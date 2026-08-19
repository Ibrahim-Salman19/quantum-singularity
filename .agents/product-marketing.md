# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-08-19

## Product Overview
**One-liner:** A real-time, on-device WebGL 2 particle simulation controllable via hand gestures and live microphone sound from a single static HTML file.
**What it does:** Simulates up to 110,000 GPU particles arranged into six mathematical topologies (Accretion Disk, Phyllotaxis Lotus, 4D Tesseract, Strange Attractor, Hopf Fibration, Lorenz Manifold), rendered through an HDR bloom post-processing pipeline and driven by three fused real-time input channels (pointer raycasting, on-device MediaPipe hand gestures, and Web Audio API FFT audio reactivity).
**Product category:** Creative Coding / WebGL Computational Art / Browser-Based Real-Time Physics Simulation / On-Device ML Demo
**Product type:** Open-source interactive web application / Technical showcase / Developer portfolio piece
**Business model:** 100% Free & Open Source (MIT License), self-hostable, zero subscriptions, zero tracking.

## Target Audience
**Target companies & organizations:** Tech companies, creative agencies, game studios, browser vendors, AI research labs, design engineering teams.
**Decision-makers & Audience:** 
- Creative Technologists and Design Engineers evaluating state-of-the-art interactive web graphics.
- Frontend & WebGL Developers seeking high-performance shader techniques and zero-GC architecture references.
- ML / Computer Vision Engineers interested in lightweight on-device sensor fusion (MediaPipe + Geometric classifiers).
- Computational Art & Audio-Visual Enthusiasts looking for real-time generative particle experiences.
- Technical Recruiters and Engineering Managers seeking evidence of deep systems engineering and mathematical rigor.

**Primary use case:** Experiencing and studying cutting-edge browser performance, procedural vertex shader computation, and multi-modal sensory fusion (vision + audio + touch) running locally with zero latency and zero server dependencies.
**Jobs to be done:**
1. Provide an inspiring, fluid interactive computational art experience controlled by natural physical inputs (gestures and sound).
2. Serve as an authoritative reference implementation of zero-allocation render loops, shader-only particle topologies, and resilient audio/camera pipelines.
3. Demonstrate production-grade web accessibility, WCAG AA compliance, and graceful degradation in WebGL applications.

## Problems & Pain Points
**Core problem:** Most web particle simulations either suffer from severe CPU-to-GPU memory transfer bottlenecks, heavy GC stutter, clunky gesture detection that flickers, or invasive cloud-dependent ML APIs that compromise privacy and add latency.
**Why alternatives fall short:**
- Traditional particle engines upload large Nx3 position arrays from CPU to GPU every frame, wasting megabytes of bandwidth and causing frame drops on lower-spec hardware.
- Naive gesture recognizers flicker on frame-rate spikes and fail when hands tilt away from canonical orientations.
- Audio-reactive demos rely on hardcoded thresholds that fail in different acoustic environments.
- Complex frameworks require megabytes of npm dependencies, complex build pipelines, and server-side infrastructure.
**What it costs them:** Frame stutter (jank), broken mobile experiences, privacy risks, battery drain, and maintenance headaches.
**Emotional tension:** Frustration with sluggish web graphics and fragile ML demos that fail outside ideal lab conditions.

## Competitive Landscape
**Direct (Traditional WebGL Demos / Three.js Experiments):** Typically compute positions on the CPU, allocate objects inside requestAnimationFrame, or suffer from frame-rate dependent easing.
**Secondary (Cloud-Based Vision / Audio Demos):** Stream webcam/audio frames to backend servers, causing 100ms+ latency, bandwidth consumption, and privacy leakage.
**Indirect (Native Desktop Creative Tools like TouchDesigner / Notch):** Powerful but require high-end desktop hardware, heavy installation, and cannot run instantly in a standard web browser on a phone or laptop.

## Differentiation
**Key differentiators:**
1. **Zero-CPU Particle Positioning:** Every particle's 3D coordinate is calculated procedurally in the vertex shader via gl_VertexID formulas. Zero bytes of position buffer uploaded per frame.
2. **Uniform LOD via Fisher-Yates Buffer Shuffling:** Particle indices are shuffled with a seeded Fisher-Yates algorithm at boot, decorrelating buffer order from spatial radius so GPU load-shedding thins the field uniformly without clipping edges.
3. **Dual-Signal Sensor Fusion:** Fuses MediaPipe neural classification with a handwritten orientation-invariant geometric classifier, weighted dynamically by palm-normal quality with temporal state machine hysteresis.
4. **Adaptive Noise-Floor Audio DSP:** 4-band FFT analysis with continuous exponential noise-floor calibration that automatically adapts to quiet rooms and loud music without manual sensitivity sliders.
5. **Zero-Allocation Hot Path:** Zero garbage collection pauses during interaction; all vectors, state objects, and FFT bins use pre-allocated scratch memory.
6. **100% On-Device Privacy & Zero Build Step:** Runs from a single static HTML file with pinned SRI-hashed CDNs. No camera or microphone data ever leaves the device.

## Customer / User Language
**How users describe the experience:**
- "A mesmerizing interactive particle field that responds instantly to my hands."
- "Silky smooth 120 FPS performance even on mobile."
- "The best reference for clean WebGL 2 vertex shader architecture and MediaPipe fusion."
**Words to use:** Procedural vertex shader, mathematical topology, Hopf fibration, Lorenz manifold, sensor fusion, on-device ML, zero-GC, adaptive DSP, HDR bloom, frame-rate independent.
**Words to avoid:** Purple gradient slop, cloud AI, subscription, cookie tracking, heavy framework.

## Brand Voice & Technical Tone
**Tone:** Authoritative, precise, scientifically rigorous, elegant, and transparent.
**Style:** Systems engineering clarity, direct mathematical formulations, verified benchmarks, and zero marketing fluff.
**Personality:** A master craftsman's scientific instrument.

## Proof Points & Benchmarks
- **Particle count:** Up to 110,000 real-time particles running at 60-144 Hz.
- **Render loop allocation:** Exactly 0 bytes/frame (zero GC pauses).
- **GPU time:** <2.5 ms per frame on mid-tier integrated graphics.
- **Topologies:** 6 distinct topological manifolds with real-time continuous morphing.
- **Testing:** 79 automated Playwright tests covering gesture scoring, audio DSP, WebGL state, focus trapping, and URL state serialization.
- **Security:** Strict Content Security Policy (CSP), Subresource Integrity (sha384), magic-byte model validation, and offline cache poison eviction.

## Goals
**Business & Project Goal:** Maximize discovery and citation across both traditional search engines (Google, Bing) and AI systems (Perplexity, ChatGPT, Claude, Gemini), demonstrating peerless engineering quality and technical thought leadership.
**Key Conversion Action:** Exploring the live interactive demo (https://animation-zeta-rosy.vercel.app/), reviewing the architectural source code, starring the GitHub repository, and citing the engineering decisions in WebGL/AI research.

## Changelog
- v1 (2026-08-19) — Initial product marketing context established for Quantum Singularity.
