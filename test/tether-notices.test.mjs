import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers, noticeLine, noticeWord, endedLine, resultLine, noticeRe } from '../server/tethers.mjs';

/* TETHER'S NOTICES (something that happened later to what an agent did): said once in the thread of the
   conversation whose agent did it, and that agent woken once through its docket. A fake keeper hands
   them, as Tether's keeper does through `notify`. */
function setup(dir, { chatOn = true } = {}) {
    const work = join(dir, 'work'); mkdirSync(work, { recursive: true });
    const resources = { workFolder: (name) => { const f = join(work, name); mkdirSync(f, { recursive: true }); return f; } };
    const hooks = {};
    const make = (_dir, options) => {
        Object.assign(hooks, options);
        const targets = new Map();
        return {
            onChange() {}, approvals: () => [], jobs: () => [], pump() {},
            store: { target: (id) => targets.get(id), putTarget: (t) => { targets.set(t.id, t); return t; }, targets: () => [...targets.values()] },
        };
    };
    const said = []; const posted = [];
    const dockets = { on: () => chatOn, post: (name, e) => { posted.push({ name, ...e }); return e; } };
    const tethers = new Tethers({ dataDir: dir, resources, conversations: () => ['alpha', 'beta'], secrets: { reveal: () => undefined }, dockets, make });
    tethers.announce = (name, e) => said.push({ name, ...e });
    return { tethers, hooks, said, posted };
}
const bounce = (over = {}) => ({ id: 'n1', at: '2026-11-05T10:00:00.000Z', agent: 'conversation:beta', target: { id: 'box', title: 'Work mail' }, kind: 'mail.bounced', text: 'The mail "Quote" to bob@example.com came back: no such mailbox.', ref: '<m1@example.com>', ...over });

test('a bounce is a warning in its conversation and wakes its agent once', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir);
    assert.equal(typeof hooks.notify, 'function', 'Tether is given a notify hook');
    hooks.notify(bounce());
    assert.equal(said.length, 1);
    assert.equal(said[0].name, 'beta');
    assert.equal(said[0].kind, 'tether-notice');
    assert.equal(said[0].tone, 'warn');
    assert.equal(said[0].level, 'needs-you');
    /* Keys and values, said by each screen in its language; Tether's own sentence as it wrote it; plain English for an older screen. */
    assert.deepEqual(said[0].text, { k: 'line-notice', v: { head: { k: 'notice-mail-bounced', t: 'Mail came back' }, target: 'Work mail', text: 'The mail "Quote" to bob@example.com came back: no such mailbox.' },
        t: 'Mail came back (Work mail): The mail "Quote" to bob@example.com came back: no such mailbox.' });
    assert.deepEqual(said[0].topic, { k: 'line-topic-notice', t: 'Later news' });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].name, 'beta');
    assert.equal(posted[0].kind, 'tether-notice');
    assert.match(posted[0].text, /^Mail came back .*no such mailbox\. See more: tether notices\.$/);
    assert.deepEqual(posted[0].data, { notice: 'n1', kind: 'mail.bounced', ref: '<m1@example.com>', target: 'box' });
});

test('the same notice twice, even after a restart, is said once', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = setup(dir);
    first.hooks.notify(bounce());
    first.hooks.notify(bounce());
    assert.equal(first.said.length, 1); assert.equal(first.posted.length, 1);
    const again = setup(dir);
    again.hooks.notify(bounce());
    assert.equal(again.said.length, 0, 'remembered across a restart'); assert.equal(again.posted.length, 0);
    again.hooks.notify(bounce({ id: 'n2' }));
    assert.equal(again.said.length, 1, 'a new notice is said');
});

test('a delay is news, not a warning; a chat that is off is not woken', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir, { chatOn: false });
    hooks.notify(bounce({ kind: 'mail.delayed', text: 'Not delivered yet; still trying.' }));
    assert.equal(said.length, 1);
    assert.equal(said[0].tone, undefined); assert.equal(said[0].level, undefined);
    assert.equal(said[0].text.v.head.k, 'notice-mail-delayed');
    assert.match(said[0].text.t, /^Mail delayed/);
    assert.equal(posted.length, 0);
});

