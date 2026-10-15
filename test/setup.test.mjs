import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startHome } from '../server/main.mjs';
import { readTools } from '../server/tools.mjs';
import { readSetup, flowsOf, headOf, FILE_MAX } from '../server/setup.mjs';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vms } from '../server/vm.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'shell', label: 'Shell', command: ['bash'], memoryMb: 768, install: [] },
    { id: 'writer', label: 'Writer', command: ['bash'], memoryMb: 1024, install: [] },
]));

/* A whole Clavarium on a stand-in host that only makes the folders it is
   asked for: machines are "built" at once, nothing runs in them. */
async function home(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-setup-'));
    const data = join(dir, 'data');
    writeFileSync(join(dir, 'host.mjs'), `import { mkdirSync } from 'node:fs';
const [data, area, verb, name] = process.argv.slice(2);
const make = { folder: 'resources', work: 'work', view: 'views' }[area];
if (verb === 'make' && make) mkdirSync(data + '/' + make + '/' + name, { recursive: true });
`);
    const server = await startHome({ port: 0, host: [process.execPath, join(dir, 'host.mjs'), data], dataDir: data, tools: TOOLS, setupPollMs: 20, mailReader: async () => [], shelfEveryMs: 0, healthEveryMs: 0,
        env: { PATH: process.env.PATH, CLAVARIUM_ANSWERER_URL: 'http://127.0.0.1:9/v1/chat/completions', CLAVARIUM_ANSWERER_MODELS: 'one,two' } });
    t.after(() => { server.closeAllConnections?.(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (path, body) => {
        const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const ok = async (path, body) => { const r = await api(path, body); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
    const until = async (what, check, ms = 15_000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`never: ${what}`); await new Promise((r) => setTimeout(r, 30)); } };
    const ready = (name) => until(`${name} is ready`, async () => (await ok('/api/conversations')).find((c) => c.name === name)?.phase === 'ready');
    /* A phone paired the way a phone pairs: a code, its own key, a signed challenge. */
    async function pair(grants, label) {
        const shared = await ok('/api/shares', { grants, label });
        const code = new URL(shared.url).hash.slice(1);
        const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const r = await fetch(`${base}/c/api/pair`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ code, key: publicKey.export({ format: 'jwk' }), label }) });
        assert.equal(r.status, 201, await r.text());
    }
    return { dir, data, api, ok, until, ready, pair };
}

const exported = async (h, flow) => (await h.ok('/api/setup/export', flow ? { flow } : {})).text;
const imported = async (h, text, choices) => {
    await h.ok('/api/setup/import', { text, choices });
    await h.until('the import is done', async () => (await h.ok('/api/setup/import'))?.done === true, 30_000);
    return h.ok('/api/setup/import');
};

