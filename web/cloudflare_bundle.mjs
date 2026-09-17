import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Pages applies its limit to every uploaded asset, including files outside the
// required engine list. Do not let an optional nested asset bypass release QA.
export function inspectCloudflareBundle(directory, maxFiles = 20_000) {
    const files = [];
    function visit(path, relative = '') {
        for (const name of readdirSync(path)) {
            const full = join(path, name), label = relative + name;
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) throw new Error(label + ': upload symlinks are unsupported');
            if (stat.isDirectory()) { visit(full, label + '/'); continue; }
            if (!stat.isFile()) throw new Error(label + ': not a regular static asset');
            if (stat.size > 25 * 1024 * 1024) throw new Error(label + ': exceeds the Pages 25 MiB file limit');
            files.push({ path: label, bytes: stat.size });
            if (files.length > maxFiles) throw new Error('Upload exceeds the Pages file-count limit');
        }
    }
    visit(directory);
    return files.sort((a, b) => b.bytes - a.bytes);
}
