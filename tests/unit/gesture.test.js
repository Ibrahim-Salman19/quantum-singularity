import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { POSES, makeHand } from '../fixtures/hand-poses.mjs';
import {
    GESTURE_NAMES, geometryGestureScores, mediaPipeGestureScores, fuseGestureScores
} from '../../src/gesture/classifier.js';
import { createGestureStateMachine, GESTURE_THRESHOLDS } from '../../src/gesture/state-machine.js';

const geom = (pose) => geometryGestureScores(pose.normalized, pose.world);

describe('geometry classifier', () => {
    test('open palm scores highest for Open_Palm', () => {
        const s = geom(POSES.openPalm());
        assert.ok(s.Open_Palm > 0.80);
        assert.ok(s.Open_Palm > s.Pointing_Up && s.Open_Palm > s.Victory);
    });

    test('pointing index scores highest for Pointing_Up', () => {
        const s = geom(POSES.point());
        assert.ok(s.Pointing_Up > 0.70);
        assert.ok(s.Pointing_Up > s.Open_Palm && s.Pointing_Up > s.Victory);
    });

    test('victory sign scores highest for Victory', () => {
        const s = geom(POSES.victory());
        assert.ok(s.Victory > 0.70);
        assert.ok(s.Victory > s.Open_Palm && s.Victory > s.Pointing_Up);
    });

    test('a closed fist matches no gesture', () => {
        const s = geom(POSES.fist());
        assert.ok(s.Open_Palm < 0.45);
        assert.ok(s.Victory < 0.60);
    });

    test('two fingers held together score lower than a spread V', () => {
        assert.ok(geom(POSES.twoTogether()).Victory < geom(POSES.victory()).Victory);
    });

    test('open palm and victory are separated by a comfortable margin', () => {
        const palm = geom(POSES.openPalm()), vic = geom(POSES.victory());
        assert.ok(palm.Open_Palm - palm.Victory > 0.15);
        assert.ok(vic.Victory - vic.Open_Palm > 0.15);
    });

    test('a horizontal point scores lower than a raised point', () => {
        const up = geom(makeHand({ thumb: 0.75, index: 0, middle: 1, ring: 1, pinky: 1 }));
        const side = geom(makeHand({ thumb: 0.75, index: 0, middle: 1, ring: 1, pinky: 1, tilt: Math.PI / 2 }));
        assert.ok(side.Pointing_Up < up.Pointing_Up);
    });

    test('shape scores are scale invariant (near vs far hand)', () => {
        const pose = { index: 0, middle: 1, ring: 1, pinky: 1, thumb: 0.75 };
        const near = geom(makeHand({ ...pose, scale: 1.5 }));
        const far = geom(makeHand({ ...pose, scale: 0.6 }));
        assert.ok(Math.abs(near.Pointing_Up - far.Pointing_Up) < 0.08);
    });

    test('handScale grows monotonically with apparent size (drives palm zoom)', () => {
        const values = [0.6, 0.9, 1.2, 1.6].map((scale) => geom(makeHand({ spread: 0.55, scale })).handScale);
        for (let i = 1; i < values.length; i++) assert.ok(values[i] > values[i - 1]);
    });

    test('palm-normal quality drops for an edge-on hand', () => {
        const faceOn = geom(makeHand({ spread: 0.55 }));
        const edgeOn = geom(makeHand({ spread: 0.55, roll: Math.PI / 2 }));
        assert.ok(edgeOn.quality < faceOn.quality);
    });

    test('works from normalized landmarks alone (no world landmarks)', () => {
        const s = geometryGestureScores(POSES.openPalm().normalized, undefined);
        assert.ok(s.Open_Palm > s.Pointing_Up);
        assert.equal(s.quality, 1);
    });

    test('malformed input never throws or yields NaN', () => {
        const cases = [
            [null, null], [[], []], [new Array(21).fill(null), null],
            [new Array(5).fill({ x: 0, y: 0, z: 0 }), null],
            [new Array(21).fill({ x: 0, y: 0, z: 0 }), new Array(21).fill({ x: 0, y: 0, z: 0 })]
        ];
        for (const [n, w] of cases) {
            const s = geometryGestureScores(n, w);
            for (const v of Object.values(s)) assert.ok(Number.isFinite(v));
        }
    });

    test('a single occluded joint degrades gracefully', () => {
        const pose = POSES.openPalm();
        pose.world[7] = null; pose.normalized[7] = null;
        const s = geom(pose);
        assert.ok(s.Open_Palm > 0.6, `open palm collapsed to ${s.Open_Palm}`);
    });
});

