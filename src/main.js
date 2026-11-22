/**
 * Quantum Singularity: application entry point.
 *
 * Owns the stateful orchestration: renderer, post-processing chain, UI wiring,
 * camera/microphone lifecycles, adaptive quality and the animation loop. All pure
 * logic (classification, filtering, DSP, URL state, device tiering) lives in
 * sibling modules and is unit-tested under Node; see ARCHITECTURE.md.
 */
import { clamp, clamp01, lerp, smooth01, easeOutExpo, approach, OneEuroFilter, createLcg } from './core/math.js';
import { computeQualityProfile, parseQualityOverride, pointSizeCompensation } from './core/device-profile.js';
import { GESTURE_LABELS, geometryGestureScores, mediaPipeGestureScores, fuseGestureScores } from './gesture/classifier.js';
import { createGestureStateMachine, GESTURE_THRESHOLDS } from './gesture/state-machine.js';
import { computeAudioBandBins, computeAudioBands, detectAudioOnset } from './audio/dsp.js';
import { parseShareHash, serializeShareState } from './state/share-link.js';
import { PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER } from './render/shaders/particles.js';
import { CINEMATIC_VERTEX_SHADER, CINEMATIC_FRAGMENT_SHADER } from './render/shaders/cinematic.js';

let THREE, OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass;
try {
    const modules = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/ShaderPass.js'),
        import('three/addons/postprocessing/OutputPass.js')
    ]);
    [THREE] = modules;
    ({ OrbitControls } = modules[1]);
    ({ EffectComposer } = modules[2]);
    ({ RenderPass } = modules[3]);
    ({ UnrealBloomPass } = modules[4]);
    ({ ShaderPass } = modules[5]);
    ({ OutputPass } = modules[6]);
} catch (error) {
    const banner = document.getElementById('fatal-banner');
    banner.textContent = 'Core 3D dependencies could not be loaded. Check your connection or self-host the pinned dependencies for production.';
    banner.classList.add('visible');
    throw error;
}

// ═══════════════════════════════════════════
// 0. CAPABILITIES, DEVICE PROFILE & QUALITY BUDGET
// ═══════════════════════════════════════════
const MP_VERSION = '0.10.35';
const MP_BUNDLES = [
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
    `https://unpkg.com/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`
];
const MP_WASM_ROOTS = [
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`,
    `https://unpkg.com/@mediapipe/tasks-vision@${MP_VERSION}/wasm`
];
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const MP_MODEL_CACHE = `quantum-singularity-mediapipe-${MP_VERSION}`;
const NETWORK_TIMEOUT_MS = 15000;

function withNetworkTimeout(promise, label, timeoutMs = NETWORK_TIMEOUT_MS) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error(`${label} timed out`);
            error.name = 'TimeoutError';
            reject(error);
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointerQuery = matchMedia('(pointer: coarse)');
const isMobile = coarsePointerQuery.matches || innerWidth <= 768;

// Read the unmasked GPU renderer string from a throwaway context. Tiering itself is
// pure and unit-tested (src/core/device-profile.js).
function probeRendererName() {
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2', { powerPreference: 'high-performance' }) ||
                   probe.getContext('webgl', { powerPreference: 'high-performance' });
        if (!gl) return '';
        // Firefox deprecates WEBGL_debug_renderer_info and reports a sanitised
        // name through RENDERER directly; Chromium/Safari need the extension.
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const name = (debugInfo && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '';
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return String(name);
    } catch (_) {
        return '';
    }
}

// `?quality=minimal|low|medium|high` pins a tier and locks the adaptive loop, for
// demos, screen capture and reproducible performance comparisons.
const qualityProfile = computeQualityProfile({
    rendererName: probeRendererName(),
    deviceMemory: Number(navigator.deviceMemory) || undefined,
    cores: Number(navigator.hardwareConcurrency) || undefined,
    saveData: Boolean(navigator.connection?.saveData),
    isMobile,
    override: parseQualityOverride(location.search)
});
const { ultraLowTier, lowTier } = qualityProfile;
const adaptiveQualityLocked = qualityProfile.forced;
const INITIAL_BLOOM = qualityProfile.initialBloom;
// Allocate once at the tier's ceiling; adaptive quality then trims draw ranges.
const N = qualityProfile.particleCount;
const SN = qualityProfile.starCount;
const DPR_CAP = qualityProfile.dprCap;
const TARGET_FPS = qualityProfile.targetFps;
const INFERENCE_FPS_CAP = qualityProfile.inferenceFpsCap;
const baselineInferenceFPS = qualityProfile.baselineInferenceFps;

let currentInferenceFPS = baselineInferenceFPS;
let adaptiveScale = qualityProfile.initialRenderScale;

const effectiveDPR = () => clamp((window.devicePixelRatio || 1) * adaptiveScale, ultraLowTier ? 0.65 : 0.7, DPR_CAP);

function supportsWebGL2() {
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2', { powerPreference: 'high-performance' });
        if (!gl) return false;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return true;
    } catch (_) {
        return false;
    }
}

if (!supportsWebGL2()) {
    const banner = document.getElementById('fatal-banner');
    banner.textContent = 'This experience requires WebGL 2. Update your browser or enable hardware acceleration.';
    banner.classList.add('visible');
    throw new Error('WebGL 2 is required by current Three.js WebGLRenderer releases.');
}

document.getElementById('hud-particles').textContent = `${Math.round(N / 1000)}K PTS`;
document.getElementById('eng-stat-particles').textContent = `${Math.round(N / 1000)}K`;

// Mobile Drawer Toggle
const controlsPanel  = document.getElementById('controls');
const mobileToggleBtn = document.getElementById('mobile-toggle-btn');

if (!isMobile) {
    controlsPanel.classList.remove('collapsed');
}

function controlsOpenOnMobile() {
    return isMobile && !controlsPanel.classList.contains('collapsed');
}

function setMobileControls(open) {
    if (!mobileToggleBtn) return;
    controlsPanel.classList.toggle('collapsed', !open);
    document.body.classList.toggle('controls-open', open);
    mobileToggleBtn.textContent = open ? 'Close controls' : 'Controls';
    mobileToggleBtn.setAttribute('aria-expanded', String(open));
}

function closeMobileControls() {
    setMobileControls(false);
    mobileToggleBtn?.focus();
}

mobileToggleBtn?.addEventListener('click', () => {
    setMobileControls(controlsPanel.classList.contains('collapsed'));
});

// Tapping the canvas while the drawer is open dismisses it, matching the
// expectation set by every other bottom-sheet style control on mobile.
document.addEventListener('pointerdown', (e) => {
    if (!controlsOpenOnMobile()) return;
    const t = e.target;
    if (t instanceof Node && (controlsPanel.contains(t) || mobileToggleBtn?.contains(t))) return;
    setMobileControls(false);
}, { passive: true });

// ═══════════════════════════════════════════
// 0. GUIDE MODAL - first-visit + re-openable
// ═══════════════════════════════════════════
const guideOverlay  = document.getElementById('guide-overlay');
const modalClose    = document.getElementById('modal-close');
const modalLaunch   = document.getElementById('modal-launch');
const modalContinue = document.getElementById('modal-continue');
const helpBtn       = document.getElementById('help-btn');
const hudHelpBtn    = document.getElementById('hud-help-btn');
const STORAGE_KEY   = 'qs_guide_dismissed_v4';

let isGuideOpen = false;
let prevActiveElement = null;
const backgroundRegions = ['ui', 'nui', 'bottom-hud'];

// The overlay is hidden with opacity/pointer-events, which does NOT remove its
// controls from the tab order. Without `inert` a keyboard user tabbing the page
// landed on five invisible buttons, and `aria-modal="true"` was permanently
// asserted to screen readers. Start inert and only lift it while open.
guideOverlay.setAttribute('inert', '');
guideOverlay.setAttribute('aria-hidden', 'true');

function openGuide() {
    if (isGuideOpen) return;
    dismissIntro();
    if (isEngOpen) closeEng();
    isGuideOpen = true;
    prevActiveElement = document.activeElement;
    for (const id of backgroundRegions) document.getElementById(id)?.setAttribute('inert', '');
    guideOverlay.removeAttribute('inert');
    guideOverlay.removeAttribute('aria-hidden');
    guideOverlay.classList.add('visible');
    modalClose.focus();
}

function closeGuide() {
    if (!isGuideOpen) return;
    isGuideOpen = false;
    guideOverlay.classList.remove('visible');
    guideOverlay.setAttribute('inert', '');
    guideOverlay.setAttribute('aria-hidden', 'true');
    for (const id of backgroundRegions) document.getElementById(id)?.removeAttribute('inert');
    // Focus may have been inside the now-inert overlay; fall back to a sensible
    // anchor rather than dropping focus to <body>.
    const restore = prevActiveElement && prevActiveElement.isConnected && prevActiveElement.offsetParent !== null
        ? prevActiveElement
        : helpBtn;
    restore?.focus?.();
    prevActiveElement = null;
}

// ── First-run welcome. The guide used to open as a modal on arrival, so a first
// visit began with a wall of instructions over a blurred field. Now the field is
// seen first, then a compact non-modal card offers the two ways in. It never
// takes focus, and any way of engaging (a choice, H, Esc, the camera button)
// dismisses it for good.
const introCard = document.getElementById('intro-card');
let introVisible = false;
let introTimer = null;
let isDismissed = false;
try { isDismissed = !!localStorage.getItem(STORAGE_KEY); } catch (e) {}

function scheduleIntro(delayMs) {
    if (isDismissed || introTimer || introVisible) return;
    introTimer = setTimeout(() => {
        introTimer = null;
        if (isDismissed || isGuideOpen || isEngOpen) return;
        introVisible = true;
        introCard.hidden = false;
        requestAnimationFrame(() => requestAnimationFrame(() => introCard.classList.add('visible')));
    }, delayMs);
}

function dismissIntro() {
    if (introTimer) { clearTimeout(introTimer); introTimer = null; }
    if (!isDismissed) {
        isDismissed = true;
        try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
    }
    if (!introVisible) return;
    introVisible = false;
    const hadFocus = introCard.contains(document.activeElement);
    introCard.classList.remove('visible');
    setTimeout(() => { if (!introVisible) introCard.hidden = true; }, 520);
    if (hadFocus) helpBtn?.focus();
}

document.getElementById('intro-camera').addEventListener('click', () => {
    dismissIntro();
    cameraBtn.focus();
    void enableNeuralLink();
});
document.getElementById('intro-dismiss').addEventListener('click', dismissIntro);
document.getElementById('intro-guide').addEventListener('click', () => { dismissIntro(); openGuide(); });

modalClose.addEventListener('click', closeGuide);
modalLaunch.addEventListener('click', () => { closeGuide(); void enableNeuralLink(); });
modalContinue.addEventListener('click', closeGuide);
helpBtn.addEventListener('click', openGuide);
hudHelpBtn.addEventListener('click', openGuide);

guideOverlay.addEventListener('pointerdown', (e) => {
    if (e.target === guideOverlay) closeGuide();
});

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

guideOverlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !isGuideOpen) return;
    const focusables = [...guideOverlay.querySelectorAll(FOCUSABLE_SELECTOR)]
        // getClientRects() is reliable for position:fixed elements, unlike offsetParent.
        .filter(el => el.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
});

// ── Engineering notes modal: same open/close/focus-trap shape as the guide
// modal above, kept as a parallel implementation rather than a shared
// abstraction so each stays simple to follow on its own.
const engOverlay = document.getElementById('eng-overlay');
const engClose   = document.getElementById('eng-close');
const engBtn     = document.getElementById('eng-btn');

let isEngOpen = false;
let prevEngActiveElement = null;

engOverlay.setAttribute('inert', '');
engOverlay.setAttribute('aria-hidden', 'true');

function openEng() {
    if (isEngOpen) return;
    if (isGuideOpen) closeGuide();
    isEngOpen = true;
    prevEngActiveElement = document.activeElement;
    for (const id of backgroundRegions) document.getElementById(id)?.setAttribute('inert', '');
    engOverlay.removeAttribute('inert');
    engOverlay.removeAttribute('aria-hidden');
    engOverlay.classList.add('visible');
    engClose.focus();
}

function closeEng() {
    if (!isEngOpen) return;
    isEngOpen = false;
    engOverlay.classList.remove('visible');
    engOverlay.setAttribute('inert', '');
    engOverlay.setAttribute('aria-hidden', 'true');
    for (const id of backgroundRegions) document.getElementById(id)?.removeAttribute('inert');
    const restore = prevEngActiveElement && prevEngActiveElement.isConnected && prevEngActiveElement.offsetParent !== null
        ? prevEngActiveElement
        : engBtn;
    restore?.focus?.();
    prevEngActiveElement = null;
}

