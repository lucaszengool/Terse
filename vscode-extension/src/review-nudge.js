'use strict';
const vscode = require('vscode');

const REVIEW_URL = 'https://marketplace.visualstudio.com/items?itemName=LucasZeng.terse-optimizer&ssr=false#review-details';
const NUDGE_EVERY = 25;

const KEY_COUNT = 'terse.reviewOptimizeCount';
const KEY_NEXT_AT = 'terse.reviewNudgeAt';
const KEY_NEVER = 'terse.reviewNever';

let _context = null;
let _showing = false;

function init(context) {
  _context = context;
}

// Call after each successful optimization. Shows a one-time rate-us nudge
// every NUDGE_EVERY successes until the user rates or picks "Never".
async function recordSuccess() {
  if (!_context || _showing) return;
  if (_context.globalState.get(KEY_NEVER, false)) return;

  const count = _context.globalState.get(KEY_COUNT, 0) + 1;
  await _context.globalState.update(KEY_COUNT, count);

  const nextAt = _context.globalState.get(KEY_NEXT_AT, NUDGE_EVERY);
  if (count < nextAt) return;

  _showing = true;
  try {
    // Re-arm immediately so a dismissed toast never repeats until +NUDGE_EVERY.
    await _context.globalState.update(KEY_NEXT_AT, count + NUDGE_EVERY);
    const choice = await vscode.window.showInformationMessage(
      'Terse has saved you tokens 25 times 🎉 — mind leaving a quick review?',
      'Rate Terse ⭐', 'Later', 'Never'
    );
    if (choice === 'Rate Terse ⭐') {
      await _context.globalState.update(KEY_NEVER, true);
      vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
    } else if (choice === 'Never') {
      await _context.globalState.update(KEY_NEVER, true);
    }
    // 'Later' (or dismissed): already re-armed at count + NUDGE_EVERY.
  } finally {
    _showing = false;
  }
}

module.exports = { init, recordSuccess };
