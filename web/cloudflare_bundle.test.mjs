import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCloudflareBundle } from './cloudflare_bundle.mjs';

test('Pages limits cover nested optional assets and accept the exact file-size boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dusk-pages-'));
    try {
        mkdirSync(join(dir, 'optional'));
        const asset = join(dir, 'optional', 'large.bin');
        writeFileSync(asset, '');
        truncateSync(asset, 25 * 1024 * 1024);
        assert.deepEqual(inspectCloudflareBundle(dir), [{ path: 'optional/large.bin', bytes: 25 * 1024 * 1024 }]);
        truncateSync(asset, 25 * 1024 * 1024 + 1);
        assert.throws(() => inspectCloudflareBundle(dir), /optional\/large.bin.*25 MiB/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Pages upload inspection rejects excess files and symlinks without traversing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dusk-pages-'));
    try {
        writeFileSync(join(dir, 'one'), '');
        writeFileSync(join(dir, 'two'), '');
        assert.equal(inspectCloudflareBundle(dir, 2).length, 2);
        assert.throws(() => inspectCloudflareBundle(dir, 1), /file-count/);
        symlinkSync(dir, join(dir, 'cycle'));
        assert.throws(() => inspectCloudflareBundle(dir), /symlinks/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
