import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Devices, readCookie, sessionCookie, cookieNameOf, SESSION_COOKIE } from '../server/devices.mjs';
import { Store } from '../server/store.mjs';
import { Grants } from '../server/grants.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-dev-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let now = Date.parse('2030-01-01T00:00:00Z');
    const grants = () => new Grants(new Store(join(dir, 'grants.json')));
    const devices = new Devices(new Store(join(dir, 'devices.json')), () => now, grants());
    return { dir, devices, grants, later: (ms) => { now += ms; }, path: join(dir, 'devices.json') };
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
    assert.equal(b.devices.conversationOf(session, one.device), 'family');
    /* The same device given a second conversation holds a second pairing:
       the session of one does not speak for the other. */
    const two = paired(b, 'work');
    assert.equal(b.devices.conversationOf(two.openSession(), two.device), 'work');
    assert.equal(b.devices.conversationOf(session, two.device), undefined);
    assert.equal(b.devices.conversationOf(session, one.device), 'family', 'and the first still works');
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

test('pairings and live sessions survive a restart (a new version put in place); codes do not; only the sha256 of a session is on disk', async (t) => {
    const b = bench(t);
    const one = paired(b);
    const session = one.openSession();
    const code = b.devices.share('family').code;
    const again = new Devices(new Store(b.path), undefined, b.grants());
    assert.deepEqual(again.of('family').map((d) => d.id), [one.device]);
    assert.equal(again.conversationOf(session), 'family', 'still signed in after the restart');
    assert.throws(() => again.pair({ code, key: phone().jwk }), /not valid any more/);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(b.path, 'utf8').includes(session), false, 'the session itself is never written');
    /* Removed: its sessions end, also after a restart. */
    again.revoke(one.device);
    const later = new Devices(new Store(b.path), undefined, b.grants());
    assert.equal(later.conversationOf(session), undefined);
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
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const cookie = sessionCookie(id, 'abc', 12, true);
    /* One cookie per pairing: two conversations on one device do not replace each other. */
    assert.ok(cookie.startsWith(`${cookieNameOf(id)}=abc;`));
    assert.equal(cookieNameOf(id), `${SESSION_COOKIE}_${id}`);
    assert.throws(() => sessionCookie('x; Path=/', 'abc', 12, true), /Not a pairing/);
    for (const part of ['Path=/c/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=43200']) assert.ok(cookie.includes(part), part);
    assert.equal(readCookie(`other=1; ${SESSION_COOKIE}=abc; x=y`, SESSION_COOKIE), 'abc');
    assert.equal(readCookie(undefined, SESSION_COOKIE), undefined);
});

test('one code gives a chosen list: conversations to use, folders to read or write -- and never a secret', (t) => {
    const b = bench(t);
    const p = phone();
    const { code } = b.devices.share([{ asset: 'conversation:family', rights: 'x' }, { asset: 'conversation:garden', rights: 'x' }, { asset: 'folder:photos', rights: 'r' }, { asset: 'git:site', rights: 'rw' }]);
    const { device } = b.devices.pair({ code, key: p.jwk, label: 'Tablet' });
    assert.deepEqual(b.devices.conversationsOf(device), ['family', 'garden']);
    assert.deepEqual(b.devices.grantsOf(device).map((g) => `${g.asset} ${g.rights}`), ['conversation:family x', 'conversation:garden x', 'folder:photos r', 'git:site rw']);
    const session = b.devices.open(device, p.sign(b.devices.challenge(device).nonce)).session;
    /* It names the conversation it speaks for; one it was not given is none -- never another in its place. */
    assert.equal(b.devices.conversationOf(session, device, 'garden'), 'garden');
    assert.equal(b.devices.conversationOf(session, device, 'private-work'), undefined);
    assert.equal(b.devices.conversationOf(session, device), 'family', 'naming none: its first');
    assert.deepEqual(b.devices.of('garden').map((d) => d.id), [device]);
    assert.throws(() => b.devices.share([{ asset: 'secret:MODEL_KEY', rights: 'x' }]), /never shared with a device/);
    assert.throws(() => b.devices.share([{ asset: 'folder:photos', rights: 'x' }]), /takes these rights/);
    assert.throws(() => b.devices.share([]), /at least one thing/);
});

