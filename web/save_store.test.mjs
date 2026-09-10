import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';

const context = { Uint8Array, Map, Promise, Date };
runInNewContext(readFileSync(new URL('./save_store.js', import.meta.url), 'utf8'), context);
const { create, inspectGci } = context.DuskSaveStore;

// Synthetic bytes exercise transport and storage, not a playable game save.
function gci(marker = 7, game = 'GZ2E') {
    const data = new Uint8Array(0x8040).fill(marker);
    data.set(Buffer.from(game + '01'), 0);
    data.fill(0, 8, 40);
    data.set(Buffer.from('gczelda2'), 8);
    data[0x38] = 0; data[0x39] = 4;
    return data;
}
const usa = '/save/GC/USA/Card A/01-GZ2E-gczelda2.gci';
const liveUsa = '/dusk/cards/USA/Card A/01-GZ2E-gczelda2.gci';

function fixture(saved = new Map()) {
    const files = new Map();
    const dirs = new Set(['/']);
    const mtimes = new Map();
    const syncCalls = [];
    const deferred = [];
    let failNext = false;
    let deferWrites = false;
    let active = 0;
    let maxActive = 0;
    const FS = {
        mkdirTree(path) {
            const parts = path.split('/').filter(Boolean);
            for (let i = 1; i <= parts.length; ++i) dirs.add('/' + parts.slice(0, i).join('/'));
        },
        mount() {},
        analyzePath(path) { return { exists: dirs.has(path) || files.has(path) }; },
        readdir(path) {
            assert.ok(dirs.has(path));
            const names = new Set(['.', '..']);
            for (const entry of [...dirs, ...files.keys()]) {
                if (entry.startsWith(path + '/')) names.add(entry.slice(path.length + 1).split('/')[0]);
            }
            return [...names];
        },
        readFile(path) { assert.ok(files.has(path), path); return files.get(path).slice(); },
        writeFile(path, data) {
            assert.ok(dirs.has(path.slice(0, path.lastIndexOf('/'))));
            files.set(path, new Uint8Array(data)); mtimes.set(path, new Date());
        },
        unlink(path) { assert.ok(files.delete(path)); },
        stat(path) { return { mtime: mtimes.get(path) }; },
        utime(path, atime, mtime) { mtimes.set(path, new Date(mtime)); },
        syncfs(populate, callback) {
            syncCalls.push(populate);
            ++active; maxActive = Math.max(active, maxActive);
            const complete = () => {
                --active;
                if (failNext) { failNext = false; callback(new Error('synthetic storage failure')); return; }
                if (populate) {
                    for (const [path, bytes] of saved) {
                        FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
                        FS.writeFile(path, bytes);
                    }
                } else {
                    // Read staging contents only on completion: this detects
                    // another transaction changing the mount during async I/O.
                    saved.clear();
                    for (const [path, bytes] of files) {
                        if (path.startsWith('/save/')) saved.set(path, bytes.slice());
                    }
                }
                callback(null);
            };
            if (deferWrites && !populate) deferred.push(complete);
            else queueMicrotask(complete);
        },
    };
    return {
        store: create({ FS, IDBFS: {} }), FS, files, saved, syncCalls,
        fail() { failNext = true; }, defer() { deferWrites = true; },
        finish() { assert.ok(deferred.length); deferred.shift()(); },
        get maxActive() { return maxActive; },
    };
}

test('campaign validation accepts both regions and rejects malformed or unrelated files', () => {
    assert.equal(inspectGci(gci()).name, '01-GZ2E-gczelda2.gci');
    assert.equal(inspectGci(gci(3, 'GZ2P')).region, 'EUR');
    for (const data of [new Uint8Array(2), gci(3, 'GZ2J'), gci(3, 'ABCE')]) {
        assert.throws(() => inspectGci(data));
    }
    const wrongBlocks = gci(); wrongBlocks[0x39] = 5;
    assert.throws(() => inspectGci(wrongBlocks), /four blocks/);
    const traversal = gci(); traversal.set(Buffer.from('../oops\0'), 8);
    assert.throws(() => inspectGci(traversal), /gczelda2/);
});

