/**
 * wallpaper-hud.js — turning a stats+sessions snapshot into everything the live
 * wallpaper draws ON TOP of the particle field.
 *
 * Named HUD, not "overlay": in this codebase `overlay` already means the
 * wallpaper WINDOW covering the screen instead of sitting on the desktop (see
 * wallpaper-overlay.test.mjs). These are the readouts drawn inside the scene.
 *
 * WHAT THIS IS FOR. The field itself (particles, silk, ripples, bloom) is the
 * engine's business. But the parts that carry MEANING — how hard the field
 * dances, the agent tags hovering over it, the rotating centre stage, and the
 * live log line — are all derived from the same two payloads, by a chunk of
 * logic that had only ever existed inline in wallpaper.html.
 *
 * The phone renders the same wallpaper from the same engine, so it needs the
 * same derivation. Copying it into the phone app would have been the start of
 * two versions of "what the wallpaper means", drifting apart one fix at a time.
 * So it lives here, once, as a pure function of its input.
 *
 * ⚠ wallpaper.html still has its own inline copy of this. It is the ORIGINAL,
 * and this file was extracted from it verbatim — see wallpaper-hud.test.mjs,
 * which pins the behaviour. It was not swapped over in the same change because
 * that file is under heavy edit elsewhere and the collision would have been
 * worse than the duplication. Deleting the inline copy is the follow-up.
 *
 * Pure: no DOM, no network, no engine. Import it anywhere, test it directly.
 */

/** The glyph each coding agent gets in the field and in the tags. */
export const AGENT_ICON = {
  claude: '✳️', 'claude-code': '✳️', cursor: '▹', codex: '◆', copilot: '⧉',
  windsurf: '≈', gemini: '✦', hermes: '⬡', 'deepseek-harness': '🐋', deepseek: '🐋',
};

export const iconFor = (a) =>
  a.agentIcon || AGENT_ICON[(a.agentType || '').toLowerCase()] || '🤖';

export const nameFor = (a) => a.agentName || a.agentType || 'Agent';

/** Big numbers, the way the wallpaper writes them. */
export function fmt(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n | 0);
}

/** Token counts inside a log line — one decimal, not two. */
export function fmtTok(n) {
  n = +n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const shortLog = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 46);

/**
 * The concrete waste Terse could trim from one agent's REAL traffic.
 *
 * This exists because agent traffic never credits `tokens_saved`, so today's
 * "saved" is honestly ~0 for anyone whose usage is all agents — and a wallpaper
 * that permanently reads 0 looks broken rather than honest. Every term here is
 * measured, not estimated.
 */
export function saveableOf(a) {
  return (+a.rereadWaste || 0)
    + ((a.toolCachePotential && +a.toolCachePotential.tokensWasted) || 0)
    + ((a.toolResultStats && +a.toolResultStats.compressibleTokens) || 0)
    + ((a.optimizationStats && +a.optimizationStats.potentialSavings) || 0);
}

/** One recent agent message → one log line, in the Dynamic Island's vocabulary. */
export function msgToLine(m) {
  const name = (m.toolName || m.tool_name || '').toString();
  if (m.type === 'tool_use') return { kind: 'tool', ico: '⚙', label: name || 'tool', tok: +m.tokens || 0 };
  if (m.type === 'tool_result') return { kind: 'result', ico: '←', label: (name ? name + ' → result' : 'result'), tok: +m.tokens || 0 };
  if (m.role === 'assistant') return { kind: 'asst', ico: '◆', label: shortLog(m.text) || 'responding', tok: +m.tokens || 0 };
  return { kind: 'user', ico: '→', label: shortLog(m.text) || 'prompt', tok: +m.tokens || 0 };
}

/**
 * Everything the overlays need, from one snapshot.
 *
 *   snapshot.stats     — { tokensSaved, tokensIn, percentSaved } (today)
 *   snapshot.sessions  — the agent sessions, connected or not
 *   snapshot.tokens    — cumulative token total, for the stage's "consumed" line
 *   snapshot.t         — optional translator, t(key, fallback)
 *
 * Returns { activity, agents, stage, logGroups, saved, pct, active } — no side
 * effects, so a caller can diff it, test it, or throw it away.
 */
