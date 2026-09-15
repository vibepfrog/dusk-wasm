import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('../extern/aurora/lib/window.cpp', import.meta.url), 'utf8');
function entryPoint(signature) {
    const start = source.indexOf(signature + ' {');
    assert.notEqual(start, -1);
    const end = source.indexOf('\n}', start);
    assert.notEqual(end, -1);
    return source.slice(start, end + 2);
}

// Compile actual window sizing and creation against an SDL fixture. In SDL
// 3.4.4 the minimum-size setter reapplies saved floating dimensions; model that
// behaviour so a browser viewport cannot silently revert to desktop geometry.
const fixture = `
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <limits>
template<class T> struct Vec2 { T x, y; };
struct Config {
    uint32_t windowWidth = 1280, windowHeight = 960;
    int windowPosX = -1, windowPosY = -1;
    bool startFullscreen = false;
    const char* appName = "Dusk";
} g_config;
using Sint32 = int;
using SDL_WindowFlags = uint64_t;
enum AuroraBackend { BACKEND_AUTO };
constexpr int SDL_WINDOW_HIGH_PIXEL_DENSITY = 1, SDL_WINDOW_FULLSCREEN = 2;
constexpr int SDL_WINDOW_HIDDEN = 4, SDL_WINDOW_RESIZABLE = 8;
constexpr int SDL_WINDOWPOS_UNDEFINED = -1;
constexpr int SDL_PROP_WINDOW_CREATE_TITLE_STRING = 1, SDL_PROP_WINDOW_CREATE_X_NUMBER = 2;
constexpr int SDL_PROP_WINDOW_CREATE_Y_NUMBER = 3, SDL_PROP_WINDOW_CREATE_WIDTH_NUMBER = 4;
constexpr int SDL_PROP_WINDOW_CREATE_HEIGHT_NUMBER = 5, SDL_PROP_WINDOW_CREATE_FLAGS_NUMBER = 6;
struct Window { int w, h, floatingW, floatingH; } instance;
Window* g_window = nullptr;
int requestedW, requestedH, minimumCalls = 0;
uint64_t requestedFlags;
double cssW = 1920, cssH = 1080;
int cssResult = 0;
constexpr int EMSCRIPTEN_RESULT_SUCCESS = 0;
int emscripten_get_element_css_size(const char*, double* w, double* h) {
    *w = cssW; *h = cssH; return cssResult;
}
int SDL_CreateProperties() { return 1; }
bool SDL_SetStringProperty(int, int, const char*) { return true; }
bool SDL_SetNumberProperty(int, int key, int64_t value) {
    if (key == SDL_PROP_WINDOW_CREATE_WIDTH_NUMBER) requestedW = value;
    if (key == SDL_PROP_WINDOW_CREATE_HEIGHT_NUMBER) requestedH = value;
    if (key == SDL_PROP_WINDOW_CREATE_FLAGS_NUMBER) requestedFlags = value;
    return true;
}
Window* SDL_CreateWindowWithProperties(int) {
    instance = {requestedW, requestedH, requestedW, requestedH};
    return &instance;
}
bool SDL_SetWindowMinimumSize(Window* window, int w, int h) {
    ++minimumCalls;
    window->w = std::max(window->floatingW, w);
    window->h = std::max(window->floatingH, h);
    return true;
}
const char* SDL_GetError() { return "fixture"; }
struct Logger { template<class... T> void error(T...) {} } Log;
void set_window_icon() {}
#define TRY(condition, ...) assert(condition)
${entryPoint('Vec2<int> initial_window_size()')}
${entryPoint('bool create_window(AuroraBackend backend)')}
int main() {
#ifdef __EMSCRIPTEN__
    for (const auto viewport : {Vec2<int>{1920,1080}, Vec2<int>{3440,1440}, Vec2<int>{360,240}}) {
        cssW = viewport.x; cssH = viewport.y;
        assert(create_window(BACKEND_AUTO));
        assert(g_window->w == viewport.x && g_window->h == viewport.y);
        assert(minimumCalls == 0);
        assert(requestedFlags & SDL_WINDOW_HIGH_PIXEL_DENSITY); // SDL applies DPR once
    }
    cssW = 853.4; cssH = 479.6;
    assert(create_window(BACKEND_AUTO));
    assert(g_window->w == 853 && g_window->h == 480);
    cssW = 0; cssH = 0;
    assert(create_window(BACKEND_AUTO));
    assert(g_window->w == 1280 && g_window->h == 960);
    cssW = std::numeric_limits<double>::quiet_NaN(); cssH = 1080;
    assert(create_window(BACKEND_AUTO));
    assert(g_window->w == 1280 && g_window->h == 960);
#else
    assert(create_window(BACKEND_AUTO));
    assert(g_window->w == 1280 && g_window->h == 960 && minimumCalls == 1);
    g_config.windowWidth = 320; g_config.windowHeight = 240;
    assert(create_window(BACKEND_AUTO));
    assert(g_window->w == 640 && g_window->h == 480);
#endif
}
`;

for (const browser of [true, false]) {
    test(browser ? 'browser window matches the viewport before its first resize, including small viewports' :
        'desktop window defaults and minimum size are retained', () => {
        const directory = mkdtempSync(join(tmpdir(), 'dusk-window-startup-'));
        try {
            const file = join(directory, 'window.cpp'), executable = join(directory, 'window');
            writeFileSync(file, fixture);
            const flags = browser ? ['-D__EMSCRIPTEN__'] : [];
            const build = spawnSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', ...flags,
                file, '-o', executable], { encoding: 'utf8', timeout: 30_000 });
            assert.equal(build.status, 0, build.error?.message || build.stderr);
            const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 5_000 });
            assert.equal(run.status, 0, run.error?.message || run.stderr);
        } finally { rmSync(directory, { recursive: true, force: true }); }
    });
}
