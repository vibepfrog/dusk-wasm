import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { create } = createRequire(import.meta.url)('./frame_pacing.js');

function scheduler() {
    let next = 1;
    const frames = new Map(), timers = new Map();
    return {
        frames, timers,
        requestAnimationFrame(fn) { const id = next++; frames.set(id, fn); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
    };
}

test('VSync waits for a display callback and cleans up its hidden-tab fallback', async () => {
    const host = scheduler();
    let done = false;
    const promise = create(host).wait(true).then(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    assert.equal(host.frames.size, 1);
    host.frames.values().next().value();
    await promise;
    assert.equal(host.frames.size, 0); assert.equal(host.timers.size, 0);
});

test('hidden-tab watchdog keeps the loop alive when rAF stops; display pacing resumes next frame', async () => {
    const host = scheduler(), pacer = create(host);
    const promise = pacer.wait(true);
    const timer = host.timers.values().next().value;
    assert.equal(timer.ms, 100); timer.fn(); await promise;
    assert.equal(host.frames.size, 0);
    const resumed = pacer.wait(true);
    host.frames.values().next().value(); await resumed;
    assert.equal(host.timers.size, 0);
});

test('Turbo / VSync off retains a cooperative timer yield', async () => {
    const host = scheduler();
    const promise = create(host).wait(false);
    assert.equal(host.frames.size, 0);
    const timer = host.timers.values().next().value;
    assert.equal(timer.ms, 0); timer.fn(); await promise;
});

test('unsupported worker rAF falls back without trapping the game loop', async () => {
    for (const throws of [false, true]) {
        const host = scheduler();
        host.requestAnimationFrame = throws ? () => { throw new Error('NotSupportedError'); } : undefined;
        const promise = create(host).wait(true);
        assert.equal(host.timers.size, 1);
        const timer = host.timers.values().next().value;
        assert.equal(timer.ms, 0); timer.fn(); await promise;
    }
});
