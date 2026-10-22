/* THE MAINTENANCE PAGE: an update about to stop the server is said to every page
   (server/updates.mjs, notice; a header on each answer), the page gives way to
   deploy/maintenance.html, which the front (Caddy) also serves while the server is
   down; the updater keeps that page and the front's block (ensureMaintenance). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { Updates, NOTICE_STALE_MS } from '../server/updates.mjs';
import { ensureMaintenance, MAINTENANCE_BLOCK, PLAIN_BLOCK, MAINTENANCE_DIR, MAINTENANCE_PAGE } from '../deploy/updater.mjs';
import { startHome, MAINTENANCE_HEADERS } from '../server/main.mjs';

const PAGE = readFileSync(MAINTENANCE_PAGE, 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
/* The page's own functions, run as the browser would, without a document: nothing starts. */
const page = vm.runInNewContext(`${SCRIPT}\n;({ next, title, backTo, EVERY_MS, STUCK_MS, RESTART_GRACE_MS })`, {});

function folder(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-maint-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
/* An installed server (update.conf there) whose updater is at `running`. */
function updatesAt(t, running, { version = '1.0.0', now = Date.parse('2026-10-22T03:00:00Z') } = {}) {
    const dir = folder(t);
    const stateFile = join(dir, 'state.json'); const confFile = join(dir, 'update.conf');
    writeFileSync(confFile, 'MODE=auto\n');
    writeFileSync(stateFile, JSON.stringify({ version, running, history: [] }));
    let clock = now;
    const u = new Updates({ host: async () => ({ code: 0 }), version, stateFile, confFile, lastLook: () => null, clock: () => clock });
    return { u, stateFile, tick: (ms) => { clock += ms; } };
}
const at = (minutesAgo) => new Date(Date.parse('2026-10-22T03:00:00Z') - minutesAgo * 60_000).toISOString();

test('the notice: said only from the step where the updater switches and restarts, towards another version, for a recent step', (t) => {
    const step = (s, extra = {}) => ({ action: 'update', version: '1.1.0', step: s, since: at(9), at: at(0.1), ...extra });
    for (const s of ['Fetching', 'Checking', 'Building', 'Testing', 'Backing up', 'Going back']) assert.equal(updatesAt(t, step(s)).u.notice(), '', `${s}: the server keeps working`);
    assert.equal(updatesAt(t, step('Switching')).u.notice(), 'update 1.1.0');
    assert.equal(updatesAt(t, step('Restarting')).u.notice(), 'update 1.1.0');
    assert.equal(updatesAt(t, step('Switching', { action: 'back', version: '0.9.0' })).u.notice(), 'back 0.9.0', 'going back to a kept release');
    assert.equal(updatesAt(t, step('Restarting'), { version: '1.1.0' }).u.notice(), '', 'the new server, up while the updater still watches it: nothing');
    assert.equal(updatesAt(t, step('Switching', { action: 'prepare' })).u.notice(), '');
    assert.equal(updatesAt(t, step('Switching', { at: at(NOTICE_STALE_MS / 60_000 + 1) })).u.notice(), '', 'an old step (an updater killed): no page held');
    assert.equal(updatesAt(t, step('Switching', { at: undefined })).u.notice(), '', 'an updater from before the notice says no time: nothing');
    assert.equal(updatesAt(t, step('Switching', { version: '1.1.0; x' })).u.notice(), '', 'only a version goes into the header');
    assert.equal(updatesAt(t, null).u.notice(), '', 'no update');
    const notInstalled = new Updates({ host: async () => ({ code: 0 }), version: '1.0.0', stateFile: join(folder(t), 'none.json'), confFile: join(folder(t), 'none.conf') });
    assert.equal(notInstalled.notice(), '', 'a server from a working tree');
});

test('the notice is read at most once a second: it is asked on every answer', (t) => {
    const s = updatesAt(t, null);
    assert.equal(s.u.notice(), '');
    writeFileSync(s.stateFile, JSON.stringify({ version: '1.0.0', running: { action: 'update', version: '1.1.0', step: 'Switching', at: at(0) } }));
    assert.equal(s.u.notice(), '', 'the same second');
    s.tick(1000);
    assert.equal(s.u.notice(), 'update 1.1.0');
});

test('the page: back as soon as the server answers and announces nothing; a restart waits to see it stop; stuck after ten minutes', () => {
    const base = { kind: 'update', startedAt: 0, now: 5000, seenDown: false };
    assert.equal(page.next({ ...base, answer: null }), 'wait', 'no answer');
    assert.equal(page.next({ ...base, answer: { status: 503, down: true, update: '' } }), 'wait', 'the front: down');
    assert.equal(page.next({ ...base, answer: { status: 502, down: false, update: '' } }), 'wait', 'the sign-in proxy\'s bare 502');
    assert.equal(page.next({ ...base, answer: { status: 200, down: false, update: 'update 1.1.0' } }), 'wait', 'the old server, still announcing');
    assert.equal(page.next({ ...base, answer: { status: 200, down: false, update: '' } }), 'back');
    assert.equal(page.next({ ...base, answer: { status: 0, down: false, update: '' } }), 'back', 'a redirection to sign in is an answer');
    assert.equal(page.next({ ...base, answer: { status: 404, down: false, update: '' } }), 'back');
    const restart = { ...base, kind: 'restart', answer: { status: 200, down: false, update: '' } };
    assert.equal(page.next(restart), 'wait', 'the server answers a moment more before it stops');
    assert.equal(page.next({ ...restart, seenDown: true }), 'back');
    assert.equal(page.next({ ...restart, now: page.RESTART_GRACE_MS + 1 }), 'back', 'a restart too quick to be seen');
    assert.equal(page.next({ ...base, now: page.STUCK_MS + 1, answer: null }), 'stuck');
    assert.equal(page.next({ ...base, now: page.STUCK_MS + 1, answer: { status: 200, down: false, update: '' } }), 'back', 'stuck, it still comes back by itself');
    assert.ok(page.EVERY_MS >= 2000 && page.EVERY_MS <= 3000);
});

test('the page says what happens, and goes back only to this site', () => {
    assert.equal(page.title('update', '1.1.0'), 'Updating Clavarium to 1.1.0...');
    assert.equal(page.title('back', '0.9.0-next.2'), 'Going back to Clavarium 0.9.0-next.2...');
    assert.equal(page.title('update', '<b>x</b>'), 'Updating Clavarium...', 'only a version is said');
    assert.equal(page.title('restart', ''), 'Restarting Clavarium...');
    assert.equal(page.title(null, null), 'Clavarium is being updated or restarted...', 'served by the front at any address');
    assert.equal(page.backTo('/?c=demo', '/maintenance.html', ''), '/?c=demo');
    assert.equal(page.backTo('//evil.example/', '/maintenance.html', ''), '/');
    assert.equal(page.backTo('/\\evil.example', '/c/maintenance.html', ''), '/c/');
    assert.equal(page.backTo('https://evil.example/', '/maintenance.html', ''), '/');
    assert.equal(page.backTo(null, '/c/', '?p=x'), '/c/?p=x', 'served by the front where the page was: reloaded there');
});

test('a real server: the notice on every answer, its version on its API, the maintenance page served with its script allowed by hash', async (t) => {
    const dir = folder(t);
    const updateState = join(dir, 'state.json'); const updateConf = join(dir, 'update.conf');
    writeFileSync(updateConf, 'MODE=off\n');
    writeFileSync(updateState, JSON.stringify({ running: null, history: [] }));
    const server = await startHome({ port: 0, host: ['true'], dataDir: join(dir, 'data'), updateState, updateConf, shelfEveryMs: 0, healthEveryMs: 0 });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    let r = await fetch(`${base}/api/conversations`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-clavarium-update'), null);
    assert.equal(r.headers.get('x-clavarium-version'), version);
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).headers.get('x-clavarium-version'), null, 'its version only to the page\'s own questions');

    writeFileSync(updateState, JSON.stringify({ running: { action: 'update', version: '999.0.0', step: 'Switching', at: new Date().toISOString() }, history: [] }));
    await new Promise((done) => setTimeout(done, 1100));
    for (const path of ['/api/conversations', '/manifest.webmanifest', '/c/manifest.webmanifest', '/']) {
        assert.equal((await fetch(base + path)).headers.get('x-clavarium-update'), 'update 999.0.0', path);
    }

    for (const path of ['/maintenance.html', '/c/maintenance.html']) {
        r = await fetch(base + path);
        assert.equal(r.status, 200, path);
        assert.equal(await r.text(), PAGE);
        const csp = r.headers.get('content-security-policy');
        assert.ok(csp.includes(`script-src 'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`), csp);
        assert.equal(csp, MAINTENANCE_HEADERS['content-security-policy']);
        assert.match(csp, /frame-ancestors 'none'/);
    }
    assert.ok(!(await (await fetch(base + '/app.js')).headers.get('content-security-policy')).includes('sha256'), 'no other page runs inline script');
});