test('export, import into an empty Clavarium, export again: the same file', async (t) => {
    const a = await home(t);
    await a.ok('/api/conversations', { name: 'writer', tool: 'writer', memoryMb: 1536 });
    await a.ok('/api/conversations', { name: 'helper', tool: 'shell' });
    await a.ready('writer'); await a.ready('helper');
    await a.ok('/api/resources', { name: 'book' });
    await a.ok('/api/resources', { name: 'photos' });
    await a.ok('/api/resources', { name: 'site', type: 'git' });
    await a.ok('/api/mailboxes', { name: 'home-mail', host: 'imap.example.com', user: 'you@example.com', password: 'never-exported' });
    await a.ok('/api/secrets', { name: 'MODEL_KEY', value: 'never-exported-either' });
    await a.ok('/api/conversations/writer/resources', { resource: 'book', access: 'write' });
    await a.ok('/api/conversations/writer/resources', { resource: 'photos', access: 'read' });
    await a.ok('/api/conversations/writer/resources', { resource: 'site', access: 'write' });
    await a.ok('/api/conversations/helper/resources', { resource: 'home-mail', access: 'read' });
    await a.ok('/api/conversations/helper/resources', { resource: 'book', access: 'read' });
    await a.ok('/api/conversations/writer/secrets', { secret: 'MODEL_KEY', attached: true });
    await a.ok('/api/conversations/writer/git/site/auto', { branches: 'test, try/*', quietSeconds: 30, perHour: 4, sure: true });
    await a.ok('/api/conversations/writer/talk', { on: true });
    await a.ok('/api/conversations/helper/network', { online: false }).catch(() => {});
    await a.ok('/api/conversations/helper/resume', { on: false });
    await a.ok('/api/conversations/writer/wakeups', { kind: 'every', minutes: 60, message: 'Look at the new photos.' });
    await a.ok('/api/conversations/writer/wakeups', { kind: 'arrival', resource: 'photos', message: 'New photos <b>arrived</b>.', quiet: 20 });
    await a.ok('/api/conversations/writer/wakeups', { kind: 'cron', line: '30 7 * * 1-5', message: 'Morning.' });
    await a.ok('/api/conversations/writer/wakeups', { kind: 'call', message: 'Called.' });
    await a.ok('/api/conversations/writer/wakeups', { perHour: 5 });
    await a.ok('/api/conversations/writer/answerer', { on: false, objectives: 'Finish the book.', charter: 'Never delete a chapter.', limit: 3 });
    await a.ok('/api/shortcuts', { label: 'Go on', text: 'Go on, please.', enter: true });
    await a.pair([{ asset: 'conversation:writer', rights: 'rw' }, { asset: 'folder:photos', rights: 'r' }], "Dad's tablet");
    const first = await exported(a);
    /* Nothing that is data or a secret, no time. */
    for (const never of ['never-exported', 'createdAt', 'T0', 'sealed', 'token']) assert.ok(!first.includes(never), `the file holds ${never}`);
    const doc = JSON.parse(first);
    assert.deepEqual([doc.clavarium, doc.version, doc['made with']], ['flow', 2, 'Clavarium 0.0.0']);
    assert.deepEqual(doc.nodes.map((n) => n.id), ["device:Dad's tablet", 'conversation:helper', 'conversation:writer', 'folder:book', 'folder:photos', 'git:site', 'mailbox:home-mail', 'secret:MODEL_KEY']);
    assert.deepEqual(doc.links.find((l) => l.to === 'git:site').autoSend, { branches: ['test', 'try/*'], quietSeconds: 30, perHour: 4, create: false, checks: true });
    assert.equal(doc.links.find((l) => l.from === "device:Dad's tablet" && l.to === 'conversation:writer').gives, 'chat');
    assert.deepEqual([doc.nodes.find((n) => n.id === 'conversation:helper').resume, doc.nodes.find((n) => n.id === 'conversation:writer').resume], [false, undefined], 'its tool starts fresh: said; the default is not');
    assert.equal(await exported(a), first, 'the same file twice: nothing in it moves');

    const b = await home(t);
    assert.equal(JSON.parse(await exported(b)).nodes.length, 0);
    const plan = await b.ok('/api/setup/preview', { text: first });
    assert.deepEqual(plan.missing, { secrets: ['MODEL_KEY'], connect: ['home-mail'], pair: ["Dad's tablet"] });
    /* The texts a tool will be typed, shown whole, HTML and all, as text. */
    assert.ok(plan.items.find((i) => i.id === 'conversation:writer').texts.some((x) => x.text === 'New photos <b>arrived</b>.'));
    assert.ok(plan.links.find((l) => l.to === 'git:site').confirm);
    const job = await imported(b, first, { confirm: { 'conversation:writer|git:site': true } });
    assert.equal(job.failed, 0, JSON.stringify(job.steps.filter((s) => s.state === 'failed')));
    assert.ok(job.steps.some((s) => /its new address: \/c\/wake\//.test(s.why ?? '')), 'a call from outside gets a new address, said once');
    assert.equal(await exported(b), first);
    /* What was missing, added since: done by itself. */
    await b.ok('/api/secrets', { name: 'MODEL_KEY', value: 'mine' });
    assert.deepEqual((await b.ok('/api/secrets')).find((s) => s.name === 'MODEL_KEY').conversations, ['writer']);
    assert.equal(await exported(b), first);
    const graph = await b.ok('/api/flows');
    assert.equal(graph.nodes.find((n) => n.id === "pair:Dad's tablet").pending, 'pair');
    assert.deepEqual(await b.ok('/api/setup/pair', { label: "Dad's tablet" }), { label: "Dad's tablet", grants: [{ asset: 'conversation:writer', rights: 'rw' }, { asset: 'folder:photos', rights: 'r' }] });
});

test('flows: what touches nothing else is apart, named after its most linked conversation, renamed, exported alone', async (t) => {
    const a = await home(t);
    for (const name of ['writer', 'helper', 'alone']) await a.ok('/api/conversations', { name, tool: 'shell' });
    for (const name of ['writer', 'helper', 'alone']) await a.ready(name);
    for (const name of ['book', 'photos', 'notes']) await a.ok('/api/resources', { name });
    await a.ok('/api/conversations/writer/resources', { resource: 'book', access: 'write' });
    await a.ok('/api/conversations/writer/resources', { resource: 'photos', access: 'read' });
    await a.ok('/api/conversations/helper/resources', { resource: 'book', access: 'read' });
    await a.ok('/api/conversations/alone/resources', { resource: 'notes', access: 'read' });
    let g = await a.ok('/api/flows');
    assert.deepEqual(g.flows.map((f) => [f.around, f.name, f.nodes.length]), [['conversation:writer', 'writer', 4], ['conversation:alone', 'alone', 2]]);
    g = await a.ok('/api/flows/name', { around: 'conversation:writer', name: 'The family book' });
    assert.equal(g.flows[0].name, 'The family book');
    assert.equal((await a.api('/api/flows/name', { around: 'conversation:writer', name: 'x'.repeat(61) })).status, 400);
    const one = JSON.parse(await exported(a, 'conversation:writer'));
    assert.equal(one.name, 'The family book');
    assert.deepEqual(one.nodes.map((n) => n.id), ['conversation:helper', 'conversation:writer', 'folder:book', 'folder:photos']);
    assert.deepEqual(one.flows, [{ around: 'conversation:writer', name: 'The family book' }]);
    /* The whole file, imported one flow at a time. */
    const all = await exported(a);
    const b = await home(t);
    const plan = await b.ok('/api/setup/preview', { text: all });
    assert.deepEqual(plan.flows.map((f) => [f.name, f.size]), [['The family book', 4], ['alone', 2]]);
    const part = await b.ok('/api/setup/preview', { text: all, choices: { flow: 1 } });
    assert.deepEqual(part.items.map((i) => i.id), ['conversation:alone', 'folder:notes']);
    await imported(b, all, { flow: 1 });
    assert.deepEqual((await b.ok('/api/conversations')).map((c) => c.name), ['alone']);
    /* What exists already: kept by default, or made again under another name. */
    const again = await b.ok('/api/setup/preview', { text: all, choices: { flow: 1 } });
    assert.deepEqual(again.items.map((i) => [i.id, i.status, i.act]), [['conversation:alone', 'exists', 'keep'], ['folder:notes', 'exists', 'keep']]);
    const renamed = await b.ok('/api/setup/preview', { text: all, choices: { flow: 1, items: { 'conversation:alone': { do: 'rename', as: 'alone-2' } } } });
    assert.equal(renamed.items[0].as, 'alone-2');
    const taken = await b.ok('/api/setup/preview', { text: all, choices: { flow: 1, items: { 'conversation:alone': { do: 'rename', as: 'alone' } } } });
    assert.equal(taken.ready, false, 'a name taken too must be changed first');
    await imported(b, all, { flow: 1, items: { 'conversation:alone': { do: 'rename', as: 'alone-2' } } });
    assert.deepEqual((await b.ok('/api/conversations')).map((c) => c.name).sort(), ['alone', 'alone-2']);
    assert.deepEqual((await b.ok('/api/conversations')).find((c) => c.name === 'alone-2').resources, [{ name: 'notes', access: 'read' }]);
});

test('a file from somebody else: what is odd is refused, alone or whole, and nothing is run', async (t) => {
    const h = await home(t);
    const file = (nodes, links = [], more = {}) => JSON.stringify({ clavarium: 'flow', version: 2, nodes, links, ...more });
    const refused = async (text, pattern) => { const r = await h.api('/api/setup/preview', { text }); assert.ok(r.status >= 400, `accepted: ${text.slice(0, 80)}`); assert.match(r.body.error, pattern); };
    await refused('not json', /not JSON/);
    await refused(JSON.stringify({ hello: 1 }), /not a Clavarium setup/);
    await refused(JSON.stringify({ clavarium: 'flow', version: 9, nodes: [], links: [] }), /format 9/);
    await refused(file([{ id: 'folder:a', kind: 'folder', name: 'a' }, { id: 'folder:a', kind: 'folder', name: 'a' }]), /same name/);
    await refused(file([{ id: 'folder:a', kind: 'folder', name: 'a' }, { id: 'git:a', kind: 'git', name: 'a' }]), /same name/);
    await refused(file([{ id: 'folder:a', kind: 'folder', name: 'b' }]), /kind and its name/);
    await refused(file([{ id: 'script:a', kind: 'script', name: 'a' }]), /known kind/);
    await refused(file([], [{ from: 'x', to: 'y', gives: 'read' }]), /not in it/);
    /* Too large: refused before it is read. */
    const huge = file([{ id: 'folder:a', kind: 'folder', name: 'a' }], [], { pad: 'x'.repeat(FILE_MAX) });
    const r = await h.api('/api/setup/preview', { text: huge });
    assert.equal(r.status, 413);
    /* A request larger still is cut while it arrives: refused, or the connection closed under it. */
    assert.equal((await h.api('/api/setup/preview', { text: 'y'.repeat(4 * FILE_MAX) }).catch(() => ({ status: 413 }))).status, 413, 'a request too large is refused whole');
    /* Refused one by one, the rest kept. */
    const odd = file([
        { id: 'conversation:ok', kind: 'conversation', name: 'ok', tool: 'shell', wakeups: { items: [{ kind: 'every', minutes: 5, message: 'Hello <script>alert(1)</script>\u0007 there' }] } },
        { id: 'conversation:nope', kind: 'conversation', name: 'nope', tool: 'rm -rf /' },
        { id: 'conversation:../../etc', kind: 'conversation', name: '../../etc', tool: 'shell' },
        { id: 'folder:/root', kind: 'folder', name: '/root' },
        { id: 'secret:lower', kind: 'secret', name: 'lower' },
        { id: 'device:<img src=x onerror=alert(1)>', kind: 'device', name: '<img src=x onerror=alert(1)>' },
        { id: 'folder:fine', kind: 'folder', name: 'fine' },
    ], [{ from: 'conversation:ok', to: 'folder:fine', gives: 'write' }, { from: 'conversation:nope', to: 'folder:fine', gives: 'read' }, { from: 'conversation:ok', to: 'folder:/root', gives: 'read' },
        { from: 'folder:fine', to: 'conversation:ok', gives: 'read' }, { from: 'conversation:ok', to: 'secret:lower', gives: 'root' }]);
    const plan = await h.ok('/api/setup/preview', { text: odd });
    const status = Object.fromEntries(plan.items.map((i) => [i.id, i.status]));
    assert.deepEqual(status, { 'device:<img src=x onerror=alert(1)>': 'to pair', 'conversation:../../etc': 'refused', 'conversation:nope': 'refused', 'conversation:ok': 'new', 'folder:/root': 'refused', 'folder:fine': 'new', 'secret:lower': 'refused' });
    assert.match(plan.items.find((i) => i.id === 'conversation:nope').why, /not one of this Clavarium/);
    assert.deepEqual(plan.links.map((l) => l.status), ['refused', 'refused', 'new', 'refused', 'refused']);
    /* What will be typed: control characters gone; HTML stays text, for the page to show as text. */
    assert.equal(plan.items.find((i) => i.id === 'conversation:ok').texts[0].text, 'Hello <script>alert(1)</script> there');
    await imported(h, odd);
    assert.deepEqual((await h.ok('/api/conversations')).map((c) => c.name), ['ok']);
    assert.deepEqual((await h.ok('/api/resources')).map((r) => r.name), ['fine']);
    assert.deepEqual((await h.ok('/api/conversations'))[0].resources, [{ name: 'fine', access: 'write' }]);
    assert.deepEqual(readdirSync(h.data).filter((f) => f.startsWith('..')), []);
});

test('the setups of the public site (format 1) are read: people to pair, agents, folders, key names; scripts said, not made', () => {
    const dir = new URL('../docs/cases/', import.meta.url);
    const tools = readTools(readFileSync(new URL('../config/tools.json', import.meta.url), 'utf8'));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.clavarium.json'))) {
        const { doc, notes } = readSetup(readFileSync(new URL(file, dir), 'utf8'), tools);
        assert.equal(doc.version, 2, file);
        assert.ok(doc.nodes.some((n) => n.kind === 'conversation'), `${file} has an agent`);
        assert.ok(doc.nodes.every((n) => n.kind !== 'conversation' || tools.some((x) => x.id === n.tool)), `${file}: every agent has a tool of tools.json`);
        assert.ok(notes.every((n) => /script/.test(n)), file);
        assert.ok(flowsOf(doc.nodes, doc.links).length >= 1, file);
    }
});

test('a repository is exported at the commit it is at, read from its files without running git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-head-'));
    try {
        const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' });
        git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'a'), '1'); git('add', 'a'); git('commit', '-qm', 'one');
        const sha = git('rev-parse', 'HEAD').stdout.trim();
        assert.equal(headOf(dir), sha);
        git('pack-refs', '--all');
        assert.equal(headOf(dir), sha, 'packed refs too');
        git('checkout', '-q', '--detach');
        assert.equal(headOf(dir), sha, 'a detached head');
        rmSync(join(dir, '.git', 'HEAD')); symlinkSync('/etc/hostname', join(dir, '.git', 'HEAD'));
        assert.equal(headOf(dir), null, 'a link is not followed');
        writeFileSync(join(dir, '.git', 'HEAD2'), 'ref: refs/heads/../../../etc/x'); rmSync(join(dir, '.git', 'HEAD')); writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/../../x\n');
        assert.equal(headOf(dir), null, 'a ref that climbs out is not read');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a clone is put at its pinned commit, hooks off, in the fresh folder; not found, it stays at the newest and says so', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-pin-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const calls = [];
    const resources = new Resources({ store: new Store(join(dir, 'r.json')), vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']), dataDir: dir,
        host: async (argv) => { if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(dir, 'resources', argv[2]), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; },
        git: async (argv) => { calls.push(argv.join(' ')); return { code: argv.includes('reset') && argv.includes('badbadb') ? 1 : 0, stderr: '' }; } });
    const made = await resources.create({ name: 'site', type: 'git', from: 'https://example.com/site.git', pin: 'abc1234' });
    assert.equal(made.pinned, true);
    assert.equal(calls[1], '-c core.hooksPath=/dev/null -c protocol.file.allow=never reset --quiet --hard abc1234');
    assert.equal((await resources.create({ name: 'other', type: 'git', from: 'https://example.com/o.git', pin: 'badbadb' })).pinned, false);
    await assert.rejects(resources.create({ name: 'third', type: 'git', from: 'https://example.com/t.git', pin: '--upload-pack=x' }), /hexadecimal/);
});