test('one thing can be taken back; what is gone takes its rights; a device left with nothing is removed', (t) => {
    const b = bench(t);
    const { code } = b.devices.share([{ asset: 'conversation:family', rights: 'x' }, { asset: 'folder:photos', rights: 'rw' }]);
    const { device } = b.devices.pair({ code, key: phone().jwk });
    b.devices.take(device, 'folder:photos');
    assert.deepEqual(b.devices.grantsOf(device).map((g) => g.asset), ['conversation:family']);
    b.devices.forget('family');
    assert.deepEqual(b.devices.all(), [], 'nothing left: the pairing is gone');
});

test('a pairing made before the table of rights existed keeps its conversation', (t) => {
    const b = bench(t);
    const store = new Store(b.path);
    store.put({ name: '0f8fad5b-d9cb-469f-a165-70867728950e', conversation: 'family', key: phone().jwk, label: 'Phone', createdAt: '2030-01-01T00:00:00.000Z' });
    const upgraded = new Devices(new Store(b.path), undefined, b.grants());
    assert.deepEqual(upgraded.conversationsOf('0f8fad5b-d9cb-469f-a165-70867728950e'), ['family']);
    assert.equal(new Store(b.path).get('0f8fad5b-d9cb-469f-a165-70867728950e').conversation, undefined);
});

test('a paired device is given more, has a right changed, and is renamed -- without a new code; a code can be cancelled', (t) => {
    const b = bench(t);
    const { device } = b.devices.pair({ code: b.devices.share('family', 'Dad').code, key: phone().jwk, label: 'Tablet or computer' });
    assert.equal(b.devices.all()[0].label, 'Dad', 'the name the owner chose wins over what the device says of itself');
    b.devices.give(device, 'folder:photos', 'r');
    b.devices.give(device, 'folder:photos', 'rw');
    b.devices.give(device, 'conversation:garden', 'x');
    assert.deepEqual(b.devices.grantsOf(device).map((g) => `${g.asset} ${g.rights}`), ['conversation:family x', 'folder:photos rw', 'conversation:garden x']);
    assert.throws(() => b.devices.give(device, 'secret:MODEL_KEY', 'x'), /never shared with a device/);
    assert.throws(() => b.devices.give('0f8fad5b-d9cb-469f-a165-70867728950e', 'folder:photos', 'r'), /No such device/);
    b.devices.rename(device, "Dad's tablet");
    assert.equal(b.devices.all()[0].label, "Dad's tablet");
    assert.throws(() => b.devices.rename(device, 'two\nlines'), /one line/);
    const { code } = b.devices.share('family');
    b.devices.cancel(code);
    assert.throws(() => b.devices.pair({ code, key: phone().jwk }), /not valid any more/);
});

test('a conversation is shared in parts, its terminal and its chat; a pairing made before keeps its chat where it was on, once', (t) => {
    const b = bench(t);
    const { device } = b.devices.pair({ code: b.devices.share([{ asset: 'conversation:family', rights: 'rw' }]).code, key: phone().jwk });
    assert.equal(b.devices.rightsOn(device, 'family'), 'rw', 'the chat, and not the terminal');
    assert.equal(b.devices.rightsOn(device, 'work'), '');
    assert.deepEqual(b.devices.of('family').map((d) => d.id), [device], 'given the chat alone, it is still a device of that conversation');
    assert.deepEqual(b.devices.conversationsOf(device), ['family']);
    /* Before: "x" gave the terminal, and the chat wherever it was on. */
    const old = '0f8fad5b-d9cb-469f-a165-70867728950e';
    new Store(b.path).put({ name: old, key: phone().jwk, label: 'Old phone', createdAt: '2030-01-01T00:00:00.000Z' });
    const grants = b.grants();
    grants.give(`pairing:${old}`, 'conversation:family', 'x'); grants.give(`pairing:${old}`, 'conversation:work', 'x');
    const upgraded = new Devices(new Store(b.path), undefined, b.grants(), { chatWas: (name) => name === 'family' });
    assert.equal(upgraded.rightsOn(old, 'family'), 'rwx');
    assert.equal(upgraded.rightsOn(old, 'work'), 'x');
    assert.equal(upgraded.rightsOn(device, 'family'), 'rw', 'a pairing made since is left as it is');
    /* Once only: "x" alone is the terminal alone from then on. */
    upgraded.give(old, 'conversation:family', 'x');
    const again = new Devices(new Store(b.path), undefined, b.grants(), { chatWas: () => true });
    assert.equal(again.rightsOn(old, 'family'), 'x');
});
