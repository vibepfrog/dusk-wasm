import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('async queue completes single requests and safely handles bounds, failures and retired renderers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-async-queue-'));
    try {
        const executable = join(directory, 'queue-test');
        const source = fileURLToPath(new URL('../extern/aurora/tests/async_pipeline_queue_test.cpp', import.meta.url));
        const compile = spawnSync(process.env.CXX || 'c++', [
            '-std=c++20', '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
            source, '-o', executable,
        ], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
        const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
