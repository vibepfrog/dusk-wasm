# Faron Woods zone-load crash — 2026-09-16

This is separate from the intermittent, unreproduced Alt+Tab/fade-to-grey
report. Asynchronous shader work is paused for this fix.

## Evidence and first invalid access

The user's full console log (1,591 lines, 46 distinct lines) starts with
`memory access out of bounds` in `daMyna_c::execute()` at `0x6d8b64`, called
from `daMyna_Create` at `0x6dc845`. `daMyna_c` is **Trill**, the shop bird.
Actor creation itself calls `execute()` after loading `Npc_myna` and initializing
its heap and state. Later pthread errors and 43 repeated proxy-assertion cycles
follow the first trap; no earlier resource/room diagnostics were included.

Log SHA256: `04fe5864b5059358270ef6d0c40a1622c1f8dda74fcb9b64172541cff6c3a8f2`.

Pre-fix release: `0137bed76a125b70f72cf109c7be578458448e3f` on
`vibepfrog/dusk-wasm:wasm-port`.
Downloaded production `index.wasm`: **21,021,578 bytes**,
SHA256 `45f6c1072f6c6194287c3c6452e89ae433d951cc766c2ccfcd9d8cfc9e785d96`.
The module's name section identifies function 8759 as `daMyna_c::execute()`.
WABT `wasm-objdump -d` gives:

```text
6d8b3c func[8759] <daMyna_c::execute()>:
... actor state-byte reads ...
6d8b51: i32.const 1928768   ; current message-object pointer slot
6d8b56: i32.load 2 0
6d8b59: i32.load 2 292     ; dMsgObject_c::mpRenProc
6d8b5d: i32.load 2 4       ; JMessage::TProcessor reference
6d8b60: i32.load 2 1468    ; jmessage_tReference::mpStatus
6d8b64: i32.load16_u 1 0   ; FAULT: *mpStatus
```

Source chain:

- `src/d/actor/d_a_myna.cpp`: `daMyna_c::create` -> `execute`.
- `include/d/d_msg_object.h`: `dMsgObject_isTalkNowCheck`.
- `src/d/d_msg_object.cpp`: `dMsgObject_c::getStatus` -> `getStatusLocal`.
- `include/d/d_msg_class.h`: `jmessage_tReference::getStatus`, `return *mpStatus`.

The optimized function inlines this chain. It faults **before** `setItemInfo`,
shop searches, animation/model calculations, collision, or `checkDead`.
The creation heap callback has the correct `int(fopAc_ac_c*)` signature;
this is not the previous scarecrow callback ABI problem.

## Reproduction without a disc or another thread

Run against the exact pre-fix artifact (the current URL will change on deployment):

```sh
node tools/diagnose-faron-myna.mjs /path/to/pre-fix/index.wasm
```

The probe verifies the binary hash, adds an export for the existing function
8759, and instantiates the real module with its original data initialization.
It does not modify function instructions or start game threads. All host-call
stubs fail if called. Zeroed actor storage is inside valid memory, and the
message service is absent, as it is before its queued creation request runs.

The actual production function traps on the same instruction. Adding the
export shifts its file offset by 27 bytes to `0x6d8b7f`.
With a null message pointer, the intermediate reads at addresses 292 and 4
return zero. Address 1468 (`0x5bc`) contains actual rodata `"common key index"`;
its first four bytes become pointer **`0x6d6d6f63`** (`"comm"`, little-endian).
The final 16-bit read is outside the initial 256 MiB memory. This explains why
an unchecked null query becomes a distant WASM out-of-bounds read.

This reproduces the **first invalid access**, not a complete zone transition.
The original browser log has no live pointer dump, so unrelated earlier
corruption cannot be categorically disproved; it is unnecessary to reproduce
this exact failure, and there is no evidence for it in the supplied log.

## Lifecycle and fix

