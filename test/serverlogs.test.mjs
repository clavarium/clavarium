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
    assert.deepEqual(asked, ['server logs machines 24', 'server restart']);
});
