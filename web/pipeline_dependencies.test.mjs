import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function check(source, directory) {
    const executable = join(directory, 'test');
    const compile = spawnSync(process.env.CXX || 'c++', [
        '-std=c++20', '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
        source, '-o', executable,
    ], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
}

test('persistent output dependencies protect producers and prioritize their original jobs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-dependencies-'));
    try {
        check(fileURLToPath(new URL('../extern/aurora/tests/pipeline_dependencies_test.cpp', import.meta.url)), directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real depth snapshot gate preserves late requests until a complete producer frame', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-depth-gate-'));
    try {
        const source = readFileSync(new URL('../extern/aurora/lib/gfx/depth_peek.cpp', import.meta.url), 'utf8');
        const start = source.indexOf('void encode_frame_snapshot(');
        const body = source.indexOf('{', start);
        const end = source.indexOf('  const auto dstSize =', body);
        assert.ok(start >= 0 && body > start && end > body, 'production gate boundaries must be present');
        // Compile the actual request-consumption gate. Only the GPU encoder
        // after it, mutex context and clock are replaced in this ROM-free test.
        const fixture = `
#include <cassert>
#include <mutex>
std::mutex g_mutex;
bool g_snapshotRequested = false, encoded = false;
int g_nextSnapshotTime = 0;
constexpr int SnapshotInterval = 10;
struct Clock { static int now() { return 100; } };
#define ZoneScoped ((void)0)
void encode(bool producerComplete) ${source.slice(body, end)} encoded = true; }
int main() {
    g_snapshotRequested = true;
    encode(false);
    assert(g_snapshotRequested && !encoded && g_nextSnapshotTime == 0);
    encode(true);
    assert(!g_snapshotRequested && encoded && g_nextSnapshotTime == 110);
    encoded = false;
    g_snapshotRequested = true;
    encode(true);
    assert(g_snapshotRequested && !encoded); // Throttled request is retained.
    g_nextSnapshotTime = 0;
    g_snapshotRequested = false;
    encode(true);
    assert(!encoded); // No unsolicited capture.
}
`;
        const path = join(directory, 'depth.cpp');
        writeFileSync(path, fixture);
        check(path, directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