engBtn.addEventListener('click', openEng);
engClose.addEventListener('click', closeEng);
engOverlay.addEventListener('pointerdown', (e) => {
    if (e.target === engOverlay) closeEng();
});
engOverlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !isEngOpen) return;
    const focusables = [...engOverlay.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(el => el.getClientRects().length > 0);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
});

// ═══════════════════════════════════════════
// 1. RENDERER + SCENE
// ═══════════════════════════════════════════
const scene  = new THREE.Scene();
scene.fog    = new THREE.FogExp2(0x080a0a, 0.0014);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 2000);
camera.position.set(0, 45, 140);

let renderer;
try {
    renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: 'high-performance',
        stencil: false,
        depth: false,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false
    });
} catch (error) {
    const banner = document.getElementById('fatal-banner');
    banner.textContent = 'WebGL could not be initialized on this browser/device. Hardware acceleration may be disabled.';
    banner.classList.add('visible');
    throw error;
}
renderer.domElement.className = 'webgl-canvas';
renderer.domElement.setAttribute('aria-label', 'Interactive quantum particle simulation');
renderer.setSize(innerWidth, innerHeight, false);
renderer.setPixelRatio(effectiveDPR());
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
document.body.appendChild(renderer.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor  = 0.055;
orbit.autoRotate     = !reducedMotionQuery.matches;
orbit.autoRotateSpeed = reducedMotionQuery.matches ? 0 : 0.28;
orbit.minDistance    = 18;
orbit.maxDistance    = 420;
orbit.enablePan      = false;

// ═══════════════════════════════════════════
// 2. POST-PROCESSING PIPELINE
// ═══════════════════════════════════════════
// The composer targets are 8-bit on every tier. Particles blend additively, and
// their shading is authored for a buffer that saturates at display white: the
// densest region clips to a bright core while the disk, jets and event horizon
// around it stay readable. Half-float targets let the same regions sum to many
// times display white, and ACES plus bloom then washed the whole disk out, on
// exactly the GPUs that draw the most particles. UnrealBloomPass allocates its
// own half-float mip chain, so the blur itself keeps float precision.
const gl = renderer.getContext();
// HUD quality readout: "AUTO" while the adaptive loop is steering, or the pinned
// tier name when ?quality= locked it.
const hudModeLabel = () => `${adaptiveQualityLocked ? `${qualityProfile.tier.toUpperCase()} LOCKED` : 'AUTO'} Q${Math.round(adaptiveScale * 100)}`;

const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false
});
const composer = new EffectComposer(renderer, sceneTarget);
composer.setPixelRatio(effectiveDPR());
composer.setSize(innerWidth, innerHeight);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    INITIAL_BLOOM,
    ultraLowTier ? 0.20 : 0.25,
    ultraLowTier ? 0.88 : 0.85
);
composer.addPass(bloomPass);

const CinematicShader = {
    uniforms: {
        tDiffuse: { value: null },
        uTime:    { value: 0 },
        uCA:      { value: 0.003 },
        uVig:     { value: 1.0 },
        uGrain:   { value: 0.018 },
        // Aspect-correction for the chromatic aberration offset, so fringing is
        // radially symmetric instead of stretched horizontally on wide displays.
        uAspect:  { value: new THREE.Vector2(1, 1) }
    },
    vertexShader: CINEMATIC_VERTEX_SHADER,
    fragmentShader: CINEMATIC_FRAGMENT_SHADER
};
// ShaderPass's own ShaderMaterial constructor does NOT forward `glslVersion`
// (it only copies name/defines/uniforms/vertex/fragment), so setting it on a
// plain shader object would silently compile as GLSL ES 1.00 and fail on the
// GLSL3 syntax below. ShaderPass *does* accept a ShaderMaterial instance
// directly, so build the material here with GLSL3 explicitly set.
// GLSL ES 3.0 enables uvec2 / floatBitsToUint for the integer grain hash and
// removes the deprecated texture2D / gl_FragColor built-ins. Safe: the project
// already enforces WebGL2 above, so GLSL3 is always available in this context.
const cinPass = new ShaderPass(new THREE.ShaderMaterial({
    name: 'CinematicShader',
    uniforms: THREE.UniformsUtils.clone(CinematicShader.uniforms),
    vertexShader: CinematicShader.vertexShader,
    fragmentShader: CinematicShader.fragmentShader,
    glslVersion: THREE.GLSL3
}));
composer.addPass(cinPass);
// Keeps the cinematic pass's radial maths aspect-correct.
function updateCinematicAspect(w, h) {
    const a = cinPass.uniforms.uAspect.value;
    if (w >= h) a.set(w / h, 1); else a.set(1, h / w);
}
updateCinematicAspect(innerWidth, innerHeight);
const outputPass = new OutputPass();
composer.addPass(outputPass);

// ═══════════════════════════════════════════
// 3. FULL-GPU PARTICLE SYSTEM
// ═══════════════════════════════════════════
const geo = new THREE.BufferGeometry();

const aIdxArr = new Float32Array(N);
const aSdArr  = new Float32Array(N);
// Bipolar jet polarity, stored explicitly as -1/+1. It used to be recovered inside
// the shader with `mod(floor(aIndex * uTotalCount), 2.0)`, which round-trips an
// integer through a float32 division and back -- landing on k-1 for some particles
// and giving arbitrary polarity. An attribute is exact and cheaper.
const aPolArr = new Float32Array(N);
// Seeds come from a fixed-seed PRNG rather than Math.random(), so every load
// renders the same field: screenshots, captures and visual regressions compare.
const seedRng = createLcg(0x2545f491);
for (let i = 0; i < N; i++) {
    aIdxArr[i] = i / N;
    aSdArr[i] = seedRng.next();
    aPolArr[i] = (i & 1) ? 1 : -1;
}

// Adaptive quality lowers the draw range, which draws a *prefix* of the buffer.
// Because every topology maps aIndex monotonically to radius, an ordered buffer made
// quality drops visibly lop off the outer edge of the accretion disk. Shuffling the
// index attribute decorrelates buffer order from spatial position, so reducing the
// draw range thins the field uniformly and is essentially invisible.
// (Fisher-Yates with a fixed seed keeps startup deterministic.)
const shuffleRng = createLcg(0x9e3779b9);
for (let i = N - 1; i > 0; i--) {
    const j = shuffleRng.nextUint() % (i + 1);
    const ti = aIdxArr[i]; aIdxArr[i] = aIdxArr[j]; aIdxArr[j] = ti;
    const ts = aSdArr[i];  aSdArr[i]  = aSdArr[j];  aSdArr[j]  = ts;
    const tp = aPolArr[i]; aPolArr[i] = aPolArr[j]; aPolArr[j] = tp;
}

// No `position` attribute: every position is computed procedurally in the vertex
// shader, so the conventional N*3 buffer was 1.3 MB of zeros uploaded to the GPU and
// bound on every draw. Three.js derives the vertex count from any attribute, so
// aIndex serves that role.
geo.setAttribute('aIndex', new THREE.BufferAttribute(aIdxArr, 1));
geo.setAttribute('aSeed',  new THREE.BufferAttribute(aSdArr,  1));
geo.setAttribute('aPolarity', new THREE.BufferAttribute(aPolArr, 1));
geo.setDrawRange(0, Math.max(1, Math.floor(N * qualityProfile.initialParticleFraction)));

// Shaders live in src/render/shaders/particles.js.
const VERT = PARTICLE_VERTEX_SHADER;
const FRAG = PARTICLE_FRAGMENT_SHADER;

const partMat = new THREE.ShaderMaterial({
    uniforms: {
        uTime:       { value: 0 },
        uTotalCount: { value: N },
        uShape:      { value: 0 },
        uScale:      { value: 18 },
        uGravity:    { value: 1.15 },
        uJetPower:   { value: 0.85 },
        uChaos:      { value: 0.18 },
        uSpeed:      { value: 0.55 },
        uPalette:    { value: 0 },
        uPaletteNext:{ value: 0 },
        uPaletteMix: { value: 0 },
        uPSize:      { value: 2.25 },
        // Shrinks points as the drawn count grows, so coverage stays constant (see device-profile.js).
        uCoverage:   { value: pointSizeCompensation(geo.drawRange.count) },
        uPixel:      { value: effectiveDPR() },
        // Drawing-buffer height in device pixels; feeds the perspective point-size term.
        uViewportHeight: { value: Math.max(1, innerHeight * effectiveDPR()) },
        uHandPos:    { value: new THREE.Vector3() },
        uHandInfl:   { value: 0 },
        uAudioBass:  { value: 0 },
        uAudioTreble:{ value: 0 },
        uAudioMid:   { value: 0 },
        uAudioPulse: { value: 0 }
    },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
const particles = new THREE.Points(geo, partMat);
// Vertex positions are generated procedurally in the GPU shader, so there is no
// CPU-side position buffer to derive bounds from. Frustum culling must be off or
// Three.js would cull against a nonexistent/degenerate bounding sphere.
particles.frustumCulled = false;
scene.add(particles);

// ── Background starfield ──
const sgeo = new THREE.BufferGeometry();
const spos = new Float32Array(SN*3), scol = new Float32Array(SN*3);
// Star brightness is authored perceptually (sRGB-ish), but a raw Float32 colour
// attribute is consumed as linear working space in r185. Convert once at build time
// so the intended brightness distribution survives OutputPass.
const srgbToLinear = (c) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
for (let i = 0; i < SN; i++) {
    const r = 420 + Math.random()*700;
    const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
    spos[i*3]=r*Math.sin(ph)*Math.cos(th); spos[i*3+1]=r*Math.sin(ph)*Math.sin(th); spos[i*3+2]=r*Math.cos(ph);
    const b = 0.15 + Math.random()*0.85, st = Math.random();
    let cr, cg, cb;
    if      (st < 0.3)  { cr = b*.6; cg = b*.7;  cb = b; }
    else if (st < 0.55) { cr = b;    cg = b*.85; cb = b*.6; }
    else                { cr = b;    cg = b;     cb = b; }
    scol[i*3] = srgbToLinear(cr); scol[i*3+1] = srgbToLinear(cg); scol[i*3+2] = srgbToLinear(cb);
}
sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
sgeo.setAttribute('color',    new THREE.BufferAttribute(scol, 3));
sgeo.setDrawRange(0, Math.max(1, Math.floor(SN * qualityProfile.initialStarFraction)));
const stars = new THREE.Points(sgeo,
    // sizeAttenuation must be off. Stars sit 420-1120 world units away, so with
    // attenuation on they rendered at roughly 0.2-0.6 device pixels: effectively
    // invisible, and crawling/flickering as the field rotates. A fixed screen-space
    // size is both correct for a skybox and far cheaper to rasterise.
    // fog is disabled because FogExp2 mixes toward a non-black colour under additive
    // blending, which added a grey haze instead of fading the stars out.
    new THREE.PointsMaterial({
        size: 1.7,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
    })
);
// The star shell always encloses the camera (orbit maxDistance is 420), so the
// bounding-sphere test can never cull it -- skip the per-frame check entirely.
stars.frustumCulled = false;
scene.add(stars);

// ═══════════════════════════════════════════
// 4. SLIDER CONTROLS
// ═══════════════════════════════════════════
const uiV = {
    shape:0, scale:18, gravity:1.15, jetPower:0.85, chaos:0.18, speed:0.55,
    palette:0, psize:2.25, bloom:INITIAL_BLOOM
};
const DEFAULTS = { ...uiV };
let shapeTween = null;
let paletteTween = null;

function mkSlider(cid, id, label, mn, mx, init) {
    uiV[id] = init;
    const cg  = document.getElementById(cid);
    const lbl = document.createElement('label');
    lbl.htmlFor = id;
    lbl.innerHTML = `<span>${label}</span><span class="val" id="${id}-v">${fmt(init)}</span>`;
    const inp = document.createElement('input');
    inp.type='range'; inp.id=id; inp.min=mn; inp.max=mx;
    inp.step=(mx-mn)/400; inp.value=init;
    inp.addEventListener('input', () => {
        uiV[id] = +inp.value;
        document.getElementById(id+'-v').textContent = fmt(uiV[id]);
        if (id === 'shape') {
            shapeTween = null;
            syncPresetBtns(uiV[id]);
        }
    });
    cg.appendChild(lbl); cg.appendChild(inp);
}

function fmt(v) { return v < 10 ? v.toFixed(2) : v.toFixed(1); }

function setSlider(id, val) {
    const el = document.getElementById(id); if (!el) return;
    const v = Math.min(+el.max, Math.max(+el.min, val));
    el.value = v; uiV[id] = v;
    const ve = document.getElementById(id+'-v');
    if (ve) ve.textContent = fmt(v);
    if (id === 'shape') syncPresetBtns(v);
}

function resetSliders() {
    shapeTween = null;
    paletteTween = null;
    Object.entries(DEFAULTS).forEach(([k,v]) => {
        if (k !== 'palette') setSlider(k, v);
    });
    uiV.palette = DEFAULTS.palette;
    partMat.uniforms.uPalette.value = DEFAULTS.palette;
    partMat.uniforms.uPaletteNext.value = DEFAULTS.palette;
    partMat.uniforms.uPaletteMix.value = 0;
    document.querySelectorAll('.swatch').forEach(sw => {
        const active = +sw.dataset.pal === DEFAULTS.palette;
        sw.classList.toggle('active', active);
        sw.setAttribute('aria-pressed', String(active));
    });
}

function syncPresetBtns(val) {
    const rv = Math.round(val);
    document.querySelectorAll('.btn-preset').forEach(b => {
        const active = +b.dataset.shape === rv;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}

mkSlider('cg-shape',   'shape',    'Morph Topology',  0,   5,    0   );
mkSlider('cg-scale',   'scale',    'Event Horizon',   15,  60,   18  );
mkSlider('cg-gravity', 'gravity',  'Spacetime Warp',  0.5, 5,    1.15);
mkSlider('cg-jetpower','jetPower', 'Jet Energy',      0,   3,    0.85);
mkSlider('cg-chaos',   'chaos',    'Curl Chaos',      0,   2,    0.18);
mkSlider('cg-speed',   'speed',    'Time Warp',       0.2, 2.0,  0.55);
mkSlider('cg-psize',   'psize',    'Particle Scale',  0.4, 2.8,  2.25);
mkSlider('cg-bloom',   'bloom',    'Bloom Intensity', 0.0, 2.5,  INITIAL_BLOOM);

// ── URL hash state: read once at startup ───────────────────────────────────────
// Parsing and validation live in src/state/share-link.js. history.replaceState is
// not called here; the hash is only written on demand by the C key, so the
// animate loop stays free of DOM mutations.
(function applyHashState() {
    const { sliders, palette, topology } = parseShareHash(location.hash);
    for (const [id, value] of Object.entries(sliders)) setSlider(id, value); // setSlider clamps to [min,max]
    if (palette !== undefined) {
        uiV.palette = palette;
        partMat.uniforms.uPalette.value = palette;
        partMat.uniforms.uPaletteNext.value = palette;
        partMat.uniforms.uPaletteMix.value = 0;
        document.querySelectorAll('.swatch').forEach(sw => {
            const active = +sw.dataset.pal === palette;
            sw.classList.toggle('active', active);
            sw.setAttribute('aria-pressed', String(active));
        });
    }
    // Topology last, deferred: morphShapeTo() is a function declaration further
    // down, but it reads state (shapeTween, SHAPE_INFO) initialised after this IIFE.
    if (topology !== undefined) queueMicrotask(() => morphShapeTo(topology));
})();

function morphShapeTo(target) {
    target = clamp(target, 0, 5);
    if (reducedMotionQuery.matches) {
        shapeTween = null;
        setSlider('shape', target);
        return;
    }
    // Resolve the DOM nodes once here rather than calling getElementById twice per
    // frame for the whole 820ms of the tween.
    shapeTween = {
        from: uiV.shape,
        to: target,
        started: performance.now(),
        duration: 820,
        input: document.getElementById('shape'),
        output: document.getElementById('shape-v')
    };
    syncPresetBtns(target);
}

document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => morphShapeTo(+btn.dataset.shape));
});

document.querySelectorAll('.swatch').forEach(sw => {
    const activateSwatch = () => {
        document.querySelectorAll('.swatch').forEach(s => {
            const active = s === sw;
            s.classList.toggle('active', active);
            s.setAttribute('aria-pressed', String(active));
        });
        const nextPalette = +sw.dataset.pal;
        if (nextPalette === uiV.palette && !paletteTween) return;
        const fromPalette = paletteTween ? paletteTween.to : uiV.palette;
        uiV.palette = nextPalette;
        if (reducedMotionQuery.matches) {
            paletteTween = null;
            partMat.uniforms.uPalette.value = nextPalette;
            partMat.uniforms.uPaletteNext.value = nextPalette;
            partMat.uniforms.uPaletteMix.value = 0;
        } else {
            partMat.uniforms.uPalette.value = fromPalette;
            partMat.uniforms.uPaletteNext.value = nextPalette;
            partMat.uniforms.uPaletteMix.value = 0;
            paletteTween = { from: fromPalette, to: nextPalette, started: performance.now(), duration: 420 };
        }
    };
    sw.addEventListener('click', activateSwatch);
    sw.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            activateSwatch();
            e.preventDefault();
        }
    });
});