/* ---------------------------- the front, kept by the updater ---------------------------- */
const INSTALLED = `# The only thing on this machine that takes what comes from the outside.
clav.example.com {
\ttls {
\t\tissuer internal
\t}
\thandle /dex/* {
\t\treverse_proxy 127.0.0.1:5556
\t}
${PLAIN_BLOCK}}

http://clav.example.com {
\thandle {
\t\tredir https://{host}{uri} 308
\t}
}
`;
function front(t, { text = INSTALLED, validate = 0, reload = 0 } = {}) {
    const dir = folder(t);
    const caddyfile = join(dir, 'Caddyfile');
    if (text !== null) writeFileSync(caddyfile, text);
    const ran = []; const reloads = [reload, 0];
    const run = async (argv, options) => {
        ran.push(argv.join(' '));
        if (argv[1] === 'validate') {
            assert.equal(readFileSync(argv[3], 'utf8').includes(MAINTENANCE_BLOCK), true, 'validated: the new text');
            assert.notEqual(options.env.XDG_DATA_HOME, undefined, 'never Caddy\'s own folder');
            return { code: validate, stderr: validate ? 'Error: adapting config using caddyfile: unknown directive' : '' };
        }
        return { code: reloads.shift(), stderr: 'reload failed' };
    };
    const o = { caddyfile, caddy: '/usr/local/bin/caddy', dir: join(dir, 'maintenance'), run };
    return { o, ran, caddyfile, file: join(dir, 'maintenance', 'index.html') };
}

