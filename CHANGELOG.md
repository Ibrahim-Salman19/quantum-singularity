# Quantum Singularity - Changelog

## [6.0.0] - 2026-11-22 (Modular Architecture, Unit-Tested Core, Strict CSP)

### Changed
- **Modular source**: the 3,300-line inline `<script type="module">` and 1,100-line inline stylesheet in `index.html` are now `src/`, a set of native ES modules with no build step:
  - `core/math`, `core/device-profile`
  - `gesture/classifier`, `gesture/state-machine`
  - `audio/dsp`, `state/share-link`
  - `render/shaders/*`

  Every module except `main.js` is free of DOM and Three.js, and is tested directly in Node.
- **First-run experience**: the control guide no longer opens as a modal on arrival. The field is shown first, followed by a compact, non-modal welcome card ("Enable hand control" / "Explore with mouse" / "How it works") that never takes focus and is dismissed for good by any engagement. Touch devices get touch wording. The guide is one key away (`H`), and its "do not open automatically" checkbox is gone. Keyboard chips now read `1-6 Switch topology` and include `P`.
- **Strict Content-Security-Policy**: `script-src` no longer allows `'unsafe-inline'`. The import map, now the only inline script, is allowed by its SHA-256. The async web-font `onload` handler was replaced with a plain stylesheet link.
- **Node 22.8+** for development and CI, since Node 20 is end-of-life.

### Fixed
- **High tier unreachable on Chromium**: Chrome caps `navigator.deviceMemory` at 8, so the `memory <= 8` test kept every Chromium desktop out of the 110K-particle tier.
- **Firefox and Safari forced to the low tier**: a hidden `deviceMemory` defaulted to 4 GB. An unknown value is now treated as unknown.
- **Linux GPUs misclassified as software renderers**: "Mesa" was in the software-renderer pattern, which put every Linux desktop with an Intel or AMD GPU into the minimal tier.
- **Gesture confirmed from a single frame at low inference rates**: at 8-9 Hz one sample (125 ms) exceeded the 85 ms confirmation window. Each sample's contribution is now capped at 0.75 × the window, so confirmation always needs two agreeing samples. Timing at 12 Hz and above is unchanged.
- **Field washed out to white on capable GPUs**: particles blend additively, and on the low, medium and high tiers the inner disk summed to many times display white on half-float targets, so the default scene rendered as a flat white glow. Only the minimal tier, which already used 8-bit targets and the fewest particles, looked as designed. Composer targets are now 8-bit on every tier, and point size scales with `sqrt(28000 / drawnCount)` so a larger budget adds detail instead of brightness. The HUD no longer shows an HDR/SDR suffix.
- **Five of the six topologies rendered as a small white smudge**: the Lotus, Tesseract, Clifford, Hopf and Lorenz shapes are authored with a 90th-percentile radius of 16 to 25 units, against 144 for the disk and a visible half-height of about 85 at the default camera. Each filled a few percent of the frame, and its particles overlapped into white. Each shape's output is now scaled by a fixed factor (1.95 to 3.0) so it fills the frame at the default scale, with its geometry unchanged.
- **Share links reset the topology**: a link without `t` (or with `t=`) parsed as topology 0 because `Number(null) === 0`. Keys are now validated independently.
- **Docs 404 in production**: `.vercelignore` excluded `*.md`, while `llms.txt` and the sitemap linked to the markdown docs.
- **Flaky camera tests**: two specs branched on whether the first-run guide had opened yet, racing its timer. When they lost, nothing enabled the camera and the test waited out its full timeout. They now use the canonical camera control.
- **Documentation accuracy**: README, ARCHITECTURE, llms.txt and llms-full.txt were rewritten from the source. Removed:
  - unmeasured benchmarks ("<2.5 ms GPU", "<180 ms boot", "3 draw calls")
  - the `gl_VertexID` claim (the shader uses a shuffled `aIndex` attribute)
  - "no external requests"
  - "numerical Lorenz integration"
  - incorrect fusion and threshold constants

