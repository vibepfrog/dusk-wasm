import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkShellRuntime } from './shell_runtime_check.mjs';

const shell = readFileSync(new URL('./shell.html', import.meta.url), 'utf8');

test('launcher startup ordering, capability guards, and main error handling', async () => {
    const checks = await checkShellRuntime(shell);
    assert.equal(checks.length, 5);
});

test('checks tolerate compact JavaScript, renamed locals, and unquoted HTML attributes', async () => {
    // Reproduce the forms that defeated the original exact-string checks.
    // This fixture is not a full minifier; CI also executes the real built HTML.
    const compact = shell.replace(/function \(\)/g, 'function()')
        .replace(/: function/g, ':function')
        .replace(/\bruntimeReadyPromise\b/g, 'r')
        .replace(/\bresolveRuntimeReady\b/g, 'q')
        .replace(/id="iso-file"/g, 'id=iso-file');
    assert.equal((await checkShellRuntime(compact)).length, 5);
});

test('checks reject a chooser enabled before runtime readiness', async () => {
    await assert.rejects(checkShellRuntime(shell.replace('accept=".iso,.gcm,.ciso" disabled',
        'accept=".iso,.gcm,.ciso"')), /chooser must be disabled/);
});

test('checks reject removal of the independent runtime promise gate', async () => {
    await assert.rejects(checkShellRuntime(shell.replace('runtimeReadyPromise.then(function ()',
        'Promise.resolve().then(function ()')), /runtime promise must guard import/);
});

test('checks reject a callback that overrides a failed capability guard', async () => {
    await assert.rejects(checkShellRuntime(shell.replace('if (!capabilityError)', 'if (true)')),
        /callback must not bypass capability guard/);
});
