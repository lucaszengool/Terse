/**
 * Tests for wallpaper-hud.js — the readouts drawn inside the wallpaper scene.
 *
 *   node src/renderer/wallpaper-hud.test.mjs
 *
 * This module was extracted from wallpaper.html so the phone could render the
 * same wallpaper without a second copy of "what the wallpaper means". The
 * inline original is still there, so these assertions are written as a PIN on
 * the behaviour both must share — every one of them corresponds to a decision
 * the original made deliberately, several of them to bugs it already fixed once.
 */
import { buildOverlays, saveableOf, msgToLine, fmt, fmtTok, iconFor } from './wallpaper-hud.js';

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? (pass++, console.log('  ✓ ' + name))
  : (fail++, console.error('  ✗ ' + name));
const eq = (name, got, want) => ok(`${name}${got === want ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  got === want);

const agent = (o) => Object.assign({ agentType: 'claude-code', connected: true }, o);

console.log('\nWallpaper HUD\n');

// ── Formatting ──
eq('fmt uses two decimals at millions', fmt(2_400_000), '2.40M');
eq('fmt uses one decimal at thousands', fmt(12_300), '12.3K');
eq('fmt floors below a thousand', fmt(999.7), '999');
// fmtTok is deliberately coarser than fmt: it sits inside a log line, not on the stage.
eq('fmtTok uses one decimal at millions', fmtTok(2_400_000), '2.4M');

// ── The saveable number ──
// Every term is measured. This is the honest non-zero number for agent traffic,
// which never credits tokens_saved.
eq('saveable sums all four measured sources', saveableOf({
  rereadWaste: 1000,
  toolCachePotential: { tokensWasted: 200 },
  toolResultStats: { compressibleTokens: 30 },
  optimizationStats: { potentialSavings: 4 },
}), 1234);
eq('saveable is 0, not NaN, for a session with none of them', saveableOf({}), 0);

{
  // Agent traffic reports saved = 0, so the field would read a permanent zero
  // without the fallback — which looks broken rather than honest.
  const r = buildOverlays({
    stats: { tokensSaved: 0, tokensIn: 0, percentSaved: 0 },
    sessions: [agent({ totalTokens: 100_000, rereadWaste: 25_000 })],
  });
  eq('falls back to saveable when today saved nothing', r.saved, 25_000);
  eq('and derives a percentage from agent totals', r.pct, 25);
}
{
  // A real saved number must win — the fallback is a floor, not a replacement.
  const r = buildOverlays({
    stats: { tokensSaved: 90_000, tokensIn: 300_000, percentSaved: 30 },
    sessions: [agent({ totalTokens: 100_000, rereadWaste: 25_000 })],
  });
  eq('a real saved number beats the fallback', r.saved, 90_000);
  eq('and keeps its own percentage', r.pct, 30);
}

// ── Activity: what makes the field dance ──
eq('no agents at all is a dead calm field', buildOverlays({ sessions: [] }).activity, 0);
ok('a connected but idle agent still stirs it a little',
  buildOverlays({ sessions: [agent({ burnRate: 0 })] }).activity === 0.08);
ok('burn rate drives it up',
  buildOverlays({ sessions: [agent({ burnRate: 2000 })] }).activity > 0.5);
eq('and it is clamped at 1 no matter how hard they burn',
  buildOverlays({ sessions: [agent({ burnRate: 999_999 })] }).activity, 1);
// A disconnected session must not keep the field dancing after the agent is gone.
eq('a disconnected session does not drive the field',
  buildOverlays({ sessions: [agent({ connected: false, burnRate: 5000 })] }).activity, 0);

// ── The centre stage: this is what becomes particle text ──
{
  const r = buildOverlays({
    tokens: 1_500_000,
    stats: { tokensSaved: 12_000, tokensIn: 100_000, percentSaved: 12 },
    sessions: [
      agent({ agentName: 'Claude', burnRate: 1800 }),
      agent({ agentType: 'codex', agentName: 'Codex', burnRate: 0, totalTokens: 4000 }),
    ],
  });
  eq('the stage leads with what was consumed', r.stage[0].v, '1.50M');
  eq('then what Terse could save', r.stage[1].u, '12%');
  ok('and marks that one as a saving, which colours the glyph', r.stage[1].saved === true);
  eq('a burning agent is billed per minute', r.stage[2].u, 'tok/min');
  // An idle agent has no rate to show, so it shows its total instead of "0/min".
  eq('an idle agent shows its total instead', r.stage[3].u, 'tokens');
  eq('and the right total', r.stage[3].v, '4.0K');
}
{
  // Five agents would push the stage past what the rotation can show before the
  // data is stale, so it stops at three.
  const many = Array.from({ length: 5 }, (_, i) => agent({ agentName: 'A' + i, burnRate: 100 }));
  eq('the stage takes at most three agents', buildOverlays({ sessions: many }).stage.length, 2 + 3);
  eq('the tags take at most five', buildOverlays({ sessions: many }).agents.length, 5);
}

// ── The live log ──
eq('a tool call reads as the tool', msgToLine({ type: 'tool_use', toolName: 'Read' }).label, 'Read');
eq('a tool result says so', msgToLine({ type: 'tool_result', toolName: 'Read' }).label, 'Read → result');
eq('assistant text is truncated to fit a glyph line',
  msgToLine({ role: 'assistant', text: 'x'.repeat(80) }).label.length, 46);
eq('whitespace in a log line is collapsed',
  msgToLine({ role: 'user', text: 'hello\n\n   world' }).label, 'hello world');

{
  // Filtering the log on `connected !== false` once meant a session the Dynamic
  // Island was happily scrolling produced nothing here, and the centre of the
  // wallpaper stayed empty for no visible reason.
  const r = buildOverlays({
    sessions: [agent({ connected: false, agentName: 'Ghost', recentMessages: [{ type: 'tool_use', toolName: 'Grep' }] })],
  });
  eq('a disconnected session still contributes its log', r.logGroups.length, 1);
  eq('with its lines intact', r.logGroups[0].lines[0].label, 'Grep');
}
{
  const r = buildOverlays({
    sessions: [
      agent({ agentName: 'Slow', burnRate: 10, recentMessages: [{ type: 'tool_use', toolName: 'A' }] }),
      agent({ agentName: 'Fast', burnRate: 9000, recentMessages: [{ type: 'tool_use', toolName: 'B' }] }),
    ],
  });
  eq('the busiest agent leads the log', r.logGroups[0].name, 'Fast');
}
{
  // recentMessages is empty for a busy session until the monitor has parsed
  // transcript lines. An empty centre reads as a broken feature, so it falls
  // back to facts we know — and invents nothing.
  const r = buildOverlays({
    sessions: [agent({ agentName: 'Claude', totalTokens: 42_000, turns: 7, model: 'opus' })],
  });
  eq('an agent with no parsed messages still gets a line', r.logGroups.length, 1);
  ok('built from real session facts only',
    r.logGroups[0].lines[0].label === 'Claude · 7 turns · 42.0K in · opus');
}
eq('no sessions means no log at all', buildOverlays({ sessions: [] }).logGroups.length, 0);
{
  const r = buildOverlays({ sessions: [agent({ project: '/Users/j/code/terse' , recentMessages: [{ role: 'user', text: 'hi' }] })] });
  eq('the project shows as its last path segment', r.logGroups[0].project, 'terse');
}

// ── Icons ──
eq('claude-code has its own mark', iconFor({ agentType: 'claude-code' }), '✳️');
eq('an agent can override it', iconFor({ agentType: 'codex', agentIcon: '🦊' }), '🦊');
eq('an unknown agent still gets one', iconFor({ agentType: 'something-new' }), '🤖');

// ── Robustness: this runs every few seconds behind a live wallpaper ──
ok('an empty snapshot does not throw', (() => {
  const r = buildOverlays({});
  return r.activity === 0 && r.stage.length === 2 && r.logGroups.length === 0;
})());
ok('a malformed snapshot does not throw', (() => {
  const r = buildOverlays({ stats: null, sessions: null, tokens: 'nonsense' });
  return r.activity === 0 && r.stage[0].v === '0';
})());
ok('a session that is not an object is skipped', (() => {
  const r = buildOverlays({ sessions: [null, undefined, agent({ burnRate: 100 })] });
  return r.active.length === 1;
})());

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