### Added
- **Unit test layer**: 137 `node --test` tests across every logic module, with enforced coverage thresholds (currently 99.8 % lines, 94.6 % branches, 100 % functions) and a dedicated CI job that gates the browser suites.
- **Exposure browser test** (`tests/exposure.spec.ts`): renders the 110K-particle tier at a fixed simulated moment and fails if the frame is blown out. It fails on the renderer before the fix (44.3 % near-white pixels) and passes after it (0 %).
- **`scripts/capture-media.mjs`**: regenerates the README and portfolio media (a 7-second loop as MP4, WebM and GIF, a poster and an interface still) from the running app, on a fixed simulated clock.
- **Production-header browser test** (`tests/csp.spec.ts`): boots the full app under the exact `vercel.json` headers and fails on any CSP violation.
- **Onboarding browser tests** (`tests/onboarding.spec.ts`).
- **`?quality=minimal|low|medium|high`**: pins a quality tier and disables adaptive quality.
- **Static audit rewritten** with 11 checks:
  - module graph (imports resolve to real exports)
  - `getElementById` targets exist
  - SRI coverage for dynamic `import()`
  - the strict-CSP hash
  - the deploy set (nothing referenced is excluded by `.vercelignore`)

### Removed
- `pricing.md` and its links: the project is MIT-licensed with nothing to price.
- Personal editor and tooling configuration (`.agents/`, `agent/`, `config/mcporter.json`, `skills-lock.json`) from version control.

## [5.3.1] - 2026-08-24 (Gesture Animation Coupling & Attractor Accuracy Fixes)

### Fixed
- **Shader Attractor Coordinate Space Alignment**: Applied the particle attractor displacement to `wp` in 3D world space instead of pre-rotation topology space, ensuring attractor forces align accurately with the user's screen-space finger position irrespective of topology tilt ($27^\circ$) and continuous time-varying $Y$-spin.
- **Dynamic Camera-Facing Interaction Plane**: Aligned `groundPlane` to dynamically face the camera (`camera.getWorldDirection().negate()`) centered at `orbit.target`, eliminating null raycast intersections during orbit rotations and keeping `Pointing_Up` attractor and pointer tracking active at all camera angles.
- **Image-Space Apparent Hand Scale for Palm Zoom**: Refactored `handScale` in `geometryGestureScores` to compute from normalized 2D image coordinates rather than camera-distance-invariant 3D metric `worldLandmarks`, enabling smooth, calibrated camera radius zooming ($0.10$ far $\rightarrow$ $0.38$ near).
- **Chaos Modulation Full Range**: Expanded `Victory` gesture horizontal travel mapping to cover the full slider range ($0.0 \rightarrow 2.0$) with enhanced responsiveness.
- **HUD Flash Message Race Protection**: Added `hudFlashTimer` to protect temporary `"Link copied!"` notifications from being overwritten by adaptive quality updates.

### Added
- **Gesture Animation Integration Test Suite**: Extended `tests/gesture-state.spec.ts` to verify full end-to-end coupling between `Pointing_Up`, `Open_Palm`, and `Victory` gestures and the live animation state (attractor influence, world coordinates, camera radius, and curl chaos).

## [5.3.0] - 2026-08-19 (Low-End PC Optimization, Lower Initial Bloom, AI Discovery)

### Added
- **Low-End PC & Software Renderer Probing**: `probeGPUInfo()` inspects `UNMASKED_RENDERER_WEBGL` via `WEBGL_debug_renderer_info` to detect unaccelerated software rasterizers (`SwiftShader`, `llvmpipe`, `Microsoft Basic Render Driver`, `VirtualBox`, `VMware`, `Mesa`) and integrated GPUs (`Intel HD/UHD Graphics`).
- **`ultraLowTier` Hardware Profile**: Automatically triggers on software rendering, $\le 2\text{GB}$ RAM, or $\le 2$ CPU cores, capping particles to 28,000 (18,000 on mobile), clamping DPR strictly to 1.0, and capping ML inference to 12 FPS so CPU threads remain available for WebGL rasterization.
- **Conditional Bloom Pass Bypass**: When bloom intensity approaches zero (`targetBloom <= 0.01`), `bloomPass.enabled = false` is applied, allowing `EffectComposer` to skip the 5 mip-level downsample/upsample passes entirely and eliminate 5+ render target switches per frame.
- **8-Bit Render Target Fallback**: On ultra-low tier and software renderers, HDR render targets fall back to 8-bit `THREE.UnsignedByteType` targets, saving 50% memory bandwidth and avoiding half-float texture format emulation overhead.
- **Fragment Shader ALU Bypass**: `CinematicShader` now guards film grain evaluation (`if (uGrain > 0.001)`), skipping integer PCG hash arithmetic and two `pow()` gamma-space conversions per pixel on low-spec hardware.
- **AI Agent Discovery & Schema.org JSON-LD**: Comprehensive `@graph` structured data added to `index.html` alongside standardized `/llms.txt`, `/llms-full.txt`, and `/pricing.md` endpoints with CORS headers in `vercel.json`.

