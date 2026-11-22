/**
 * Gesture classification: a hand-written geometric classifier over MediaPipe's 21
 * hand landmarks, an adapter for MediaPipe's trained gesture classifier, and the
 * quality-weighted fusion of the two.
 *
 * Everything here is pure maths over plain `{x, y, z}` objects -- no DOM, no
 * Three.js, no MediaPipe import -- so it runs unchanged in the browser and under
 * `node --test`.
 *
 * Landmark indices follow MediaPipe's hand model:
 *   0 wrist · 1-4 thumb · 5-8 index · 9-12 middle · 13-16 ring · 17-20 pinky
 *
 * @module gesture/classifier
 */
import { clamp01, smooth01 } from '../core/math.js';

/** The three gestures the experience responds to. */
export const GESTURE_NAMES = Object.freeze(['Pointing_Up', 'Open_Palm', 'Victory']);

export const GESTURE_LABELS = Object.freeze({
    Pointing_Up: 'POINT',
    Open_Palm: 'OPEN PALM',
    Victory: 'VICTORY'
});

const FINGER_JOINTS = Object.freeze({
    index:  [5, 6, 7, 8],
    middle: [9, 10, 11, 12],
    ring:   [13, 14, 15, 16],
    pinky:  [17, 18, 19, 20]
});

// Neutral score used when a joint is occluded/degenerate. 0.5 == "no evidence
// either way", which keeps an unreadable finger from dominating a gesture score.
const EXT_UNKNOWN = 0.5;

