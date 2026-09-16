// Reproduce the first bad access in the pre-fix production binary, without a
// disc, game initialization, or threads. This is an instruction-level probe,
// not a gameplay test. See docs/faron-myna-crash.md for scope and provenance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

assert.equal(process.argv.length, 3, 'Usage: node tools/diagnose-faron-myna.mjs <pre-fix index.wasm>');
const bytes = readFileSync(process.argv[2]);
assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '45f6c1072f6c6194287c3c6452e89ae433d951cc766c2ccfcd9d8cfc9e785d96',
    'This probe is pinned to the reported pre-fix binary; offsets must not be used with another build');

let position = 8;
function readULEB() {
    let value = 0, shift = 0, byte;
    do {
        byte = bytes[position++];
        value += (byte & 127) * 2 ** shift;
        shift += 7;
    } while (byte & 128);
    return value;
}
function uleb(value) {
    const out = [];
    do {
        let byte = value & 127;
        value >>>= 7;
        if (value) byte |= 128;
        out.push(byte);
    } while (value);
    return Buffer.from(out);
}

// Add an export for the EXISTING execute function. Do not alter any function
// body, data segment, or initializer. Account for the export's offset shift.
let instrumented, offsetShift;
while (position < bytes.length) {
    const sectionStart = position, id = bytes[position++];
    const size = readULEB(), sectionEnd = position + size;
    if (id === 7) {
        const count = readULEB(), payloadStart = position;
        const name = Buffer.from('diagnostic_myna_execute');
        const data = Buffer.concat([uleb(count + 1), bytes.subarray(payloadStart, sectionEnd),
            uleb(name.length), name, Buffer.from([0]), uleb(8759)]);
        const section = Buffer.concat([Buffer.from([7]), uleb(data.length), data]);
        offsetShift = section.length - (sectionEnd - sectionStart);
        instrumented = Buffer.concat([bytes.subarray(0, sectionStart), section, bytes.subarray(sectionEnd)]);
        break;
    }
    position = sectionEnd;
}
assert(instrumented, 'Missing export section');
const module = await WebAssembly.compile(instrumented);
const memory = new WebAssembly.Memory({ initial: 4096, maximum: 32768, shared: true });
const imports = { env: { memory } };
for (const { module: owner, name, kind } of WebAssembly.Module.imports(module)) {
    if (kind === 'function') (imports[owner] ??= {})[name] = () => {
        throw new Error(`Unexpected host call: ${owner}.${name}`);
    };
}
const instance = await WebAssembly.instantiate(module, imports);
// The module start has initialized the REAL passive data segments.
const view = new DataView(memory.buffer);
assert.equal(view.getUint32(1928768, true), 0, 'Expected absent message service');
assert.equal(view.getUint32(292, true), 0);
assert.equal(view.getUint32(4, true), 0);
assert.equal(view.getUint32(1468, true), 0x6d6d6f63, 'Expected rodata bytes "comm"');
assert(0x6d6d6f63 >= memory.buffer.byteLength);

let failure;
try {
    // Valid zeroed storage for the two actor-field reads preceding the query.
    instance.exports.diagnostic_myna_execute(0x01000000);
} catch (error) {
    failure = error;
}
assert(failure instanceof WebAssembly.RuntimeError);
assert.match(failure.message, /memory access out of bounds/);
const adjustedOffset = (0x6d8b64 + offsetShift).toString(16);
assert(failure.stack.includes(`:0x${adjustedOffset}`), failure.stack);
console.log(JSON.stringify({
    reproduced: true,
    function: 'daMyna_c::execute()',
    originalOffset: '0x6d8b64',
    diagnosticOffset: `0x${adjustedOffset}`,
    currentMessage: null,
    invalidStatusPointer: '0x6d6d6f63 (rodata bytes "comm")',
    memoryBytes: memory.buffer.byteLength,
    threadsStarted: 0,
    hostCalls: 0,
}, null, 2));
