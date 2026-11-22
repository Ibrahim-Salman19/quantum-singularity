/**
 * Static audit: fast, dependency-free checks that catch the failure modes a
 * no-build-step project is most exposed to. There is no bundler to fail on a bad
 * import, no type checker, and no linker for DOM IDs, so these run before any
 * browser test and in under a second.
 *
 * Usage: node scripts/static_audit.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(rootDir, rel));

function walk(dir, ext) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(rel, ext));
        else if (rel.endsWith(ext)) out.push(rel);
    }
    return out.sort();
}

const html = read('index.html');
const srcFiles = walk('src', '.js');
const srcText = Object.fromEntries(srcFiles.map((f) => [f, read(f)]));
const allSource = html + '\n' + Object.values(srcText).join('\n');

let failed = 0;
function check(name, fn) {
    try {
        const detail = fn();
        console.log(`✔ ${name}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
        console.error(`✘ ${name}: ${err.message}`);
        failed++;
    }
}

console.log('=== QUANTUM SINGULARITY STATIC AUDIT ===\n');

// 1. The page loads external modules only: inline module code would bypass the
//    syntax check below and the module graph check, and blocks a stricter CSP.
check('Module entry points', () => {
    const inline = [...html.matchAll(/<script type="module"(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    if (inline.some((m) => m[1].trim())) throw new Error('index.html contains an inline module script');
    for (const [re, rel] of [[/<script type="module" src="([^"]+)"/, 'module script'], [/<link rel="stylesheet" href="(?!https?:)([^"]+)"/, 'local stylesheet']]) {
        const m = html.match(re);
        if (!m) throw new Error(`index.html has no ${rel}`);
        if (!exists(m[1])) throw new Error(`${rel} ${m[1]} does not exist`);
    }
    return 'src/main.js, src/styles.css';
});

// 2. Every JS file parses.
check('JavaScript syntax', () => {
    const files = [...srcFiles, ...walk('scripts', '.js'), ...walk('tests/unit', '.js'), 'playwright.config.js'];
    for (const f of files) {
        try {
            execFileSync(process.execPath, ['--check', path.join(rootDir, f)], { stdio: 'pipe' });
        } catch (err) {
            throw new Error(`${f}\n${String(err.stderr || err.message).trim()}`);
        }
    }
    return `${files.length} files`;
});

// 3. Relative imports resolve, and every named import is actually exported.
//    In the browser a missing named export is a SyntaxError that kills the whole
//    module graph at load: exactly what a bundler would have caught.
check('Module graph (imports resolve, named exports exist)', () => {
    const exportsOf = (text) => {
        const names = new Set();
        for (const m of text.matchAll(/export\s+(?:const|let|var|function\*?|async\s+function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
        for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop();
                if (name) names.add(name);
            }
        }
        return names;
    };
    let edges = 0;
    for (const [file, text] of Object.entries(srcText)) {
        for (const m of text.matchAll(/import\s*(?:\{([^}]*)\}\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[2]));
            if (!(target in srcText)) throw new Error(`${file} imports ${m[2]}, which does not exist`);
            const available = exportsOf(srcText[target]);
            for (const part of (m[1] || '').split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0];
                if (name && !available.has(name)) throw new Error(`${file} imports { ${name} } from ${m[2]}, which does not export it`);
            }
            edges++;
        }
    }
    return `${srcFiles.length} modules, ${edges} imports`;
});

// 4. DOM integrity.
check('Unique DOM IDs', () => {
    const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) throw new Error(`duplicate IDs: ${[...new Set(dupes)].join(', ')}`);
    return `${ids.length} IDs`;
});

check('Every getElementById() target exists', () => {
    const known = new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]));
    // Sliders are built at runtime: mkSlider(container, id, ...) creates #id and #id-v.
    for (const m of srcText['src/main.js'].matchAll(/mkSlider\(\s*'[^']+'\s*,\s*'([^']+)'/g)) {
        known.add(m[1]);
        known.add(`${m[1]}-v`);
    }
    const refs = new Set();
    for (const text of Object.values(srcText)) {
        for (const m of text.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) refs.add(m[1]);
    }
    const missing = [...refs].filter((id) => !known.has(id));
    if (missing.length) throw new Error(`no element for: ${missing.join(', ')}`);
    return `${refs.size} references`;
});

// 5. Subresource Integrity covers every CDN module the page can load.
check('Import map SRI coverage', () => {
    const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (!mapMatch) throw new Error('no <script type="importmap"> block');
    const importMap = JSON.parse(mapMatch[1]);
    const integrity = importMap.integrity || {};
    const hashPattern = /^sha384-[A-Za-z0-9+/]{64}={0,2}$/;
    for (const [url, hash] of Object.entries(integrity)) {
        if (!hashPattern.test(hash)) throw new Error(`malformed integrity hash for ${url}`);
    }
    const covered = (url) => Object.hasOwn(integrity, url);
    const entries = Object.entries(importMap.imports || {});
    for (const [spec, url] of entries.filter(([s]) => !s.endsWith('/'))) {
        if (!covered(url)) throw new Error(`imports["${spec}"] -> ${url} has no integrity entry`);
    }
    // Prefix mappings ("three/addons/") are resolved by hand for every literal import().
    const prefixes = entries.filter(([s]) => s.endsWith('/'));
    let dynamic = 0;
    for (const m of allSource.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const prefix = prefixes.find(([p]) => m[1].startsWith(p));
        if (!prefix) continue;
        const resolved = prefix[1] + m[1].slice(prefix[0].length);
        if (!covered(resolved)) throw new Error(`import('${m[1]}') -> ${resolved} has no integrity entry`);
        dynamic++;
    }
    // The MediaPipe mirrors are built from template literals; check them explicitly.
    const version = srcText['src/main.js'].match(/const MP_VERSION = '([^']+)'/)?.[1];
    if (!version) throw new Error('MP_VERSION not found in src/main.js');
    for (const origin of ['https://cdn.jsdelivr.net/npm', 'https://unpkg.com']) {
        const url = `${origin}/@mediapipe/tasks-vision@${version}/vision_bundle.mjs`;
        if (!covered(url)) throw new Error(`MediaPipe bundle ${url} has no integrity entry`);
    }
    return `${Object.keys(integrity).length} hashes, ${dynamic} addon imports, MediaPipe ${version}`;
});

// 6. Topology count agrees across the slider, keyboard, info table, share links.
check('Topology consistency (6 topologies)', () => {
    const main = srcText['src/main.js'];
    if (!/mkSlider\('cg-shape',\s*'shape',\s*'Morph Topology',\s*0,\s*5\b/.test(main)) throw new Error('topology slider max is not 5');
    for (let k = 1; k <= 6; k++) {
        if (!new RegExp(`case '${k}':\\s*morphShapeTo\\(${k - 1}\\)`).test(main)) throw new Error(`key '${k}' is not bound to morphShapeTo(${k - 1})`);
    }
    const info = main.match(/const SHAPE_INFO = \[([\s\S]*?)\n\];/);
    if (!info) throw new Error('SHAPE_INFO not found');
    const count = (info[1].match(/^\s*\[/gm) || []).length;
    if (count !== 6) throw new Error(`SHAPE_INFO has ${count} entries`);
    if (!main.includes('clamp(target, 0, 5)')) throw new Error('morphShapeTo does not clamp to [0, 5]');
    if (!/TOPOLOGY_COUNT = 6\b/.test(srcText['src/state/share-link.js'])) throw new Error('share-link TOPOLOGY_COUNT is not 6');
    return 'slider, keys 1-6, SHAPE_INFO, clamp, share links';
});

// 7. Deployment: every asset the page or the crawler files reference is shipped.
//    .vercelignore once excluded *.md while llms.txt linked to the docs, so the
//    published documentation links all returned 404.
check('Deploy set (referenced files exist and are not .vercelignored)', () => {
    const ignore = read('.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const toRegex = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '(/|$)');
    const ignored = (rel) => ignore.some((g) => toRegex(g.replace(/^\/|\/$/g, '')).test(rel));

    const site = JSON.parse(read('package.json')).homepage.replace(/\/$/, '');
    const refs = new Set();
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
        if (!/^(https?:|data:|mailto:|#|\/\/)/.test(m[1])) refs.add(m[1].replace(/^\.?\//, ''));
    }
    for (const file of ['llms.txt', 'llms-full.txt', 'robots.txt', 'sitemap.xml', 'index.html']) {
        for (const m of read(file).matchAll(new RegExp(site.replace(/[.]/g, '\\.') + '/([A-Za-z0-9._/-]+)', 'g'))) refs.add(m[1]);
    }
    const manifest = JSON.parse(read('manifest.json'));
    for (const icon of manifest.icons || []) refs.add(icon.src.replace(/^\.?\//, ''));

    for (const rel of refs) {
        if (!exists(rel)) throw new Error(`${rel} is referenced but does not exist`);
        if (ignored(rel)) throw new Error(`${rel} is referenced but excluded by .vercelignore`);
    }
    for (const rel of srcFiles) if (ignored(rel)) throw new Error(`${rel} is excluded by .vercelignore`);
    return `${refs.size} referenced files + ${srcFiles.length} modules`;
});

// 8. Hosting config and crawler files.
check('vercel.json headers', () => {
    const cfg = JSON.parse(read('vercel.json'));
    if (!Array.isArray(cfg.headers)) throw new Error('missing headers array');
    const global = cfg.headers.find((h) => h.source === '/(.*)');
    const keys = new Set((global?.headers || []).map((h) => h.key));
    for (const k of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Permissions-Policy']) {
        if (!keys.has(k)) throw new Error(`global headers missing ${k}`);
    }
    for (const h of cfg.headers) {
        const files = h.source.match(/^\/\(([^)]+)\)$/)?.[1];
        if (!files || files === '.*') continue;
        for (const f of files.split('|')) if (!exists(f)) throw new Error(`header rule targets ${f}, which does not exist`);
    }
    return 'CSP, HSTS, nosniff, Permissions-Policy';
});

check('Strict CSP (no inline script without a pinned hash)', () => {
    // script-src carries no 'unsafe-inline'. The only executable inline script is
    // the import map, allowed by its SHA-256. Editing the import map without
    // updating vercel.json would blank the production site while every local test
    // still passed (the dev server sends no CSP), so the hash is enforced here.
    const csp = JSON.parse(read('vercel.json')).headers
        .find((h) => h.source === '/(.*)').headers
        .find((h) => h.key === 'Content-Security-Policy').value;
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src ')) || '';
    if (scriptSrc.includes("'unsafe-inline'")) throw new Error("script-src allows 'unsafe-inline'");
    if (/'unsafe-eval'/.test(scriptSrc)) throw new Error("script-src allows 'unsafe-eval'");
    const allowed = new Set([...scriptSrc.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]));
    let hashed = 0;
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        const [, attrs, body] = m;
        if (/\bsrc=/.test(attrs) || /type="application\/ld\+json"/.test(attrs)) continue;
        const digest = createHash('sha256').update(body, 'utf8').digest('base64');
        if (!allowed.has(digest)) {
            throw new Error(`inline <script${attrs}> is not allowed by the CSP; add 'sha256-${digest}' to script-src`);
        }
        hashed++;
    }
    const handler = html.match(/<[a-z][^>]*\son[a-z]+\s*=\s*["'][^>]*>/i);
    if (handler) throw new Error(`inline event handler would be blocked by the CSP: ${handler[0].slice(0, 80)}`);
    if (/javascript:/i.test(html)) throw new Error('javascript: URL would be blocked by the CSP');
    return `${hashed} inline script pinned by hash, 0 inline handlers`;
});

check('robots.txt, sitemap, manifest and icons', () => {
    if (!read('robots.txt').includes('User-agent: *')) throw new Error('robots.txt has no User-agent: * rule');
    const manifest = JSON.parse(read('manifest.json'));
    for (const field of ['name', 'short_name', 'start_url', 'display', 'icons']) {
        if (!(field in manifest)) throw new Error(`manifest.json missing "${field}"`);
    }
    for (const rel of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'og-image.jpg', 'sitemap.xml']) {
        if (!exists(rel)) throw new Error(`missing ${rel}`);
    }
    if (!html.includes('rel="manifest"')) throw new Error('index.html does not link the manifest');
    if (!html.includes('rel="apple-touch-icon"')) throw new Error('index.html does not link an apple-touch-icon');
});

if (failed) {
    console.error(`\nSTATIC AUDIT FAILED (${failed} check${failed === 1 ? '' : 's'})`);
    process.exit(1);
}
console.log('\nALL STATIC AUDIT CHECKS PASSED');
