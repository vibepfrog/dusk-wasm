/* web/iso_bridge.js — disc-image import for the Dusk WASM build.
 *
 * Walks a user-uploaded GameCube ISO of Twilight Princess (EUR), verifies it,
 * compresses it to CISO by dropping every 2 MB block the FST doesn't reference,
 * and writes the result to /iso/dusk.ciso (IDBFS-mounted by web/pre.js) so it
 * survives a page reload.
 *
 * The CISO converter (constants, buildFstBlockMap, isoToCiso) is ported from
 * slider's pc/web/shell-rom.js — the GC disc format is identical for AC and TP,
 * and Aurora's nod library natively reads CISO so no C-side work is needed.
 *
 * Exposes `window.duskIsoImport.importIso(file, { onProgress, onPhase })`.
 */
(function () {
    /* ── EUR Twilight Princess constants ────────────────────────────────── */
    // Game ID at disc header offset 0x00. "GZ2" is Twilight Princess's title
    // code (matches dusk/assets/GZ2E01). The 4th byte is region: "P" = PAL,
    // "E" = NTSC-U, "J" = NTSC-J. We only verify the title prefix here and let
    // EXPECTED_SHA1 below be the strict per-dump gate so the error messages can
    // distinguish "wrong game" from "wrong region or modified dump".
    var EXPECTED_TITLE_PREFIX = 'GZ2';
    // SHA-1 of the verified EUR ISO (see PLAN.md).
    var EXPECTED_SHA1 = '2601822a488eeb86fb89db16ca8f29c2c953e1ca';
    var CISO_OUT_PATH = '/iso/dusk.ciso';

    /* ── CISO format constants (from slider/pc/web/shell-rom.js) ────────── */
    var CISO_HEADER_SIZE = 0x8000;
    var CISO_BLOCK_SIZE  = 0x200000; // 2 MB
    var CISO_MAP_OFFSET  = 8;
    var CISO_MAX_BLOCKS  = CISO_HEADER_SIZE - CISO_MAP_OFFSET; // 32760

    function isCisoFile(headBytes) {
        return headBytes[0] === 0x43 && headBytes[1] === 0x49 &&
               headBytes[2] === 0x53 && headBytes[3] === 0x4F; // 'CISO'
    }
    async function readSlice(file, offset, length) {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }
    function beU32(arr, off) {
        return ((arr[off] << 24) | (arr[off + 1] << 16) |
                (arr[off + 2] << 8) | arr[off + 3]) >>> 0;
    }
    function bytesToHex(buf) {
        var view = new Uint8Array(buf);
        var s = '';
        for (var i = 0; i < view.length; i++) {
            var h = view[i].toString(16);
            if (h.length === 1) s += '0';
            s += h;
        }
        return s;
    }

    /* Walk the GC disc's FST and produce a `numBlocks`-long Uint8Array
     * marking which 2 MB blocks overlap any region the game actually
     * reads (disc header, DOL, FST, every FST-listed file). Blocks
     * outside those regions are guaranteed to be filler and safe to
     * drop. Without this, a scattered disc layout produces a CISO
     * nearly as large as the original ISO because each filler block
     * contains pseudo-random padding (not all-same-byte). */
    async function buildFstBlockMap(file, numBlocks) {
        var used = new Uint8Array(numBlocks);
        function markRange(start, end) {
            if (end > file.size) end = file.size;
            if (end <= start) return;
            var first = Math.floor(start / CISO_BLOCK_SIZE);
            var last  = Math.floor((end - 1) / CISO_BLOCK_SIZE);
            for (var b = first; b <= last && b < numBlocks; b++) {
                used[b] = 1;
            }
        }

        // Disc header occupies [0, 0x2440); also conservatively keep
        // the apploader region up to the DOL offset.
        var hdr = await readSlice(file, 0, 0x440);
        var dolOffset = beU32(hdr, 0x420);
        var fstOffset = beU32(hdr, 0x424);
        var fstSize   = beU32(hdr, 0x428);
        markRange(0, Math.max(0x2440, dolOffset));

        // DOL: read its header and compute the total DOL byte span.
        // GC DOL header has 7 text sections (offsets at 0x00, sizes at
        // 0x90) and 11 data sections (offsets at 0x1C, sizes at 0xAC).
        // The DOL ends at max(offset + size) across all sections.
        var dolHdr = await readSlice(file, dolOffset, 0x100);
        var dolEnd = dolOffset + 0x100;
        for (var i = 0; i < 7; i++) {
            var off  = beU32(dolHdr, 0x00 + i * 4);
            var size = beU32(dolHdr, 0x90 + i * 4);
            if (size > 0) dolEnd = Math.max(dolEnd, dolOffset + off + size);
        }
        for (var i = 0; i < 11; i++) {
            var off  = beU32(dolHdr, 0x1C + i * 4);
            var size = beU32(dolHdr, 0xAC + i * 4);
            if (size > 0) dolEnd = Math.max(dolEnd, dolOffset + off + size);
        }
        markRange(dolOffset, dolEnd);

        // FST itself.
        markRange(fstOffset, fstOffset + fstSize);

        // FST entries: 12 bytes each. Root entry at offset 0; its size
        // field (bytes 8-11) is the total entry count. Each file entry
        // has type=0 at byte 0, file offset at bytes 4-7, file size at
        // bytes 8-11. Directories (type=1) have no disc data of their
        // own.
        var fstBytes = await readSlice(file, fstOffset, fstSize);
        var numEntries = beU32(fstBytes, 0x08);
        for (var i = 1; i < numEntries; i++) {
            var entryOff = i * 12;
            if (fstBytes[entryOff] === 0) { // file
                var fileOff  = beU32(fstBytes, entryOff + 4);
                var fileSize = beU32(fstBytes, entryOff + 8);
                markRange(fileOff, fileOff + fileSize);
            }
        }
        return used;
    }

    /* Convert a raw .iso/.gcm Blob into CISO bytes. Uses the FST to
     * identify which 2 MB blocks the game actually reads and drops
     * everything else — GC discs typically contain ~95%+ filler that
     * the game never accesses. The CISO format returns 0x00 for absent
     * blocks; that's fine because dropped offsets are never queried by
     * the disc reader (it only follows FST entries). */
    async function isoToCiso(file, onProgress) {
        var isoSize = file.size;
        var numBlocks = Math.ceil(isoSize / CISO_BLOCK_SIZE);
        if (numBlocks > CISO_MAX_BLOCKS) {
            throw new Error('ISO too large to compress to CISO (max 64 GB at 2 MB blocks).');
        }
        var fstUsed = await buildFstBlockMap(file, numBlocks);
        var blockMap = new Uint8Array(CISO_MAX_BLOCKS);
        var presentBlocks = [];
        for (var i = 0; i < numBlocks; i++) {
            if (!fstUsed[i]) {
                if (onProgress) onProgress(i + 1, numBlocks);
                continue;
            }
            var start = i * CISO_BLOCK_SIZE;
            var end   = Math.min(start + CISO_BLOCK_SIZE, isoSize);
            var buf   = await readSlice(file, start, end - start);
            blockMap[i] = 1;
            if (buf.length < CISO_BLOCK_SIZE) {
                var padded = new Uint8Array(CISO_BLOCK_SIZE);
                padded.set(buf);
                presentBlocks.push(padded);
            } else {
                presentBlocks.push(buf);
            }
            if (onProgress) onProgress(i + 1, numBlocks);
            // Yield to the event loop every 8 blocks so the progress UI repaints.
            if ((i & 7) === 7) await new Promise(function (r) { setTimeout(r, 0); });
        }
        var totalSize = CISO_HEADER_SIZE + presentBlocks.length * CISO_BLOCK_SIZE;
        var out = new Uint8Array(totalSize);
        out[0] = 0x43; out[1] = 0x49; out[2] = 0x53; out[3] = 0x4F;
        new DataView(out.buffer).setUint32(4, CISO_BLOCK_SIZE, true);
        out.set(blockMap, CISO_MAP_OFFSET);
        var off = CISO_HEADER_SIZE;
        for (var k = 0; k < presentBlocks.length; k++) {
            out.set(presentBlocks[k], off);
            off += CISO_BLOCK_SIZE;
        }
        return out;
    }

    /* ── Verification ───────────────────────────────────────────────────── */

    async function verifyHeader(file) {
        var hdr = await readSlice(file, 0, 0x20);
        var titleCode = String.fromCharCode(hdr[0], hdr[1], hdr[2]);
        var region    = String.fromCharCode(hdr[3]);
        if (titleCode !== EXPECTED_TITLE_PREFIX) {
            throw new Error(
                'Wrong disc: header title code is "' + titleCode + '" but Dusk ' +
                'requires "' + EXPECTED_TITLE_PREFIX + '" (Twilight Princess).');
        }
        // Region byte is informational here; SHA-1 below is the actual EUR gate.
        return { titleCode: titleCode, region: region };
    }

    async function verifySha1(file) {
        // SubtleCrypto.digest only accepts a single ArrayBuffer — no incremental
        // chunked update API exists. So we load the whole ISO into memory once.
        // For TP EUR (~1.4 GB) this works on any 64-bit desktop browser; mobile
        // Safari may OOM and we let the throw propagate so the caller can fall
        // back to header-only verification.
        var buf = await file.arrayBuffer();
        var digestBuf = await crypto.subtle.digest('SHA-1', buf);
        var actual = bytesToHex(digestBuf);
        if (actual !== EXPECTED_SHA1) {
            throw new Error(
                'ISO SHA-1 mismatch.\n  expected: ' + EXPECTED_SHA1 +
                '\n  actual:   ' + actual +
                '\nThis dump is not the verified EUR ISO. Refusing to import.');
        }
    }

    /* ── Top-level import ───────────────────────────────────────────────── */

    /**
     * Import a user-uploaded ISO: verify it, convert to CISO, write to
     * /iso/dusk.ciso, persist to IndexedDB.
     *
     * @param {File|Blob} file the user-selected disc image
     * @param {{onProgress?: (cur:number,total:number)=>void,
     *          onPhase?: (phase:string)=>void}} [callbacks]
     * @returns {Promise<{cisoBytes:number, isoBytes:number}>}
     */
    async function importIso(file, callbacks) {
        callbacks = callbacks || {};
        function phase(name) { if (callbacks.onPhase) callbacks.onPhase(name); }

        phase('header-check');
        await verifyHeader(file);

        phase('sha1');
        await verifySha1(file);

        phase('ciso-convert');
        var cisoBytes = await isoToCiso(file, callbacks.onProgress);

        phase('write');
        // /iso is plain MEMFS — pre.js intentionally does NOT mount it as
        // IDBFS. Chrome's per-blob IndexedDB cap is ~1 GB and TP's CISO is
        // ~1054 MB, so persistence either fails outright or (worse) silently
        // truncates, which leaves a half-CISO that analyzePath reports as
        // existing but iso::inspect rejects. The upload is session-local; the
        // user re-uploads each session.
        FS.writeFile(CISO_OUT_PATH, cisoBytes);

        phase('done');
        return { cisoBytes: cisoBytes.length, isoBytes: file.size };
    }

    window.duskIsoImport = {
        importIso:             importIso,
        isCisoFile:            isCisoFile,
        readSlice:             readSlice,
        isoToCiso:             isoToCiso,
        verifyHeader:          verifyHeader,
        verifySha1:            verifySha1,
        EXPECTED_TITLE_PREFIX: EXPECTED_TITLE_PREFIX,
        EXPECTED_SHA1:         EXPECTED_SHA1,
        CISO_OUT_PATH:         CISO_OUT_PATH,
        CISO_HEADER_SIZE:      CISO_HEADER_SIZE,
    };
})();
