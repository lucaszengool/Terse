/**
 * cowork-relay.js — one SSE connection per machine, shared by every window.
 *
 * WHY THIS EXISTS.
 * Terse runs many windows at once: main, island, wallpaper, and one dashboard
 * per metric. If each opened its own stream to the team endpoint they would run
 * into the browser's HTTP/1.1 limit of six connections per domain — and the
 * failure mode is not an error you can catch, it is streams that silently never
 * open, so whichever window happened to be seventh just shows nothing. That is
 * a miserable bug to diagnose in the field.
 *
 * So: exactly one window owns the EventSource. It claims ownership through a
 * Rust atomic (`cowork_claim_owner`), and forwards everything it receives to
 * `cowork_relay`, which re-emits to every window as a `cowork-peer` event.
 * Every other window is a pure listener and opens no connection at all.
 *
 * FAILURE BEHAVIOUR IS THE POINT:
 *   · the claim lives in app memory, never on disk — a crash cannot leave a
 *     stale owner that stops anyone from ever connecting again;
 *   · the owner releases on unload, and any other window will claim it on its
 *     next tick, so closing a window does not end the session;
 *   · if the claim fails, the window still receives every event as a listener.
 *
 * NOTHING HERE RUNS UNTIL A TEAM IS JOINED. connect() is the only entry point,
 * and until it is called this module opens no socket, registers no timer and
 * emits no event — so a solo user's app behaves exactly as it did before.
 */

const TAURI = () => window.__TAURI__;
const invoke = (c, a) => TAURI()?.core?.invoke(c, a);

// Any nonzero token, unique per window instance. Ownership is only ever
// compared for equality, so the value itself does not matter.
const SELF_ID = Math.floor(Math.random() * 0xffffffff) + 1;

let es = null;              // the EventSource — only ever on the owner
let owner = false;
let team = null;
let token = null;
let claimTimer = 0;
const handlers = new Set();

/** Subscribe to peer events. Safe to call from any window, any time. */
export function onPeer(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

function fanOutLocally(payload) {
  for (const fn of handlers) {
    try { fn(payload); } catch (e) { /* one bad handler must not stop the rest */ }
  }
}

/** Open the shared stream for a team. Idempotent. */
export async function connect(teamId, authToken, apiBase) {
  if (!TAURI() || !teamId) return false;
  team = teamId; token = authToken;
  const API = apiBase || '';

  // Every window listens, whether or not it ends up owning the connection.
  TAURI().event?.listen('cowork-peer', (ev) => fanOutLocally(ev.payload));

  const tryClaim = async () => {
    if (owner || !team) return;
    let got = false;
    try { got = await invoke('cowork_claim_owner', { id: SELF_ID }); } catch (e) { return; }
    if (!got) return;                       // another window has it — stay a listener
    owner = true;
    openStream(API);
  };

  await tryClaim();
  // Re-attempt periodically: if the owning window closes, whichever window is
  // still alive picks the connection back up without the user noticing.
  clearInterval(claimTimer);
  claimTimer = setInterval(tryClaim, 4000);

  window.addEventListener('beforeunload', release);
  return true;
}

function openStream(API) {
  closeStream();
  const url = `${API}/api/cloud/teams/${encodeURIComponent(team)}/stream` +
              `?token=${encodeURIComponent(token || '')}`;
  es = new EventSource(url);
  es.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    // Straight to Rust, which fans out to every window — including this one, so
    // the owner takes exactly the same path as everyone else and there is only
    // one code path to reason about.
    invoke('cowork_relay', { payload })?.catch(() => {});
  };
  // EventSource reconnects on its own, and Last-Event-ID means the server can
  // resume without sticky sessions. Nothing to do here but let it.
  es.onerror = () => {};
}

function closeStream() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
}

/** Leave the team. Returns the app to exactly its solo behaviour. */
export function disconnect() {
  clearInterval(claimTimer); claimTimer = 0;
  closeStream();
  release();
  team = null; token = null;
  handlers.clear();
}

function release() {
  if (!owner) return;
  owner = false;
  try { invoke('cowork_release_owner', { id: SELF_ID }); } catch (e) {}
}

export function isConnected() { return !!team; }
