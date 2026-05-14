/**
 * Terse Chrome Extension — Content Script
 * Reads and writes text in web page textareas/inputs/contenteditable elements.
 * Communicates with popup and service worker via chrome.runtime messaging.
 *
 * NOTE: Optimization happens in the popup (which loads optimizer-bundle.js).
 * This content script only handles DOM interaction (read/write text fields).
 */

(() => {
  // ── State ──
  let activeElement = null;
  let lastText = '';
  let lastOriginalText = '';
  let sendCooldownUntil = 0;
  let processingEnter = false;
  let terseSettings = null;

  // Load optimizer settings from background
  chrome.runtime.sendMessage({ type: 'get-settings' }).then(s => {
    terseSettings = s;
    if (window._terseOptimizer && s?.aggressiveness) {
      window._terseOptimizer.setMode(s.aggressiveness);
    }
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings?.newValue) {
      terseSettings = changes.settings.newValue;
      if (window._terseOptimizer && terseSettings?.aggressiveness) {
        window._terseOptimizer.setMode(terseSettings.aggressiveness);
      }
    }
  });

  // ── Helpers ──

  function getActiveInput() {
    const el = document.activeElement;
    if (!el) return null;

    // textarea or text input
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /text|search|url/.test(el.type))) {
      return el;
    }
    // contenteditable
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      return el;
    }
    // Dive into shadow DOM for common AI chat UIs
    if (el.shadowRoot) {
      const inner = el.shadowRoot.querySelector('textarea, [contenteditable="true"]');
      if (inner) return inner;
    }
    // Some chat UIs use a div with role="textbox"
    if (el.getAttribute('role') === 'textbox') {
      return el;
    }
    return null;
  }

  function findNearestInput() {
    // If activeElement is not an input, scan the page for the most likely chat input
    const candidates = document.querySelectorAll(
      'textarea, [contenteditable="true"], [role="textbox"], div[data-placeholder]'
    );
    // Prefer the one that's focused or last in DOM (usually chat input at bottom)
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (el.offsetHeight > 0 && el.offsetWidth > 0) return el;
    }
    return null;
  }

  function getTextFromElement(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value || '';
    }
    return el.innerText || el.textContent || '';
  }

  function setTextInElement(el, text) {
    if (!el) return false;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // Use native setter to trigger React/Vue/Angular reactivity
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, text);
      } else {
        el.value = text;
      }
    } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
      // For contenteditable, use execCommand for better undo support
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      return true;
    } else {
      return false;
    }

    // Dispatch events so frameworks detect the change
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    // React 16+ needs this
    const nativeInputEvent = new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertText',
      data: text,
    });
    el.dispatchEvent(nativeInputEvent);

    return true;
  }

  function getSelectedText() {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      return sel.toString();
    }
    // Check active input's selection range
    const el = getActiveInput();
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start !== end) {
        return el.value.substring(start, end);
      }
    }
    return '';
  }

  function getCurrentSite() {
    try {
      return new URL(window.location.href).hostname;
    } catch {
      return '';
    }
  }

  // ── Auto-compress on Enter ──

  function isOptimizableInput(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      const blocked = ['search', 'url', 'email', 'tel', 'number', 'date', 'time', 'color',
                       'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'hidden',
                       'range', 'image', 'month', 'week', 'datetime-local', 'password'];
      if (blocked.includes(type)) return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
      if (role === 'search' || /search|find|url|address/.test(label)) return false;
    }
    return (
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'INPUT' ||
      el.isContentEditable ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('role') === 'textbox'
    );
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (processingEnter) return;
    if (!window._terseOptimizer) return;

    const target = e.target;
    if (!isOptimizableInput(target)) return;

    const text = getTextFromElement(target);
    const trimmed = (text || '').trim();
    if (trimmed.length < 15 || !trimmed.includes(' ')) return;

    const result = window._terseOptimizer.optimize(trimmed);
    if (!result?.optimized || result.optimized === trimmed) return;

    e.preventDefault();
    e.stopPropagation();

    lastOriginalText = text;
    setTextInElement(target, result.optimized);
    sendCooldownUntil = Date.now() + 2000;

    // Re-dispatch Enter so the page submits with the optimized text
    processingEnter = true;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    processingEnter = false;

    // Fallback: click visible send/submit button
    setTimeout(() => {
      const form = target.closest('form');
      if (form) {
        const btn = form.querySelector(
          'button[type="submit"], [data-testid*="send"], [aria-label*="Send"], [aria-label*="Submit"]'
        );
        if (btn) btn.click();
      }
    }, 50);
  }, true); // capture phase so we run before page handlers

  // ── Message handling from popup / service worker ──

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'capture-selection': {
        const el = getActiveInput() || findNearestInput();
        const selected = getSelectedText();
        const text = selected || getTextFromElement(el);
        if (text && text.length >= 3) {
          lastOriginalText = text;
          activeElement = el;
          sendResponse({
            success: true,
            text,
            isSelection: !!selected,
            site: getCurrentSite(),
          });
        } else {
          sendResponse({ success: false, reason: 'No text found. Focus a text field or select text first.' });
        }
        break;
      }

      case 'capture-and-replace': {
        // Used by keyboard shortcut — asks service worker to optimize, then replaces
        const el = getActiveInput() || findNearestInput();
        const selected = getSelectedText();
        const text = selected || getTextFromElement(el);
        if (text && text.length >= 3) {
          lastOriginalText = text;
          activeElement = el;
          sendResponse({ success: true, text, site: getCurrentSite() });
        } else {
          sendResponse({ success: false, reason: 'No text found' });
        }
        break;
      }

      case 'replace-text': {
        const el = activeElement || getActiveInput() || findNearestInput();
        if (el && msg.text) {
          lastOriginalText = getTextFromElement(el);
          activeElement = el;
          const ok = setTextInElement(el, msg.text);
          sendCooldownUntil = Date.now() + 2000;
          sendResponse({ success: ok });
        } else {
          sendResponse({ success: false, reason: 'No active input found' });
        }
        break;
      }

      case 'undo-replace': {
        const el = activeElement || getActiveInput();
        if (el && lastOriginalText) {
          setTextInElement(el, lastOriginalText);
          lastOriginalText = '';
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false });
        }
        break;
      }

      case 'get-active-text': {
        const el = getActiveInput() || findNearestInput();
        const selected = getSelectedText();
        const text = selected || getTextFromElement(el);
        sendResponse({
          text: text || '',
          hasInput: !!el,
          isSelection: !!selected,
          site: getCurrentSite(),
          url: window.location.href,
        });
        break;
      }

      case 'send-enter': {
        const el = activeElement || getActiveInput();
        if (el) {
          // Simulate Enter key (works for ChatGPT, Claude, Gemini, etc.)
          const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));

          // Some chat UIs use a submit button — try clicking it
          setTimeout(() => {
            const form = el.closest('form');
            if (form) {
              const submit = form.querySelector('button[type="submit"], button[data-testid="send-button"]');
              if (submit) submit.click();
            }
          }, 50);

          sendResponse({ success: true });
        } else {
          sendResponse({ success: false });
        }
        break;
      }

      case 'update-auto-mode':
        sendResponse({ ok: true });
        break;

      case 'ping':
        sendResponse({ alive: true });
        break;

      default:
        sendResponse({ error: 'unknown type' });
    }
    return true; // keep channel open for async
  });

  // ── Live monitoring: detect text changes and notify popup ──

  let pollInterval = null;

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      const el = getActiveInput();
      if (!el) return;
      const text = getTextFromElement(el);
      if (text === lastText || text.length < 5) return;
      if (Date.now() < sendCooldownUntil) return;

      lastText = text;
      activeElement = el;

      // Notify popup of new text (popup may or may not be open)
      chrome.runtime.sendMessage({
        type: 'text-changed',
        text,
        site: getCurrentSite(),
      }).catch(() => {}); // popup not open — that's fine
    }, 500);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // Start polling when page has focus
  if (document.hasFocus()) startPolling();

  window.addEventListener('focus', startPolling);
  window.addEventListener('blur', () => {
    // Keep polling briefly after blur (user might have clicked the popup)
    setTimeout(stopPolling, 10000);
  });

  // Detect focus on text inputs
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (
      el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /text|search/.test(el.type)) ||
      el.isContentEditable ||
      el.getAttribute('role') === 'textbox'
    ) {
      activeElement = el;
      startPolling();
    }
  });
})();
