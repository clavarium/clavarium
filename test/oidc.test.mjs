/* The sign-in client id: random by default, settable, and migrated off the
   old literal "clavarium" -- with dex and the proxy always left agreeing. The
   files are written on a real machine; here the two config texts are built as
   install.sh writes them, in a temp dir, and the root-only steps (chown,
   restart) are a recorded fake. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    LEGACY_ID, LEGACY_NAME, VALID_ID, randomClientId,
    dexClientId, dexClientName, proxyClientId, withDexClient, withProxyClient,
    applyClientId, ensureGenericClientId, setClientId,
} from '../deploy/oidc.mjs';

const dexText = (id = LEGACY_ID, name = LEGACY_NAME) => `# Who may sign in to Clavarium on THIS machine. Written by install.sh.
issuer: https://clav.example.com/dex
storage:
  type: sqlite3
  config:
    file: /var/lib/dex/dex.db
web:
  http: 127.0.0.1:5556
oauth2:
  skipApprovalScreen: true
staticClients:
  - id: ${id}
    name: ${name}
    secret: deadbeef
    redirectURIs:
      - https://clav.example.com/oauth2/callback
enablePasswordDB: true
staticPasswords:
  - email: "owner@example.com"
    hash: "$2a$14$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    username: "owner"
    userID: "11111111-1111-1111-1111-111111111111"
`;
const proxyText = (id = LEGACY_ID) => `provider = "oidc"
client_id = "${id}"
client_secret = "deadbeef"
cookie_secret = "cookiecookiecookiecookiecookieAB"
oidc_issuer_url = "https://clav.example.com/dex"
email_domains = ["*"]
`;

/* A pair of config files in a temp dir, plus a fake `run` that records argv. */
function sandbox(t, { dex = dexText(), proxy = proxyText() } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-oidc-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dexConf = join(dir, 'config.yaml');
    const proxyCfg = join(dir, 'oauth2-proxy.cfg');
    if (dex !== null) writeFileSync(dexConf, dex);
    if (proxy !== null) writeFileSync(proxyCfg, proxy);
    const ran = [];
    const run = (argv) => { ran.push(argv.join(' ')); return Promise.resolve({ code: 0 }); };
    return { dir, dexConf, proxyCfg, ran, run, readDex: () => readFileSync(dexConf, 'utf8'), readProxy: () => readFileSync(proxyCfg, 'utf8') };
}

test('a random id is 32 hex characters, unique, and a valid id', () => {
    const a = randomClientId(); const b = randomClientId();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    assert.ok(VALID_ID.test(a));
    assert.notEqual(a, LEGACY_ID);
});

test('a chosen id is checked: plain names pass; spaces, colons and quotes do not', () => {
    for (const ok of ['acme', 'acme-crm', 'acme.crm', 'Portal_2', 'a'.repeat(64)]) assert.ok(VALID_ID.test(ok), ok);
    for (const bad of ['', 'a b', 'a:b', 'a"b', 'a\nb', '-lead', 'trail-', 'a'.repeat(65), 'x/y']) assert.ok(!VALID_ID.test(bad), bad);
});

test('the id and name are read from each config, and rewritten without disturbing the rest', () => {
    const dex = dexText(); const proxy = proxyText();
    assert.equal(dexClientId(dex), 'clavarium');
    assert.equal(dexClientName(dex), 'Clavarium');
    assert.equal(proxyClientId(proxy), 'clavarium');
    const dex2 = withDexClient(dex, 'abc123', 'abc123');
    assert.equal(dexClientId(dex2), 'abc123');
    assert.equal(dexClientName(dex2), 'abc123');
    assert.ok(dex2.includes('secret: deadbeef') && dex2.includes('userID: "11111111'), 'the rest is untouched');
    assert.ok(!dex2.includes('name: Clavarium'), 'the client no longer names the product');
    const proxy2 = withProxyClient(proxy, 'abc123');
    assert.equal(proxyClientId(proxy2), 'abc123');
    assert.ok(proxy2.includes('client_secret = "deadbeef"'), 'the secret is left alone');
});

test('applyClientId writes BOTH files to one id and, as root, restarts dex then the proxy', async (t) => {
    const s = sandbox(t);
    const r = await applyClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, id: 'abc123', run: s.run, isRoot: true });
    assert.deepEqual(r.changed, ['dex', 'oauth2-proxy']);
    assert.equal(dexClientId(s.readDex()), 'abc123');
    assert.equal(dexClientName(s.readDex()), 'abc123');
    assert.equal(proxyClientId(s.readProxy()), 'abc123');
    assert.deepEqual(s.ran, ['chown root:dex ' + s.dexConf + '.new', 'systemctl restart dex.service', 'systemctl restart oauth2-proxy.service'], 'dex is restarted before the proxy that talks to it');
    /* Called again with the same id: nothing to do, nothing restarted. */
    const again = await applyClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, id: 'abc123', run: s.run, isRoot: true });
    assert.deepEqual(again.changed, []);
});

