<div align="center">
  <img src="res/logo-mascot.png" alt="Logo" width="640">

  <p align="center">
    <a href="https://twilitrealm.dev">Official Website (upstream)</a>
    •
    <a href="https://discord.gg/dusktp">Discord (upstream)</a>
    •
    <a href="https://sh1ftmaker.github.io/dusk-wasm/">Live build (this fork)</a>
  </p>
</div>

> [!WARNING]
> **This is an unofficial fork.** It adds a WebAssembly target so Dusk runs
> in a Chromium-based browser via WebGPU. It is **not affiliated with, endorsed
> by, or supported by [TwilitRealm](https://github.com/TwilitRealm) or the
> upstream Dusk project**. Bug reports about the web build should be filed
> against this repo's issues, not the upstream — please do not bother the
> upstream maintainers with port-specific problems.
>
> Upstream lives at **https://github.com/TwilitRealm/dusk**. If you want the
> stable, supported desktop builds, go there. This fork is experimental.

# WebAssembly port

This branch (`wasm-port`) builds a single static page that boots Dusk in any
modern Chromium-based browser after a one-time EUR ISO upload. The wasm
bundle, JS shell, and packed assets are published to GitHub Pages at
**https://sh1ftmaker.github.io/dusk-wasm/** on every push to `wasm-port`.

How it works:

- The original Aurora (GX → WebGPU translator) is vendored under
  `extern/aurora/` and points at the browser's WebGPU API via
  [emdawnwebgpu](https://github.com/google/dawn/tree/main/third_party/emdawnwebgpu).
- The Rust portions (`nod` for disc parsing) target
  `wasm32-unknown-emscripten` via Corrosion.
- The C++ port follows the dusk-decomp source unchanged where possible;
  wasm-specific touchpoints (`OSResumeThread` thread-spawn skips, main-loop
  `emscripten_sleep(0)` yields, function-pointer signature widenings for
  wasm CFI, RmlUi depth/stencil pinning) are documented in
  [`docs/wasm-port-notes.md`](docs/wasm-port-notes.md) and
  [`CLAUDE.md`](CLAUDE.md).

Current state (2026-05): boots through Aurora init, WebGPU surface
configured, reaches the prelaunch "WELCOME TO DUSK" preset selection UI,
click input works (`Classic`/`Dusk` buttons), advances to the controller
assignment screen. Disc-streamed game content (movies, scripted audio,
level data) does not yet load because the worker threads are
silently no-op'd on emscripten without `-pthread` — see
`docs/wasm-port-notes.md` for the cooperative-scheduler plan.

# Upstream Overview

Dusk is a reverse-engineered reimplementation of Twilight Princess.

It aims to be as accurate as possible to the original while also providing new options, enhancements, and tools to customize your experience.

# Setup

> [!IMPORTANT]
> Dusk does *not* provide any copyrighted assets. You must provide your own copy of the original game.

### 1. Verify your dump

First, make sure your dump of the game is clean and supported by Dusk. You can do this by checking the SHA-1 hash of your dump against this list of supported versions:

| Version      | SHA-1 hash                                 |
|--------------| ------------------------------------------ |
| GameCube USA | `75edd3ddff41f125d1b4ce1a40378f1b565519e7` |
| GameCube EUR | `2601822a488eeb86fb89db16ca8f29c2c953e1ca` |

*Support for other versions of the game is planned in the future.

### 2. Download [Dusk](https://github.com/TwilitRealm/dusk/releases)

### 3. Setup the game
**Windows / macOS / Linux**
- Extract the .zip file
- Launch Dusk
- Press **Select Disc Image** and provide the path to your supported game dump
- Press **Play**!

**iOS**
- Follow the [iOS setup guide](docs/ios-install-altstore.md)

**Android**
- Install the Dusk apk
- Launch Dusk
- Press **Select Disc Image** and provide the path to your supported game dump
- Press **Play**!

# Building

If you'd like to build Dusk from source, please read the [build instructions](docs/building.md).

Pull requests are welcomed! Note that we do not accept contributions that are primarily AI-generated and will close your PR if we suspect as much.

# Credits

Special thanks to the [TP decompilation](https://github.com/zeldaret/tp) team, the GC/Wii decompilation community, the [Aurora](https://github.com/encounter/aurora) developers, the [TP speedrunning community](https://zsrtp.link), and all [contributors](https://github.com/TwilitRealm/dusk/graphs/contributors).

<br/>
<div align="center">
    <a href="https://github.com/encounter/aurora">
        <img src="assets/aurora-powered.png" alt="Powered by Aurora" width="800">
    </a>
</div>
