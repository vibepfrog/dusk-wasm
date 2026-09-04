/* web/iso_bridge.js — bounded browser disc-image handoff for Dusk.
 *
 * The selected File remains outside the WebAssembly heap. The pthread workers
 * receive the browser File handle and nod reads it in bounded slices through
 * FileReaderSync. Full disc validation is deliberately left to native Dusk so
 * raw ISO/GCM and CISO follow the same trusted parsing and hashing path.
 */
(function () {
    'use strict';

    var SUPPORTED_DISC_IDS = ['GZ2E01', 'GZ2P01'];
    var CISO_MAGIC = 'CISO';
    var DISC_PATH = '/dusk/browser-disc';

    async function readSlice(file, offset, length) {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }

    function bytesToAscii(bytes, count) {
        var value = '';
        for (var i = 0; i < count; i++) value += String.fromCharCode(bytes[i]);
        return value;
    }

    async function verifyHeader(file) {
        if (!file || typeof file.slice !== 'function' || typeof file.size !== 'number') {
            throw new Error('Choose a GameCube ISO, GCM, or CISO file.');
        }
        if (file.size < 0x440) {
            throw new Error('Disc image is too small to contain a GameCube header.');
        }

        // This is the only main-thread disc read. For CISO the logical disc
        // header lives in compressed blocks, so nod resolves and validates it.
        var header = await readSlice(file, 0, 0x20);
        var magic = bytesToAscii(header, 4);
        if (magic === CISO_MAGIC) {
            return { discId: null, titleCode: null, region: null, format: 'ciso' };
        }

        var discId = bytesToAscii(header, 6);
        if (SUPPORTED_DISC_IDS.indexOf(discId) === -1) {
            throw new Error(
                'Unsupported disc ID "' + discId + '". Dusk currently supports ' +
                'Twilight Princess USA (GZ2E01) and EUR (GZ2P01).');
        }

        return {
            discId: discId,
            titleCode: discId.slice(0, 3),
            region: discId[3],
            format: 'iso',
        };
    }

    /**
     * Validate the outer container and make the selected File available to all
     * pthread workers. Native Dusk performs the authoritative logical disc ID
     * and XXH3 validation when callMain opens DISC_PATH.
     */
    async function importIso(file, callbacks) {
        callbacks = callbacks || {};
        function phase(name) {
            if (callbacks.onPhase) callbacks.onPhase(name);
        }

        phase('header-check');
        var info = await verifyHeader(file);

        if (!window.Module || typeof window.Module.duskSetDiscFile !== 'function') {
            throw new Error('Dusk worker runtime is not ready. Reload the page and try again.');
        }

        phase('worker-handoff');
        var workers = await window.Module.duskSetDiscFile(file);

        phase('done');
        return {
            discId: info.discId,
            format: info.format,
            isoBytes: file.size,
            path: DISC_PATH,
            workers: workers,
        };
    }

    window.duskIsoImport = {
        SUPPORTED_DISC_IDS: SUPPORTED_DISC_IDS,
        CISO_MAGIC: CISO_MAGIC,
        DISC_PATH: DISC_PATH,
        readSlice: readSlice,
        verifyHeader: verifyHeader,
        importIso: importIso,
    };
})();
