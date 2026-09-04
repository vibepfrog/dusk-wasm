/* Regression tests for the bounded browser disc-image handoff.
 * Run with: node --test web/iso_bridge.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, 'iso_bridge.js'), 'utf8');

let handedOffFile = null;
let handoffCount = 0;
const fakeWindow = {
    Module: {
        async duskSetDiscFile(file) {
            handedOffFile = file;
            handoffCount++;
            return 6;
        },
    },
};
const context = vm.createContext({
    window: fakeWindow,
    Promise,
    String,
    Uint8Array,
    Error,
});
vm.runInContext(source, context, { filename: 'iso_bridge.js' });
const bridge = fakeWindow.duskIsoImport;
assert.ok(bridge, 'iso_bridge.js did not populate window.duskIsoImport');

function makeImageFile(prefix, reportedSize, name) {
    const bytes = new Uint8Array(0x440);
    for (let i = 0; i < prefix.length; i++) bytes[i] = prefix.charCodeAt(i);

    const reads = [];
    const file = {
        name,
        size: reportedSize,
        slice(start, end) {
            reads.push({ start, end });
            const part = bytes.slice(start, Math.min(end, bytes.length));
            return { async arrayBuffer() { return part.buffer; } };
        },
    };
    return { file, reads };
}

function makeDiscFile(discId, size = 1_459_978_240) {
    return makeImageFile(discId, size, discId + '.iso');
}

function makeCisoFile(size = 1_054_900_000) {
    return makeImageFile('CISO', size, 'twilight-princess.ciso');
}

function resetHandoff() {
    handedOffFile = null;
    handoffCount = 0;
}

test('accepts the EUR raw disc ID with one 32-byte read', async () => {
    const { file, reads } = makeDiscFile('GZ2P01');
    const info = await bridge.verifyHeader(file);
    assert.deepEqual({ ...info }, {
        discId: 'GZ2P01', titleCode: 'GZ2', region: 'P', format: 'iso',
    });
    assert.deepEqual(reads, [{ start: 0, end: 0x20 }]);
});

test('accepts the USA raw disc ID with one 32-byte read', async () => {
    const { file, reads } = makeDiscFile('GZ2E01');
    const info = await bridge.verifyHeader(file);
    assert.deepEqual({ ...info }, {
        discId: 'GZ2E01', titleCode: 'GZ2', region: 'E', format: 'iso',
    });
    assert.deepEqual(reads, [{ start: 0, end: 0x20 }]);
});

test('recognizes CISO and defers logical disc validation to nod', async () => {
    const { file, reads } = makeCisoFile();
    const info = await bridge.verifyHeader(file);
    assert.deepEqual({ ...info }, {
        discId: null, titleCode: null, region: null, format: 'ciso',
    });
    assert.deepEqual(reads, [{ start: 0, end: 0x20 }]);
});

test('rejects another GameCube title', async () => {
    const { file } = makeDiscFile('GM8E01');
    await assert.rejects(bridge.verifyHeader(file), /Unsupported disc ID.*GZ2E01.*GZ2P01/);
});

test('hands a synthetic 1.4 GB raw File to workers without copying it', async () => {
    resetHandoff();
    const { file, reads } = makeDiscFile('GZ2E01');
    const phases = [];
    const result = await bridge.importIso(file, { onPhase: phase => phases.push(phase) });

    assert.equal(handedOffFile, file, 'the original File object must be handed off');
    assert.equal(handoffCount, 1);
    assert.deepEqual(reads, [{ start: 0, end: 0x20 }]);
    assert.deepEqual(phases, ['header-check', 'worker-handoff', 'done']);
    assert.equal(result.path, '/dusk/browser-disc');
    assert.equal(result.workers, 6);
    assert.equal(result.isoBytes, 1_459_978_240);
});

test('hands a 1 GB CISO to workers without expansion or a whole-file read', async () => {
    resetHandoff();
    const { file, reads } = makeCisoFile();
    const result = await bridge.importIso(file);

    assert.equal(handedOffFile, file);
    assert.deepEqual(reads, [{ start: 0, end: 0x20 }]);
    assert.equal(result.format, 'ciso');
    assert.equal(result.discId, null);
    assert.equal(result.isoBytes, 1_054_900_000);
});

test('rejects a truncated file before worker handoff or any read', async () => {
    resetHandoff();
    const { file, reads } = makeImageFile('GZ2E01', 128, 'truncated.iso');
    await assert.rejects(bridge.importIso(file), /too small/);
    assert.equal(handoffCount, 0);
    assert.deepEqual(reads, []);
});
