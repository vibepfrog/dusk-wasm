import assert from 'node:assert/strict';
import test from 'node:test';
import './texture_pack.js';
import './pipeline_store.js';

const cache = globalThis.DuskPipelineStore;
function recipe(frame = 4, lo = 0x12345678) {
    const config = new Uint8Array(12);
    new DataView(config.buffer).setUint32(0, 2, true);
    return { type: 0, version: 2, lo, hi: 0, frame, config, crc: globalThis.DuskTexturePack.crc32(config) };
}
test('shader handoff preserves native little-endian bytes and first-use order', () => {
    const a = recipe(8), b = recipe(1, 8);
    const bytes = cache.encode([a, b]);
    assert.equal(Buffer.from(bytes.slice(0, 8)).toString(), 'DUSKPC01');
    const d = new DataView(bytes.buffer);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => d.getUint32(8 + i * 4, true)), [0, 2, 12, 1, 8, 0]);
    assert.deepEqual(bytes.slice(32, 44), b.config);
    assert.deepEqual(bytes.slice(68, 80), a.config);
});
test('corrupt, stale, malformed and excessive shader recipes are discarded', () => {
    const corrupt = recipe(); corrupt.config[8] ^= 1;
    assert.equal(cache.encode([corrupt, { ...recipe(), version: 4 }, { ...recipe(), type: 99 },
        { ...recipe(), hi: -1 }, { ...recipe(), config: new Uint8Array(9000) }]).length, 8);
    assert.equal(cache.encode(Array.from({ length: 11000 }, (_, i) => recipe(i, i))).length, 8 + 10000 * 36);
});
test('shader storage failure does not block play or touch campaign paths', async () => {
    const files = new Map();
    const store = cache.create({ indexedDB: { open() { throw new Error('test storage denied'); } }, FS: {
        mkdirTree() {}, writeFile(path, bytes) { files.set(path, bytes); }, unlink(path) { files.delete(path); },
    } });
    let status;
    store.subscribe(s => { status = s; });
    await store.initialize();
    store.startGame(true); store.record(0, 1, 0, 2, 1, recipe().config); store.flush();
    assert.match(status, /unavailable; gameplay can continue/);
    assert.equal(files.size, 0);
});
