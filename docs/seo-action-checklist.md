# Terse SEO Action Checklist (external / manual steps)

Everything in the repo is done (see git diff of 2026-07-17). These steps need dashboard access or ongoing human effort and cannot be done from code.

## 🚨 1. Cloudflare — unblock AI crawlers (5 minutes, highest impact)

Verified 2026-07-17: `GPTBot` and `PerplexityBot` get **403** from www.terseai.org while browsers/Googlebot get 200. ChatGPT, Claude, and Perplexity literally cannot read the site, so Terse can never be cited or recommended by them.

1. Cloudflare dashboard → your zone → **Security → Bots** (or **AI Audit / AI Crawl Control** on newer dashboards).
2. Turn **off** "Block AI bots" / set AI crawlers to **Allow** — at minimum: `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-User`, `PerplexityBot`, `Perplexity-User`, `Google-Extended`, `Applebot-Extended`, `cohere-ai`, `YouBot`.
3. **Settings → robots.txt management**: disable Cloudflare's "managed robots.txt" injection. It currently prepends a section that *disallows* ClaudeBot/GPTBot/Google-Extended, contradicting our own robots.txt below it.
4. Re-verify: `curl -s -o /dev/null -w "%{http_code}" -A "GPTBot/1.0" https://www.terseai.org/` → must be `200`, and `curl -s https://www.terseai.org/robots.txt` → must start with our `# Terse — Token Optimizer for AI` header, no Cloudflare block above it.

Note: if "ai-train=no" is a deliberate choice, you can keep `Google-Extended`/`Applebot-Extended` blocked (training opt-out) while still allowing the *search/answer* bots (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot). Search/citation visibility only needs the latter group.

## 2. Google Search Console + Bing Webmaster Tools
- Verify www.terseai.org in GSC (DNS TXT via Cloudflare is easiest) and submit `sitemap.xml`.
- Check Coverage report after ~1 week: the ~224 pages we just `noindex`ed should drop out; the ~25 new pages should come in.
- Bing Webmaster Tools matters more than usual now — Bing's index feeds ChatGPT search.

## 3. Store listings (needs owner account)
- **Chrome Web Store**: apply the refreshed copy in `chrome-extension/STORE_LISTING.md`; upload 5 screenshots (before/after compression, savings counter, themes, shortcut, options) + a short promo video. Consider the keyword-richer title variant there.
- **VS Code Marketplace**: republish with the updated `package.json` (new keywords + homepage). Add 3–5 screenshots/GIF to the README (it renders as the listing page).
- Both stores rank primarily on **reviews + retention**: the in-app review nudges we added will only fire after 25 optimizations — seed the first reviews by asking existing users/friends directly.

## 4. GEO / brand-mention flywheel (ongoing, ~2h/week)
Brand mentions correlate ~3× more with AI-assistant visibility than backlinks; Reddit is the #1 cited domain on Perplexity.
- **Reddit**: genuinely answer cost threads in r/ClaudeAI, r/cursor, r/ChatGPTCoding, r/LocalLLaMA (search: "Claude Code expensive", "token costs", "runaway agent"). Lead with the fix, mention Terse once, link a specific guide page (e.g. /prompt-caching-guide), not the homepage.
- **Directories**: create/claim listings on Product Hunt (relaunch with the agent-butler story + circuit breaker), AlternativeTo (list as alternative to LLMLingua, ccusage, Cursor usage dashboards), G2, StackShare, There's An AI For That.
- **GitHub**: make Terse-AI/terseai README a real landing page (features, GIFs, links to terseai.org pages) — GitHub is heavily crawled by LLMs. Add the site link to the org profile.
- **Original data**: publish one "State of Agent Token Waste" post from Terse telemetry (aggregate, anonymized) — original stats are the #1 citation magnet; pitch it to dev newsletters.
- **HN/dev.to**: the circuit-breaker feature ("my agent spent $400 overnight — so I built a breaker") is a strong Show HN angle.

## 5. Monitoring
- GA4: mark AI referrals (chatgpt.com, perplexity.ai, claude.ai) as a channel group to track AI-sourced traffic.
- Spot-check monthly: ask ChatGPT/Perplexity/Claude "how do I cut Claude Code token costs" and see if Terse is cited yet.
- Keep `llms.txt` in sync when features/pricing change (updated 2026-07-17 for the agent-butler feature set).

## 6. Deferred / optional
- More hreflang languages: i18n.js already has ja/ko/es/fr/de/ar/it dictionaries — same static-prerender approach as /zh/ when ready.
- `aggregateRating` JSON-LD was **removed** from index.html because both stores show 0 reviews (fake review markup risks a Google manual action). Re-add it only when real store reviews exist, with the real numbers.
- Consider renaming the Chrome extension title to a keyword variant once it has reviews (title changes reset some ranking signals; do it early or not at all).
