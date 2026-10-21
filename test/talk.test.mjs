/* What is of this product in "talk": where Parley's bridge lives, the
   invitation, the line typed to the tool and when, the alert to the owner,
   which files the page can open, the words of the chat screen. The bridge
   itself, its verbs and its cleaning are tested where they live, in Parley. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { Talk, SYSTEM_MAX, EVENT_LEVELS, TYPING_QUIET_MS, RETRY_MS, REREAD_AFTER_MS, SETTLED_MS, READY_MAX_MS, typeCommand, enterCommand, ENTER_AFTER_MS, TYPED_KNOWN_MS, HEALTH_KNOWN_MS } from '../server/talk.mjs';
import { Readable } from 'node:stream';
import { WAKE, REREAD } from 'clavarium-parley/host';
import { packageFile } from '../server/parley.mjs';
const { run } = await import(packageFile('clavarium-parley', 'bin/parley.mjs'));

const BRIDGE = packageFile('clavarium-parley', 'server/parley-mcp.mjs');
const until = async (what, check, ms = 5000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

/* A conversation "helper" whose machine runs a tool, all of it stand-ins. */
function bench(t, { work = 'kept', tools = true } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-talk-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'helper'), { recursive: true });
    const typed = []; const alerted = []; const warmed = [];
    const world = { state: 'Running', awake: true, tmux: true, clock: 1_000_000, attached: ['notes'] };
    /* Every question to the VM manager and every command in the machine, in order. */
    const calls = [];
    const vms = {
        /* A line is typed by ONE tmux command: the line, a pause, Enter. */
        exec: async (name, argv) => {
            calls.push('exec');
            if (!world.tmux) return { code: 1 };
            if (argv.length === enterCommand().length) { assert.deepEqual(argv, enterCommand()); typed.push('Enter'); return { code: 0 }; }
            assert.deepEqual(argv, typeCommand(argv[8]), 'one command: the line, a pause, Enter');
            typed.push(argv[8], 'Enter');
            return { code: 0 };
        },
        state: async () => { calls.push('state'); return world.state; },
    };
    /* Parley is installed by the server before the invitation (toolbox.mjs); `world.install` says why it could not be. */
    const installs = [];
    const toolbox = tools ? { find: (name) => (name === 'parley' ? { name, path: '/tools/clavarium-parley-0.3.0.tgz' } : undefined), installIn: async (name) => { installs.push(name); return world.install ?? ''; } } : null;
    /* The terminal the bridge keeps open (`world.open`), and what health last saw (`world.seen`). */
    const channel = [];
    const terminal = { open: () => world.open === true, droppedAt: () => world.droppedAt, settled: () => (world.open === true ? world.settled ?? { openFor: 1e9, quietFor: 1e9 } : null), type: async (name, line, ms) => { calls.push('channel'); if (world.channelFails) return false; if (world.enterLost) { channel.push([line, ms]); typed.push(line); return 'enter'; } channel.push([line, ms]); typed.push(line, 'Enter'); return true; } };
    const health = { of: () => world.seen ?? null };
    const make = () => new Talk({ store: new Store(join(dir, 'talk.json')), words: new Store(join(dir, 'talk-words.json')), vms, toolbox, terminal, health,
        conversations: { list: () => [{ name: 'helper', work }], awake: () => (world.awake ? ['helper'] : []) },
        resources: { workFolder: (name) => join(dir, 'work', name), of: () => world.attached.map((name) => ({ name, access: 'read' })) },
        warm: async (name) => { warmed.push(name); }, alert: (payload) => alerted.push(payload), listenEveryMs: 30, now: () => world.clock });
    const talk = make();
    t.after(() => talk.stop());
    const bridge = join(dir, 'work', 'helper', '.parley');
    /* The tool runs the command, from its work folder. */
    const parley = (...args) => run(args, { cwd: join(dir, 'work', 'helper'), env: {} });
    return { dir, typed, alerted, warmed, world, talk, make, bridge, parley, installs, calls, channel };
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

