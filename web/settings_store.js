/* Small user preferences only; disc handles, shaders and campaign saves have
 * separate stores. Native config::Save calls save() on the page thread. */
(function (root) {
    'use strict';
    const key = 'dusk-settings-v1';
    const configPath = '/libsdl/TwilitRealm/Dusk/config.json';
    const maxLength = 128 * 1024;
    function valuesOnly(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Settings must be an object.');
        }
        const values = Object.create(null);
        for (const [name, item] of Object.entries(value)) {
            // Browser disc paths/verification describe this session's File.
            if (name === 'backend.isoPath' || name === 'backend.isoVerification') continue;
            if (!/^(game|video|audio|backend)\.[A-Za-z][A-Za-z0-9]*$/.test(name) ||
                !['boolean', 'number', 'string'].includes(typeof item) ||
                (typeof item === 'number' && !Number.isFinite(item))) {
                throw new Error('Invalid settings entry.');
            }
            values[name] = item;
        }
        return values;
    }
    function parse(text) {
        if (typeof text !== 'string' || text.length > maxLength) throw new Error('Invalid settings size.');
        return JSON.parse(text);
    }
    function create(options) {
        const notify = options.notify || function () {};
        const logError = options.logError || function () {};
        function failed(error, message) {
            logError(error);
            notify(message || 'Settings storage is unavailable. Changes apply to this session only.');
            return false;
        }
        function initialize() {
            try {
                const text = options.storage().getItem(key);
                if (text === null) {
                    notify('Dusk settings will be remembered on this browser.');
                    return true;
                }
                const saved = parse(text);
                if (!saved || saved.version !== 1) throw new Error('Unsupported settings version.');
                const values = valuesOnly(saved.values);
                options.FS.mkdirTree('/libsdl/TwilitRealm/Dusk');
                options.FS.writeFile(configPath, JSON.stringify(values));
                notify('Dusk settings restored from this browser.');
                return true;
            } catch (error) {
                // Do not replace an unreadable record merely by visiting the
                // launcher. Defaults work; a later explicit save can repair it.
                return failed(error, 'Saved Dusk settings could not be restored. Using defaults.');
            }
        }
        function save(text) {
            try {
                const encoded = JSON.stringify({ version: 1, values: valuesOnly(parse(text)) });
                if (encoded.length > maxLength) throw new Error('Settings are too large.');
                options.storage().setItem(key, encoded);
                notify('Dusk settings saved on this browser.');
                return true;
            } catch (error) { return failed(error); }
        }
        return { initialize, save };
    }
    root.DuskSettingsStore = { create };
    if (typeof module === 'object' && module.exports) module.exports = root.DuskSettingsStore;
})(globalThis);
