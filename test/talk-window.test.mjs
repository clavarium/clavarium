/* A part of the chat: the page is given the end of the thread, the page before it on demand,
   then only what changed; the whole thread is searched; what the tool reads after a restart is
   the owner's choice. The thread itself is never cut: what is on disk stays whole. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Talk, partOf, WINDOWS, AI_WINDOW, REREAD_AFTER_MS } from '../server/talk.mjs';
import { ownText } from '../server/guide.mjs';
import { REREAD } from 'clavarium-parley/host';

const until = async (what, check, ms = 5000) => { const end = Date.now() + ms; for (;;) { if (await check()) return; if (Date.now() > end) throw new Error(`never happened: ${what}`); await new Promise((r) => setTimeout(r, 20)); } };
const at = (i) => new Date(Date.parse('2026-04-01T08:00:00.000Z') + i * 60_000).toISOString();

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-window-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'work', 'helper'), { recursive: true });
    const typed = [];
    const world = { clock: Date.now(), seen: null };
    const vms = { exec: async (name, argv) => { typed.push(argv[8] ?? 'Enter'); return { code: 0 }; }, state: async () => 'Running' };
    const talk = new Talk({ store: new Store(join(dir, 'talk.json')), words: new Store(join(dir, 'talk-words.json')), vms,
        toolbox: { find: () => ({ name: 'parley' }), installIn: async () => '' }, health: { of: () => world.seen },
        conversations: { list: () => [{ name: 'helper', work: 'kept' }], awake: () => ['helper'] },
        resources: { workFolder: (name) => join(dir, 'work', name), of: () => [] },
        listenEveryMs: 30, now: () => world.clock, keptDir: join(dir, 'data', 'talk-kept') });
    t.after(() => talk.stop());
    const bridge = join(dir, 'work', 'helper', '.parley');
    /* A thread of n messages written straight to the bridge, as a tool and an owner would have. */
    /* Written before its chat is turned on: the copy kept by the server takes the thread as it was then. */
    const thread = (n) => {
        mkdirSync(bridge, { recursive: true });
        const agent = []; const person = [];
        for (let i = 0; i < n; i += 1) (i % 2 ? person : agent).push(JSON.stringify(i % 2 ? { id: `p-${i}`, at: at(i), text: `Owner message ${i}` } : { id: `a-${i}`, at: at(i), kind: 'say', text: `Tool message ${i}` }));
        writeFileSync(join(bridge, 'from-agent.jsonl'), agent.map((l) => `${l}\n`).join(''));
        writeFileSync(join(bridge, 'to-agent.jsonl'), person.map((l) => `${l}\n`).join(''));
    };
    return { dir, talk, bridge, thread, typed, world };
}

