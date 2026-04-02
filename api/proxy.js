/**
 * Terse LLM Proxy — Routes buyer requests through seller API keys.
 *
 * Revenue model:
 * 1. Commission: Terse takes COMMISSION_PERCENT% of every transaction
 * 2. Optimization margin: buyer pays for pre-optimization tokens,
 *    but actual API call uses fewer tokens after Terse compression
 *
 * Supports: Anthropic Messages API, OpenAI Chat Completions API
 */
const express = require('express');
const crypto = require('crypto');
const { decrypt } = require('./crypto-utils');
const db = require('./db');
const { COMMISSION_PERCENT, PROVIDER_LIST_PRICES } = require('./marketplace');

const router = express.Router();

// Rough token estimation (4 chars ≈ 1 token)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Extract text content from messages for optimization
function extractUserText(messages) {
  let text = '';
  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        text += msg.content + '\n';
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') text += part.text + '\n';
        }
      }
    }
  }
  return text.trim();
}

// Simple prompt optimization (lightweight version for proxy — no heavy NLP deps)
function optimizePrompt(text) {
  if (!text || text.length < 20) return text;

  let result = text;

  // Remove filler words/phrases
  const fillers = [
    /\b(basically|essentially|actually|literally|honestly|frankly|obviously|clearly)\b/gi,
    /\b(I think|I believe|I feel like|in my opinion|it seems like)\b/gi,
    /\b(please|kindly|if you could|would you mind|could you please)\b/gi,
    /\b(just|really|very|quite|pretty much|sort of|kind of)\b/gi,
    /\b(as a matter of fact|at the end of the day|in order to|for the purpose of)\b/gi,
    /\b(I would like you to|I want you to|I need you to)\b/gi,
  ];
  for (const filler of fillers) {
    result = result.replace(filler, '');
  }

  // Compress whitespace
  result = result.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Remove redundant line breaks
  result = result.replace(/^\s+$/gm, '');

  return result;
}

