import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Grants, readRights, RIGHTS, conversationSubject, pairingSubject } from '../server/grants.mjs';
import { Store } from '../server/store.mjs';

function bench(t) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-grants-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, grants: new Grants(new Store(join(dir, 'grants.json'))) };
}
const DEVICE = pairingSubject('0f8fad5b-d9cb-469f-a165-70867728950e');
const TALK = conversationSubject('family');

test('each type of asset takes only the rights that mean something for it', () => {
    assert.deepEqual(RIGHTS, { conversation: 'x', folder: 'rw', mailbox: 'r', git: 'rw', secret: 'x' });
    assert.equal(readRights('folder:reports', 'r'), 'r');
    assert.equal(readRights('folder:reports', 'wr'), 'rw', 'one way to write them');
    assert.equal(readRights('folder:reports', 'w'), 'rw', 'writing brings reading');
    assert.equal(readRights('git:site', 'rw'), 'rw');
    assert.equal(readRights('conversation:family', 'x'), 'x');
    assert.equal(readRights('secret:MODEL_KEY', 'x'), 'x');
    for (const [asset, rights] of [['conversation:family', 'r'], ['folder:reports', 'x'], ['mailbox:inbox', 'w'], ['secret:MODEL_KEY', 'r'], ['folder:reports', ''], ['folder:reports', 'rwz'], ['shadow:x', 'r'], ['folder:../etc', 'r'], ['folder', 'r']]) {
        assert.throws(() => readRights(asset, rights), /takes these rights|Not an asset/, `${asset} ${rights}`);
    }
});

test('a right is one line: given, read back, changed, taken away -- and kept across a restart', (t) => {
    const b = bench(t);
    b.grants.give(TALK, 'folder:reports', 'r');
    b.grants.give(DEVICE, 'conversation:family', 'x');
    b.grants.give(DEVICE, 'folder:photos', 'rw');
    assert.equal(b.grants.can(TALK, 'folder:reports', 'r'), true);
    assert.equal(b.grants.can(TALK, 'folder:reports', 'w'), false);
    assert.equal(b.grants.can(DEVICE, 'folder:reports', 'r'), false, 'no line, no right');
    b.grants.give(TALK, 'folder:reports', 'rw');
    assert.equal(b.grants.rightsOf(TALK, 'folder:reports'), 'rw', 'the line is replaced, not doubled');
    assert.deepEqual(b.grants.of(DEVICE).map((g) => `${g.asset} ${g.rights}`).sort(), ['conversation:family x', 'folder:photos rw']);
    assert.deepEqual(b.grants.of(DEVICE, 'folder').map((g) => g.name), ['photos']);
    assert.deepEqual(b.grants.on('folder:reports'), [{ subject: TALK, rights: 'rw' }]);
    const again = new Grants(new Store(join(b.dir, 'grants.json')));
    assert.equal(again.can(DEVICE, 'conversation:family', 'x'), true);
    again.take(DEVICE, 'folder:photos');
    assert.equal(again.rightsOf(DEVICE, 'folder:photos'), '');
});

test('a secret is never shared with a device; a conversation is not given to a conversation; nobody else can be named', (t) => {
    const b = bench(t);
    assert.throws(() => b.grants.give(DEVICE, 'secret:MODEL_KEY', 'x'), /never shared with a device/);
    b.grants.give(TALK, 'secret:MODEL_KEY', 'x');
    assert.throws(() => b.grants.give(TALK, 'conversation:work', 'x'), /shared with a device/);
    for (const subject of ['owner', 'pairing:guess', 'conversation:Bad Name', 'user:root', '']) {
        assert.throws(() => b.grants.give(subject, 'folder:reports', 'r'), /Not somebody/, subject);
    }
});

test('what goes away takes its lines with it', (t) => {
    const b = bench(t);
    b.grants.give(TALK, 'folder:reports', 'rw'); b.grants.give(TALK, 'folder:notes', 'r');
    b.grants.give(DEVICE, 'conversation:family', 'x'); b.grants.give(DEVICE, 'folder:reports', 'r');
    b.grants.forgetAsset('folder:reports');
    assert.deepEqual(b.grants.on('folder:reports'), []);
    assert.deepEqual(b.grants.of(TALK).map((g) => g.asset), ['folder:notes']);
    b.grants.forgetSubject(DEVICE);
    assert.deepEqual(b.grants.of(DEVICE), []);
});
