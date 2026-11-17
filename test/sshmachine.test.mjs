/* A MACHINE OVER SSH MADE FROM THE PAGE (server/sshmachine.mjs, 17-11): opened with a key made here -- the same
   keys as the git repositories, one list --, its host key read and pinned before it is made. The private half
   reaches Tether's connector only, by name; "used by" names the machine and a key in use is not removed.
   No network: the probe and the connector are stand-ins. example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { addMachine, machinesUsing, probeHostKey, fingerprint } from '../server/sshmachine.mjs';
import { GitAccess } from '../server/gitaccess.mjs';
import { Vault } from '../server/vault.mjs';
import { Tethers } from '../server/tethers.mjs';

const PRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const OWNER = { id: 'person:owner', name: 'Owner' };

function world(t, { probe = async () => PRINT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-sshm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const access = new GitAccess({ vault: new Vault(join(dir, 'vault.key')), dataDir: dir });
    const seen = [];
    const ssh = { run: async (verb, target, a, ctx) => { seen.push({ verb, target: target.id, key: await ctx.secret('key'), pin: target.config.pin }); return { text: 'ok' }; } };
    const tethers = new Tethers({ dataDir: dir, resources: { workFolder: () => dir }, conversations: () => [], secrets: { reveal: () => null }, connectors: { ssh } });
    tethers.sshKeys = access;
    access.machinesUsing(machinesUsing(tethers));
    return { access, tethers, seen, add: (body) => addMachine({ tethers, keys: access, probe }, body) };
}

test('a machine is made with a key made here: its host key pinned, the key named, never written in the target', async (t) => {
    const w = world(t);
    w.access.makeKey({ name: 'home' });
    const made = await w.add({ title: 'Serveur maison', host: 'server.example.com', user: 'admin', key: 'home' });
    assert.deepEqual(made, { id: 'serveur-maison', title: 'Serveur maison', pin: PRINT });
    const target = w.tethers.store().target('serveur-maison');
    assert.equal(target.kind, 'ssh');
    assert.deepEqual(target.config, { host: 'server.example.com', port: 22, user: 'admin', pin: PRINT });
    assert.deepEqual(target.secrets, { key: 'sshkey:home' });
    assert.doesNotMatch(JSON.stringify(target), /PRIVATE KEY/);
    /* A second one of the same name gets its own id. */
    const again = await w.add({ title: 'Serveur maison', host: 'other.example.com', port: '2222', user: 'admin', key: 'home' });
    assert.equal(again.id, 'serveur-maison-2');
    assert.equal(w.tethers.store().target('serveur-maison-2').config.port, 2222);
});

test('the connector gets the private half by name, from the keys made here; nothing else does', async (t) => {
    const w = world(t);
    w.access.makeKey({ name: 'home' });
    const made = await w.add({ title: 'Box', host: 'server.example.com', user: 'admin', key: 'home' });
    const r = await w.tethers.read('files.list', { target: made.id, path: '/' }, OWNER);
    assert.equal(w.seen.length, 1, JSON.stringify(r));
    assert.match(w.seen[0].key, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
    assert.equal(w.seen[0].pin, PRINT);
    assert.doesNotMatch(JSON.stringify(w.access.keys()), /PRIVATE KEY/, 'the page sees the public half only');
});

test('"used by" names the machine; a key in use is not removed; removed with the machine, it can go', async (t) => {
    const w = world(t);
    w.access.makeKey({ name: 'home' });
    const made = await w.add({ title: 'Box', host: 'server.example.com', user: 'admin', key: 'home' });
    assert.deepEqual(w.access.keys()[0].usedBy, ['Box']);
    assert.throws(() => w.access.removeKey('home'), (e) => e.status === 409 && /Box/.test(e.message));
    w.tethers.store().removeTarget(made.id);
    assert.deepEqual(w.access.keys()[0].usedBy, []);
    w.access.removeKey('home');
    assert.deepEqual(w.access.keys(), []);
});

test('refused before anything is made: odd fields, a key not made here, a machine not reached, a fingerprint that differs', async (t) => {
    const w = world(t);
    w.access.makeKey({ name: 'home' });
    const base = { title: 'Box', host: 'server.example.com', user: 'admin', key: 'home' };
    for (const bad of [{ title: '' }, { host: 'server.example.com/path' }, { host: 'server.example.com:22' }, { host: '-oProxyCommand=x' }, { port: '0' }, { port: '70000' }, { user: 'a b' }, { user: '-l' }, { key: 'none' }, { key: '' }]) {
        await assert.rejects(w.add({ ...base, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
    }
    const down = world(t, { probe: async () => { throw new Error('connect ECONNREFUSED'); } });
    down.access.makeKey({ name: 'home' });
    await assert.rejects(down.add(base), (e) => e.status === 502 && /could not be reached/.test(e.message));
    await assert.rejects(w.add({ ...base, pin: 'SHA256:somethingelse' }), (e) => e.status === 409);
    assert.equal(w.tethers.store().targets().filter((x) => x.kind === 'ssh').length, 0);
    /* The same fingerprint given (its padding aside) is accepted. */
    assert.equal((await w.add({ ...base, pin: `${PRINT}=` })).pin, PRINT);
});

test('the probe reads the host key without logging in, and refuses it so that nothing goes further', async () => {
    const hostKey = Buffer.from('a host key');
    let asked = null; let accepted = null;
    class Client extends EventEmitter {
        connect(config) { asked = config; setImmediate(() => { accepted = config.hostVerifier(hostKey); this.emit('error', new Error('host key refused')); }); }
        end() {}
    }
    assert.equal(await probeHostKey('server.example.com', 2222, { Client }), fingerprint(hostKey));
    assert.equal(accepted, false);
    assert.equal(asked.port, 2222);
    assert.equal(asked.privateKey, undefined);
    assert.equal(asked.password, undefined);
    class Silent extends EventEmitter { connect() {} end() {} }
    await assert.rejects(probeHostKey('server.example.com', 22, { Client: Silent, ms: 30 }), /no answer/);
});
