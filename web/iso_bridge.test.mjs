/* iso_bridge.test.mjs — Node-based test for web/iso_bridge.js
 *
 * Run: node dusk/web/iso_bridge.test.mjs
 *      (requires Node 18+ for global Blob and crypto.subtle)
 *
 * iso_bridge.js is browser code (IIFE assigning window.duskIsoImport). We load
 * it into a vm context with shims for `window`, `FS`, and a few globals so the
 * exported functions can be exercised directly against the real EUR ISO. No
 * production-side changes are needed.
 *
 * Tests:
 *   1. verifyHeader accepts the real ISO (game ID "RZDP")
 *   2. verifyHeader rejects a fake header
 *   3. verifySha1 matches the pinned EXPECTED_SHA1 (= 2601822a...)
 *   4. isoToCiso produces a CISO with valid magic, block size, and a non-zero
 *      number of present blocks; the result is much smaller than the ISO
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const ISO_PATH        = 'C:/Users/shift/Desktop/dusk-wasm/The Legend of Zelda - Twilight Princess (E).iso';
const ISO_BRIDGE_PATH = join(__dirname, 'iso_bridge.js');

/* ── Load iso_bridge.js into a vm context with browser-global shims ──── */

const isoBridgeSrc = readFileSync(ISO_BRIDGE_PATH, 'utf8');
const fakeWindow = {};
const ctx = vm.createContext({
    window:    fakeWindow,
    crypto:    globalThis.crypto,           // Node 18+ has crypto.subtle
    setTimeout, clearTimeout,
    console,
    Promise, Math, String, Number, DataView, Uint8Array, ArrayBuffer, Error,
    // FS is only used by importIso (not under test here); leave it out so any
    // accidental use throws loudly.
});
vm.runInContext(isoBridgeSrc, ctx, { filename: 'iso_bridge.js' });
const bridge = fakeWindow.duskIsoImport;
assert.ok(bridge, 'iso_bridge.js did not populate window.duskIsoImport');

/* ── ISO file → Blob (lazily once, shared across tests) ──────────────── */

let isoBlob = null;
function loadIso() {
    if (isoBlob) return isoBlob;
    const buf = readFileSync(ISO_PATH);
    // Node's global Blob accepts a Buffer; .slice() and .arrayBuffer() work
    // the same as in the browser.
    isoBlob = new Blob([buf]);
    return isoBlob;
}

/* ── Tests ──────────────────────────────────────────────────────────── */

test('verifyHeader accepts the real EUR ISO', async () => {
    const file = loadIso();
    await bridge.verifyHeader(file);
});

test('verifyHeader rejects a wrong-title-code dump', async () => {
    // Fake a 32-byte header with title code "AAA" (anything non-GZ2).
    const fakeHdr = new Uint8Array(0x40);
    fakeHdr[0] = 0x41; fakeHdr[1] = 0x41; fakeHdr[2] = 0x41; fakeHdr[3] = 0x41;
    const fake = new Blob([fakeHdr]);
    await assert.rejects(
        bridge.verifyHeader(fake),
        /Wrong disc.*GZ2/,
        'verifyHeader should refuse non-GZ2 title codes',
    );
});

test('verifyHeader returns titleCode + region for the real ISO', async () => {
    const file = loadIso();
    const info = await bridge.verifyHeader(file);
    assert.equal(info.titleCode, 'GZ2');
    assert.equal(info.region, 'P', 'EUR ISO must report region "P" (PAL)');
});

test('verifySha1 matches the pinned EXPECTED_SHA1', { timeout: 120_000 }, async () => {
    const file = loadIso();
    await bridge.verifySha1(file);
});

test('isoToCiso produces a well-formed CISO smaller than the ISO',
     { timeout: 600_000 }, async () => {
    const file = loadIso();

    let lastProgress = 0;
    const ciso = await bridge.isoToCiso(file, (cur, total) => {
        // Sanity-check progress monotonicity; not strictly required but cheap.
        assert.ok(cur >= lastProgress, `progress went backwards: ${cur} < ${lastProgress}`);
        lastProgress = cur;
    });

    // CISO header layout: 'CISO' magic at [0..4], block-size LE u32 at [4..8],
    // then a CISO_MAX_BLOCKS-byte map. Present blocks are appended after the
    // header in their original order.
    assert.equal(ciso[0], 0x43, 'magic[0] must be C');
    assert.equal(ciso[1], 0x49, 'magic[1] must be I');
    assert.equal(ciso[2], 0x53, 'magic[2] must be S');
    assert.equal(ciso[3], 0x4F, 'magic[3] must be O');

    const dv = new DataView(ciso.buffer, ciso.byteOffset, ciso.byteLength);
    const blockSize = dv.getUint32(4, true);
    assert.equal(blockSize, 0x200000, 'block size must be 2 MiB (LE u32)');

    // Count present blocks from the map and cross-check against the trailer length.
    const headerSize = bridge.CISO_HEADER_SIZE; // 0x8000
    let presentCount = 0;
    for (let i = 8; i < headerSize; i++) {
        if (ciso[i] === 1) presentCount++;
        else assert.equal(ciso[i], 0, `map byte ${i} must be 0 or 1, got ${ciso[i]}`);
    }
    assert.ok(presentCount > 0, 'CISO must contain at least one present block');

    const trailerBytes = ciso.length - headerSize;
    assert.equal(trailerBytes, presentCount * blockSize,
        `trailer size ${trailerBytes} should be ${presentCount}*${blockSize}`);

    // FST-driven compression: TP fills more of the disc than AC but should
    // still drop a substantial fraction. Slider expected 5-15% for AC; TP is
    // heavier but should still be well under the original size.
    const isoBytes = file.size;
    const ratio = ciso.length / isoBytes;
    assert.ok(ratio < 0.95,
        `CISO/ISO ratio ${ratio.toFixed(3)} suggests FST walk found nothing to drop`);

    console.log(`    [iso_bridge] ISO ${(isoBytes / 1e6).toFixed(1)} MB → ` +
                `CISO ${(ciso.length / 1e6).toFixed(1)} MB ` +
                `(${(ratio * 100).toFixed(1)}%, ${presentCount} present blocks)`);
});