test('without root it still writes the files, but does not chown or restart', async (t) => {
    const s = sandbox(t);
    const r = await applyClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, id: 'abc123', run: s.run, isRoot: false });
    assert.deepEqual(r.changed, ['dex', 'oauth2-proxy']);
    assert.equal(proxyClientId(s.readProxy()), 'abc123');
    assert.deepEqual(s.ran, []);
});

test('ensureGenericClientId migrates a legacy install once to a random id, then does nothing', async (t) => {
    const s = sandbox(t);
    const r = await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.deepEqual(r.changed, ['dex', 'oauth2-proxy']);
    assert.match(r.id, /^[0-9a-f]{32}$/);
    assert.equal(dexClientId(s.readDex()), r.id);
    assert.equal(dexClientName(s.readDex()), r.id);
    assert.equal(proxyClientId(s.readProxy()), r.id, 'dex and the proxy agree');
    assert.notEqual(dexClientId(s.readDex()), LEGACY_ID);
    assert.notEqual(dexClientName(s.readDex()), LEGACY_NAME, 'the client no longer names the product');
    const again = await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.deepEqual(again.changed, [], 'idempotent: the migrated id is kept');
});

test('a migration cut off half-way is converged on the next turn, without a new id', async (t) => {
    /* dex already migrated to a good id, the proxy still on the old one. */
    const s = sandbox(t, { dex: dexText('kept9999kept9999kept9999kept9999', 'kept9999kept9999kept9999kept9999'), proxy: proxyText(LEGACY_ID) });
    const r = await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.deepEqual(r.changed, ['oauth2-proxy'], 'only the proxy is brought into line');
    assert.equal(r.id, 'kept9999kept9999kept9999kept9999', 'the id dex already had is kept');
    assert.equal(proxyClientId(s.readProxy()), 'kept9999kept9999kept9999kept9999');
});

test('the other half-way case (dex still legacy, proxy already changed) regenerates both', async (t) => {
    const s = sandbox(t, { dex: dexText(LEGACY_ID), proxy: proxyText('orphan00orphan00orphan00orphan00') });
    const r = await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.deepEqual(r.changed, ['dex', 'oauth2-proxy']);
    assert.match(r.id, /^[0-9a-f]{32}$/);
    assert.notEqual(r.id, 'orphan00orphan00orphan00orphan00');
    assert.equal(dexClientId(s.readDex()), r.id);
    assert.equal(proxyClientId(s.readProxy()), r.id);
});

test('an operator-chosen id is left alone by the migration', async (t) => {
    const s = sandbox(t, { dex: dexText('acme-crm', 'acme-crm'), proxy: proxyText('acme-crm') });
    const r = await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.deepEqual(r.changed, []);
    assert.equal(dexClientId(s.readDex()), 'acme-crm');
});

test('on a machine with no sign-in (no files) nothing is done', async (t) => {
    const s = sandbox(t, { dex: null, proxy: null });
    assert.deepEqual((await ensureGenericClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true })).changed, []);
    assert.deepEqual((await applyClientId({ dexConf: s.dexConf, proxyCfg: s.proxyCfg, id: 'x', run: s.run, isRoot: true })).changed, []);
});

test('setClientId sets a chosen id, refuses a bad one, and makes a random one on request', async (t) => {
    const s = sandbox(t);
    await setClientId({ value: 'acme-crm', dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.equal(dexClientId(s.readDex()), 'acme-crm');
    assert.equal(proxyClientId(s.readProxy()), 'acme-crm');
    await assert.rejects(setClientId({ value: 'bad id', dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true }), /letters, digits/);
    const r = await setClientId({ value: '--random', dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true });
    assert.match(r.id, /^[0-9a-f]{32}$/);
    assert.equal(dexClientId(s.readDex()), r.id);
});

test('setClientId on a machine with no sign-in refuses', async (t) => {
    const s = sandbox(t, { dex: null, proxy: null });
    await assert.rejects(setClientId({ value: 'acme', dexConf: s.dexConf, proxyCfg: s.proxyCfg, run: s.run, isRoot: true }), /local mode/);
});
