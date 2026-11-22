/**
 * Pure audio-analysis maths for the microphone-reactive mode: FFT band splitting
 * and an adaptive onset (beat) detector. No Web Audio objects are touched here, so
 * the maths is verified with synthetic frequency arrays under `node --test`.
 *
 * Bands:
 *   sub-bass   20-80 Hz   kick fundamental, sub-woofer content
 *   mid-bass   80-250 Hz  bass guitar, lower harmonics
 *   mids      250-2000 Hz vocals, most melodic content
 *   treble   2000-8000 Hz hi-hats, consonants, brightness
 *
 * @module audio/dsp
 */
import { approach, clamp } from '../core/math.js';

/**
 * Map an analyser's sample rate and FFT size to four exclusive band end-bins.
 * Each boundary is forced at least one bin past the previous so no band is empty,
 * even at very coarse FFT resolutions.
 */
export function computeAudioBandBins(sampleRate, fftSize, binCount) {
    const binHz = sampleRate / fftSize;
    const subBassBinEnd = clamp(Math.round(80 / binHz), 1, binCount);
    const midBassBinEnd = clamp(Math.round(250 / binHz), subBassBinEnd + 1, binCount);
    const midBinEnd     = clamp(Math.round(2000 / binHz), midBassBinEnd + 1, binCount);
    const trebleBinEnd  = clamp(Math.round(8000 / binHz), midBinEnd + 1, binCount);
    return {
        subBassBinEnd,
        midBassBinEnd,
        midBinEnd,
        trebleBinEnd,
        // Aliases for the original two-band API.
        bassBinEnd: midBassBinEnd,
        trebleBinStart: midBinEnd
    };
}

const binCount = (start, end) => Math.max(1, end - start);

/**
 * Average raw byte frequency bins (0..255) into normalised 0..1 band levels,
 * writing into `out` so the per-frame path allocates nothing.
 *
 * Four-band form: `(freqData, subBassEnd, midBassEnd, midEnd, trebleEnd, out)`
 * Legacy two-band form: `(freqData, bassEnd, trebleStart, trebleEnd, out)`
 */
export function computeAudioBands(freqData, a, b, c, d, e) {
    if (e !== undefined) {
        const subBassBinEnd = a, midBassBinEnd = b, midBinEnd = c, trebleBinEnd = d, out = e;
        let subBassSum = 0, midBassSum = 0, midSum = 0, trebleSum = 0;
        for (let i = 0; i < subBassBinEnd; i++) subBassSum += freqData[i];
        for (let i = subBassBinEnd; i < midBassBinEnd; i++) midBassSum += freqData[i];
        for (let i = midBassBinEnd; i < midBinEnd; i++) midSum += freqData[i];
        for (let i = midBinEnd; i < trebleBinEnd; i++) trebleSum += freqData[i];
        out.subBassRaw = subBassSum / binCount(0, subBassBinEnd) / 255;
        out.midBassRaw = midBassSum / binCount(subBassBinEnd, midBassBinEnd) / 255;
        out.midRaw     = midSum / binCount(midBassBinEnd, midBinEnd) / 255;
        out.trebleRaw  = trebleSum / binCount(midBinEnd, trebleBinEnd) / 255;
        // Kick drums carry most energy in the sub band; weight it slightly higher.
        out.bassRaw    = out.subBassRaw * 0.55 + out.midBassRaw * 0.45;
        return out;
    }

    const bassBinEnd = a, trebleBinStart = b, trebleBinEnd = c, out = d;
    let bassSum = 0;
    for (let i = 0; i < bassBinEnd; i++) bassSum += freqData[i];
    out.bassRaw = bassBinEnd > 0 ? bassSum / bassBinEnd / 255 : 0;
    let trebleSum = 0;
    const trebleCount = trebleBinEnd - trebleBinStart;
    for (let i = trebleBinStart; i < trebleBinEnd; i++) trebleSum += freqData[i];
    out.trebleRaw = trebleCount > 0 ? trebleSum / trebleCount / 255 : 0;
    out.subBassRaw = out.bassRaw;
    out.midBassRaw = out.bassRaw;
    out.midRaw = 0;
    return out;
}

/** Bass must exceed its running average by this ratio (plus an absolute floor). */
export const ONSET_RATIO = 1.4;
export const ONSET_FLOOR = 0.05;
/** Minimum time between two detected onsets, in milliseconds. */
export const ONSET_COOLDOWN_MS = 140;

/**
 * Adaptive onset detector. A slow running average of bass energy acts as a noise
 * floor, so a transient that jumps well above its own recent history reads as a hit
 * regardless of the track's absolute loudness. Writes into `out`.
 */
export function detectAudioOnset(bassRaw, prevBassAvg, prevPulse, prevCooldownUntil, nowMs, dt, out) {
    out.bassAvg = approach(prevBassAvg, bassRaw, 0.04, dt);
    if (bassRaw > out.bassAvg * ONSET_RATIO + ONSET_FLOOR && nowMs > prevCooldownUntil) {
        out.pulse = 1;
        out.cooldownUntil = nowMs + ONSET_COOLDOWN_MS;
    } else {
        out.pulse = approach(prevPulse, 0, 0.22, dt);
        out.cooldownUntil = prevCooldownUntil;
    }
    return out;
}
