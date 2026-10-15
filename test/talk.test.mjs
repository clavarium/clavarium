/* What is of this product in "talk": where Parley's bridge lives, the
   invitation, the line typed to the tool and when, the alert to the owner,
   which files the page can open, the words of the chat screen. The bridge
   itself, its verbs and its cleaning are tested where they live, in Parley. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Talk, TYPING_QUIET_MS, RETRY_MS } from '../server/talk.mjs';
import { WAKE } from '../server/parley/host/parley-host.mjs';
import { run } from '../server/parley/bin/parley.mjs';

const BRIDGE = fileURLToPath(new URL('../server/parley/server/parley-mcp.mjs', import.meta.url));
const until = async (what, check, ms = 5000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

/* A conversation "helper" whose machine runs a tool, all of it stand-ins. */
function bench(t, { work = 'kept', tools = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-talk-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'helper'), { recursive: true });
    const typed = []; const alerted = []; const warmed = [];
    const world = { state: 'Running', awake: true, tmux: true, clock: 1_000_000, attached: ['notes'] };
    const vms = {
        exec: async (name, argv) => { if (!world.tmux) return { code: 1 }; const rest = argv.slice(argv.indexOf('send-keys') + 3); typed.push(rest[0] === '-l' ? rest.slice(2).join(' ') : rest.join(' ')); return { code: 0 }; },
        state: async () => world.state,
    };
    const toolbox = tools ? { find: (name) => (name === 'parley' ? { name, path: '/tools/clavarium-parley-0.2.0.tgz' } : undefined) } : null;
    const make = () => new Talk({ store: new Store(join(dir, 'talk.json')), words: new Store(join(dir, 'talk-words.json')), vms, toolbox,
        conversations: { list: () => [{ name: 'helper', work }], awake: () => (world.awake ? ['helper'] : []) },
        resources: { workFolder: (name) => join(dir, 'work', name), of: () => world.attached.map((name) => ({ name, access: 'read' })) },
        warm: async (name) => { warmed.push(name); }, alert: (payload) => alerted.push(payload), listenEveryMs: 30, now: () => world.clock });
    const talk = make();
    t.after(() => talk.stop());
    const bridge = join(dir, 'work', 'helper', '.parley');
    /* The tool runs the command, from its work folder. */
    const parley = (...args) => run(args, { cwd: join(dir, 'work', 'helper'), env: {} });
    return { dir, typed, alerted, warmed, world, talk, make, bridge, parley };
}

test('off until the owner turns it on; turned on, the bridge is put in the work folder and nothing is typed', async (t) => {
    const b = bench(t);
    assert.deepEqual(b.talk.of('helper'), { on: false, possible: true, tools: true, messages: [], waiting: 0, status: null, steps: [], files: [], unread: 0 });
    await assert.rejects(b.talk.say('helper', 'hello'), /not turned on/);
    assert.throws(() => b.talk.of('nobody'), /No such conversation/);
    const on = await b.talk.set('helper', true);
    assert.equal(on.on, true); assert.equal(on.tools, true);
    assert.equal(readFileSync(join(b.bridge, 'server.mjs'), 'utf8'), readFileSync(BRIDGE, 'utf8'), 'the MCP server stays there for a tool that wants it');
    assert.deepEqual(b.typed, []);
    const disk = bench(t, { work: 'disk' });
    await assert.rejects(disk.talk.set('helper', true), /nowhere to live/);
    assert.equal(disk.talk.of('helper').possible, false);
});

test('the invitation: typed once in its terminal, English, the archive in /tools to install, the person\'s language', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const asked = await b.talk.invite('helper', 'fr-FR');
    assert.deepEqual(b.warmed, ['helper']);
    assert.equal(b.typed.length, 2); assert.equal(b.typed[1], 'Enter');
    const line = b.typed[0];
    assert.equal(line, asked.invited);
    for (const part of ['npm install -g /tools/clavarium-parley-0.2.0.tgz', 'parley --help', 'under /work', 'Write to them in French.', 'You have a new message']) assert.ok(line.includes(part), part);
    assert.ok(!line.includes('MCP'), 'no server to declare');
    b.world.awake = false;
    await assert.rejects(b.talk.invite('helper', 'en'), /asleep/);
    b.world.awake = true; b.world.tmux = false;
    await assert.rejects(b.talk.invite('helper', 'en'), /could not be typed/);
    const bare = bench(t, { tools: false });
    await bare.talk.set('helper', true);
    await assert.rejects(bare.talk.invite('helper', 'en'), /tools folder is not in place/);
    assert.equal(bare.talk.of('helper').tools, false);
});