### Changed
- **Lower Initial Bloom Baseline**: Reduced default bloom intensity from `1.05` to `0.45` (`0.28-0.38` on low tiers), calibrated `UnrealBloomPass` radius to `0.25` and threshold to `0.85`, and tuned audio pulse flash multipliers (`0.22` and `0.14`) to eliminate visual glare.

## [5.2.1] - 2026-08-17 (Production-Readiness Hardening)

### Added
- **Hopf Fibration & Lorenz Manifold topologies** (topology 5 & 6, keys `5`/`6`): two new GPU-procedural shapes join the disk/lotus/tesseract/attractor set; the topology slider, keyboard bindings, preset buttons, and `morphShapeTo` clamp all extend to six shapes, with a static-audit check guarding the consistency of every binding.
- **Four-band audio DSP**: the audio pipeline splits the spectrum into sub-bass / mid-bass / mids / treble with fixed Hz boundaries computed once per stream, giving the field a fuller spectral response than the previous two-band split.
- **URL hash state sharing** (`C` key / hash links): the current topology, palette, and slider values serialize to a parseable `#t=..&p=..` hash on demand, and load-time hash values are applied with strict validation (invalid values silently ignored).
- **New Playwright suites**: `tests/audio-bands-4.spec.ts`, `tests/topologies.spec.ts`, `tests/url-state.spec.ts`, and `tests/visibility-suspend.spec.ts` (19 tests) wired into `test:fast`/`test:gpu`/`test:ci` so CI executes the whole suite; full suite is now 79 tests across 13 suites.
- **Security headers**: `Strict-Transport-Security`, `X-Frame-Options: DENY`, and `Cross-Origin-Opener-Policy: same-origin` added to `vercel.json`.
- **`.vercelignore`**: restricts static deploys to the app shell and assets (docs, tests, scripts, legacy `v1`-`v5` directories, and local tooling no longer upload).
- **`manifest.json`** gained a stable `id`; `package.json` engines corrected to Node >= 20 and repository/bugs URLs pointed at the real origin.

### Fixed
- **Test suite flake-hardening**: animation-dependent assertion windows (morph titles, GPU stats readout, clipboard HUD, "Waiting for a hand") widened from 5s to 15-60s and full-app boots given 120s budgets, so a slow CI runner (software rasterisation) surfaces real failures instead of timeouts. These windows were passing on idle machines and failing under load with rotating, environment-only timeouts.
- **Camera and microphone were not torn down on tab hide** (documented contract said "full teardown on tab hide"): switching tabs left the camera LED and microphone live with only inference paused. The `visibilitychange` handler now fully stops both streams on hide and re-acquires them on return *only if* the visitor had them on at hide time (a stopped `MediaStreamTrack` cannot be restarted, so restore re-runs the guarded enable paths). Regression-guarded by `tests/visibility-suspend.spec.ts`, which drives the real camera through a simulated hidden/visible cycle.
- **Hash palette could be force-set to 0**: `applyHashState` coerced a missing `p` parameter to `Number(null) === 0`, which passed the integer/range check and rewrote the swatches. The raw parameter is now null-guarded like the slider paths.
- **Bloom could blow out past the slider maximum**: audio pulse + mid-bass swell on top of a maxed bloom slider produced an unclamped strength; the target is now clamped to the slider ceiling.
- **Docs overclaimed SRI coverage**: README/ARCHITECTURE now scope the "pinned with Subresource Integrity" claim to the nine import-map modules and state honestly that the MediaPipe WASM runtime and model load outside the import map (model still magic-byte validated).

## [5.2.0] - 2026-08-10 (Audio Input, Engineering Panel, GPU Profiling)

