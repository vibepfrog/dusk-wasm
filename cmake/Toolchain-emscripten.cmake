# Emscripten toolchain wrapper.
# Usage: cmake --preset web-emscripten
# (or `emcmake cmake ...`, which sets this automatically and is the recommended path).
#
# Resolves the real Emscripten.cmake from $EMSDK or $EMSCRIPTEN. We don't ship a
# bundled SDK because emsdk is large (~2 GB) and updates frequently — the pinned
# version is in tools/emsdk-version (5.0.6, matching slider's web-release branch).

if(NOT DEFINED ENV{EMSDK} AND NOT DEFINED ENV{EMSCRIPTEN})
    message(FATAL_ERROR
        "Emscripten SDK not found.\n"
        "  1. Install emsdk: https://emscripten.org/docs/getting_started/downloads.html\n"
        "  2. Install + activate the pinned version (see tools/emsdk-version):\n"
        "       ./emsdk install 5.0.6 && ./emsdk activate 5.0.6\n"
        "  3. Activate it in your shell:\n"
        "       source /path/to/emsdk/emsdk_env.sh        (POSIX)\n"
        "       C:/path/to/emsdk/emsdk_env.ps1            (PowerShell)\n"
        "  4. Prefer `emcmake cmake --preset web-emscripten` (sets the toolchain automatically).")
endif()

if(DEFINED ENV{EMSDK})
    set(_EMSCRIPTEN_TOOLCHAIN "$ENV{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
elseif(DEFINED ENV{EMSCRIPTEN})
    set(_EMSCRIPTEN_TOOLCHAIN "$ENV{EMSCRIPTEN}/cmake/Modules/Platform/Emscripten.cmake")
endif()

if(NOT EXISTS "${_EMSCRIPTEN_TOOLCHAIN}")
    message(FATAL_ERROR "Emscripten.cmake not found at: ${_EMSCRIPTEN_TOOLCHAIN}")
endif()

include("${_EMSCRIPTEN_TOOLCHAIN}")
