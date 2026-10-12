/* THE END-TO-END BENCH: the real server, a real browser, real terminals.
 *
 * Only the VM manager and the privileged host commands are stand-ins (see
 * fake-clavarium-host.mjs): everything the product itself does
 * -- pages, API, WebSocket bridge, tmux sessions, files, pairing -- runs for
 * real. A test here fails for the reasons a person would be let down.
 *
 * The browser comes from the `playwright` package, or from wherever
 * CLAVARIUM_E2E_PLAYWRIGHT points. Without either, every test here is
 * SKIPPED and says so: a suite that passes without having run is worse than
 * one that is absent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startHome } from '../server/main.mjs';
import { readTools } from '../server/tools.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

async function loadPlaywright() {
    for (const from of [process.env.CLAVARIUM_E2E_PLAYWRIGHT && `${process.env.CLAVARIUM_E2E_PLAYWRIGHT}/index.mjs`, 'playwright']) {
        if (!from) continue;
        try { return await import(from); } catch { /* try the next one */ }
    }
    return undefined;
}
const playwright = await loadPlaywright();
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
export const SKIP = !playwright ? 'no browser: install the "playwright" package, or set CLAVARIUM_E2E_PLAYWRIGHT'
    : !hasTmux ? 'tmux is not installed' : false;

/* A plain shell with a fixed prompt, so that tests can tell "ready". */
const TOOLS = readTools(JSON.stringify([
    { id: 'shell', label: 'Shell', command: ['env', 'PS1=ready> ', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [] },
    { id: 'other', label: 'Other tool', command: ['env', 'PS1=other> ', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [] },
]));

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Starts everything; `t.after` takes it all down, tmux servers included. */
/* `tools`: other tools than the two plain shells (the pictures of the site are
   taken on this bench, with the names a reader knows). */
export async function bench(t, { stopDelayMs = 60_000, launchSeconds = '1', microphone, mailReader, tools, answerFetcher } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-e2e-'));
    /* A speech-to-text engine that hears the same sentence whatever it is sent. */
    const engine = createServer((request, response) => { request.resume(); request.on('end', () => response.end(JSON.stringify({ text: 'said out loud' }))); });
    await new Promise((ready) => engine.listen(0, '127.0.0.1', ready));
    process.env.FAKE_VM_DIR = dir;
    process.env.FAKE_VM_LAUNCH_SECONDS = launchSeconds;
    const server = await startHome({
        port: 0, dataDir: join(dir, 'data'), tools: tools ? readTools(JSON.stringify(tools)) : TOOLS, stopDelayMs, mailReader, gitLocalRemotes: true,
        /* Three readers that are not models: what they say is decided by the test. */
        ...(answerFetcher ? { answerFetcher, answerEveryMs: 300 } : {}),
        wakeEveryMs: 300,
        env: { ...process.env, ...(answerFetcher ? { CLAVARIUM_ANSWERER_URL: 'http://127.0.0.1:9/v1/chat/completions', CLAVARIUM_ANSWERER_MODELS: 'reader-one,reader-two,reader-three' } : {}), CLAVARIUM_TRANSCRIPTION_URL: `http://127.0.0.1:${engine.address().port}/v1/audio/transcriptions` },
        host: [process.execPath, join(HERE, 'fake-clavarium-host.mjs')],
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    /* `microphone`: a WAV file the browser will hear as its microphone. */
    const browser = await playwright.chromium.launch(microphone ? { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${microphone}`] } : {});
    const contexts = [];
    t.after(async () => {
        await browser.close();
        server.closeAllConnections?.(); server.close(); engine.close();
        for (const line of spawnSync('sh', ['-c', 'ls /tmp/tmux-$(id -u) 2>/dev/null'], { encoding: 'utf8' }).stdout.split('\n')) {
            if (line.startsWith('e2e-clv-')) spawnSync('tmux', ['-L', line, 'kill-server'], { stdio: 'ignore' });
        }
        rmSync(dir, { recursive: true, force: true });
    });

    /* A person at a screen. `phone: true` is a small touch screen. */
    async function person({ phone = false, at = '/', context: given } = {}) {
        const context = given ?? await browser.newContext(microphone ? { viewport: { width: 1200, height: 760 }, permissions: ['microphone'] } : phone ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 760 }, acceptDownloads: true });
        contexts.push(context);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(origin + at);
        const screen = () => page.evaluate(() => { const b = window.clavariumTerminal.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += `${b.getLine(i).translateToString(true)}\n`; return s; });
        const until = async (what, check, ms = 20_000) => {
            const end = Date.now() + ms;
            for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await wait(100); }
        };
        const state = () => page.locator('#state').innerText();
        const sees = (text, ms) => until(`the terminal shows ${JSON.stringify(text)}`, async () => (await screen()).includes(text), ms);
        const type = async (text) => { await page.locator('#terminal').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
        const api = (path, body) => page.evaluate(async ([p, b]) => { const r = await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, body]);
        /* Creates a conversation from the page, as a person does, and waits for its terminal. */
        async function create(name, tool = 'Shell', { onDisk = false } = {}) {
            await page.locator('#new').click();
            await page.fill('#create-name', name);
            if (onDisk) await page.locator('#create-disk').check();
            await page.locator('#create-tools button', { hasText: tool }).click();
            await page.locator('#create button[type=submit]').click();
            await until(`${name} is live`, async () => (await state()) === 'live', 30_000);
            await sees(tool === 'Shell' ? 'ready>' : 'other>');
        }
        /* A folder is made in Assets. */
        async function newFolder(name) {
            await page.locator('#assets-open').click();
            await page.locator('#folder-box summary').click();
            await page.fill('#folder-name', name);
            await page.locator('#folder-new button[type=submit]').click();
            await until(`${name} is listed in Assets`, async () => (await page.locator(`#assets-folder .asset[data-name="${name}"]`).count()) === 1);
            await page.locator('#assets-close').click();
        }
        /* What the conversation shown may do with it, set in Access: 'Read', 'Write', or 'Off' (detached). */
        async function access(name, level) {
            await page.locator('#folders').click();
            const row = page.locator(`#panel-rows .folder[data-name="${name}"]`);
            await until('its sheet is painted', async () => (await page.locator('#panel-title').innerText()).startsWith('This conversation - '));
            if (level === 'Off') {
                await row.locator('button', { hasText: 'Detach' }).click();
                await until(`${name} is detached`, async () => (await row.count()) === 0);
            } else if ((await row.count()) > 0) {
                await row.locator('.levels button', { hasText: level }).click();
                await until(`${name} is ${level}`, async () => (await row.locator('.levels button[aria-pressed=true]').innerText().catch(() => '')) === level);
            } else {
                await page.locator('#attach-open').click();
                await page.locator(`#attach-rows .folder[data-name="${name}"]`).locator('button', { hasText: level }).click();
                await until(`${name} is attached`, async () => (await row.count()) === 1);
            }
            await page.locator('#panel-close').click();
        }
        return { page, context, errors, screen, until, state, sees, type, api, create, newFolder, access };
    }
    return { origin, dir, person, browser };
}