test('hydrate, import, export, and reload preserve every GCI byte', async () => {
    const f = fixture();
    await f.store.initialize();
    assert.equal(f.store.state().entries.length, 0);
    const data = gci();
    await f.store.importSave(data);
    assert.deepEqual(f.saved.get(usa), data);
    assert.deepEqual(f.files.get(liveUsa), data);
    assert.deepEqual(f.store.download('GZ2E').bytes, data);
    const reload = fixture(f.saved);
    await reload.store.initialize();
    assert.deepEqual(reload.store.download('GZ2E').bytes, data);
    assert.equal(reload.syncCalls.filter(p => !p).length, 0);
    // Returned download bytes must not mutate the retained snapshot.
    reload.store.download('GZ2E').bytes.fill(0);
    assert.deepEqual(reload.store.download('GZ2E').bytes, data);
});

test('replacement requires confirmation, retains previous bytes, and is disabled during play', async () => {
    const f = fixture(new Map([[usa, gci(1)]]));
    await f.store.initialize();
    await assert.rejects(f.store.importSave(gci(2)), /Confirm replacement/);
    assert.deepEqual(f.store.download('GZ2E').bytes, gci(1));
    await f.store.importSave(gci(2), true);
    assert.deepEqual(f.store.download('GZ2E', true).bytes, gci(1));
    const reload = fixture(f.saved);
    await reload.store.initialize();
    assert.deepEqual(reload.store.download('GZ2E', true).bytes, gci(1));
    reload.store.startGame();
    await assert.rejects(reload.store.importSave(gci(3), true), /before starting/);
});

test('failed hydration and exclusive-lock failure never flush or start a game', async () => {
    const f = fixture(new Map([[usa, gci(1)]]));
    f.fail();
    await assert.rejects(f.store.initialize(), /storage failure/);
    assert.throws(() => f.store.startGame(), /could not be opened/);
    assert.throws(() => f.store.retry(), /could not be opened/);
    assert.deepEqual(f.syncCalls, [true]);
    assert.deepEqual(f.saved.get(usa), gci(1));
    const locked = create({ FS: f.FS, acquireLock: async () => { throw new Error('Another tab'); } });
    await assert.rejects(locked.initialize(), /Another tab/);
    assert.deepEqual(f.syncCalls, [true]);
});

test('only completed transactions persist; in-progress and failed writes retain the previous save', async () => {
    const f = fixture(new Map([[usa, gci(1)]]));
    await f.store.initialize();
    f.store.startGame();
    f.store.beginWrite();
    f.FS.writeFile(liveUsa, gci(2));
    assert.throws(() => f.store.download('GZ2E'), /Wait for/);
    f.store.endWrite(false);
    assert.deepEqual(f.store.download('GZ2E').bytes, gci(1));
    assert.deepEqual(f.saved.get(usa), gci(1));
    assert.deepEqual(f.syncCalls, [true]);
    f.store.beginWrite();
    f.FS.writeFile(liveUsa, gci(3));
    f.store.endWrite(true);
    await f.store.flush();
    assert.deepEqual(f.saved.get(usa), gci(3));
    assert.equal(f.store.state().dirty, false);
});

test('overlapping saves serialize immutable snapshots and never sync partial live card writes', async () => {
    const f = fixture(new Map([[usa, gci(1)]]));
    await f.store.initialize();
    f.defer();
    f.store.beginWrite(); f.FS.writeFile(liveUsa, gci(2)); f.store.endWrite(true);
    await tick();
    f.store.beginWrite(); f.FS.writeFile(liveUsa, gci(3)); f.store.endWrite(true);
    await tick();
    f.finish();
    assert.deepEqual(f.saved.get(usa), gci(2));
    await tick();
    f.FS.writeFile(liveUsa, gci(4)); // An uncommitted card write must not leak into storage.
    f.finish();
    await f.store.flush();
    assert.deepEqual(f.saved.get(usa), gci(3));
    assert.equal(f.maxActive, 1);
});

test('storage errors preserve exportable bytes and a retry recovers without reloading', async () => {
    const f = fixture(new Map([[usa, gci(1)]]));
    await f.store.initialize();
    f.fail();
    await assert.rejects(f.store.importSave(gci(2), true), /storage failure/);
    assert.deepEqual(f.saved.get(usa), gci(1));
    assert.deepEqual(f.store.download('GZ2E').bytes, gci(2));
    assert.equal(f.store.state().dirty, true);
    assert.throws(() => f.store.startGame(), /Could not store/);
    await f.store.retry();
    assert.deepEqual(f.saved.get(usa), gci(2));
    assert.equal(f.store.state().dirty, false);
    assert.equal(f.store.state().error, '');
});