const SHAPE_INFO = [
    ['Singularity Accretion',    'GPU particles / black hole jets / adaptive bloom'],
    ['Quantum Lotus',             'GPU particles / spherical harmonics / phyllotaxis'],
    ['4D Breathing Tesseract',    'GPU particles / hyperdimensional lattice / 4D to 3D projection'],
    ['Clifford Attractor',        'GPU particles / quantum vortex / non-Euclidean flow'],
    ['Hopf Fibration',            'GPU particles / S³ stereographic projection / linked circles'],
    ['Lorenz Manifold',           'GPU particles / strange attractor surface / butterfly wings'],
];
let _infoCache = '';
let _infoFadeTimer = null;
function setInfo(idx) {
    const [title, desc] = SHAPE_INFO[idx];
    const key = title + desc;
    if (key === _infoCache) return;
    _infoCache = key;
    const titleEl = document.getElementById('info-title');
    const descEl  = document.getElementById('info-desc');
    // Fade out, swap text, fade back in; collapses to an instant swap when
    // prefers-reduced-motion is active (transition-duration is .01ms there).
    if (_infoFadeTimer) { clearTimeout(_infoFadeTimer); _infoFadeTimer = null; }
    titleEl.classList.add('info-fading');
    descEl.classList.add('info-fading');
    _infoFadeTimer = setTimeout(() => {
        titleEl.textContent = title;
        descEl.textContent  = desc;
        titleEl.classList.remove('info-fading');
        descEl.classList.remove('info-fading');
        _infoFadeTimer = null;
    }, 140);
}

// ═══════════════════════════════════════════
// 5. MOUSE & TOUCH ATTRACTOR FIELD
// ═══════════════════════════════════════════
const raycaster    = new THREE.Raycaster();
const mouseNDC     = new THREE.Vector2();
const groundPlane  = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const mouseWorldPos = new THREE.Vector3();
const pointerReticle = document.getElementById('pointer-reticle');
let isMouseActive = false, mouseTimeout = null;
let pendingPointer = null, pointerRaf = 0;

function clearPointerTimeout() {
    if (mouseTimeout) { clearTimeout(mouseTimeout); mouseTimeout = null; }
    if (pointerRaf) { cancelAnimationFrame(pointerRaf); pointerRaf = 0; }
    pendingPointer = null;
}

function showPointerReticle(clientX, clientY) {
    if (!pointerReticle || reducedMotionQuery.matches) return;
    // Independent `translate` property: composited, and does not clobber the
    // `scale` used by the show/hide transition.
    pointerReticle.style.setProperty('--rx', `${clientX}px`);
    pointerReticle.style.setProperty('--ry', `${clientY}px`);
    pointerReticle.classList.add('active');
}
function hidePointerReticle() { pointerReticle?.classList.remove('active'); }

function resolvePointer() {
    pointerRaf = 0;
    if (!pendingPointer || graphicsDisposed) return;
    const { x, y } = pendingPointer;
    pendingPointer = null;
    mouseNDC.x = (x / innerWidth)  *  2 - 1;
    mouseNDC.y = (y / innerHeight) * -2 + 1;
    raycaster.setFromCamera(mouseNDC, camera);
    camera.getWorldDirection(tempDir).negate();
    groundPlane.setFromNormalAndCoplanarPoint(tempDir, orbit.target);
    if (raycaster.ray.intersectPlane(groundPlane, mouseWorldPos)) {
        isMouseActive = true;
        showPointerReticle(x, y);
        if (mouseTimeout) clearTimeout(mouseTimeout);
        mouseTimeout = setTimeout(() => {
            mouseTimeout = null;
            isMouseActive = false;
            hidePointerReticle();
        }, 900);
    }
}

// Pointer events can fire faster than the display refresh (high-polling-rate mice
// deliver 500-1000 moves/sec). Coalescing to one raycast + one style write per frame
// removes that entire class of redundant work.
function handlePointerOrTouch(clientX, clientY) {
    pendingPointer = { x: clientX, y: clientY };
    if (!pointerRaf) pointerRaf = requestAnimationFrame(resolvePointer);
}

function releasePointer() {
    isMouseActive = false;
    clearPointerTimeout();
    hidePointerReticle();
}

// Pointer Events already cover mouse, touch and pen. The previous code also bound
// touchstart/touchmove, so every finger drag ran the raycast twice per frame.
renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) handlePointerOrTouch(e.clientX, e.clientY);
}, { passive: true });
renderer.domElement.addEventListener('pointerdown', (e) => {
    handlePointerOrTouch(e.clientX, e.clientY);
}, { passive: true });
renderer.domElement.addEventListener('pointerleave', releasePointer, { passive: true });
renderer.domElement.addEventListener('pointercancel', releasePointer, { passive: true });
renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') releasePointer();
}, { passive: true });
renderer.domElement.addEventListener('dblclick', () => {
    targetCameraRadius = 140;
    orbit.target.set(0, 0, 0);
});

// ═══════════════════════════════════════════
// 6-7. GESTURE FUSION + TEMPORAL HYSTERESIS
// ═══════════════════════════════════════════
// The classifier (geometry + MediaPipe fusion) and the hysteresis state machine
// are pure modules under src/gesture/. This section only binds them to the DOM.
const OEF = OneEuroFilter;
const gbarEl = document.getElementById('gbar');

// Cache the last written bar width so we do not trigger a style recalc on every
// inference frame for an unchanged value.
let lastBarPct = -1;
function setGestureBar(value) {
    const pct = Math.round(clamp01(value) * 100);
    if (pct === lastBarPct) return;
    lastBarPct = pct;
    gbarEl.style.width = `${pct}%`;
}

const gestureMachine = createGestureStateMachine({ onBar: setGestureBar });
const updateGestureTemporal = gestureMachine.update;
const resetGestureTemporal = gestureMachine.reset;
const {
    GESTURE_ACTIVATE, GESTURE_SWITCH, GESTURE_HOLD,
    GESTURE_MARGIN, GESTURE_IDLE_MARGIN,
    GESTURE_CONFIRM_SEC, GESTURE_RELEASE_SEC
} = GESTURE_THRESHOLDS;

// ═══════════════════════════════════════════
// 8. MEDIAPIPE NEURAL LINK - direct video processing
// ═══════════════════════════════════════════
let cameraStream = null, videoFrameCallbackId = null, neuralBusy = false;
let neuralState = 'off';
let neuralBackend = 'none'; // 'main' | 'none'
let mainRecognizer = null, mainMediaPipeModule = null;
let neuralSession = 0;
let mainInferenceErrors = 0;
const handWorldPos  = new THREE.Vector3();
const tempDir       = new THREE.Vector3();
// Reused every frame by the attractor cross-fade; allocating a Vector3 per frame
// would hand the GC ~60 objects/second for no reason.
const attractorTarget = new THREE.Vector3();
const handNDC       = new THREE.Vector2();
let handInfl = 0.0;
let wantAutoRotate = !reducedMotionQuery.matches;
let targetCameraRadius = 140;
let isZoomingActive = false;

const vidEl        = document.getElementById('webcam');
const ocEl         = document.getElementById('oc');
const octx         = ocEl.getContext('2d', { alpha: true, desynchronized: true });
const statusEl     = document.getElementById('nstatus');
const gnameEl      = document.getElementById('gname');
const ringEl       = document.getElementById('gesture-ring');
const cameraBtn    = document.getElementById('camera-toggle');
const backendBadge = document.getElementById('backend-badge');
let prevConfG      = null;
let lastInference  = 0;
let lastMediaPipeTime = 0;
let lastGestureTickMs = 0;

const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[17,0]
];

// #nstatus is role="status" aria-live="polite" and #gname is aria-live="polite".
// Both used to be rewritten on every inference frame (up to 26 Hz), which produced
// a continuous, unusable stream of screen-reader announcements. Writing only on an
// actual change also removes a per-frame style recalc.
let lastStatusText = null, lastStatusColor = null;
function setNeuralStatus(text, color = 'var(--text-2)') {
    if (text !== lastStatusText) {
        lastStatusText = text;
        statusEl.textContent = text;
    }
    if (color !== lastStatusColor) {
        lastStatusColor = color;
        statusEl.style.color = color;
    }
}

