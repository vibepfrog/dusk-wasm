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
            var downloadUrls = [];

            function showError(err) { message.textContent = String(err.message || err); }
            function downloadLink(entry, backup, disabled) {
                var link = document.createElement('a');
                link.className = 'save-download';
                link.textContent = 'Download ' + (backup ? 'previous ' : '') + entry.region + ' save';
                link.setAttribute('aria-disabled', String(disabled));
                if (!disabled) {
                    var file = store.download(entry.game, backup);
                    link.href = URL.createObjectURL(new Blob([file.bytes], { type: 'application/octet-stream' }));
                    link.download = file.name;
                    downloadUrls.push(link.href);
                }
                return link;
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
                // Use real download links in the DOM, with a retained snapshot
                // behind each URL. Retire replaced URLs after the browser has
                // had time to begin any download already clicked by the user.
                var retiredUrls = downloadUrls;
                downloadUrls = [];
                setTimeout(function () { retiredUrls.forEach(function (url) { URL.revokeObjectURL(url); }); }, 60000);
                list.replaceChildren();
                state.entries.forEach(function (entry) {
                    var row = document.createElement('div');
                    row.append(downloadLink(entry, false, state.writing));
                    if (entry.backup) {
                        row.append(downloadLink(entry, true, state.writing));
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