test('the updater keeps the front: the page copied when it differs, the block put in once, validated first, Caddy reloaded', async (t) => {
    const f = front(t);
    assert.deepEqual(await ensureMaintenance(f.o), { page: true, edge: true, why: '' });
    assert.equal(readFileSync(f.file, 'utf8'), PAGE);
    assert.equal(statSync(f.file).mode & 0o777, 0o644, 'Caddy reads it');
    const text = readFileSync(f.caddyfile, 'utf8');
    assert.equal(text, INSTALLED.replace(PLAIN_BLOCK, MAINTENANCE_BLOCK), 'nothing else of it changed');
    assert.deepEqual(f.ran.map((x) => x.replace(/ \/\S+\.new /, ' NEW ')), ['/usr/local/bin/caddy validate --config NEW --adapter caddyfile', 'systemctl try-reload-or-restart caddy.service']);
    assert.ok(!existsSync(`${f.caddyfile}.new`));
    /* Again: nothing to do, nothing run. */
    assert.deepEqual(await ensureMaintenance(f.o), { page: false, edge: false, why: '' });
    assert.equal(f.ran.length, 2);
    /* A new release with another page: the page only. */
    writeFileSync(f.file, 'an older page');
    assert.deepEqual(await ensureMaintenance(f.o), { page: true, edge: false, why: '' });
    assert.equal(readFileSync(f.file, 'utf8'), PAGE);
    assert.equal(f.ran.length, 2);
});

