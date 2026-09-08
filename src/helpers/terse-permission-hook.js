#!/usr/bin/env node
/**
 * terse-permission-hook.js — answer Claude Code's permission prompts from the
 * Dynamic Island instead of the terminal.
 *
 * Wired as TWO hooks, both pointing at this one file; it dispatches on
 * hook_event_name:
 *
 *   PreToolUse                      — can decide. May hold the call.
 *   Notification/permission_prompt  — pure observation. Never holds, never decides.
 *
 * WHY BOTH. PreToolUse runs BEFORE Claude Code's permission check, so at that
 * moment nothing knows whether this call will actually be prompted for — the
 * old version guessed, and guessed wrong often enough that the island
 * interrupted work nobody was being asked to approve. The Notification event is
 * the ground truth: it fires only when Claude Code really did put a permission
 * prompt on screen, and it carries the SAME tool_use_id as the PreToolUse call.
 * Terse uses it to learn which calls genuinely prompt, and only those ever get
 * a card. See permission.rs.
 *
 * OUTPUT CONTRACT — this is what the previous version got wrong:
 *
 *   Claude Code defines exactly three permissionDecision values: allow, deny,
 *   ask. To say "I have no decision, carry on normally" a hook must exit 0 and
 *   print NOTHING. The old code printed permissionDecision:"defer" — not a real
 *   value — on essentially every tool call, in every session on the machine,
 *   because the hook is registered globally in ~/.claude/settings.json. An
 *   unrecognised decision is a schema violation on the agent's hot path.
 *   Silence is the correct way to stand aside.
 *
 * FAILURE POLICY — silence, never "allow":
 * if Terse is not running, the port is closed, the reply is malformed, or the
 * user does not answer in time, we print nothing and Claude Code's own
 * permission flow decides. A hook that failed open would silently auto-approve
 * every tool call the moment Terse crashed.
 */
const http = require('http');

const PORT = parseInt(process.env.TERSE_PERMISSION_PORT || '47822', 10);
// Ceiling on how long this process may hold the agent. Comfortably under the
// `timeout` registered on the hook entry so we always lose that race on purpose
// and exit cleanly rather than being killed mid-write.
const TIMEOUT_MS = parseInt(process.env.TERSE_PERMISSION_TIMEOUT || '15000', 10);
const VALID = new Set(['allow', 'deny', 'ask']);

let done = false;

/** Stand aside: no decision, normal permission flow applies. */
function passThrough() {
  if (done) return;
  done = true;
  process.exit(0);                      // deliberately no stdout
}

function decide(decision, reason) {
  if (done) return;
  done = true;
  // Belt and braces: never emit anything outside the documented vocabulary,
  // even if the app sends something unexpected.
  if (!VALID.has(decision)) return passThrough();
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  };
  if (reason) out.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

/** Nothing may outlive this, whatever goes wrong with sockets or the app. */
const guard = setTimeout(passThrough, TIMEOUT_MS + 1500);
guard.unref?.();

function post(path, body, onReply, onFail) {
  const data = JSON.stringify(body);
  const req = http.request(
    {
      host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: TIMEOUT_MS,
    },
    (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let r = null;
        try { r = JSON.parse(out); } catch { return onFail(); }
        onReply(r || {});
      });
    }
  );
  req.on('error', onFail);              // Terse not running → normal prompt
  req.on('timeout', () => { req.destroy(); onFail(); });
  req.write(data);
  req.end();
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', passThrough);
process.stdin.on('end', () => {
  let p;
  try { p = JSON.parse(raw); } catch { return passThrough(); }

  // ── Notification: Claude Code really is asking the user right now ─────────
  // Fire-and-forget. Claude Code waits for this hook, and its own prompt is
  // already on screen, so the one job here is to be fast and silent.
  if (p.hook_event_name === 'Notification') {
    // The registered matcher is already `permission_prompt`, so anything
    // arriving here has been filtered by Claude Code. Only bail on a type we
    // positively recognise as something else — treating a MISSING field as
    // "not a permission prompt" would silently disable learning if the payload
    // ever names it differently.
    const nt = p.notification_type;
    if (nt && nt !== 'permission_prompt') return passThrough();
    return post(
      '/notify',
      {
        sessionId: p.session_id,
        toolUseId: p.tool_use_id,
        toolName: p.tool_name,
        cwd: p.cwd,
        permissionMode: p.permission_mode,
      },
      passThrough,
      passThrough
    );
  }

  // ── PreToolUse: the only event that can answer ────────────────────────────
  post(
    '/permission',
    {
      sessionId: p.session_id,
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      toolInput: p.tool_input,
      cwd: p.cwd,
      permissionMode: p.permission_mode,
      // The card needs to show WHY, not just what. Only the path is sent —
      // Terse reads the tail itself, so nothing about the conversation crosses
      // this socket that was not already on disk.
      transcriptPath: p.transcript_path,
    },
    (r) => decide(r.decision, r.reason || 'Answered in Terse'),
    passThrough
  );
});
