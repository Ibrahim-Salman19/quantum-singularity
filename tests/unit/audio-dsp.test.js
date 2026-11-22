import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeAudioBandBins, computeAudioBands, detectAudioOnset,
    ONSET_COOLDOWN_MS
} from '../../src/audio/dsp.js';

const out = () => ({ bassRaw: 0, subBassRaw: 0, midBassRaw: 0, midRaw: 0, trebleRaw: 0 });

describe('computeAudioBandBins', () => {
    for (const [rate, fft] of [[44100, 1024], [48000, 1024], [48000, 2048], [96000, 512], [8000, 256]]) {
        test(`${rate} Hz / FFT ${fft}: four strictly ordered, in-range boundaries`, () => {
            const bins = fft / 2;
            const b = computeAudioBandBins(rate, fft, bins);
            assert.ok(b.subBassBinEnd >= 1);
            assert.ok(b.subBassBinEnd < b.midBassBinEnd);
            assert.ok(b.midBassBinEnd < b.midBinEnd);
            assert.ok(b.midBinEnd < b.trebleBinEnd || b.trebleBinEnd === bins);
            assert.ok(b.trebleBinEnd <= bins);
        });
    }

    test('48 kHz / 1024 lands boundaries on the expected frequencies', () => {
        const b = computeAudioBandBins(48000, 1024, 512); // 46.875 Hz per bin
        assert.equal(b.subBassBinEnd, 2);   // ~80 Hz
        assert.equal(b.midBassBinEnd, 5);   // ~250 Hz
        assert.equal(b.midBinEnd, 43);      // ~2 kHz
        assert.equal(b.trebleBinEnd, 171);  // ~8 kHz
    });

    test('keeps the two-band aliases', () => {
        const b = computeAudioBandBins(44100, 1024, 512);
        assert.equal(b.bassBinEnd, b.midBassBinEnd);
        assert.equal(b.trebleBinStart, b.midBinEnd);
    });
});

describe('computeAudioBands', () => {
    test('silence is zero in every band', () => {
        const r = computeAudioBands(new Uint8Array(512), 2, 5, 43, 171, out());
        for (const v of Object.values(r)) assert.equal(v, 0);
    });

    test('full scale is one in every band', () => {
        const r = computeAudioBands(new Uint8Array(512).fill(255), 2, 5, 43, 171, out());
        for (const v of Object.values(r)) assert.ok(Math.abs(v - 1) < 1e-12);
    });

    test('energy lands only in the band it belongs to', () => {
        const data = new Uint8Array(512);
        for (let i = 43; i < 171; i++) data[i] = 255; // treble only
        const r = computeAudioBands(data, 2, 5, 43, 171, out());
        assert.equal(r.subBassRaw, 0);
        assert.equal(r.midBassRaw, 0);
        assert.equal(r.midRaw, 0);
        assert.equal(r.trebleRaw, 1);
    });

    test('bass is a 55/45 blend of sub-bass and mid-bass', () => {
        const data = new Uint8Array(512);
        data[0] = data[1] = 255; // sub-bass full, mid-bass empty
        const r = computeAudioBands(data, 2, 5, 43, 171, out());
        assert.ok(Math.abs(r.bassRaw - 0.55) < 1e-12);
    });

    test('writes into and returns the caller-owned object (no allocation)', () => {
        const target = out();
        assert.equal(computeAudioBands(new Uint8Array(64), 2, 5, 20, 40, target), target);
    });

    test('legacy two-band signature still works', () => {
        const data = new Uint8Array(64).fill(128);
        const r = computeAudioBands(data, 4, 20, 40, out());
        assert.ok(Math.abs(r.bassRaw - 128 / 255) < 1e-12);
        assert.ok(Math.abs(r.trebleRaw - 128 / 255) < 1e-12);
        assert.equal(r.midRaw, 0);
    });

    test('degenerate (empty) ranges do not divide by zero', () => {
        const r = computeAudioBands(new Uint8Array(8).fill(255), 0, 0, 0, 0, out());
        for (const v of Object.values(r)) assert.ok(Number.isFinite(v));
    });
});

describe('detectAudioOnset', () => {
    const o = () => ({ bassAvg: 0, pulse: 0, cooldownUntil: 0 });
    const dt = 1 / 60;

    test('a transient well above the running average fires a pulse', () => {
        const r = detectAudioOnset(0.9, 0.2, 0, 0, 1000, dt, o());
        assert.equal(r.pulse, 1);
        assert.equal(r.cooldownUntil, 1000 + ONSET_COOLDOWN_MS);
    });

    test('steady loud music does not fire (the threshold adapts)', () => {
        const r = detectAudioOnset(0.8, 0.8, 0, 0, 1000, dt, o());
        assert.ok(r.pulse < 1);
    });

    test('respects the cooldown window', () => {
        const first = detectAudioOnset(0.9, 0.2, 0, 0, 1000, dt, o());
        const second = detectAudioOnset(0.9, 0.2, first.pulse, first.cooldownUntil, 1050, dt, o());
        assert.ok(second.pulse < 1);
        const third = detectAudioOnset(0.9, 0.2, second.pulse, second.cooldownUntil, 1000 + ONSET_COOLDOWN_MS + 1, dt, o());
        assert.equal(third.pulse, 1);
    });

    test('a pulse decays toward zero between hits', () => {
        let state = detectAudioOnset(0.9, 0.2, 0, 0, 1000, dt, o());
        for (let i = 1; i <= 60; i++) {
            state = detectAudioOnset(0, state.bassAvg, state.pulse, state.cooldownUntil, 1000 + i * 16, dt, o());
        }
        assert.ok(state.pulse < 0.01);
    });

    test('the running average tracks the input slowly', () => {
        const r = detectAudioOnset(1, 0, 0, 0, 0, dt, o());
        assert.ok(r.bassAvg > 0 && r.bassAvg < 0.1);
    });
});
