(function () {
    'use strict';
    const scenes = ['Ordon Village', 'Ordon Spring', 'Fishing Pond'];
    function summarize(frames) {
        if (!frames.length || frames.some(x => !Number.isFinite(x) || x <= 0)) {
            throw new Error('Benchmark frames must contain positive, finite intervals.');
        }
        const sorted = frames.slice().sort((a, b) => a - b);
        const total = frames.reduce((a, b) => a + b, 0);
        const slowest = sorted.slice(-Math.max(1, Math.ceil(sorted.length * 0.01)));
        return {
            frames: frames.length, durationMs: total,
            fps: 1000 * frames.length / total,
            low1Percent: 1000 * slowest.length / slowest.reduce((a, b) => a + b, 0),
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
            p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
            maxMs: sorted[sorted.length - 1], over50Ms: frames.filter(x => x > 50).length,
        };
    }
    function shaderSummary(data) {
        const s = data.asyncShaders;
        if (!s) return { completeRendering: null, text: 'Shader readiness unknown' };
        const completeRendering = s.skippedDraws === 0 && s.failed === 0;
        return { completeRendering, text: (s.enabled ? 'ON' : 'OFF') + ' · ' +
            s.skippedDraws + ' draws skipped / ' + s.skippedFrames + ' frames · ' +
            s.pendingEnd + ' pending' + (completeRendering ? '' : ' · incomplete rendering') };
    }
    globalThis.DuskShowcaseMetrics = { summarize, shaderSummary };
    if (typeof window === 'undefined') return;
    let Module, send, rows = [], reportURL, recipeURL, busy = true, completed = false;
    const node = id => document.getElementById(id);
    function controls(locked) {
        busy = locked;
        ['showcase-scene', 'showcase-benchmark', 'showcase-tour'].forEach(id => {
            node(id).disabled = !send || locked;
        });
        node('showcase-explore').disabled = !send;
        node('showcase-campaign').disabled = !send;
    }
    function dispatch(value) {
        if (!send || !send(value)) {
            node('showcase-status').textContent = 'Please wait for the current request to finish.';
            return;
        }
        controls(true);
    }
    function download(link, bytes, filename, type, previous) {
        if (previous) URL.revokeObjectURL(previous);
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        link.href = url; link.download = filename; link.hidden = false;
        return url;
    }
    function refreshReport() {
        const report = {
            schema: 'dusk-showcase-benchmark-v2', route: 'entrance-orbit-v1',
            completed,
            createdAt: new Date().toISOString(), userAgent: navigator.userAgent,
            canvas: { width: Module.canvas.width, height: Module.canvas.height },
            devicePixelRatio: window.devicePixelRatio,
            texturePack: Module.duskSelectedPack ? Module.duskSelectedPack.file.name : null,
            savedShaderPreparation: node('shader-warm').checked,
            note: 'Rendered-frame submission intervals, including pacing; not GPU execution timings. ' +
                'First pass may already use cached shaders. Entry/load builds are separate from sweep builds. ' +
                'Texture uploads and other work can also cause spikes. Dynamic actors continue to simulate. ' +
                'Results with skipped draws include incomplete rendering; do not compare them as equal visual work. ' +
                'Async mode still waits for protected outputs. Pending shaders are not counted as compiled.',
            results: rows,
        };
        reportURL = download(node('showcase-report'), JSON.stringify(report, null, 2),
            'dusk-showcase-benchmark.json', 'application/json', reportURL);
    }
    window.duskShowcaseUI = {
        attach(module) {
            Module = module;
            node('launch-showcase').disabled = false;
            node('showcase-scene').addEventListener('change', () => {
                if (!busy) dispatch(Number(node('showcase-scene').value) + 1);
            });
            node('showcase-benchmark').addEventListener('click', () => dispatch(10));
            node('showcase-tour').addEventListener('click', () => dispatch(13));
            node('showcase-explore').addEventListener('click', () => dispatch(11));
            node('showcase-campaign').addEventListener('click', () => dispatch(12));
            node('showcase-export').addEventListener('click', () => {
                recipeURL = download(node('showcase-recipes'), Module.duskPipelines.snapshot(),
                    'dusk-shader-recipes.bin', 'application/octet-stream', recipeURL);
            });
            Module.duskPipelines.subscribe(text => { node('showcase-cache').textContent = text; });
            ['keydown', 'keyup', 'pointerdown', 'pointerup'].forEach(type => {
                node('showcase-panel').addEventListener(type, event => event.stopPropagation());
            });
            controls(true);
        },
        prepare() {
            const enabled = node('launch-showcase').checked;
            node('launch-showcase').disabled = true;
            Module.duskSaves.setIsolated(enabled);
            return enabled ? ['--showcase'] : [];
        },
        recover() { if (Module) node('launch-showcase').disabled = false; },
        connect(callback) { send = callback; node('showcase-panel').hidden = false; controls(true); },
        status(text, scene, locked) {
            node('showcase-status').textContent = text;
            node('showcase-scene').value = String(scene);
            controls(locked);
            if (!locked) node('showcase-progress').hidden = true;
        },
        begin() {
            rows = [];
            completed = false;
            node('showcase-results').replaceChildren();
            node('showcase-results-wrap').hidden = true;
            node('showcase-report').hidden = true;
            node('showcase-progress').value = 0;
            node('showcase-progress').hidden = false;
            node('showcase-run-note').textContent = 'Camera and character controls are held during measurement. ' +
                'Use Free explore to stop. Hidden-tab time is excluded; opening settings or resizing stops the run.';
        },
        progress(scene, pass, fraction, compiled) {
            node('showcase-progress').value = fraction;
            node('showcase-status').textContent = scenes[scene] + ' · ' +
                (pass ? 'Repeat' : 'First pass') + ' · ' + Math.round(fraction * 100) +
                '% · ' + compiled + ' shader builds during this sweep';
        },
        result(data) {
            const metrics = summarize(data.frames);
            const shaders = shaderSummary(data);
            rows.push({ ...data, sceneName: scenes[data.scene], metrics,
                completeRendering: shaders.completeRendering });
            const row = document.createElement('tr');
            for (const value of [scenes[data.scene], data.pass ? 'Repeat' : 'First',
                metrics.fps.toFixed(1), metrics.low1Percent.toFixed(1),
                data.entryCompiled + ' + ' + data.compiled, metrics.over50Ms, shaders.text]) {
                const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
            }
            node('showcase-results').append(row);
            node('showcase-results-wrap').hidden = false;
            refreshReport();
        },
        complete() {
            completed = true;
            node('showcase-progress').hidden = true;
            node('showcase-run-note').textContent = 'Each first pass is followed by the same sweep. Check skipped draws before comparing FPS. ' +
                'These locations sample performance; they do not cover every game shader.';
            if (rows.length) refreshReport();
        },
        finished() {
            send = null; controls(true);
            node('showcase-status').textContent = 'Campaign mode. Prepared shaders remain available in this session.';
            node('showcase-progress').hidden = true; node('showcase-panel').open = false;
        },
    };
})();