let lastGestureName = null;
function setGestureName(text) {
    if (text === lastGestureName) return;
    lastGestureName = text;
    gnameEl.textContent = text;
}
function setBackendBadge(text) { backendBadge.textContent = `· ${text}`; }
function pulseRing() {
    if (reducedMotionQuery.matches) return;
    ringEl.classList.remove('active');
    void ringEl.offsetWidth;
    ringEl.classList.add('active');
}
function resizeOverlayCanvas() {
    const w = Math.max(1, vidEl.videoWidth || 320);
    const h = Math.max(1, vidEl.videoHeight || 240);
    if (ocEl.width !== w || ocEl.height !== h) { ocEl.width = w; ocEl.height = h; }
}
function drawHand(lm) {
    resizeOverlayCanvas();
    // getContext('2d') can return null if the 2D context is unavailable; skip the
    // overlay draw rather than throwing out of the inference loop.
    if (!octx) return;
    octx.clearRect(0, 0, ocEl.width, ocEl.height);
    if (!lm?.length) return;
    const w = ocEl.width, h = ocEl.height;
    octx.save();
    octx.lineCap = 'round';
    octx.lineJoin = 'round';

    // Batch every bone into one path instead of issuing 21 separate stroke calls.
    octx.strokeStyle = 'rgba(143,203,184,.46)';
    octx.lineWidth = Math.max(1.2, Math.min(w, h) * 0.006);
    octx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
        const p = lm[a], q = lm[b];
        if (!p || !q) continue;
        octx.moveTo(p.x * w, p.y * h);
        octx.lineTo(q.x * w, q.y * h);
    }
    octx.stroke();

    // Same for the 21 joints: one filled path, one stroked path.
    const r = Math.max(1.7, Math.min(w, h) * 0.009);
    octx.beginPath();
    for (const p of lm) {
        if (!p) continue;
        const cx = p.x * w, cy = p.y * h;
        octx.moveTo(cx + r, cy);
        octx.arc(cx, cy, r, 0, Math.PI * 2);
    }
    octx.fillStyle = 'rgba(143,203,184,.30)';
    octx.fill();
    octx.lineWidth = Math.max(0.8, r * 0.38);
    octx.strokeStyle = 'rgba(237,241,238,.90)';
    octx.stroke();
    octx.restore();
}

const oefPointX = new OEF(30, 1.15, 0.055);
const oefPointY = new OEF(30, 1.15, 0.055);
const oefPalmScale = new OEF(30, 0.75, 0.022);
const oefVictoryX = new OEF(30, 1.0, 0.045);

// Aspect ratio of the frames MediaPipe is actually analysing. Updated once the
// video reports real dimensions; used to keep hand->NDC mapping isotropic.
let gestureFrameAspect = 4 / 3;

// Open_Palm zoom calibration window, expressed in the units produced by
// geometryGestureScores().handScale.
const PALM_NEAR_MIN = 0.10;
const PALM_NEAR_MAX = 0.38;

function resetGestureDynamics() {
    oefPointX.reset(); oefPointY.reset(); oefPalmScale.reset(); oefVictoryX.reset();
}

/**
 * Map normalized landmark space to camera NDC.
 *
 * Landmarks are normalized against the camera frame's aspect ratio, but the
 * raycast happens through a camera using the *window's* aspect. Feeding [0,1]
 * straight through to [-1,1] stretched hand motion non-uniformly (horizontal
 * travel felt compressed on a widescreen display). We letterbox the landmark
 * space into the viewport so a given physical hand movement produces the same
 * angular movement on both axes, and expand the usable range slightly so the
 * user can reach the edges of the field without moving out of frame.
 */
const HAND_REACH = 1.22;
function handToNDC(nx, ny, out, viewAspectOverride) {
    const camAspect = gestureFrameAspect;
    const viewAspect = viewAspectOverride || camera.aspect;
    let x = (nx * 2 - 1) * HAND_REACH;
    let y = (1 - ny * 2) * HAND_REACH;
    // A perspective camera already widens its horizontal field of view by the
    // viewport aspect, so matching NDC deltas would NOT be isotropic. Dividing the
    // x offset by the aspect ratio makes equal fractional hand travel produce equal
    // world-space travel on both axes.
    if (viewAspect > camAspect && camAspect > 1e-6) {
        x *= camAspect / viewAspect;
    } else if (camAspect > 1e-6) {
        y *= viewAspect / camAspect;
    }
    out.set(clamp(x, -1, 1), clamp(y, -1, 1));
}

function applyGesture(g, lm, ts, handScale, dt) {
    if (!lm || !lm.length) return;
    const t = ts * 0.001;
    if (g === 'Pointing_Up') {
        if (!lm[8]) return;
        wantAutoRotate = false;
        isZoomingActive = false;
        // Mirror x to match the mirrored preview (#webcam / #oc use scaleX(-1)).
        const filteredX = oefPointX.filter(1.0 - lm[8].x, t);
        const filteredY = oefPointY.filter(lm[8].y, t);
        handToNDC(filteredX, filteredY, handNDC);
        raycaster.setFromCamera(handNDC, camera);
        camera.getWorldDirection(tempDir).negate();
        groundPlane.setFromNormalAndCoplanarPoint(tempDir, orbit.target);
        if (raycaster.ray.intersectPlane(groundPlane, handWorldPos)) {
            handInfl = approach(handInfl, 1.0, 0.34, dt);
        } else {
            handWorldPos.set(handNDC.x, handNDC.y, 0.5).unproject(camera);
            handInfl = approach(handInfl, 1.0, 0.34, dt);
        }
        return;
    }

    handInfl = approach(handInfl, 0, 0.14, dt);
    if (g === 'Open_Palm') {
        wantAutoRotate = !reducedMotionQuery.matches;
        isZoomingActive = true;
        const filteredScale = oefPalmScale.filter(handScale, t);
        const proximity = smooth01(PALM_NEAR_MIN, PALM_NEAR_MAX, filteredScale);
        targetCameraRadius = THREE.MathUtils.lerp(255, 38, proximity);
    } else if (g === 'Victory') {
        if (!lm[8] || !lm[12] || !lm[0]) return;
        wantAutoRotate = !reducedMotionQuery.matches;
        isZoomingActive = false;
        // Track the V's midpoint but anchor it to the wrist so that rotating the
        // hand in place does not read as horizontal travel.
        const centerX = 1.0 - (lm[8].x + lm[12].x + lm[0].x) / 3;
        const fx = oefVictoryX.filter(centerX, t);
        const targetChaos = THREE.MathUtils.lerp(0.0, 2.0, clamp01(fx));
        setSlider('chaos', approach(uiV.chaos, targetChaos, 0.25, dt));
    } else {
        isZoomingActive = false;
    }
}

// Single-pass bounds check. The previous implementation built two arrays and spread
// them into Math.min/Math.max four times, every frame.
function handFramingHint(lm, handScale) {
    if (!lm?.length) return null;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const p of lm) {
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (minX < 0.015 || maxX > 0.985 || minY < 0.015 || maxY > 0.985) return 'Center the full hand';
    if (handScale < PALM_NEAR_MIN * 0.55) return 'Move hand closer';
    return null;
}

// Zero-allocation scratch object for the "no hand visible" temporal update.
const ZERO_SCORES_MUT = { Pointing_Up: 0, Open_Palm: 0, Victory: 0 };

function handleGestureResult(res, inferenceMs, mpTs) {
    if (neuralState !== 'on') return;
    if (inferenceMs > 48) adaptiveQualityHint('inference-slow');

    const nowMs = performance.now();
    // Real elapsed time between inference frames, used for all easing so that
    // gesture response is identical at 12 Hz and 26 Hz inference.
    const dt = lastGestureTickMs > 0 ? clamp((nowMs - lastGestureTickMs) / 1000, 1 / 120, 0.5) : 1 / 30;
    lastGestureTickMs = nowMs;

    if (res?.landmarks?.length) {
        const lm = res.landmarks[0];
        const world = res.worldLandmarks?.[0];
        drawHand(lm);

        const geom = geometryGestureScores(lm, world);
        const ml = mediaPipeGestureScores(res.gestures?.[0]);
        const scores = fuseGestureScores(geom, ml, geom.quality);
        const temporal = updateGestureTemporal(scores, nowMs);
        const conf = temporal.gesture;

        if (conf) {
            const label = GESTURE_LABELS[conf] || conf.replace(/_/g, ' ').toUpperCase();
            // Reset the smoothing filters BEFORE the first apply of a new gesture.
            // Previously apply ran once with the previous gesture's filter state
            // (emitting one frame of garbage), then reset, then applied a second
            // time with the same timestamp -- double-applying every non-idempotent
            // easing step on each transition.
            if (conf !== prevConfG) {
                resetGestureDynamics();
                pulseRing();
            }
            applyGesture(conf, lm, mpTs, geom.handScale, dt);
            setGestureName(label);
            setNeuralStatus(label, 'var(--accent)');
        } else {
            const pct = Math.round(temporal.bestScore * 100);
            setGestureName(temporal.bestScore > 0.42
                ? `${GESTURE_LABELS[temporal.bestName] || temporal.bestName} ${pct}%`
                : 'HAND DETECTED');
            const framing = handFramingHint(lm, geom.handScale);
            setNeuralStatus(framing || 'Tracking hand', framing ? 'var(--warning)' : 'var(--accent)');
            wantAutoRotate = !reducedMotionQuery.matches;
            isZoomingActive = false;
            handInfl = approach(handInfl, 0, 0.10, dt);
        }
        prevConfG = conf;
    } else {
        updateGestureTemporal(ZERO_SCORES_MUT, nowMs);
        drawHand(null);
        setGestureName('NO HAND');
        setNeuralStatus('Waiting for a hand', 'var(--warning)');
        resetGestureDynamics();
        handInfl = approach(handInfl, 0, 0.18, dt);
        if (handInfl < 0.002) handInfl = 0;
        isZoomingActive = false;
        wantAutoRotate = !reducedMotionQuery.matches;
        prevConfG = null;
    }
}

async function loadMainMediaPipeModule() {
    if (mainMediaPipeModule) return mainMediaPipeModule;
    let lastError = null;
    for (const url of MP_BUNDLES) {
        try {
            mainMediaPipeModule = await withNetworkTimeout(import(url), 'MediaPipe module', 10000);
            return mainMediaPipeModule;
        } catch (error) { lastError = error; }
    }
    throw lastError || new Error('MediaPipe module unavailable');
}

async function resolveMainVisionFileset(FilesetResolver) {
    let lastError = null;
    for (const root of MP_WASM_ROOTS) {
        try { return await withNetworkTimeout(FilesetResolver.forVisionTasks(root), 'MediaPipe WASM runtime', 12000); }
        catch (error) { lastError = error; }
    }
    throw lastError || new Error('MediaPipe WASM runtime unavailable');
}

// The .task model ships as a TFLite flatbuffer (4-byte size prefix + "TFL3" at
// offset 4) OR, for the newer model zoo bundles, as a nested ZIP archive (outer
// bundle -> inner .task files -> .tflite members) that the MediaPipe WASM runtime
// inflates itself. Both are legitimate, so the poison check accepts either
// signature. This catches the single worst failure mode of the cache layer: a
// captive portal or CDN error page returned with HTTP 200, cached permanently,
// and then handed to MediaPipe as "model bytes" forever after.
const MP_MODEL_MIN_BYTES = 1 << 20; // the float16 recognizer bundle is ~8 MB
function looksLikeTfliteModel(bytes) {
    if (!bytes || bytes.byteLength < MP_MODEL_MIN_BYTES) return false;
    // "TFL3" flatbuffer at offset 4
    if (bytes[4] === 0x54 && bytes[5] === 0x46 && bytes[6] === 0x4C && bytes[7] === 0x33) return true;
    // ZIP local-file header "PK\x03\x04" (offset 0 in a plain archive; this
    // bundle variant carries a 2-byte prefix before the signature)
    for (let i = 0; i <= 2; i++) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) return true;
    }
    return false;
}

async function fetchCachedModelBytes() {
    let cache = null;
    try {
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys
                .filter(k => k.startsWith('quantum-singularity-mediapipe-') && k !== MP_MODEL_CACHE)
                .map(k => caches.delete(k)));
            cache = await caches.open(MP_MODEL_CACHE);
            const cached = await cache.match(MP_MODEL);
            if (cached) {
                setNeuralStatus('Loading cached gesture model', 'var(--warning)');
                const bytes = new Uint8Array(await cached.arrayBuffer());
                if (looksLikeTfliteModel(bytes)) return bytes;
                // Poisoned entry: evict and fall through to a fresh download.
                console.warn('[NeuralLink] cached gesture model failed validation, refetching');
                try { await cache.delete(MP_MODEL); } catch (_) {}
            }
        }
    } catch (_) { cache = null; }

    setNeuralStatus('Downloading gesture model once', 'var(--warning)');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, NETWORK_TIMEOUT_MS);
    try {
        const response = await fetch(MP_MODEL, { cache: 'default', mode: 'cors', signal: controller.signal });
        if (!response.ok) throw new Error(`Gesture model download failed: HTTP ${response.status}`);
        // Read the body to completion first, then write to CacheStorage from the
        // buffer. Cloning the Response and draining both branches concurrently
        // forces the browser to buffer the whole ~8 MB body and serialises the
        // cache write ahead of the bytes we actually need.
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!looksLikeTfliteModel(bytes)) {
            throw new Error('Gesture model response was not a valid TFLite model');
        }
        if (cache) {
            try {
                await cache.put(MP_MODEL, new Response(bytes, {
                    headers: { 'Content-Type': 'application/octet-stream' }
                }));
            } catch (_) {}
        }
        return bytes;
    } catch (error) {
        if (timedOut) {
            const timeoutError = new Error('Gesture model network request timed out');
            timeoutError.name = 'TimeoutError';
            throw timeoutError;
        }
        throw error;
    } finally { clearTimeout(timer); }
}

