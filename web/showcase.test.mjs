import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('./showcase_ui.js', import.meta.url), 'utf8');
const metricsContext = {};
runInNewContext(source, metricsContext);
const { summarize } = metricsContext.DuskShowcaseMetrics;

test('benchmark uses elapsed frame time rather than the mean of instantaneous FPS', () => {
    const m = summarize([10, 10, 100]);
    assert.equal(m.fps, 25);
    assert.equal(m.durationMs, 120);
    assert.equal(m.over50Ms, 1);
    assert.equal(m.low1Percent, 10);
});

test('tail metrics expose hitches hidden by a high average frame rate', () => {
    const frames = Array(198).fill(8).concat([50, 150]);
    const m = summarize(frames);
    assert.equal(m.low1Percent, 10);
    assert.equal(m.maxMs, 150);
    assert.equal(m.p95Ms, 8);
    assert.equal(m.p99Ms, 8);
    assert.equal(m.over50Ms, 1);
    assert.equal(frames[0], 8, 'analysis must not reorder captured frame intervals');
});

test('empty, zero, negative and nonfinite samples cannot produce plausible scores', () => {
    for (const frames of [[], [0], [-1], [NaN], [Infinity], [10, '20']]) {
        assert.throws(() => summarize(frames), /positive, finite/);
    }
});

test('showcase launch is opt-in and protects saves before main starts', () => {
    const nodes = new Map(), events = [], writes = [];
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, {
            checked: false, disabled: true, hidden: true, value: '0',
            addEventListener(type, fn) { events.push([id, type, fn]); },
        });
        return nodes.get(id);
    }
    const context = { document: { getElementById: node }, window: {} };
    runInNewContext(source, context);
    const ui = context.window.duskShowcaseUI;
    ui.attach({ duskSaves: { setIsolated(v) { writes.push(v); } },
        duskPipelines: { subscribe() {} } });
    assert.equal(node('launch-showcase').disabled, false);
    assert.deepEqual(Array.from(ui.prepare()), []);
    node('launch-showcase').checked = true;
    assert.deepEqual(Array.from(ui.prepare()), ['--showcase']);
    assert.deepEqual(writes, [false, true]);
    const commands = [];
    ui.connect(value => { commands.push(value); return true; });
    ui.status('Ready', 0, false);
    events.find(([id, event]) => id === 'showcase-tour' && event === 'click')[2]();
    assert.deepEqual(commands, [13]);
    assert.equal(node('showcase-tour').disabled, true);
    ui.finished();
    assert.equal(node('showcase-campaign').disabled, true);
});

test('benchmark flags incomplete rendering and does not equate pending jobs with completed shaders', () => {
    const { shaderSummary } = metricsContext.DuskShowcaseMetrics;
    const data = { asyncShaders: { enabled: true, skippedDraws: 4, skippedFrames: 2,
        failed: 0, pendingEnd: 3 } };
    assert.equal(shaderSummary(data).completeRendering, false);
    assert.match(shaderSummary(data).text, /4 draws skipped \/ 2 frames.*3 pending.*incomplete rendering/);
    data.asyncShaders.skippedDraws = data.asyncShaders.skippedFrames = 0;
    assert.equal(shaderSummary(data).completeRendering, true, 'pending unused shaders need not imply missing pixels');
    data.asyncShaders.failed = 1;
    assert.equal(shaderSummary(data).completeRendering, false);
    assert.equal(shaderSummary({}).completeRendering, null, 'old reports cannot imply verified completeness');
});
