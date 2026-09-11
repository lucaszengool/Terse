/* hands-frame.js — a MediaPipe HandLandmarker result, as the line terse-hands
 * would have written for the same frame.
 *
 * Pure: no DOM, no MediaPipe import. It is the whole of the conversion the
 * Windows tracker (hands-tracker.html) performs, pulled out so that exact code
 * can be unit-tested in Node (hands-frame.test.mjs) and reused by harnesses —
 * a format drift here would break every gesture consumer at once, silently.
 *
 * terse-hands line:  {"t":epochMs,"ms":inferMs,"h":[{"c":"l|r|u","s":score,"p":[x,y,c ×21]}]}
 * Coordinates 0..1, top-left origin, MIRRORED: move your hand to your right and
 * x grows, like a mirror. Numbers are formatted exactly as terse-hands formats
 * them (%.4f for x and y, %.2f for scores).
 */

/** Per-hand JSON strings for the "h" array. */
export function handsJson(result) {
  const L = (result && result.landmarks) || [];
  const H = (result && result.handedness) || [];
  const hands = [];
  for (let i = 0; i < L.length; i++) {
    const cat = H[i] && H[i][0];
    const cs = (cat ? cat.score : 0.9).toFixed(2);
    // MediaPipe names the hand as if the picture were mirrored (the selfie
    // convention). The camera frame it is given is raw, not mirrored, so its
    // "Left" is the person's RIGHT hand. terse-hands reports the actual hand.
    const c = !cat ? 'u' : cat.categoryName === 'Left' ? 'r' : cat.categoryName === 'Right' ? 'l' : 'u';
    const pts = new Array(21);
    for (let j = 0; j < 21; j++) {
      const p = L[i][j];
      // Mirror x only. terse-hands flips y as well, but that is Apple Vision's
      // bottom-left origin; MediaPipe is already top-left. Hand landmarks carry
      // no per-joint confidence, so each joint gets the hand's score —
      // gesture-core only ever asks whether a joint clears 0.1.
      pts[j] = p ? `${(1 - p.x).toFixed(4)},${p.y.toFixed(4)},${cs}` : '-1,-1,0';
    }
    hands.push(`{"c":"${c}","s":${cs},"p":[${pts.join(',')}]}`);
  }
  return hands;
}

/** One frame line. */
export function frameLine(hands, ms, epochMs) {
  return `{"t":${epochMs},"ms":${ms.toFixed(1)},"h":[${hands.join(',')}]}`;
}