test('the front is never broken: refused by caddy validate, or by Caddy at the reload, the Caddyfile stays as it was', async (t) => {
    const refused = front(t, { validate: 1 });
    const r = await ensureMaintenance(refused.o);
    assert.equal(r.edge, false); assert.match(r.why, /caddy validate refused it: Error: adapting config/);
    assert.equal(readFileSync(refused.caddyfile, 'utf8'), INSTALLED);
    assert.equal(refused.ran.length, 1, 'not reloaded');
    assert.ok(!existsSync(`${refused.caddyfile}.new`));

    const notTaken = front(t, { reload: 1 });
    const r2 = await ensureMaintenance(notTaken.o);
    assert.equal(r2.edge, false); assert.match(r2.why, /Caddy did not take it .*put back/);
    assert.equal(readFileSync(notTaken.caddyfile, 'utf8'), INSTALLED);
    assert.deepEqual(notTaken.ran.slice(1), ['systemctl try-reload-or-restart caddy.service', 'systemctl try-reload-or-restart caddy.service']);
});

test('a Caddyfile changed by hand is not touched; no Caddyfile (local mode, no front), nothing at all', async (t) => {
    const byHand = front(t, { text: INSTALLED.replace('reverse_proxy 127.0.0.1:4180', 'reverse_proxy 127.0.0.1:4180 {\n\t\t\tflush_interval -1\n\t\t}') });
    const before = readFileSync(byHand.caddyfile, 'utf8');
    const r = await ensureMaintenance(byHand.o);
    assert.equal(r.edge, false); assert.match(r.why, /not the one install\.sh wrote/);
    assert.equal(readFileSync(byHand.caddyfile, 'utf8'), before);
    assert.deepEqual(byHand.ran, []);
    assert.equal(r.page, true, 'the page is there for whoever adds the block');

    const none = front(t, { text: null });
    assert.deepEqual(await ensureMaintenance(none.o), { page: false, edge: false, why: '' });
    assert.ok(!existsSync(none.file)); assert.deepEqual(none.ran, []);
});

test('install.sh writes the same block and puts the page outside the releases', () => {
    const text = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
    const caddyfile = /cat > \/etc\/caddy\/Caddyfile <<CADDY\n([\s\S]*?)\nCADDY\n/.exec(text)[1];
    assert.ok(caddyfile.includes(MAINTENANCE_BLOCK), 'the block, as the updater writes it');
    assert.ok(!caddyfile.includes(PLAIN_BLOCK));
    /* The heredoc is not quoted: nothing in the block that the shell would change. */
    assert.ok(!/[$`]/.test(MAINTENANCE_BLOCK));
    assert.ok(MAINTENANCE_BLOCK.includes(`root * ${MAINTENANCE_DIR}`));
    assert.ok(text.includes(`"$APP/deploy/maintenance.html" ${MAINTENANCE_DIR}/index.html`));
    assert.ok(text.indexOf(`${MAINTENANCE_DIR}/index.html`) < text.indexOf('systemctl restart dex.service caddy.service'), 'there before Caddy starts');
    /* What the server's answers carry is what the block keeps apart: its own errors are JSON. */
    assert.match(MAINTENANCE_BLOCK, /header Content-Type text\/html\*/);
});

test('the page is one file: nothing it loads from elsewhere (the front serves it alone)', () => {
    assert.ok(!/<script[^>]+src=|<link[^>]+href=|<img|url\(/.test(PAGE));
    assert.ok(!/[^\x00-\x7f]/.test(PAGE), 'plain ASCII');
});
