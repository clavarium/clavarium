import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ssh } from 'clavarium-tether/connectors/ssh';
import { bench, SKIP } from './bench.mjs';

/* A MACHINE'S SHARED CONSOLE (16-11): Settings > Assets, a machine opened: under who has it, its live console -- the
   person types in it; the conversation given the machine opens the same shell through Tether and types in it. At
   « propose » its input is a card beside the console (Send / Edit / Refuse), a destructive one marked; a password
   prompt hides the input from the AI; the person's key takes back control; « Hide from the AI »; full screen with the
   conversation's chat beside it. Desktop, tablet, phone; light and dark. The machine is Tether's real ssh connector
   over a stand-in ssh2 client playing a tiny shell (no network). example.com only. */
const SHOTS = process.env.CLAVARIUM_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const MACHINE = { id: 'home-server', title: 'Serveur maison', kind: 'ssh', connector: 'ssh', config: { host: 'server.example.com', user: 'admin' }, secrets: { key: 'HOME_SERVER_KEY' } };
const SECRET = 'correct-horse-battery-staple-42';

/* A tiny shell: echoes keys, runs a line on Enter, asks a password for sudo (echo off). */
function tinyShell() {
    const s = new EventEmitter(); s.stderr = new EventEmitter();
    let line = ''; let mode = 'cmd';
    const out = (t) => setImmediate(() => s.emit('data', Buffer.from(t)));
    const prompt = () => out('\x1b[32madmin@maison\x1b[0m:~$ ');
    const RUNS = {
        uptime: ' 10:12:04 up 41 days,  3:02,  2 users,  load average: 0,31, 0,22, 0,18',
        'df -h': 'Filesystem   Size  Used Avail Use% Mounted on\r\n/dev/sda1     58G   53G  5,1G  91% /',
        'df -h /': 'Filesystem   Size  Used Avail Use% Mounted on\r\n/dev/sda1     58G   53G  5,1G  91% /',
        'systemctl status nginx': '\x1b[31m× nginx.service - A high performance web server\r\n     Active: failed (Result: exit-code) since Mon 02:14:07\x1b[0m',
        'cat notes.txt': '<b>not bold</b> <img src=x onerror="window.pwned=1">',
    };
    s.write = (d) => {
        for (const ch of String(d)) {
            if (ch === '\x15') { if (line && mode === 'cmd') out('\b \b'.repeat(line.length)); line = ''; continue; }
            if (ch === '\x03') { line = ''; mode = 'cmd'; out('^C\r\n'); prompt(); continue; }
            if (ch === '\r' || ch === '\n') {
                const got = line; line = '';
                out('\r\n');
                if (mode === 'pass') { mode = 'cmd'; out(`Hit:1 http://deb.example.com bookworm InRelease\r\nReading package lists... Done\r\n`); prompt(); continue; }
                if (/^sudo apt/.test(got)) { mode = 'pass'; out('[sudo] password for admin: '); continue; }
                if (got) out(`${RUNS[got] ?? `${got.split(' ')[0]}: done`}\r\n`);
                prompt(); continue;
            }
            line += ch;
            if (mode === 'cmd') out(ch);
        }
        return true;
    };
    s.setWindow = () => {}; s.end = () => s.emit('close'); s.close = s.end;
    setImmediate(() => { out('Debian GNU/Linux 12 · last login: yesterday 21:40\r\n'); prompt(); });
    return s;
}
class FakeClient extends EventEmitter {
    connect() { setImmediate(() => this.emit('ready')); return this; }
    shell(opts, cb) { cb(null, tinyShell()); }
    exec(command, cb) { const st = new EventEmitter(); st.stderr = new EventEmitter(); st.close = () => {}; st.destroy = () => {}; setImmediate(() => { st.emit('data', Buffer.from(`output of ${command}\n`)); st.emit('close', 0); }); cb(null, st); }
    sftp(cb) { cb(new Error('no sftp here')); }
    end() { this.emit('close'); }
}

