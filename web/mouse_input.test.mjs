import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { create } = createRequire(import.meta.url)('./mouse_input.js');

function target() {
    const handlers = new Map();
    return {
        addEventListener(type, callback) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(callback);
        },
        emit(type, event = {}) { for (const callback of handlers.get(type) || []) callback(event); },
    };
}
function fixture() {
    const doc = Object.assign(target(), { hidden: false, focused: true, pointerLockElement: null });
    doc.hasFocus = () => doc.focused;
    const canvas = Object.assign(target(), { focus() {}, requests: 0 });
    const win = target();
    const status = {};
    function lock() { doc.pointerLockElement = canvas; doc.emit('pointerlockchange'); }
    doc.exitPointerLock = () => { doc.pointerLockElement = null; doc.emit('pointerlockchange'); };
    canvas.requestPointerLock = () => { ++canvas.requests; lock(); };
    const mouse = create({ canvas, document: doc, window: win, status });
    const click = () => canvas.emit('click', { button: 0 });
    const move = (movementX, movementY) => doc.emit('mousemove', { movementX, movementY });
    return { doc, canvas, win, status, mouse, click, move, lock };
}

test('enabling camera requires a click and ignores unlocked mouse movement', () => {
    const f = fixture();
    f.click();
    f.mouse.setEnabled(true);
    assert.equal(f.canvas.requests, 0);
    f.move(50, 60);
    assert.deepEqual(f.mouse.consume(), [0, 0]);
    f.click();
    assert.equal(f.canvas.requests, 1);
    assert.match(f.status.textContent, /Mouse captured/);
});

test('relative movement is accumulated once per simulation tick, including fractional pixels', () => {
    const f = fixture();
    f.mouse.setEnabled(true); f.click();
    f.move(2.5, -3); f.move(-1, 8.25);
    assert.deepEqual(f.mouse.consume(), [1.5, 5.25]);
    assert.deepEqual(f.mouse.consume(), [0, 0]); // second catch-up tick cannot repeat input
    f.move(NaN, Infinity);
    assert.deepEqual(f.mouse.consume(), [0, 0]);
});

test('Escape releases without automatically recapturing, and stale motion is discarded', () => {
    const f = fixture();
    f.mouse.setEnabled(true); f.click(); f.move(100, 50);
    f.doc.emit('keydown', { key: 'Escape' });
    f.mouse.setEnabled(true);
    assert.equal(f.doc.pointerLockElement, null);
    assert.equal(f.canvas.requests, 1);
    f.click();
    assert.deepEqual(f.mouse.consume(), [0, 0]);
});

test('F1 and disabled camera release capture; settings require a new click after closing', () => {
    const f = fixture();
    f.mouse.setEnabled(true); f.click();
    f.doc.emit('keydown', { key: 'F1' }); f.click();
    assert.equal(f.doc.pointerLockElement, null);
    assert.equal(f.canvas.requests, 1);
    f.mouse.setEnabled(true); f.click();
    f.mouse.setEnabled(false);
    assert.equal(f.doc.pointerLockElement, null);
    assert.equal(f.status.hidden, true);
});

test('tab hide and window blur release immediately and never replay buffered movement', () => {
    const f = fixture();
    f.mouse.setEnabled(true); f.click(); f.move(700, 800);
    f.doc.hidden = true; f.doc.emit('visibilitychange'); f.click();
    assert.equal(f.canvas.requests, 1);
    f.doc.hidden = false; f.doc.emit('visibilitychange');
    assert.equal(f.doc.pointerLockElement, null);
    f.click(); assert.deepEqual(f.mouse.consume(), [0, 0]);
    f.win.emit('blur');
    assert.equal(f.doc.pointerLockElement, null);
});

test('permission rejection is handled and a later click can retry', async () => {
    const f = fixture();
    f.mouse.setEnabled(true);
    f.canvas.requestPointerLock = () => Promise.reject(new Error('denied'));
    f.click(); await Promise.resolve();
    assert.match(f.status.textContent, /declined/);
    f.canvas.requestPointerLock = f.lock;
    f.click(); assert.equal(f.doc.pointerLockElement, f.canvas);
});

test('a lock completing after capture was revoked is immediately released (Promise and legacy APIs)', async () => {
    for (const promiseApi of [false, true]) {
        const f = fixture();
        let complete;
        f.canvas.requestPointerLock = () => {
            ++f.canvas.requests;
            return promiseApi ? new Promise(resolve => { complete = resolve; }) : undefined;
        };
        f.mouse.setEnabled(true); f.click(); f.click();
        assert.equal(f.canvas.requests, 1);
        f.win.emit('blur'); // a delayed browser approval must not recapture on return
        f.lock();
        complete?.(); await Promise.resolve();
        assert.equal(f.doc.pointerLockElement, null);
        assert.deepEqual(f.mouse.consume(), [0, 0]);
    }
});
