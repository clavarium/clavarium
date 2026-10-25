/* The remote screen (MeshCentral), from Settings (server/meshcentral.mjs), with a stand-in for
   the host program: status parsing, turning on (install then start) and off, errors surfaced. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshCentral, readStatus } from '../server/meshcentral.mjs';

const RUNNING = 'installed yes\nrunning yes\nversion 1.1.35\nurl https://clav.example.com/meshcentral/\njunk line\nversion bad!!\n';
const OFF = 'installed yes\nrunning no\nversion 1.1.35\nurl /meshcentral/\nstep idle\n';
const INSTALLING = 'installed no\nrunning no\nversion none\nurl /meshcentral/\nstep installing\n';

function bench({ answers = {} } = {}) {
    const asked = [];
    const host = async (argv, options = {}) => {
        asked.push({ argv, options });
        const key = argv.slice(0, 2).join(' ');
        if (answers[key]) return answers[key](argv, options);
        if (key === 'meshcentral status') return { code: 0, stdout: OFF, stderr: '' };
        if (key === 'meshcentral enable') return { code: 0, stdout: 'enabling\n', stderr: '' };
        if (key === 'meshcentral disable') return { code: 0, stdout: 'disabled\n', stderr: '' };
        return { code: 64, stdout: '', stderr: 'usage' };
    };
    return { host, asked };
}

test('status reads only the lines of the expected shapes', () => {
    assert.deepEqual(readStatus(RUNNING), {
        installed: true, running: true, version: '1.1.35', url: 'https://clav.example.com/meshcentral/', step: null, why: null, on: true,
    });
    /* A version of an unexpected shape, and an unknown step, are left out. */
    assert.deepEqual(readStatus('installed yes\nrunning no\nversion !!!\nstep nonsense\nwhy BAD\n'), {
        installed: true, running: false, version: null, url: null, step: null, why: null, on: false,
    });
    assert.deepEqual(readStatus(''), { installed: false, running: false, version: null, url: null, step: null, why: null, on: false });
    assert.equal(readStatus(INSTALLING).step, 'installing');
    assert.equal(readStatus('installed yes\nrunning no\nstep failed\nwhy install\n').why, 'install');
});

test('status: not readable when the host refuses or fails, without throwing', async () => {
    const m = new MeshCentral({ host: async () => ({ code: 78, stdout: '', stderr: 'REFUSED: unknown verb: meshcentral status' }) });
    const s = await m.status();
    assert.equal(s.installed, false); assert.equal(s.running, false);
    assert.match(s.said, /unknown verb/);
});

test('enable asks the host to turn it on and returns at once', async () => {
    const { host, asked } = bench();
    const m = new MeshCentral({ host, watchEveryMs: 60_000 });
    assert.deepEqual(await m.enable(), { started: true });
    assert.deepEqual(asked.at(-1).argv, ['meshcentral', 'enable']);
});

test('enable: the turn-on watched, running said once with the url (install then start)', async () => {
    let step = 'installing';
    const seen = [];
    const { host } = bench({ answers: {
        'meshcentral status': () => ({ code: 0, stdout: `installed yes\nrunning ${step === 'running' ? 'yes' : 'no'}\nversion 1.1.35\nurl https://clav.example.com/meshcentral/\nstep ${step}\n`, stderr: '' }),
    } });
    const m = new MeshCentral({ host, said: (t) => seen.push(t), watchEveryMs: 5, watchForMs: 60_000 });
    await m.enable();
    /* It is still installing: nothing said yet. */
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, []);
    step = 'running';
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /Remote screen: on now at https:\/\/clav\.example\.com\/meshcentral\//);
});

test('enable: a failed turn-on is said once, with the reason', async () => {
    const seen = [];
    const { host } = bench({ answers: {
        'meshcentral status': () => ({ code: 0, stdout: 'installed no\nrunning no\nstep failed\nwhy install\n', stderr: '' }),
    } });
    const m = new MeshCentral({ host, said: (t) => seen.push(t), watchEveryMs: 5, watchForMs: 60_000 });
    await m.enable();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 1);
    assert.match(seen[0], /did not turn on \(could not install\)/);
});

test('disable asks the host to turn it off', async () => {
    const { host, asked } = bench();
    const m = new MeshCentral({ host });
    assert.deepEqual(await m.disable(), { disabled: true });
    assert.deepEqual(asked.at(-1).argv, ['meshcentral', 'disable']);
});

test('errors are surfaced: a host refusal becomes a 409, another failure a 502', async () => {
    const refusing = new MeshCentral({ host: async () => ({ code: 78, stdout: '', stderr: 'REFUSED: the remote screen is being turned on already: wait for its end' }) });
    await assert.rejects(refusing.enable(), (e) => e.status === 409 && /being turned on already/.test(e.message));
    const broken = new MeshCentral({ host: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    await assert.rejects(broken.disable(), (e) => e.status === 502);
});
