/**
 * The agent log, from the wire to the field.
 *
 *   node landing/phone/agentlog.test.js
 *
 * A phone that had linked a Mac showed no agent log at all, and every piece of
 * the chain looked fine on its own. The break was two size limits meeting a
 * payload nobody had measured:
 *
 *   · a session snapshot carries THIRTY recent messages, and a user message's
 *     text is kept whole up to 2000 chars because the desktop's optimizer needs
 *     it. Eight of those is hundreds of kilobytes.
 *   · express.json() refused it at 100kb, before link.js could run — and the
 *     desktop's push reads only `watching` off the reply, so the failure was
 *     silent on both ends.
 *
 * link.js trims the frame now instead of refusing it. This test guards the
 * OTHER half of that decision: that what survives the trim is still enough for
 * the field to draw. The trim keeps five keys; if anyone drops one, the field
 * goes quiet again and nothing throws — so the assertion is on the drawn text,
 * not on the shape.
 */
import { buildOverlays, msgToLine } from '../../src/renderer/wallpaper-hud.js';

let pass = 0, fail = 0;
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.error('  ✗ ' + n)));
const eq = (n, g, w) => ok(`${n}${g === w ? '' : ` (got ${JSON.stringify(g)}, want ${JSON.stringify(w)})`}`, g === w);

/** Exactly what api/link.js stores after trimSession — no more, no less. */
const wireSession = (over = {}) => ({
  id: 'agent-claude-42',
  agentType: 'claude',
  agentName: 'Claude Code',
  agentIcon: '🤖',
  connected: true,
  project: '/Users/james/Desktop/Terse',
  model: 'claude-opus-5',
  turns: 14,
  totalTokens: 91000,
  totalInputTokens: 78000,
  totalOutputTokens: 13000,
  burnRate: 320,
  costPerHour: 1.4,
  contextFill: 0.42,
  estimatedCost: 0.9,
  elapsedMinutes: 26,
  recentMessages: [
    { role: 'user', type: 'text', toolName: '', text: 'make the city show on the phone', tokens: 12 },
    { role: 'assistant', type: 'tool_use', toolName: 'Read', text: '', tokens: 40 },
    { role: 'tool', type: 'tool_result', toolName: 'Read', text: 'ok', tokens: 900 },
    { role: 'assistant', type: 'text', toolName: '', text: 'The layer was never advanced.', tokens: 60 },
    { role: 'assistant', type: 'tool_use', toolName: 'Edit', text: '', tokens: 55 },
  ],
  ...over,
});

console.log('\n── a wire session still draws ──');
const o = buildOverlays({ stats: { tokensSaved: 120 }, sessions: [wireSession()], tokens: 91000 });
ok('there is a log group at all', Array.isArray(o.logGroups) && o.logGroups.length === 1);
const g = o.logGroups[0];
eq('named after the agent', g.name, 'Claude Code');
eq('with its icon', g.icon, '🤖');
eq('and the project, not the whole path', g.project, 'Terse');
eq('every line the wire carried', g.lines.length, 5);

// This is the assertion that matters: the ENGINE draws `label`, so a trim that
// keeps the wrong keys shows up here as empty text rather than as an error.
ok('every line has something to draw', g.lines.every((l) => l && l.label));
eq('a tool call reads as its tool', g.lines[1].label, 'Read');
eq('a result says so', g.lines[2].label, 'Read → result');
eq("an assistant's words come through", g.lines[3].label, 'The layer was never advanced.');
eq('and a prompt is a prompt', g.lines[0].label, 'make the city show on the phone');

console.log('\n── busiest first, because the engine draws groups[0] ──');
const many = buildOverlays({
  sessions: [
    wireSession({ agentName: 'Quiet', burnRate: 5 }),
    wireSession({ agentName: 'Busy', burnRate: 900 }),
    wireSession({ agentName: 'Middling', burnRate: 100 }),
  ],
});
eq('the busiest agent leads', many.logGroups[0].name, 'Busy');
ok('and at most three are carried', many.logGroups.length <= 3);

console.log('\n── the shapes that used to arrive empty ──');
// recentMessages can genuinely be empty for a live session: the monitor fills
// it only once it has parsed transcript lines. An empty centre reads as broken,
// so the fallback says something true instead of nothing.
const bare = buildOverlays({ sessions: [wireSession({ recentMessages: [] })] });
ok('a session with no messages still says something', bare.logGroups.length === 1);
ok('and what it says is real session data', /Claude Code/.test(bare.logGroups[0].lines[0].label));

const none = buildOverlays({ sessions: [] });
eq('no agents means no log', none.logGroups.length, 0);

console.log('\n── a truncated message is still a message ──');
// link.js cuts text to 140 chars. The engine cuts again to ~46 for the screen,
// so the only thing that matters here is that it survives as non-empty text.
const long = msgToLine({ role: 'assistant', type: 'text', text: 'x'.repeat(140), tokens: 3 });
ok('it draws', !!long.label);
ok('and is shortened for the field', long.label.length <= 46);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
