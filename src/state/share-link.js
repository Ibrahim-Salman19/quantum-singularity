/**
 * Shareable-link state: the URL hash that reproduces a scene exactly.
 *
 *   #t=0&p=2&sc=18&g=1.15&jp=0.85&ch=0.18&sp=0.55&ps=2.25&bl=1.05
 *
 * Parsing is deliberately forgiving: unknown keys are ignored and malformed or
 * out-of-range values are dropped individually, so an outdated or hand-edited link
 * degrades to the defaults instead of breaking the experience. Slider values are
 * returned unclamped; the slider layer clamps them to each control's range.
 *
 * @module state/share-link
 */

/** Hash key -> slider id, in serialization order. */
export const SLIDER_KEYS = Object.freeze({
    sc: 'scale',
    g:  'gravity',
    jp: 'jetPower',
    ch: 'chaos',
    sp: 'speed',
    ps: 'psize',
    bl: 'bloom'
});

export const TOPOLOGY_COUNT = 6;
export const PALETTE_COUNT = 5;

function readNumber(params, key) {
    const raw = params.get(key);
    // Number(null) and Number('') are both 0, which would silently pass a range
    // check; an absent or empty key must stay absent.
    if (raw == null || raw.trim() === '') return undefined;
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
}

/**
 * @param {string} hash `location.hash`, with or without the leading `#`
 * @returns {{topology?: number, palette?: number, sliders: Record<string, number>}}
 */
export function parseShareHash(hash) {
    const result = { sliders: {} };
    if (typeof hash !== 'string') return result;
    const body = hash.replace(/^#/, '');
    if (body.length < 2) return result;
    const params = new URLSearchParams(body);

    for (const [key, id] of Object.entries(SLIDER_KEYS)) {
        const v = readNumber(params, key);
        if (v !== undefined) result.sliders[id] = v;
    }

    // Palette is an index: integers only.
    const palette = readNumber(params, 'p');
    if (Number.isInteger(palette) && palette >= 0 && palette < PALETTE_COUNT) result.palette = palette;

    // Topology tolerates fractional values (rounded), matching the shape slider.
    const topology = readNumber(params, 't');
    if (topology !== undefined && topology >= 0 && topology <= TOPOLOGY_COUNT - 1) {
        result.topology = Math.round(topology);
    }
    return result;
}

const fmt2 = (v) => +Number(v).toFixed(2);

/**
 * @param {{shape:number, palette:number} & Record<string, number>} state the live
 *        `uiV` slider state
 * @returns {string} hash body without the leading `#`
 */
export function serializeShareState(state) {
    const parts = [`t=${Math.round(state.shape)}`, `p=${state.palette}`];
    for (const [key, id] of Object.entries(SLIDER_KEYS)) parts.push(`${key}=${fmt2(state[id])}`);
    return parts.join('&');
}
