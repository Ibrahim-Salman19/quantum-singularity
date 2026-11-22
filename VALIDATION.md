# Quantum Singularity: Validation Report

**Version** 6.0.0 · **Date** 2026-11-22

**Environment**
- Node 22
- Playwright headless Chromium
- SwiftShader software rendering (no GPU passthrough)

Every number in this report was produced by the commands shown. Performance figures that cannot be measured without real GPU hardware are not claimed; see [§7](#7-what-automation-cannot-cover).

| Layer | Command | Result |
| :--- | :--- | :--- |
| Static audit | `npm run test:static` | 11 / 11 checks pass |
| Unit | `npm run test:unit` | 137 / 137 pass; 99.77 % lines, 94.58 % branches, 100 % functions |
| Browser | `npm run test:e2e` | 91 / 91 pass |

CI (`.github/workflows/ci.yml`) runs the audit and the unit layer in parallel. Both gate two browser jobs: `test:fast` (logic, DOM, onboarding) and `test:gpu` (WebGL, camera, audio, CSP, exposure). Together the jobs cover all 16 spec files.

---

## 1. Static audit

`scripts/static_audit.js` has no dependencies and runs in under a second. Each check exists because the bug it catches either happened or would fail silently in production.

| Check | What it catches |
| :--- | :--- |
| Module entry points | an inline module script reappearing, or a missing `src/main.js` / `src/styles.css` |
| JavaScript syntax | `node --check` on every source, script and unit-test file |
| Module graph | a relative import that does not resolve, or a named import the target does not export (in the browser, a SyntaxError that blanks the page) |
| Unique DOM IDs | duplicate `id` attributes |
| `getElementById` targets | code looking up an element that `index.html` does not contain |
| Import map SRI coverage | an import-map module, or a dynamic `import()` of a CDN URL, without a `sha384` hash; version drift between Three.js addons or MediaPipe mirrors |
| Topology consistency | the slider range, keys `1`-`6`, `SHAPE_INFO`, the shader clamp and share-link validation disagreeing about how many topologies exist |
| Deploy set | a file the site or `llms.txt` links to that is missing or excluded by `.vercelignore` |
| `vercel.json` headers | CSP, HSTS, `nosniff` or Permissions-Policy missing |
| Strict CSP | `'unsafe-inline'` / `'unsafe-eval'` in `script-src`; an inline script whose SHA-256 is not in the policy; inline `on*=` handlers; `javascript:` URLs |
| Crawler and PWA files | `robots.txt`, the sitemap, the manifest or its icons missing |

---

## 2. Unit tests

`node --test` with the built-in coverage reporter, run directly on the `src/` modules. No bundler, transpiler or browser is involved. CI fails if coverage drops below 95 % lines, 85 % branches or 95 % functions.

| Module | Lines | Branches | Functions |
| :--- | ---: | ---: | ---: |
| `audio/dsp.js` | 100.00 | 90.00 | 100.00 |
| `core/device-profile.js` | 100.00 | 98.82 | 100.00 |
| `core/math.js` | 100.00 | 96.30 | 100.00 |
| `gesture/classifier.js` | 99.26 | 88.61 | 100.00 |
| `gesture/state-machine.js` | 100.00 | 95.00 | 100.00 |
| `state/share-link.js` | 100.00 | 100.00 | 100.00 |
| **All logic modules** | **99.77** | **94.58** | **100.00** |

Unit coverage measures the DOM-free modules. `src/main.js` (renderer, UI and device lifecycles) and the GLSL are exercised by the browser layer instead.

---

## 3. Browser tests

91 Playwright tests across 16 files, on headless Chromium. The camera tests use Chromium's fake video device, and the WebGL tests use SwiftShader.

| File | Tests | Covers |
| :--- | ---: | :--- |
| `gesture-recognition.spec.ts` | 26 | geometry classifier per pose, scale invariance, palm-normal quality, malformed input, temporal activation / spike / release / switch, frame-rate independence, fusion boosts and `None` veto, NDC mapping isotropy and mirroring |
| `audio-reactivity.spec.ts` | 9 | idle UI, band-bin mapping, onset firing and cooldown, enable/disable round trip, stale-session race |
| `engineering-panel.spec.ts` | 9 | focus trap, `inert` background, mutual exclusion with the guide, live stats, GPU / draw-call readout, multi-pass draw-call counting |
| `gesture-state.spec.ts` | 6 | status badges and camera-toggle state |
| `onboarding.spec.ts` | 6 | welcome card appears without taking focus; each choice dismisses it for good; returning visitors are not greeted |
| `topologies.spec.ts` | 6 | six topologies, morph tweens, UI sync, keys `1`-`6` |
| `url-state.spec.ts` | 6 | share-link round trip, clamping, `C` to copy, malformed hashes |
| `audio-bands-4.spec.ts` | 5 | four-band split, clamping, zero-allocation output |
| `dom.spec.ts` | 5 | header, HUD, presets, palettes, guide |
| `accessibility.spec.ts` | 3 | keyboard shortcuts, ARIA state, guide overlay |
| `webgl.spec.ts` | 3 | WebGL 2 context, FPS HUD, focus mode |
| `camera-pipeline.spec.ts` | 2 | full camera enable: model download and validation, WASM init, "Hand tracking active", toggle round trip |
| `visibility-suspend.spec.ts` | 2 | render-loop suspension and camera/microphone teardown on tab hide |
| `shader-compile.spec.ts` | 1 | every shader compiles and links under WebGL 2 |
| `csp.spec.ts` | 1 | the app boots under the exact production headers with zero `securitypolicyviolation` events |
| `exposure.spec.ts` | 1 | the 110K-particle tier, rendered at a fixed simulated moment, has under 15 % near-white pixels and over 30 % dark ones |

**Refactor parity.** The full suite was run on the original single-file app (`ae65666`) and on this branch on the same machine:
- Original: 83 / 83 passed, 24.8 min.
- This branch: 89 / 89 passed, 23.7 min. `csp.spec.ts` was added while that run was in progress and passed on its own. After the final font-loading change, the CSP, onboarding, accessibility and DOM specs were run again; all 15 passed.

The seven new tests are the onboarding and CSP specs.

**Negative control.** To check that `csp.spec.ts` can fail, one character of the import-map hash in `vercel.json` was corrupted. The test then failed with a `script-src` violation, as it should.

`exposure.spec.ts` was run twice against the code before the fix (commit `2949b36`) and twice after it, on the same machine with the clock paused at the same simulated moment. Both runs of each build agreed to within 0.2 percentage points:

| Build | Near-white pixels | Dark pixels | Mean luminance | Result |
| :--- | ---: | ---: | ---: | :--- |
| Before (half-float targets, fixed point size) | 44.3 % | 2.4 % | 0.80 | fails |
| After (8-bit targets, coverage-scaled points) | 0.0 % | 49.9 % | 0.29 | passes |

---

## 4. Bugs the tests found

Each is pinned by a test marked `REGRESSION` (unit) or by the browser test named here.

| Bug | Impact | Root cause |
| :--- | :--- | :--- |
| High tier unreachable on Chromium | no Chrome or Edge user ever got the 110K-particle tier | `navigator.deviceMemory` is capped at 8, and the check was `memory <= 8 → not high` |
| Firefox / Safari forced low | every Firefox and Safari visitor got the low tier | `deviceMemory` is hidden there; the fallback was 4 GB |
| Linux GPUs treated as software | Intel/AMD desktops on Linux got the minimal tier | "Mesa", the standard Linux driver stack, was in the software-renderer pattern |
| Single-frame gesture confirm | at 8-9 Hz inference one misread frame triggered a gesture | one 125 ms sample exceeded the 85 ms confirmation window; contributions are now capped at 0.75 × the window |
| Share link resets topology | links without `t` always opened the first shape | `Number(null) === 0` passed the range check |
| Docs 404 in production | every markdown link in `llms.txt` and the sitemap returned 404 | `.vercelignore` excluded `*.md` (caught by the deploy-set audit) |
| Higher tiers washed out to white | every visitor above the minimal tier saw a flat white disk instead of the accretion structure | additive particles summed far past display white on half-float targets, and coverage grew with the particle count; pinned by `exposure.spec.ts` and a `REGRESSION` unit test |
| Flaky camera tests | two specs occasionally waited out their full timeout | they raced the first-run guide's timer (fixed in `camera-pipeline` and `visibility-suspend`) |

Earlier releases' suites caught three more, still covered:
- a guaranteed `ReferenceError` on camera teardown
- an unreachable gesture-release path
- a flickering challenger blocking release

They also caught a draw-call counter reporting only the final composer pass (next section).

---

## 5. Profiling correctness

`EffectComposer` calls `renderer.render()` once per pass, and `WebGLRenderer.info` resets at the start of each call. So after `composer.render()`, `info.render.calls` reflected only the final pass and reported **1** draw call per frame. `autoReset` is now disabled, with one manual reset per frame, so the HUD reports the true per-frame total across all passes. `engineering-panel.spec.ts` asserts it.

GPU time uses `EXT_disjoint_timer_query_webgl2` with a pipelined query pool: a query issued on frame *N* is read on *N+1* or *N+2*, never awaited synchronously, because a blocking read would stall the GPU it is measuring. Disjoint results are discarded. Without the extension, as under SwiftShader in CI, the HUD falls back to draw calls only, and the suite verifies that path.

---

## 6. Lighthouse

Measured on v5.2 (2026-08-10) with the Lighthouse CLI (desktop preset) on `google-chrome-stable`:

| Category | Score |
| :--- | :--- |
| Accessibility | 100 |
| Best Practices | 100 |
| SEO | 100 |
| Performance | 39-44 (SwiftShader-bound, not representative) |

The Performance score is not meaningful here. With no GPU, SwiftShader compiles shaders and rasterises 100K particles on the CPU. That produced 14-15 s of Total Blocking Time, and back-to-back runs swung by 5 points with no code change. It needs re-measuring on real hardware.

Findings handled:
- **Render-blocking web fonts (fixed).** The Google Fonts stylesheet loads with `media="print"` and is switched to `all` when it arrives, so it never blocks first paint. The switch is in `src/fonts.js` rather than an inline `onload`, because the strict CSP forbids inline handlers.
- **Minify / unused JavaScript (declined).** The source is served as readable native modules with no build step, so a reviewer can read exactly what runs. The unused-JS figure comes from loading complete Three.js and MediaPipe builds from a CDN.
- **`color-contrast` on `#modal-launch` (false positive, verified).** Lighthouse reported 1.02:1. `getComputedStyle` showed the button's real colours are `rgb(11, 21, 18)` on `rgb(143, 203, 184)`, which is 10.09:1, above AAA. The audit had sampled the page background (`--bg`) instead of the button's own fill.

---

## 7. What automation cannot cover

The suites use fake media devices and a software rasteriser. Checking on a real device needs about 90 seconds on the deployed HTTPS site.

**Camera**
1. Click **Enable camera**. The permission prompt appears before any model download starts.
2. Raise only the index finger. The attractor follows the fingertip smoothly in all four quadrants.
3. Open your palm and move it toward and away from the camera. The zoom eases without jumps.
4. Make a V-sign and move it left and right. The Chaos slider follows.
5. Click **Disable camera**. The hardware camera light turns off and the status reads "Camera off".

**Microphone**

6. Click **Enable microphone**. The status reads "Listening".
7. Play music with strong bass. The field swells on the beat.
8. Make a high-frequency sound (hi-hat, "sss"). The curl turbulence sharpens.
9. Click **Disable microphone**. The mic indicator clears, and reactivity decays smoothly to rest instead of snapping.

**Profiling**

10. Press `P`. On hardware with `EXT_disjoint_timer_query_webgl2`, a real GPU time in milliseconds appears, and it responds to the Bloom and Particle Scale sliders.

---

## 8. Reproducing

```bash
npm ci && npx playwright install chromium
npm run test:static   # under 1 s
npm run test:unit     # about 1 s
npm run test:e2e      # about 25 min under SwiftShader on one worker
```
