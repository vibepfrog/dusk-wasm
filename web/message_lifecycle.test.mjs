import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Exercise the real predicate with a fixture for the independently queued
// message service. This does not simulate a complete game scene or save file.
const source = readFileSync(new URL('../include/d/d_msg_object.h', import.meta.url), 'utf8');
const start = source.indexOf('inline bool dMsgObject_isTalkNowCheck() {');
assert.notEqual(start, -1);
const end = source.indexOf('\n}', start);
assert.notEqual(end, -1);
const predicate = source.slice(start, end + 2);
const fixture = `
#include <cassert>
#include <cstddef>
#include <cstdint>
using u16 = uint16_t;
struct dMsgObject_c { u16 mode; static u16 getStatus(); };
dMsgObject_c* currentMessage = nullptr;
unsigned statusReads = 0;
dMsgObject_c* dMsgObject_getMsgObjectClass() { return currentMessage; }
u16 dMsgObject_c::getStatus() {
    ++statusReads;
    assert(currentMessage != nullptr && "status queried before message creation");
    return currentMessage->mode;
}
${predicate}
int main() {
    // Early actor create/execute, then the later message-create request, then
    // teardown. Repetition checks that an earlier service is never retained.
    for (int transition = 0; transition < 64; ++transition) {
        const unsigned before = statusReads;
        for (int frame = 0; frame < 5; ++frame)
            assert(!dMsgObject_isTalkNowCheck());
        assert(statusReads == before);
        currentMessage = new dMsgObject_c{1};
        assert(!dMsgObject_isTalkNowCheck());
        assert(statusReads == before + 1);
        // Preserve every existing status, including 0 during initialization.
        for (unsigned mode = 0; mode <= UINT16_MAX; ++mode) {
            currentMessage->mode = mode;
            assert(dMsgObject_isTalkNowCheck() == (mode != 1));
        }
        delete currentMessage;
        currentMessage = nullptr;
        const unsigned after = statusReads;
        assert(!dMsgObject_isTalkNowCheck());
        assert(statusReads == after);
    }
}
`;

const wasm = process.env.DUSK_MESSAGE_TEST_WASM === '1';
test(`dialogue query tolerates queued creation and teardown (${wasm ? 'WASM' : 'native sanitizers'})`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'dusk-message-lifecycle-'));
    try {
        const input = join(directory, 'message.cpp');
        const executable = join(directory, wasm ? 'message.mjs' : 'message');
        writeFileSync(input, fixture);
        const flags = wasm
            ? ['-sENVIRONMENT=node', '-sASSERTIONS=1', '-sWASM_ASYNC_COMPILATION=0']
            : ['-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-fno-omit-frame-pointer'];
        const compile = spawnSync(wasm ? 'em++' : (process.env.CXX || 'c++'),
            ['-std=c++17', '-O2', ...flags, input, '-o', executable],
            { encoding: 'utf8', timeout: 60_000 });
        assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
        const run = spawnSync(wasm ? process.execPath : executable, wasm ? [executable] : [],
            { encoding: 'utf8', timeout: 15_000 });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
