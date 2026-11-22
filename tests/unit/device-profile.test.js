import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGPU, pickTier, computeQualityProfile, parseQualityOverride, pointSizeCompensation, COVERAGE_REFERENCE_PARTICLES, QUALITY_TIERS } from '../../src/core/device-profile.js';

describe('classifyGPU', () => {
    // Real renderer strings as reported by Chrome/ANGLE, Firefox, Safari and Mesa.
    const cases = [
        ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software'],
        ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software'],
        ['Mesa llvmpipe (LLVM 12.0.0, 256 bits)', 'software'],
        ['Microsoft Basic Render Driver', 'software'],
        ['SVGA3D; build: RELEASE; LLVM;', 'software'],
        ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
        ['NVIDIA GeForce GTX 1060/PCIe/SSE2', 'discrete'],
        ['AMD Radeon RX 6800 XT (radeonsi, navi21, LLVM 15.0.7, DRM 3.49, 6.2.0)', 'discrete'],
        ['AMD Radeon Pro 5500M OpenGL Engine', 'discrete'],
        ['Intel(R) Arc(TM) A770 Graphics', 'discrete'],
        ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
        ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'integrated'],
        ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
        ['AMD Radeon Vega 8 Graphics', 'integrated'],
        ['Adreno (TM) 740', 'integrated'],
        ['Mali-G78 MP14', 'integrated'],
        ['PowerVR Rogue GE8320', 'integrated'],
        ['Apple GPU', 'unknown'],
        ['Apple M2', 'unknown'],
        ['', 'unknown'],
        [undefined, 'unknown']
    ];
    for (const [name, expected] of cases) {
        test(`${JSON.stringify(name)} -> ${expected}`, () => assert.equal(classifyGPU(name), expected));
    }

    test('REGRESSION: a real GPU on the Mesa driver stack is not treated as software', () => {
        // The original regex listed "Mesa" as a software renderer, which put every
        // Linux desktop with an Intel or AMD GPU into the lowest quality tier.
        assert.notEqual(classifyGPU('Mesa Intel(R) UHD Graphics 620 (KBL GT2)'), 'software');
        assert.notEqual(classifyGPU('AMD Radeon RX 7900 XTX (radeonsi, navi31, LLVM 16.0.6, DRM 3.54, 6.5.0)'), 'software');
    });
});

describe('pickTier', () => {
    test('software rasterisers always get the minimal tier', () => {
        assert.equal(pickTier({ gpuClass: 'software', deviceMemory: 32, cores: 32 }), 'minimal');
    });

    test('Data Saver on mobile is minimal, on desktop low', () => {
        assert.equal(pickTier({ gpuClass: 'discrete', deviceMemory: 8, cores: 16, saveData: true, isMobile: true }), 'minimal');
        assert.equal(pickTier({ gpuClass: 'discrete', deviceMemory: 8, cores: 16, saveData: true }), 'low');
    });

    test('severely constrained hardware is minimal', () => {
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: 2, cores: 2 }), 'minimal');
    });

    test('integrated GPUs and small machines start low (adaptive quality can climb)', () => {
        assert.equal(pickTier({ gpuClass: 'integrated', deviceMemory: 8, cores: 8 }), 'low');
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: 4, cores: 8 }), 'low');
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: 8, cores: 4 }), 'low');
    });

    test('REGRESSION: a discrete-GPU Chrome desktop reaches the high tier', () => {
        // Chrome caps navigator.deviceMemory at 8, and the old `memory <= 8` test made
        // the 110K-particle tier unreachable on every Chromium browser.
        assert.equal(pickTier({ gpuClass: 'discrete', deviceMemory: 8, cores: 16 }), 'high');
    });

    test('REGRESSION: browsers that hide deviceMemory are not forced low', () => {
        // Firefox and Safari do not expose deviceMemory; it used to default to 4,
        // which classified every Firefox/Safari visitor as low-end.
        assert.equal(pickTier({ gpuClass: 'discrete', deviceMemory: undefined, cores: 12 }), 'high');
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: undefined, cores: 8 }), 'medium');
    });

    test('an unknown GPU on a many-core machine is high', () => {
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: undefined, cores: 12 }), 'high');
    });

    test('missing signals fall back to medium, never crash', () => {
        assert.equal(pickTier({ gpuClass: 'unknown' }), 'medium');
        assert.equal(pickTier({ gpuClass: 'unknown', deviceMemory: NaN, cores: 0 }), 'medium');
    });
});

