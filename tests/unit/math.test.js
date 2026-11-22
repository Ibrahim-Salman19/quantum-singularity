import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, clamp01, lerp, smooth01, easeOutExpo, approach, OneEuroFilter, createLcg } from '../../src/core/math.js';

describe('scalar helpers', () => {
    test('clamp and clamp01 bound their input', () => {
        assert.equal(clamp(5, 0, 1), 1);
        assert.equal(clamp(-5, 0, 1), 0);
        assert.equal(clamp(0.25, 0, 1), 0.25);
        assert.equal(clamp01(2), 1);
        assert.equal(clamp01(-1), 0);
    });

    test('clamp01 maps non-finite input to 0 instead of propagating NaN', () => {
        for (const v of [NaN, Infinity, -Infinity, undefined, null, 'x']) assert.equal(clamp01(v), 0);
    });

    test('lerp hits both endpoints', () => {
        assert.equal(lerp(10, 20, 0), 10);
        assert.equal(lerp(10, 20, 1), 20);
        assert.equal(lerp(10, 20, 0.5), 15);
    });

    test('smooth01 is 0/1 outside the edges and monotonic inside', () => {
        assert.equal(smooth01(0.2, 0.8, 0), 0);
        assert.equal(smooth01(0.2, 0.8, 1), 1);
        assert.ok(Math.abs(smooth01(0.2, 0.8, 0.5) - 0.5) < 1e-12);
        let prev = -1;
        for (let x = 0.2; x <= 0.8; x += 0.01) {
            const y = smooth01(0.2, 0.8, x);
            assert.ok(y >= prev);
            prev = y;
        }
    });

    test('smooth01 tolerates degenerate (equal) edges', () => {
        assert.ok(Number.isFinite(smooth01(0.5, 0.5, 0.4)));
        assert.ok(Number.isFinite(smooth01(0.5, 0.5, 0.6)));
    });

    test('easeOutExpo starts at 0, ends exactly at 1', () => {
        assert.equal(easeOutExpo(0), 0);
        assert.equal(easeOutExpo(1), 1);
        assert.equal(easeOutExpo(2), 1);
        assert.ok(easeOutExpo(0.5) > 0.95);
    });
});

describe('approach (frame-rate independent easing)', () => {
    const simulate = (hz, seconds, k) => {
        let v = 0;
        const dt = 1 / hz;
        for (let i = 0; i < Math.round(seconds * hz); i++) v = approach(v, 1, k, dt);
        return v;
    };

    test('converges identically at 30, 60, 120 and 144 Hz', () => {
        const ref = simulate(60, 0.5, 0.1);
        for (const hz of [30, 120, 144]) {
            assert.ok(Math.abs(simulate(hz, 0.5, 0.1) - ref) < 1e-9, `${hz} Hz diverged`);
        }
    });

    test('one 60 Hz step equals the authored lerp factor', () => {
        assert.ok(Math.abs(approach(0, 1, 0.25, 1 / 60) - 0.25) < 1e-12);
    });

    test('a zero, negative or NaN dt is a no-op', () => {
        assert.equal(approach(0.3, 1, 0.5, 0), 0.3);
        assert.equal(approach(0.3, 1, 0.5, -1), 0.3);
        assert.equal(approach(0.3, 1, 0.5, NaN), 0.3);
    });

    test('never overshoots, even with k >= 1 and a long frame', () => {
        const v = approach(0, 1, 5, 2);
        assert.ok(v <= 1 && v > 0.99);
    });
});

describe('OneEuroFilter', () => {
    test('passes the first sample through unchanged', () => {
        const f = new OneEuroFilter(30, 1, 0.01);
        assert.equal(f.filter(0.42, 0), 0.42);
    });

    test('suppresses jitter on a stationary signal', () => {
        const f = new OneEuroFilter(30, 1.0, 0.007);
        const rng = createLcg(7);
        let inVar = 0, outVar = 0;
        const n = 300;
        for (let i = 0; i < n; i++) {
            const noisy = 0.5 + (rng.next() - 0.5) * 0.02;
            const out = f.filter(noisy, i / 30);
            if (i > 30) { inVar += (noisy - 0.5) ** 2; outVar += (out - 0.5) ** 2; }
        }
        assert.ok(outVar < inVar * 0.5, `filtered variance ${outVar} vs raw ${inVar}`);
    });

    test('lag shrinks as speed grows (speed-adaptive cutoff)', () => {
        // For a constant-velocity ramp the steady-state lag is v / (2*pi*fc), with
        // fc = minCutoff + beta * |v|. Lag *relative to speed* must fall as the hand
        // moves faster: that is the property that removes swipe latency.
        const relativeLag = (speed) => {
            const f = new OneEuroFilter(30, 1.15, 0.055);
            let out = 0, x = 0;
            for (let i = 0; i <= 90; i++) { x = speed * i / 30; out = f.filter(x, i / 30); }
            return (x - out) / speed;
        };
        const slow = relativeLag(0.1), fast = relativeLag(20);
        assert.ok(fast < slow * 0.5, `fast ${fast} vs slow ${slow}`);
    });

    test('reset() forgets history', () => {
        const f = new OneEuroFilter(30);
        f.filter(0, 0); f.filter(0, 0.033);
        f.reset();
        assert.equal(f.filter(0.9, 1), 0.9);
    });

    test('re-estimates its sampling rate from timestamps', () => {
        const f = new OneEuroFilter(30);
        f.filter(0, 0);
        f.filter(0, 0.01);
        assert.ok(Math.abs(f.f - 100) < 1e-6);
    });
});

describe('createLcg', () => {
    test('is deterministic for a given seed', () => {
        const a = createLcg(123), b = createLcg(123);
        for (let i = 0; i < 100; i++) assert.equal(a.nextUint(), b.nextUint());
    });

    test('different seeds diverge', () => {
        assert.notEqual(createLcg(1).nextUint(), createLcg(2).nextUint());
    });

    test('next() stays in [0, 1)', () => {
        const r = createLcg(99);
        for (let i = 0; i < 10000; i++) {
            const v = r.next();
            assert.ok(v >= 0 && v < 1);
        }
    });

    test('matches the original inline shuffle generator bit for bit', () => {
        // The particle index shuffle predates this module; the extracted generator
        // must reproduce it exactly or the field layout would silently change.
        let legacy = 0x9e3779b9;
        const r = createLcg(0x9e3779b9);
        for (let i = 0; i < 1000; i++) {
            legacy = (legacy * 1664525 + 1013904223) >>> 0;
            assert.equal(r.nextUint(), legacy);
        }
    });
});