test('the line that wakes it: typed once until it has read, and the message itself never', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const first = await b.talk.say('helper', 'Keep it under two pages.');
    assert.equal(first.told, 'typed'); assert.equal(first.unread, 1);
    assert.deepEqual(b.typed, [WAKE, 'Enter']);
    assert.equal((await b.talk.say('helper', 'And in French.')).told, 'told', 'not typed again before it has read');
    assert.equal(b.typed.length, 2);
    assert.equal(b.parley('read').out, 'Message: Keep it under two pages.\nMessage: And in French.\n');
    assert.equal(b.talk.of('helper').unread, 0);
    await until('it is known to have read', () => b.talk.of('helper').unread === 0 && JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    assert.equal((await b.talk.say('helper', 'One more thing.')).told, 'typed', 'read, so the next message wakes it again');
    assert.deepEqual(b.typed.slice(2), [WAKE, 'Enter']);
    await assert.rejects(b.talk.say('helper', '  '), /Write something/);
    /* The owner asks to remind it: typed again, though it was typed already. */
    assert.equal((await b.talk.remind('helper')).told, 'typed');
    assert.equal(b.typed.length, 6);
});

test('the line waits: while somebody types in its terminal, while it sleeps, while its machine does not run; then it is typed, once', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    /* Somebody is typing in the terminal. */
    b.talk.typed('helper');
    assert.equal((await b.talk.say('helper', 'hello')).told, 'typing');
    assert.deepEqual(b.typed, [], 'nothing typed over somebody');
    assert.deepEqual(b.talk.of('helper').wake, { waits: true, typed: null, why: 'typing' });
    b.world.clock += TYPING_QUIET_MS + 200;
    await until('typed once they stopped', () => b.typed.length === 2);
    assert.deepEqual(b.typed, [WAKE, 'Enter']);
    assert.equal(b.talk.of('helper').wake.waits, false);
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    /* Put to sleep by its owner: the message waits; its machine is not even asked. */
    b.world.awake = false;
    assert.equal((await b.talk.say('helper', 'for later')).told, 'asleep');
    b.world.clock += RETRY_MS + 1;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.typed.length, 2);
    /* Awake, but its machine stopped (its tool exited): still waiting. */
    b.world.awake = true; b.world.state = 'Stopped';
    b.world.clock += RETRY_MS + 1;
    await until('looked at again', () => b.talk.of('helper').wake.why === 'asleep');
    assert.equal(b.typed.length, 2);
    /* Its machine runs, its tool does not answer: tried again later. */
    b.world.state = 'Running'; b.world.tmux = false;
    b.world.clock += RETRY_MS + 1;
    await until('tried', () => b.talk.of('helper').wake.why === 'failed');
    b.world.tmux = true;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.typed.length, 2, 'not before the time to try again');
    b.world.clock += RETRY_MS + 1;
    await until('typed at last', () => b.typed.length === 4);
    assert.equal(b.talk.of('helper').wake.waits, false);
    /* Read before it was ever told: nothing waits any more, nothing is typed. */
    b.parley('read');
    b.world.awake = false;
    await b.talk.say('helper', 'later still');
    b.parley('read');
    b.world.awake = true; b.world.clock += RETRY_MS + 1;
    await until('nothing waits', () => b.talk.of('helper').wake.waits === false);
    assert.equal(b.typed.length, 4);
});

