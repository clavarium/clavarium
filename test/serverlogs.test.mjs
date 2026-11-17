/* Settings, This server, Logs: read through the host program, secrets masked (server/serverlogs.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerLogs, mask } from '../server/serverlogs.mjs';

test('what looks like a secret is masked; the rest is kept as it is', () => {
    const line = 'login ok password=hunter2hunter2 token: abc Bearer eyJhbGciOiJIUzI1NiJ9xxxxxxxxxxxxxxxxxxxxxxxxxxxxx key ghp_0123456789abcdefghijABCDEFGHIJ012345 machine clv-demo started';
    const out = mask(line);
    assert.doesNotMatch(out, /hunter2|ghp_|eyJ/);
    assert.match(out, /password=\[masked\]/);
    assert.match(out, /machine clv-demo started/);
    assert.equal(mask('2026-10-21T03:22:01+0000 host clavarium[812]: vm manager: it does not answer'), '2026-10-21T03:22:01+0000 host clavarium[812]: vm manager: it does not answer');
});

test('one source over one span, through the host program; anything else refused', async () => {
    const asked = [];
    const logs = new ServerLogs({ host: async (argv) => { asked.push(argv.join(' ')); return argv[1] === 'logs' ? { code: 0, stdout: 'a\nb secret=xyz\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }; } });
    const r = await logs.read('machines', '24');
    assert.deepEqual(r, { source: 'machines', span: '24', text: 'a\nb secret=[masked]\n', lines: 2, cut: false });
    await assert.rejects(logs.read('../etc', '1'), /Not a source/);
    await assert.rejects(logs.read('system', '2'), /Not a span/);
    assert.equal((await logs.read('clavarium', '10m')).span, '10m', 'the last 10 minutes: the shortest, the default');
    assert.deepEqual(await logs.restart(), { restarting: true });
    assert.deepEqual(await logs.reboot(), { rebooting: true });
    assert.deepEqual(asked, ['server logs machines 24', 'server logs clavarium 10m', 'server restart', 'server reboot']);
});

test('a long read is answered "still reading", and the same read is given when asked again', async () => {
    let release;
    const logs = new ServerLogs({ host: () => new Promise((ok) => { release = () => ok({ code: 0, stdout: 'one\n', stderr: '' }); }) });
    assert.deepEqual(await logs.start('clavarium', '10m', 20), { pending: true, source: 'clavarium', span: '10m' });
    assert.deepEqual(await logs.start('clavarium', '10m', 20), { pending: true, source: 'clavarium', span: '10m' }, 'not read twice');
    release();
    const r = await logs.start('clavarium', '10m', 20);
    assert.equal(r.text, 'one\n');
});

test('a slow or failing journal: what was read is shown with its note; a failure says its reason, never a bare exit (17-11)', async () => {
    const said = (r) => new ServerLogs({ host: async () => r });
    const sudo = '2026-11-17T10:00:01+0000 host sudo[9001]: clavarium : PWD=/ ; USER=root ; COMMAND=/usr/local/sbin/clavarium-host vm states';
    const pam = '2026-11-17T10:00:01+0000 host sudo[9001]: pam_unix(sudo:session): session opened for user root(uid=0) by (uid=999)';
    const got = await said({ code: 0, stdout: `one\n${sudo}\n${pam}\ntwo\n`, stderr: 'NOTE: the journal took more than 60s: what it said by then\n' }).read('clavarium', '1');
    assert.equal(got.text, 'one\ntwo\n', 'sudo and PAM lines left out, from an older host program too');
    assert.equal(got.lines, 2);
    assert.equal(got.note, 'the journal took more than 60s: what it said by then');
    assert.equal('note' in await said({ code: 0, stdout: 'a\n', stderr: '' }).read('clavarium', '1'), false);
    await assert.rejects(said({ code: 1, stdout: '', stderr: '', timedOut: true }).read('clavarium', '1'), /could not be read: no answer in 120 s/);
    await assert.rejects(said({ code: 1, stdout: '', stderr: '', tooLong: true }).read('clavarium', '1'), /more than 8 MB/);
    await assert.rejects(said({ code: 1, stdout: '', stderr: 'sudo: a password is required\n' }).read('clavarium', '1'), /could not be read: sudo: a password is required$/);
    await assert.rejects(said({ code: 1, stdout: '', stderr: '' }).read('clavarium', '1'), /could not be read: exit 1$/);
});

test('the load is what it is given (the host tally), read-only', () => {
    const windows = { everyMs: 300_000, windows: [{ from: 1, to: 2, commands: 3, ms: 4, kinds: [], open: true }] };
    assert.deepEqual(new ServerLogs({ host: async () => ({ code: 0 }), load: () => windows }).load(), windows);
    assert.deepEqual(new ServerLogs({ host: async () => ({ code: 0 }) }).load(), { everyMs: 0, windows: [] });
});
