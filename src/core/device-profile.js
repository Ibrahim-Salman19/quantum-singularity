/**
 * Device capability classification and the quality budget derived from it.
 *
 * The page must look its best on a gaming desktop and still hold frame rate on a
 * budget phone or a GPU-less VM. This module picks a starting tier from what the
 * browser exposes (GPU renderer string, memory, cores, Data Saver); the adaptive
 * quality loop in `main.js` then refines resolution and particle count from
 * measured frame times.
 *
 * Pure: everything is passed in, so the tiering is unit-tested against real
 * renderer strings from Chrome/ANGLE, Firefox, Safari and Mesa.
 *
 * @module core/device-profile
 */

/** Tier names, lowest to highest. */
export const QUALITY_TIERS = Object.freeze(['minimal', 'low', 'medium', 'high']);

// CPU rasterisers and VM display adapters. Note: "Mesa" alone is NOT software --
// Mesa is the standard Linux driver stack for real Intel/AMD GPUs; only its
// llvmpipe/softpipe/lavapipe back-ends are CPU renderers.
const SOFTWARE_GPU = /SwiftShader|llvmpipe|softpipe|lavapipe|Software Rasterizer|Basic Render|Microsoft Basic|VirtualBox|VMware SVGA|SVGA3D/i;
const DISCRETE_GPU = /NVIDIA|GeForce|Quadro|RTX|Radeon\s*(RX|Pro|VII)|Intel.*\bArc\b/i;
const INTEGRATED_GPU = /Intel|HD Graphics|UHD Graphics|Iris|Mali|Adreno|PowerVR|Radeon(\(TM\))?\s*(Graphics|Vega)/i;

/**
 * @param {string} rendererName unmasked WebGL renderer string ('' when hidden)
 * @returns {'software'|'discrete'|'integrated'|'unknown'}
 */
export function classifyGPU(rendererName) {
    const name = String(rendererName || '');
    if (!name) return 'unknown';
    if (SOFTWARE_GPU.test(name)) return 'software';
    if (DISCRETE_GPU.test(name)) return 'discrete';
    if (INTEGRATED_GPU.test(name)) return 'integrated';
    // Apple Silicon ("Apple M2", or Safari's masked "Apple GPU") and anything else
    // we cannot place: decide from memory/cores instead of guessing.
    return 'unknown';
}

/**
 * Pick a tier from hardware signals.
 *
 * `deviceMemory` is Chromium-only and capped at 8, so it can rule a device *down*
 * but never prove it high-end; Firefox and Safari do not expose it at all, which
 * must read as "unknown" rather than defaulting to a low value.
 *
 * @param {object} p
 * @param {string}  p.gpuClass     result of classifyGPU()
 * @param {number|undefined} p.deviceMemory navigator.deviceMemory (GiB) if exposed
 * @param {number|undefined} p.cores        navigator.hardwareConcurrency
 * @param {boolean} p.saveData     Data Saver / Lite mode requested
 * @param {boolean} p.isMobile     coarse pointer or narrow viewport
 * @returns {'minimal'|'low'|'medium'|'high'}
 */
export function pickTier({ gpuClass, deviceMemory, cores, saveData = false, isMobile = false }) {
    const mem = Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : null;
    const cpu = Number.isFinite(cores) && cores > 0 ? cores : null;

    if (gpuClass === 'software') return 'minimal';
    if (saveData && isMobile) return 'minimal';
    if (mem !== null && mem <= 2 && (cpu === null || cpu <= 2)) return 'minimal';

    if (saveData) return 'low';
    if (gpuClass === 'integrated') return 'low';
    if (mem !== null && mem <= 4) return 'low';
    if (cpu !== null && cpu <= 4) return 'low';

    if (gpuClass === 'discrete') return 'high';
    // Unknown GPU (Apple Silicon, masked renderer): a many-core machine that has
    // not reported low memory is treated as high-end.
    if (cpu !== null && cpu >= 10) return 'high';
    return 'medium';
}

// Per-tier budgets. Mobile has no separate "high": phone thermals cap out at medium.
const BUDGETS = Object.freeze({
    desktop: {
        minimal: { particles: 28000,  stars: 700,  dprCap: 1.0,  inferenceCap: 12 },
        low:     { particles: 48000,  stars: 1600, dprCap: 1.25, inferenceCap: 18 },
        medium:  { particles: 82000,  stars: 2800, dprCap: 1.75, inferenceCap: 26 },
        high:    { particles: 110000, stars: 3800, dprCap: 2.0,  inferenceCap: 26 }
    },
    mobile: {
        minimal: { particles: 18000,  stars: 400,  dprCap: 1.0,  inferenceCap: 12 },
        low:     { particles: 30000,  stars: 1000, dprCap: 1.15, inferenceCap: 20 },
        medium:  { particles: 52000,  stars: 2000, dprCap: 1.6,  inferenceCap: 20 },
        high:    { particles: 52000,  stars: 2000, dprCap: 1.6,  inferenceCap: 20 }
    }
});

