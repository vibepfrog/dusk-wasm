import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const { create } = createRequire(import.meta.url)('./settings_store.js');
const key = 'dusk-settings-v1';
const path = '/libsdl/TwilitRealm/Dusk/config.json';

function fixture(records = new Map()) {
    const files = new Map(), messages = [], errors = [];
    const storage = {
        getItem: name => records.get(name) ?? null,
        setItem: (name, value) => records.set(name, value),
    };
    const FS = { mkdirTree() {}, writeFile: (name, value) => files.set(name, value) };
    const store = create({ FS, storage: () => storage,
        notify: text => messages.push(text), logError: error => errors.push(error) });
    return { store, storage, FS, files, records, messages, errors };
}

test('settings survive a new session, preserving explicit opt-outs and numeric zero', () => {
    const first = fixture();
    assert.equal(first.store.initialize(), true);
    assert.equal(first.files.size, 0, 'fresh sessions must keep native defaults');
    const settings = { 'game.freeCamera': false, 'game.enableMouseCamera': false,
        'game.internalResolutionScale': 0, 'game.gyroDeadband': 0, 'game.gyroSmoothing': 0,
        'game.gyroMode': 1, 'game.enableTurboKeybind': true, 'audio.masterVolume': 42 };
    assert.equal(first.store.save(JSON.stringify(settings)), true);
    const next = fixture(first.records);
    assert.equal(next.store.initialize(), true);
    assert.deepEqual(JSON.parse(next.files.get(path)), settings);
});

test('preferences exclude session disc metadata and do not write campaign paths', () => {
    const f = fixture();
    f.records.set('unrelated-app', 'untouched');
    assert.equal(f.store.save(JSON.stringify({ 'backend.isoPath': '/dusk/browser-disc',
        'backend.isoVerification': 2, 'backend.wasPresetChosen': true })), true);
    const next = fixture(f.records);
    next.store.initialize();
    assert.deepEqual(JSON.parse(next.files.get(path)), { 'backend.wasPresetChosen': true });
    assert.deepEqual([...next.files.keys()], [path]);
    assert.equal(next.records.get('unrelated-app'), 'untouched');
});

test('empty preferences remain an object and allow future native defaults', () => {
    const f = fixture();
    assert.equal(f.store.save('{}'), true);
    const next = fixture(f.records);
    next.store.initialize();
    assert.deepEqual(JSON.parse(next.files.get(path)), {});
});

test('corrupt, oversized, or unsupported records fall back without overwriting stored data', () => {
    for (const text of ['{bad', 'null', 'x'.repeat(128 * 1024 + 1),
        JSON.stringify({ version: 2, values: {} }),
        JSON.stringify({ version: 1, values: [] }),
        JSON.stringify({ version: 1, values: { 'game.freeCamera': {} } })]) {
        const f = fixture(new Map([[key, text]]));
        assert.equal(f.store.initialize(), false);
        assert.equal(f.files.size, 0);
        assert.equal(f.records.get(key), text);
        assert.equal(f.errors.length, 1);
    }
});

test('denied storage and failed writes leave gameplay usable and retain the last good settings', () => {
    const f = fixture();
    const denied = create({ FS: f.FS, storage() { throw new Error('Access denied'); } });
    assert.equal(denied.initialize(), false);
    assert.equal(denied.save('{}'), false);
    f.store.save('{"audio.masterVolume":25}');
    const previous = f.records.get(key);
    f.storage.setItem = () => { throw new Error('Quota exceeded'); };
    assert.equal(f.store.save('{"audio.masterVolume":50}'), false);
    assert.equal(f.records.get(key), previous);
    assert.match(f.messages.at(-1), /session only/);
});

test('the real preRun hook hydrates preferences before native startup', () => {
    const f = fixture();
    f.store.save('{"game.freeCamera":false,"audio.masterVolume":17}');
    const next = fixture(f.records);
    const listeners = [];
    const context = {
        Module: {}, FS: next.FS, IDBFS: {}, indexedDB: {},
        window: { localStorage: next.storage, addEventListener() {} },
        document: { getElementById: () => null, addEventListener() {} },
        navigator: {}, console,
        addRunDependency: name => listeners.push(name), removeRunDependency() {},
        DuskSettingsStore: { create },
        DuskPipelineStore: { create: () => ({ initialize: () => Promise.resolve() }) },
        DuskSaveStore: { create: () => ({ initialize: () => Promise.resolve() }) },
    };
    runInNewContext(readFileSync(new URL('./pre.js', import.meta.url), 'utf8'), context);
    for (const hook of context.Module.preRun) hook();
    assert.deepEqual(JSON.parse(next.files.get(path)), { 'game.freeCamera': false, 'audio.masterVolume': 17 });
    assert.equal(typeof context.Module.duskSettings.save, 'function');
    assert.ok(listeners.includes('idbfs-rehydrate'), 'campaign startup still has its independent gate');
});
