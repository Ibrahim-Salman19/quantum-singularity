import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('=== QUANTUM SINGULARITY STATIC AUDIT ===\n');

let failed = false;

// 1. ES Module Syntax Check
try {
    const htmlPath = path.join(rootDir, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    if (!scriptMatch) {
        throw new Error('No <script type="module"> block found in index.html');
    }
    const tempFile = path.join('/tmp', `extracted_module_${Date.now()}.mjs`);
    fs.writeFileSync(tempFile, scriptMatch[1]);
    execSync(`node --check ${tempFile}`);
    fs.unlinkSync(tempFile);
    console.log('✔ ES Module Syntax Check: PASS');
} catch (err) {
    console.error('✘ ES Module Syntax Check: FAIL -', err.message);
    failed = true;
}

// 2. Duplicate DOM IDs Check
try {
    const htmlPath = path.join(rootDir, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const idMatches = [...html.matchAll(/id=["']([^"']+)["']/g)].map(m => m[1]);
    const counts = {};
    const duplicates = [];
    idMatches.forEach(id => {
        counts[id] = (counts[id] || 0) + 1;
        if (counts[id] === 2) duplicates.push(id);
    });
    if (duplicates.length > 0) {
        throw new Error(`Found duplicate DOM IDs: ${duplicates.join(', ')}`);
    }
    console.log(`✔ Duplicate DOM IDs Check (${idMatches.length} IDs): PASS`);
} catch (err) {
    console.error('✘ Duplicate DOM IDs Check: FAIL -', err.message);
    failed = true;
}

// 3. vercel.json Schema/JSON Syntax Check
try {
    const vercelPath = path.join(rootDir, 'vercel.json');
    const content = fs.readFileSync(vercelPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed.headers || !Array.isArray(parsed.headers)) {
        throw new Error('vercel.json missing headers array');
    }
    console.log('✔ vercel.json JSON Schema & Headers: PASS');
} catch (err) {
    console.error('✘ vercel.json Check: FAIL -', err.message);
    failed = true;
}

// 4. robots.txt Check
try {
    const robotsPath = path.join(rootDir, 'robots.txt');
    const content = fs.readFileSync(robotsPath, 'utf8');
    if (!content.includes('User-agent: *')) {
        throw new Error('robots.txt missing User-agent: * baseline rule');
    }
    console.log('✔ robots.txt Verification: PASS');
} catch (err) {
    console.error('✘ robots.txt Check: FAIL -', err.message);
    failed = true;
}

// 5. Import Map SRI Coverage Check
// Every CDN module URL actually reachable from the module graph -- static "imports"
// entries, string-literal dynamic import() calls, and the MediaPipe CDN fallback
// array -- must have a matching "integrity" hash, so a future added dependency
// can't silently ship without SRI coverage.
try {
    const htmlPath = path.join(rootDir, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (!mapMatch) throw new Error('No <script type="importmap"> block found');
    const importMap = JSON.parse(mapMatch[1]);
    if (!importMap.integrity || typeof importMap.integrity !== 'object') {
        throw new Error('importmap has no "integrity" block');
    }
    const integrityKeys = new Set(Object.keys(importMap.integrity));
    const hashPattern = /^sha384-[A-Za-z0-9+/]{64}={0,2}$/;
    for (const [url, hash] of Object.entries(importMap.integrity)) {
        if (!hashPattern.test(hash)) {
            throw new Error(`Malformed integrity hash for ${url}: "${hash}"`);
        }
    }

    // Direct (non-prefix) "imports" entries resolve straight to a URL.
    const bareSpecifiers = Object.entries(importMap.imports || {}).filter(([spec]) => !spec.endsWith('/'));
    for (const [spec, url] of bareSpecifiers) {
        if (!integrityKeys.has(url)) throw new Error(`imports["${spec}"] -> ${url} has no integrity entry`);
    }

    // Prefix entries (e.g. "three/addons/") resolve dynamically; find every
    // string-literal import('three/addons/...') call and resolve it by hand.
    const prefixEntries = Object.entries(importMap.imports || {}).filter(([spec]) => spec.endsWith('/'));
    const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = dynamicImportRe.exec(html))) {
        const spec = m[1];
        const prefix = prefixEntries.find(([p]) => spec.startsWith(p));
        if (!prefix) continue; // not a mapped bare specifier (e.g. a same-origin or external URL import)
        const resolved = prefix[1] + spec.slice(prefix[0].length);
        if (!integrityKeys.has(resolved)) {
            throw new Error(`import('${spec}') -> ${resolved} has no integrity entry`);
        }
    }

    // The MediaPipe CDN fallback array is built from template literals, not string
    // literals, so it can't be regex-matched generically -- check its two known
    // mirrors explicitly against the pinned MP_VERSION.
    const versionMatch = html.match(/const MP_VERSION = '([^']+)'/);
    if (!versionMatch) throw new Error('MP_VERSION not found');
    const mpVersion = versionMatch[1];
    for (const origin of ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com']) {
        const url = `${origin}/@mediapipe/tasks-vision@${mpVersion}/vision_bundle.mjs`;
        if (!integrityKeys.has(url)) throw new Error(`MediaPipe bundle ${url} has no integrity entry`);
    }

    console.log(`✔ Import Map SRI Coverage Check (${integrityKeys.size} entries): PASS`);
} catch (err) {
    console.error('✘ Import Map SRI Coverage Check: FAIL -', err.message);
    failed = true;
}