describe('MediaPipe score adapter', () => {
    test('maps our three labels and keeps the max per label', () => {
        const ml = mediaPipeGestureScores([
            { categoryName: 'Victory', score: 0.4 },
            { categoryName: 'Victory', score: 0.7 },
            { categoryName: 'Open_Palm', score: 0.1 }
        ]);
        assert.equal(ml.Victory, 0.7);
        assert.equal(ml.Open_Palm, 0.1);
        assert.equal(ml.Pointing_Up, 0);
    });

    test('non-actionable canned labels feed the None veto', () => {
        assert.ok(mediaPipeGestureScores([{ categoryName: 'Closed_Fist', score: 0.93 }]).None > 0.9);
        assert.ok(mediaPipeGestureScores([{ categoryName: 'Thumb_Up', score: 0.8 }]).None > 0.7);
    });

    test('prototype keys cannot pollute the score map', () => {
        const ml = mediaPipeGestureScores([
            { categoryName: 'constructor', score: 0.99 },
            { categoryName: '__proto__', score: 0.99 },
            { categoryName: 'Victory', score: 0.7 }
        ]);
        assert.equal(ml.Victory, 0.7);
        assert.deepEqual(Object.keys(ml).sort(), ['None', 'Open_Palm', 'Pointing_Up', 'Victory']);
    });

    test('clears state between calls and tolerates junk input', () => {
        mediaPipeGestureScores([{ categoryName: 'Victory', score: 0.9 }]);
        const ml = mediaPipeGestureScores(undefined);
        assert.deepEqual({ ...ml }, { Pointing_Up: 0, Open_Palm: 0, Victory: 0, None: 0 });
        assert.doesNotThrow(() => mediaPipeGestureScores([null, {}, { categoryName: 'Victory', score: NaN }]));
    });
});

describe('fusion', () => {
    test('a confident classifier survives mediocre geometry', () => {
        const fused = fuseGestureScores(
            { Pointing_Up: 0.45, Open_Palm: 0.2, Victory: 0.2 },
            { Pointing_Up: 0.96, Open_Palm: 0.01, Victory: 0.01, None: 0.02 },
            0.5
        );
        assert.ok(fused.Pointing_Up > GESTURE_THRESHOLDS.GESTURE_ACTIVATE);
    });

    test('an explicit None suppresses weak geometry', () => {
        const fused = fuseGestureScores(
            { Pointing_Up: 0.60, Open_Palm: 0.2, Victory: 0.2 },
            { Pointing_Up: 0.05, Open_Palm: 0.02, Victory: 0.02, None: 0.95 },
            1
        );
        assert.ok(fused.Pointing_Up < 0.5);
    });

    test('agreement between geometry and classifier is boosted', () => {
        const fused = fuseGestureScores(
            { Pointing_Up: 0.90, Open_Palm: 0.1, Victory: 0.1 },
            { Pointing_Up: 0.92, Open_Palm: 0.02, Victory: 0.02, None: 0.04 },
            1
        );
        assert.ok(fused.Pointing_Up > 0.90);
    });

    test('unambiguous geometry can activate on its own when the palm is face-on', () => {
        const ml = { Pointing_Up: 0, Open_Palm: 0, Victory: 0, None: 0 };
        const fused = fuseGestureScores({ Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 }, ml, 1);
        assert.ok(fused.Pointing_Up >= GESTURE_THRESHOLDS.GESTURE_ACTIVATE);
    });

    test('geometry influence shrinks for an edge-on palm', () => {
        const ml = { Pointing_Up: 0.3, Open_Palm: 0, Victory: 0, None: 0 };
        const g = { Pointing_Up: 0.7, Open_Palm: 0, Victory: 0 };
        const faceOn = fuseGestureScores(g, ml, 1).Pointing_Up;
        const edgeOn = fuseGestureScores(g, ml, 0).Pointing_Up;
        assert.ok(edgeOn < faceOn);
    });

    test('outputs stay in [0, 1] for any input', () => {
        const fused = fuseGestureScores({ Pointing_Up: 9, Open_Palm: -9, Victory: NaN }, {}, 5);
        for (const name of GESTURE_NAMES) assert.ok(fused[name] >= 0 && fused[name] <= 1);
    });
});

describe('end to end: synthetic hand -> stable gesture', () => {
    for (const [pose, expected] of [['openPalm', 'Open_Palm'], ['point', 'Pointing_Up'], ['victory', 'Victory']]) {
        test(`${pose} held for 300 ms with an agreeing classifier activates ${expected}`, () => {
            const sm = createGestureStateMachine();
            const hand = POSES[pose]();
            const ml = mediaPipeGestureScores([{ categoryName: expected, score: 0.8 }]);
            let out;
            for (let t = 1; t <= 300; t += 40) {
                const g = geometryGestureScores(hand.normalized, hand.world);
                out = sm.update(fuseGestureScores(g, ml, g.quality), t);
            }
            assert.equal(out.gesture, expected);
        });
    }

    test('a fist with a Closed_Fist label never activates anything', () => {
        const sm = createGestureStateMachine();
        const hand = POSES.fist();
        const ml = mediaPipeGestureScores([{ categoryName: 'Closed_Fist', score: 0.9 }]);
        for (let t = 1; t <= 1000; t += 40) {
            const g = geometryGestureScores(hand.normalized, hand.world);
            assert.equal(sm.update(fuseGestureScores(g, ml, g.quality), t).gesture, null);
        }
    });
});

