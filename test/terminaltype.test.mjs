/* The one way this server types into a tool's terminal (terminaltype.mjs): copy mode left, the line and
   its Enter in one command, the bridge's terminal only when that fails, each line said in the log. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalType, DOORBELLS, typeCommand, keyCommand, enterCommand, escapeCommand, TYPED_AT, ENTER_AFTER_MS, HOLD_MAX_MS } from '../server/terminaltype.mjs';
import { Wakeups } from '../server/wakeups.mjs';
import { Dockets, WAKE } from '../server/dockets.mjs';
import { Store } from '../server/store.mjs';

function bench({ code = 0, terminal = null, typing = () => false } = {}) {
    const ran = []; const logged = []; const warmed = []; let now = 0;
    const vms = { exec: async (name, argv) => { ran.push(argv); return typeof code === 'function' ? code(argv) : typeof code === 'object' ? code : { code }; } };
    const typer = new TerminalType({ vms, terminal, typing, warm: async (name) => { warmed.push(name); }, log: (line) => logged.push(line), now: () => now, pause: async (ms) => { now += ms; } });
    return { typer, ran, logged, warmed, now: () => now };
}

test('a line: its terminal warmed, then ONE command -- copy mode left, the line, a pause, Enter -- and said typed', async () => {
    const b = bench();
    assert.equal(await b.typer.typeLine('worker', 'You have something to handle: run "docket".', { why: 'docket' }), true);
    assert.deepEqual(b.warmed, ['worker']);
    assert.equal(b.ran.length, 1, 'one command into the machine');
    const [argv] = b.ran;
    assert.deepEqual(argv, typeCommand('You have something to handle: run "docket".'));
    assert.deepEqual(argv.slice(3, 10), ['if-shell', '-F', '-t', '=main:', '#{pane_in_mode}', 'send-keys -t =main: -X cancel', ';'], 'copy mode left first');
    assert.equal(argv[TYPED_AT], 'You have something to handle: run "docket".');
    assert.deepEqual(argv.slice(TYPED_AT + 1), [';', 'run-shell', '-d', String(ENTER_AFTER_MS / 1000), ';', 'send-keys', '-t', '=main:', 'Enter']);
    assert.deepEqual(b.logged, ['docket: worker: typed (You have something to handle: run "docket".)']);
});

test('the command failed: down the terminal the bridge keeps open, said so; neither: NOT typed, with why', async () => {
    const down = [];
    const terminal = { open: () => true, type: async (name, line, ms) => { down.push([name, line, ms]); return true; } };
    const b = bench({ code: { code: 1, stderr: 'no server running\n' }, terminal });
    assert.equal(await b.typer.typeLine('worker', 'Look at the queue.', { why: 'wake-up' }), true);
    assert.deepEqual(down, [['worker', 'Look at the queue.', ENTER_AFTER_MS]]);
    assert.deepEqual(b.logged, ['wake-up: worker: typed down its terminal (Look at the queue.), the command in the machine failed (exit 1: no server running)']);

    const closed = bench({ code: { code: 1 }, terminal: { open: () => false, type: async () => assert.fail('no terminal open') } });
    assert.equal(await closed.typer.typeLine('worker', 'x'), false);
    assert.deepEqual(closed.logged, ['server: worker: NOT typed (x): exit 1; no terminal open']);

    const refused = bench({ code: { code: 1 }, terminal: { open: () => true, type: async () => false } });
    assert.equal(await refused.typer.typeLine('worker', 'x', { why: 'talk', what: 'wake' }), false);
    assert.deepEqual(refused.logged, ['talk: worker: NOT typed (wake): exit 1; its terminal refused too']);

    const thrown = bench({ code: () => { throw new Error('gone'); } });
    assert.equal(await thrown.typer.typeLine('worker', 'x'), false, 'a command that throws is a failure, never an exception');
    assert.match(thrown.logged[0], /^server: worker: NOT typed \(x\): exit -1: gone; no terminal open$/);
});

test('the line went down the terminal, its Enter did not: the Enter alone, never the line twice', async () => {
    const terminal = { open: () => true, type: async () => 'enter' };
    const b = bench({ code: (argv) => ({ code: argv.includes('-l') ? 1 : 0 }), terminal });
    assert.equal(await b.typer.typeLine('worker', 'x'), true);
    assert.deepEqual(b.ran, [typeCommand('x'), enterCommand()]);
});

test('a secret is never named in the log', async () => {
    const b = bench();
    assert.equal(await b.typer.typeLine('worker', 'AbC-123-code', { why: 'sign-in', secret: true }), true);
    assert.deepEqual(b.logged, ['sign-in: worker: typed (not shown)']);
    assert.doesNotMatch(b.logged.join('\n'), /AbC/);
});

test('never over a person: held while somebody types, a while at most; hold 0: not typed at all', async () => {
    let busy = 3;
    const b = bench({ typing: () => busy-- > 0 });
    assert.equal(await b.typer.typeLine('worker', 'x'), true);
    assert.equal(b.now(), 3000, 'held while they typed');
    assert.deepEqual(b.logged, ['server: worker: typed (x)']);

    const long = bench({ typing: () => true });
    assert.equal(await long.typer.typeLine('worker', 'x'), true);
    assert.ok(long.now() >= HOLD_MAX_MS && long.now() < HOLD_MAX_MS + 2000, 'a line left half typed does not keep the server silent');
    assert.match(long.logged[0], /^server: worker: typed \(x\), after 300 s with somebody typing there$/);

    const now = bench({ typing: () => true });
    assert.equal(await now.typer.typeLine('worker', 'y', { why: 'answerer', hold: 0 }), false);
    assert.deepEqual(now.ran, [], 'nothing typed');
    assert.deepEqual(now.logged, ['answerer: worker: NOT typed (y): somebody types there']);
});

test('a key alone: copy mode left, the key, in one command; said either way', async () => {
    const b = bench();
    assert.equal(await b.typer.sendKey('worker', 'Escape', { why: 'API key' }), true);
    assert.deepEqual(b.ran, [escapeCommand()]);
    assert.deepEqual(escapeCommand(), keyCommand('Escape'));
    assert.deepEqual(keyCommand('y').slice(3, 10), ['if-shell', '-F', '-t', '=main:', '#{pane_in_mode}', 'send-keys -t =main: -X cancel', ';']);
    assert.deepEqual(keyCommand('y').slice(10), ['send-keys', '-t', '=main:', 'y']);
    assert.deepEqual(b.logged, ['API key: worker: key Escape']);
    const failed = bench({ code: { code: 1 } });
    assert.equal(await failed.typer.sendKey('worker', 'Escape'), false);
    assert.deepEqual(failed.logged, ['server: worker: key Escape NOT sent: exit 1']);
});

test('wake-ups, server lines and the docket\'s line all go through the one typer', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-termtype-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const lines = [];
    const typer = { typeLine: async (name, line, options) => { lines.push([name, line, options.why]); return true; }, ring: async (name, source) => { lines.push([name, 'ring', source]); return true; }, busy: () => false };
    const world = { now: new Date(2026, 0, 5, 6, 0, 0) };
    const wakeups = new Wakeups({ store: new Store(join(dir, 'w.json')), vms: { exec: async () => assert.fail('never typed on its own') }, conversations: { list: () => [{ name: 'worker' }], awake: () => ['worker'] }, resources: { of: () => [] },
        now: () => new Date(world.now), typer });
    wakeups.add('worker', { kind: 'every', minutes: 5, message: 'Look at the inbox.' });
    world.now = new Date(world.now.getTime() + 5 * 60_000);
    await wakeups.tick();
    assert.equal(await wakeups.say('worker', 'Clavarium, repository site: moved.'), true);
    /* As main.mjs makes it: the docket's line said through the wake-ups. */
    const work = join(dir, 'work');
    mkdirSync(work);
    const dockets = new Dockets({ store: new Store(join(dir, 'd.json')), resources: { workFolder: () => work }, now: () => world.now.getTime(), listenEveryMs: 10,
        say: (name, line) => (line === WAKE ? wakeups.ring(name, 'docket') : wakeups.say(name, line, { why: 'docket' })), event: () => {}, alert: () => {}, idle: () => true, awake: () => ['worker'], chatOn: () => true, zone: 'Europe/Paris' });
    t.after(() => dockets.stop());
    dockets.post('worker', { kind: 'arrival', text: 'New in handoff: a.md' });
    await dockets.tick();
    assert.deepEqual(lines, [['worker', 'Look at the inbox.', 'wake-up'], ['worker', 'Clavarium, repository site: moved.', 'server line'], ['worker', 'ring', 'docket']]);
});

