# Browser showcase and benchmark

Before choosing a supported USA/EUR disc, enable **Quick showcase & benchmark**.
The engine loads the common game resources, then enters Ordon Village directly.
No campaign save or opening new-game cutscene is required. The selected disc and
optional HD texture pack remain local files, as in campaign mode.
Location and benchmark controls become available once the first location is
ready; they stay disabled during shader preparation and scene loading.

The showcase panel offers Ordon Village, Ordon Spring and the Fishing Pond.
Each selected visit creates a temporary human character with a sword, shield,
lantern and bow. Free exploration uses the normal controls. Press **0** for
settings, including Mouse Camera, and **Esc** to release the pointer before
using the page controls.

**Benchmark this location** reloads its entrance and performs the same
20-second camera sweep twice. **Benchmark all three** repeats this for each
location: about two minutes of measurement plus scene loading. The camera sweeps
around the entrance and checks background collision; this is a representative
sample, not an exhaustive shader museum or a full-game performance guarantee.
Free exploration can discover effects outside the camera route.

Character input is held during a benchmark. **Free explore** cancels it.
Hidden-tab time is excluded. Opening game settings or changing the presentation
settings/window size stops measurement so different configurations are not
silently combined. A scene transition or scripted event also invalidates an
unfinished sweep. Completed rows remain downloadable as a partial report.

Results include average rendered FPS, the slowest 1% frame rate, long-frame
counts, and newly created game pipelines. Shader builds are split into entry/load
and measured-sweep counts. The JSON download also includes frame intervals,
p95/p99/max intervals, resolution settings, frame interpolation, VSync, bloom,
shadow resolution, mirror mode, texture-pack filename and browser user agent.
Reports stay local unless a player chooses to share them.

These are frame-submission intervals including pacing, not direct GPU timings.
A first pass may already benefit from saved recipes or the browser's internal
cache. A prepared repeat can still discover a shader. Texture reads, ZIP
decompression/uploads and other work can cause spikes independently of shaders.
Dynamic actors continue to simulate; the route is repeatable, not a deterministic
replay of every actor and random effect.

The existing recipe cache records shaders encountered here and prepares them on
future launches when **Prepare saved shaders before play** is enabled. **Prepare
shader download** creates a separate recipe download for later catalog building.
It contains rendering configurations, not disc assets or compiled GPU binaries.

**Return to campaign** uses the engine's normal reset path while retaining the
WebGPU device. Press Start on the title screen to open file selection. Shader
pipelines stay available in this renderer session. Campaign saving is re-enabled
only after file selection has reset the temporary progression and item state.

## Save isolation

The native card controller rejects showcase save/format requests before they
are queued; it never copies the temporary progress into the campaign write
buffer. The worker operations have a second guard. Autosave is suppressed.
The browser snapshot store independently ignores writes in isolated mode and
restores its working card files from the retained campaign snapshots on exit.
Existing save downloads remain available throughout the showcase. In-game save
attempts can report that no writable card is available; they do not save a demo
campaign.

## Validation and remaining gameplay checks

Automated browser-code tests cover opt-in launch, benchmark statistics and
campaign isolation/restoration, including a player with no existing save. The
startup regression tests compile the actual C++ logo/showcase entry points with
a scene-manager fixture, checking repeated logo frames, rejected transition
requests, campaign startup/reset and controls during preparation. They need
a host C++ compiler (`c++`) alongside Node.
The full build must compile the engine hooks and run the generated-shell checks.
An actual supported disc is needed to verify entrances, local scripted events,
camera collision, all three completed routes, return to campaign, and saves on
both supported regions. Synthetic storage bytes are not gameplay validation.

This feature does not add asynchronous skip-drawing or ubershaders. The next
roadmap step is a settings toggle for asynchronous compilation, defaulting on;
ubershaders remain conditional on the results of that work.
