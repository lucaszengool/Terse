/* ── Room playback scheduler ─────────────────────────────────────────────────
   One room, many people, ONE strip of big particle text. Deciding what it says
   next is the whole problem, and a single shared FIFO gets it wrong: whoever's
   agent is chattiest fills the strip and everyone else disappears from the room.

   So this is per-person subqueues served ROUND-ROBIN — one line per person per
   turn — which is the standard cure for exactly that starvation. Two properties
   follow, and both are the point:

     · the room's cadence never changes. take() hands out one item per call, so
       five people talking do not make the wallpaper five times faster; they
       make it fairer. Speed is the caller's business, not the queue's.
     · a quiet person is never buried. Their one line is next in the rotation
       however far ahead the noisy person is.

   Chat messages do NOT take a turn — they PREEMPT. A person typing to the room
   is addressing humans, and waiting behind a build log would make the room feel
   dead. Messages are strictly ordered among themselves and always drain first.

   Pure logic, no DOM, no timers: this is the piece worth testing directly.
   ---------------------------------------------------------------------------- */
(function (root) {
  'use strict';

  function RoomQueue(opts) {
    opts = opts || {};
    // Per-person backlog cap. The wallpaper shows the present, not a transcript;
    // an agent that dumps 500 lines while you look away should cost you the
    // oldest 490, not a growing buffer.
    this.perUserCap = opts.perUserCap || 8;
    this.messageCap = opts.messageCap || 20;
    this._logs = new Map();      // memberId → array of items (insertion order)
    this._order = [];            // rotation order: stable, by first appearance
    this._cursor = 0;
    this._messages = [];
  }

  /** An agent log line from `memberId`. Returns the queue, for chaining. */
  RoomQueue.prototype.pushLog = function (memberId, item) {
    var id = String(memberId == null ? '' : memberId);
    var q = this._logs.get(id);
    if (!q) {
      q = [];
      this._logs.set(id, q);
      this._order.push(id);
    }
    q.push(item);
    while (q.length > this.perUserCap) q.shift();
    return this;
  };

  /** A chat message. Jumps every log line, regardless of whose turn it is. */
  RoomQueue.prototype.pushMessage = function (memberId, item) {
    this._messages.push({ memberId: String(memberId == null ? '' : memberId), item: item });
    while (this._messages.length > this.messageCap) this._messages.shift();
    return this;
  };

  /** Forget a member who left, so the rotation does not stall on an empty seat. */
  RoomQueue.prototype.drop = function (memberId) {
    var id = String(memberId);
    var i = this._order.indexOf(id);
    if (i === -1) return this;
    this._order.splice(i, 1);
    this._logs.delete(id);
    // Keep the cursor pointing at the same *upcoming* member: removing an entry
    // before it would otherwise skip whoever moved into its slot.
    if (i < this._cursor) this._cursor--;
    if (this._cursor > this._order.length) this._cursor = 0;
    return this;
  };

  RoomQueue.prototype.size = function () {
    var n = this._messages.length;
    this._logs.forEach(function (q) { n += q.length; });
    return n;
  };

  /** How many spoken lines are still waiting. The caller uses this to decide
      its own pace: a room where people are talking should keep up with them,
      and one where only agents are logging should not race. */
  RoomQueue.prototype.pendingMessages = function () { return this._messages.length; };

  RoomQueue.prototype.pendingFor = function (memberId) {
    var q = this._logs.get(String(memberId));
    return q ? q.length : 0;
  };

  /**
   * The next thing the strip should say, or null when the room is quiet.
   * Shape: { kind: 'message' | 'log', memberId, item }.
   */
  RoomQueue.prototype.take = function () {
    if (this._messages.length) {
      var m = this._messages.shift();
      return { kind: 'message', memberId: m.memberId, item: m.item };
    }
    // One full lap at most: if nobody has anything, the room is quiet. Without
    // the bound this spins forever on an all-empty rotation.
    for (var n = 0; n < this._order.length; n++) {
      if (this._cursor >= this._order.length) this._cursor = 0;
      var id = this._order[this._cursor];
      this._cursor++;
      var q = this._logs.get(id);
      if (q && q.length) return { kind: 'log', memberId: id, item: q.shift() };
    }
    return null;
  };

  var api = { RoomQueue: RoomQueue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TerseRoomQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);
