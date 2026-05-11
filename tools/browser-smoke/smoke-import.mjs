/* smoke-import.mjs — drive the full ISO upload → CISO write → reload → game-boot
 * flow in headless Chrome. Drops the verified EUR ISO via Puppeteer, watches the
 * import phases, waits for the auto-reload, and reports what state main() reaches.
 *
 * Run: node tools/browser-smoke/smoke-import.mjs [URL]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI: smoke-import.mjs [--headful] [URL]
const args = process.argv.slice(2);
const HEADFUL = args.includes('--headful');
const URL_TO_TEST = args.find(a => /^https?:\/\//.test(a)) || 'http://127.0.0.1:8081/';
const ISO_PATH    = 'C:/Users/shift/Desktop/dusk-wasm/The Legend of Zelda - Twilight Princess (E).iso';
const SCREENSHOT  = resolve(__dirname, 'smoke-import-screenshot.png');

// CISO conversion of a 1.4 GB GC disc takes ~30-90s on this hardware (per Phase 5
// DoD). Add headroom for SHA-1 verify (~5-15s) and post-reload wasm boot (~5s).
const IMPORT_TIMEOUT_MS = 180_000;
const POST_RELOAD_MS    = 30_000;

const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chromePath = CHROME_CANDIDATES.find(existsSync);
if (!chromePath) { console.error('Chrome not found'); process.exit(2); }
if (!existsSync(ISO_PATH)) { console.error('ISO not found at', ISO_PATH); process.exit(2); }
const isoSizeMB = (statSync(ISO_PATH).size / 1e6).toFixed(1);
console.log('[smoke-import] browser:', chromePath);
console.log('[smoke-import] URL:    ', URL_TO_TEST);
console.log('[smoke-import] ISO:    ', ISO_PATH, `(${isoSizeMB} MB)`);
console.log('[smoke-import] mode:   ', HEADFUL ? 'HEADFUL (real GPU)' : 'headless (SwiftShader CPU)');

const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: HEADFUL ? false : 'new',
    args: HEADFUL
        // Headful: let Chrome use the real GPU. --enable-unsafe-webgpu opts past
        // origin-trial gates that may still apply for explicit-port hosting.
        ? [
            '--enable-unsafe-webgpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,800',
        ]
        // Headless: WebGPU requires a Vulkan adapter; SwiftShader provides a CPU
        // fallback so the test runs anywhere even without a GPU. Known to be
        // missing features that real GPUs have — use --headful for fidelity.
        : [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan,UseSkiaRenderer',
            '--use-vulkan=swiftshader',
            '--no-sandbox',
            '--disable-dev-shm-usage',
        ],
    defaultViewport: { width: 1280, height: 720 },
    protocolTimeout: 240_000,  // CDP commands during file upload can be slow for 1.4 GB
});

const page = await browser.newPage();
// Inner-loop iteration: never serve cached wasm/JS — local dev server doesn't set
// proper cache-control, and the browser otherwise pins the first-seen wasm even
// after rebuilds, masking real fixes as "still broken".
await page.setCacheEnabled(false);

const events = [];
let lastEventAt = Date.now();
function note(kind, msg) {
    lastEventAt = Date.now();
    const line = `[${new Date().toISOString().slice(11, 23)}] ${kind.padEnd(11)} ${msg}`;
    events.push(line);
    console.log(line);
}

page.on('console', m => note(m.type().toUpperCase(), m.text()));
page.on('pageerror', e => {
    note('PAGEERROR', `${e.message}`);
    if (e.stack) note('PAGESTACK', e.stack);
});
page.on('error',     e => note('ERROR',     `${e.message}`));

// onerror handler for parse-time + uncaught errors with file:line:col
await page.evaluateOnNewDocument(() => {
    window.addEventListener('error', e => {
        const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '<no location>';
        console.error('[onerror] ' + (e.message || '?') + ' @ ' + where);
    });
});

/* ── 1. First navigation: drop-zone visible, no CISO ─────────────────── */
note('STEP', '1/4 first nav (no CISO yet)');
await page.goto(URL_TO_TEST, { waitUntil: 'load', timeout: 60_000 });
// Wait for the wasm runtime to be ready (Module.calledRun = true).
await page.waitForFunction(() => window.Module && window.Module.calledRun === true,
                            { timeout: 60_000, polling: 500 });
note('STEP', '1/4 done — wasm runtime ready');

/* ── 2. Upload the EUR ISO via the file input ────────────────────────── */
note('STEP', '2/4 upload ISO');
const fileInput = await page.$('input[type=file]');
if (!fileInput) { note('FATAL', 'no <input type=file> found'); await browser.close(); process.exit(1); }
const uploadStart = Date.now();
await fileInput.uploadFile(ISO_PATH);
note('STEP', `2/4 done — uploadFile call returned in ${((Date.now()-uploadStart)/1000).toFixed(1)}s`);

