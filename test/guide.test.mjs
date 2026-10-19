/* Where a tool is: a short guide made from the real settings, a line in the
   tool's own instruction file, and nothing of one conversation where
   another machine could read it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Guide, commonText, ownText, withBlock, readLines, plain, POINTER, MARK_START, MARK_END, COMMON_PATH, OWN_PATH, TELL_AGAIN, LINES_MAX, LINE_MAX } from '../server/guide.mjs';
import { Toolbox } from '../server/toolbox.mjs';
import { Store } from '../server/store.mjs';
import { readTools, loadTools } from '../server/tools.mjs';

const TOOLS = readTools(JSON.stringify([
    { id: 'claude-code', label: 'Claude Code', instructions: '.claude/CLAUDE.md', command: ['claude'], memoryMb: 2048, install: [] },
    { id: 'shell', label: 'Shell', command: ['bash'], memoryMb: 768, install: [] },
]));

/* Machines played on this computer: each a directory, its user's home in it,
   commands run for real (sh, install) with the paths of the machine put
   under its directory. Everything sent in is recorded. */
function machines(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-guide-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sent = [];
    const states = {};
    const root = (name) => join(dir, name);
    const home = (name) => { const h = join(root(name), 'home'); mkdirSync(h, { recursive: true }); return h; };
    let between = null;
    const vms = {
        state: async (name) => states[name] ?? 'Running',
        exec: async (name, argv, { input = '' } = {}) => {
            sent.push({ name, argv: [...argv], input });
            let command = [...argv];
            if (command[0] === 'sudo') command = command.slice(2);
            if (command[0] === 'install') {
                const target = join(root(name), command.at(-1));
                mkdirSync(dirname(target), { recursive: true });
                rmSync(target, { force: true });
                writeFileSync(target, input, { mode: 0o444 });
                return { code: 0, stdout: '', stderr: '' };
            }
            if (command[0] === 'sh') {
                if (command[2].includes('changed meanwhile') && between) { between(home(name)); between = null; }
                const r = spawnSync('sh', command.slice(1), { cwd: home(name), input, encoding: 'utf8' });
                return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
            }
            return { code: 127, stdout: '', stderr: 'not played here' };
        },
    };
    return { dir, vms, sent, states, root, home, meanwhile: (f) => { between = f; } };
}

function bench(t, { conversations = { writer: { name: 'writer', tool: 'claude-code', work: 'kept', phase: 'ready' } }, resources = {}, records = {}, secrets = {}, chat = {}, say } = {}) {
    const m = machines(t);
    const store = new Store(join(m.dir, 'guide.json'));
    const guide = new Guide({
        store, vms: m.vms, tools: TOOLS,
        conversations: { get: (name) => conversations[name], awake: () => Object.values(conversations).filter((c) => c.phase === 'ready' && !c.asleep).map((c) => c.name) },
        resources: { of: (name) => resources[name] ?? [], get: (name) => records[name], hasOrigin: (name) => records[name]?.origin === true },
        secrets: { of: (name) => Object.keys(secrets[name] ?? {}) },
        toolbox: { find: (name) => (name === 'parley' ? { path: '/tools/clavarium-parley-0.5.0.tgz' } : undefined) },
        chat: (name) => chat[name] === true,
        say: say ?? (async () => true),
    });
    return { ...m, guide, store };
}

test('the part every machine reads: facts and exact commands, a pointer to its own part, nothing of a conversation', () => {
    const text = commonText();
    const lines = text.trim().split('\n');
    assert.ok(lines.length >= 8 && lines.length <= 20, `${lines.length} lines`);
    assert.equal(lines[0], '# Where you are (Clavarium)');
    for (const fact of ['you are root (sudo works)', '/work', '/resources/<name>', '/tools/index.json', OWN_PATH, 'You have no push key: never push', 'never in /tmp', 'environment variables: never print them', 'To talk to the person, when their chat is on: parley guide says how (parley --help, every command).']) assert.ok(text.includes(fact), fact);
    assert.ok(text.length < 1600, 'short');
    /* Plain ASCII, no address of any kind. */
    assert.match(text, /^[\x20-\x7e\n]*$/);
    assert.doesNotMatch(text, /https?:|\d+\.\d+\.\d+\.\d+|:\d{2,5}\b|ssh-|BEGIN|password|token/i);
    /* Parley is installed by the server: the tool is never asked to install anything. */
    assert.doesNotMatch(text, /npm install|\.tgz/);
});

