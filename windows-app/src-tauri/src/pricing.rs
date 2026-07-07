//! Shared LLM price table, so cost estimates are consistent across the agent
//! monitor, the stats receipt, and the cloud team dashboard.
//!
//! Rates are USD per 1,000 tokens as `(fresh_input, output, cache_read)`.
//! Prompt-cache *writes* are billed at ~1.25× the fresh-input rate (Anthropic);
//! cache *reads* are the much cheaper third element.

/// Multiplier applied to the fresh-input rate for prompt-cache writes.
pub const CACHE_WRITE_MULT: f64 = 1.25;

/// `(input, output, cache_read)` USD per 1k tokens for a model name.
/// Matching is case-insensitive substring, most-specific first.
pub fn model_pricing(model: &str) -> (f64, f64, f64) {
    let m = model.to_lowercase();
    // Anthropic
    if m.contains("opus") { return (0.015, 0.075, 0.0015); }
    if m.contains("haiku") { return (0.0008, 0.004, 0.00008); }
    if m.contains("sonnet") || m.contains("claude") { return (0.003, 0.015, 0.0003); }
    // OpenAI (Codex uses GPT-4o / o-series / GPT-5)
    if m.contains("o3") || m.contains("gpt-5") { return (0.010, 0.040, 0.005); }
    if m.contains("o4-mini") || m.contains("o1-mini") { return (0.0011, 0.0044, 0.00055); }
    if m.contains("o1") || m.contains("o3-mini") { return (0.003, 0.012, 0.0015); }
    if m.contains("gpt-4o-mini") { return (0.00015, 0.0006, 0.000075); }
    if m.contains("gpt-4o") { return (0.0025, 0.010, 0.00125); }
    // Unknown — assume a mid Claude tier so estimates stay in a sane range.
    (0.003, 0.015, 0.0003)
}

/// Estimate USD cost from a model name and a token breakdown.
/// `fresh_in` must EXCLUDE `cache_read` and `cache_create` (pass those separately).
pub fn estimate_cost(model: &str, fresh_in: u64, output: u64, cache_read: u64, cache_create: u64) -> f64 {
    let (pin, pout, pread) = model_pricing(model);
    (fresh_in as f64) / 1000.0 * pin
        + (output as f64) / 1000.0 * pout
        + (cache_read as f64) / 1000.0 * pread
        + (cache_create as f64) / 1000.0 * pin * CACHE_WRITE_MULT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_costs_more_than_haiku() {
        let opus = estimate_cost("claude-opus-4", 1000, 1000, 0, 0);
        let haiku = estimate_cost("claude-haiku-4", 1000, 1000, 0, 0);
        assert!(opus > haiku);
    }

    #[test]
    fn cache_reads_are_cheap() {
        // 1M cache-read tokens should cost far less than 1M fresh-input tokens.
        let fresh = estimate_cost("claude-sonnet", 1_000_000, 0, 0, 0);
        let cached = estimate_cost("claude-sonnet", 0, 0, 1_000_000, 0);
        assert!(cached < fresh / 5.0, "cache read {cached} not << fresh {fresh}");
    }

    #[test]
    fn unknown_model_has_sane_default() {
        assert!(estimate_cost("some-future-model", 1000, 1000, 0, 0) > 0.0);
    }
}
