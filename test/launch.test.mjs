/* The launchers of /tools/launch, run as a machine runs them: a home of
   their own, the command they start replaced by one that says what it got. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTools, readTools } from '../server/tools.mjs';

const LAUNCH = fileURLToPath(new URL('../launch', import.meta.url));
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
    const run = (...args) => spawnSync('sh', [join(LAUNCH, 'claude-code.sh'), ...args], { env: { ...process.env, HOME: dir }, encoding: 'utf8' });
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

test('a launcher named in the configuration is a script of launch/; every launcher there parses', () => {
    for (const t of loadTools()) if (t.launch) assert.ok(existsSync(join(LAUNCH, t.launch)), `${t.id}: ${t.launch} is in launch/`);
    for (const f of readdirSync(LAUNCH)) {
        if (f.endsWith('.sh')) assert.equal(spawnSync('sh', ['-n', join(LAUNCH, f)]).status, 0, f);
        if (f.endsWith('.mjs')) assert.equal(spawnSync(process.execPath, ['--check', join(LAUNCH, f)]).status, 0, f);
    }
    const one = (launch) => readTools(JSON.stringify([{ id: 'x', label: 'X', command: ['x'], memoryMb: 768, install: [], launch }]));
    for (const bad of ['../x.sh', '/tools/x.sh', 'x', 'x.sh;id', 'X.sh', '']) assert.throws(() => one(bad), /launch/, bad);
    assert.equal(one('x.sh')[0].launch, 'x.sh');
});
