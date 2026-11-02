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

test('the launcher of Claude Code gives it its tools through the relay (MCP), once, by Claude Code itself; an old declaration replaced; none without a chat; never in the way (02-11)', (t) => {
    const dir = home(t);
    const chat = join(dir, 'work', '.parley'); mkdirSync(chat, { recursive: true });
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const asked = join(dir, 'asked.txt');
    const relay = join(LAUNCH, 'mcp-relay.mjs');
    /* A Claude Code that notes what it is asked, and records a server added as the real one does. */
    const fake = `#!/bin/sh\necho "$*" >> "${asked}"\nnode -e '
const fs=require("fs"),f=process.env.HOME+"/.claude.json";let d={};try{d=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}d.mcpServers??={};
const a=process.argv.slice(1);if(a[0]==="mcp"&&a[1]==="remove")delete d.mcpServers[a[4]];
if(a[0]==="mcp"&&a[1]==="add"){const i=a.indexOf("--");d.mcpServers[a[4]]={command:a[i+1],args:a.slice(i+2)}}fs.writeFileSync(f,JSON.stringify(d));' "$@"\n`;
    writeFileSync(join(bin, 'claude'), fake, { mode: 0o755 });
    const nodeDir = join(dir, 'node'); mkdirSync(nodeDir); symlinkSync(process.execPath, join(nodeDir, 'node'));
    const PATH = `${bin}:${nodeDir}:/usr/bin:/bin`;
    const run = (env = {}) => spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), 'full', 'true'], { env: { ...process.env, HOME: dir, PATH, PARLEY_DIR: chat, ...env }, encoding: 'utf8' });
    const lines = () => (existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').filter(Boolean) : []);
    assert.equal(run().status, 0);
    assert.deepEqual(lines(), [], 'no chat (no server in its folder): nothing asked');
    writeFileSync(join(chat, 'server.mjs'), '');
    assert.equal(run().status, 0);
    assert.equal(lines().at(-1), `mcp add --scope user parley -- node ${relay} node ${chat}/server.mjs --dir ${chat}`, 'Parley, through the relay');
    const n = lines().length;
    assert.equal(run().status, 0);
    assert.equal(lines().length, n, 'declared already: Claude Code not asked again');
    /* An older declaration, without the relay: replaced. */
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { parley: { command: 'node', args: [`${chat}/server.mjs`, '--dir', chat] } } }));
    assert.equal(run().status, 0);
    assert.deepEqual(lines().slice(-2), ['mcp remove --scope user parley', `mcp add --scope user parley -- node ${relay} node ${chat}/server.mjs --dir ${chat}`]);
    /* Parley and Docket installed on the machine: their own commands, through the relay. */
    writeFileSync(join(bin, 'parley-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'docket-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(run().status, 0);
    assert.ok(lines().includes(`mcp add --scope user docket -- node ${relay} docket-mcp --dir /work/.docket`), lines().join('\n'));
    assert.ok(lines().includes(`mcp add --scope user parley -- node ${relay} parley-mcp --dir ${chat}`), 'the copy beside the chat replaced by the version installed');
    /* Claude Code refusing: said, and the tool starts all the same. */
    rmSync(join(dir, '.claude.json')); writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const refused = run();
    assert.equal(refused.status, 0);
    assert.match(refused.stderr, /parley was not given to Claude Code as tools: the command parley still works/);
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

test('json-set merges inside objects: the other keys and projects kept (02-11)', (t) => {
    const dir = home(t);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { a: 1 }, projects: { '/other': { x: 1 }, '/work': { allowedTools: ['y'] } } }));
    assert.equal(jsonSet(dir, '.claude.json', '{"hasCompletedOnboarding": true, "projects": {"/work": {"hasTrustDialogAccepted": true}}}').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')), { mcpServers: { a: 1 }, hasCompletedOnboarding: true, projects: { '/other': { x: 1 }, '/work': { allowedTools: ['y'], hasTrustDialogAccepted: true } } });
});

