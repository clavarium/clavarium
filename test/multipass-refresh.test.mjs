/* Multipass updated in Clavarium's own window: its machines put to sleep first, those that ran started again. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multipassTurn, isHeld, hasRefresh, runningMachines } from '../deploy/multipass-refresh.mjs';

const INFO = (installed, offered) => `name: multipass\ntracking:     latest/stable\nchannels:\n  latest/stable:    1.17.2   2026-11-18 (${offered}) 105MB -\n  latest/candidate: 1.18.0   2026-11-20 (99999) 105MB -\ninstalled:          1.17.0   (${installed}) 110MB -\n`;
const LIST = (notes) => `Name  Version Rev Tracking Publisher Notes\nmultipass  1.17.0  19760  latest/stable  canonical**  ${notes}\n`;
const MACHINES = JSON.stringify({ list: [{ name: 'clv-a', state: 'Running' }, { name: 'clv-b', state: 'Suspended' }, { name: 'clv-c', state: 'Running' }, { name: 'other', state: 'Running' }] });

function bench({ held = true, installed = 19760, offered = 20750, fail = () => false, mode = 'asap', inWindow = true, why = '', saved = {} } = {}) {
    const calls = []; let data = { ...saved };
    const run = async (argv) => {
        const c = argv.join(' ').replace('/snap/bin/multipass', 'mp'); calls.push(c);
        if (fail(c)) return { code: 1, stdout: '', stderr: 'it failed' };
        if (c === 'snap list multipass') return { code: 0, stdout: LIST(held ? 'held' : '-') };
        if (c === 'snap info multipass') return { code: 0, stdout: INFO(installed, offered) };
        if (c === 'mp list --format json') return { code: 0, stdout: MACHINES };
        return { code: 0, stdout: '' };
    };
    const go = () => multipassTurn({ mark: (on) => calls.push(`mark ${on}`), run, mode, inWindow, busy: async () => why, state: () => data, save: (x) => { data = { ...data, ...x }; }, sleep: async () => {}, now: () => Date.parse('2026-11-23T03:00:00Z') });
    return { calls, go, data: () => data };
}

test('what is read: held, a newer revision on the channel it follows, the machines of this Clavarium that run', () => {
    assert.equal(isHeld(LIST('held')), true); assert.equal(isHeld(LIST('-')), false);
    assert.equal(hasRefresh(INFO(19760, 20750)), true);
    assert.equal(hasRefresh(INFO(20750, 20750)), false, 'the candidate channel is not the one it follows');
    assert.equal(hasRefresh('nonsense'), false);
    assert.deepEqual(runningMachines(MACHINES), ['clv-a', 'clv-c']);
    assert.equal(runningMachines('nope'), null);
});

test('in the window: those that run put to sleep, updated, those started again; one asleep stays asleep', async () => {
    const b = bench();
    assert.equal(await b.go(), 'updated');
    const at = (c) => b.calls.indexOf(c);
    assert.ok(at('mp suspend clv-a') < at('snap refresh multipass --ignore-running') && at('mp suspend clv-c') < at('snap refresh multipass --ignore-running'));
    assert.ok(at('snap refresh multipass --ignore-running') < at('mp start clv-a') && at('snap refresh multipass --ignore-running') < at('mp start clv-c'));
    assert.ok(!b.calls.some((c) => c.includes('clv-b') || c.includes(' other')));
    assert.deepEqual(b.data().multipassRefresh.machines, []);
});

test('outside the window, while something is built, or up to date: nothing stops', async () => {
    for (const o of [{ inWindow: false }, { why: 'a build runs' }, { installed: 20750 }]) {
        const b = bench(o); await b.go();
        assert.ok(!b.calls.some((c) => c.includes('suspend') || c === 'snap refresh multipass --ignore-running'), JSON.stringify(o));
    }
});

test('held when it updates by itself; given back to snap when it does not, and never updated here', async () => {
    const own = bench({ held: false, inWindow: false }); await own.go();
    assert.ok(own.calls.includes('snap refresh --hold multipass'));
    const ask = bench({ held: true, mode: 'ask' }); await ask.go();
    assert.ok(ask.calls.includes('snap refresh --unhold multipass'));
    assert.ok(!ask.calls.some((c) => c.includes('suspend') || c === 'snap refresh multipass --ignore-running'));
});

test('a machine that will not sleep: not updated, those stopped started again', async () => {
    const b = bench({ fail: (c) => c === 'mp suspend clv-c' });
    assert.equal(await b.go(), 'not updated');
    assert.ok(!b.calls.includes('snap refresh multipass --ignore-running'));
    assert.ok(b.calls.includes('mp start clv-a'));
});

test('its update fails: its machines are started again all the same', async () => {
    const b = bench({ fail: (c) => c === 'snap refresh multipass --ignore-running' });
    assert.equal(await b.go(), 'update failed');
    assert.ok(b.calls.includes('mp start clv-a') && b.calls.includes('mp start clv-c'));
});

test('a turn cut in the middle: the next one starts its machines first, even outside the window, and does not try again the same day', async () => {
    const b = bench({ inWindow: false, saved: { multipassRefresh: { triedAt: '2026-11-23T02:50:00Z', machines: ['clv-a'] } } });
    await b.go();
    assert.ok(b.calls.includes('mp start clv-a'));
    assert.deepEqual(b.data().multipassRefresh.machines, []);
    const again = bench({ saved: { multipassRefresh: { triedAt: '2026-11-23T02:50:00Z', machines: [] } } });
    assert.equal(await again.go(), 'tried lately');
});

test('one that cannot be started stays written down for the next turn', async () => {
    const b = bench({ fail: (c) => c === 'mp start clv-c' });
    await b.go();
    assert.deepEqual(b.data().multipassRefresh.machines, ['clv-c']);
});

test('the server is told before the first machine sleeps and after the last is back, even when it fails', async () => {
    for (const fail of [() => false, (c) => c === 'mp suspend clv-c', (c) => c.startsWith('snap refresh multipass --')]) {
        const b = bench({ fail }); await b.go();
        assert.ok(b.calls.indexOf('mark true') < b.calls.indexOf('mp suspend clv-a'));
        assert.equal(b.calls.at(-1), 'mark false');
    }
    const quiet = bench({ installed: 20750 }); await quiet.go();
    assert.ok(!quiet.calls.includes('mark true'), 'nothing to update: nothing said');
});

/* 25-11, on a real server: four machines started, then its daemon died and stayed mute for three hours. */
test('mute after its update: its daemon restarted, then stopped and started for sure -- each said; its previous version never put back by itself', async () => {
    for (const fixedBy of ['snap restart multipass.multipassd', 'UNSTICK']) {
        let mute = false;
        const b = bench({ fail: (c) => {
            if (c === 'snap refresh multipass --ignore-running') { mute = true; return false; }
            if (c === fixedBy || (fixedBy === 'UNSTICK' && /multipass-unstick\.sh$/.test(c))) { mute = false; return false; }
            return mute && (c === 'mp list --format json' || c.startsWith('mp start'));
        } });
        assert.equal(await b.go(), 'updated');
        const at = (c) => b.calls.indexOf(c);
        assert.ok(at('snap restart multipass.multipassd') > at('snap refresh multipass --ignore-running'));
        if (fixedBy === 'UNSTICK') {
            assert.ok(b.calls.findIndex((c) => /^bash .*multipass-unstick\.sh$/.test(c)) > at('snap restart multipass.multipassd'), 'stopped and started for sure, its old dnsmasq ended');
        } else assert.ok(!b.calls.some((c) => c.includes('multipass-unstick')), 'nothing more once it answers');
        assert.ok(at('mp start clv-a') > (fixedBy === 'UNSTICK' ? b.calls.findIndex((c) => c.includes('multipass-unstick')) : at(fixedBy)));
        assert.ok(!b.calls.some((c) => c.startsWith('snap revert')), 'never its previous version');
        assert.deepEqual(b.data().multipassRefresh.machines, []);
    }
});


test('dead in the middle of the starts (cannot connect to its socket): rescued, that machine tried once more', async () => {
    let dead = false; let died = false;
    const b = bench({ fail: (c) => {
        if (c === 'mp start clv-c' && !died) { dead = true; died = true; return true; }
        if (c === 'snap restart multipass.multipassd') { dead = false; return false; }
        return dead && (c === 'mp list --format json' || c.startsWith('mp start'));
    } });
    await b.go();
    assert.ok(b.calls.includes('snap restart multipass.multipassd'));
    assert.deepEqual(b.data().multipassRefresh.machines, [], 'clv-c started at the second try');
});