test('the owner is alerted when the tool asks or says it waits, in the words of the chat screen; not for the rest', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    b.talk.setWords({ lang: 'fr', own: { 'alert-waits': '{name} : à vous, taratata' } });
    b.talk.words('fr-FR');
    b.parley('tell', 'Half written.'); b.parley('status', 'working');
    b.parley('ask', 'Blue or red cover?', 'blue', 'red'); b.parley('status', 'waiting', 'on the cover');
    await until('two alerts', () => b.alerted.length === 2);
    assert.deepEqual(b.alerted, [{ title: 'helper vous pose une question', body: 'Blue or red cover?', url: '/?c=helper' }, { title: 'helper : à vous, taratata', body: 'on the cover', url: '/?c=helper' }]);
    const seen = b.talk.of('helper');
    assert.equal(seen.waiting, 1); assert.equal(seen.status.state, 'waiting');
    assert.deepEqual(b.talk.brief('helper'), { waiting: 1, state: 'waiting' });
    assert.equal((await b.talk.say('helper', 'blue', seen.messages.find((m) => m.kind === 'ask').id)).waiting, 0);
    /* After a restart of this server, it listens again without being asked. */
    b.talk.stop();
    const again = b.make(); t.after(() => again.stop());
    await new Promise((r) => setTimeout(r, 60));
    b.parley('ask', 'One page or two?');
    await until('alerted again', () => b.alerted.length === 3);
    /* Turned off: nothing of it is read, nobody is alerted, nothing is deleted. */
    await again.set('helper', false);
    b.parley('ask', 'Anybody?');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.alerted.length, 3); assert.equal(again.of('helper').messages.length, 0); assert.equal(again.brief('helper'), null);
    assert.equal(existsSync(join(b.bridge, 'from-agent.jsonl')), true);
});

test('a file it shows opens from the page when it is in its work folder or an attached folder; any other is said to be outside', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const work = join(b.dir, 'work', 'helper');
    writeFileSync(join(work, 'report.html'), 'x');
    b.parley('show', 'report.html', 'The draft.');
    /* As the tool sees them: the paths are the machine's. Posted by hand, as a tool's MCP client would. */
    const post = (path) => writeFileSync(join(b.bridge, 'from-agent.jsonl'), `${JSON.stringify({ id: path, at: new Date().toISOString(), kind: 'show', path })}\n`, { flag: 'a' });
    for (const path of ['/work/report.html', '/work/.parley/to-agent.jsonl', '/resources/notes/plan.md', '/resources/other/plan.md', '/etc/passwd', '/work/../etc/passwd', 'relative.txt']) post(path);
    const shown = b.talk.of('helper').messages.filter((m) => m.kind === 'show').map((m) => [m.path, m.open]);
    assert.deepEqual(shown.slice(1), [['/work/report.html', 'work:report.html'], ['/work/.parley/to-agent.jsonl', null], ['/resources/notes/plan.md', 'notes:plan.md'], ['/resources/other/plan.md', null], ['/etc/passwd', null], ['/work/../etc/passwd', null], ['relative.txt', null]]);
    assert.equal(shown[0][1], null, 'the bench\'s own path is not /work: outside, as it should be');
});

test('the words of the chat screen: each device its language, or one for all; the owner\'s own replace any word, and only words that exist', (t) => {
    const b = bench(t);
    assert.equal(b.talk.settings().lang, 'device');
    assert.deepEqual(b.talk.settings().languages, ['en', 'fr']);
    assert.equal(b.talk.words('fr-FR').send, 'Envoyer', 'a French device, in French');
    assert.equal(b.talk.words('en-US').send, 'Send');
    assert.equal(b.talk.words('ja').send, 'Send', 'a language without a dictionary: English');
    b.talk.setWords({ lang: 'device', own: { send: 'Clique ici pour faire taratata', done: '<img src=x onerror=alert(1)>' } });
    assert.equal(b.talk.words('fr').send, 'Clique ici pour faire taratata');
    assert.equal(b.talk.words('en').done, '<img src=x onerror=alert(1)>', 'whatever it says: the page shows it as text');
    b.talk.setWords({ lang: 'fr', own: {} });
    assert.equal(b.talk.words('en-US').send, 'Envoyer', 'one language for all');
    assert.throws(() => b.talk.setWords({ lang: 'xx' }), /language/);
    assert.throws(() => b.talk.setWords({ lang: 'device', own: { sned: 'Go' } }), /no such word: sned/);
    assert.throws(() => b.talk.setWords({ lang: 'device', own: { send: 42 } }), /a text/);
    assert.throws(() => b.talk.setWords({ lang: 'device', own: ['send'] }), /JSON/);
    assert.throws(() => b.talk.setWords({ lang: 'device', own: { send: 'x'.repeat(501) } }), /500/);
    assert.equal(b.talk.settings().lang, 'fr', 'a refusal changes nothing');
});
