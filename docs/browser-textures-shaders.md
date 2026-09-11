# Browser texture packs and shader preparation

Open **HD textures & shader preparation** before choosing the disc. Select a
local `.zip` containing Dusklight/Dolphin `tex1_*.dds` replacements, then select
the ISO/GCM/CISO as usual. The ZIP must be selected again after reload; its
contents are never uploaded or copied to browser storage. Use **Use original
textures** before launch to disable the pack. Reload to change packs during play.

The linked [TPDE+ 1.2.0 release](https://gamebanana.com/mods/676609) is distributed
as `TPDE+ 1.2.0.zip`; its release notes describe embedded mipmaps. This patch adds
the missing embedded-mipmap support to our older Aurora DDS loader. The full
third-party archive and real game rendering still require a user gameplay test.

Supported: single-volume ZIP/ZIP64, Store or Deflate, ASCII/UTF-8 paths, legacy
DXT1/DXT5/ATI2 DDS and supported DX10 RGBA8/BGRA8/BC1/BC3/BC5/BC7 formats.
Both embedded mip chains and older `_mipN.dds` sidecars work. PNG-only packs,
7z/RAR, encryption and other ZIP compression methods are rejected. Preserve
the pack's texture names. If an archive includes alternative versions of the
same texture in different folders, prepare a ZIP containing the desired set;
the first matching name in path order wins.

The loader reads only the ZIP directory (at most 8 MiB / 60,000 entries) and
individual DDS payloads (at most 64 MiB each). ZIP64 offsets are safe integers,
not truncated 32-bit offsets. Payloads stream through `DecompressionStream` with
an output limit and CRC check, on the rendering pthread via JSPI. The browser
and Wasm temporarily hold copies of the current texture. The whole archive is
never buffered or extracted. DDS dimensions are limited to 8192 and the device
limit. Unsupported BC compression falls back to original textures.

The replacement LRU budget is 256 MiB on web (native default remains 4 GiB).
This limits this cache's ownership; GPU resources still referenced by in-flight
frames/bind groups and the rest of the engine consume additional memory. First
loads, decompression, CRC checks, GPU uploads, and eviction/reloads can cause
stalls. Higher-resolution packs are not a performance improvement.

## Shader preparation

**Prepare saved shaders before play** is enabled by default. While playing,
the engine records Clear/GX pipeline configurations into a separate IndexedDB
database, `dusk-shader-recipes-v1`. Small writes are batched; hiding the page
also requests a flush. Campaign IDBFS and save files are unaffected. Browser
storage failure disables the optional cache without blocking the game.

On later launches the browser supplies at most 10,000 recipes / 16 MiB. The
engine checks the type, configuration version, size and original hash before
recreating each pipeline. Warmup uses WebGPU `CreateRenderPipelineAsync`, waits
for actual pipeline readiness through JSPI, and yields between batches before
gameplay. Progress appears at the bottom of the page. Disable the checkbox to
skip warmup for troubleshooting. This stores pipeline descriptions, not portable
GPU binaries. Browser/driver compilation caches are implementation-specific.

There is no complete first-launch shader collection: only previously visited
render states can be warmed. New scenes, effects or graphics settings may need
new pipelines. All pipelines required by a live frame are still completed before
draw replay; we do not skip draws to hide stutters. `[PipelineDiag]` logs include
CPU creation time; `[FrameProfile]` helps distinguish shader creation from other
frame costs. A low compile time does not rule out deferred GPU/driver stalls.

Compare two visits to the same area: play once, wait a few seconds, reload with
warmup enabled, then revisit. Check both the saved/prepared shader count and
the frame logs. This cannot fix asset I/O, texture uploads, garbage collection,
browser scheduling, GPU load or the remaining synchronous DVD path by itself.

Validation: Node tests cover ZIP Store/Deflate, sparse >4 GiB ZIP64 seeks,
malformed/archive expansion limits, CRC checks, worker handoff, recipe encoding,
cache limits and optional storage failure, alongside the existing save/launcher
checks. CI builds the complete Wasm and verifies its output. These are not a
claim of completed end-to-end game or texture-pack testing.
