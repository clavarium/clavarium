/* The launchers of /tools/launch, run as a machine runs them: a home of
   their own, the command they start replaced by one that says what it got. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTools, readTools } from '../server/tools.mjs';

const LAUNCH = fileURLToPath(new URL('../config/launch', import.meta.url));
function home(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-launch-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const jsonSet = (dir, ...args) => spawnSync(process.execPath, [join(LAUNCH, 'json-set.mjs'), ...args], { env: { ...process.env, HOME: dir }, encoding: 'utf8' });
const settings = (dir) => JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));

test('json-set: keys set and taken out, every other key kept; a file that is not JSON is never overwritten', (t) => {
    const dir = home(t);
    assert.equal(jsonSet(dir, '.claude/settings.json', '{"a": true}').status, 0);
    assert.deepEqual(settings(dir), { a: true }, 'made when missing');
    assert.equal(statSync(join(dir, '.claude', 'settings.json')).mode & 0o777, 0o600);
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark-ansi', permissions: { allow: ['Bash(parley:*)'] } }));
    jsonSet(dir, '.claude/settings.json', '{"skipDangerousModePermissionPrompt": true}');
    assert.deepEqual(settings(dir), { theme: 'dark-ansi', permissions: { allow: ['Bash(parley:*)'] }, skipDangerousModePermissionPrompt: true });
    jsonSet(dir, '.claude/settings.json', '{"skipDangerousModePermissionPrompt": null}');
    assert.deepEqual(settings(dir), { theme: 'dark-ansi', permissions: { allow: ['Bash(parley:*)'] } }, 'null takes it out');
    writeFileSync(join(dir, '.claude', 'settings.json'), 'not json {');
    assert.equal(jsonSet(dir, '.claude/settings.json', '{"a": 1}').status, 3);
    assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), 'not json {', 'left as it is');
    for (const bad of [['/etc/passwd', '{}'], ['../x', '{}'], ['a/../../b', '{}'], ['x.json', '[1]'], ['x.json', 'nope'], ['x.json']]) assert.equal(jsonSet(dir, ...bad).status, 64, bad.join(' '));
    assert.ok(!existsSync(join(dir, 'x.json')));
});

test('the launcher of Claude Code: its settings file says the rights chosen, then the command runs as it was given', (t) => {
    const dir = home(t);
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark-ansi' }));
    /* No chat: this test is about the rights alone (where it runs may have a chat of its own). */
    const run = (...args) => spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), ...args], { env: { ...process.env, HOME: dir, PARLEY_DIR: join(dir, 'no-chat') }, encoding: 'utf8' });
    const full = run('full', 'sh', '-c', 'echo "ran: $*"', 'x', '--dangerously-skip-permissions', 'a b');
    assert.equal(full.status, 0, full.stderr);
    assert.equal(full.stdout, 'ran: --dangerously-skip-permissions a b\n', 'its arguments, untouched');
    assert.deepEqual(settings(dir), { theme: 'dark-ansi', skipDangerousModePermissionPrompt: true });
    assert.equal(run('ask', 'true').status, 0);
    assert.deepEqual(settings(dir), { theme: 'dark-ansi' }, 'asked first: taken out');
    /* The exit of the tool is the exit of the launcher. */
    assert.equal(run('full', 'sh', '-c', 'exit 7').status, 7);
    assert.equal(run('maybe', 'true').status, 64);
    assert.equal(run('full').status, 64);
    /* A settings file that cannot be changed is said, and the tool still starts (it then asks first). */
    writeFileSync(join(dir, '.claude', 'settings.json'), 'broken');
    const said = run('full', 'echo', 'started');
    assert.equal(said.stdout, 'started\n');
    assert.match(said.stderr, /were not changed: it may ask before acting/);
});