test('screen-watch: the rules a launcher gives, acted on once, on the bottom of the screen only (02-11)', async () => {
    const { rulesOf, actionsOn } = await import('../config/launch/screen-watch.mjs');
    const rules = rulesOf(['link:https://claude\\.ai/[^ ]*oauth[^ ]*', 'notice:(update|installed)[^\\n]{0,80}restart=Restart when it suits you.', 'keys:trust this folder\\?=Enter', 'keys:rm -rf=rm', 'nope:x']);
    assert.deepEqual(rules.map((r) => r.kind), ['link', 'notice', 'keys'], 'a key not in the closed list, or an unknown kind: no rule');
    const seen = new Set();
    const screen = (bottom) => `${'work line\n'.repeat(40)}${bottom}`;
    assert.deepEqual(actionsOn(screen('Open https://claude.ai/oauth/authorize?code=abc to sign in'), rules, seen).map((a) => [a.kind, a.match]), [['link', 'https://claude.ai/oauth/authorize?code=abc']]);
    assert.deepEqual(actionsOn(screen('Open https://claude.ai/oauth/authorize?code=abc to sign in'), rules, seen), [], 'once per link');
    assert.deepEqual(actionsOn(screen('✓ Update installed · Restart to apply'), rules, seen).map((a) => [a.kind, a.value]), [['notice', 'Restart when it suits you.']], 'told to the agent, which decides');
    assert.deepEqual(actionsOn(screen('Do you trust this folder?'), rules, seen).map((a) => [a.kind, a.value]), [['keys', ['Enter']]]);
    assert.deepEqual(actionsOn(`Update installed, restart now\n${'later line\n'.repeat(20)}`, rules, new Set()), [], 'above the bottom: never');
});

test('toml-block keeps its own block, every other line as it was; codex.sh and vibe.sh give their tools through the relay (02-11)', (t) => {
    const dir = home(t);
    const run = (...args) => spawnSync(process.execPath, [join(LAUNCH, 'toml-block.mjs'), ...args], { env: { ...process.env, HOME: dir }, encoding: 'utf8' });
    mkdirSync(join(dir, '.codex'));
    writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mine]\na = 1\n');
    assert.equal(run('.codex/config.toml', 'tools', '[x]\nb = 2').status, 0);
    assert.equal(run('.codex/config.toml', 'tools', '[x]\nb = 3').status, 0);
    assert.equal(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-5"\n\n[mine]\na = 1\n\n# >>> clavarium tools\n[x]\nb = 3\n# <<< clavarium tools\n');
    assert.equal(run('.codex/config.toml', 'tools').status, 0);
    assert.equal(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-5"\n\n[mine]\na = 1\n', 'no text: the block taken out');
    assert.equal(run('/etc/passwd', 'tools', 'x').status, 64);
    /* The launchers themselves, with a Tether on the way. */
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'tether-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const nodeDir = join(dir, 'node'); mkdirSync(nodeDir); symlinkSync(process.execPath, join(nodeDir, 'node'));
    const PATH = `${bin}:${nodeDir}:/usr/bin:/bin`;
    for (const [launcher, file] of [['codex.sh', '.codex/config.toml'], ['vibe.sh', '.vibe/config.toml']]) {
        const r = spawnSync('sh', [join(LAUNCH, launcher), 'full', 'true'], { env: { ...process.env, HOME: dir, PATH, PARLEY_DIR: join(dir, 'nochat') }, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const text = readFileSync(join(dir, file), 'utf8');
        assert.ok(text.includes(`"${join(LAUNCH, 'mcp-relay.mjs')}", "tether-mcp"`), `${launcher}: Tether through the relay\n${text}`);
        assert.doesNotMatch(text, /parley-mcp/, `${launcher}: no chat, no Parley`);
    }
    assert.match(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), /\[projects\."\/work"\]\ntrust_level = "trusted"/);
});