/* ── 3. Wait for the import flow to finish (drop-zone hides) ────────── */
note('STEP', '3/4 wait for CISO conversion + drop-zone hide');
const importStart = Date.now();
try {
    // The shell hides drop-zone and calls Module.callMain() after import succeeds.
    // No reload — main() runs in this same Module instance.
    await page.waitForFunction(() => {
        const dz = document.getElementById('drop-zone');
        return dz && dz.classList.contains('hidden');
    }, { timeout: IMPORT_TIMEOUT_MS, polling: 500 });
    note('STEP', `3/4 done — import + callMain in ${((Date.now()-importStart)/1000).toFixed(1)}s`);
} catch (e) {
    note('STEP-FAIL', `3/4 drop-zone never hid within ${IMPORT_TIMEOUT_MS/1000}s: ${e.message}`);
}

/* ── 4. Post-callMain: let game boot output flush ─────────────────────── */
note('STEP', '4/4 wait for post-import boot output');
const bootStart = Date.now();
// Just wait for activity to settle — Aurora init logs will pour in.
while (Date.now() - bootStart < POST_RELOAD_MS) {
    if (Date.now() - lastEventAt > 3000) break;
    await new Promise(r => setTimeout(r, 250));
}
note('STEP', `4/4 settled after ${((Date.now()-bootStart)/1000).toFixed(1)}s`);

// Quiet wait — let any post-boot console output flush
const quietStart = Date.now();
while (Date.now() - quietStart < 10_000) {
    if (Date.now() - lastEventAt > 3_000) break;
    await new Promise(r => setTimeout(r, 250));
}

/* ── DOM snapshot ───────────────────────────────────────────────────── */
const dom = await page.evaluate(() => ({
    dropZoneVisible: document.getElementById('drop-zone') &&
                     !document.getElementById('drop-zone').classList.contains('hidden'),
    canvasSize:      (() => { const c = document.getElementById('canvas');
                              return c ? `${c.width}x${c.height}` : null; })(),
    bootStatusText:  document.getElementById('boot-status')?.textContent?.trim(),
    importStatusText:document.getElementById('import-status')?.textContent?.trim(),
    moduleExists:    typeof window.Module === 'object',
    runtimeReady:    window.Module?.calledRun === true,
    cisoExists:      (() => { try { return window.FS?.analyzePath('/iso/dusk.ciso')?.exists ?? null; }
                              catch { return 'error'; } })(),
    cisoSize:        (() => { try { return window.FS?.stat('/iso/dusk.ciso')?.size ?? null; }
                              catch { return null; } })(),
}));
note('DOM', JSON.stringify(dom, null, 2));

await page.screenshot({ path: SCREENSHOT, fullPage: false });
note('SHOT', SCREENSHOT);

/* ── 5. Click the "Dusk" preset button (center of right-hand button) ──── */
// The welcome dialog's Dusk button is centered ~ x=798, y=376 in the
// 1280x720 viewport. The canvas captures pointer events directly via SDL3,
// so a Puppeteer mouse click at the screen coords is dispatched into the
// game's input loop. After the click, wait briefly for the UI to advance
// (next-screen RmlUi render or a navigation into the game proper).
note('STEP', '5/5 click Dusk preset button');
await page.mouse.move(798, 376);
await new Promise(r => setTimeout(r, 200));
await page.mouse.click(798, 376);
const clickStart = Date.now();
while (Date.now() - clickStart < 8_000) {
    if (Date.now() - lastEventAt > 2_000) break;
    await new Promise(r => setTimeout(r, 250));
}
note('STEP', `5/5 settled after ${((Date.now()-clickStart)/1000).toFixed(1)}s`);

const SCREENSHOT_AFTER = resolve(__dirname, 'smoke-import-after-click.png');
await page.screenshot({ path: SCREENSHOT_AFTER, fullPage: false });
note('SHOT', SCREENSHOT_AFTER);

/* ── 6. Try to dismiss controller prompt: press Escape, then capture ──── */
note('STEP', '6/6 dismiss controller-prompt with Escape + Enter');
await page.focus('#canvas').catch(() => {});
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 1000));
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 1000));
await page.keyboard.press('Space');
const after2Start = Date.now();
while (Date.now() - after2Start < 5_000) {
    if (Date.now() - lastEventAt > 1500) break;
    await new Promise(r => setTimeout(r, 250));
}

const SCREENSHOT_FINAL = resolve(__dirname, 'smoke-import-after-dismiss.png');
await page.screenshot({ path: SCREENSHOT_FINAL, fullPage: false });
note('SHOT', SCREENSHOT_FINAL);

await browser.close();

console.log('\n──── SUMMARY ────');
const errs  = events.filter(e => /PAGEERROR|FATAL/.test(e));
console.log(`events: ${events.length}  errors: ${errs.length}`);
process.exit(errs.length === 0 ? 0 : 1);
