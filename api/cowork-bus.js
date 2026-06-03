/**
 * Terse Cowork — in-process SSE pub/sub.
 *
 * Each team has a Set of open SSE responses. emit() fans a payload out to every
 * subscriber for that team. This is intentionally in-memory: Terse runs as a
 * single Railway instance, so a process-local bus is sufficient. Scaling
 * horizontally later would require swapping this for Redis pub/sub — the rest of
 * the cowork code only touches subscribe/unsubscribe/emit, so the surface is small.
 */

const channels = new Map(); // teamId → Set<res>

function subscribe(teamId, res) {
  let set = channels.get(teamId);
  if (!set) {
    set = new Set();
    channels.set(teamId, set);
  }
  set.add(res);
  return () => unsubscribe(teamId, res);
}

function unsubscribe(teamId, res) {
  const set = channels.get(teamId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) channels.delete(teamId);
}

function emit(teamId, payload) {
  const set = channels.get(teamId);
  if (!set || set.size === 0) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      unsubscribe(teamId, res);
    }
  }
}

function subscriberCount(teamId) {
  return channels.get(teamId)?.size || 0;
}

module.exports = { subscribe, unsubscribe, emit, subscriberCount };
