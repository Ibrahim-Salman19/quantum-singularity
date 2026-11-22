// Fetches the webcam fixture for tests/hand-gesture.spec.ts.
//
// Chromium's fake camera plays an MJPEG file, and a single JPEG is a one-frame
// MJPEG that it repeats. The photo is MediaPipe's own gesture-recognizer sample,
// fetched at test time rather than committed. A failed download only warns: the
// hand spec then fails with a clear message, and every other spec still runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HAND_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hand-victory.mjpeg');
const SOURCE = 'https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/victory.jpg';

export default async function globalSetup() {
    if (fs.existsSync(HAND_FIXTURE)) return;
    fs.mkdirSync(path.dirname(HAND_FIXTURE), { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            // JPEG start-of-image marker: refuse an HTML error page saved as a frame.
            if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
            fs.writeFileSync(HAND_FIXTURE, bytes);
            return;
        } catch (error) {
            if (attempt === 3) console.warn(`[global-setup] hand fixture unavailable: ${error.message}`);
        }
    }
}
