import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTools, loadTools, NODE_STEPS, NODE_SHA256 } from '../server/tools.mjs';

test('the shipped catalogue loads, and no step of it is a shell line', () => {
    const tools = loadTools();
    assert.ok(tools.length >= 2);
    for (const t of tools) {
        for (const step of t.steps) {
            assert.ok(!step.argv.includes('-c') || step.argv[0] === 'sha256sum', `${t.id}: ${step.argv.join(' ')}`);
            assert.ok(!step.argv.some((a) => /[|;&`$]/.test(a) && !a.startsWith('https://')), `${t.id}: a step looks like shell`);
        }
    }
});

test('the runtime is checked BEFORE it is unpacked, with a checksum that comes from here', () => {
    /* The program of each step: the first word, or the one after `sudo -n`. */
    const program = (argv) => (argv[0] === 'sudo' ? argv[2] : argv[0]);
    const order = NODE_STEPS.map((s) => program(s.argv)).filter((p) => ['curl', 'sha256sum', 'tar'].includes(p));
    assert.deepEqual(order, ['curl', 'sha256sum', 'tar'], 'download, then check, then unpack');
    const check = NODE_STEPS.find((s) => s.argv[0] === 'sha256sum');
    assert.ok(check.input.startsWith(NODE_SHA256));
    const download = NODE_STEPS.find((s) => s.argv[0] === 'curl');
    assert.ok(download.argv.includes('=https'), 'never anything but HTTPS');
});

test('a malformed catalogue is refused with the name of what is wrong', () => {
    const one = (extra) => JSON.stringify([{ id: 'x', label: 'X', command: ['x'], memoryMb: 1024, install: [], ...extra }]);
    assert.equal(readTools(one({}))[0].id, 'x');
    assert.throws(() => readTools(one({ command: 'x --flag' })), /argument vector/);
    assert.throws(() => readTools(one({ command: ['x', ';', 'y'] })), /argument vector/);
    assert.throws(() => readTools(one({ install: ['curl https://example.com | sh'] })), /install step/);
    assert.throws(() => readTools(one({ memoryMb: 64 })), /memoryMb/);
    assert.throws(() => readTools(one({ id: 'Bad Id' })), /tool id/);
    assert.throws(() => readTools('[]'), /empty/);
});

test('Claude Code is set to take its colours from the terminal, so that the page decides light or dark; and may run parley without asking', () => {
    const steps = loadTools().find((t) => t.id === 'claude-code').steps;
    const settings = steps.find((s) => s.argv.at(-1) === '.claude/settings.json');
    assert.ok(settings, 'a step writes its settings');
    /* parley only writes in its own folder: asking each time would stop the chat on a question only the terminal shows. */
    assert.deepEqual(JSON.parse(settings.input), { theme: 'dark-ansi', permissions: { allow: ['Bash(parley:*)'] } });
    /* After the tool itself: its own install must not overwrite it. */
    assert.ok(steps.indexOf(settings) > steps.findIndex((s) => s.argv.includes('@anthropic-ai/claude-code')));
});

test('a step with input is a small file handed over apart, and nothing else', () => {
    const base = { id: 'x', label: 'X', command: ['x'], memoryMb: 1024 };
    const ok = readTools(JSON.stringify([{ ...base, install: [{ argv: ['install', '/dev/stdin', 'f'], input: 'a' }] }]));
    assert.deepEqual(ok[0].steps, [{ argv: ['install', '/dev/stdin', 'f'], input: 'a' }]);
    for (const bad of [{ argv: 'install f', input: 'a' }, { argv: ['install'] }, { argv: ['install'], input: 7 }, { argv: ['install'], input: 'x'.repeat(5000) }]) {
        assert.throws(() => readTools(JSON.stringify([{ ...base, install: [bad] }])));
    }
});

test('every tool but the shell is started with every right in its own machine, by the flag its own --help names; Claude Code also skips the one-time warning, and may run parley in either choice', () => {
    const rights = Object.fromEntries(loadTools().map((t) => [t.id, t.rights]));
    /* Checked against each tool's --help and source (P4): the flag that removes every approval. */
    assert.deepEqual(rights.codex.full, ['--dangerously-bypass-approvals-and-sandbox']);
    /* --yolo alone is turned back to "default" in a folder Gemini does not trust: --skip-trust trusts it for the session. */
    assert.deepEqual(rights.gemini.full, ['--yolo', '--skip-trust']);
    assert.deepEqual(rights.opencode.full, ['--auto']);
    const claude = rights['claude-code'];
    assert.equal(claude.full[0], '--dangerously-skip-permissions');
    /* Given on the command line, not written in its settings file: the owner's file is never rewritten. */
    assert.equal(claude.full[1], '--settings');
    assert.deepEqual(JSON.parse(claude.full[2]), { skipDangerousModePermissionPrompt: true, permissions: { allow: ['Bash(parley:*)'] } });
    assert.deepEqual(claude.ask[0], '--settings');
    assert.deepEqual(JSON.parse(claude.ask[1]), { permissions: { allow: ['Bash(parley:*)'] } });
    for (const id of ['codex', 'gemini', 'opencode']) assert.deepEqual(rights[id].ask, [], `${id}: asks as it does by itself`);
    assert.equal(rights.shell, undefined);
});