test('the page asks for the end of its chat, the page before it, then only what changed; without asking, as before', async (t) => {
    const b = bench(t);
    b.thread(600);
    await b.talk.set('helper', true);
    const first = b.talk.of('helper', new URLSearchParams({ last: '200' }));
    assert.equal(first.messages.length, 200);
    assert.equal(first.window.more, 400);
    assert.match(first.cursor, /^\d+\.\d+\.\d+~[0-9a-f]{10}$/);
    const before = b.talk.of('helper', new URLSearchParams({ last: '200', before: first.window.before }));
    assert.deepEqual([before.messages[0].text, before.messages.at(-1).text], ['Tool message 200', 'Owner message 399']);
    /* Nothing changed: almost nothing sent. */
    const same = b.talk.of('helper', new URLSearchParams({ last: '200', since: first.cursor }));
    assert.deepEqual([same.since, same.messages.length], [true, 0]);
    assert.ok(JSON.stringify(same).length < 400, `small: ${JSON.stringify(same).length}`);
    /* A line of its machine: it comes with what changed, and once. */
    b.talk.event('helper', { kind: 'restarted', text: 'Its machine was restarted.' });
    const line = b.talk.of('helper', new URLSearchParams({ last: '200', since: first.cursor }));
    assert.deepEqual(line.messages.map((m) => m.from), ['system']);
    assert.equal(b.talk.of('helper', new URLSearchParams({ last: '200', since: line.cursor })).messages.length, 0);
    /* The owner writes: that message alone. */
    await b.talk.say('helper', 'One more thing.');
    const wrote = b.talk.of('helper', new URLSearchParams({ last: '200', since: line.cursor }));
    assert.deepEqual(wrote.messages.map((m) => m.text), ['One more thing.']);
    /* Its machine's lines: those of its time only, in a page. */
    assert.equal(before.messages.some((m) => m.from === 'system'), false);
    assert.equal(b.talk.of('helper', new URLSearchParams({ last: '200' })).messages.filter((m) => m.from === 'system').length, 1);
    /* Not asked: the newest SHOWN_MAX, as it was; ?state=1: whether it is on, nothing more. */
    const plain = b.talk.of('helper');
    assert.equal(plain.messages.length, 200);
    assert.equal('cursor' in plain, false);
    assert.deepEqual(Object.keys(b.talk.of('helper', new URLSearchParams({ state: '1' }))).sort(), ['on', 'possible', 'tools', 'wake']);
    /* The files on disk are whole. */
    assert.equal(readFileSync(join(b.bridge, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean).length, 300);
});

test('the whole chat searched; a question still open however old; the list of conversations still says it waits', async (t) => {
    const b = bench(t);
    b.thread(500);
    const lines = readFileSync(join(b.bridge, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 0, JSON.stringify({ id: 'q-old', at: at(1.5), kind: 'ask', text: 'Which backup?', choices: ['A', 'B'] }), JSON.stringify({ id: 's-old', at: at(1.6), kind: 'show', path: '/work/old-plan.png' }));
    writeFileSync(join(b.bridge, 'from-agent.jsonl'), lines.map((l) => `${l}\n`).join(''));
    await b.talk.set('helper', true);
    const found = b.talk.search('helper', 'owner message 3');
    assert.equal(found.matches[0].text, 'Owner message 399');
    assert.equal(found.count, 1 + 5 + 50, '3, 31 to 39, 301 to 399: the owner\'s are odd');
    const now = b.talk.of('helper', new URLSearchParams({ last: '100' }));
    assert.equal(now.messages[0].id, 'q-old', 'open: given with the end of the thread');
    assert.equal(now.waiting, 1);
    assert.equal(b.talk.brief('helper').waiting, 1);
    assert.throws(() => b.talk.search('nobody', 'x'), /No such conversation/);
    /* A file shown long ago is still one of its chat: it opens from the page that brought it back. */
    assert.equal(b.talk.shown('helper', 'work:old-plan.png'), true);
    assert.equal(b.talk.shown('helper', 'work:never-shown.png'), false);
});

test('what its tool reads after a restart is the owner\'s choice; its guide says it', async (t) => {
    const b = bench(t);
    assert.deepEqual(b.talk.window(), { ai: AI_WINDOW, default: AI_WINDOW, choices: WINDOWS });
    assert.equal(b.talk.rereadLine(), REREAD, 'the newest 100 by default');
    assert.equal(b.talk.rereadCommand(), 'parley read --last 100');
    assert.throws(() => b.talk.setWindow({ ai: 'messages:1000000' }), /one of/);
    b.talk.setWindow({ ai: 'days:3' });
    assert.equal(b.talk.rereadCommand(), 'parley read --days 3');
    assert.match(b.talk.rereadLine(), /run "parley read --days 3" before going on; it says how to read further back\./);
    /* Typed so after a restart. */
    await b.talk.set('helper', true);
    b.talk.renewed('helper', 'Restarted.', true);
    await b.talk.say('helper', 'Back?');
    b.world.clock += REREAD_AFTER_MS + 1;
    await until('typed', () => b.typed.length > 0);
    assert.match(b.typed[0], /parley read --days 3/);
    assert.match(ownText({ name: 'x', chat: true, workKept: true, reread: 'parley read --days 3' }), /- After a restart: parley read --days 3, the end of the chat; it says how to read further back\./);
    assert.doesNotMatch(ownText({ name: 'x', chat: false, workKept: true, reread: 'parley read --days 3' }), /After a restart/);
});

test('what the page may ask for: numbers and ids, nothing else', () => {
    assert.deepEqual(partOf(new URLSearchParams({ last: '200', c: 'helper' })), { last: 200 });
    assert.deepEqual(partOf({ days: '3', before: 'a-1', since: '1.2.3~abc' }), { days: 3, before: 'a-1', since: '1.2.3~abc' });
    assert.equal(partOf(new URLSearchParams({ last: '-1', before: 'a b', since: '<x>' })), null);
    assert.equal(partOf(null), null);
    assert.deepEqual(partOf(new URLSearchParams({ state: '1' })), { state: true });
});