async function initializeMainThreadBackend() {
    const { GestureRecognizer, FilesetResolver } = await loadMainMediaPipeModule();
    const vision = await resolveMainVisionFileset(FilesetResolver);
    const model = await fetchCachedModelBytes();
    const common = {
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.50,
        minHandPresenceConfidence: 0.50,
        minTrackingConfidence: 0.50,
        cannedGesturesClassifierOptions: { maxResults: -1, scoreThreshold: 0 }
    };
    // MediaPipe may take ownership of (and detach) the buffer it is handed, so each
    // delegate attempt gets its own copy. Reusing one array meant the CPU fallback
    // could receive a detached buffer and fail on exactly the machines that need it.
    // A software renderer skips the GPU delegate (see visionDelegates).
    let lastError = null;
    for (const delegate of qualityProfile.visionDelegates) {
        try {
            mainRecognizer = await GestureRecognizer.createFromOptions(vision, {
                ...common, baseOptions: { modelAssetBuffer: model.slice(), delegate }
            });
            setBackendBadge(`on-device · ${delegate}`);
            break;
        } catch (error) {
            lastError = error;
            console.warn(`[NeuralLink] ${delegate} delegate unavailable`, error);
            try { mainRecognizer?.close?.(); } catch (_) {}
            mainRecognizer = null;
        }
    }
    if (!mainRecognizer) throw lastError;
    neuralBackend = 'main';
    mainInferenceErrors = 0;
    currentInferenceFPS = Math.min(baselineInferenceFPS, isMobile ? 12 : 15);
}

async function initializeGestureBackend() {
    setNeuralStatus('Loading gesture engine', 'var(--warning)');
    await initializeMainThreadBackend();
}

function disposeGestureBackend() {
    try { mainRecognizer?.close?.(); } catch (_) {}
    mainRecognizer = null;
    neuralBackend = 'none';
    setBackendBadge('camera off');
}

/**
 * Produce a strictly increasing timestamp for recognizeForVideo().
 *
 * MediaPipe requires monotonic timestamps. `metadata.mediaTime` is seconds since
 * the start of the track while `performance.now()` is milliseconds since page load,
 * so mixing them (which happened whenever the rAF fallback ran, or a stream
 * restarted and mediaTime reset toward zero) permanently pinned the clock to
 * +0.01ms steps and silently destroyed MediaPipe's internal tracking heuristics.
 *
 * We therefore rebase mediaTime onto the performance clock and stay on one timeline.
 */
let mediaTimeOrigin = null;
function nextMediaPipeTimestamp(metadata) {
    let ts;
    if (Number.isFinite(metadata?.mediaTime)) {
        const raw = metadata.mediaTime * 1000;
        if (mediaTimeOrigin === null || raw < mediaTimeOrigin.raw) {
            mediaTimeOrigin = { raw, base: Math.max(lastMediaPipeTime, performance.now()) };
        }
        ts = mediaTimeOrigin.base + (raw - mediaTimeOrigin.raw);
    } else {
        ts = performance.now();
    }
    if (!(ts > lastMediaPipeTime)) ts = lastMediaPipeTime + 1;
    lastMediaPipeTime = ts;
    return ts;
}

// recognizeForVideo() is a synchronous blocking WASM call, so this function has no
// await points and needs no re-entrancy guard; the previous `frameCaptureBusy` flag
// could never actually be observed as true and was dead weight.
function submitGestureFrame(callbackNow, metadata) {
    if (neuralState !== 'on' || document.hidden || vidEl.readyState < 2) return;
    if (callbackNow - lastInference < 1000 / Math.max(1, currentInferenceFPS)) return;
    lastInference = callbackNow;

    if (!mainRecognizer) return;

    // Keep the landmark->NDC mapping isotropic even if the camera renegotiates
    // its resolution mid-session.
    if (vidEl.videoWidth > 0 && vidEl.videoHeight > 0) {
        gestureFrameAspect = vidEl.videoWidth / vidEl.videoHeight;
    }

    const mpTs = nextMediaPipeTimestamp(metadata);
    const started = performance.now();
    try {
        const result = mainRecognizer.recognizeForVideo(vidEl, mpTs);
        mainInferenceErrors = 0;
        handleGestureResult(result, performance.now() - started, mpTs);
    } catch (error) {
        mainInferenceErrors++;
        console.warn('[NeuralLink] gesture inference error', error);
        setNeuralStatus(
            mainInferenceErrors >= 3 ? 'Gesture engine error. Toggle camera to retry.' : 'Recovering gesture inference',
            'var(--danger)'
        );
    }
}

// Tracks which scheduling API owns `videoFrameCallbackId`. Previously the canceller
// chose its API by feature-detecting cancelVideoFrameCallback rather than by which
// API actually scheduled the callback -- correct only by coincidence.
let usingVideoFrameCallback = false;

function scheduleVideoInference() {
    if (neuralState !== 'on' || document.hidden || videoFrameCallbackId != null) return;
    if (typeof vidEl.requestVideoFrameCallback === 'function') {
        usingVideoFrameCallback = true;
        videoFrameCallbackId = vidEl.requestVideoFrameCallback((now, metadata) => {
            videoFrameCallbackId = null;
            submitGestureFrame(now, metadata);
            scheduleVideoInference();
        });
    } else {
        usingVideoFrameCallback = false;
        videoFrameCallbackId = requestAnimationFrame((now) => {
            videoFrameCallbackId = null;
            submitGestureFrame(now, null);
            scheduleVideoInference();
        });
    }
}

function cancelVideoInference() {
    if (videoFrameCallbackId == null) return;
    // Cancel via the API that actually scheduled the callback, not via feature
    // detection -- the two only happened to agree because rVFC and its canceller
    // always ship together.
    if (usingVideoFrameCallback) vidEl.cancelVideoFrameCallback?.(videoFrameCallbackId);
    else cancelAnimationFrame(videoFrameCallbackId);
    videoFrameCallbackId = null;
}

async function enableNeuralLink() {
    if (neuralBusy || neuralState === 'on' || neuralState === 'starting') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setNeuralStatus('Camera requires HTTPS or localhost', 'var(--danger)');
        return;
    }

    neuralBusy = true;
    neuralState = 'starting';
    cameraBtn.disabled = true;
    cameraBtn.textContent = 'Starting camera…';
    const session = ++neuralSession;
    try {
        // Ask for camera permission first. This prevents downloading the ML stack
        // when the visitor chooses not to grant camera access.
        setNeuralStatus('Requesting camera permission', 'var(--warning)');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                facingMode: 'user',
                width: { ideal: isMobile ? 480 : 640 },
                height: { ideal: isMobile ? 360 : 480 },
                frameRate: { ideal: 30, max: 30 }
            }
        });
        // Use a local `stream` and only publish it after the session check: the old
        // code wrote straight to the module-level `cameraStream`, so a stale session
        // stopping "its" tracks clobbered the reference a newer session had already
        // started using.
        if (session !== neuralSession) { stream.getTracks().forEach(t => t.stop()); return; }
        cameraStream = stream;

        for (const track of cameraStream.getVideoTracks()) {
            track.addEventListener('ended', () => {
                if (neuralState !== 'off') {
                    stopCameraTracks({ disposeBackend: true });
                    setNeuralStatus('Camera ended. Mouse and touch ready.');
                }
            }, { once: true });
        }

        vidEl.srcObject = cameraStream;
        await vidEl.play();
        resizeOverlayCanvas();
        setNeuralStatus('Camera ready · loading gesture engine', 'var(--warning)');

        // Heavy MediaPipe/WASM/model loading begins only after permission succeeds.
        await initializeGestureBackend();
        if (session !== neuralSession) {
            disposeGestureBackend();
            return;
        }

        neuralState = 'on';
        cameraBtn.textContent = 'Disable camera';
        cameraBtn.classList.add('is-on');
        cameraBtn.setAttribute('aria-pressed', 'true');
        resetGestureTemporal();
        resetGestureDynamics();
        lastInference = 0;
        lastMediaPipeTime = 0;
        mediaTimeOrigin = null;
        lastGestureTickMs = 0;
        setNeuralStatus('Hand tracking active', 'var(--accent)');
        scheduleVideoInference();
    } catch (error) {
        console.warn('[NeuralLink]', error);
        const name = error?.name || '';
        let message = 'Camera or gesture engine unavailable. Mouse and touch ready.';
        if (!window.isSecureContext) message = 'Camera requires HTTPS or localhost.';
        else if (name === 'NotAllowedError' || name === 'SecurityError') message = 'Camera permission denied. Mouse and touch ready.';
        else if (name === 'NotFoundError') message = 'No camera was found. Mouse and touch ready.';
        else if (name === 'NotReadableError') message = 'Camera is busy in another app or tab.';
        else if (name === 'OverconstrainedError') message = 'Camera constraints are unsupported on this device.';
        else if (name === 'AbortError') message = 'Camera start was interrupted. Try again.';
        else if (name === 'TimeoutError') message = 'Gesture model network request timed out. Try again.';
        setNeuralStatus(message, 'var(--danger)');
        stopCameraTracks({ disposeBackend: true });
    } finally {
        neuralBusy = false;
        cameraBtn.disabled = false;
        if (neuralState !== 'on') cameraBtn.textContent = 'Enable camera';
    }
}

function stopCameraTracks({ disposeBackend = true } = {}) {
    ++neuralSession;
    cancelVideoInference();
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    try { vidEl.pause(); } catch (_) {}
    vidEl.srcObject = null;
    neuralState = 'off';
    cameraBtn.textContent = 'Enable camera';
    cameraBtn.classList.remove('is-on');
    cameraBtn.setAttribute('aria-pressed', 'false');
    setGestureName('No gesture');
    setBackendBadge('camera off');
    drawHand(null);
    resetGestureTemporal();
    handInfl = 0;
    isZoomingActive = false;
    wantAutoRotate = !reducedMotionQuery.matches;
    resetGestureDynamics();
    // Reset every piece of gesture state so a re-enable starts clean. The
    // inference-rate ratchet in particular used to be one-way: it could only ever
    // be lowered, so toggling the camera repeatedly degraded tracking permanently.
    mainInferenceErrors = 0;
    prevConfG = null;
    lastGestureTickMs = 0;
    lastMediaPipeTime = 0;
    mediaTimeOrigin = null;
    lastInference = 0;
    currentInferenceFPS = baselineInferenceFPS;
    if (disposeBackend) disposeGestureBackend();
}

function disableNeuralLink() {
    stopCameraTracks({ disposeBackend: true });
    setNeuralStatus('Camera off. Mouse and touch ready.');
}

cameraBtn.addEventListener('click', () => {
    dismissIntro();
    if (neuralState === 'on') disableNeuralLink();
    else void enableNeuralLink();
});

window.addEventListener('offline', () => {
    if (neuralState === 'starting') setNeuralStatus('Offline. Camera preview can run, but the gesture model may need network access.', 'var(--warning)');
});
window.addEventListener('online', () => {
    if (neuralState === 'off') setNeuralStatus('Camera off. Mouse and touch ready.');
});

// ═══════════════════════════════════════════
// 8B. WEB AUDIO REACTIVITY - third input modality
// ═══════════════════════════════════════════
// Mirrors the camera pipeline's lifecycle (session counter guarding against a
// stale enable/disable race, explicit permission gate, named-error messaging)
// but drives GPU uniforms instead of gesture state: bass swells the field,
// treble sharpens curl turbulence, and an onset detector fires a decaying
// "pulse" impulse on transients, so the particle field visibly breathes with
// whatever is playing in the room.
const audioBtn = document.getElementById('audio-toggle');
const audioStatusEl = document.getElementById('astatus');
const abarEl = document.getElementById('abar');

let audioCtx = null, audioStream = null, audioAnalyser = null, audioBusy = false;
let audioState = 'off';
let audioSession = 0;
let audioFreqData = null;
// Four-band bin boundaries (computed once at stream open, fixed for the lifetime
// of an AudioContext with a given fftSize and sampleRate).
let audioSubBassBinEnd = 0, audioMidBassBinEnd = 0, audioMidBinEnd = 0, audioTrebleBinEnd = 0;
// Per-frame smoothed outputs for each band.
let audioBassSmooth = 0, audioMidBassSmooth = 0, audioMidSmooth = 0, audioTrebleSmooth = 0;
let audioPulse = 0, audioBassAvg = 0;
let audioPulseCooldownUntil = 0;
// Reused output objects for the pure helpers below, so the hot per-frame path
// (updateAudioReactivity, called from animate()) allocates nothing -- the same
// out-parameter idiom handToNDC() uses for the gesture raycast.
const audioBandsOut = { bassRaw: 0, subBassRaw: 0, midBassRaw: 0, midRaw: 0, trebleRaw: 0 };
const audioOnsetOut = { bassAvg: 0, pulse: 0, cooldownUntil: 0 };