test('the part of one conversation: read-only and read-write right, the chat on or off, names of secrets only, no address', async (t) => {
    const b = bench(t, {
        conversations: { writer: { name: 'writer', tool: 'claude-code', work: 'kept', phase: 'ready' }, helper: { name: 'helper', tool: 'shell', work: 'disk', phase: 'ready', offline: true } },
        resources: { writer: [{ name: 'book', access: 'write' }, { name: 'photos', access: 'read' }, { name: 'site', access: 'write' }, { name: 'home-mail', access: 'read' }] },
        records: { book: { name: 'book', type: 'folder' }, photos: { name: 'photos', type: 'folder' }, site: { name: 'site', type: 'git', from: 'ssh://example.com/me/site.git', origin: true }, 'home-mail': { name: 'home-mail', type: 'mailbox', host: 'imap.example.com', user: 'you@example.com' } },
        secrets: { writer: { MODEL_KEY: 'sk-the-value-itself' } },
        chat: { writer: true },
    });
    const own = b.guide.own('writer');
    assert.match(own, /^# This conversation: writer\n/);
    assert.match(own, /^- Read-write: \/resources\/book, \/resources\/site \(git\)\.$/m);
    assert.match(own, /^- Read-only: \/resources\/photos, \/resources\/home-mail \(mail\)\.$/m);
    assert.ok(own.includes("git -C /resources/site fetch /resources/site-origin '+refs/heads/*:refs/remotes/origin/*'"));
    assert.match(own, /^- \/work is kept by the server/m);
    assert.match(own, /^- Chat with the person: on\. Parley is installed: run parley guide\.$/m);
    /* How Parley is used is said by parley guide, not here again. */
    assert.ok(!/--short|parley close|parley tell|parley status/.test(own), 'no Parley usage described here');
    assert.doesNotMatch(own, /npm install|\.tgz/);
    assert.match(own, /^- Internet: on\.$/m);
    assert.match(own, /^- Secrets given, by name only: MODEL_KEY\.$/m);
    for (const never of ['sk-the-value-itself', 'example.com', 'ssh:', 'imap', '@']) assert.ok(!own.includes(never), `never: ${never}`);
    const other = b.guide.own('helper');
    assert.match(other, /^- Folders given: none\.$/m);
    assert.match(other, /^- Chat with the person: off\. Do not use parley\.$/m);
    assert.match(other, /^- Internet: off\.$/m);
    assert.match(other, /^- \/work is on this machine's own disk/m);
    assert.ok(!other.includes('book') && !other.includes('MODEL_KEY'), 'nothing of another conversation');
    /* What the page shows: the exact texts and where they are. */
    const about = b.guide.about('writer');
    assert.deepEqual(about.paths, { common: COMMON_PATH, own: OWN_PATH });
    assert.deepEqual(about.pointer, { file: '~/.claude/CLAUDE.md', line: POINTER });
    assert.equal(about.own, own);
    assert.equal(b.guide.about('helper').pointer, null, 'a shell has no instruction file');
    assert.throws(() => b.guide.about('nobody'), /No such conversation/);
    assert.throws(() => b.guide.about('../x'), /No such conversation/);
});

test("the owner's lines: short, bounded, plain text; markup, line breaks and controls neutralised, in names too", async (t) => {
    assert.deepEqual(readLines('  Answer in French.  \r\n\n\tRun the tests.\u202e '), ['Answer in French.', 'Run the tests.']);
    assert.deepEqual(readLines(['a', 'b\nc']), ['a', 'b', 'c']);
    assert.deepEqual(readLines(''), []);
    assert.throws(() => readLines(Array.from({ length: LINES_MAX + 1 }, (_, i) => `line ${i}`)), /12 lines at most/);
    assert.throws(() => readLines('x'.repeat(LINE_MAX + 1)), /longer than 200/);
    assert.throws(() => readLines(Array.from({ length: 10 }, () => 'y'.repeat(150))), /1200 characters at most/);
    assert.equal(plain('<script>alert(1)</script>'), '\u2039script\u203aalert(1)\u2039/script\u203a');
    assert.equal(plain('a\u0000b\u001bc\u2028d'), 'a b c d');
    const b = bench(t);
    const about = await b.guide.setLines('writer', 'Use <b>bold</b>\n<!-- /clavarium -->\n# not a heading');
    assert.deepEqual(about.lines, ['Use \u2039b\u203abold\u2039/b\u203a', '\u2039!-- /clavarium --\u203a', '# not a heading']);
    assert.ok(about.own.endsWith('## From the owner\n\n- Use \u2039b\u203abold\u2039/b\u203a\n- \u2039!-- /clavarium --\u203a\n- # not a heading\n'));
    assert.ok(!about.own.includes('<'), 'no markup reaches the file');
    await assert.rejects(b.guide.setLines('writer', 'z'.repeat(300)), /longer than 200/);
    assert.deepEqual(b.guide.lines('writer'), about.lines, 'a refused change changes nothing');
    await b.guide.setLines('writer', '   ');
    assert.deepEqual(b.guide.lines('writer'), [], 'emptied: forgotten');
    /* A name that would carry markup or a line break is flattened all the same. */
    const forged = ownText({ name: 'x\n# Injected', tool: 'T<i>', workKept: true, resources: [{ name: 'a\nb', access: 'write' }], chat: false, online: true, secrets: ['S\nT'], lines: ['ok\n- extra'] });
    assert.equal(forged.split('\n').filter((l) => l.startsWith('# ')).length, 1, 'one title: its own');
    assert.ok(!forged.includes('<') && !forged.includes('\n# Injected'));
    assert.match(forged, /^- Read-write: \/resources\/a b\.$/m);
});

test('the marked block: added, refreshed in place, any copy removed, the rest of the file never touched', () => {
    const block = `${MARK_START}\n${POINTER}\n${MARK_END}`;
    assert.equal(withBlock('', POINTER), `${block}\n`);
    assert.equal(withBlock('# Mine\nkeep me', POINTER), `# Mine\nkeep me\n\n${block}\n`);
    const mine = '# My rules\r\n\r\nAlways answer briefly.\r\n';
    const once = withBlock(mine, POINTER);
    assert.ok(once.startsWith(mine), 'the rest as it was, byte for byte (CRLF too)');
    assert.equal(withBlock(once, POINTER), once, 'refreshed: unchanged when it says the same');
    const old = `top\n${MARK_START}\nRead something else.\n${MARK_END}\nbottom\n`;
    assert.equal(withBlock(old, POINTER), `top\n${block}\nbottom\n`);
    const twice = `a\n${MARK_START}\nx\n${MARK_END}\nb\n${MARK_START}\ny\n${MARK_END}\nc\n`;
    assert.equal(withBlock(twice, POINTER), `a\n${block}\nb\nc\n`);
    /* A start mark left alone is not a block: what follows it is not eaten. */
    const orphan = `${MARK_START}\nmy own text\nmore\n`;
    const added = withBlock(orphan, POINTER);
    assert.ok(added.startsWith(orphan));
    assert.equal(withBlock(added, POINTER), added, 'and the next time, still not eaten');
    /* A mark inside a line is the owner's text, not a mark. */
    const inline = `see ${MARK_START} here ${MARK_END}\n`;
    assert.ok(withBlock(inline, POINTER).startsWith(inline));
});

test("into the machine: its own part root-owned and read-only, the pointer in the tool's file through a marked block; a link refused", async (t) => {
    const b = bench(t);
    await b.guide.prepared('writer', true);
    const own = join(b.root('writer'), OWN_PATH);
    assert.equal(readFileSync(own, 'utf8'), b.guide.own('writer'));
    const install = b.sent.find((s) => s.argv.includes('install'));
    assert.deepEqual(install.argv, ['sudo', '-n', 'install', '-D', '-m', '0444', '-o', 'root', '-g', 'root', '/dev/stdin', OWN_PATH], 'its text on standard input, never in an argument');
    const file = join(b.home('writer'), '.claude/CLAUDE.md');
    assert.equal(readFileSync(file, 'utf8'), `${MARK_START}\n${POINTER}\n${MARK_END}\n`);
    /* Names are arguments of a fixed script, never spliced into it. */
    for (const s of b.sent.filter((x) => x.argv[0] === 'sh')) { assert.equal(s.argv[3], 'clavarium-guide'); assert.equal(s.argv[4], '.claude/CLAUDE.md'); assert.ok(!s.argv[2].includes('CLAUDE')); }

    /* The tool (or the person) wrote its own rules there: kept, the block refreshed. */
    writeFileSync(file, '# My rules\nBe brief.\n');
    assert.equal(await b.guide.pointer('writer'), 'written');
    assert.equal(readFileSync(file, 'utf8'), `# My rules\nBe brief.\n\n${MARK_START}\n${POINTER}\n${MARK_END}\n`);
    const sent = b.sent.length;
    assert.equal(await b.guide.pointer('writer'), 'same');
    assert.equal(b.sent.length, sent + 1, 'read, and not written again');

    /* Changed between the look and the write: left as it is. */
    b.meanwhile((h) => writeFileSync(join(h, '.claude/CLAUDE.md'), 'Somebody wrote this meanwhile.\n'));
    writeFileSync(file, 'before\n');
    await assert.rejects(b.guide.pointer('writer'), /changed meanwhile/);
    assert.equal(readFileSync(file, 'utf8'), 'Somebody wrote this meanwhile.\n');

    /* A link, to the file or to a folder on the way: refused, its target untouched. */
    const target = join(b.root('writer'), 'elsewhere.md');
    writeFileSync(target, 'not yours\n');
    rmSync(file);
    symlinkSync(target, file);
    await assert.rejects(b.guide.pointer('writer'), /is a link: not followed/);
    assert.equal(readFileSync(target, 'utf8'), 'not yours\n');
    rmSync(join(b.home('writer'), '.claude'), { recursive: true });
    mkdirSync(join(b.root('writer'), 'other'));
    symlinkSync(join(b.root('writer'), 'other'), join(b.home('writer'), '.claude'));
    await assert.rejects(b.guide.pointer('writer'), /\.claude is a link/);
    assert.deepEqual(readdirSync(join(b.root('writer'), 'other')), []);
    /* A folder where the file should be: refused. */
    rmSync(join(b.home('writer'), '.claude'));
    mkdirSync(join(b.home('writer'), '.claude/CLAUDE.md'), { recursive: true });
    await assert.rejects(b.guide.pointer('writer'), /is not a file/);
    /* Never in the way of an opening. */
    const quiet = console.error; console.error = () => {};
    try { await b.guide.prepared('writer', true); } finally { console.error = quiet; }
});

test('kept up to date: written at a start, again when a setting changes, never into a machine that sleeps; told again only when asked', async (t) => {
    const said = [];
    const conversations = { writer: { name: 'writer', tool: 'claude-code', work: 'kept', phase: 'ready' } };
    const b = bench(t, { conversations, say: async (name, line) => { said.push([name, line]); return true; } });
    await b.guide.prepared('writer', true);
    const writes = () => b.sent.filter((s) => s.argv.includes('install')).length;
    assert.equal(writes(), 1);
    await b.guide.prepared('writer', false);
    assert.equal(writes(), 1, 'an opening with nothing changed sends nothing');
    await b.guide.setLines('writer', 'Answer in French.');
    assert.equal(writes(), 2, 'a change: written now into a machine that runs');
    assert.ok(readFileSync(join(b.root('writer'), OWN_PATH), 'utf8').includes('- Answer in French.'));
    b.states.writer = 'Stopped';
    await b.guide.setLines('writer', 'Answer in German.');
    assert.equal(writes(), 2, 'nothing sent into a machine that does not run');
    b.states.writer = 'Running';
    await b.guide.prepared('writer', false);
    assert.equal(writes(), 3, 'it gets it at its next opening');
    assert.equal(said.length, 0, 'nothing typed by itself');
    const told = await b.guide.tellAgain('writer');
    assert.deepEqual(said, [['writer', TELL_AGAIN]]);
    assert.equal(told.told, 'Read /tools/CLAVARIUM.md and /etc/clavarium/conversation.md again: your setup changed.');
    conversations.writer.asleep = true;
    await assert.rejects(b.guide.tellAgain('writer'), /asleep/);
    assert.equal(said.length, 1);
});

test('isolation: one conversation\'s part goes into its own machine only, on its own disk; /tools holds the common part alone', async (t) => {
    const conversations = { alpha: { name: 'alpha', tool: 'claude-code', work: 'kept', phase: 'ready' }, beta: { name: 'beta', tool: 'claude-code', work: 'kept', phase: 'ready' } };
    const b = bench(t, { conversations, resources: { alpha: [{ name: 'alpha-secret-plans', access: 'write' }] }, records: { 'alpha-secret-plans': { name: 'alpha-secret-plans', type: 'folder' } } });
    await b.guide.setLines('alpha', 'Only alpha may read this line.');
    await b.guide.prepared('alpha', true);
    await b.guide.prepared('beta', true);
    for (const s of b.sent) {
        const text = `${s.argv.join(' ')}\n${s.input}`;
        if (s.name === 'beta') assert.ok(!text.includes('alpha'), 'nothing of alpha is ever sent into beta');
        /* Only two places are ever written: its own file, and the tool's file in its home -- never a shared folder. */
        const target = s.argv.includes('install') ? s.argv.at(-1) : s.argv[4];
        assert.ok([OWN_PATH, '.claude/CLAUDE.md'].includes(target), target);
    }
    assert.ok(readFileSync(join(b.root('alpha'), OWN_PATH), 'utf8').includes('Only alpha may read this line.'));
    assert.ok(!readFileSync(join(b.root('beta'), OWN_PATH), 'utf8').includes('alpha'));
    /* The tools folder, which every machine sees: the common part, the same for all. */
    const tools = mkdtempSync(join(tmpdir(), 'clv-guide-tools-'));
    t.after(() => rmSync(tools, { recursive: true, force: true }));
    const box = new Toolbox({ host: async () => ({ code: 0, stderr: '' }), vms: {}, mntDir: tools, notes: (find) => commonText({ parley: find('parley')?.path }) });
    await box.prepare();
    const files = join(tools, 'toolbox', 'files');
    const notes = readFileSync(join(files, 'CLAVARIUM.md'), 'utf8');
    assert.equal(notes, commonText({ parley: box.find('parley').path }));
    for (const f of readdirSync(files)) assert.ok(!readFileSync(join(files, f)).toString('latin1').includes('alpha'), f);
    assert.ok(statSync(join(files, 'CLAVARIUM.md')).isFile() && !lstatSync(join(files, 'CLAVARIUM.md')).isSymbolicLink());
});

test("each tool's own instruction file is a line of its configuration, checked", () => {
    const real = Object.fromEntries(loadTools().map((x) => [x.id, x.instructions]));
    assert.deepEqual(real, { 'claude-code': '.claude/CLAUDE.md', opencode: '.config/opencode/AGENTS.md', codex: '.codex/AGENTS.md', gemini: '.gemini/GEMINI.md', shell: undefined });
    const one = (instructions) => readTools(JSON.stringify([{ id: 'x', label: 'X', command: ['x'], memoryMb: 768, install: [], instructions }]));
    for (const bad of ['/etc/passwd', '../x', 'a/../b', './a', 'a//b', 'a b', '$(x)', '']) assert.throws(() => one(bad), /instructions/, bad);
    assert.equal(one('.x/RULES.md')[0].instructions, '.x/RULES.md');
    assert.ok(!existsSync('/nonexistent-guide-check'));
});
