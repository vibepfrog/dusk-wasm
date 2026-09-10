/* Small DOM interface; campaign bytes stay on this device. */
(function () {
    'use strict';
    window.duskSaveUI = {
        attach: function (store) {
            var panel = document.getElementById('saves-panel');
            var status = document.getElementById('save-status');
            var list = document.getElementById('save-list');
            var input = document.getElementById('save-file');
            var pick = document.getElementById('save-pick');
            var retry = document.getElementById('save-retry');
            var message = document.getElementById('save-message');
            var importBusy = false;

            function showError(err) { message.textContent = String(err.message || err); }
            function download(game, backup) {
                try {
                    var file = store.download(game, backup);
                    var url = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
                    var link = document.createElement('a');
                    link.href = url;
                    link.download = file.name;
                    link.click();
                    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
                } catch (err) { showError(err); }
            }
            function render(state) {
                var unavailable = state.phase !== 'ready';
                input.disabled = unavailable || state.gameStarted || !!state.pending || state.importing || importBusy;
                pick.setAttribute('aria-disabled', String(input.disabled));
                retry.hidden = !state.dirty || !state.error;
                retry.disabled = unavailable || !!state.pending || state.writing || state.importing;
                status.textContent = state.error || (state.writing || state.pending || state.importing
                    ? 'Saving… keep this tab open.'
                    : unavailable ? 'Opening saved games…'
                    : state.entries.length ? 'Saved on this device.' : 'No campaign save yet. Save from the game menu.');
                status.classList.toggle('error', !!state.error);
                document.getElementById('save-import-hint').textContent = state.gameStarted
                    ? 'To import another save, finish saving and reload before choosing your disc.'
                    : 'Import a Windows campaign save before choosing your disc. Match the save and disc region.';
                list.replaceChildren();
                state.entries.forEach(function (entry) {
                    var row = document.createElement('div');
                    var button = document.createElement('button');
                    button.textContent = 'Download ' + entry.region + ' save';
                    button.disabled = state.writing;
                    button.addEventListener('click', function () { download(entry.game, false); });
                    row.append(button);
                    if (entry.backup) {
                        var previous = document.createElement('button');
                        previous.textContent = 'Download previous ' + entry.region + ' save';
                        previous.disabled = state.writing;
                        previous.addEventListener('click', function () { download(entry.game, true); });
                        row.append(previous);
                    }
                    list.append(row);
                });
            }
            input.addEventListener('change', async function () {
                var file = input.files && input.files[0];
                if (!file || importBusy || input.disabled) return;
                importBusy = true;
                message.textContent = '';
                render(store.state());
                try {
                    if (file.size !== 0x8040) throw new Error('Choose a Twilight Princess campaign .gci file (32,832 bytes).');
                    var bytes = new Uint8Array(await file.arrayBuffer());
                    var entry = globalThis.DuskSaveStore.inspectGci(bytes);
                    var exists = store.state().entries.some(function (e) { return e.game === entry.game; });
                    if (exists && !window.confirm('Replace the existing ' + entry.region + ' campaign? Its previous save will remain available to download.')) return;
                    await store.importSave(bytes, exists);
                    message.textContent = entry.region + ' campaign imported. You can now choose your disc.';
                } catch (err) { showError(err); }
                finally { importBusy = false; input.value = ''; render(store.state()); }
            });
            retry.addEventListener('click', function () { store.retry().catch(showError); });
            // Keep controls in this panel from also becoming game input.
            ['keydown', 'keyup', 'pointerdown', 'pointerup'].forEach(function (name) {
                panel.addEventListener(name, function (event) { event.stopPropagation(); });
            });
            store.subscribe(render);
        },
    };
})();