test('the launcher of Claude Code gives it the chat as its own tools (Parley, MCP) once, by Claude Code itself; none without a chat; never in the way', (t) => {
    const dir = home(t);
    const chat = join(dir, 'work', '.parley'); mkdirSync(chat, { recursive: true });
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const asked = join(dir, 'asked.txt');
    /* A Claude Code that only notes what it is asked, and records the server as the real one does. */
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> "${asked}"\nprintf '{"mcpServers":{"parley":{"command":"node","args":["${chat}/server.mjs"]}}}' > "$HOME/.claude.json"\n`, { mode: 0o755 });
    /* Only what this test puts on the way, and node (its launchers' scripts) -- node alone, never what sits beside it (a Docket of this computer's). */
    const nodeDir = join(dir, 'node'); mkdirSync(nodeDir); symlinkSync(process.execPath, join(nodeDir, 'node'));
    const PATH = `${bin}:${nodeDir}:/usr/bin:/bin`;
    const run = (env = {}) => spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), 'full', 'true'], { env: { ...process.env, HOME: dir, PATH, PARLEY_DIR: chat, ...env }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(existsSync(asked), false, 'no chat (no server in its folder): nothing asked');
    writeFileSync(join(chat, 'server.mjs'), '');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(asked, 'utf8'), `mcp add --scope user parley -- node ${chat}/server.mjs --dir ${chat}\n`, 'no Docket in this machine: Parley alone');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(asked, 'utf8').split('\n').filter(Boolean).length, 1, 'declared already: Claude Code not asked again');
    /* Docket installed: given as its tools too, once, its folder beside the chat's. */
    writeFileSync(join(bin, 'docket-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> "${asked}"\nprintf '{"mcpServers":{"parley":{"command":"node","args":["${chat}/server.mjs"]},"docket":{"command":"docket-mcp","args":["--dir","/work/.docket"]}}}' > "$HOME/.claude.json"\n`, { mode: 0o755 });
    assert.equal(run().status, 0);
    assert.equal(readFileSync(asked, 'utf8').split('\n').filter(Boolean).at(-1), 'mcp add --scope user docket -- docket-mcp --dir /work/.docket');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(asked, 'utf8').split('\n').filter(Boolean).length, 2, 'declared already: not asked again');
    rmSync(join(bin, 'docket-mcp'));
    /* Claude Code refusing: said, and the tool starts all the same. */
    rmSync(join(dir, '.claude.json')); writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const refused = run();
    assert.equal(refused.status, 0);
    assert.match(refused.stderr, /Parley was not given to Claude Code as tools: the command parley still works/);
});

test('the launcher of Claude Code gives the chat its pulse: hooks of Claude Code, the others kept, written once; none without a chat; never in the way', (t) => {
    const dir = home(t);
    const chat = join(dir, 'work', '.parley'); mkdirSync(chat, { recursive: true });
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    mkdirSync(join(dir, '.claude'));
    const theirs = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }] };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark-ansi', hooks: theirs }));
    const run = () => spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), 'full', 'true'], { env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, PARLEY_DIR: chat }, encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.deepEqual(settings(dir).hooks, theirs, 'no chat (no server in its folder): nothing added');
    writeFileSync(join(chat, 'server.mjs'), '');
    assert.equal(run().status, 0);
    const pulse = (end) => [{ type: 'command', command: `parley pulse${end ? ' --end' : ''} --dir ${chat} >/dev/null 2>&1 || true` }];
    const wanted = {
        PreToolUse: [theirs.PreToolUse[0], { matcher: '*', hooks: pulse(false) }],
        Notification: [theirs.Notification[0], { hooks: pulse(true) }],
        UserPromptSubmit: [{ hooks: pulse(false) }],
        Stop: [{ hooks: [{ type: 'command', command: `parley pulse --end --stop-check --dir ${chat} 2>/dev/null || true` }] }],
    };
    assert.deepEqual(settings(dir).hooks, wanted, 'theirs kept, ours after them');
    assert.equal(settings(dir).theme, 'dark-ansi');
    const once = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), once, 'started again: the same, not added twice');
    /* Ours, from an older start with another folder: replaced, not doubled. */
    const old = settings(dir); old.hooks.Stop = [{ hooks: [{ type: 'command', command: 'parley pulse --end --dir /old >/dev/null 2>&1 || true' }] }];
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(old));
    assert.equal(run().status, 0);
    assert.deepEqual(settings(dir).hooks.Stop, wanted.Stop);
    /* Hooks that are not an object: left as they are, said, and the tool starts. */
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: [] }));
    const refused = spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), 'full', 'echo', 'started'], { env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, PARLEY_DIR: chat }, encoding: 'utf8' });
    assert.equal(refused.stdout, 'started\n');
    assert.match(refused.stderr, /will not say when Claude Code works without a word/);
    assert.deepEqual(settings(dir).hooks, []);
});

test('a launcher named in the configuration is a script of config/launch; every launcher there parses', () => {
    for (const t of loadTools()) if (t.launch) assert.ok(existsSync(join(LAUNCH, t.launch)), `${t.id}: ${t.launch} is in config/launch`);
    for (const f of readdirSync(LAUNCH)) {
        if (f.endsWith('.sh')) assert.equal(spawnSync('sh', ['-n', join(LAUNCH, f)]).status, 0, f);
        if (f.endsWith('.mjs')) assert.equal(spawnSync(process.execPath, ['--check', join(LAUNCH, f)]).status, 0, f);
    }
    const one = (launch) => readTools(JSON.stringify([{ id: 'x', label: 'X', command: ['x'], memoryMb: 768, install: [], launch }]));
    for (const bad of ['../x.sh', '/tools/x.sh', 'x', 'x.sh;id', 'X.sh', '']) assert.throws(() => one(bad), /launch/, bad);
    assert.equal(one('x.sh')[0].launch, 'x.sh');
});