// Band splitting and onset detection are pure maths in src/audio/dsp.js.

function setAudioStatus(text, color = 'var(--text-3)') {
    audioStatusEl.textContent = text;
    audioStatusEl.style.color = color;
}

function disposeAudioBackend() {
    try { audioAnalyser?.disconnect(); } catch (_) {}
    audioAnalyser = null;
    audioFreqData = null;
    if (audioCtx) {
        const ctx = audioCtx;
        audioCtx = null;
        void ctx.close().catch(() => {});
    }
}

function stopAudioTracks() {
    ++audioSession;
    audioStream?.getTracks().forEach(track => track.stop());
    audioStream = null;
    disposeAudioBackend();
    audioState = 'off';
    audioBtn.textContent = 'Enable microphone';
    audioBtn.classList.remove('is-on');
    audioBtn.setAttribute('aria-pressed', 'false');
    audioBassSmooth = 0; audioMidBassSmooth = 0; audioMidSmooth = 0;
    audioTrebleSmooth = 0; audioPulse = 0; audioBassAvg = 0;
    setAudioBar(0);
}

function disableAudioReactivity() {
    stopAudioTracks();
    setAudioStatus('Sound off. Field responds to touch and vision only.');
}

async function enableAudioReactivity() {
    if (audioBusy || audioState === 'on' || audioState === 'starting') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setAudioStatus('Microphone requires HTTPS or localhost', 'var(--danger)');
        return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
        setAudioStatus('Web Audio is unsupported in this browser', 'var(--danger)');
        return;
    }

    audioBusy = true;
    audioState = 'starting';
    audioBtn.disabled = true;
    audioBtn.textContent = 'Starting microphone…';
    const session = ++audioSession;
    try {
        setAudioStatus('Requesting microphone permission', 'var(--warning)');
        const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        // Everything below is built into locals and only published to module state
        // in one step after the final session check. Writing `audioCtx` before the
        // `await ctx.resume()` would mean a superseded session's cleanup could close
        // the AudioContext a *newer* session had already started using -- the same
        // stale-reference class of bug the camera pipeline guards against.
        if (session !== audioSession) { stream.getTracks().forEach(t => t.stop()); return; }

        const ctx = new Ctx();
        const abandon = () => {
            stream.getTracks().forEach(t => t.stop());
            void ctx.close().catch(() => {});
        };
        if (ctx.state === 'suspended') await ctx.resume();
        if (session !== audioSession) { abandon(); return; }

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        // Smoothing is done in updateAudioReactivity() with a frame-rate independent
        // approach(), matching the gesture EMA -- so this is left raw per-frame.
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        const freqData = new Uint8Array(analyser.frequencyBinCount);

        // Bin index <-> Hz is fixed for the lifetime of this analyser (fftSize and
        // sampleRate do not change), so the band boundaries are computed once here
        // rather than every frame.
        const bins = computeAudioBandBins(ctx.sampleRate, analyser.fftSize, freqData.length);

        if (session !== audioSession) { abandon(); return; }

        // Publish.
        audioStream = stream;
        audioCtx = ctx;
        audioAnalyser = analyser;
        audioFreqData = freqData;
        audioSubBassBinEnd = bins.subBassBinEnd;
        audioMidBassBinEnd = bins.midBassBinEnd;
        audioMidBinEnd     = bins.midBinEnd;
        audioTrebleBinEnd  = bins.trebleBinEnd;

        for (const track of audioStream.getAudioTracks()) {
            track.addEventListener('ended', () => {
                if (audioState !== 'off') {
                    stopAudioTracks();
                    setAudioStatus('Microphone ended. Field responds to touch and vision only.');
                }
            }, { once: true });
        }

        audioState = 'on';
        audioBtn.textContent = 'Disable microphone';
        audioBtn.classList.add('is-on');
        audioBtn.setAttribute('aria-pressed', 'true');
        setAudioStatus('Listening · 4 bands drive the field', 'var(--accent)');
    } catch (error) {
        console.warn('[AudioReactivity]', error);
        // A superseded session must not report its failure over a newer session's
        // state, nor tear down the device that newer session just acquired.
        if (session !== audioSession) return;
        const name = error?.name || '';
        let message = 'Microphone unavailable. Field responds to touch and vision only.';
        if (!window.isSecureContext) message = 'Microphone requires HTTPS or localhost.';
        else if (name === 'NotAllowedError' || name === 'SecurityError') message = 'Microphone permission denied.';
        else if (name === 'NotFoundError') message = 'No microphone was found.';
        else if (name === 'NotReadableError') message = 'Microphone is busy in another app or tab.';
        setAudioStatus(message, 'var(--danger)');
        stopAudioTracks();
    } finally {
        audioBusy = false;
        audioBtn.disabled = false;
        if (audioState !== 'on') audioBtn.textContent = 'Enable microphone';
    }
}

// Zero-GC per-frame update: getByteFrequencyData() fills the pre-allocated
// audioFreqData array in place, and the band sums are plain loops over it.
function updateAudioReactivity(dt) {
    if (audioState !== 'on' || !audioAnalyser) {
        // Decay all bands toward zero so the GPU uniforms tail off after the mic
        // is disabled rather than snapping to black.
        audioBassSmooth    = approach(audioBassSmooth,    0, 0.08, dt);
        audioMidBassSmooth = approach(audioMidBassSmooth, 0, 0.08, dt);
        audioMidSmooth     = approach(audioMidSmooth,     0, 0.08, dt);
        audioTrebleSmooth  = approach(audioTrebleSmooth,  0, 0.08, dt);
        audioPulse         = approach(audioPulse,         0, 0.3,  dt);
        return;
    }
    audioAnalyser.getByteFrequencyData(audioFreqData);
    computeAudioBands(audioFreqData, audioSubBassBinEnd, audioMidBassBinEnd, audioMidBinEnd, audioTrebleBinEnd, audioBandsOut);
    const { bassRaw, midBassRaw, midRaw, trebleRaw } = audioBandsOut;

    // Asymmetric attack/release envelope per band. Low bands get a faster attack
    // so kick drums feel immediate; treble gets a slower release for shimmer.
    audioBassSmooth    = approach(audioBassSmooth,    bassRaw,    bassRaw    > audioBassSmooth    ? 0.55 : 0.10, dt);
    audioMidBassSmooth = approach(audioMidBassSmooth, midBassRaw, midBassRaw > audioMidBassSmooth ? 0.45 : 0.11, dt);
    audioMidSmooth     = approach(audioMidSmooth,     midRaw,     midRaw     > audioMidSmooth     ? 0.40 : 0.10, dt);
    audioTrebleSmooth  = approach(audioTrebleSmooth,  trebleRaw,  trebleRaw  > audioTrebleSmooth  ? 0.38 : 0.09, dt);

    detectAudioOnset(bassRaw, audioBassAvg, audioPulse, audioPulseCooldownUntil, performance.now(), dt, audioOnsetOut);
    audioBassAvg = audioOnsetOut.bassAvg;
    audioPulse = audioOnsetOut.pulse;
    audioPulseCooldownUntil = audioOnsetOut.cooldownUntil;

    // Level meter: blend all four bands for a responsive, full-spectrum indicator.
    // Written only when the rounded percentage changes: this runs every frame, and an
    // unconditional style write forces a style recalc at display refresh rate.
    setAudioBar(audioBassSmooth * 0.35 + audioMidBassSmooth * 0.25 + audioMidSmooth * 0.20 + audioTrebleSmooth * 0.20);
}

let lastAudioBarPct = -1;
function setAudioBar(level) {
    const pct = Math.round(clamp01(level) * 100);
    if (pct === lastAudioBarPct || !abarEl) return;
    lastAudioBarPct = pct;
    abarEl.style.width = `${pct}%`;
}

audioBtn.addEventListener('click', () => audioState === 'on' ? disableAudioReactivity() : void enableAudioReactivity());

// ═══════════════════════════════════════════
// 9. PRESENTATION + KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
const focusBtn = document.getElementById('focus-btn');
const focusExitBtn = document.getElementById('focus-exit');
let focusMode = false;

function setFocusMode(next) {
    const value = Boolean(next);
    if (value === focusMode) return;
    // Entering focus mode hides #bottom-hud, which may currently hold focus; without
    // an explicit move, focus silently falls back to <body> and keyboard position is
    // lost. Hand it to the exit affordance (and back again on the way out).
    const hadFocusInChrome = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body;
    focusMode = value;
    document.body.classList.toggle('focus-mode', focusMode);
    focusBtn?.setAttribute('aria-pressed', String(focusMode));
    focusExitBtn?.setAttribute('aria-pressed', String(focusMode));
    if (focusMode && isGuideOpen) closeGuide();
    if (!hadFocusInChrome) return;
    if (focusMode) focusExitBtn?.focus();
    else focusBtn?.focus();
}
focusBtn?.addEventListener('click', () => setFocusMode(!focusMode));
focusExitBtn?.addEventListener('click', () => setFocusMode(false));

let userPaused = false;
let contextPaused = false;

function setPaused(next) {
    const value = Boolean(next);
    if (value === userPaused) return;
    userPaused = value;
    resetPerformanceClocks();
    fpsEl.textContent = userPaused ? 'FPS: PAUSED' : 'FPS: --';
    document.body.classList.toggle('is-paused', userPaused);
}

window.addEventListener('keydown', (e) => {
    // Never hijack browser or OS shortcuts. Without this guard Ctrl+R silently
    // reset every slider, Cmd+F toggled focus mode, and Ctrl+H opened the guide.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Holding a key must not flip state dozens of times per second.
    if (e.repeat) return;

    const target = e.target;
    const isTextEntry = target instanceof HTMLElement && (
        target.matches('input:not([type=button]):not([type=checkbox]), select, textarea, [contenteditable="true"]')
    );
    if (isTextEntry && e.key !== 'Escape') return;

    // Space and Enter are the native activation keys for a focused control; let the
    // browser handle them there. Every other shortcut stays available even when a
    // button holds focus -- previously clicking any button disabled the entire
    // shortcut set until the user clicked elsewhere.
    const key = e.key.toLowerCase();
    const onButton = target instanceof HTMLElement && target.matches('button, [role=button]');
    if (onButton && (key === ' ' || key === 'enter')) return;

    switch (key) {
        case 'h':      isGuideOpen ? closeGuide() : openGuide(); e.preventDefault(); break;
        case 'b':      isEngOpen ? closeEng() : openEng(); e.preventDefault(); break;
        case 'r':      resetSliders(); e.preventDefault(); break;
        case 'f':      setFocusMode(!focusMode); e.preventDefault(); break;
        case 'p':      setStatsMode(!statsMode); e.preventDefault(); break;
        case '1':      morphShapeTo(0); e.preventDefault(); break;
        case '2':      morphShapeTo(1); e.preventDefault(); break;
        case '3':      morphShapeTo(2); e.preventDefault(); break;
        case '4':      morphShapeTo(3); e.preventDefault(); break;
        case '5':      morphShapeTo(4); e.preventDefault(); break;
        case '6':      morphShapeTo(5); e.preventDefault(); break;
        case 'c': {
            // Serialize current simulation state to a shareable URL hash and copy
            // it to the clipboard. history.replaceState is intentionally NOT called
            // here: driving it at 60Hz would create per-frame layout thrash.
            const url = `${location.origin}${location.pathname}#${serializeShareState(uiV)}`;
            navigator.clipboard?.writeText(url).catch(() => {});
            // Brief confirmation flash in the HUD mode display.
            if (hudFlashTimer) clearTimeout(hudFlashTimer);
            hudMode.textContent = 'Link copied!';
            hudFlashTimer = setTimeout(() => {
                hudFlashTimer = null;
                if (!statsMode) hudMode.textContent = hudModeLabel();
            }, 1800);
            e.preventDefault();
            break;
        }
        case 's': {
            // Off-screen 2× snapshot. Shares the live scene object (read-only
            // during a single render call on the same thread) but uses its own
            // renderer with preserveDrawingBuffer:true so the main renderer stays
            // optimised (false). The main animate loop is driven by
            // setAnimationLoop, which is a rAF-aligned callback; a snapshot render
            // call in a keydown handler fires between frames and cannot race it.
            if (graphicsDisposed) { e.preventDefault(); break; }
            (() => {
                let snapRenderer;
                try {
                    const w = Math.max(1, innerWidth * 2);
                    const h = Math.max(1, innerHeight * 2);
                    snapRenderer = new THREE.WebGLRenderer({
                        antialias: true, alpha: false,
                        powerPreference: 'high-performance',
                        preserveDrawingBuffer: true
                    });
                    snapRenderer.setSize(w, h, false);
                    snapRenderer.setPixelRatio(1);
                    snapRenderer.outputColorSpace = THREE.SRGBColorSpace;
                    snapRenderer.toneMapping = THREE.ACESFilmicToneMapping;
                    snapRenderer.toneMappingExposure = 0.92;
                    const snapCam = camera.clone();
                    snapCam.aspect = w / h;
                    snapCam.updateProjectionMatrix();
                    snapRenderer.render(scene, snapCam);
                    snapRenderer.domElement.toBlob(blob => {
                        if (!blob) return;
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = `quantum-singularity-${Date.now()}.png`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                    }, 'image/png');
                } catch (err) {
                    console.warn('[Snapshot]', err);
                } finally {
                    // Dispose immediately: preserveDrawingBuffer ties up extra
                    // GPU memory and we only needed one frame from this renderer.
                    try { snapRenderer?.dispose(); } catch (_) {}
                }
            })();
            e.preventDefault();
            break;
        }
        case ' ':      setPaused(!userPaused); e.preventDefault(); break;
        case 'escape':
            if (isGuideOpen) closeGuide();
            else if (isEngOpen) closeEng();
            else if (introVisible) dismissIntro();
            else if (controlsOpenOnMobile()) closeMobileControls();
            else if (focusMode) setFocusMode(false);
            break;
    }
});