describe('temporal state machine', () => {
    const POINT = { Pointing_Up: 0.95, Open_Palm: 0, Victory: 0 };
    const NONE = { Pointing_Up: 0, Open_Palm: 0, Victory: 0 };
    let sm, t;
    const feed = (scores, ms, step = 40) => {
        let last;
        const end = t + ms;
        while (t <= end) { last = sm.update(scores, t); t += step; }
        return last;
    };
    beforeEach(() => { sm = createGestureStateMachine(); t = 1000; });

    test('a sustained confident score activates', () => {
        assert.equal(feed(POINT, 400).gesture, 'Pointing_Up');
    });

    test('a single-frame spike does not activate', () => {
        sm.update(NONE, t);
        sm.update({ Pointing_Up: 1, Open_Palm: 0, Victory: 0 }, t + 40);
        assert.equal(sm.update(NONE, t + 80).gesture, null);
    });

    test('an active gesture releases when its score collapses', () => {
        assert.equal(feed(POINT, 400).gesture, 'Pointing_Up');
        assert.equal(feed(NONE, 600).gesture, null);
    });

    test('REGRESSION: a flickering challenger cannot block release', () => {
        feed(POINT, 440);
        assert.equal(sm.snapshot().active, 'Pointing_Up');
        for (let i = 0; i < 40; i++) {
            sm.update({ Pointing_Up: 0, Open_Palm: i % 2 ? 0.98 : 0.2, Victory: 0 }, t);
            t += 40;
        }
        assert.notEqual(sm.snapshot().active, 'Pointing_Up');
    });

    test('holds through a brief tracking dropout', () => {
        feed(POINT, 440);
        sm.update(NONE, t); t += 40;
        sm.update(NONE, t); t += 40;
        sm.update(POINT, t);
        assert.equal(sm.snapshot().active, 'Pointing_Up');
    });

    test('switching requires a clear margin over the incumbent', () => {
        feed(POINT, 440);
        feed({ Pointing_Up: 0.90, Open_Palm: 0.93, Victory: 0 }, 440);
        assert.equal(sm.snapshot().active, 'Pointing_Up');
        feed({ Pointing_Up: 0.05, Open_Palm: 0.99, Victory: 0 }, 440);
        assert.equal(sm.snapshot().active, 'Open_Palm');
    });

    test('an ambiguous tie between two gestures never activates', () => {
        const out = feed({ Pointing_Up: 0.9, Open_Palm: 0.88, Victory: 0 }, 1000);
        assert.equal(out.gesture, null);
    });

    test('debounce timing is frame-rate independent (12 Hz vs 30 Hz)', () => {
        for (const step of [83, 33]) {
            sm.reset(); t = 1000;
            assert.equal(feed(POINT, 300, step).gesture, 'Pointing_Up', `step ${step} ms`);
        }
    });

    test('a single sample never confirms a gesture, even after a long gap', () => {
        sm.update(NONE, t);
        // 10 s later (tab hidden, or inference stalled): the EMA saturates in one step,
        // but one frame of evidence must still not be enough to confirm.
        assert.equal(sm.update(POINT, t + 10000).gesture, null);
        assert.equal(sm.update(POINT, t + 10040).gesture, 'Pointing_Up');
    });

    test('confirms within 250 ms at the 8 Hz ultra-low inference floor', () => {
        // Sample 1 only lifts the EMA to ~0.5; samples 2 and 3 are the two agreeing
        // candidate samples. 12 Hz also takes three samples, so latency scales with
        // the sample period instead of collapsing to a single frame.
        assert.equal(sm.update(POINT, t).gesture, null);
        assert.equal(sm.update(POINT, t + 125).gesture, null);
        assert.equal(sm.update(POINT, t + 250).gesture, 'Pointing_Up');
    });

    test('a spurious single frame between misses at 8 Hz does not activate', () => {
        for (let i = 0; i < 20; i++) {
            const scores = i % 3 === 1 ? POINT : NONE;
            assert.equal(sm.update(scores, t).gesture, null, `frame ${i}`);
            t += 125;
        }
    });

    test('reports the displayed confidence to the UI and zeroes it on reset', () => {
        const bars = [];
        const m = createGestureStateMachine({ onBar: (v) => bars.push(v) });
        m.update(POINT, 1000);
        m.update(POINT, 1040);
        assert.ok(bars.at(-1) > bars[0] && bars.at(-1) <= 1);
        m.reset();
        assert.equal(bars.at(-1), 0);
    });

    test('snapshot() returns a copy, not live state', () => {
        feed(POINT, 400);
        const snap = sm.snapshot();
        snap.ema.Pointing_Up = -1;
        assert.notEqual(sm.snapshot().ema.Pointing_Up, -1);
    });

    test('thresholds are internally consistent', () => {
        const th = GESTURE_THRESHOLDS;
        assert.ok(th.GESTURE_HOLD < th.GESTURE_ACTIVATE);
        assert.ok(th.GESTURE_ACTIVATE < th.GESTURE_SWITCH);
        assert.ok(th.GESTURE_CONFIRM_SEC < th.GESTURE_RELEASE_SEC);
        assert.ok(Object.isFrozen(th));
    });
});