test('the commit of a repository is read without following links or waiting on a pipe', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { headOf } = await import('../server/setup.mjs');
    const d = mkdtempSync(`${tmpdir()}/clv-head-`);
    try {
        const ok = `${d}/ok`; mkdirSync(`${ok}/.git/refs/heads`, { recursive: true });
        writeFileSync(`${ok}/.git/HEAD`, 'ref: refs/heads/main\n'); writeFileSync(`${ok}/.git/refs/heads/main`, `${'a'.repeat(40)}\n`);
        assert.equal(headOf(ok), 'a'.repeat(40));
        /* .git itself a link to elsewhere: not read. */
        const elsewhere = `${d}/elsewhere`; mkdirSync(elsewhere); writeFileSync(`${elsewhere}/HEAD`, `${'b'.repeat(40)}\n`);
        const linked = `${d}/linked`; mkdirSync(linked); symlinkSync(elsewhere, `${linked}/.git`);
        assert.equal(headOf(linked), null);
        /* refs/heads a link out: not read. */
        const sub = `${d}/sub`; mkdirSync(`${sub}/.git/refs`, { recursive: true }); writeFileSync(`${sub}/.git/HEAD`, 'ref: refs/heads/main\n');
        mkdirSync(`${d}/out`); writeFileSync(`${d}/out/main`, `${'c'.repeat(40)}\n`); symlinkSync(`${d}/out`, `${sub}/.git/refs/heads`);
        assert.equal(headOf(sub), null);
        /* HEAD a FIFO: answered at once, nothing read. */
        const pipe = `${d}/pipe`; mkdirSync(`${pipe}/.git`, { recursive: true }); execFileSync('mkfifo', [`${pipe}/.git/HEAD`]);
        assert.equal(headOf(pipe), null);
    } finally { rmSync(d, { recursive: true, force: true }); }
});