// ═══════════════════════════════════════════
// 10. ANIMATION LOOP + ADAPTIVE RENDER SCALE
// ═══════════════════════════════════════════
const fpsEl        = document.getElementById('hud-fps');
const hudMode      = document.getElementById('hud-mode');
const hudParticles = document.getElementById('hud-particles');
let hudFlashTimer  = null;

// Wraps EXT_disjoint_timer_query_webgl2 (real GPU time, not the CPU-side
// renderer.info counters) behind a small pipelined query pool so reading a result
// never stalls the GPU waiting on the driver: ISSUE a query this frame, READ it back
// once the driver marks it available, typically a frame or two later.
class GPUTimer {
    constructor(glContext) {
        this.gl = glContext;
        this.ext = glContext.getExtension('EXT_disjoint_timer_query_webgl2');
        // WebGLQuery objects are recycled rather than created per frame. Allocating a
        // new one each frame would leak GPU objects for the driver to reclaim and put
        // an allocation back into the hot path this project deliberately keeps clean.
        this.free = [];
        this.pending = [];
        this.active = null;
        this.lastMs = null;
    }
    get supported() { return Boolean(this.ext); }
    begin() {
        // Depth cap: a driver that never marks results available must not grow the
        // pending queue without bound.
        if (!this.ext || this.active || this.pending.length >= 3) return;
        const query = this.free.pop() ?? this.gl.createQuery();
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
        this.active = query;
    }
    end() {
        if (!this.ext || !this.active) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.pending.push(this.active);
        this.active = null;
    }
    poll() {
        if (!this.ext) return this.lastMs;
        const gl = this.gl;
        while (this.pending.length && gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
            const query = this.pending.shift();
            // GPU_DISJOINT_EXT means the GPU was interrupted (power state change,
            // context switch) and every in-flight timing is untrustworthy, not just
            // this one -- so the reading is discarded rather than displayed.
            const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
            const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
            this.free.push(query);
            if (!disjoint) this.lastMs = ns / 1e6;
        }
        return this.lastMs;
    }
    dispose() {
        const gl = this.gl;
        if (this.active) { try { gl.endQuery(this.ext.TIME_ELAPSED_EXT); } catch (_) {} this.free.push(this.active); this.active = null; }
        for (const q of this.pending) gl.deleteQuery(q);
        for (const q of this.free) gl.deleteQuery(q);
        this.pending.length = 0;
        this.free.length = 0;
        this.lastMs = null;
    }
}
const gpuTimer = new GPUTimer(gl);
// EffectComposer issues one renderer.render() call per pass, and each of those
// auto-resets renderer.info by default -- so reading info.render.calls right after
// composer.render() would only reflect the *last* pass, not the frame total.
// Taking ownership of the reset (once, before the whole composer pass) makes the
// counter accumulate across every pass for an honest per-frame total.
renderer.info.autoReset = false;

const statsBtn = document.getElementById('stats-btn');
let statsMode = false;
function setStatsMode(next) {
    const value = Boolean(next);
    if (value === statsMode) return;
    statsMode = value;
    statsBtn?.setAttribute('aria-pressed', String(statsMode));
    statsBtn?.classList.toggle('is-on', statsMode);
    // Turning the readout off releases the query objects rather than leaving a
    // pool parked on the GPU for a panel that may never be opened again.
    if (!statsMode) {
        gpuTimer.dispose();
        hudMode.textContent = hudModeLabel();
    }
}
statsBtn?.addEventListener('click', () => setStatsMode(!statsMode));

let fcnt = 0, lastFt = performance.now(), lastFrameNow = performance.now();
let simTime = 0, qualityWindowFrames = 0, qualityWindowStart = performance.now();
let qualityCooldownUntil = 0;
let lastFpsShown = -1, lastFpsBucket = '';

// Shader time is wrapped so trigonometric arguments stay in a range where float32
// still has usable phase resolution. Without this, an hour-long session pushes
// sin() arguments past 25,000 and the twinkle/grain terms visibly quantise.
const SIM_TIME_WRAP = 3600;

function resetPerformanceClocks() {
    const now = performance.now();
    lastFrameNow = now;
    lastFt = now;
    qualityWindowStart = now;
    fcnt = 0;
    qualityWindowFrames = 0;
}

// Measured display cadence. Adaptive quality used to compare against a hardcoded
// 60Hz assumption, so on a 50Hz panel or a throttled tab the "increase quality"
// branch was unreachable while the "decrease" branch fired constantly -- quality
// decayed monotonically to the floor on perfectly healthy hardware.
let observedRefreshHz = 60;
let refreshSamples = 0;
function observeRefreshRate(dt) {
    if (dt <= 0.002 || dt > 0.05) return;
    const hz = 1 / dt;
    // Track the fastest sustained cadence seen; slow frames are the thing we are
    // trying to detect, so they must not drag the reference down.
    if (refreshSamples < 240) {
        observedRefreshHz = Math.max(observedRefreshHz, hz);
        refreshSamples++;
    }
}
function fpsTargets() {
    const ceiling = Math.min(observedRefreshHz, 144);
    // Aim just under the panel's cadence, and treat "within ~12%" as healthy.
    const high = ceiling * 0.94;
    const low = Math.min(TARGET_FPS - (isMobile ? 7 : 8), ceiling * 0.80);
    return { low, high };
}

function applyRenderScale(nextScale, force = false) {
    const minScale = ultraLowTier ? 0.48 : 0.58;
    const next = clamp(nextScale, minScale, 1.0);
    // Compare against the clamped value, and treat "already at the requested
    // boundary" as applied. The old dead-zone check compared post-clamp deltas
    // against a 0.03 threshold, which made the 1.0 ceiling and 0.58 floor
    // unreachable from 0.98/0.60 while still arming a multi-second cooldown.
    if (!force && next === adaptiveScale) return false;
    if (!force && Math.abs(next - adaptiveScale) < 0.03 && next !== 1.0 && next !== minScale) return false;
    adaptiveScale = next;
    const dpr = effectiveDPR();
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    // composer.setPixelRatio() internally calls setSize(); calling both reallocated
    // every composer and bloom-mip render target twice per quality step, and the
    // resulting hitch depressed the next FPS sample into another step down.
    composer.setPixelRatio(dpr);
    partMat.uniforms.uPixel.value = dpr;
    partMat.uniforms.uViewportHeight.value = Math.max(1, innerHeight * dpr);

    const detail = clamp((adaptiveScale - minScale) / (1.0 - minScale), 0, 1);
    const particleRatio = lerp(isMobile ? (ultraLowTier ? 0.45 : 0.58) : (ultraLowTier ? 0.48 : 0.62), 1.0, detail);
    const starRatio = lerp(ultraLowTier ? 0.38 : 0.52, 1.0, detail);
    const minParticles = ultraLowTier ? 8000 : (lowTier ? 12000 : 16000);
    const activeParticles = Math.max(minParticles, Math.floor(N * particleRatio));
    geo.setDrawRange(0, activeParticles);
    partMat.uniforms.uCoverage.value = pointSizeCompensation(activeParticles);
    sgeo.setDrawRange(0, Math.max(200, Math.floor(SN * starRatio)));
    currentInferenceFPS = Math.round(lerp(isMobile ? (ultraLowTier ? 8 : 11) : (ultraLowTier ? 9 : 13), INFERENCE_FPS_CAP, detail));
    if (neuralBackend === 'main') currentInferenceFPS = Math.min(currentInferenceFPS, isMobile ? 10 : 14);

    // Scale the post-processing cost with quality, not just the resolution.
    updateCinematicQuality(detail);

    if (!statsMode && !hudFlashTimer) hudMode.textContent = hudModeLabel();
    hudParticles.textContent = `${Math.round(activeParticles / 1000)}K PTS`;
    return true;
}

// Recomputed only when quality or the motion preference changes, rather than being
// rebuilt from scratch on every single frame.
function updateCinematicQuality(detail) {
    const reduced = reducedMotionQuery.matches || ultraLowTier;
    cinPass.uniforms.uCA.value = reduced ? 0.0004 : lerp(0.0008, 0.0028, detail);
    cinPass.uniforms.uGrain.value = reduced ? 0.003 : lerp(0.005, 0.016, detail);
}

function adaptiveQualityHint(reason) {
    if (adaptiveQualityLocked || performance.now() < qualityCooldownUntil) return;
    if (reason === 'inference-slow' && adaptiveScale > 0.62) {
        if (applyRenderScale(adaptiveScale - 0.055)) {
            qualityCooldownUntil = performance.now() + 2500;
        }
    }
}

function evaluateAdaptiveQuality(now) {
    // A tier pinned with ?quality= is honoured exactly: no automatic stepping.
    if (adaptiveQualityLocked) return;
    const elapsed = now - qualityWindowStart;
    if (elapsed < (ultraLowTier ? 1800 : 2500)) return;
    const avgFps = qualityWindowFrames * 1000 / Math.max(1, elapsed);
    if (now >= qualityCooldownUntil) {
        const { low, high } = fpsTargets();
        const minScale = ultraLowTier ? 0.48 : 0.58;
        if (avgFps < low && adaptiveScale > minScale) {
            // Only arm the cooldown if the step was actually applied; otherwise a
            // no-op re-ran every few seconds forever.
            if (applyRenderScale(adaptiveScale - (avgFps < low - 10 ? 0.12 : 0.075))) {
                qualityCooldownUntil = now + (ultraLowTier ? 2200 : 3200);
            }
        } else if (avgFps > high && adaptiveScale < 1.0) {
            if (applyRenderScale(adaptiveScale + 0.035)) {
                qualityCooldownUntil = now + (ultraLowTier ? 4200 : 5200);
            }
        }
    }
    qualityWindowFrames = 0;
    qualityWindowStart = now;
}

