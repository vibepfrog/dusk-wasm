/* Disposable shader recipes, separate from campaign IDBFS. No GPU binaries or
 * disc assets are stored. Schema/config versions are checked again in C++.
 */
(function () {
    'use strict';
    const MAX_BYTES = 16 * 1024 * 1024, MAX_RECORDS = 10000, MAX_CONFIG = 8192;
    const MAGIC = new Uint8Array([68, 85, 83, 75, 80, 67, 48, 49]); // DUSKPC01
    function valid(r) {
        return r && (r.type === 0 || r.type === 1) && r.config instanceof Uint8Array &&
            r.config.length >= 4 && r.config.length <= MAX_CONFIG &&
            new DataView(r.config.buffer, r.config.byteOffset, 4).getUint32(0, true) === r.version &&
            r.crc === globalThis.DuskTexturePack.crc32(r.config) &&
            [r.lo, r.hi, r.frame, r.version].every(x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff);
    }
    function encode(records) {
        const selected = [];
        let size = 8;
        for (const r of records) {
            if (!valid(r) || selected.length >= MAX_RECORDS || size + 24 + r.config.length > MAX_BYTES) continue;
            selected.push(r); size += 24 + r.config.length;
        }
        selected.sort((a, b) => a.frame - b.frame);
        const bytes = new Uint8Array(size); bytes.set(MAGIC);
        const d = new DataView(bytes.buffer);
        let p = 8;
        for (const r of selected) {
            [r.type, r.version, r.config.length, r.frame, r.lo, r.hi].forEach((v, i) => d.setUint32(p + 4 * i, v, true));
            bytes.set(r.config, p + 24); p += 24 + r.config.length;
        }
        return bytes;
    }
    function create(options) {
        let db, timer, disabled = false, totalBytes = 0;
        const records = new Map(), pending = new Map(), removals = new Set();
        const listeners = new Set();
        let message = 'Opening shader cache…';
        function status(text) { message = text; listeners.forEach(fn => fn(text)); }
        function unavailable(err) {
            disabled = true; pending.clear(); removals.clear();
            status('Shader cache unavailable; gameplay can continue.');
            console.warn('[dusk] Shader cache:', String(err));
        }
        function flush() {
            clearTimeout(timer);
            timer = null;
            if (!db || disabled || (!pending.size && !removals.size)) return;
            try {
                const tx = db.transaction('recipes', 'readwrite');
                const store = tx.objectStore('recipes');
                for (const key of removals) store.delete(key);
                for (const r of pending.values()) store.put(r);
                removals.clear(); pending.clear();
                tx.onerror = () => unavailable(tx.error);
                tx.onabort = () => unavailable(tx.error);
                tx.oncomplete = () => status(records.size + ' shader recipes saved for next time.');
            } catch (err) { unavailable(err); }
        }
        function record(type, lo, hi, version, frame, bytes) {
            if (disabled || !db || bytes.length > MAX_CONFIG) return;
            const config = bytes.slice();
            const key = type + ':' + lo + ':' + hi;
            const r = { key, type, lo, hi, version, frame, config, crc: globalThis.DuskTexturePack.crc32(config) };
            if (!valid(r)) return;
            const previous = records.get(key);
            if (previous) totalBytes -= previous.config.length + 24;
            records.delete(key); records.set(key, r); removals.delete(key);
            totalBytes += config.length + 24; pending.set(key, r);
            while (records.size > MAX_RECORDS || totalBytes > MAX_BYTES - 8) {
                const oldest = records.keys().next().value;
                totalBytes -= records.get(oldest).config.length + 24;
                records.delete(oldest); pending.delete(oldest); removals.add(oldest);
            }
            if (!timer) timer = setTimeout(flush, 1000);
        }
        async function initialize() {
            try {
                db = await new Promise((resolve, reject) => {
                    const request = options.indexedDB.open('dusk-shader-recipes-v1', 1);
                    let expired = false;
                    const timeout = setTimeout(() => { expired = true; reject(new Error('Opening shader storage timed out.')); }, 5000);
                    request.onupgradeneeded = () => request.result.createObjectStore('recipes', { keyPath: 'key' });
                    request.onsuccess = () => {
                        clearTimeout(timeout);
                        if (expired) request.result.close(); else resolve(request.result);
                    };
                    request.onerror = request.onblocked = () => { clearTimeout(timeout); reject(request.error || new Error('Shader storage is blocked.')); };
                });
                db.onversionchange = () => { db.close(); unavailable('Shader storage changed in another tab.'); };
                // Cursor limits bound memory even if older storage is oversized.
                await new Promise((resolve, reject) => {
                    const tx = db.transaction('recipes', 'readonly');
                    const req = tx.objectStore('recipes').openCursor();
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) return;
                        const r = cursor.value;
                        if (valid(r) && records.size < MAX_RECORDS && totalBytes + r.config.length + 24 <= MAX_BYTES - 8) {
                            records.set(r.key, r); totalBytes += r.config.length + 24;
                        }
                        cursor.continue();
                    };
                    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
                });
                options.FS.mkdirTree('/dusk');
                options.FS.writeFile('/dusk/pipeline-recipes.bin', encode(records.values()));
                status(records.size ? records.size + ' saved shaders ready to prepare.' : 'Shaders will be remembered as you play.');
            } catch (err) { unavailable(err); }
        }
        function startGame(warm) {
            if (warm && !disabled) {
                options.FS.writeFile('/dusk/pipeline-recipes.bin', encode(records.values()));
            } else {
                try { options.FS.unlink('/dusk/pipeline-recipes.bin'); } catch (_) {}
            }
        }
        return { initialize, record, flush, startGame, status,
            subscribe(fn) { listeners.add(fn); fn(message); return () => listeners.delete(fn); } };
    }
    globalThis.DuskPipelineStore = { create, encode, valid, MAX_BYTES, MAX_RECORDS };
})();
