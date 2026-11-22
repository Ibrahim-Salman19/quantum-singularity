#!/usr/bin/env node
/**
 * Regenerates the project media in docs/media/ from the running app.
 *
 *   npm start                                   # serve the repo on :8080
 *   node scripts/capture-media.mjs [baseUrl]    # requires ffmpeg on PATH
 *
 * Environment: QS_QUALITY picks the tier (default high); QS_ONLY=hero or
 * QS_ONLY=interface renders one part; QS_KEEP_MASTER=<path> keeps the lossless
 * FFV1 master of the loop.
 *
 * Outputs
 *   hero.mp4         16:9 loop, H.264, no audio (portfolio, LinkedIn)
 *   hero.webm        the same loop in VP9
 *   hero-poster.webp a still from the loop, for <video poster>
 *   hero.gif         a 480 px, 10 fps version so the README animates on GitHub
 *   interface.png    the full interface with its controls
 *
 * Determinism: once the app is ready, Playwright's fake clock is paused and only
 * advanced by step(), so consecutive frames are exactly 1/FPS of simulated time
 * apart however slowly the machine renders.
 * That keeps the clip smooth even under a software rasteriser.
 *
 * Frames are read straight from the WebGL canvas. page.screenshot() stalls for
 * minutes while the clock is paused, so the interface still uses a DevTools
 * capture instead. An init script requests
 * preserveDrawingBuffer so the last rendered frame stays readable, and
 * toDataURL() returns it after gl.finish() has waited for the GPU.
 *
 * The loop: CAPTURE_S = LOOP_S + FADE_S seconds are rendered, and the last FADE_S
 * seconds are crossfaded into the first FADE_S. The field spins once every 67 s
 * and its hue cycles every 27 s of simulated time, so no clip this short ends on
 * the view it opened with. The morph back to the opening topology therefore
 * starts as the crossfade does: the eye follows the particles settling into the
 * disk while the opening frames fade in underneath.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'media');
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const QUALITY = process.env.QS_QUALITY || 'high';

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
const STEP_MS = 1000 / FPS;
const WARMUP_S = 29; // the disk precesses; at 29 s it lies nearly edge-on, its most legible view
const LOOP_S = 7;
const FADE_S = 0.5;
const CAPTURE_S = LOOP_S + FADE_S;
const UI_WARMUP_S = 20; // the disk has tilted toward the camera and turned magenta
const ONLY = process.env.QS_ONLY || '';
const POSTER_S = 0; // the opening frame, so the poster hands over to playback without a jump

// Keys pressed at each time in seconds. The clip opens on topology 1 (the default)
// and morphs back to it one frame before the crossfade begins.
const SCRIPT = [
    { at: 2.0, key: '5' }, // Hopf fibration
    { at: 4.25, key: '3' }, // 4D tesseract
    { at: LOOP_S - 1 / FPS, key: '1' } // back to the accretion disk, across the join
];

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const ffmpeg = (args) => sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const size = (f) => `${(fs.statSync(f).size / 1048576).toFixed(2)} MB`;

async function boot(page, url) {
    await page.clock.install();
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    // Poll from Node: in-page waits rely on timers, and the page's timers are now fake.
    for (let i = 0; i < 480; i++) {
        if (await page.evaluate(() => window.__qsReady === true)) {
            // An installed clock keeps running in real time; pause it so that only
            // step() advances it, one frame at a time.
            await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('app never became ready');
}

// One frame: advance simulated time, then block until the GPU has finished it.
async function step(page) {
    await page.clock.fastForward(STEP_MS);
    await page.evaluate(() => document.querySelector('canvas.webgl-canvas')?.getContext('webgl2')?.finish());
}

async function grab(page, file) {
    const url = await page.evaluate(() => document.querySelector('canvas.webgl-canvas').toDataURL('image/png'));
    fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
}

// Headless Chromium on Linux snaps glyph advances to whole pixels, which squeezes the
// word spaces out of small UI text; turning hinting off keeps the browser's spacing.
const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--font-render-hinting=none']
});
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-media-'));

try {
    // One context per shot: the fake clock belongs to the context, so a page opened
    // after the hero would boot with the hero's clock still paused.
    const newContext = async (width, height) => {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
        context.setDefaultTimeout(300000);
        await context.addInitScript(() => {
            // Returning-visitor state: no welcome card in the shots.
            try { localStorage.setItem('qs_guide_dismissed_v4', '1'); } catch (e) {}
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, attrs) {
                if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
                return getContext.call(this, type, attrs);
            };
        });
        return context;
    };

    if (ONLY !== 'interface') {
        // 1. Hero loop: the field alone (the canvas holds no HTML interface).
        const context = await newContext(WIDTH, HEIGHT);
        const page = await context.newPage();
        await boot(page, `${BASE}/?quality=${QUALITY}`);
        for (let i = 0; i < WARMUP_S * FPS; i++) await step(page);

        const total = Math.round(CAPTURE_S * FPS);
        const started = Date.now();
        let next = 0;
        for (let i = 0; i < total; i++) {
            const t = i / FPS;
            while (next < SCRIPT.length && SCRIPT[next].at <= t) await page.keyboard.press(SCRIPT[next++].key);
            await step(page);
            await grab(page, path.join(work, `f${String(i).padStart(4, '0')}.png`));
            if (i % 12 === 0) {
                const eta = ((Date.now() - started) / (i + 1)) * (total - i - 1) / 60000;
                process.stdout.write(`frame ${i + 1}/${total}, about ${eta.toFixed(0)} min left\n`);
            }
        }
        await context.close();

        // Encode. Build a lossless master of the loop, then derive the formats.
        const master = path.join(work, 'loop.mkv');
        ffmpeg(['-framerate', String(FPS), '-i', path.join(work, 'f%04d.png'), '-filter_complex',
            `[0]split[a][b];` +
            `[a]trim=start=${FADE_S}:end=${CAPTURE_S},setpts=PTS-STARTPTS[body];` +
            `[b]trim=start=0:end=${FADE_S},setpts=PTS-STARTPTS[head];` +
            `[body][head]xfade=transition=fade:duration=${FADE_S}:offset=${LOOP_S - FADE_S}[v]`,
            '-map', '[v]', '-c:v', 'ffv1', master]);
        // Keep the lossless master to try other encodes without re-rendering.
        if (process.env.QS_KEEP_MASTER) fs.copyFileSync(master, process.env.QS_KEEP_MASTER);

        const mp4 = path.join(outDir, 'hero.mp4');
        ffmpeg(['-i', master, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
            '-crf', '30', '-preset', 'veryslow', '-tune', 'film', '-movflags', '+faststart', mp4]);
        const webm = path.join(outDir, 'hero.webm');
        ffmpeg(['-i', master, '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '44',
            '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1', webm]);
        const poster = path.join(outDir, 'hero-poster.webp');
        ffmpeg(['-ss', String(POSTER_S), '-i', master, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '86', poster]);

        const palette = path.join(work, 'palette.png');
        // Particle fields are close to noise, which GIF compresses badly; width, frame
        // rate and palette are what keep this near 3 MB.
        const gifScale = 'fps=10,scale=480:-1:flags=lanczos';
        ffmpeg(['-i', master, '-vf', `${gifScale},palettegen=max_colors=96:stats_mode=diff`, palette]);
        ffmpeg(['-i', master, '-i', palette, '-lavfi',
            `${gifScale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, '-loop', '0',
            path.join(outDir, 'hero.gif')]);
    }

    if (ONLY !== 'hero') {
        // 2. Interface still, with the controls visible. The clock stays paused: once
        // it runs, the real-time render loop starves the software rasteriser and the
        // screenshot never gets a frame. A DevTools capture reads the compositor's
        // current output, which already holds the last WebGL frame.
        const context = await newContext(1440, 900);
        const ui = await context.newPage();
        await boot(ui, `${BASE}/?quality=${QUALITY}`);
        for (let i = 0; i < UI_WARMUP_S * FPS; i++) await step(ui);
        for (let i = 0; i < 120 && !(await ui.evaluate(() => document.fonts.status === 'loaded')); i++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        // The frame counter divides frames by simulated time, so here it reports the
        // capture rate, not the app's. Show its unmeasured state rather than either.
        await ui.evaluate(() => {
            const fps = document.getElementById('hud-fps');
            fps.textContent = 'FPS: --';
            fps.style.color = '';
        });
        const cdp = await context.newCDPSession(ui);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'interface.png'), Buffer.from(data, 'base64'));
        await context.close();
    }

    for (const f of ['hero.mp4', 'hero.webm', 'hero-poster.webp', 'hero.gif', 'interface.png']) {
        if (!fs.existsSync(path.join(outDir, f))) continue;
        console.log(`${f.padEnd(17)} ${size(path.join(outDir, f))}`);
    }
} finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
}