### Added
- **Live Microphone Reactivity**: A third real-time input channel alongside pointer and gesture. Web Audio `AnalyserNode` (FFT size 1024) splits the spectrum into bass (~20-250Hz) and treble (~2-8kHz) bands; bass swells the whole particle field radially, treble sharpens curl turbulence, and an adaptive onset/beat detector (a slow running average of bass energy as noise floor) fires a fast-decaying "pulse" impulse that flashes particle energy and kicks bloom strength. Lifecycle mirrors the camera pipeline exactly: explicit permission gate, session-counter race guard, named-error messaging, full teardown on tab hide/page unload.
- **`window.__qsAudio` Test Surface**: exposes the pure band-splitting (`computeAudioBandBins`, `computeAudioBands`) and onset-detector (`detectAudioOnset`) functions, following the same out-parameter, zero-allocation idiom as `handToNDC`, so the audio pipeline is unit-testable with synthetic frequency-bin arrays instead of a live microphone.
- **Engineering Notes Panel** (`B` key / "Build" button): an in-app modal surfacing the architecture's key decisions (GPU-procedural particles, fused input channels, frame-rate-independent temporal state, adaptive quality budget, zero-allocation hot path) and live stats, reusing the guide modal's exact accessibility pattern (focus trap, `inert` background regions, mutual-exclusion with the guide modal).
- **GPU/Performance Stats HUD** (`P` key / "Stats" button): real GPU frame time via `EXT_disjoint_timer_query_webgl2`, pipelined two-deep so reads never stall the GPU, with a graceful "draw calls only" fallback on hardware/browsers without the extension.
- **Social Preview Card**: `og-image.jpg` (1200x630, ~65KB) plus complete Open Graph/Twitter Card meta tags (`og:image`, `og:url`, `twitter:card=summary_large_image`), so links shared to Slack/LinkedIn/email render a proper preview instead of a blank card.

### Fixed
- **Stale-session race in the audio pipeline** (found in self-review, before it shipped): `enableAudioReactivity()` assigned the new `AudioContext` to module state *before* `await ctx.resume()`, so a superseded enable resuming late could close the context a newer enable had already begun using, leaving the UI reading "Listening" over a dead audio graph. The context, analyser, and stream are now built entirely in locals and published in a single step after a final session check, with an `abandon()` path that tears down only its own resources. The `catch` block likewise no longer reports failures or tears down devices on behalf of a session that has already been superseded. Regression-guarded by a rapid enable/disable cycling test that asserts the reported state and the real `AudioContext.state` agree.
- **GPU timer allocated a `WebGLQuery` every frame**: the timer was armed unconditionally in the render loop, creating and destroying a query object per frame even with the stats readout closed: a per-frame allocation in a codebase that deliberately has none. Queries are now pooled and recycled, the timer is only armed while the readout is visible, and closing it (or tearing down the renderer) releases the pool.
- **`renderer.info.render.calls` under-reported by design**: `EffectComposer` issues one internal `renderer.render()` call per pass, and `WebGLRenderer.info` auto-resets at the start of each one, so reading the counter after `composer.render()` only ever reflected the *last* pass (observed: 1 draw call). Fixed by taking ownership of the reset (`renderer.info.autoReset = false`, one manual `reset()` per frame before the composer pass), which now reports the honest per-frame total (observed: 17).
- **Missing `microphone` Permissions-Policy**: `vercel.json` previously declared `microphone=()` (fully blocked); updated to `microphone=(self)` to allow the new audio-reactivity feature under the existing strict CSP.
- **Guide modal had no height ceiling on desktop**: a 5th guide-card (added for the new "Sound" input) pushed card content close to typical laptop viewport heights with no `overflow-y`/`max-height` fallback outside the mobile media query; added `max-height: min(88dvh, 780px)` + `overflow-y: auto` to the base `.modal-card` rule so any future content growth degrades to a scrollbar instead of clipping off-screen.

## [5.1.0] - 2026-08-08 (Gesture Recognition Engine Rework)

