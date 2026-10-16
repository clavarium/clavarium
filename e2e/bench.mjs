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
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startHome } from '../server/main.mjs';
import { readTools } from '../server/tools.mjs';
import { installFakeSsh } from './fake-ssh.mjs';

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
    /* Started on its last session (`resume`), it says so in its environment. */
    { id: 'shell', label: 'Shell', command: ['env', 'PS1=ready> ', 'bash', '--norc', '--noprofile'], resume: ['env', 'PS1=ready> ', 'RESUMED=1', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [] },
    { id: 'other', label: 'Other tool', command: ['env', 'PS1=other> ', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [] },
]));

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* The tmux servers of this computer's user, by name. */
const tmuxDir = () => join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
const tmuxSockets = () => { try { return readdirSync(tmuxDir()); } catch { return []; } };
/* Taken down, and its socket taken away: a socket left behind would be looked at by every bench after. */
const tmuxDown = (line) => { spawnSync('tmux', ['-L', line, 'kill-server'], { stdio: 'ignore' }); rmSync(join(tmuxDir(), line), { force: true }); };
/* The name of a stand-in machine's tmux server, for a conversation. */
export const tmuxOf = (name) => `${process.env.FAKE_TMUX_PREFIX ?? 'e2e-'}clv-${name}`.slice(0, 40);

/* Starts everything; `t.after` takes it all down, tmux servers included. */
/* `tools`: other tools than the two plain shells (the pictures of the site are
   taken on this bench, with the names a reader knows). */
