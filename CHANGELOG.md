# Quantum Singularity - Changelog

## [5.2.0] - 2026-08-10 (Audio Input, Engineering Panel, GPU Profiling)

### Added
- **Live Microphone Reactivity**: A third real-time input channel alongside pointer and gesture. Web Audio `AnalyserNode` (FFT size 1024) splits the spectrum into bass (~20-250Hz) and treble (~2-8kHz) bands; bass swells the whole particle field radially, treble sharpens curl turbulence, and an adaptive onset/beat detector (a slow running average of bass energy as noise floor) fires a fast-decaying "pulse" impulse that flashes particle energy and kicks bloom strength. Lifecycle mirrors the camera pipeline exactly: explicit permission gate, session-counter race guard, named-error messaging, full teardown on tab hide/page unload.
- **`window.__qsAudio` Test Surface**: exposes the pure band-splitting (`computeAudioBandBins`, `computeAudioBands`) and onset-detector (`detectAudioOnset`) functions, following the same out-parameter, zero-allocation idiom as `handToNDC`, so the audio pipeline is unit-testable with synthetic frequency-bin arrays instead of a live microphone.
- **Engineering Notes Panel** (`B` key / "Build" button): an in-app modal surfacing the architecture's key decisions (GPU-procedural particles, fused input channels, frame-rate-independent temporal state, adaptive quality budget, zero-allocation hot path) and live stats, reusing the guide modal's exact accessibility pattern (focus trap, `inert` background regions, mutual-exclusion with the guide modal).
- **GPU/Performance Stats HUD** (`P` key / "Stats" button): real GPU frame time via `EXT_disjoint_timer_query_webgl2`, pipelined two-deep so reads never stall the GPU, with a graceful "draw calls only" fallback on hardware/browsers without the extension.
- **Social Preview Card**: `og-image.jpg` (1200x630, ~65KB) plus complete Open Graph/Twitter Card meta tags (`og:image`, `og:url`, `twitter:card=summary_large_image`), so links shared to Slack/LinkedIn/email render a proper preview instead of a blank card.

### Fixed
- **Stale-session race in the audio pipeline** (found in self-review, before it shipped): `enableAudioReactivity()` assigned the new `AudioContext` to module state *before* `await ctx.resume()`, so a superseded enable resuming late could close the context a newer enable had already begun using — leaving the UI reading "Listening" over a dead audio graph. The context, analyser, and stream are now built entirely in locals and published in a single step after a final session check, with an `abandon()` path that tears down only its own resources. The `catch` block likewise no longer reports failures or tears down devices on behalf of a session that has already been superseded. Regression-guarded by a rapid enable/disable cycling test that asserts the reported state and the real `AudioContext.state` agree.
- **GPU timer allocated a `WebGLQuery` every frame**: the timer was armed unconditionally in the render loop, creating and destroying a query object per frame even with the stats readout closed — a per-frame allocation in a codebase that deliberately has none. Queries are now pooled and recycled, the timer is only armed while the readout is visible, and closing it (or tearing down the renderer) releases the pool.
- **`renderer.info.render.calls` under-reported by design**: `EffectComposer` issues one internal `renderer.render()` call per pass, and `WebGLRenderer.info` auto-resets at the start of each one — so reading the counter after `composer.render()` only ever reflected the *last* pass (observed: 1 draw call). Fixed by taking ownership of the reset (`renderer.info.autoReset = false`, one manual `reset()` per frame before the composer pass), which now reports the honest per-frame total (observed: 17).
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