export function buildOverlays(snapshot) {
  const s = snapshot || {};
  const t = s.t || ((_k, fallback) => fallback);
  const stats = s.stats || {};
  // Null-filtered ONCE, here, rather than guarded at each use. The two filters
  // below already tolerated a null entry, but the fallback path's sort did not —
  // it reads .totalTokens off whatever it is handed and throws. This runs every
  // few seconds behind a live wallpaper, where a throw means the field silently
  // stops updating, so the tolerance belongs at the door.
  const sessions = (Array.isArray(s.sessions) ? s.sessions : []).filter((a) => a && typeof a === 'object');
  const active = sessions.filter((a) => a.connected !== false);

  const saved = +stats.tokensSaved || 0;
  const pct = +stats.percentSaved || (stats.tokensIn ? Math.round(saved / stats.tokensIn * 100) : 0);

  // Show today's real saved OR the aggregate agent "saveable", whichever is
  // larger, so the number means something instead of being a perpetual 0.
  const saveableAgg = active.reduce((acc, a) => acc + saveableOf(a), 0);
  const totalAgentTok = active.reduce((acc, a) => acc + (+a.totalTokens || 0), 0);
  const savedShown = Math.max(saved, saveableAgg);
  const pctShown = saved > 0 ? pct
    : (totalAgentTok > 0 ? Math.round(saveableAgg / totalAgentTok * 100) : 0);

  // How hard the field dances. No agents, or all idle → calm; agents burning
  // tokens → it moves. Driven by REAL aggregate burn rate, never by a timer.
  const totalBurn = active.reduce((acc, a) => acc + (+a.burnRate || 0), 0);
  const activity = Math.min(1, (active.length ? 0.08 : 0) + totalBurn / 4500);

  // Tags hovering over the columns.
  const agents = active.slice(0, 5).map((a) => ({
    key: a.agentType || a.agentName,
    name: nameFor(a),
    icon: iconFor(a),
    rate: (+a.burnRate || 0) > 0 ? a.burnRate : null,
  }));

  // The centre "now playing" stage — this is what becomes particle TEXT. It
  // rotates: what was consumed, what Terse could save, then each busy agent.
  const stage = [
    { k: t('wpp_consumed', 'Today · consumed'), v: fmt(+s.tokens || 0), u: 'tokens' },
    { k: t('wpp_saveable', 'Terse saveable'), v: fmt(savedShown), u: pctShown + '%', saved: true },
  ];
  active.slice(0, 3).forEach((a) => stage.push({
    ic: iconFor(a),
    k: nameFor(a),
    v: fmt((+a.burnRate || 0) > 0 ? a.burnRate : (a.totalTokens || 0)),
    u: (+a.burnRate || 0) > 0 ? 'tok/min' : 'tokens',
  }));

  // The live log, busiest agent first.
  //
  // Sourced from ALL sessions, not just the connected ones. Filtering on
  // `connected !== false` here once meant a session the Dynamic Island was
  // happily scrolling produced NOTHING in the field, and the centre stayed
  // empty for no visible reason.
  const logGroups = sessions
    .filter((a) => (a.recentMessages || []).length)
    .sort((a, b) => (+b.burnRate || 0) - (+a.burnRate || 0))
    .slice(0, 3)
    .map((a) => ({
      name: nameFor(a),
      icon: iconFor(a),
      project: a.project ? String(a.project).split('/').filter(Boolean).pop() : '',
      lines: (a.recentMessages || []).map(msgToLine),
    }));

  // Fall back to facts we KNOW exist. recentMessages can be empty even for a
  // busy session — the monitor only fills it once it has parsed transcript
  // lines — and an empty centre reads as a broken feature. Everything here is
  // still real session data; nothing is invented.
  if (!logGroups.length && sessions.length) {
    const s0 = sessions.slice().sort((a, b) => (+b.totalTokens || 0) - (+a.totalTokens || 0))[0];
    if (s0) {
      const bits = [];
      if (s0.turns) bits.push(s0.turns + ' turns');
      if (s0.totalTokens) bits.push(fmtTok(s0.totalTokens) + ' in');
      if (s0.model) bits.push(String(s0.model));
      logGroups.push({
        name: nameFor(s0),
        icon: s0.agentIcon || '🤖',
        lines: [{ label: nameFor(s0) + ' · ' + (bits.join(' · ') || 'connected') }],
      });
    }
  }

  return { activity, agents, stage, logGroups, saved: savedShown, pct: pctShown, active };
}

export default buildOverlays;