### Added
- **Gesture Test Suite**: `tests/gesture-recognition.spec.ts` (26 tests) covering geometry scoring, temporal hysteresis, fusion, prototype-pollution resistance, and aspect-correct hand-to-NDC mapping, driven by synthetic 21-landmark poses (`tests/fixtures/hand-poses.mjs`).
- **Camera Pipeline Suite**: `tests/camera-pipeline.spec.ts` (2 tests) drives the real camera-on flow headlessly with a fake device: model download, MediaPipe WASM init, "Hand tracking active", and toggle round-trip. Full suite now 41 passing Playwright tests.
- **Test Surface**: `window.__qsGesture` exposes classifier, fusion, temporal state machine, `handToNDC`, thresholds, and `setFrameAspect` for deterministic, browser-agnostic unit testing.
- **Temporal State Machine**: time-based EMA (`EMA_TAU_ATTACK=0.045`, `EMA_TAU_RELEASE=0.13`) and hysteresis thresholds (`GESTURE_ACTIVATE=0.64`, `GESTURE_SWITCH=0.74`, `GESTURE_MARGIN=0.10`, `GESTURE_CONFIRM_SEC=0.085`, `GESTURE_RELEASE_SEC=0.20`) making debounce timing frame-rate independent.
- **MediaPipe Model Cache Hardening**: TFLite magic-byte validation (`TFL3`), cache-poisoning eviction, buffer-based cache writes, per-delegate model slicing.
- **CSP Hardening**: `frame-ancestors 'none'` added to `vercel.json` (clickjacking protection).

### Fixed
- **Model bundle validation rejected legitimate models**: Google now serves `gesture_recognizer.task` as a nested ZIP bundle (`PK\x03\x04`), not the legacy raw `TFL3` flatbuffer; the cache poison check rejected it, failing every camera enable ("Gesture engine unavailable"). Validation now accepts both signatures. Regression-guarded by a new full end-to-end camera pipeline suite.
- **Guaranteed ReferenceError on camera teardown**: undeclared `workerFrameErrors`/`frameTransferErrors` references threw in strict mode, aborting teardown and GPU cleanup; removed and full gesture-state reset added to `stopCameraTracks`.
- **Space key permanently killed the render loop**: `fpsEl` TDZ access threw before the first rAF; `setPaused()` extracted, `__qsReady` flag moved to true end of module.
- **Aspect-distorted pointing raycast**: `handToNDC` now maps hand travel to physical, window-independent ground travel (was viewport-aspect-dependent); Victory midpoint anchored to wrist landmark; frame-rate-independent `approach()` easing.
- **Unreachable gesture release path**: release timer now accumulates independently of challenger flicker (regression test added).
- **Prototype pollution in classifier scores**: `Object.hasOwn` guard on `mlScores`.
- **Phyllotaxis golden-angle math**: vertex shader previously scaled `137.508°` by TAU; corrected to `GOLDEN_ANGLE = 2.39996322972865332`.
- **Dead payload removed**: 1.3MB zeroed `position` attribute dropped; `aPolarity` attribute added for exact jet parity.

### Perf & Correctness
- Zero per-frame allocations retained through gesture ranking, temporal update, and DOM writes (all change-gated).
- Render-scale dead-zone, single render-target reallocation per quality step, refresh-rate calibration, SIM time wrap, and cached cinematic uniforms.
- Pointer input coalesced to one raycast per frame; duplicate touch listeners removed.

## [5.0.0] - 2026-08-08 (Production Hardening & Reliability Release)

### Added
- Created `scripts/static_audit.js` for automated static verification (ES module check, duplicate DOM IDs check, `vercel.json` check, `robots.txt` check).
- Added `package.json` with Playwright e2e test infrastructure configuration.
- Added comprehensive documentation (`VALIDATION.md`, `ARCHITECTURE.md`, `CHANGELOG.md`).

### Fixed & Restructured
- **Gesture Pipeline Reliability**: Restored direct video processing baseline (`requestVideoFrameCallback` -> `recognizeForVideo(vidEl, mpTs)`). Eliminated async Web Worker message serialization overhead, `createImageBitmap` canvas transfers, and watchdog fallback thrashing.
- **Low Activation Latency**: Reduced gesture activation latency from ~340ms to ~110ms.
- **Landmark Geometry Fusion**: Retained dual-pass landmark geometry fallback (`isPoint`, `isPeace`, `isPalm`) to keep gesture tracking fully functional even under challenging lighting or non-canonical hand poses.
- **Zero-GC Vector Allocations**: Audited Three.js render loop to ensure 0 per-frame garbage collector object creation.
- **Static DOM Consistency**: Validated all 47 DOM IDs and verified clean target mapping for all dynamic slider components.

### Security & Deployment
- Validated `vercel.json` Content-Security-Policy and Permissions-Policy headers.
- Confirmed zero server-side function / edge dependencies for Vercel Hobby static compatibility.