test('the invitation: typed once in its terminal, English, Parley installed by the server first (never by the tool), the person\'s language', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const asked = await b.talk.invite('helper', 'fr-FR');
    assert.deepEqual(b.warmed, ['helper']);
    assert.equal(b.typed.length, 2); assert.equal(b.typed[1], 'Enter');
    const line = b.typed[0];
    assert.equal(line, asked.invited);
    assert.deepEqual(b.installs, ['helper'], 'installed by the server, before');
    assert.ok(line.startsWith('Parley is installed: run "parley --help".'), line);
    assert.ok(!/npm|install -g|\.tgz/.test(line), 'the tool is not asked to install anything');
    for (const part of ['parley --help', 'parley doing', 'under /work', 'Write to them in French.', 'You have a new message', 'main folder of the repository or under /work, never in /tmp']) assert.ok(line.includes(part), part);
    assert.ok(/^[\x20-\x7e]+$/.test(line) && !/[`'$\\]/.test(line), 'one plain line, nothing a shell would run');
    assert.ok(!line.includes('MCP'), 'no server to declare');
    b.world.awake = false;
    await assert.rejects(b.talk.invite('helper', 'en'), /asleep/);
    b.world.awake = true; b.world.tmux = false;
    await assert.rejects(b.talk.invite('helper', 'en'), /could not be typed/);
    /* Not installed: said, and nothing typed. */
    b.world.tmux = true; b.world.install = 'there is no npm in this machine';
    const before = b.typed.length;
    await assert.rejects(b.talk.invite('helper', 'en'), /Parley could not be installed in its machine: there is no npm in this machine/);
    assert.equal(b.typed.length, before);
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
    assert.equal(b.parley('read').out, 'Message: Keep it under two pages.\nMessage: And in French.\nForgot how to work with them? parley guide\n');
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
    /* Awake, but its machine stopped (its tool exited, its terminal closed): still waiting. */
    b.world.awake = true; b.world.state = 'Stopped'; b.world.droppedAt = b.world.clock;
    b.world.clock += RETRY_MS + 1;
    const asked = b.calls.filter((c) => c === 'state').length;
    await until('its machine asked about, since what was known of it went with its terminal', () => b.calls.filter((c) => c === 'state').length > asked);
    assert.equal(b.talk.of('helper').wake.why, 'asleep');
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
    b.parley('tell', 'Half written.'); b.parley('status', 'working'); b.parley('doing', 'choosing a cover');
    b.parley('ask', 'Blue or red cover?', 'blue', 'red'); b.parley('status', 'waiting', 'on the cover');
    await until('two alerts', () => b.alerted.length === 2);
    assert.deepEqual(b.alerted, [{ title: 'helper vous pose une question', body: 'Blue or red cover?', url: '/?c=helper' }, { title: 'helper : à vous, taratata', body: 'on the cover', url: '/?c=helper' }]);
    const seen = b.talk.of('helper');
    assert.equal(seen.waiting, 1); assert.equal(seen.status.state, 'waiting');
    assert.deepEqual(seen.steps.map((x) => x.kind), ['status', 'doing', 'status'], 'what it does is on the page, and alerts nobody');
    const brief = b.talk.brief('helper');
    assert.deepEqual({ waiting: brief.waiting, state: brief.state }, { waiting: 1, state: 'waiting' });
    assert.equal(brief.lastFrom, 'agent', 'and what was said last, for the list');
    assert.ok(brief.lastText && brief.lastAt);
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

test('what is wrong with its machine is said in its chat, once, where it happened, with what can be done; and said again only when it comes back', async (t) => {
    const b = bench(t);
    /* The lines are dated by this server's clock, the messages by Parley's: the same here. */
    b.world.clock = Date.now();
    const memory = { level: 'warn', problems: [{ level: 'warn', kind: 'memory', key: 'memory-low', text: 'Its memory is almost full: 20 MB free of 768 MB.' }] };
    b.talk.machine('helper', memory);
    assert.equal(existsSync(join(b.dir, 'talk.json')), false, 'its chat is off: nothing kept');
    await b.talk.set('helper', true);
    await b.talk.say('helper', 'Start.');
    b.world.clock += 1000;
    b.talk.machine('helper', memory);
    /* The next look finds the same, with other numbers: not said twice. */
    b.talk.machine('helper', { level: 'warn', problems: [{ ...memory.problems[0], text: 'Its memory is almost full: 18 MB free of 768 MB.' }] });
    let lines = b.talk.of('helper').messages.filter((m) => m.from === 'system');
    assert.deepEqual(lines.map((l) => [l.text, l.level, l.tone, l.event, l.actions]), [['Its memory is almost full: 20 MB free of 768 MB.', 'needs-you', 'warn', 'machine-problem', ['memory', 'restart', 'terminal']]]);
    assert.equal(b.talk.of('helper').messages.at(-1).from, 'system', 'after the message it came after');
    /* Out of memory, and the machine no longer answers: what is new is said; a problem with no memory in it offers no memory. */
    b.talk.machine('helper', { level: 'bad', problems: [memory.problems[0], { level: 'bad', kind: 'answer', key: 'silent', text: 'Its machine does not answer.' }] });
    lines = b.talk.of('helper').messages.filter((m) => m.from === 'system');
    assert.deepEqual(lines.at(-1), { ...lines.at(-1), text: 'Its machine does not answer.', level: 'needs-you', tone: 'bad', actions: ['restart', 'terminal'] });
    /* A disk short of room alone: a restart frees nothing -- what takes the room, and a larger disk. */
    b.talk.machine('helper', { level: 'warn', problems: [memory.problems[0], { level: 'bad', kind: 'answer', key: 'silent', text: 'Its machine does not answer.' }, { level: 'warn', kind: 'disk', key: 'disk:/', text: 'Its disk is almost full: 50 MB left of 8000 MB.' }] });
    assert.deepEqual(b.talk.of('helper').messages.filter((m) => m.from === 'system').at(-1).actions, ['room', 'disk']);
    /* Well again, then short of memory again: said again. Information alone is never said. */
    b.talk.machine('helper', { state: 'Running', level: 'info', problems: [{ level: 'info', kind: 'mount', key: 'remounted:/work', text: '/work had come loose' }] });
    b.talk.machine('helper', memory);
    assert.equal(b.talk.of('helper').messages.filter((m) => m.from === 'system').length, 4);
    assert.deepEqual(b.typed.filter((x) => x !== WAKE && x !== 'Enter'), [], 'nothing of it is typed to the tool');
});

test('after a restart its chat says so, and once the tool had time to start it is told, once, to read the whole thread; a message that waits is not announced on top', async (t) => {
    const b = bench(t);
    b.world.clock = Date.now();
    b.talk.renewed('helper', 'Its machine was restarted.', true);
    assert.equal(b.talk.of('helper').on, false, 'off: nothing');
    await b.talk.set('helper', true);
    b.talk.renewed('helper', 'Its machine was restarted: the tool started again.', true);
    assert.deepEqual(b.talk.of('helper').messages.map((m) => [m.from, m.text, m.level, m.event, m.topic, m.tone]), [['system', 'Its machine was restarted: the tool started again.', 'news', 'restarted', 'Restarted', undefined]]);
    /* The person writes meanwhile: nothing typed, the line to come tells it to read everything. */
    assert.equal((await b.talk.say('helper', 'Are you back?')).told, 'restarting');
    assert.deepEqual(b.talk.of('helper').wake, { waits: true, typed: null, why: 'restarting' });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(b.typed, [], 'the tool is given time to start');
    b.world.clock += REREAD_AFTER_MS + 1;
    await until('typed', () => b.typed.length === 2);
    assert.deepEqual(b.typed, [REREAD, 'Enter']);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.typed.length, 2, 'once, and the message that waits is not announced on top');
    assert.match(b.parley('read', '--all').out, /They wrote: Are you back\? \(new\)/);
    /* Its restart failed: said, with what can be done, and nothing typed. */
    b.talk.renewed('helper', 'Its machine was not restarted: it did not stop.', false);
    b.world.clock += REREAD_AFTER_MS + 1;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.typed.length, 2);
    const failed = b.talk.of('helper').messages.filter((m) => m.from === 'system').at(-1);
    assert.deepEqual([failed.level, failed.tone, failed.event, failed.actions], ['needs-you', 'bad', 'machine-problem', ['restart', 'terminal']]);
});

test('after a restart the line is typed only with the person\'s next message, and only once the tool is READY: its terminal open long enough and quiet, so its Enter is a real Enter', async (t) => {
    const b = bench(t);
    b.world.clock = Date.now();
    await b.talk.set('helper', true);
    b.world.open = true;
    /* Its terminal has just been opened (the tool starts now), and it draws. */
    b.world.settled = { openFor: 300, quietFor: 0 };
    b.talk.renewed('helper', 'Its machine was restarted: the tool started again.', true);
    b.world.clock += REREAD_AFTER_MS + 1;
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(b.typed, [], 'started, not ready: nothing typed into a tool that does not read its keyboard yet');
    /* Open long enough, but still drawing its first screen. */
    b.world.settled = { openFor: REREAD_AFTER_MS + 1, quietFor: 100 };
    b.world.clock += REREAD_AFTER_MS + 1;
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(b.typed, [], 'still drawing: not yet');
    /* Ready and quiet, but the person has not written since: nothing is typed alone
       (a line typed while it reloads a long session stayed in its input box, unsent). */
    b.world.settled = { openFor: REREAD_AFTER_MS + 3000, quietFor: SETTLED_MS + 1 };
    b.world.clock += SETTLED_MS + 200;
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(b.typed, [], 'nothing waits: nothing typed');
    /* The person writes: the line that makes it read everything, then Enter apart, once. */
    await b.talk.say('helper', 'Where are we?');
    b.world.clock += 60_000;
    await until('typed', () => b.typed.length === 2);
    assert.deepEqual(b.channel, [[REREAD, ENTER_AFTER_MS]]);
    assert.deepEqual(b.typed, [REREAD, 'Enter']);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(b.typed.length, 2, 'once');
    /* A tool that never stops drawing is told anyway, after a while. */
    b.talk.renewed('helper', 'Restarted again.', true);
    b.world.settled = { openFor: READY_MAX_MS + 1, quietFor: 0 };
    b.world.clock += REREAD_AFTER_MS + 1;
    await until('typed again', () => b.typed.length === 4);
});

test('a file the person attaches is put in the bridge folder, in a folder of its own; the message gives its path; it opens from the chat, as what the tool shows does', async (t) => {
    const b = bench(t);
    const body = (text) => Object.assign(Readable.from([Buffer.from(text)]), { headers: {} });
    await assert.rejects(b.talk.attach('helper', 'a.txt', body('x')), /not turned on/);
    await b.talk.set('helper', true);
    const file = await b.talk.attach('helper', 'notes.txt', body('the notes'));
    assert.match(file.path, /^\/work\/\.parley\/files\/[0-9a-f-]{36}\/notes\.txt$/);
    assert.equal(readFileSync(join(b.dir, 'work', 'helper', file.path.slice(6)), 'utf8'), 'the notes');
    await assert.rejects(b.talk.attach('helper', '../escape.txt', body('x')), /file name/);
    await b.talk.say('helper', '', undefined, [file.path]);
    const mine = b.talk.of('helper').messages.at(-1);
    assert.deepEqual(mine.files, [{ path: file.path, name: 'notes.txt', size: 9, open: `work:${file.path.slice(6)}` }]);
    assert.match(b.parley('read').out, /Attached file: \/work\/\.parley\/files\/.+\/notes\.txt \(9 bytes\)/);
    assert.equal(b.talk.shown('helper', `work:${file.path.slice(6)}`), true);
    assert.equal(b.talk.shown('helper', 'work:.parley/to-agent.jsonl'), false);
    await assert.rejects(b.talk.say('helper', 'x', undefined, ['/work/.parley/to-agent.jsonl']), /attached here first/);
    await assert.rejects(b.talk.say('helper', 'x', undefined, Array(11).fill(file.path)), /10 files at most/);
});

test('a machine put to sleep and woken does not say again what was wrong before: only a look at a running machine that finds it gone does', async (t) => {
    const b = bench(t);
    b.world.clock = Date.now();
    await b.talk.set('helper', true);
    const memory = { state: 'Running', level: 'warn', problems: [{ level: 'warn', kind: 'memory', key: 'oom:1', text: 'It ran out of memory once.' }] };
    b.talk.machine('helper', memory);
    b.talk.machine('helper', { state: 'Suspended', level: 'info', problems: [{ level: 'info', kind: 'state', key: 'asleep', text: 'asleep' }] });
    b.talk.machine('helper', memory);
    assert.equal(b.talk.of('helper').messages.filter((m) => m.from === 'system').length, 1);
});

test('a file is not attached when the tool put a link where the chat folders should be', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    const body = (text) => Object.assign(Readable.from([Buffer.from(text)]), { headers: {} });
    const outside = join(b.dir, 'outside'); mkdirSync(outside);
    rmSync(join(b.bridge, 'files'), { recursive: true, force: true });
    symlinkSync(outside, join(b.bridge, 'files'));
    await assert.rejects(b.talk.attach('helper', 'a.txt', body('x')), /not as it should be/);
    assert.deepEqual(readdirSync(outside), [], 'nothing was made outside');
});

test('the line is typed fast: one command, and the machine asked about only when nothing is known of it', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    /* Nothing known: asked, then one command (before: asked, then two). */
    assert.equal((await b.talk.say('helper', 'one')).told, 'typed');
    assert.deepEqual(b.calls, ['state', 'exec']);
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    /* Typed into it a moment ago: not asked again. */
    b.world.clock += 1000;
    assert.equal((await b.talk.say('helper', 'two')).told, 'typed');
    assert.deepEqual(b.calls, ['state', 'exec', 'exec']);
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    /* Long ago, but its health was looked at lately and found it running: not asked. */
    b.world.clock += TYPED_KNOWN_MS + 1;
    b.world.seen = { state: 'Running', answering: true, at: new Date(b.world.clock - 1000).toISOString() };
    assert.equal((await b.talk.say('helper', 'three')).told, 'typed');
    assert.deepEqual(b.calls.slice(3), ['exec']);
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    /* Its terminal closed since (put to sleep, stopped): what was known is not any more. */
    b.world.droppedAt = b.world.clock;
    b.world.clock += 1000;
    b.world.state = 'Suspended';
    assert.equal((await b.talk.say('helper', 'four')).told, 'asleep');
    assert.deepEqual(b.calls.slice(4), ['state'], 'asked, and nothing typed into a machine that does not run');
    b.world.state = 'Running';
    b.parley('read');
    /* A health look too old, a machine that does not answer: asked. */
    for (const seen of [{ state: 'Running', answering: true, at: new Date(b.world.clock - HEALTH_KNOWN_MS - 1).toISOString() }, { state: 'Running', answering: false, at: new Date(b.world.clock).toISOString() }]) {
        b.world.clock += TYPED_KNOWN_MS + 1; b.world.droppedAt = undefined;
        b.world.seen = { ...seen, at: seen.answering ? new Date(b.world.clock - HEALTH_KNOWN_MS - 1).toISOString() : new Date(b.world.clock).toISOString() };
        const before = b.calls.length;
        assert.equal((await b.talk.say('helper', 'again')).told, 'typed');
        assert.deepEqual(b.calls.slice(before), ['state', 'exec']);
        b.parley('read');
        await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    }
});

test('the line goes down the terminal already open when there is one: nothing sent into the machine; the command in the machine when that fails', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    b.world.open = true;
    assert.equal((await b.talk.say('helper', 'hello')).told, 'typed');
    assert.deepEqual(b.calls, ['channel'], 'no question, no command');
    assert.deepEqual(b.channel, [[WAKE, ENTER_AFTER_MS]], 'the line, and Enter apart');
    assert.deepEqual(b.typed, [WAKE, 'Enter']);
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    /* The channel refuses (a screen pressed the tmux prefix, it closed meanwhile): the command, once. */
    b.world.channelFails = true;
    assert.equal((await b.talk.say('helper', 'again')).told, 'typed');
    assert.deepEqual(b.calls, ['channel', 'channel', 'exec']);
    assert.deepEqual(b.typed, [WAKE, 'Enter', WAKE, 'Enter']);
    /* Still never while somebody types in the terminal. */
    b.parley('read');
    await until('read', () => JSON.parse(readFileSync(join(b.dir, 'talk.json'), 'utf8'))[0].woke === false);
    b.world.channelFails = false;
    b.talk.typed('helper');
    assert.equal((await b.talk.say('helper', 'wait')).told, 'typing');
    assert.equal(b.typed.length, 4);
});

test('the line went down the channel but its Enter could not (the channel closed meanwhile): the Enter alone, never the line twice', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    b.world.open = true; b.world.enterLost = true;
    assert.equal((await b.talk.say('helper', 'hello')).told, 'typed');
    assert.deepEqual(b.calls, ['channel', 'exec']);
    assert.deepEqual(b.typed, [WAKE, 'Enter'], 'the line once, then Enter');
});

test('the one tmux command: the line as it is, a pause, Enter; a last ";" kept as text', () => {
    const argv = typeCommand('Read this.');
    assert.deepEqual(argv.slice(0, 9), ['tmux', '-L', 'clavarium', 'send-keys', '-t', '=main:', '-l', '--', 'Read this.']);
    assert.deepEqual(argv.slice(9), [';', 'run-shell', '-d', String(ENTER_AFTER_MS / 1000), ';', 'send-keys', '-t', '=main:', 'Enter']);
    assert.equal(typeCommand('a;')[8], 'a\\;');
    assert.equal(typeCommand('a ; b')[8], 'a ; b');
});

test('the thread\'s own lines: a level per kind of event, the owner\'s choice over it, only where the chat is on, never unread, bounded', async (t) => {
    const b = bench(t);
    b.world.clock = Date.now();
    assert.equal(b.talk.event('helper', { kind: 'sent', text: 'Sent to dev: 1 commit, no checks asked for.' }), null, 'its chat is off: nothing kept');
    await b.talk.set('helper', true);
    const sent = b.talk.event('helper', { kind: 'sent', text: 'Sent to preprod: 2 commits, checks passed.', topic: 'Sent', brief: 'preprod', actions: ['review:app', 'bad action!', 'x'.repeat(30)] });
    assert.deepEqual({ ...sent, id: 'id', at: 'at' }, { id: 'id', at: 'at', event: 'sent', text: 'Sent to preprod: 2 commits, checks passed.', level: 'news', topic: 'Sent', brief: 'preprod', actions: ['review:app'] });
    const levels = Object.fromEntries(Object.keys(EVENT_LEVELS).map((kind) => [kind, b.talk.event('helper', { kind, text: kind }).level]));
    assert.deepEqual(levels, { sent: 'news', refused: 'needs-you', 'sent-by-hand': 'news', origin: 'trace', wakeup: 'trace', 'machine-problem': 'needs-you', restarted: 'news' });
    assert.throws(() => b.talk.event('helper', { kind: 'gossip', text: 'x' }), /No such kind/);
    assert.equal(b.talk.event('helper', { kind: 'sent', text: '  ' }), null, 'nothing to say: no line');
    /* Bounds: topic, brief, text; a tone only of the two. */
    const long = b.talk.event('helper', { kind: 'refused', text: 'y'.repeat(900), topic: 't'.repeat(90), brief: 'b'.repeat(90), tone: 'pink' });
    assert.deepEqual([long.text.length, long.topic.length, long.brief.length, long.tone], [500, 40, 60, undefined]);
    /* The owner moves a kind: what is stored next follows, what was stored stays. */
    assert.throws(() => b.talk.setThread({ levels: { origin: 'loud' } }), /A level is one of/);
    assert.throws(() => b.talk.setThread({ levels: { gossip: 'news' } }), /no such kind/);
    assert.throws(() => b.talk.setThread({ levels: ['news'] }), /pairs/);
    assert.throws(() => b.talk.setThread({}), /pairs/);
    const set = b.talk.setThread({ levels: { origin: 'news', sent: 'trace' } });
    assert.deepEqual([set.levels.origin, set.levels.sent, set.levels.refused], ['news', 'trace', 'needs-you']);
    assert.equal(b.talk.event('helper', { kind: 'origin', text: 'Origin updated.' }).level, 'news');
    assert.equal(b.talk.event('helper', { kind: 'sent', text: 'Sent.', level: 'needs-you' }).level, 'trace', 'the owner\'s choice wins over the source\'s');
    assert.equal(b.talk.event('helper', { kind: 'wakeup', text: 'Wake-up.', level: 'news' }).level, 'news', 'no choice made: the source\'s level');
    /* Back to the default: nothing kept for it. */
    b.talk.setThread({ levels: { origin: 'trace' } });
    assert.deepEqual(b.make().thread().levels, { ...EVENT_LEVELS, sent: 'trace' }, 'kept across a restart of the server');
    /* Never unread, and the person's own unread count untouched. */
    assert.equal(b.talk.of('helper').unread, 0);
    assert.equal(b.talk.brief('helper').waiting, 0);
    for (let i = 0; i < SYSTEM_MAX + 5; i += 1) b.talk.event('helper', { kind: 'wakeup', text: `Wake-up ${i}` });
    const lines = b.talk.of('helper').messages.filter((m) => m.from === 'system');
    assert.equal(lines.length, SYSTEM_MAX);
    assert.equal(lines.at(-1).text, `Wake-up ${SYSTEM_MAX + 4}`);
    assert.equal(b.talk.of('helper').unread, 0);
    assert.deepEqual(b.typed, [], 'nothing of it is typed to the tool');
});

test('reactions: "stop" wakes it at once, even told already; "go" as a message does; a thumbs up wakes nobody; a dictated message is said so', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    b.parley('tell', 'I can delete the old logs.');
    const id = b.talk.of('helper').messages.find((m) => m.from === 'agent').id;
    const kept = await b.talk.react('helper', id, 'agree');
    assert.equal(kept.told, 'kept'); assert.deepEqual(b.typed, [], 'a thumbs up wakes nobody');
    assert.equal(kept.messages.find((m) => m.id === id).reaction.id, 'agree');
    assert.equal((await b.talk.react('helper', id, 'go')).told, 'typed');
    assert.deepEqual(b.typed, [WAKE, 'Enter']);
    assert.equal((await b.talk.react('helper', id, 'stop')).told, 'typed', 'stop: typed again though it was told');
    assert.equal(b.typed.length, 4);
    assert.match(b.parley('read').out, /STOP: stop what you are doing now/);
    await assert.rejects(b.talk.react('helper', id, 'party'), /A reaction is one of/);
    await assert.rejects(b.talk.react('helper', 'nope', 'go'), /No such message/);
    assert.equal((await b.talk.react('helper', id, null)).messages.find((m) => m.id === id).reaction, undefined, 'taken back');
    await b.talk.say('helper', 'delete them', undefined, undefined, 'voice');
    assert.match(b.parley('read').out, /Message \(dictated: may hold recognition mistakes/);
});

test('it needs its owner only until the owner writes: answered with a button or in a message of one\'s own', async (t) => {
    const b = bench(t);
    await b.talk.set('helper', true);
    b.parley('ask', 'Blue or red cover?', 'blue', 'red'); b.parley('status', 'waiting', 'on the cover');
    await until('read', () => b.talk.brief('helper')?.waiting === 1);
    assert.equal(b.talk.brief('helper').needs, true);
    await b.talk.say('helper', 'red, and bigger letters');
    assert.equal(b.talk.brief('helper').waiting, 1, 'the question is still open: answered another way');
    assert.equal(b.talk.brief('helper').needs, false, 'but the turn is its own again');
    await new Promise((r) => setTimeout(r, 20));
    b.parley('status', 'waiting', 'one more thing');
    await until('waits again', () => b.talk.brief('helper')?.needs === true);
});
