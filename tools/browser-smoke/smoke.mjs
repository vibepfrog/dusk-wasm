/* smoke.mjs — headless Chrome smoke test for the dusk WASM build.
 *
 * Drives the user's installed Chrome (via puppeteer-core; no bundled Chromium)
 * pointing at the local emrun server (default http://localhost:8080/).
 *
 * Captures: console messages with severity, page errors, navigation errors,
 * a screenshot at end, and the visible drop-zone + canvas state. Exits when
 * the page has been quiet for `QUIET_MS` (no new console messages) or after
 * `MAX_MS` total — whichever comes first.
 *
 * Run: node tools/browser-smoke/smoke.mjs [URL]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const URL_TO_TEST = process.argv[2] || 'http://localhost:8080/';
const QUIET_MS    = 8000;     // exit if no console activity for this long
const MAX_MS      = 90_000;   // hard cap (the wasm is 197 MB over localhost)
const SCREENSHOT  = resolve(__dirname, 'smoke-screenshot.png');

const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Users/shift/AppData/Local/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find(existsSync);
if (!chromePath) {
    console.error('No Chrome/Edge found in standard install paths.');
    process.exit(2);
}
console.log('[smoke] using browser:', chromePath);
console.log('[smoke] testing URL:  ', URL_TO_TEST);

const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
        // Headless WebGPU on Windows needs SwiftShader Vulkan since there's
        // no display server adapter. --enable-unsafe-webgpu opts past the
        // origin-trial gate that sometimes still applies in headless.
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer',
        '--use-vulkan=swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
    ],
    // Use a temp profile dir so we don't interfere with the user's normal Chrome.
    userDataDir: undefined,
    defaultViewport: { width: 1280, height: 720 },
});

const page = await browser.newPage();

/* ── Event capture ──────────────────────────────────────────────────── */

let lastEventAt = Date.now();
const events = [];
function note(kind, msg) {
    lastEventAt = Date.now();
    const line = `[${new Date().toISOString().slice(11, 23)}] ${kind.padEnd(10)} ${msg}`;
    events.push(line);
    console.log(line);
}

page.on('console', msg => {
    const t = msg.type();   // log, info, warn, error, debug
    note(t.toUpperCase(), msg.text());
});
page.on('pageerror', err => note('PAGEERROR', `${err.message}\n${err.stack || ''}`));

// Inject a window.onerror handler so we get file:line:col for parse-time errors
// (puppeteer's pageerror event drops the location for SyntaxErrors).
await page.evaluateOnNewDocument(() => {
    window.addEventListener('error', e => {
        const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '<no location>';
        // Use console.error so puppeteer's console listener picks it up.
        console.error('[onerror] ' + (e.message || '?') + ' @ ' + where);
    });
});
page.on('error',     err => note('ERROR',     `${err.message}`));
page.on('requestfailed', req => {
    note('REQ-FAIL', `${req.method()} ${req.url()} — ${req.failure()?.errorText || '?'}`);
});
page.on('response', res => {
    const s = res.status();
    if (s >= 400) note('HTTP-' + s, `${res.request().method()} ${res.url()}`);
});

/* ── Navigate + wait ────────────────────────────────────────────────── */

note('NAV', `goto ${URL_TO_TEST}`);
try {
    await page.goto(URL_TO_TEST, { waitUntil: 'load', timeout: MAX_MS });
    note('NAV', 'page load fired');
} catch (e) {
    note('NAV-FAIL', e.message);
}

/* Quiet-watcher: exit when no event for QUIET_MS, or hard cap MAX_MS. */
const start = Date.now();
while (Date.now() - start < MAX_MS) {
    if (Date.now() - lastEventAt > QUIET_MS) break;
    await new Promise(r => setTimeout(r, 500));
}
note('SMOKE', `done (elapsed ${((Date.now() - start) / 1000).toFixed(1)}s, ${events.length} events)`);

/* ── DOM snapshot ───────────────────────────────────────────────────── */

const dom = await page.evaluate(() => {
    const dropZone   = document.getElementById('drop-zone');
    const canvas     = document.getElementById('canvas');
    const bootStatus = document.getElementById('boot-status');
    const importStatus = document.getElementById('import-status');
    return {
        dropZoneVisible:  dropZone && !dropZone.classList.contains('hidden'),
        dropZoneText:     dropZone?.textContent?.trim().slice(0, 200),
        canvasPresent:    !!canvas,
        canvasSize:       canvas ? `${canvas.width}x${canvas.height}` : null,
        bootStatusText:   bootStatus?.textContent?.trim(),
        importStatusText: importStatus?.textContent?.trim(),
        // Module + FS introspection (best-effort)
        moduleExists:     typeof window.Module === 'object',
        runtimeReady:     window.Module?.calledRun === true,
        fsMounted:        typeof window.FS?.analyzePath === 'function',
        cisoExists:       (() => {
            try { return window.FS?.analyzePath('/iso/dusk.ciso')?.exists ?? null; }
            catch { return 'error'; }
        })(),
        wgpuAvailable:    typeof navigator.gpu === 'object',
    };
});
note('DOM', JSON.stringify(dom, null, 2));

await page.screenshot({ path: SCREENSHOT, fullPage: false });
note('SHOT', `wrote ${SCREENSHOT}`);

await browser.close();

/* ── Report ─────────────────────────────────────────────────────────── */

console.log('\n──── SUMMARY ────');
const errs  = events.filter(e => /ERROR|PAGEERROR|REQ-FAIL|HTTP-[45]/.test(e));
const warns = events.filter(e => /WARN/.test(e));
console.log(`events: ${events.length}  errors: ${errs.length}  warnings: ${warns.length}`);
if (errs.length) {
    console.log('\nErrors:');
    for (const e of errs.slice(0, 30)) console.log(' ', e);
}
process.exit(errs.length === 0 ? 0 : 1);
