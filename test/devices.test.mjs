import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Devices, readCookie, sessionCookie, SESSION_COOKIE } from '../server/devices.mjs';
import { Store } from '../server/store.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-dev-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let now = Date.parse('2030-01-01T00:00:00Z');
    const devices = new Devices(new Store(join(dir, 'devices.json')), () => now);
    return { devices, later: (ms) => { now += ms; }, path: join(dir, 'devices.json') };
}
/* What the pairing page does with WebCrypto, done here with the same curve. */
function phone() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { jwk, sign: (nonce) => sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
}
function paired(b, conversation = 'family') {
    const p = phone();
    const { device } = b.devices.pair({ code: b.devices.share(conversation).code, key: p.jwk, label: 'Phone' });
    const openSession = () => b.devices.open(device, p.sign(b.devices.challenge(device).nonce)).session;
    return { p, device, openSession };
}

test('a scanned code binds a device to ONE conversation; its session opens that one and no other', (t) => {
    const b = bench(t);
    const one = paired(b, 'family');
    const session = one.openSession();
    assert.equal(b.devices.conversationOf(session), 'family');
    assert.deepEqual(b.devices.of('family').map((d) => d.label), ['Phone']);
    assert.deepEqual(b.devices.of('work'), []);
    assert.equal(b.devices.conversationOf('not-a-session'), undefined);
    assert.equal(b.devices.conversationOf(''), undefined);
});

test('a code works once, and only for ten minutes', (t) => {
    const b = bench(t);
    const { code } = b.devices.share('family');
    b.devices.pair({ code, key: phone().jwk });
    assert.throws(() => b.devices.pair({ code, key: phone().jwk }), /not valid any more/, 'second use');
    const late = b.devices.share('family').code;
    b.later(11 * 60_000);
    assert.throws(() => b.devices.pair({ code: late, key: phone().jwk }), /not valid any more/, 'expired');
    assert.throws(() => b.devices.pair({ code: 'guess', key: phone().jwk }), /not valid any more/);
    /* A bad key spends the code too: a code is never left to be tried again. */
    const spent = b.devices.share('family').code;
    assert.throws(() => b.devices.pair({ code: spent, key: { kty: 'RSA' } }), /not a device key/);
    assert.throws(() => b.devices.pair({ code: spent, key: phone().jwk }), /not valid any more/);
});

test('only the holder of the private key opens a session; a challenge is used once and soon', (t) => {
    const b = bench(t);
    const one = paired(b);
    const thief = phone();
    assert.throws(() => b.devices.open(one.device, thief.sign(b.devices.challenge(one.device).nonce)), /not paired/);
    const { nonce } = b.devices.challenge(one.device);
    const signature = one.p.sign(nonce);
    b.devices.open(one.device, signature);
    assert.throws(() => b.devices.open(one.device, signature), /not paired/, 'replayed');
    const slow = one.p.sign(b.devices.challenge(one.device).nonce);
    b.later(61_000);
    assert.throws(() => b.devices.open(one.device, slow), /not paired/, 'too late');
    /* An unknown device gets a challenge like any other, and nothing after. */
    assert.equal(typeof b.devices.challenge('00000000-0000-4000-8000-000000000000').nonce, 'string');
    assert.throws(() => b.devices.open('00000000-0000-4000-8000-000000000000', 'x'), /not paired/);
});

test('revoked, a device loses its sessions at once and cannot open another', (t) => {
    const b = bench(t);
    const one = paired(b);
    const session = one.openSession();
    b.devices.revoke(one.device);
    assert.equal(b.devices.conversationOf(session), undefined);
    assert.throws(() => one.openSession(), /not paired/);
    assert.throws(() => b.devices.revoke(one.device), /No such device/);
});

test('a session ends after twelve hours; the device, still paired, opens a new one', (t) => {
    const b = bench(t);
    const one = paired(b);
    const session = one.openSession();
    b.later(13 * 3_600_000);
    assert.equal(b.devices.conversationOf(session), undefined);
    assert.equal(b.devices.conversationOf(one.openSession()), 'family');
});

test('pairings survive a restart; sessions and codes do not, and neither is written to disk', (t) => {
    const b = bench(t);
    const one = paired(b);
    const session = one.openSession();
    const code = b.devices.share('family').code;
    const again = new Devices(new Store(b.path));
    assert.deepEqual(again.of('family').map((d) => d.id), [one.device]);
    assert.equal(again.conversationOf(session), undefined);
    assert.throws(() => again.pair({ code, key: phone().jwk }), /not valid any more/);
});

test('archiving a conversation removes its devices; the private half of a key is never accepted', (t) => {
    const b = bench(t);
    const one = paired(b, 'family'); paired(b, 'work');
    b.devices.forget('family');
    assert.deepEqual([b.devices.of('family').length, b.devices.of('work').length], [0, 1]);
    assert.throws(() => one.openSession(), /not paired/);
    const leaked = { ...phone().jwk, d: 'private' };
    assert.throws(() => b.devices.pair({ code: b.devices.share('work').code, key: leaked }), /not a device key/);
});

test('the session cookie is for the device door only, and unreadable by scripts', () => {
    const cookie = sessionCookie('abc', 12, true);
    for (const part of ['Path=/c/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=43200']) assert.ok(cookie.includes(part), part);
    assert.equal(readCookie(`other=1; ${SESSION_COOKIE}=abc; x=y`, SESSION_COOKIE), 'abc');
    assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
});