// Apply optimization to messages (only user messages)
function optimizeMessages(messages) {
  return messages.map(msg => {
    if (msg.role !== 'user') return msg;
    if (typeof msg.content === 'string') {
      return { ...msg, content: optimizePrompt(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(part =>
          part.type === 'text' ? { ...part, text: optimizePrompt(part.text) } : part
        ),
      };
    }
    return msg;
  });
}

// Detect provider from request path or model name
function detectProvider(path, model) {
  if (path.includes('/messages')) return 'anthropic';
  if (path.includes('/chat/completions')) {
    if (model?.startsWith('claude')) return 'anthropic';
    if (model?.startsWith('gemini')) return 'google';
    return 'openai';
  }
  return null;
}

// Provider-specific API endpoints
const PROVIDER_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

// ════════════════════════════════════════
//  PROXY HANDLER
// ════════════════════════════════════════

// Anthropic Messages API
router.post('/v1/messages', handleProxy);

// OpenAI-compatible Chat Completions
router.post('/v1/chat/completions', handleProxy);

async function handleProxy(req, res) {
  const startTime = Date.now();

  // 1. Authenticate buyer via virtual key
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: 'Missing API key' } });
  }
  const rawKey = authHeader.slice(7);
  const keyHash = db.hashKey(rawKey);
  const buyerKey = db.findBuyerByHash.get(keyHash);

  if (!buyerKey) {
    return res.status(401).json({ error: { message: 'Invalid API key' } });
  }

  const buyer = db.getUser.get(buyerKey.user_id);
  if (!buyer || buyer.buyer_balance_cents <= 0) {
    return res.status(402).json({ error: { message: 'Insufficient balance. Top up at https://www.terseai.org/marketplace' } });
  }

  // 2. Parse request
  const body = req.body;
  const model = body.model;
  const messages = body.messages;
  const stream = body.stream || false;

  if (!model || !messages) {
    return res.status(400).json({ error: { message: 'Missing model or messages' } });
  }

  // 3. Detect provider and find cheapest seller key
  const provider = detectProvider(req.path, model);
  if (!provider) {
    return res.status(400).json({ error: { message: 'Could not determine provider' } });
  }

  const sellerKey = db.findCheapestKey.get(provider);
  if (!sellerKey) {
    return res.status(503).json({ error: { message: `No available keys for provider: ${provider}` } });
  }

  // 4. Estimate pre-optimization tokens
  const preOptText = extractUserText(messages);
  const preOptTokens = estimateTokens(preOptText);

  // 5. Optimize messages
  const optimizedMessages = optimizeMessages(messages);
  const postOptText = extractUserText(optimizedMessages);
  const postOptTokens = estimateTokens(postOptText);

  // 6. Decrypt seller's API key
  let apiKey;
  try {
    apiKey = decrypt(sellerKey.encrypted_key, sellerKey.key_iv, sellerKey.key_tag);
  } catch (err) {
    console.error('[proxy] key decrypt error:', err.message);
    return res.status(500).json({ error: { message: 'Internal key error' } });
  }

  // 7. Forward to provider
  let providerRes;
  try {
    if (provider === 'anthropic') {
      // Build Anthropic request
      const anthropicBody = {
        model,
        max_tokens: body.max_tokens || 4096,
        messages: optimizedMessages,
      };
      if (body.system) anthropicBody.system = body.system;
      if (body.temperature !== undefined) anthropicBody.temperature = body.temperature;
      if (body.top_p !== undefined) anthropicBody.top_p = body.top_p;
      if (body.tools) anthropicBody.tools = body.tools;
      if (body.tool_choice) anthropicBody.tool_choice = body.tool_choice;
      if (stream) anthropicBody.stream = true;

      providerRes = await fetch(PROVIDER_ENDPOINTS.anthropic, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });
    } else if (provider === 'openai') {
      // Build OpenAI request
      const openaiBody = {
        model,
        messages: optimizedMessages,
      };
      if (body.max_tokens !== undefined) openaiBody.max_tokens = body.max_tokens;
      if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
      if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
      if (body.tools) openaiBody.tools = body.tools;
      if (body.tool_choice) openaiBody.tool_choice = body.tool_choice;
      if (stream) openaiBody.stream = true;
      if (body.response_format) openaiBody.response_format = body.response_format;

      providerRes = await fetch(PROVIDER_ENDPOINTS.openai, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(openaiBody),
      });
    } else if (provider === 'google') {
      // Gemini — translate to Google's format
      const geminiBody = {
        contents: optimizedMessages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : m.content.map(p => p.text || '').join('\n') }],
        })),
      };
      if (body.temperature !== undefined) geminiBody.generationConfig = { temperature: body.temperature };

      providerRes = await fetch(`${PROVIDER_ENDPOINTS.google}/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });
    }
  } catch (err) {
    console.error('[proxy] provider request error:', err.message);
    return res.status(502).json({ error: { message: 'Failed to reach provider' } });
  }

  // 8. Handle streaming
  if (stream && providerRes.ok) {
    res.setHeader('Content-Type', providerRes.headers.get('content-type') || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = providerRes.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullResponse += chunk;
        res.write(chunk);
      }
      res.end();
    } catch (err) {
      console.error('[proxy] stream error:', err.message);
      res.end();
    }

    // Estimate output tokens from streamed response
    const outputTokens = estimateTokens(fullResponse);
    recordTransaction(buyerKey, sellerKey, buyer, provider, model, preOptTokens, outputTokens, postOptTokens);
    return;
  }

  // 9. Non-streaming: parse response
  if (!providerRes.ok) {
    const errBody = await providerRes.text();
    return res.status(providerRes.status).json({ error: { message: 'Provider error', status: providerRes.status, details: errBody } });
  }

  const responseData = await providerRes.json();

  // Extract token usage from response
  let inputTokens = preOptTokens;
  let outputTokens = 0;

  if (provider === 'anthropic' && responseData.usage) {
    inputTokens = responseData.usage.input_tokens || preOptTokens;
    outputTokens = responseData.usage.output_tokens || 0;
  } else if (provider === 'openai' && responseData.usage) {
    inputTokens = responseData.usage.prompt_tokens || preOptTokens;
    outputTokens = responseData.usage.completion_tokens || 0;
  } else {
    // Estimate from response
    outputTokens = estimateTokens(JSON.stringify(responseData));
  }

  // Record transaction
  recordTransaction(buyerKey, sellerKey, buyer, provider, model, inputTokens, outputTokens, postOptTokens);

  // Return response to buyer
  res.json(responseData);
}

function recordTransaction(buyerKey, sellerKey, buyer, provider, model, inputTokens, outputTokens, inputTokensOptimized) {
  // Calculate costs
  // Buyer pays based on seller's price (using pre-optimization token counts for input)
  const buyerInputCost = Math.ceil((inputTokens / 1_000_000) * sellerKey.price_per_1m_input);
  const buyerOutputCost = Math.ceil((outputTokens / 1_000_000) * sellerKey.price_per_1m_output);
  const totalBuyerCost = buyerInputCost + buyerOutputCost;

  // Terse commission
  const terseFee = Math.ceil(totalBuyerCost * (COMMISSION_PERCENT / 100));

  // Seller receives (total - commission)
  const sellerReceives = totalBuyerCost - terseFee;

  // Actual API cost (based on optimized/post-optimization tokens — this is what the provider charges)
  const listPrices = PROVIDER_LIST_PRICES[provider]?.[model];
  let actualCost = totalBuyerCost; // fallback
  if (listPrices) {
    actualCost = Math.ceil(
      ((inputTokensOptimized || inputTokens) / 1_000_000) * listPrices.input +
      (outputTokens / 1_000_000) * listPrices.output
    );
  }

  const txnId = crypto.randomUUID();

  try {
    // Debit buyer
    db.debitBuyerBalance.run(totalBuyerCost, buyer.id);

    // Credit seller
    db.creditSellerBalance.run(sellerReceives, sellerKey.user_id);

    // Track seller key spend
    db.incrementSellerSpend.run(actualCost, sellerKey.id);

    // Record transaction
    db.addTransaction.run({
      id: txnId,
      buyer_key_id: buyerKey.id,
      seller_key_id: sellerKey.id,
      buyer_id: buyer.id,
      seller_id: sellerKey.user_id,
      provider,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_tokens_optimized: inputTokensOptimized,
      seller_cost_cents: totalBuyerCost,
      terse_fee_cents: terseFee,
      actual_api_cost_cents: actualCost,
    });

    console.log(`[proxy] txn=${txnId} buyer=${buyer.id} seller=${sellerKey.user_id} model=${model} in=${inputTokens} out=${outputTokens} cost=${totalBuyerCost}¢ fee=${terseFee}¢`);
  } catch (err) {
    console.error('[proxy] transaction recording error:', err.message);
  }
}

module.exports = router;
