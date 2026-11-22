/**
 * Small numeric helpers shared by the render loop, the gesture pipeline and the
 * audio pipeline. Everything here is pure and allocation-free.
 * @module core/math
 */

/** Clamp `v` into `[lo, hi]`. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Clamp into `[0, 1]`, mapping non-finite input (NaN, ±Infinity) to 0. */
export function clamp01(v) {
    return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite smoothstep of `value` between `edge0` and `edge1`, output in `[0, 1]`. */
export function smooth01(edge0, edge1, value) {
    const x = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0));
    return x * x * (3 - 2 * x);
}

export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * Frame-rate independent exponential approach.
 *
 * A plain `lerp(current, target, k)` applied once per frame converges twice as fast
 * on a 120 Hz display as on a 60 Hz one, and slows to a crawl whenever a loop is
 * throttled. This normalises `k` (authored against a 60 Hz step) to the actual
 * elapsed time `dt` (seconds) so easing feels identical everywhere.
 */
export function approach(current, target, k, dt) {
    if (!(dt > 0)) return current;
    const t = 1 - Math.pow(1 - Math.min(0.999, k), dt * 60);
    return current + (target - current) * t;
}

/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012): an adaptive low-pass filter
 * whose cutoff rises with signal speed. Slow hand movement is smoothed heavily to
 * kill landmark jitter; fast movement passes through with little lag.
 *
 * @param {number} freq  initial sampling frequency estimate (Hz)
 * @param {number} mCut  minimum cutoff frequency (Hz)
 * @param {number} beta  speed coefficient
 * @param {number} dCut  cutoff for the derivative estimate (Hz)
 */
export class OneEuroFilter {
    constructor(freq, mCut = 1, beta = 0.007, dCut = 1) {
        this.f = freq; this.mc = mCut; this.b = beta; this.dc = dCut;
        this.yp = NaN; this.dyp = 0; this.lt = NaN;
    }
    _alpha(cut) {
        const r = 2 * Math.PI * cut / Math.max(1e-5, this.f);
        return r / (r + 1);
    }
    reset() { this.yp = NaN; this.dyp = 0; this.lt = NaN; }
    /** @param {number} x sample  @param {number} t timestamp in seconds */
    filter(x, t) {
        if (!Number.isNaN(this.lt) && t > this.lt) {
            this.f = 1 / Math.max(0.001, t - this.lt);
        }
        this.lt = t;
        const dx  = Number.isNaN(this.yp) ? 0 : (x - this.yp) * this.f;
        const adx = this._alpha(this.dc);
        const edx = Number.isNaN(this.dyp) ? dx : adx * dx + (1 - adx) * this.dyp;
        this.dyp  = edx;
        const a   = this._alpha(this.mc + this.b * Math.abs(edx));
        this.yp   = Number.isNaN(this.yp) ? x : a * x + (1 - a) * this.yp;
        return this.yp;
    }
}

/**
 * Deterministic 32-bit LCG (Numerical Recipes constants). Used wherever start-up
 * must be reproducible -- particle seeds and the index shuffle -- so two loads of
 * the page produce the same field and visual regressions are comparable.
 */
export function createLcg(seed = 0x9e3779b9) {
    let state = seed >>> 0;
    return {
        /** Next raw 32-bit unsigned integer. */
        nextUint() {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
        },
        /** Next float in `[0, 1)`. */
        next() { return this.nextUint() / 4294967296; }
    };
}