test('a machine\'s shared console: the person and the AI on one shell; proposals, destructive, hidden input, key wins, hidden from the AI, full screen with its chat; on three screens', { skip: SKIP }, async (t) => {
    const b = await bench(t, { tetherTargets: [MACHINE], tetherConnectors: { ssh: ssh({ Client: FakeClient, typeMs: 40, settleMs: 300 }) } });
    const me = await b.person();
    const page = me.page;
    await page.setViewportSize({ width: 1280, height: 860 });
    await me.create('ops');
    assert.equal((await me.api('/api/secrets', { name: 'HOME_SERVER_KEY', value: 'a-stand-in-key-for-this-test', hostOnly: true })).status, 201);
    assert.equal((await me.api('/api/conversations/ops/talk', { on: true })).status, 200);
    assert.equal((await me.api('/api/tether/level', { target: 'home-server', agent: 'conversation:ops', level: 'propose' })).status, 200);
    /* The conversation's agent asks through its .tether folder; its answers come back there. */
    const side = join(b.dir, 'kept-work', 'ops', 'work', '.tether');
    mkdirSync(side, { recursive: true });
    let n = 0;
    const ask = (op, args) => { const id = `a${++n}`; appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id, op, args: { target: 'home-server', ...args }, at: new Date().toISOString() })}\n`); return id; };
    const answers = join(side, 'answers.jsonl');
    const answerOf = (id) => (existsSync(answers) ? readFileSync(answers, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.ask === id && a.held !== true) : undefined);
    const answered = async (id, ms = 20_000) => { await me.until(`the answer to ${id}`, async () => Boolean(answerOf(id)), ms); return answerOf(id); };

    /* Assets, the machine: its console, live, under who has it. */
    await page.goto(`${b.origin}/?open=assets`);
    await me.until('the Assets place', async () => page.locator('#assets').isVisible());
    await page.locator('#assets-rows .as-row[data-asset="connexion:home-server"]').click();
    const sc = page.locator('#assets-detail .sc');
    const screen = page.locator('.sc .sc-screen .xterm-rows');
    const text = async () => (await screen.count()) ? screen.innerText() : '';
    await me.until('the console is live', async () => (await text()).includes('admin@maison'), 20_000);
    assert.match(await page.locator('.sc-live').innerText(), /live/);
    /* The person types: their own keys, their own shell. */
    await page.locator('.sc .sc-screen').click();
    await page.keyboard.type('uptime'); await page.keyboard.press('Enter');
    await me.until('uptime ran', async () => (await text()).includes('load average'));
    /* What the machine prints is drawn by the terminal only: nothing of it runs. */
    await page.keyboard.type('cat notes.txt'); await page.keyboard.press('Enter');
    await me.until('the file shown as text', async () => (await text()).includes('<img src=x'));
    assert.equal(await page.evaluate(() => window.pwned ?? null), null);
    assert.equal(await page.locator('.sc img').count(), 0);

    /* The AI joins (a read, even at propose) and proposes a line: a card under the console. */
    assert.equal((await answered(ask('terminal.open', { why: 'look at nginx' }))).ok, true);
    await me.until('the AI on the console', async () => (await page.locator('.sc-chip.ai').count()) === 1);
    const typedId = ask('terminal.type', { text: 'df -h', enter: true, why: 'Disk almost full? See what takes room.' });
    const card = page.locator('.sc-ask').first();
    await me.until('its proposal', async () => (await card.count()) === 1, 20_000);
    assert.match(await card.locator('.sc-why').innerText(), /See what takes room/);
    assert.equal(await card.locator('.sc-cmd').innerText(), 'df -h');
    assert.equal(await page.locator('#assets-detail .as-chapter h3', { hasText: 'Waiting for you' }).count(), 0, 'not shown twice in the generic list');
    /* Edited, then sent: the person's line is typed, the AI told it was edited. */
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await card.locator('textarea').fill('df -h /');
    await shot(page, 'desktop-dark-proposal-edit');
    await card.locator('button', { hasText: 'Send as edited' }).click();
    const typed = await answered(typedId);
    assert.equal(typed.ok, true, typed.text); assert.match(typed.text, /edited/);
    await me.until('df ran on the shared screen', async () => (await text()).includes('91% /'));
    await me.until('the journal says it', async () => /df -h \//.test(await page.locator('.sc-journal').innerText()));
    assert.match(await page.locator('.sc-journal').innerText(), /edited by you/);

    /* Destructive: marked, said plainly, sent only in two steps; refused here. */
    const riskId = ask('terminal.type', { text: 'sudo rm -rf /var/log/nginx/*', enter: true, why: 'Free some room by emptying the nginx logs.' });
    const risky = page.locator('.sc-ask.risky');
    await me.until('the destructive proposal', async () => (await risky.count()) === 1, 20_000);
    assert.match(await risky.locator('.sc-risk').innerText(), /Destructive/);
    assert.match(await risky.locator('.sc-risk-say').innerText(), /Erases files/);
    await shot(page, 'desktop-dark-destructive');
    await risky.locator('button', { hasText: 'Refuse' }).click();
    const refused = await answered(riskId);
    assert.equal(refused.ok, false); assert.match(refused.text, /refused/);
    assert.doesNotMatch(await text(), /rm -rf/);

    /* At free: the AI types alone, character by character; a password prompt hides the input from it. */
    assert.equal((await me.api('/api/tether/level', { target: 'home-server', agent: 'conversation:ops', level: 'free' })).status, 200);
    const sudoId = ask('terminal.type', { text: 'sudo apt update', enter: true, why: 'Refresh the package lists.' });
    await me.until('the AI typing, said in words', async () => /is typing/.test(await page.locator('.sc-state').innerText()), 20_000);
    await shot(page, 'desktop-dark-ai-typing');
    const sudo = await answered(sudoId);
    assert.equal(sudo.ok, true, sudo.text); assert.match(sudo.text, /password prompt/);
    await me.until('hidden input, said', async () => (await sc.getAttribute('class')).includes('hidden-input'));
    assert.match(await page.locator('.sc-state').innerText(), /hidden input/i);
    assert.equal(await page.locator('.sc-secret').getAttribute('aria-pressed'), 'true');
    await shot(page, 'desktop-dark-hidden-input');
    await page.locator('.sc .sc-screen').click();
    await page.keyboard.type(SECRET); await page.keyboard.press('Enter');
    await me.until('apt went on', async () => (await text()).includes('Reading package lists'));
    const read = await answered(ask('terminal.read', { lines: 200 }));
    assert.equal(read.ok, true);
    assert.match(read.text, /\[hidden input\]/); assert.match(read.text, /Reading package lists/);
    assert.ok(!read.text.includes(SECRET), 'the secret never reaches the AI');
    const journal = await me.api('/api/tether/console-journal', { target: 'home-server' });
    assert.ok(!JSON.stringify(journal.body).includes(SECRET), 'nor the journal');
    assert.ok(!readFileSync(join(b.dir, 'data', 'tether', 'journal.jsonl'), 'utf8').includes(SECRET));

    /* The person's key wins: the AI's partial line erased, nothing of it sent. */
    const longId = ask('terminal.type', { text: 'systemctl restart nginx php8.2-fpm postgresql redis-server', enter: true, why: 'Restart the web stack.' });
    await me.until('the AI typing again', async () => !(await page.locator('.sc-take').isHidden()), 20_000);
    await page.locator('.sc-take').click();
    const cut = await answered(longId);
    assert.equal(cut.ok, false); assert.match(cut.text, /took back control/);
    await me.until('the journal says control was taken back', async () => /took back control/.test(await page.locator('.sc-journal').innerText()));

    /* Hidden from the AI: it reads a notice, not the screen. */
    await page.locator('.sc-hide-ai').click();
    await me.until('hidden from the AI', async () => (await page.locator('.sc-hide-ai').getAttribute('aria-pressed')) === 'true');
    assert.match(await page.locator('.sc-chip.ai').innerText(), /sees nothing/);
    const blind = await answered(ask('terminal.read', {}));
    assert.match(blind.text, /hid this console from you/);
    await page.locator('.sc-hide-ai').click();
    await me.until('shown again', async () => (await page.locator('.sc-hide-ai').getAttribute('aria-pressed')) === 'false');

    /* terminal.run while the console is open: shown there as if typed. */
    assert.equal((await answered(ask('terminal.run', { command: 'uname -a', why: 'Which kernel?' }))).ok, true);
    await me.until('the run shown in the console', async () => (await text()).includes('output of uname -a'));
    await shot(page, 'desktop-dark-console');

    /* Full screen: the console large, the chat of « ops » beside it; Escape out of the terminal leaves it. */
    await page.locator('.sc-full-btn').click();
    const full = page.locator('body > .sc.sc-full');
    await me.until('full screen', async () => full.isVisible());
    await me.until('its chat beside it', async () => (await page.locator('.sc-chat .parley-box, .sc-chat textarea').count()) > 0, 20_000);
    assert.match(await page.locator('.sc-chat-head').innerText(), /ops/);
    await me.until('the screen still there', async () => (await text()).includes('output of uname -a'));
    await shot(page, 'desktop-dark-fullscreen');
    await page.locator('.sc-chat-head').click();
    await page.keyboard.press('Escape');
    await me.until('full screen left', async () => (await full.count()) === 0);
    await me.until('back in the panel', async () => (await page.locator('#assets-detail .sc').count()) === 1);

    /* A tablet, light; then a phone: the keys bar, nothing wider than the screen. */
    await page.evaluate(() => localStorage.setItem('clavarium-theme', 'light'));
    for (const [name, w, h] of [['tablet-light', 820, 1180], ['phone-light', 390, 844]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.reload();
        await me.until('the Assets place', async () => page.locator('#assets').isVisible());
        const row = page.locator('#assets-rows .as-row[data-asset="connexion:home-server"]');
        if (!(await page.locator('#assets-detail .sc').count()) && await row.isVisible()) await row.click();
        await me.until(`the console on a ${name}`, async () => (await text()).includes('admin@maison'), 20_000);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no sideways scroll`);
        if (name.startsWith('phone')) assert.ok(await page.locator('.sc-keys').isVisible(), 'the keys bar on a phone');
        await shot(page, name);
        if (name.startsWith('phone')) {
            const pid = ask('terminal.type', { text: 'reboot', enter: true, why: 'The update needs a restart.' });
            await me.until('a destructive proposal on the phone', async () => (await page.locator('.sc-ask.risky').count()) === 1, 20_000);
            await page.locator('.sc-ask.risky').scrollIntoViewIfNeeded();
            await shot(page, 'phone-light-destructive');
            await page.locator('.sc-ask.risky button', { hasText: 'Refuse' }).click();
            assert.equal((await answered(pid)).ok, false);
            await page.locator('.sc-full-btn').click();
            await me.until('full screen on the phone', async () => page.locator('body > .sc.sc-full').isVisible());
            await me.until('its chat under it', async () => (await page.locator('.sc-chat .parley-box, .sc-chat textarea').count()) > 0, 20_000);
            await shot(page, 'phone-light-fullscreen');
        }
    }
    assert.deepEqual(me.errors, []);
});
