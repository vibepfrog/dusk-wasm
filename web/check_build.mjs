#!/usr/bin/env node
/* Post-build smoke checks for the threaded WebAssembly bundle. */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(process.argv[2] || join(__dirname, '..', 'build', 'web-emscripten-fast', 'web'));
const failures = [];

function fail(message) { failures.push(message); console.error('FAIL: ' + message); }
function ok(message) { console.log('ok:   ' + message); }
function bytes(value) {
    if (value > 1e9) return (value / 1e9).toFixed(2) + ' GB';
    if (value > 1e6) return (value / 1e6).toFixed(2) + ' MB';
    if (value > 1e3) return (value / 1e3).toFixed(2) + ' KB';
    return value + ' B';
}

console.log('check_build: build dir = ' + buildDir);
if (!existsSync(buildDir)) {
    fail('build directory does not exist');
    process.exit(1);
}

const expected = [
    'index.html', 'index.js', 'index.wasm', 'index.data',
    'iso_bridge.js', 'coi-serviceworker.js', '_headers',
];
const sizes = {};
for (const name of expected) {
    const path = join(buildDir, name);
    if (!existsSync(path)) {
        fail('missing artifact: ' + name);
        continue;
    }
    const size = statSync(path).size;
    if (size === 0) {
        fail('zero-byte artifact: ' + name);
        continue;
    }
    sizes[name] = size;
    ok(name.padEnd(15) + ' ' + bytes(size));
}

if (sizes['index.wasm']) {
    const wasm = readFileSync(join(buildDir, 'index.wasm'));
    const head = wasm.subarray(0, 8);
    const magicOk = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    const versionOk = head[4] === 0x01 && head[5] === 0 && head[6] === 0 && head[7] === 0;
    if (!magicOk) fail('index.wasm does not start with wasm magic bytes');
    else ok('wasm magic bytes correct');
    if (!versionOk) fail('index.wasm is not version 1');
    else ok('wasm version 1');

    // Aurora uses synchronous WebGPU WaitAny() during adapter/device startup.
    // Emdawnwebgpu can only provide that bridge when Asyncify or JSPI is
    // enabled. This build deliberately uses Asyncify because JSPI is not yet
    // available in every target browser and conflicts with our exception mode.
    const asyncifyMarker = Buffer.from('asyncify_start_unwind');
    if (!wasm.includes(asyncifyMarker)) fail('index.wasm is missing Asyncify support required by WebGPU WaitAny');
    else ok('Asyncify WebGPU wait support present');
}

if (sizes['index.html']) {
    const html = readFileSync(join(buildDir, 'index.html'), 'utf8');
    if (html.includes('{{{ SCRIPT }}}')) fail('shell script placeholder was not substituted');
    else ok('shell script placeholder substituted');

    if (!/<canvas[^>]*\bid=(?:["']canvas["']|canvas(?:\s|>))/i.test(html)) {
        fail('index.html is missing the canvas id');
    } else ok('canvas id present');

    if (!html.includes('iso_bridge.js')) fail('shell does not reference iso_bridge.js');
    else ok('shell references iso_bridge.js');
    if (!html.includes('coi-serviceworker.js')) fail('shell does not reference the isolation fallback');
    else ok('shell references the isolation fallback');
    if (!/index\.js/i.test(html)) fail('shell does not reference index.js');
    else ok('shell references index.js');

    if (!html.includes('crossOriginIsolated') || !html.includes('SharedArrayBuffer')) {
        fail('shell is missing the cross-origin isolation runtime guard');
    } else ok('cross-origin isolation runtime guard present');
}

if (sizes['coi-serviceworker.js']) {
    const worker = readFileSync(join(buildDir, 'coi-serviceworker.js'), 'utf8');
    for (const header of [
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Embedder-Policy',
        'Cross-Origin-Resource-Policy',
    ]) {
        if (!worker.includes(header)) fail('isolation worker is missing ' + header);
        else ok('isolation worker sets ' + header);
    }
}

if (sizes['index.js']) {
    const loader = readFileSync(join(buildDir, 'index.js'), 'utf8');
    const sharedMemory = /new WebAssembly\.Memory\(\{[^}]*["']?shared["']?\s*:\s*(?:true|!0)\b[^}]*\}\)/.test(loader);
    if (!sharedMemory) fail('loader does not construct shared WebAssembly.Memory');
    else ok('loader constructs shared WebAssembly.Memory');

    if (!loader.includes('new Worker(pthreadMainJs') || !loader.includes('PThread')) {
        fail('loader is missing the pthread worker bootstrap');
    } else ok('pthread worker bootstrap present');

    const boundedMarkers = ['BroadcastChannel', '__duskDiscFile', 'FileReaderSync', '4194304'];
    for (const marker of boundedMarkers) {
        if (!loader.includes(marker)) fail('loader is missing bounded disc marker: ' + marker);
        else ok('bounded disc marker present: ' + marker);
    }
}

if (sizes['iso_bridge.js']) {
    const bridge = readFileSync(join(buildDir, 'iso_bridge.js'), 'utf8');
    for (const marker of ['window.duskIsoImport', 'GZ2E01', 'GZ2P01', "CISO_MAGIC = 'CISO'", '/dusk/browser-disc']) {
        if (!bridge.includes(marker)) fail('iso_bridge.js is missing marker: ' + marker);
        else ok('iso_bridge.js marker present: ' + marker);
    }
    if (bridge.includes('file.arrayBuffer()')) fail('iso_bridge.js performs a whole-file read');
    else ok('iso_bridge.js has no whole-file arrayBuffer read');
    if (bridge.includes('FS.writeFile')) fail('iso_bridge.js copies the disc into MEMFS');
    else ok('iso_bridge.js has no MEMFS disc copy');
}

if (sizes['_headers']) {
    const headers = readFileSync(join(buildDir, '_headers'), 'utf8');
    const required = [
        'Cross-Origin-Opener-Policy: same-origin',
        'Cross-Origin-Embedder-Policy: require-corp',
        'Cross-Origin-Resource-Policy: same-origin',
    ];
    for (const header of required) {
        if (!headers.includes(header)) fail('_headers is missing ' + header);
        else ok('_headers contains ' + header);
    }
}

console.log('---');
if (failures.length) {
    console.error('check_build: FAIL (' + failures.length + ' check(s) failed)');
    process.exit(1);
}

const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
console.log('check_build: PASS (' + expected.length + ' artifacts, ' + bytes(total) + ' total)');