// 6. Manifest & Icon Presence Check
try {
    for (const rel of ['manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
        const p = path.join(rootDir, rel);
        if (!fs.existsSync(p)) throw new Error(`Missing ${rel}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
    for (const field of ['name', 'short_name', 'start_url', 'display', 'icons']) {
        if (!(field in manifest)) throw new Error(`manifest.json missing "${field}"`);
    }
    if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
        throw new Error('manifest.json has no icons');
    }
    const htmlPath = path.join(rootDir, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    if (!html.includes('rel="manifest"')) throw new Error('index.html does not link the manifest');
    if (!html.includes('rel="apple-touch-icon"')) throw new Error('index.html does not link an apple-touch-icon');
    console.log('✔ Manifest & Icon Presence Check: PASS');
} catch (err) {
    console.error('✘ Manifest & Icon Presence Check: FAIL -', err.message);
    failed = true;
}

// 7. Topology & keyboard binding consistency check
try {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    // Slider must allow values 0–5
    if (!html.includes("'shape',    'Morph Topology',  0,   5")) {
        throw new Error("Topology slider max is not 5");
    }
    // Keyboard cases for 5 and 6
    if (!html.includes("case '5':      morphShapeTo(4)")) {
        throw new Error("Missing keyboard case for topology 5 (key '5' → morphShapeTo(4))");
    }
    if (!html.includes("case '6':      morphShapeTo(5)")) {
        throw new Error("Missing keyboard case for topology 6 (key '6' → morphShapeTo(5))");
    }
    // SHAPE_INFO must have exactly 6 entries (count opening [' sequences)
    const shapeInfoMatch = html.match(/const SHAPE_INFO = \[([\s\S]*?)\];/);
    if (!shapeInfoMatch) throw new Error('SHAPE_INFO not found');
    const entryCount = (shapeInfoMatch[1].match(/\['/g) || []).length;
    if (entryCount !== 6) throw new Error(`SHAPE_INFO has ${entryCount} entries, expected 6`);
    // morphShapeTo clamp must be 5
    if (!html.includes('clamp(target, 0, 5)')) {
        throw new Error('morphShapeTo clamp is not (0, 5)');
    }
    console.log('✔ Topology & keyboard binding consistency (6 topologies): PASS');
} catch (err) {
    console.error('✘ Topology consistency check: FAIL -', err.message);
    failed = true;
}

if (failed) {
    console.error('\nSTATIC AUDIT FAILED!');
    process.exit(1);
} else {
    console.log('\nALL STATIC AUDIT CHECKS PASSED CLEANLY!');
}
