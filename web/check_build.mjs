#!/usr/bin/env node
/* check_build.mjs — post-build smoke check for the WASM bundle.
 *
 * Run: node dusk/web/check_build.mjs [build-dir]
 *      default build-dir = dusk/build/web-emscripten/web
 *
 * Verifies the four artifacts emcc produces are present and shaped the way the
 * runtime expects: wasm starts with the magic bytes, the HTML shell had its
 * {{{ SCRIPT }}} placeholder substituted, the canvas + drop-zone wiring is
 * intact, and iso_bridge.js was copied alongside by the POST_BUILD command.
 *
 * Exits 0 on success, non-zero on any check failure. CI uses this as the
 * verify step in .github/workflows/web.yml.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const buildDir = resolve(process.argv[2] || join(__dirname, '..', 'build', 'web-emscripten', 'web'));

const failures = [];
function fail(msg) { failures.push(msg); console.error('FAIL: ' + msg); }
function ok(msg)   { console.log('ok:   ' + msg); }

function bytes(n) {
    if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n > 1e6) return (n / 1e6).toFixed(2) + ' MB';
    if (n > 1e3) return (n / 1e3).toFixed(2) + ' KB';
    return n + ' B';
}

console.log('check_build: build dir = ' + buildDir);
if (!existsSync(buildDir)) {
    fail('build directory does not exist');
    process.exit(1);
}

/* ── 1. All four artifacts exist with non-zero size ─────────────────── */

const expected = ['index.html', 'index.js', 'index.wasm', 'index.data', 'iso_bridge.js'];
const sizes = {};
for (const name of expected) {
    const p = join(buildDir, name);
    if (!existsSync(p)) {
        fail(`missing artifact: ${name}`);
        continue;
    }
    const s = statSync(p);
    if (s.size === 0) {
        fail(`zero-byte artifact: ${name}`);
        continue;
    }
    sizes[name] = s.size;
    ok(`${name.padEnd(15)} ${bytes(s.size)}`);
}

/* ── 2. wasm magic bytes ────────────────────────────────────────────── */

if (sizes['index.wasm']) {
    const head = readFileSync(join(buildDir, 'index.wasm')).subarray(0, 8);
    // Magic is "\0asm" (0x00 0x61 0x73 0x6d) followed by 4 little-endian
    // version bytes; version 1 = 0x01 0x00 0x00 0x00.
    const magicOk =
        head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    const versionOk =
        head[4] === 0x01 && head[5] === 0x00 && head[6] === 0x00 && head[7] === 0x00;
    if (!magicOk) fail('index.wasm does not start with wasm magic bytes (\\0asm)');
    else ok('wasm magic bytes correct');
    if (!versionOk) fail(`index.wasm version bytes unexpected: ${[...head.subarray(4,8)].map(b=>b.toString(16)).join(' ')}`);
    else ok('wasm version 1');
}

/* ── 3. HTML shell template substitution + key wiring ───────────────── */

if (sizes['index.html']) {
    const html = readFileSync(join(buildDir, 'index.html'), 'utf8');

    if (html.includes('{{{ SCRIPT }}}')) {
        fail('index.html still contains the un-substituted {{{ SCRIPT }}} token');
    } else {
        ok('shell {{{ SCRIPT }}} placeholder substituted');
    }

    // Canvas ID is what BackendBinding.cpp's SurfaceSourceCanvasHTMLSelector
    // selects ("#canvas"); a missing id="canvas" silently breaks WebGPU.
    if (!/<canvas[^>]*\bid=["']canvas["']/i.test(html)) {
        fail('index.html missing <canvas id="canvas">');
    } else {
        ok('canvas id="canvas" present');
    }

    // The shell must reference iso_bridge.js so the file picker can call it.
    if (!html.includes('iso_bridge.js')) {
        fail('index.html does not reference iso_bridge.js');
    } else {
        ok('shell references iso_bridge.js');
    }

    // emcc's loader appends a script tag for index.js where {{{ SCRIPT }}} was.
    if (!/index\.js/i.test(html)) {
        fail('index.html does not reference index.js (script tag substitution looks broken)');
    } else {
        ok('shell references index.js');
    }
}

/* ── 4. iso_bridge.js sanity (the runtime gate for first import) ────── */

if (sizes['iso_bridge.js']) {
    const js = readFileSync(join(buildDir, 'iso_bridge.js'), 'utf8');

    if (!js.includes('window.duskIsoImport')) {
        fail('iso_bridge.js does not assign window.duskIsoImport');
    } else {
        ok('iso_bridge.js exports window.duskIsoImport');
    }

    if (!js.includes('2601822a488eeb86fb89db16ca8f29c2c953e1ca')) {
        fail('iso_bridge.js does not contain the EUR EXPECTED_SHA1 — wrong copy?');
    } else {
        ok('iso_bridge.js carries pinned EUR SHA-1');
    }
}

/* ── Summary ────────────────────────────────────────────────────────── */

console.log('---');
if (failures.length === 0) {
    console.log(`check_build: PASS (${expected.length} artifacts, ${bytes(Object.values(sizes).reduce((a,b)=>a+b,0))} total)`);
    process.exit(0);
} else {
    console.error(`check_build: FAIL (${failures.length} check(s) failed)`);
    process.exit(1);
}