/**
 * The particle count the shading was tuned at: the minimal desktop budget.
 */
export const COVERAGE_REFERENCE_PARTICLES = 28000;

/**
 * Point-size factor that keeps the field's screen coverage independent of the tier.
 *
 * Particles blend additively, so how much of the disk saturates grows with
 * count x point area. At the shading's tuned size, 110K particles covered the
 * inner disk several times over and it rendered as flat white. Scaling the point
 * diameter by sqrt(reference / count) holds count x area constant, so a bigger
 * budget buys finer detail instead of more light. Counts at or below the
 * reference are drawn as authored.
 *
 * @param {number} visibleCount particles currently drawn
 * @returns {number} factor in (0, 1]
 */
export function pointSizeCompensation(visibleCount, reference = COVERAGE_REFERENCE_PARTICLES) {
    const n = Number(visibleCount);
    if (!Number.isFinite(n) || n <= reference) return 1;
    return Math.sqrt(reference / n);
}

/**
 * Parse a `?quality=` override. Accepts tier names plus a few friendly aliases.
 * @returns {'minimal'|'low'|'medium'|'high'|null}
 */
export function parseQualityOverride(search) {
    let value = null;
    try { value = new URLSearchParams(search || '').get('quality'); } catch { return null; }
    if (!value) return null;
    const v = value.trim().toLowerCase();
    const aliases = { ultra: 'high', max: 'high', mid: 'medium', med: 'medium', min: 'minimal', potato: 'minimal' };
    const tier = aliases[v] || v;
    return QUALITY_TIERS.includes(tier) ? tier : null;
}

/**
 * Build the full quality profile.
 *
 * @param {object} p  hardware signals (see pickTier) plus:
 * @param {string} [p.rendererName]
 * @param {string|null} [p.override] tier forced via `?quality=`; disables the
 *        adaptive loop so the requested quality is actually what renders
 */
export function computeQualityProfile({ rendererName = '', deviceMemory, cores, saveData = false, isMobile = false, override = null }) {
    const gpuClass = classifyGPU(rendererName);
    const detected = pickTier({ gpuClass, deviceMemory, cores, saveData, isMobile });
    const tier = override && QUALITY_TIERS.includes(override) ? override : detected;
    const forced = tier === override;

    const ultraLowTier = tier === 'minimal';
    const lowTier = ultraLowTier || tier === 'low';
    const midTier = tier === 'medium';
    // Data Saver trims budgets further, unless the user explicitly forced a tier.
    const lite = saveData && !forced;

    const budget = BUDGETS[isMobile ? 'mobile' : 'desktop'][tier];
    return Object.freeze({
        tier,
        detectedTier: detected,
        forced,
        gpuClass,
        rendererName: String(rendererName || ''),
        ultraLowTier,
        lowTier,
        midTier,
        lite,
        particleCount: budget.particles,
        starCount: budget.stars,
        dprCap: budget.dprCap,
        targetFps: isMobile || ultraLowTier ? 50 : 58,
        inferenceFpsCap: budget.inferenceCap,
        // What camera teardown restores to, so repeated enable/disable cycles cannot
        // permanently ratchet the inference rate down.
        baselineInferenceFps: lite || ultraLowTier ? 12 : Math.min(budget.inferenceCap, isMobile ? 18 : 24),
        initialRenderScale: lite ? 0.75 : ultraLowTier ? 0.80 : lowTier ? 0.90 : 1.0,
        initialBloom: ultraLowTier ? 0.28 : lowTier ? 0.38 : 0.45,
        // Fraction of the allocated particles/stars drawn at start-up.
        initialParticleFraction: lite ? 0.72 : 1.0,
        initialStarFraction: lite ? 0.65 : 1.0,
        // MediaPipe delegates to try, in order. On a CPU rasteriser the "GPU"
        // delegate is emulated as well: under SwiftShader its first inference took
        // 24 s and each later one about twice as long as the CPU delegate's, so it
        // is not offered there. It follows the hardware, not a forced ?quality tier.
        visionDelegates: Object.freeze(gpuClass === 'software' ? ['CPU'] : ['GPU', 'CPU'])
    });
}