export async function bench(t, { stopDelayMs = 60_000, launchSeconds = '1', microphone, mailReader, tools, answerFetcher, alertSend } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-e2e-'));
    /* A speech-to-text engine that hears the same sentence whatever it is sent. */
    const engine = createServer((request, response) => { request.resume(); request.on('end', () => response.end(JSON.stringify({ text: 'said out loud' }))); });
    await new Promise((ready) => engine.listen(0, '127.0.0.1', ready));
    process.env.FAKE_VM_DIR = dir;
    /* The stand-in machines' tmux servers are named after this bench: another
       run on the same computer (a check in another working tree) does not
       take them down when it ends, nor they its own. Those of a bench whose
       folder is gone (one started after it ended) are taken down here. */
    const id = dir.slice(-6);
    process.env.FAKE_TMUX_PREFIX = `e2e-${id}-`;
    for (const line of tmuxSockets()) {
        const of = /^e2e-([A-Za-z0-9]{6})-/.exec(line)?.[1];
        if (of && !existsSync(join(tmpdir(), `clv-e2e-${of}`))) tmuxDown(line);
    }
    /* "The hosting service" of private repositories: reached over a stand-in ssh (fake-ssh.mjs). */
    const sshRoot = join(dir, 'far');
    const gitSsh = installFakeSsh(sshRoot);
    process.env.FAKE_VM_LAUNCH_SECONDS = launchSeconds;
    const server = await startHome({
        port: 0, dataDir: join(dir, 'data'), tools: tools ? readTools(JSON.stringify(tools)) : TOOLS, stopDelayMs, mailReader, gitLocalRemotes: true, gitSsh,
        /* A test machine may have little free disk: no reserve beyond the cap. */
        gitReserveBytes: 0,
        /* Three readers that are not models: what they say is decided by the test. */
        ...(answerFetcher ? { answerFetcher, answerEveryMs: 300 } : {}),
        wakeEveryMs: 300, alertSend, talkEveryMs: 200, gitEveryMs: 300,
        /* After a restart, the tool is given a moment, not seconds, before it is told to read its chat again. */
        rereadAfterMs: 500,
        /* The ready-made machine is built only when a test asks for it. */
        shelfEveryMs: 0,
        /* A folder missing in a machine is given a moment, not seconds, before it is mounted again. */
        healthSettleMs: 200,
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
        for (const line of tmuxSockets()) if (line.startsWith(`e2e-${id}-`)) tmuxDown(line);
        /* Work still finishing in the closed server (a git read, a store being written) may add a file
           while the folder is removed: removing is tried again rather than failing the test. */
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    /* A person at a screen. `phone: true` is a small touch screen. */
    /* `locale`: the language the browser says it reads (a French device: 'fr-FR'). */
    async function person({ phone = false, at = '/', context: given, locale } = {}) {
        const context = given ?? await browser.newContext({ ...(microphone ? { viewport: { width: 1200, height: 760 }, permissions: ['microphone'] } : phone ? { viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true } : { viewport: { width: 1200, height: 760 }, acceptDownloads: true }), ...(locale ? { locale } : {}) });
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
        /* Waits until a command has PRINTED `line` as its last line and the
           prompt is back under it. `sees` is not enough before measuring where
           text sits on the screen: the command typed is echoed first, and it
           holds its own output in quotes (echo "x" shows x at once), so `sees`
           can return before the command even ran -- then a `clear` and the
           real output move everything, and a click or a finger lands where
           the text no longer is. Under the load of the whole suite that gap
           is long enough to be hit. */
        const printed = (line, ms) => until(`the terminal printed ${JSON.stringify(line)}, and the prompt is back`, async () => {
            const rows = (await screen()).split('\n').map((row) => row.trimEnd());
            while (rows.length > 0 && rows.at(-1) === '') rows.pop();
            return rows.length >= 2 && rows.at(-2) === line && /^[a-z]+>$/.test(rows.at(-1));
        }, ms);
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
            await fullSize(name);
        }
        /* Waits until the terminal in the machine has the page's size. A screen
           that takes a terminal already open (bridge.mjs) sets it a line
           short, then right a moment later, so that the tool redraws: until
           the second size has arrived, the tool is still to be told of a
           change of size, and the shell, told while it draws its prompt,
           draws a second one -- after the output a test then reads (seen:
           "ready>" twice at the end of the copied screen). Typed only once
           the size is final, a test reads only what it typed. */
        async function fullSize(name) {
            const pane = () => spawnSync('tmux', ['-L', tmuxOf(name), 'list-panes', '-a', '-F', '#{pane_width}x#{pane_height}'], { encoding: 'utf8' }).stdout.trim();
            await until(`the terminal of ${name} has the page's size`, async () => pane() === await page.evaluate(() => `${window.clavariumTerminal.cols}x${window.clavariumTerminal.rows}`));
        }
        /* Access, one of the three places at the bottom left, on one of its tabs: 'map', 'devices' or 'assets'. */
        async function openAccess(tab = 'map') {
            await page.locator('#nav-access').click();
            await page.locator(`#tab-${tab}`).click();
            await until(`the ${tab} tab of Access is shown`, async () => (await page.locator(`#tab-${tab}`).getAttribute('aria-selected')) === 'true' && page.locator('#access').isVisible());
        }
        /* A folder is made in Assets. */
        async function newFolder(name) {
            await openAccess('assets');
            await page.locator('#folder-box summary').click();
            await page.fill('#folder-name', name);
            await page.locator('#folder-new button[type=submit]').click();
            await until(`${name} is listed in Assets`, async () => (await page.locator(`#assets-folder .asset[data-name="${name}"]`).count()) === 1);
            await page.locator('#access-close').click();
        }
        /* What the conversation shown may do with it, set in Access: 'Read', 'Write', or 'Off' (detached). */
        async function access(name, level) {
            await page.locator('#folders').click();
            const row = page.locator(`#panel-rows .folder[data-name="${name}"]`);
            await until('its sheet is painted', async () => (await page.locator('#panel-title').innerText()).startsWith('This conversation - '));
            await chapter('access');
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
        /* A chapter of "This conversation" is unfolded, if it is not already. */
        async function chapter(key) {
            const box = page.locator(`details.chapter[data-chapter="${key}"]`);
            if (!(await box.evaluate((d) => d.open))) await box.locator(':scope > summary').click();
        }
        /* On a phone: the bar's "..." menu is opened, and the keys behind "More". */
        async function menu() { if ((await page.locator('header').getAttribute('data-menu')) !== 'open') await page.locator('#menu').click(); }
        async function more() { if ((await page.locator('#keys').getAttribute('data-more')) !== 'true') await page.locator('#keys-more').click(); }
        return { page, context, errors, screen, until, state, sees, printed, type, api, create, fullSize, openAccess, newFolder, access, chapter, menu, more };
    }
    return { origin, dir, person, browser, sshRoot };
}
