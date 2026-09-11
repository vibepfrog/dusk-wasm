(function () {
    'use strict';
    window.duskEnhancements = {
        attach(Module) {
            const input = document.getElementById('pack-file');
            const status = document.getElementById('pack-status');
            const remove = document.getElementById('pack-remove');
            const warm = document.getElementById('shader-warm');
            const shaderStatus = document.getElementById('shader-status');
            let busy = false, started = false;
            input.disabled = false;
            Module.duskPipelines.subscribe(text => { shaderStatus.textContent = text; });
            input.addEventListener('change', async () => {
                const file = input.files[0];
                if (!file || busy || started) return;
                busy = true; input.disabled = true; remove.disabled = true;
                status.textContent = 'Checking texture pack…';
                try {
                    const pack = await globalThis.DuskTexturePack.index(file);
                    Module.duskSelectedPack = pack;
                    status.textContent = file.name + ' — ' + pack.entries.length + ' DDS files ready.';
                } catch (err) {
                    Module.duskSelectedPack = null;
                    status.textContent = String(err.message || err);
                } finally { busy = false; input.disabled = false; remove.disabled = false; }
            });
            remove.addEventListener('click', () => {
                if (busy || started) return;
                Module.duskSelectedPack = null; input.value = ''; status.textContent = 'Original textures selected.';
            });
            window.duskEnhancements.prepare = function () {
                if (busy) throw new Error('Wait for the texture pack check to finish before choosing your disc.');
                if (started) return;
                started = true; input.disabled = true; remove.disabled = true; warm.disabled = true;
                Module.duskPipelines.startGame(warm.checked);
            };
            window.duskEnhancements.recover = function () {
                started = false; input.disabled = false; remove.disabled = false; warm.disabled = false;
            };
        },
    };
})();
