/* Local ZIP/ZIP64 DDS packs. Only the bounded central directory and the one
 * requested texture are read. No archive extraction, upload, or OPFS copy.
 * Linked before pre.js, including in the render pthread (JSPI async reads).
 */
(function () {
    'use strict';
    const MAX_FILE = 64 * 1024 * 1024;
    const MAX_INDEX = 8 * 1024 * 1024;
    const MAX_ENTRIES = 60000;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[i] = c;
    }
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    function fail(message) { throw new Error('Texture pack: ' + message); }
    function range(offset, length, size) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
            offset < 0 || length < 0 || offset > size - length) fail('invalid ZIP range.');
    }
    async function slice(file, offset, length) {
        range(offset, length, file.size);
        if (length > MAX_INDEX) fail('index read exceeds the memory limit.');
        const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        if (bytes.length !== length) fail('truncated ZIP.');
        return bytes;
    }
    function uint64(view, offset) {
        const n = Number(view.getBigUint64(offset, true));
        if (!Number.isSafeInteger(n)) fail('ZIP64 offset is too large.');
        return n;
    }
    function nameOf(bytes) {
        // DDS keys are ASCII; UTF-8 folders are supported. Do not silently
        // reinterpret legacy codepage names as different filesystem paths.
        let name;
        try { name = decoder.decode(bytes).replace(/\\/g, '/'); }
        catch (_) { fail('file names must be ASCII or UTF-8.'); }
        if (name.length > 1024 || /[\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') ||
            name.split('/').some(p => p === '..' || p === '.')) fail('unsafe file name.');
        return name;
    }
    async function index(file) {
        if (!file || file.size < 22) fail('choose a ZIP containing DDS textures.');
        const tailStart = Math.max(0, file.size - 65557);
        const tail = await slice(file, tailStart, file.size - tailStart);
        const v = new DataView(tail.buffer);
        let end = -1;
        for (let p = tail.length - 22; p >= 0; p--) {
            if (v.getUint32(p, true) === 0x06054b50 && p + 22 + v.getUint16(p + 20, true) === tail.length) {
                end = p; break;
            }
        }
        if (end < 0) fail('not a complete ZIP (7z/RAR are not supported).');
        if (v.getUint16(end + 4, true) || v.getUint16(end + 6, true) ||
            v.getUint16(end + 8, true) !== v.getUint16(end + 10, true)) fail('split archives are not supported.');
        let count = v.getUint16(end + 10, true);
        let size = v.getUint32(end + 12, true);
        let offset = v.getUint32(end + 16, true);
        let directoryEnd = tailStart + end;
        if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) {
            const loc = new DataView((await slice(file, directoryEnd - 20, 20)).buffer);
            if (loc.getUint32(0, true) !== 0x07064b50 || loc.getUint32(4, true) ||
                loc.getUint32(16, true) !== 1) fail('invalid ZIP64 locator.');
            directoryEnd = uint64(loc, 8);
            const z = new DataView((await slice(file, directoryEnd, 56)).buffer);
            if (z.getUint32(0, true) !== 0x06064b50 || uint64(z, 4) < 44 ||
                z.getUint32(16, true) || z.getUint32(20, true) || uint64(z, 24) !== uint64(z, 32)) {
                fail('invalid ZIP64 directory.');
            }
            count = uint64(z, 32); size = uint64(z, 40); offset = uint64(z, 48);
        }
        if (count > MAX_ENTRIES || size > MAX_INDEX) fail('ZIP directory exceeds the supported limit.');
        range(offset, size, directoryEnd);
        const bytes = await slice(file, offset, size);
        const d = new DataView(bytes.buffer);
        const entries = [];
        const names = new Set();
        let p = 0;
        for (let i = 0; i < count; i++) {
            range(p, 46, size);
            if (d.getUint32(p, true) !== 0x02014b50) fail('invalid central directory.');
            const flags = d.getUint16(p + 8, true), method = d.getUint16(p + 10, true);
            const nameLen = d.getUint16(p + 28, true), extraLen = d.getUint16(p + 30, true);
            const length = 46 + nameLen + extraLen + d.getUint16(p + 32, true);
            range(p, length, size);
            const name = nameOf(bytes.subarray(p + 46, p + 46 + nameLen));
            let compressed = d.getUint32(p + 20, true), unpacked = d.getUint32(p + 24, true);
            let local = d.getUint32(p + 42, true), disk = d.getUint16(p + 34, true);
            let extra = p + 46 + nameLen;
            const extraEnd = extra + extraLen;
            while (extra < extraEnd) {
                range(extra, 4, extraEnd);
                const tag = d.getUint16(extra, true), n = d.getUint16(extra + 2, true);
                extra += 4; range(extra, n, extraEnd);
                if (tag === 1) {
                    let q = extra;
                    const next = () => { range(q, 8, extra + n); const value = uint64(d, q); q += 8; return value; };
                    if (unpacked === 0xffffffff) unpacked = next();
                    if (compressed === 0xffffffff) compressed = next();
                    if (local === 0xffffffff) local = next();
                    if (disk === 65535) { range(q, 4, extra + n); disk = d.getUint32(q, true); }
                }
                extra += n;
            }
            if (/\.dds$/i.test(name) && !name.startsWith('__MACOSX/')) {
                if (flags & (1 | 64) || disk) fail('encrypted or split textures are not supported.');
                if (method !== 0 && method !== 8) fail('use ZIP Store or Deflate compression.');
                if (!unpacked || unpacked > MAX_FILE || compressed > MAX_FILE) fail('a DDS exceeds the 64 MiB per-file limit.');
                if (method === 0 && compressed !== unpacked) fail('invalid stored texture size.');
                range(local, 30 + compressed, offset);
                if (names.has(name)) fail('duplicate texture path: ' + name);
                names.add(name);
                entries.push({ name, flags, method, compressed, unpacked, offset: local,
                    crc: d.getUint32(p + 16, true), directory: offset });
            }
            p += length;
        }
        if (!entries.length) fail('no DDS textures found. PNG-only packs are not supported.');
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        return { file, entries };
    }
    async function read(file, entry) {
        const header = new DataView((await slice(file, entry.offset, 30)).buffer);
        if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== entry.flags ||
            header.getUint16(8, true) !== entry.method) fail('local header differs from the directory.');
        const n = header.getUint16(26, true), extra = header.getUint16(28, true);
        const name = nameOf(await slice(file, entry.offset + 30, n));
        if (name !== entry.name) fail('local texture name differs from the directory.');
        const start = entry.offset + 30 + n + extra;
        range(start, entry.compressed, entry.directory);
        let stream = file.slice(start, start + entry.compressed).stream();
        if (entry.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = stream.getReader();
        // Fixed allocation, capped at 64 MiB; stop a lying/expanding archive
        // immediately rather than accumulating chunks with Response.arrayBuffer.
        const bytes = new Uint8Array(entry.unpacked);
        let written = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value.length > bytes.length - written) fail('expanded texture exceeds its declared size.');
                bytes.set(value, written); written += value.length;
            }
        } catch (err) { await reader.cancel().catch(() => {}); throw err; }
        finally { reader.releaseLock(); }
        if (written !== bytes.length || crc32(bytes) !== entry.crc) fail('texture checksum/size mismatch.');
        return bytes;
    }
    globalThis.DuskTexturePack = { index, read, crc32, MAX_FILE, MAX_INDEX };
})();