function dist3(a, b) {
    if (!a || !b) return 0;
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Planar distance. Normalized landmark z is in a wrist-relative, loosely x-scaled
// unit that is not comparable to x/y, so including it in an "apparent size" metric
// only injects noise.
function dist2(a, b) {
    if (!a || !b) return 0;
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Interior angle at vertex `b`, in degrees. Returns NaN for degenerate geometry so
// callers can distinguish "unknown" from "fully folded" (0 deg) -- treating an
// occluded joint as folded biases every score toward Pointing_Up.
// Written with scalar locals: this runs 10x per inference frame.
function angleAt(a, b, c) {
    if (!a || !b || !c) return NaN;
    const abx = a.x - b.x, aby = a.y - b.y, abz = a.z - b.z;
    const cbx = c.x - b.x, cby = c.y - b.y, cbz = c.z - b.z;
    const lab = Math.sqrt(abx * abx + aby * aby + abz * abz);
    const lcb = Math.sqrt(cbx * cbx + cby * cby + cbz * cbz);
    if (lab < 1e-6 || lcb < 1e-6) return NaN;
    const dot = (abx * cbx + aby * cby + abz * cbz) / (lab * lcb);
    return Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot) * 180 / Math.PI;
}

function fingerExtensionScore(lm, joints) {
    const [mcp, pip, dip, tip] = joints;
    if (!lm[mcp] || !lm[pip] || !lm[dip] || !lm[tip]) return EXT_UNKNOWN;
    const pipAngle = angleAt(lm[mcp], lm[pip], lm[dip]);
    const dipAngle = angleAt(lm[pip], lm[dip], lm[tip]);
    if (Number.isNaN(pipAngle) && Number.isNaN(dipAngle)) return EXT_UNKNOWN;

    // Re-normalise the straightness weights over whichever joints are readable so a
    // single occluded DIP cannot cap the score at 0.58.
    let straight = 0, wsum = 0;
    if (!Number.isNaN(pipAngle)) { straight += 0.58 * smooth01(132, 169, pipAngle); wsum += 0.58; }
    if (!Number.isNaN(dipAngle)) { straight += 0.27 * smooth01(130, 168, dipAngle); wsum += 0.27; }
    const straightness = wsum > 0 ? (straight / wsum) * 0.85 : EXT_UNKNOWN * 0.85;

    const wristPip = dist3(lm[0], lm[pip]);
    if (wristPip < 1e-5) return clamp01(straightness);
    const reach = 0.15 * smooth01(1.02, 1.22, dist3(lm[0], lm[tip]) / wristPip);
    return clamp01(straightness + reach);
}

// The thumb has no PIP/DIP pair comparable to the fingers; abduction from the index
// MCP is the reliable signal for "open hand" vs "fist/point".
function thumbExtensionScore(lm) {
    if (!lm[1] || !lm[2] || !lm[3] || !lm[4] || !lm[5] || !lm[17]) return EXT_UNKNOWN;
    const ipAngle = angleAt(lm[2], lm[3], lm[4]);
    const mcpAngle = angleAt(lm[1], lm[2], lm[3]);
    const palmWidth = dist3(lm[5], lm[17]);
    if (palmWidth < 1e-5) return EXT_UNKNOWN;
    // Tip-to-index-MCP distance normalised by palm width: large when the thumb is
    // splayed out, small when it is tucked across the palm.
    const spread = smooth01(0.55, 1.05, dist3(lm[4], lm[5]) / palmWidth);
    let straight = 0, wsum = 0;
    if (!Number.isNaN(ipAngle))  { straight += smooth01(120, 165, ipAngle);  wsum += 1; }
    if (!Number.isNaN(mcpAngle)) { straight += smooth01(120, 165, mcpAngle); wsum += 1; }
    const straightness = wsum > 0 ? straight / wsum : EXT_UNKNOWN;
    return clamp01(0.45 * straightness + 0.55 * spread);
}

// Z component of the unit palm normal in world-landmark space, or NaN when the palm
// triangle is degenerate. |nz| near 1 means the palm faces the camera; near 0 means
// it is edge-on, where 2D-projected heuristics become ambiguous.
function palmNormalZ(lm) {
    const wx = lm[0].x, wy = lm[0].y, wz = lm[0].z;
    const ax = lm[5].x - wx, ay = lm[5].y - wy, az = lm[5].z - wz;
    const bx = lm[17].x - wx, by = lm[17].y - wy, bz = lm[17].z - wz;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    return nl < 1e-9 ? NaN : nz / nl;
}

/**
 * Score each supported gesture from landmark geometry alone.
 *
 * @param {Array<{x:number,y:number,z:number}>} normalized image-space landmarks (y down)
 * @param {Array<{x:number,y:number,z:number}>} [world] metric world landmarks (y up);
 *        preferred for the shape scores when present because they are scale-free
 * @returns {{Pointing_Up:number, Open_Palm:number, Victory:number, handScale:number, quality:number}}
 *          gesture scores in [0,1], apparent hand size (zoom proxy), and a [0,1]
 *          trust term describing how face-on the palm is presented
 */
export function geometryGestureScores(normalized, world) {
    const useWorld = world?.length === 21;
    const lm = useWorld ? world : normalized;
    if (!lm?.length || lm.length < 21 || !lm[0]) {
        return { Pointing_Up: 0, Open_Palm: 0, Victory: 0, handScale: 0, quality: 0 };
    }

    const eThumb  = thumbExtensionScore(lm);
    const eIndex  = fingerExtensionScore(lm, FINGER_JOINTS.index);
    const eMiddle = fingerExtensionScore(lm, FINGER_JOINTS.middle);
    const eRing   = fingerExtensionScore(lm, FINGER_JOINTS.ring);
    const ePinky  = fingerExtensionScore(lm, FINGER_JOINTS.pinky);

    const palmWidth = dist3(lm[5], lm[17]);
    const handSpan  = dist3(lm[0], lm[9]);

    // --- Pointing_Up -------------------------------------------------------
    // Extended index, folded middle/ring/pinky, AND an index axis that is not
    // pointing back along the palm. Verticality is scored generously so a relaxed,
    // slightly-tilted point still reads, but a horizontal "finger gun" does not
    // score identically to a raised finger.
    let pointDirection = 0.5;
    if (lm[5] && lm[8]) {
        const dx = lm[8].x - lm[5].x, dy = lm[8].y - lm[5].y, dz = lm[8].z - lm[5].z;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl > 1e-6) {
            // World landmarks are y-up; normalized landmarks are y-down.
            const up = useWorld ? (dy / dl) : (-dy / dl);
            pointDirection = smooth01(-0.35, 0.45, up);
        }
    }
    const point = clamp01(
        0.34 * eIndex + 0.17 * (1 - eMiddle) + 0.14 * (1 - eRing) + 0.13 * (1 - ePinky)
        + 0.08 * (1 - eThumb) + 0.14 * pointDirection
    );

    // --- Victory -----------------------------------------------------------
    // Fingertip separation carries real weight: two fingers held together is a much
    // weaker Victory than a clear V.
    const victorySeparation = palmWidth > 1e-5 ? dist3(lm[8], lm[12]) / palmWidth : 0;
    const victory = clamp01(
        0.24 * eIndex + 0.24 * eMiddle + 0.16 * (1 - eRing) + 0.16 * (1 - ePinky)
        + 0.20 * smooth01(0.30, 0.78, victorySeparation)
    );

    // --- Open_Palm ---------------------------------------------------------
    // Down-weight the weakest finger: the pinky is the most frequently mis-tracked
    // landmark and should not veto an obvious open hand. The thumb participates,
    // which separates a real open palm from "four fingers up, thumb tucked".
    // (Branch-free top-3-of-4 instead of allocating and sorting an array.)
    const weakest = Math.min(eIndex, eMiddle, eRing, ePinky);
    const fingerCore = (eIndex + eMiddle + eRing + ePinky - weakest + 0.55 * weakest) / 3.55;
    const openPalm = clamp01(0.82 * fingerCore + 0.18 * eThumb);

    // --- Distance proxy ----------------------------------------------------
    // Apparent hand size in image space drives palm zoom. Computed from normalized
    // landmarks because metric world landmarks do not scale with camera distance.
    let handScale = 0;
    if (normalized?.length === 21 && normalized[0] && normalized[5] && normalized[9] && normalized[17]) {
        handScale = clamp01(0.65 * dist2(normalized[5], normalized[17]) + 0.35 * dist2(normalized[0], normalized[9]) * 1.55);
    } else if (useWorld && palmWidth > 1e-6) {
        handScale = clamp01((0.62 * palmWidth + 0.38 * handSpan * 0.62) * 2.05);
    }

    // Confidence that the palm is presented face-on enough for the 2D-projected
    // heuristics to be meaningful. Feeds the fusion stage as a geometry-trust term.
    let quality = 1;
    if (useWorld) {
        const nz = palmNormalZ(lm);
        if (!Number.isNaN(nz)) quality = clamp01(0.35 + 0.65 * smooth01(0.15, 0.60, Math.abs(nz)));
    }

    return { Pointing_Up: point, Open_Palm: openPalm, Victory: victory, handScale, quality };
}