test('an unknown agent, or one that is no conversation, gives nothing and never throws', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said, posted } = setup(dir);
    hooks.notify(bounce({ agent: 'conversation:nobody' }));
    hooks.notify(bounce({ id: 'n3', agent: 'agent:other' }));
    hooks.notify(bounce({ id: 'n4', agent: null }));
    hooks.notify(null);
    hooks.notify({});
    assert.equal(said.length, 0); assert.equal(posted.length, 0);
});

test('each frame of a notice: with or without its target, with or without the sentence of Tether; an unknown kind is later news', () => {
    assert.deepEqual(noticeLine('mail.sent-late', '', 'Sent at 10:02.'), { k: 'line-notice-said', v: { head: { k: 'notice-mail-sent-late', t: 'Mail sent late' }, text: 'Sent at 10:02.' }, t: 'Mail sent late: Sent at 10:02.' });
    assert.deepEqual(noticeLine('calendar.declined', 'Work calendar', ''), { k: 'line-notice-at', v: { head: { k: 'notice-calendar-declined', t: 'Invitation declined' }, target: 'Work calendar' }, t: 'Invitation declined (Work calendar)' });
    assert.deepEqual(noticeLine('mail.later-draft-kept', '', ''), { k: 'notice-mail-later-draft-kept', t: 'Scheduled mail sent, draft kept' });
    assert.deepEqual(noticeLine('files.something', '', ''), { k: 'notice-later', t: 'Later news' });
});

/* Every word these lines send is one Parley's screens know (Parley 0.17.71 on). */
test('each word of these lines is in the dictionary of the screens', async () => {
    const { KEYS } = await import('clavarium-parley/ui');
    const sent = [noticeLine('mail.bounced', 'a', 'b'), noticeLine('mail.bounced', '', 'b'), noticeLine('mail.bounced', 'a', ''), endedLine('x', 'yes'), resultLine('x', ''), resultLine('x', 'why'), resultLine('x')];
    for (const kind of ['mail.bounced', 'mail.delayed', 'mail.send-failed', 'mail.later-failed', 'mail.later-unsure', 'mail.later-late', 'mail.sent-late', 'mail.later-draft-kept', 'calendar.declined', 'other']) sent.push(noticeWord(kind));
    for (const o of ['no', 'timeout', 'withdrawn', 'stopped', '']) sent.push(endedLine('x', o));
    const keys = new Set(['line-topic-request', 'line-topic-notice', 'line-flash', 'line-flash-device']);
    const walk = (x) => { if (x && typeof x === 'object') { if (x.k) keys.add(x.k); Object.values(x.v ?? {}).forEach(walk); } };
    sent.forEach(walk);
    for (const k of keys) assert.ok(KEYS.includes(k), k);
});

test('a bounce or a delay carries the mail sent as a chip (mail:TARGET/ID, its subject); other notices, or no Message-ID, none', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-tnot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { hooks, said } = setup(dir);
    hooks.notify(bounce());
    assert.deepEqual(said[0].re, { ref: 'mail:box/m1%40example.com', label: 'Quote', lead: { k: 'line-re-sent', t: 'the mail sent' } });
    hooks.notify(bounce({ id: 'n2', ref: undefined }));
    assert.equal(said[1].re, undefined, 'no Message-ID: no chip');
    hooks.notify(bounce({ id: 'n3', kind: 'mail.later-failed' }));
    assert.equal(said[2].re, undefined, 'a mail never sent: nothing to open');
    assert.deepEqual(noticeRe('mail.delayed', 'box', 'm2@example.com', 'odd words').label, { k: 'req-a-message', t: 'a message' }, 'no subject read: a word');
    assert.equal(noticeRe('mail.bounced', 'a b', 'm@example.com', ''), null, 'a target that cannot be in a reference');
});
