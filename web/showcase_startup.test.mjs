import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';

// Compile the production C++ entry points with a small scene-manager fixture.
// This exercises their interaction across frames, without a disc or renderer.
// Do not copy the startup logic into a JavaScript model: that missed the logo's
// repeated calls, which could overwrite an already accepted PLAY request.
function entryPoint(file, signature) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = source.indexOf(signature + ' {');
    assert.notEqual(start, -1, `Missing production entry point: ${signature}`);
    const end = source.indexOf('\n}', start);
    assert.notEqual(end, -1, `Missing function boundary: ${signature}`);
    return source.slice(start, end + 2);
}

let directory, executable;
before(() => {
    directory = mkdtempSync(join(tmpdir(), 'dusk-showcase-startup-'));
    executable = join(directory, 'startup');
    const fixture = `
#include <cassert>
#include <string>
using fpc_ProcID = unsigned int;
constexpr fpc_ProcID fpcM_ERROR_PROCESS_ID_e = 0xFFFFFFFF;
struct scene_class { fpc_ProcID id = 1; };
fpc_ProcID fopScnM_GetID(scene_class* scene) { return scene->id; }
struct dScnLogo_c : scene_class {
    bool isOpeningCut() { return false; }
    void nextSceneChange();
};
constexpr int fpcNm_PLAY_SCENE_e = 1, fpcNm_OPENING_SCENE_e = 2;
namespace mDoRst { bool resetting = false; bool isReset() { return resetting; } }
int requests = 0, rejections = 0, openingCalls = 0, preparations = 0;
int queuedScene = 0;
std::string nextStage;
bool uiBusy = false;
int fopScnM_ChangeReq(scene_class*, int scene, int, int) {
    ++requests;
    if (rejections) { --rejections; return 0; }
    assert(!queuedScene); // accepted requests must not be issued again
    queuedScene = scene;
    return 1;
}
void dComIfG_changeOpeningScene(scene_class*, int scene) {
    ++openingCalls;
    nextStage = "F_SP102";
    // The real opening helper re-requests the scene even if the queue is busy.
    queuedScene = scene;
}
#define MAIN_THREAD_EM_ASM(body, message, scene, locked) \\
    ((void)(message), (void)(scene), uiBusy = (locked))
namespace dusk::showcase {
bool enabled = false, bootPending = false, benchmarking = false;
bool waiting = false, exiting = false;
fpc_ProcID bootLogoID = fpcM_ERROR_PROCESS_ID_e;
int sceneIndex = 0;
bool active() { return enabled; }
${entryPoint('../src/dusk/showcase.cpp', 'void status(const char* text)')}
void set_stage() {
    ++preparations;
    nextStage = "F_SP103";
    waiting = true;
    status("Loading");
}
${entryPoint('../src/dusk/showcase.cpp', 'bool boot(scene_class* logo)')}
}
${entryPoint('../src/d/d_s_logo.cpp', 'void dScnLogo_c::nextSceneChange()')}
int main(int argc, char** argv) {
    assert(argc == 2);
    const std::string scenario = argv[1];
    dScnLogo_c logo;
    if (scenario == "campaign") {
        logo.nextSceneChange();
        assert(openingCalls == 1 && queuedScene == fpcNm_OPENING_SCENE_e);
        assert(nextStage == "F_SP102" && requests == 0 && preparations == 0);
    } else if (scenario == "accepted" || scenario == "retry") {
        dusk::showcase::enabled = dusk::showcase::bootPending = true;
        const int blockedFrames = scenario == "retry" ? 2 : 0;
        rejections = blockedFrames;
        for (int frame = 0; frame < 12; ++frame) {
            logo.nextSceneChange();
            assert(openingCalls == 0 && nextStage == "F_SP103");
            if (frame < blockedFrames) {
                assert(dusk::showcase::bootPending && queuedScene == 0);
            } else {
                assert(!dusk::showcase::bootPending && queuedScene == fpcNm_PLAY_SCENE_e);
            }
        }
        assert(requests == blockedFrames + 1 && preparations == requests);
    } else if (scenario == "return") {
        dusk::showcase::enabled = dusk::showcase::bootPending = true;
        logo.nextSceneChange();
        assert(queuedScene == fpcNm_PLAY_SCENE_e);
        queuedScene = 0; // first logo finished; Reset creates a new process
        ++logo.id; // deliberately reuse its memory, as an allocator can do
        logo.nextSceneChange();
        assert(openingCalls == 1 && queuedScene == fpcNm_OPENING_SCENE_e);
        assert(nextStage == "F_SP102" && requests == 1);
        assert(dusk::showcase::enabled); // isolation ends later at file select
    } else if (scenario == "controls") {
        dusk::showcase::enabled = dusk::showcase::bootPending = true;
        dusk::showcase::status("Preparing");
        assert(uiBusy); // native startup has no playable location yet
        logo.nextSceneChange();
        assert(uiBusy);
        dusk::showcase::waiting = false;
        dusk::showcase::status("Ready");
        assert(!uiBusy);
    } else {
        assert(false && "Unknown scenario");
    }
}
`;
    const file = join(directory, 'startup.cpp');
    writeFileSync(file, fixture);
    const build = spawnSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', file, '-o', executable],
        { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, build.error?.message || build.stderr);
});
after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

for (const [scenario, description] of [
    ['campaign', 'ordinary launch still requests the title screen'],
    ['accepted', 'showcase keeps its accepted handoff across subsequent logo frames'],
    ['retry', 'showcase retries rejected requests without falling through to the title'],
    ['return', 'a new logo after reset can return to the campaign while saves remain isolated'],
    ['controls', 'benchmark controls stay busy from startup until the location is ready'],
]) {
    test(description, () => {
        const run = spawnSync(executable, [scenario], { encoding: 'utf8', timeout: 5_000 });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
    });
}
