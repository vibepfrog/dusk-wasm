import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import './texture_pack.js';

const pack = globalThis.DuskTexturePack;

// A sparse browser File stand-in makes real offsets above 4 GiB testable
// without allocating or downloading a multi-gigabyte fixture.
export function zipFixture({ method = 8, zip64 = false, name = 'textures/tex1_4x4_0123456789abcdef_14.dds',
    flags = 0, unpacked, badCrc = false, payload = Buffer.alloc(1024, 42), extraSize = 0 } = {}) {
    const compressed = method === 8 ? deflateRawSync(payload) : payload;
    const filename = Buffer.from(name), checksum = crc32(payload) ^ (badCrc ? 1 : 0);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum >>> 0, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(unpacked ?? payload.length, 22); local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extraSize, 28); filename.copy(local, 30);
    const offset = zip64 ? 0x100000123 : 0;
    const centralOffset = offset + local.length + extraSize + compressed.length;
    const central = Buffer.alloc(46 + filename.length + (zip64 ? 28 : 0));
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : unpacked ?? payload.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt16LE(zip64 ? 28 : 0, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42); filename.copy(central, 46);
    if (zip64) {
        const p = 46 + filename.length;
        central.writeUInt16LE(1, p); central.writeUInt16LE(24, p + 2);
        central.writeBigUInt64LE(BigInt(unpacked ?? payload.length), p + 4);
        central.writeBigUInt64LE(BigInt(compressed.length), p + 12);
        central.writeBigUInt64LE(BigInt(offset), p + 20);
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(zip64 ? 65535 : 1, 8); end.writeUInt16LE(zip64 ? 65535 : 1, 10);
    end.writeUInt32LE(zip64 ? 0xffffffff : central.length, 12);
    end.writeUInt32LE(zip64 ? 0xffffffff : centralOffset, 16);
    let trailer = end;
    if (zip64) {
        const z = Buffer.alloc(56), loc = Buffer.alloc(20);
        z.writeUInt32LE(0x06064b50); z.writeBigUInt64LE(44n, 4);
        z.writeBigUInt64LE(1n, 24); z.writeBigUInt64LE(1n, 32);
        z.writeBigUInt64LE(BigInt(central.length), 40); z.writeBigUInt64LE(BigInt(centralOffset), 48);
        loc.writeUInt32LE(0x07064b50); loc.writeBigUInt64LE(BigInt(centralOffset + central.length), 8);
        loc.writeUInt32LE(1, 16); trailer = Buffer.concat([z, loc, end]);
    }
    const segments = [[offset, local], [offset + local.length + extraSize, compressed],
        [centralOffset, central], [centralOffset + central.length, trailer]];
    const reads = [];
    return { size: centralOffset + central.length + trailer.length, reads, payload,
        slice(start, finish) {
            assert.ok(finish - start <= pack.MAX_INDEX, 'no whole archive or unbounded reads');
            reads.push([start, finish]);
            const bytes = Buffer.alloc(finish - start);
            for (const [at, data] of segments) {
                const lo = Math.max(start, at), hi = Math.min(finish, at + data.length);
                if (hi > lo) data.copy(bytes, lo - start, lo - at, hi - at);
            }
            return new Blob([bytes]);
        },
    };
}

for (const method of [0, 8]) test('reads stored/deflated ZIP method ' + method + ' byte-for-byte', async () => {
    const file = zipFixture({ method, extraSize: 12 });
    const result = await pack.index(file);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(Buffer.from(await pack.read(file, result.entries[0])), file.payload);
});

test('ZIP64 seeks above 4 GiB with bounded reads and no archive-sized allocation', async () => {
    const file = zipFixture({ zip64: true });
    const result = await pack.index(file);
    assert.ok(result.entries[0].offset > 0xffffffff);
    assert.deepEqual(Buffer.from(await pack.read(file, result.entries[0])), file.payload);
    assert.ok(file.reads.reduce((n, [a, b]) => n + b - a, 0) < 70000);
});

test('rejects traversal, encryption, unsupported codecs, oversized entries, and non-DDS packs', async () => {
    for (const options of [{ name: '../bad.dds' }, { name: '/bad.dds' }, { name: 'C:\\bad.dds' },
        { flags: 1 }, { method: 12 }, { unpacked: 64 * 1024 * 1024 + 1 }, { name: 'textures.png' }]) {
        await assert.rejects(pack.index(zipFixture(options)), /Texture pack:/);
    }
    await assert.rejects(pack.index(new Blob([Buffer.alloc(128)])), /not a complete ZIP/);
});

test('rejects corrupted and expanding textures before handing any bytes to native code', async () => {
    for (const options of [{ badCrc: true }, { unpacked: 8 }, { unpacked: 4096 }]) {
        const file = zipFixture(options), result = await pack.index(file);
        await assert.rejects(pack.read(file, result.entries[0]), /Texture pack:/);
    }
});

test('CRC32 matches the independent zlib implementation', () => {
    const bytes = Buffer.from('123456789');
    assert.equal(pack.crc32(bytes), 0xcbf43926);
    assert.equal(pack.crc32(bytes), crc32(bytes));
});

test('disc and pack handles reach every pthread before native startup', async () => {
    const channels = [], files = new Map();
    class Channel {
        constructor(name) { this.name = name; channels.push(this); }
        postMessage(data) {
            for (const other of channels) if (other !== this && other.name === this.name) {
                queueMicrotask(() => other.onmessage?.({ data }));
            }
        }
    }
    const source = readFileSync(new URL('./pre.js', import.meta.url), 'utf8');
    const shared = { BroadcastChannel: Channel, URLSearchParams, setTimeout, clearTimeout };
    const main = { ...shared, Module: { duskDiscChannel: 'test-pack-handoff' },
        PThread: { unusedWorkers: [1, 2, 3], runningWorkers: [] },
        FS: { mkdirTree() {}, writeFile(path, data) { files.set(path, data); } } };
    runInNewContext(source, main);
    const workers = [1, 2, 3].map(id => {
        const context = { ...shared, ENVIRONMENT_IS_PTHREAD: true, Module: {},
            location: { search: '?duskDiscChannel=test-pack-handoff' }, crypto: { randomUUID: () => String(id) } };
        runInNewContext(source, context); return context;
    });
    main.Module.duskSelectedPack = await pack.index(zipFixture());
    const disc = new Blob(['CISO']);
    assert.equal(await main.Module.duskSetDiscFile(disc), 3);
    for (const worker of workers) {
        assert.equal(worker.__duskDiscFile, disc);
        assert.equal(worker.__duskTexturePack.entries.size, 1);
        assert.equal(worker.__duskTexturePack.file, main.Module.duskSelectedPack.file);
    }
    assert.equal(files.size, 1);
    assert.match(files.get('/dusk/texture-pack-index.txt'), /^textures\/tex1_/);
});
