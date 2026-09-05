/* Exercise the launcher only: no Wasm, network, GPU, or disc data is loaded. */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate as flushTasks } from 'node:timers/promises';

function attributes(text) {
    const result = {};
    for (const match of text.matchAll(/([-\w]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return result;
}

function findElement(html, tag, predicate) {
    for (const match of html.matchAll(new RegExp('<' + tag + '\\b([^>]*)>', 'gi'))) {
        const attrs = attributes(match[1]);
        if (predicate(attrs)) return attrs;
    }
    assert.fail('missing launcher element: ' + tag);
}

function element(attrs = {}) {
    const listeners = new Map();
    const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
    return {
        disabled: Object.hasOwn(attrs, 'disabled'),
        textContent: '',
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        },
        setAttribute(name, value) { attrs[name] = String(value); },
        getAttribute(name) { return attrs[name] ?? null; },
        focus() {},
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(callback);
        },
        dispatch(name, data = {}) {
            const event = { target: this, preventDefault() {}, stopPropagation() {}, ...data };
            for (const callback of listeners.get(name) || []) callback(event);
        },
    };
}

function launch(html, unavailable) {
    const inputAttrs = findElement(html, 'input', a => a.id === 'iso-file');
    assert.ok(Object.hasOwn(inputAttrs, 'disabled'), 'chooser must be disabled in the initial HTML');
    const pick = element(findElement(html, 'label', a => a.for === 'iso-file'));
    const nodes = Object.fromEntries(['drop-zone', 'import-status', 'boot-status', 'canvas']
        .map(id => [id, element()]));
    const input = nodes['iso-file'] = element(inputAttrs);
    nodes['drop-zone'].querySelector = selector => selector === '.pick-btn' ? pick : null;
    if (unavailable !== 'offscreen') nodes.canvas.transferControlToOffscreen = function () {};

    const calls = [];
    const errors = [];
    let ready = false;
    let finishImport;
    const context = {
        document: { getElementById: id => nodes[id] || null },
        navigator: { gpu: unavailable === 'gpu' ? undefined : {} },
        crossOriginIsolated: unavailable !== 'isolation',
        SharedArrayBuffer: unavailable === 'shared-memory' ? undefined : function () {},
        WebAssembly: unavailable === 'jspi' ? {} : { Suspending() {}, promising() {} },
        crypto: { randomUUID: () => 'launcher-regression-test' },
        console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
        addEventListener() {},
        duskIsoImport: {
            importIso(file) {
                calls.push(['import', file]);
                return new Promise(resolve => { finishImport = resolve; });
            },
        },
    };
    context.window = context;
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
        .filter(match => !Object.hasOwn(attributes(match[1]), 'src') && match[2].trim())
        .map(match => match[2]);
    assert.equal(inline.length, 1, 'expected one inline launcher script');
    runInNewContext(inline[0], context, { filename: 'dusk-launcher.js', timeout: 1000 });
    assert.equal(typeof context.Module?.onRuntimeInitialized, 'function', 'runtime callback is required');
    assert.equal(context.Module.noInitialRun, true, 'main must not auto-start before disc selection');
    context.Module.callMain = args => {
        assert.ok(ready, 'main must not run before onRuntimeInitialized');
        calls.push(['main', ...args]);
    };
    return {
        input, pick, nodes, calls, errors, module: context.Module,
        ready() { ready = true; context.Module.onRuntimeInitialized(); },
        finishImport() {
            assert.equal(typeof finishImport, 'function', 'disc import must have started');
            finishImport({ path: '/dusk/browser-disc' });
        },
        select() { input.dispatch('change', { target: { files: [{ name: 'test.ciso' }] } }); },
        drop() { nodes['drop-zone'].dispatch('drop', { dataTransfer: { files: [{ name: 'test.ciso' }] } }); },
    };
}

export async function checkShellRuntime(html) {
    const checks = [];
    const app = launch(html);
    assert.equal(app.input.disabled, true, 'chooser must remain disabled before runtime readiness');
    assert.equal(app.pick.getAttribute('aria-disabled'), 'true');
    app.select();
    app.drop();
    await flushTasks();
    assert.equal(app.calls.length, 0, 'early chooser and drop events must not import or launch');
    checks.push('early chooser and drop events cannot start main');

    app.ready();
    await flushTasks();
    assert.equal(app.input.disabled, false, 'runtime readiness must enable the chooser');
    assert.notEqual(app.pick.getAttribute('aria-disabled'), 'true');
    assert.equal(app.calls.length, 0, 'runtime readiness alone must not start the game');
    app.select();
    app.drop();
    await flushTasks();
    assert.deepEqual(app.calls.map(call => call[0]), ['import'], 'main must wait for disc handoff');
    app.finishImport();
    await flushTasks();
    assert.deepEqual(app.calls.map(call => call[0]), ['import', 'main']);
    assert.deepEqual(app.calls[1], ['main', '/dusk/browser-disc']);
    assert.equal(app.nodes['drop-zone'].classList.contains('hidden'), true);
    app.select();
    app.drop();
    await flushTasks();
    assert.equal(app.calls.length, 2, 'duplicate input must not launch the game twice');
    checks.push('runtime readiness and completed disc handoff launch main exactly once');

    // Force an event past the disabled UI to test the promise gate separately.
    const forced = launch(html);
    forced.input.disabled = false;
    forced.select();
    await flushTasks();
    assert.equal(forced.calls.length, 0, 'the runtime promise must guard import independently of the UI');
    forced.ready();
    await flushTasks();
    forced.finishImport();
    await flushTasks();
    assert.deepEqual(forced.calls.map(call => call[0]), ['import', 'main']);
    checks.push('runtime promise blocks early programmatic input');

    for (const feature of ['isolation', 'shared-memory', 'jspi', 'gpu', 'offscreen']) {
        const blocked = launch(html, feature);
        blocked.ready();
        assert.equal(blocked.input.disabled, true, feature + ': callback must not bypass capability guard');
        assert.equal(blocked.nodes['import-status'].classList.contains('error'), true);
        blocked.select();
        blocked.drop();
        await flushTasks();
        assert.equal(blocked.calls.length, 0, feature + ': unsupported browser must not launch');
    }
    checks.push('runtime readiness preserves all five browser capability guards');

    for (const asynchronous of [false, true]) {
        const failed = launch(html);
        failed.module.callMain = () => {
            const error = new Error('synthetic main failure');
            if (asynchronous) return Promise.reject(error);
            throw error;
        };
        failed.ready();
        failed.drop();
        await flushTasks();
        failed.finishImport();
        await flushTasks();
        assert.match(failed.nodes['import-status'].textContent, /synthetic main failure/);
        assert.equal(failed.nodes['drop-zone'].classList.contains('hidden'), false);
        assert.equal(failed.errors.filter(args => String(args[0]).includes('main() threw')).length, 1);
    }
    checks.push('synchronous and JSPI-promise main failures are caught and displayed');
    return checks;
}