describe('computeQualityProfile', () => {
    const desktop = { deviceMemory: 8, cores: 16 };

    test('desktop particle budgets per tier are pinned', () => {
        const budget = (tier) => computeQualityProfile({ ...desktop, override: tier }).particleCount;
        assert.deepEqual(QUALITY_TIERS.map(budget), [28000, 48000, 82000, 110000]);
    });

    test('mobile budgets top out at 52K', () => {
        const budget = (tier) => computeQualityProfile({ ...desktop, isMobile: true, override: tier }).particleCount;
        assert.deepEqual(QUALITY_TIERS.map(budget), [18000, 30000, 52000, 52000]);
    });

    test('a discrete NVIDIA desktop gets the full budget', () => {
        const p = computeQualityProfile({ ...desktop, rendererName: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)' });
        assert.equal(p.tier, 'high');
        assert.equal(p.particleCount, 110000);
        assert.equal(p.dprCap, 2.0);
        assert.equal(p.initialRenderScale, 1.0);
        assert.equal(p.forced, false);
    });

    test('SwiftShader (CI) gets the safety budget', () => {
        const p = computeQualityProfile({ ...desktop, rendererName: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' });
        assert.equal(p.tier, 'minimal');
        assert.equal(p.ultraLowTier, true);
        assert.equal(p.lowTier, true);
        assert.equal(p.targetFps, 50);
        assert.equal(p.baselineInferenceFps, 12);
        assert.equal(p.initialBloom, 0.28);
        assert.deepEqual(p.visionDelegates, ['CPU']);
    });

    test('gesture inference tries the GPU delegate first unless the renderer is software', () => {
        const delegates = (rendererName, override = null) => computeQualityProfile({ ...desktop, rendererName, override }).visionDelegates;
        assert.deepEqual(delegates('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)'), ['GPU', 'CPU']);
        assert.deepEqual(delegates('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'), ['GPU', 'CPU']);
        assert.deepEqual(delegates(''), ['GPU', 'CPU']);
        assert.deepEqual(delegates('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)'), ['CPU']);
        // A forced tier changes the render budget, not what the hardware can run.
        assert.deepEqual(delegates('llvmpipe (LLVM 15.0.7, 256 bits)', 'high'), ['CPU']);
    });

    test('an override pins the tier and is reported as forced', () => {
        const p = computeQualityProfile({ ...desktop, rendererName: 'llvmpipe', override: 'high' });
        assert.equal(p.detectedTier, 'minimal');
        assert.equal(p.tier, 'high');
        assert.equal(p.forced, true);
        assert.equal(p.particleCount, 110000);
    });

    test('an invalid override is ignored', () => {
        const p = computeQualityProfile({ ...desktop, rendererName: 'llvmpipe', override: 'bogus' });
        assert.equal(p.tier, 'minimal');
        assert.equal(p.forced, false);
    });

    test('Data Saver trims start-up cost unless a tier was forced', () => {
        const lite = computeQualityProfile({ ...desktop, saveData: true });
        assert.equal(lite.lite, true);
        assert.equal(lite.initialRenderScale, 0.75);
        assert.equal(lite.initialParticleFraction, 0.72);
        assert.equal(lite.baselineInferenceFps, 12);

        const forced = computeQualityProfile({ ...desktop, saveData: true, override: 'high' });
        assert.equal(forced.lite, false);
        assert.equal(forced.initialParticleFraction, 1);
    });

    test('inference baseline never exceeds the tier cap', () => {
        for (const isMobile of [false, true]) {
            for (const tier of QUALITY_TIERS) {
                const p = computeQualityProfile({ ...desktop, isMobile, override: tier });
                assert.ok(p.baselineInferenceFps <= p.inferenceFpsCap, `${tier}/${isMobile}`);
            }
        }
    });

    test('the profile is immutable', () => {
        const p = computeQualityProfile(desktop);
        assert.throws(() => { 'use strict'; p.particleCount = 1; });
    });
});

describe('parseQualityOverride', () => {
    test('accepts tier names, case-insensitively', () => {
        assert.equal(parseQualityOverride('?quality=high'), 'high');
        assert.equal(parseQualityOverride('?quality=LOW'), 'low');
        assert.equal(parseQualityOverride('?foo=1&quality=medium'), 'medium');
    });

    test('accepts friendly aliases', () => {
        assert.equal(parseQualityOverride('?quality=ultra'), 'high');
        assert.equal(parseQualityOverride('?quality=potato'), 'minimal');
    });

    test('rejects anything else', () => {
        for (const s of ['', '?quality=', '?quality=extreme', '?q=high', undefined, null]) {
            assert.equal(parseQualityOverride(s), null);
        }
    });
});

describe('pointSizeCompensation', () => {
    test('leaves counts at or below the reference as authored', () => {
        for (const n of [1, 8000, 18000, COVERAGE_REFERENCE_PARTICLES]) {
            assert.equal(pointSizeCompensation(n), 1);
        }
    });

    test('REGRESSION: holds count x point area constant above the reference', () => {
        // Without this, every tier above minimal saturated the inner disk to white.
        for (const tier of ['low', 'medium', 'high']) {
            const n = computeQualityProfile({ deviceMemory: 8, cores: 16, override: tier }).particleCount;
            const f = pointSizeCompensation(n);
            assert.ok(f < 1, tier);
            assert.ok(Math.abs(n * f * f - COVERAGE_REFERENCE_PARTICLES) < 1e-6, tier);
        }
    });

    test('shrinks monotonically as the count grows', () => {
        let prev = 1;
        for (const n of [30000, 48000, 82000, 110000, 400000]) {
            const f = pointSizeCompensation(n);
            assert.ok(f < prev, String(n));
            prev = f;
        }
    });

    test('treats invalid counts as the authored size', () => {
        for (const n of [NaN, undefined, null, 'many', Infinity, -Infinity]) {
            assert.equal(pointSizeCompensation(n), 1, String(n));
        }
    });
});
