/**
 * The Windows gesture tracker must emit the exact line terse-hands emits.
 *
 * Every gesture consumer — gesture-core.js and everything built on it — was
 * written against terse-hands' stdout. The Windows tracker replaces that stdout
 * with MediaPipe, so a drift here does not crash anything: the cursor simply
 * lands on the wrong side of the screen, or the wrong hand gets named, or a
 * joint quietly reads as missing. These pin the conversion to the contract.
 *
 * Run: node src/renderer/hands-frame.test.mjs
 */
import { handsJson, frameLine } from './hands-frame.js';

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) pass++; else { fail++; console.error('FAIL: ' + msg); } };

// A synthetic MediaPipe result: one hand, 21 joints on a diagonal.
const lm = Array.from({ length: 21 }, (_, j) => ({ x: 0.1 + j * 0.01, y: 0.2 + j * 0.01, z: 0, visibility: 0 }));
const result = { landmarks: [lm], handedness: [[{ categoryName: 'Left', score: 0.973, index: 0 }]] };

const hands = handsJson(result);
ok('one hand in, one hand out', hands.length === 1);
const h = JSON.parse(hands[0]);
ok('21 joints × (x, y, confidence) = 63 numbers', h.p.length === 63);
ok('x is MIRRORED: MediaPipe 0.1 becomes 0.9 (move right, x grows)', h.p[0] === 0.9);
ok('y is NOT flipped: MediaPipe is already top-left, unlike Vision', h.p[1] === 0.2);
ok('every joint carries the hand score, which clears gesture-core\'s 0.1 gate', h.p[2] === 0.97 && h.p[62] === 0.97);
ok('last joint mirrored too: 1 − 0.30 = 0.7', h.p[60] === 0.7);
ok('MediaPipe "Left" on a raw frame is the person\'s RIGHT hand', h.c === 'r');
ok('score formatted like terse-hands (%.2f)', h.s === 0.97);

// Formatting, byte for byte: %.4f coordinates and %.2f confidences.
ok('coordinates are written with four decimals', /"p":\[0\.9000,0\.2000,0\.97,/.test(hands[0]));

// The other hand, and the unlabelled case.
const right = JSON.parse(handsJson({ landmarks: [lm], handedness: [[{ categoryName: 'Right', score: 0.5 }]] })[0]);
ok('MediaPipe "Right" on a raw frame is the person\'s LEFT hand', right.c === 'l');
const none = JSON.parse(handsJson({ landmarks: [lm], handedness: [] })[0]);
ok('no handedness → "u", like terse-hands without chirality', none.c === 'u' && none.s === 0.9);

// A missing joint reads exactly the way terse-hands writes one.
const gap = lm.slice(); gap[4] = undefined;
const g = JSON.parse(handsJson({ landmarks: [gap], handedness: [[{ categoryName: 'Left', score: 0.8 }]] })[0]);
ok('a missing joint is -1,-1,0', g.p[12] === -1 && g.p[13] === -1 && g.p[14] === 0);

// Two hands, and none.
ok('two hands in, two out', handsJson({ landmarks: [lm, lm], handedness: [[{ categoryName: 'Left', score: 1 }], [{ categoryName: 'Right', score: 1 }]] }).length === 2);
ok('no hands → empty array', handsJson({ landmarks: [], handedness: [] }).length === 0);
ok('a null result is not a crash', handsJson(null).length === 0);

// The whole line, and that it round-trips through JSON.parse the way
// gesture-core's attachGestures reads a hand-frame payload.
const line = frameLine(hands, 6.25, 1700000000000);
const fr = JSON.parse(line);
ok('line starts with {"t" — the prefix hands.rs routes as a frame, not a status', line.startsWith('{"t"'));
ok('t, ms and h are all there', fr.t === 1700000000000 && fr.ms === 6.3 && Array.isArray(fr.h) && fr.h.length === 1);
ok('an empty frame is still a frame: {"t":..,"h":[]}', JSON.parse(frameLine([], 1, 1)).h.length === 0);

// Shape match against terse-hands' own format string, joint for joint.
const SWIFT_HAND = /^\{"c":"[lru]","s":\d+\.\d\d,"p":\[(-?\d+(\.\d+)?,){62}-?\d+(\.\d+)?\]\}$/;
ok('each hand matches the terse-hands hand shape exactly', hands.every((s) => SWIFT_HAND.test(s)));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