test('a doorbell: one short line, never content -- the chat\'s and the docket\'s, typed and said as any line', async () => {
    const b = bench();
    assert.equal(await b.typer.ring('worker', 'docket'), true);
    assert.equal(await b.typer.ring('worker', 'chat'), true);
    assert.deepEqual(b.ran, [typeCommand(WAKE), typeCommand(DOORBELLS.chat.line)]);
    assert.deepEqual(b.logged, ['docket: worker: typed (wake)', 'talk: worker: typed (wake)']);
    for (const bell of Object.values(DOORBELLS)) assert.ok(bell.line.length < 200 && !/\n/.test(bell.line), 'short, one line');
    await assert.rejects(b.typer.ring('worker', 'anything'), RangeError);
});

/* ONE PIPE INTO THE TERMINAL (the owner's rule, 17-11): no module of the server types into a tool's pane but
   terminaltype.mjs. Allowed, and only these: bridge.mjs, the terminal itself -- the person's own keystrokes
   from a screen, and the channel terminaltype.mjs falls back to; main.mjs hands that channel to the typer alone. */
test('one pipe: tmux send-keys is built nowhere in the server but terminaltype.mjs; the bridge\'s typing handed to it alone', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const root = new URL('../server/', import.meta.url);
    const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.mjs'));
    const KEYS_INTO_PANE = /send-keys|paste-buffer|send-prefix|load-buffer/;
    const found = files.filter((f) => f !== 'terminaltype.mjs' && KEYS_INTO_PANE.test(readFileSync(new URL(f, root), 'utf8')));
    assert.deepEqual(found, [], 'keys into a pane built outside terminaltype.mjs');
    const main = readFileSync(new URL('main.mjs', root), 'utf8');
    assert.equal(main.match(/bridge\?\.type\(/g)?.length, 1, 'the bridge\'s typing given to one place');
    assert.match(main, /new TerminalType\(\{[^]*?bridge\?\.type\(/, '...the one TerminalType');
    const others = files.filter((f) => !['bridge.mjs', 'main.mjs', 'terminaltype.mjs'].includes(f) && /\bbridge\??\.type\(|\.terminal\.write\(/.test(readFileSync(new URL(f, root), 'utf8')));
    assert.deepEqual(others, []);
});