// Canned MediaPipe labels that are not mapped to an action but are positive evidence
// that the user is NOT performing one of our three gestures. Folding them into
// `None` makes the fusion veto fire for a fist or thumbs-up instead of leaving
// geometry unchallenged.
const MP_NEGATIVE_LABELS = Object.freeze(['Closed_Fist', 'Thumb_Up', 'Thumb_Down', 'ILoveYou']);

// Reused across calls: the classifier runs at up to ~26 Hz.
const mlScores = { Pointing_Up: 0, Open_Palm: 0, Victory: 0, None: 0 };

/**
 * Collapse MediaPipe's gesture categories into our label set.
 * NOTE: returns a shared scratch object that is overwritten on the next call.
 *
 * @param {Array<{categoryName:string, score:number}>} categories
 */
export function mediaPipeGestureScores(categories) {
    mlScores.Pointing_Up = 0;
    mlScores.Open_Palm = 0;
    mlScores.Victory = 0;
    mlScores.None = 0;
    for (const c of categories || []) {
        const name = c?.categoryName;
        // Object.hasOwn, not `in`: `in` also matches Object.prototype keys, so a
        // category literally named "constructor" would corrupt the map.
        if (name && Object.hasOwn(mlScores, name)) {
            mlScores[name] = Math.max(mlScores[name], clamp01(c.score));
        } else if (name && MP_NEGATIVE_LABELS.includes(name)) {
            mlScores.None = Math.max(mlScores.None, clamp01(c.score));
        }
    }
    return mlScores;
}

// Reused across calls so the fusion stage performs no per-frame allocation.
const fused = { Pointing_Up: 0, Open_Palm: 0, Victory: 0 };

/**
 * Fuse the trained classifier with the geometric heuristics.
 *
 * The neural classifier is the more trustworthy signal on canonical poses, so it
 * carries the majority weight. Geometry is retained because the canned classifier
 * drops out on partial occlusion and off-axis hands, but its influence is scaled by
 * `quality` (how face-on the palm is) so unreliable 2D-projected heuristics cannot
 * override a confident model prediction.
 * NOTE: returns a shared scratch object that is overwritten on the next call.
 */
export function fuseGestureScores(geom, ml, quality = 1) {
    const q = clamp01(quality);
    // Geometry weight ranges 0.30 (edge-on palm, geometry untrustworthy) to 0.46.
    const wGeom = 0.30 + 0.16 * q;
    const wMl   = 1 - wGeom;
    const none  = clamp01(ml?.None);
    for (const name of GESTURE_NAMES) {
        const g = clamp01(geom?.[name]);
        const m = clamp01(ml?.[name]);
        let score = wGeom * g + wMl * m;
        // Mutual agreement is strong evidence: let a confident pair exceed the
        // linear blend rather than being dragged down by it.
        if (g > 0.80 && m > 0.55) score = Math.max(score, 0.84 + 0.14 * Math.min(g, m));
        // Trust a very confident model even when geometry is mediocre (off-axis).
        else if (m > 0.82) score = Math.max(score, 0.74 + 0.22 * m);
        // Geometry alone can still activate, but only when it is unambiguous and
        // the palm is well presented -- capped below the "agreement" ceiling.
        else if (g > 0.88 && q > 0.75 && none < 0.55) score = Math.max(score, 0.70 + 0.10 * g);
        // Explicit "no gesture" from the model vetoes weak geometry.
        if (none > 0.70 && g < 0.72) score *= 0.72;
        fused[name] = clamp01(score);
    }
    return fused;
}
