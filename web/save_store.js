/* Completed campaign snapshots only. Live card writes never race IDBFS sync. */
(function (root) {
    'use strict';
    var regions = { GZ2E: 'USA', GZ2P: 'EUR' };
    var workingRoot = '/dusk/cards';
    var persistentRoot = '/save/GC';

    function inspectGci(input) {
        var bytes = new Uint8Array(input);
        if (bytes.length !== 0x8040) {
            throw new Error('Choose a Twilight Princess campaign .gci file (32,832 bytes).');
        }
        var text = function (start, end) {
            return String.fromCharCode.apply(null, bytes.subarray(start, end)).split('\0')[0];
        };
        var game = text(0, 4);
        if (!regions[game] || text(4, 6) !== '01') {
            throw new Error('This save must be for the USA or European GameCube version of Twilight Princess.');
        }
        if (text(8, 40) !== 'gczelda2' || ((bytes[0x38] << 8) | bytes[0x39]) !== 4) {
            throw new Error('Expected the standard Twilight Princess campaign save: gczelda2, four blocks.');
        }
        return { game: game, region: regions[game], name: '01-' + game + '-gczelda2.gci', bytes: bytes };
    }

    function create(options) {
        var FS = options.FS;
        var entries = new Map();
        var backups = new Map();
        var phase = 'loading';
        var error = '';
        var writeActive = false;
        var gameStarted = false;
        var isolated = false;
        var importing = false;
        var pending = 0;
        var revision = 0;
        var persistedRevision = 0;
        var lastTimestamp = 0;
        var tail = Promise.resolve();
        var listeners = [];

        function state() {
            return {
                phase: phase, error: error, writing: writeActive, importing: importing,
                gameStarted: gameStarted, isolated: isolated, pending: pending,
                dirty: revision !== persistedRevision,
                entries: Array.from(entries.values(), function (e) {
                    return { game: e.game, region: e.region, name: e.name, backup: backups.has(e.game) };
                }),
            };
        }
        function notify() {
            listeners.forEach(function (listener) { listener(state()); });
        }
        function sync(populate) {
            return new Promise(function (resolve, reject) {
                FS.syncfs(populate, function (err) { if (err) reject(err); else resolve(); });
            });
        }
        function folder(base, region) { return base + '/' + region + '/Card A'; }
        function filesAt(path) {
            return FS.analyzePath(path).exists ? FS.readdir(path).filter(function (name) {
                return name.endsWith('.gci');
            }) : [];
        }
        function readCards(base) {
            var found = new Map();
            Object.keys(regions).forEach(function (game) {
                var dir = folder(base, regions[game]);
                filesAt(dir).forEach(function (name) {
                    var entry = inspectGci(FS.readFile(dir + '/' + name));
                    if (entry.game !== game || found.has(game)) {
                        throw new Error('Conflicting campaign files in the ' + regions[game] + ' save folder.');
                    }
                    found.set(game, entry);
                });
            });
            return found;
        }
        function writeFile(path, bytes) {
            FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
            // IDBFS compares mtimes. Ensure successive snapshots differ even
            // when two writes land within the same millisecond.
            var previous = FS.analyzePath(path).exists ? FS.stat(path).mtime.getTime() : 0;
            lastTimestamp = Math.max(Date.now(), lastTimestamp + 1, previous + 1);
            FS.writeFile(path, bytes);
            FS.utime(path, lastTimestamp, lastTimestamp);
        }
        function writeCards(base, snapshot) {
            snapshot.forEach(function (entry) {
                var dir = folder(base, entry.region);
                // Canonicalize imported filenames so the native card reader
                // never sees two files for the same internal campaign name.
                filesAt(dir).forEach(function (name) {
                    if (name !== entry.name) FS.unlink(dir + '/' + name);
                });
                writeFile(dir + '/' + entry.name, entry.bytes);
            });
        }
        function enqueuePersistence() {
            var snapshot = new Map(entries);
            var backupSnapshot = new Map(backups);
            var jobRevision = ++revision;
            ++pending;
            notify();
            var job = tail.then(async function () {
                writeCards(persistentRoot, snapshot);
                backupSnapshot.forEach(function (entry) {
                    writeFile('/save/backups/' + entry.name, entry.bytes);
                });
                await sync(false);
                persistedRevision = jobRevision;
                error = '';
            }).catch(function (err) {
                error = 'Could not store saves on this device. Download a backup and choose Retry storage.';
                if (options.logError) options.logError(err);
                throw err;
            }).finally(function () { --pending; notify(); });
            // Keep the queue usable after an I/O failure; each caller still
            // receives its own rejection. Only this queue writes the mount.
            tail = job.catch(function () {});
            return job;
        }
        async function initialize() {
            try {
                if (options.acquireLock) await options.acquireLock();
                FS.mkdirTree('/save');
                FS.mount(options.IDBFS, {}, '/save');
                await sync(true);
                entries = readCards(persistentRoot);
                filesAt('/save/backups').forEach(function (name) {
                    var entry = inspectGci(FS.readFile('/save/backups/' + name));
                    backups.set(entry.game, entry);
                });
                Object.keys(regions).forEach(function (game) {
                    FS.mkdirTree(folder(workingRoot, regions[game]));
                });
                writeCards(workingRoot, entries);
                phase = 'ready';
            } catch (err) {
                // Never flush an empty mount over saves after a failed read.
                phase = 'failed';
                error = 'Saved games could not be opened. ' + String(err.message || err);
                if (options.logError) options.logError(err);
                throw err;
            } finally { notify(); }
        }
        function requireReady() {
            if (phase !== 'ready') throw new Error(error || 'Saved games are still loading.');
        }
        function beginWrite() {
            if (isolated) return;
            writeActive = true;
            notify();
        }
        function endWrite(success) {
            if (isolated) return;
            writeActive = false;
            if (!success) {
                error = 'The game could not complete its save. The previous completed save is retained.';
                notify();
                return;
            }
            try {
                requireReady();
                entries = readCards(workingRoot);
                enqueuePersistence().catch(function () {});
            } catch (err) {
                error = 'Could not capture the completed game save: ' + String(err.message || err);
                notify();
            }
        }
        async function importSave(input, replace) {
            requireReady();
            if (gameStarted || importing || writeActive || pending) {
                throw new Error('Import a save before starting the game, after any storage operation finishes.');
            }
            var entry = inspectGci(input);
            if (entries.has(entry.game) && !replace) {
                throw new Error('Confirm replacement of the existing ' + entry.region + ' campaign first.');
            }
            importing = true;
            try {
                if (entries.has(entry.game)) backups.set(entry.game, entries.get(entry.game));
                entries.set(entry.game, entry);
                writeCards(workingRoot, entries);
                await enqueuePersistence();
            } finally { importing = false; notify(); }
        }
        return {
            initialize: initialize, state: state, beginWrite: beginWrite, endWrite: endWrite,
            importSave: importSave,
            setIsolated: function (value) {
                if (writeActive || pending) throw new Error('Wait for campaign storage before changing session mode.');
                // The authoritative completed snapshots are kept unchanged.
                // Restore working files as a second guard on returning to play.
                if (isolated && !value) {
                    Object.keys(regions).forEach(function (game) {
                        var dir = folder(workingRoot, regions[game]);
                        filesAt(dir).forEach(function (name) { FS.unlink(dir + '/' + name); });
                    });
                    writeCards(workingRoot, entries);
                }
                isolated = !!value;
                notify();
            },
            subscribe: function (listener) { listeners.push(listener); listener(state()); },
            startGame: function () {
                requireReady();
                if (gameStarted || importing || pending || error || revision !== persistedRevision) {
                    throw new Error(error || 'Wait for saved games to finish storing before starting.');
                }
                gameStarted = true;
                notify();
            },
            download: function (game, backup) {
                requireReady();
                if (writeActive) throw new Error('Wait for the in-game save to finish.');
                var entry = (backup ? backups : entries).get(game);
                if (!entry) throw new Error('No completed campaign save is available yet.');
                return { name: entry.name, bytes: entry.bytes.slice() };
            },
            retry: function () {
                requireReady();
                if (writeActive || importing || pending) throw new Error('A save operation is still in progress.');
                return enqueuePersistence();
            },
            flush: async function () {
                await tail;
                if (error || revision !== persistedRevision) throw new Error(error || 'Save storage is incomplete.');
            },
        };
    }
    root.DuskSaveStore = { create: create, inspectGci: inspectGci };
})(globalThis);