function animate(now = performance.now()) {
    const dt = Math.min(Math.max((now - lastFrameNow) / 1000, 0), 0.05);
    lastFrameNow = now;
    if (userPaused || contextPaused || document.hidden) return;
    observeRefreshRate(dt);
    simTime += dt;
    if (simTime > SIM_TIME_WRAP) simTime -= SIM_TIME_WRAP;

    fcnt++;
    qualityWindowFrames++;
    if (now - lastFt >= 600) {
        const fps = Math.round(fcnt * 1000 / (now - lastFt));
        if (fps !== lastFpsShown) {
            lastFpsShown = fps;
            fpsEl.textContent = `FPS: ${fps}`;
            // Only touch style when the bucket changes, not every 600ms.
            const bucket = fps >= 55 ? 'good' : fps >= 35 ? 'warn' : 'bad';
            if (bucket !== lastFpsBucket) {
                lastFpsBucket = bucket;
                fpsEl.style.color = bucket === 'good' ? 'var(--accent)'
                    : bucket === 'warn' ? 'var(--warning)' : 'var(--danger)';
            }
        }
        if (statsMode) {
            const gpuMs = gpuTimer.poll();
            const calls = renderer.info.render.calls;
            hudMode.textContent = gpuMs != null
                ? `GPU ${gpuMs.toFixed(2)}ms · ${calls} dc`
                : `${calls} draw calls · no GPU timer`;
        }
        fcnt = 0;
        lastFt = now;
    }
    evaluateAdaptiveQuality(now);

    orbit.autoRotate = wantAutoRotate && !reducedMotionQuery.matches;

    // Pointer/hand attractor. Cross-fade the influence AND the world position so the
    // attractor no longer teleports between the hand target and the mouse target the
    // instant influence crosses a hard 0.01 threshold.
    const u = partMat.uniforms;
    const handActive = handInfl > 0.004;
    const targetInfl = handActive ? handInfl : (isMouseActive ? 0.8 : 0);
    u.uHandInfl.value = approach(u.uHandInfl.value, targetInfl, handActive ? 0.5 : 0.12, dt);
    attractorTarget.copy(handActive ? handWorldPos : mouseWorldPos);
    if (u.uHandInfl.value < 0.002) {
        u.uHandPos.value.copy(attractorTarget);
    } else {
        u.uHandPos.value.lerp(attractorTarget, 1 - Math.pow(0.0001, dt));
    }

    if (shapeTween) {
        const progress = clamp((now - shapeTween.started) / shapeTween.duration, 0, 1);
        uiV.shape = lerp(shapeTween.from, shapeTween.to, easeOutExpo(progress));
        if (shapeTween.input) shapeTween.input.value = String(uiV.shape);
        if (shapeTween.output) shapeTween.output.textContent = fmt(uiV.shape);
        if (progress >= 1) {
            uiV.shape = shapeTween.to;
            shapeTween = null;
        }
    }
    if (paletteTween) {
        const progress = clamp((now - paletteTween.started) / paletteTween.duration, 0, 1);
        u.uPaletteMix.value = progress * progress * (3 - 2 * progress);
        if (progress >= 1) {
            u.uPalette.value = paletteTween.to;
            u.uPaletteNext.value = paletteTween.to;
            u.uPaletteMix.value = 0;
            paletteTween = null;
        }
    }

    u.uTime.value     = simTime;
    u.uShape.value    = uiV.shape;
    u.uScale.value    = uiV.scale;
    u.uGravity.value  = uiV.gravity;
    u.uJetPower.value = uiV.jetPower;
    u.uChaos.value    = uiV.chaos;
    u.uSpeed.value    = uiV.speed;
    u.uPSize.value    = uiV.psize;

    updateAudioReactivity(dt);
    u.uAudioBass.value   = audioBassSmooth;
    u.uAudioTreble.value = audioTrebleSmooth;
    u.uAudioMid.value    = audioMidSmooth;
    u.uAudioPulse.value  = audioPulse;

    cinPass.uniforms.uTime.value = simTime;
    // Pulse (onset transient) + mid-bass swell both drive bloom so kick hits AND
    // bass guitar create a visible flash without competing with each other.
    const targetBloom = clamp(uiV.bloom + audioPulse * 0.22 + audioMidBassSmooth * 0.14, 0, 3);
    if (bloomPass.strength !== targetBloom) bloomPass.strength = targetBloom;
    // Fillrate optimization for low-end / no-GPU / software renderers:
    // When bloom is near zero, disable UnrealBloomPass so EffectComposer completely skips the 5 mip passes.
    const shouldEnableBloom = targetBloom > 0.01;
    if (bloomPass.enabled !== shouldEnableBloom) bloomPass.enabled = shouldEnableBloom;

    setInfo(Math.min(5, Math.max(0, Math.round(uiV.shape))));
    stars.rotation.y = reducedMotionQuery.matches ? 0 : simTime * 0.009;

    const currentRadius = camera.position.distanceTo(orbit.target);
    if (isZoomingActive || Math.abs(currentRadius - targetCameraRadius) > 0.5) {
        const lerpedRadius = approach(currentRadius, targetCameraRadius, reducedMotionQuery.matches ? 0.2 : 0.1, dt);
        tempDir.subVectors(camera.position, orbit.target);
        if (tempDir.lengthSq() > 0.0001) {
            tempDir.normalize();
            camera.position.copy(orbit.target).addScaledVector(tempDir, lerpedRadius);
        }
    }

    orbit.update();
    renderer.info.reset();
    // The GPU timer is only armed while the stats readout is visible: issuing
    // timer queries every frame would cost driver work and hold GPU query objects
    // alive for a number nobody is looking at.
    if (statsMode) gpuTimer.begin();
    composer.render(dt);
    if (statsMode) gpuTimer.end();
}

let pausedByContextLoss = false;
renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    pausedByContextLoss = true;
    contextPaused = true;
    resetPerformanceClocks();
    const banner = document.getElementById('fatal-banner');
    banner.textContent = 'Graphics context was lost. The browser is attempting to restore it…';
    banner.classList.add('visible');
}, false);
renderer.domElement.addEventListener('webglcontextrestored', () => {
    if (pausedByContextLoss) contextPaused = false;
    pausedByContextLoss = false;
    resetPerformanceClocks();
    resizeExperience();
    document.getElementById('fatal-banner').classList.remove('visible');
    void renderer.compileAsync(scene, camera).catch(error => console.warn('[Renderer] restore precompile skipped', error));
}, false);

let resizeRaf = 0;
function resizeExperience() {
    resizeRaf = 0;
    // A resize event can be queued in the same task as pagehide; without this guard
    // the rAF fires after teardown and touches a disposed renderer/composer.
    if (graphicsDisposed) return;
    const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const dpr = effectiveDPR();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    // setPixelRatio already re-runs setSize on the composer chain; calling both
    // reallocated every render target twice per resize event.
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    partMat.uniforms.uPixel.value = dpr;
    partMat.uniforms.uViewportHeight.value = Math.max(1, h * dpr);
    updateCinematicAspect(w, h);
}
const onWindowResize = () => {
    if (!resizeRaf) resizeRaf = requestAnimationFrame(resizeExperience);
};
window.addEventListener('resize', onWindowResize, { passive: true });

reducedMotionQuery.addEventListener?.('change', () => {
    const reduced = reducedMotionQuery.matches;
    wantAutoRotate = !reduced;
    orbit.autoRotateSpeed = reduced ? 0 : 0.28;
    // Post-processing intensity is now cached rather than recomputed per frame, so it
    // must be refreshed when the preference flips mid-session.
    updateCinematicQuality(clamp((adaptiveScale - 0.58) / 0.42, 0, 1));
    if (reduced) {
        shapeTween = null;
        stars.rotation.y = 0;
    }
});

// A MediaStreamTrack cannot be restarted once stopped, so "full teardown on tab
// hide" (documented in README/ARCHITECTURE) means re-acquiring the camera and
// microphone when the tab becomes visible again. Remember what was live at hide
// time so only those inputs come back, and never resurrect one the visitor had
// turned off before the tab left.
let suspendCameraOnHide = false;
let suspendAudioOnHide = false;
document.addEventListener('visibilitychange', () => {
    resetPerformanceClocks();
    if (document.hidden) {
        suspendCameraOnHide = neuralState === 'on';
        suspendAudioOnHide = audioState === 'on';
        if (suspendCameraOnHide) stopCameraTracks({ disposeBackend: true });
        if (suspendAudioOnHide) stopAudioTracks();
        cancelVideoInference();
    } else {
        cancelVideoInference();
        if (suspendCameraOnHide) {
            suspendCameraOnHide = false;
            void enableNeuralLink();
        }
        if (suspendAudioOnHide) {
            suspendAudioOnHide = false;
            void enableAudioReactivity();
        }
        if (neuralState === 'on') scheduleVideoInference();
    }
});

let graphicsDisposed = false;
function cleanupGraphics() {
    if (graphicsDisposed) return;
    graphicsDisposed = true;
    renderer.setAnimationLoop(null);
    // Cancel anything still scheduled before the GPU objects go away.
    if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = 0; }
    clearPointerTimeout();
    window.removeEventListener('resize', onWindowResize);
    stopCameraTracks({ disposeBackend: true });
    stopAudioTracks();
    try { gpuTimer.dispose(); } catch (_) {}
    orbit.dispose();
    geo.dispose();
    partMat.dispose();
    sgeo.dispose();
    stars.material.dispose();
    for (const pass of composer.passes) {
        try { pass.dispose?.(); } catch (_) {}
    }
    try { composer.renderTarget1?.dispose(); } catch (_) {}
    try { composer.renderTarget2?.dispose(); } catch (_) {}
    composer.dispose();
    renderer.dispose();
    // dispose() alone does not guarantee the driver releases the context on every
    // platform; forcing the loss makes teardown deterministic.
    try { renderer.forceContextLoss(); } catch (_) {}
    renderer.domElement.remove();
    scene.clear();
}

// pagehide can participate in the back/forward cache. Never destroy GPU state for a persisted page.
window.addEventListener('pagehide', (event) => {
    if (event.persisted) {
        stopCameraTracks({ disposeBackend: true });
        setNeuralStatus('Camera off. Page suspended.');
        stopAudioTracks();
        setAudioStatus('Sound off. Page suspended.');
    } else {
        cleanupGraphics();
    }
});

window.addEventListener('pageshow', (event) => {
    if (event.persisted && !graphicsDisposed) {
        resetPerformanceClocks();
        renderer.setAnimationLoop(animate);
    }
});

resizeExperience();
applyRenderScale(adaptiveScale, true);

// Compile scene materials early when KHR_parallel_shader_compile is available.
try {
    await renderer.compileAsync(scene, camera);
} catch (error) {
    console.warn('[Renderer] shader precompile skipped', error);
}
renderer.setAnimationLoop(animate);

// Last-resort safety net for anything the individually-guarded paths miss (e.g. an
// internal Three.js throw inside composer.render()). Deduped per message so a
// repeating per-frame failure cannot spam the console; the loop keeps running and
// recovers when the transient condition clears.
let lastUnhandledSignature = null;
const reportUnhandled = (message) => {
    if (lastUnhandledSignature === message) return;
    lastUnhandledSignature = message;
    console.warn('[Unhandled]', message);
};
window.addEventListener('unhandledrejection', (event) => reportUnhandled(String(event.reason)));
window.addEventListener('error', (event) => reportUnhandled(event.message));

// Readiness flag for automated tests. Set only after every binding is initialised
// and the render loop is live -- it previously fired mid-module, before `fpsEl` was
// even declared, so a test that acted on it immediately could hit a temporal dead
// zone.
window.__qsReady = true;
document.body.dataset.qsReady = 'true';
// Let the field settle in (intro camera move, first bloom) before greeting.
scheduleIntro(1400);

// Test-only surface for the gesture recognition pipeline.
//
// The classifier is pure, deterministic maths over 21 landmarks, but it is the one
// part of this app that cannot be exercised through the UI without a physical hand
// in front of a physical camera. Exposing the pure functions lets the suite verify
// recognition, hysteresis and release behaviour against synthetic poses.
window.__qsGesture = Object.freeze({
    geometryGestureScores,
    fuseGestureScores,
    updateGestureTemporal,
    resetGestureTemporal,
    mediaPipeGestureScores,
    handToNDC,
    applyGesture,
    animationState: () => ({
        handInfl,
        handWorldPos: { x: handWorldPos.x, y: handWorldPos.y, z: handWorldPos.z },
        targetCameraRadius,
        isZoomingActive,
        chaos: uiV.chaos,
        uHandInfl: partMat.uniforms.uHandInfl.value,
        uHandPos: { x: partMat.uniforms.uHandPos.value.x, y: partMat.uniforms.uHandPos.value.y, z: partMat.uniforms.uHandPos.value.z }
    }),
    THREE,
    groundPlane,
    thresholds: Object.freeze({
        GESTURE_ACTIVATE, GESTURE_SWITCH, GESTURE_HOLD,
        GESTURE_MARGIN, GESTURE_IDLE_MARGIN,
        GESTURE_CONFIRM_SEC, GESTURE_RELEASE_SEC
    }),
    setFrameAspect(a) { gestureFrameAspect = a; },
    state: () => gestureMachine.snapshot()
});

// Test-only surface for the Web Audio reactivity pipeline. Like __qsGesture above,
// this exposes pure functions so the onset detector and band-splitting maths can be
// exercised with synthetic frequency-bin arrays instead of a live microphone.
window.__qsAudio = Object.freeze({
    computeAudioBandBins,
    computeAudioBands,
    detectAudioOnset,
    state: () => ({
        audioState,
        bassSmooth:    audioBassSmooth,
        midBassSmooth: audioMidBassSmooth,
        midSmooth:     audioMidSmooth,
        trebleSmooth:  audioTrebleSmooth,
        pulse:         audioPulse
    }),
    // The real AudioContext state, so a test can assert the reported UI state and the
    // actual audio graph agree -- the exact thing the stale-session race broke.
    contextState: () => audioCtx?.state ?? 'none'
});

// Test-only surface for URL state serialization, so Playwright specs can verify the
// hash schema without needing clipboard permissions in every test environment.
window.__qsState = Object.freeze({
    serialize: () => serializeShareState(uiV),
    parse: (hash) => parseShareHash(hash),
    uiV: () => ({ ...uiV }),
    quality: () => ({ ...qualityProfile, adaptiveScale, locked: adaptiveQualityLocked })
});