`dComIfG_play_c::itemInit` clears the message-object slot for a scene.
`dStage_playerInit` queues player and HUD (`METER2`) creation. Later,
`dMeter2_Create` queues `MSG_OBJECT` via `fopMsgM_Create` -> `fpcM_Create` ->
`fpcSCtRq_Request`; this does not construct the object synchronously.
Actors also have phased resource loading and can finish creation and run
their first `execute()` before the message request is serviced.
`dMsgObject_Create` registers and initializes the message object on the game
worker; `_delete` clears the slot during teardown.

The fix makes `dMsgObject_isTalkNowCheck()` return **false when the message
object is absent**. Once it exists, every original status retains the same
meaning (`status != 1`). This is a meaningful absence check for a predicate,
not an attempt to hide an invalid non-null pointer. The helper queries the
current service each time, so later creation immediately restores normal
dialogue behavior. It adds no allocations, cached pointers, ownership changes,
creation retries, resource leaks, or save-format changes. The same semantics
apply to native PC and WASM. No browser suspension/input code is changed.

The exact source/offset match and single-thread reproduction reject a required
thread race, pointer-width conversion, alignment issue, archive relocation,
or Trill shop-array overrun as the explanation for this first access. WASM
exposes a creation-order assumption that native timing need not expose.

Emscripten 5.0.6's
[callback.c](https://github.com/emscripten-core/emscripten/blob/5.0.6/system/lib/html5/callback.c)
asserts at line 42 when it cannot enqueue a browser event onto the target
thread. Its position after the uncaught worker trap in this log and the
independent reproduction support **secondary fallout**, not a cause of the
original invalid access. No callback suppression was added.

## Diagnostics and regression checks

- `web/message_lifecycle.test.mjs` compiles the real predicate against a small
  message-service fixture. It checks no status access before creation/after
  destruction, all 65,536 status values, and 64 create/delete/recreate cycles.
  Native uses ASan/UBSan; CI also builds/runs it as real WASM with pinned
  Emscripten 5.0.6 (`DUSK_MESSAGE_TEST_WASM=1`). This is a focused lifecycle
  test, not a linked native-game or gameplay test.
- Normal CI still builds the complete WASM game and runs all browser tests.
- Opt-in `-DDUSK_TRACE_ENABLE=ON` records Trill's first execute and destruction
  (actor ID, address, stage, placement room, parameters, heap/model and message
  pointers), and bounded missing-message execute logs. It also records message
  creation/destruction, renderer/reference pointers, and the real status
  address. It is compiled out of production. Stage/room values from this trace
  can resolve the user's geographic description; the log alone does not name
  an exact room ID, and this checkout has no disc stage-placement data.
- For a fresh crash, preserve the first stack plus these lifecycle logs and
  exact matching binary hash. Investigate a non-null invalid message separately;
  do not extend the predicate into speculative range checks. SAFE_HEAP or a
  DWARF diagnostic build is an escalation if that evidence warrants it; neither
  is needed permanently for the demonstrated null-chain failure.

## Validation still requiring gameplay

No valid game disc or matching Faron save is available in the development
workspace. Do not mark these as passed based on the unit fixture:

1. Enter the Faron passage destination repeatedly; leave and return at least
   ten times, including a fresh browser session.
2. Save/reload on both sides; check Trill dialogue and shop interactions.
3. Check actor/scene heap recovery across transitions in a trace build.
4. Repeat with tab hide/resume during transitions; this fix does not claim to
   solve the earlier intermittent grey-screen report.
5. Repeat the area on a full native PC build if available.

## Nearby audit items (not silently included in this fix)

- `daMyna_c::deleteItem(fpc_ProcID)` finds slot `i` but writes
  `mShopItems[i_itemId]`. `daObj_SSItem_c::buy` passes a process ID, so this is a
  separate concrete out-of-bounds risk during purchases. Fix slot selection
  with a dedicated high-process-ID regression test before claiming shop safety.
- `getItemNumMax()` extracts a 4-bit count but arrays contain ten items. Check
  actual placement values and count invariants before changing game behavior.
- Trill's TARGET_PC destructor already resets file-static actor pointers that
  were formerly cleared by REL unload. Overlapping instances/room ownership
  remain worth auditing, but that path does not explain this first query.
