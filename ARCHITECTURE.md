# Quantum Singularity - Technical Architecture

## 1. System Overview

**Quantum Singularity** is a static single-page WebGL 2 computational art application featuring interactive particle fields, adaptive GPU quality scaling, on-device hand gesture control via MediaPipe Tasks Vision, and live microphone reactivity via the Web Audio API. All three input channels (pointer, gesture, sound) converge on the same shader uniforms, so the render loop and diagram below apply identically regardless of which are active; the audio pipeline specifically is detailed in section 4.

```
┌────────────────────────────────────────────────────────────────────────┐
│                              BROWSER DOM                               │
│                                                                        │
│   ┌─────────────────────┐               ┌──────────────────────────┐   │
│   │   HTMLVideoElement  │               │   WebGL 2 Canvas         │   │
│   │   (Webcam Stream)   │               │   (Three.js Renderer)    │   │
│   └──────────┬──────────┘               └────────────▲─────────────┘   │
│              │                                       │                 │
│              │ requestVideoFrameCallback()           │                 │
│              ▼                                       │ Render Loop     │
│   ┌─────────────────────┐               ┌────────────┴─────────────┐   │
│   │ MediaPipe Vision    │               │ Custom GLSL Shaders      │   │
│   │ (Gesture Recognizer)│               │ (GPU Particles & Bloom)  │   │
│   └──────────┬──────────┘               └────────────▲─────────────┘   │
│              │                                       │                 │
│              │ Hand Landmarks & Gesture Category     │ Update Uniforms │
│              ▼                                       │                 │
│   ┌──────────────────────────────────────────────────┴─────────────┐   │
│   │ Gesture Fusion & Dynamics Engine (OEF & Raycasting)            │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. WebGL 2 & Particle Shader Architecture

- **Rendering Engine**: Three.js `0.185.1` WebGLRenderer with WebGL 2 context.
- **Hardware-Aware Tiering & Software Renderer Probing**:
  - `probeGPUInfo()` inspects `UNMASKED_RENDERER_WEBGL` via `WEBGL_debug_renderer_info` to detect unaccelerated software renderers (`SwiftShader`, `llvmpipe`, `Microsoft Basic Render Driver`) and low-spec integrated GPUs.
  - Automatically activates `ultraLowTier` under software rendering, $\le 2\text{GB}$ RAM, or $\le 2$ CPU cores.
- **Particle Count Allocation**:
  - High-Tier Desktop: Up to 110,000 active particles (`110K PTS`).
  - Mid-Tier / Standard: 82,000 particles (`82K PTS`).
  - Low-Tier / Mobile: 30,000 to 52,000 particles.
  - Ultra-Low Tier / Software Renderers: 18,000 to 28,000 particles to guarantee stable 60 FPS on CPU rasterization.
- **GPU procedural positions**: Particle positions are computed dynamically inside vertex shaders using 6 continuous mathematical topologies:
  1. `Singularity Accretion`: Keplerian rotational dynamics with relativistic bipolar relativistic jets.
  2. `Phyllotaxis Lotus`: Golden angle spiral lattice ($\theta = 137.507764^\circ$) with radial wave oscillations.
  3. `4D Tesseract`: 4D hypercube projected to 3D with dual-plane SO(4) rotation ($XW / YZ$).
  4. `Clifford Strange Attractor`: Bounded non-periodic chaotic attractor with curl perturbations.
  5. `Hopf Fibration`: Hypersphere mapping $S^3 \to S^2$ via nested toroidal Villarceau circles.
  6. `Lorenz Chaotic Manifold`: Real-time numerical integration of the 3D Lorenz attractor differential equations ($\sigma=10, \rho=28, \beta=8/3$).
- **HDR Post-Processing & Fillrate Optimizations**:
  - `EffectComposer` with `RenderPass`, `UnrealBloomPass`, `ShaderPass`, and `OutputPass`.
  - HalfFloat HDR on supported hardware, automatically falling back to 8-bit `THREE.UnsignedByteType` on ultra-low tier / software renderers.
  - Initial bloom intensity calibrated to `0.45` (`0.28–0.38` on low tiers) with dynamic bypass (`bloomPass.enabled = false`) when bloom approaches zero.
  - Fragment shader ALU bypass skipping integer PCG hash and `pow()` gamma-space conversions when film grain is minimal.

---

## 3. Direct Gesture Pipeline & Landmark Fusion

- **Inference Scheduling**: `requestVideoFrameCallback()` triggers MediaPipe processing synchronously on new camera frames; MediaPipe timestamps are rebased onto the performance clock with strict monotonic guarantees.
- **Gesture Fusion**:
  - **Neural Classifier**: Google MediaPipe `gesture_recognizer.task` (`float16`, served as a nested ZIP bundle); cached in `CacheStorage` after magic-byte validation (`TFL3` or `PK\x03\x04` zip) with poison eviction.
  - **Landmark Geometry**: Dual-pass evaluation analyzing finger joint angles (`angleAt`, branch-free), PIP/DIP straightness (`fingerExtensionScore`, `EXT_UNKNOWN=0.5`), palm-basis normal `quality`, and direction-scored `Pointing_Up`.
  - **Fusion Rule**: quality-weighted blend (`wGeom = 0.30 + 0.16*q`), agreement and confident-model boosts, and a `None` veto from both the classifier and the `MP_NEGATIVE_LABELS` canned set (`Closed_Fist`, `Thumb_Up`, `Thumb_Down`, `ILoveYou`).
- **Temporal State Machine**: time-based EMA (`EMA_TAU_ATTACK=0.045s`, `EMA_TAU_RELEASE=0.13s`) with activation/switch/hold/release hysteresis (`0.64/0.74/0.44` + margins), so debounce timing is frame-rate independent; release accumulates independently so a flickering challenger cannot block release.
- **Control Mappings**:
  - `Pointing_Up`: Index fingertip (`lm[8]`) 3D raycasting onto particle ground plane (`raycaster.setFromCamera(handNDC, camera)`); `handToNDC` applies aspect correction so equal hand travel yields physical, viewport-independent ground travel.
  - `Open_Palm`: Distance lerp calculated from world-space hand scale (`lm[12]` to `lm[0]`) mapped to camera orbit radius.
  - `Victory`: Hand center X position mapped to chaos/turbulence strength (`uiV.chaos`); midpoint anchored to wrist `lm[0]`.

---

## 4. Web Audio Reactivity - third input channel

- **Pipeline**: `getUserMedia({ audio: true })` -> `MediaStreamAudioSourceNode` -> `AnalyserNode` (`fftSize=1024`, `smoothingTimeConstant=0`, own EMA smoothing applied on the CPU for frame-rate independence, matching the gesture temporal machine's philosophy).
- **Band Splitting**: `computeAudioBandBins()` maps the analyser's sample rate/FFT size to bass (~20-250Hz) and treble (~2-8kHz) bin ranges once, at connection time; `computeAudioBands()` averages those ranges every frame into normalised 0..1 levels with no per-frame allocation (an out-parameter is reused, the same idiom `handToNDC()` uses for the gesture raycast).
- **Onset/Beat Detection**: `detectAudioOnset()` tracks a slow running average of bass energy as an adaptive noise floor; a transient that jumps well above its own recent history (`bassRaw > bassAvg * 1.4 + 0.05`) fires a "pulse" impulse that decays over ~140ms, independent of the track's absolute loudness.
- **Shader Coupling**: three uniforms (`uAudioBass`, `uAudioTreble`, `uAudioPulse`) feed the same particle vertex/fragment shader the gesture attractor uses -- bass swells the whole field radially, treble scales curl-noise turbulence amplitude, and pulse flashes per-particle energy (and, on the JS side, kicks `bloomPass.strength`) on detected hits.
- **Lifecycle Parity with Camera**: session-counter guard against stale enable/disable races, explicit permission gate before any audio graph is built, named `getUserMedia` error messages, and full teardown on tab hide — camera/mic tracks are fully stopped and re-acquired on return only if they were live at hide time — plus page unload and `bfcache` persistence.
- **Test Surface**: `window.__qsAudio` exposes `computeAudioBandBins`, `computeAudioBands`, and `detectAudioOnset` as pure functions, so the band-splitting and onset maths are verified against synthetic frequency-bin arrays without a live microphone.

## 5. In-App Engineering Panel & GPU Profiling

- **Engineering Notes Modal** (`B` key): reuses the guide modal's exact accessibility shape (focus trap via a shared `FOCUSABLE_SELECTOR` Tab-cycling handler, `inert` background regions while open, mutual exclusion between the two modals) to surface architecture highlights and live particle-count stats directly to visitors who won't read the source.
- **GPU Timing**: a small `GPUTimer` class wraps `EXT_disjoint_timer_query_webgl2`, pipelining queries two-deep (`begin()`/`end()` around `composer.render()`, `poll()` reading back a frame or two later) so a result is never awaited synchronously -- that would stall the GPU on the driver. Falls back to a "draw calls only" readout when the extension is unavailable.
- **Accurate Draw-Call Counting**: `EffectComposer` issues one internal `renderer.render()` call per pass, and `WebGLRenderer.info` auto-resets at the start of each one by default, so naively reading `renderer.info.render.calls` after `composer.render()` only reflects the *last* pass. `renderer.info.autoReset` is disabled and reset is taken once per frame instead, so the counter accumulates across the whole composer pipeline for an honest per-frame total.

## 6. Testing & Verification

- **Playwright e2e** (`tests/`): 79 tests across 13 suites (gesture recognition, camera pipeline, visibility suspension, accessibility, DOM, gesture state, WebGL, audio reactivity, engineering panel, audio band DSP, topology expansion, URL state, shader compilation).
- **Synthetic Landmarks** (`tests/fixtures/hand-poses.mjs`): deterministic 21-landmark pose generator (`openPalm`, `point`, `victory`, `fist`, `twoTogether`) driving classifier/hysteresis/fusion tests.
- **Test Surfaces**: `window.__qsGesture` exposes the pure gesture scoring/fusion/temporal/NDC functions; `window.__qsAudio` exposes the pure audio band-splitting/onset-detection functions. Both follow the same principle -- push side effects to the edges, keep the maths pure and browser-agnostic, so it is unit-testable without a physical camera or microphone.
- **Static Audit** (`scripts/static_audit.js`): ES module syntax, duplicate DOM IDs, `vercel.json` schema, `robots.txt`, import-map SRI coverage, manifest/icon presence, topology & keyboard-binding consistency.

## 7. Security & Vercel Hobby Infrastructure

- Static file delivery (`index.html`, `vercel.json`, `robots.txt`, `sitemap.xml`, `manifest.json`, `og-image.jpg`, icons).
- Heavy binaries loaded directly from upstream CDNs (`cdn.jsdelivr.net` & `unpkg.com`), avoiding Vercel bandwidth proxying.
- Model cached in browser `CacheStorage` (`quantum-singularity-mediapipe-0.10.35`).
- Strict CSP and same-origin camera/microphone permissions policy.
- **Subresource Integrity via import map**: SRI covers the import-map modules only — `three.module.js`, all six addon files, and the MediaPipe `vision_bundle.mjs` from both the jsdelivr and unpkg mirrors (nine modules total) — each pinned with a `sha384` hash in the importmap's `integrity` block (Chrome 127+, Firefox 138+, Safari 18.4+). This closes the one supply-chain gap CSP's origin allowlist can't: a compromised or MITM'd CDN response for an *allowed* origin now fails to execute instead of running silently. `scripts/static_audit.js` enforces that every reachable import URL has a matching hash, so an added dependency can't ship without coverage. The MediaPipe WASM runtime and `.wasm` binary are fetched by MediaPipe's own loader outside the import map, so they can't carry import-map integrity; they load from the same pinned CDN origins, and the `gesture_recognizer.task` model is validated by magic bytes (`TFL3`/ZIP signature + size floor) with poison eviction.
- **Why `script-src` still keeps `'unsafe-inline'`**: the two alternatives were considered and rejected for this architecture specifically, not by default. A nonce-based CSP needs a fresh per-request value injected by a server, which this project deliberately doesn't have (0 Vercel Functions/Edge Middleware is a stated design goal, not an oversight); a hardcoded "nonce" in a static file is not a nonce and provides zero benefit. A hash-based CSP is technically viable for a static file, but this is a single-file app with a multi-thousand-line inline `<script type="module">` that changes frequently -- pinning its hash would silently break the entire site on the next unrelated edit unless the hash is remembered and recomputed every time, which is a worse failure mode than the gap it closes. SRI on the CDN imports addresses the higher-value target (third-party code execution) without that fragility.
- **PWA manifest**: `manifest.json` + `icon-192.png`/`icon-512.png` (any + maskable) + `apple-touch-icon.png`, generated from the same mark used by the inline SVG favicon so the brand is pixel-consistent installed, pinned, or shared.
