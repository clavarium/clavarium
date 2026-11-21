/* A MAIL CITED BY ITS REFERENCE (mailref.mjs): read through Tether when it is opened, only by whoever may
   read that mailbox, answered as the .eml viewer's bytes -- and its page with remote pictures made by the
   very code and headers of an .eml's (files.mjs mailPage). A mailbox connector of the test answers; the
   mails are written here, example.com / example.org only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tethers } from '../server/tethers.mjs';
import { mailRoute, openMail, deviceMayRead, isMailRef } from '../server/mailref.mjs';
import { mailPage, MAIL_HEADERS } from '../server/files.mjs';

const MAIL = `Message-ID: <quote-1@example.com>\r\nFrom: Ann <ann@example.com>\r\nTo: me@example.org\r\nSubject: Caf\xe9 quote\r\nDate: Wed, 04 Nov 2026 09:00:00 +0000\r\nContent-Type: text/html; charset=iso-8859-1\r\n\r\n<p id="said">Le caf\xe9</p><img src="https://img.example.com/track.png"><script>alert(1)</script><img src="x" onerror="alert(2)">\r\n`;
const REF = 'mail:work-mail/quote-1%40example.com?in=INBOX&uid=7';
const BOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'me@example.org', host: 'mail.example.org' } };

/* A Tether that keeps its store in a folder of the test, its mailbox answering from `mails` (by Message-ID). */
function tethers(mails = { '<quote-1@example.com>': MAIL }) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mailref-'));
    const asked = [];
    const connector = { run: async (verb, target, a, ctx) => {
        asked.push({ verb, a, person: ctx.person });
        if (verb === 'mail.source') { if (a.uid !== '7') throw new Error('no such message'); return { text: MAIL, size: 1 }; }
        const id = `<${decodeURIComponent(/\/([^?]+)/.exec(a.ref)[1])}>`;
        if (target.config.down) throw Object.assign(new Error('the mailbox cannot be reached'));
        if (!mails[id]) { const e = new (await import('clavarium-tether/verbs')).Refused(`${target.title}: this mail is no longer in the mailbox`); e.code = 'gone'; throw e; }
        return { text: 'Found in Archive.', size: mails[id].length, raw: Buffer.from(mails[id], 'latin1'), folder: 'Archive', ref: `${a.ref.split('?')[0]}?in=Archive&uid=3`, cut: false };
    } };
    const t = new Tethers({ dataDir: dir, resources: { workFolder: () => dir }, conversations: () => ['asker'], secrets: { reveal: async () => '' }, connectors: { mail: connector } });
    t.store().putTarget(BOX);
    return { t, asked, dir };
}
/* An answer the route writes. */
function response() {
    const r = { status: 0, headers: {}, body: null };
    r.writeHead = (status, headers) => { r.status = status; r.headers = headers; return r; };
    r.end = (body) => { r.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? '')); return r; };
    return r;
}
const OWNER = { id: 'person:owner', name: 'Owner' };
const SITE = { 'content-security-policy': "default-src 'self'" };

test('a reference is told from anything else', () => {
    assert.equal(isMailRef(REF), true);
    for (const x of ['', '42', 'AAMkAGI2', '/work/a.eml', 'mail:', 'https://example.com']) assert.equal(isMailRef(x), false, x);
});

test('opened: the mail\'s bytes, byte for byte, read now as the person\'s read; where it was found said beside them', async () => {
    const { t, asked, dir } = tethers();
    const out = response();
    assert.equal(await mailRoute('/mail/open', new URLSearchParams({ ref: REF }), out, { tethers: t, headers: SITE, who: OWNER, may: () => true }), true);
    assert.equal(out.status, 200);
    assert.equal(out.body.toString('latin1'), MAIL, 'the 8-bit é is one byte, as sent');
    assert.equal(out.headers['content-type'], 'message/rfc822');
    assert.equal(out.headers['cache-control'], 'no-store');
    assert.equal(out.headers['x-content-type-options'], 'nosniff');
    assert.match(out.headers['content-disposition'], /^attachment; filename\*=UTF-8''Caf%C3%A9%20quote\.eml$/);
    assert.equal(decodeURIComponent(out.headers['x-mail-folder']), 'Archive');
    assert.equal(decodeURIComponent(out.headers['x-mail-box']), 'Work mailbox');
    assert.equal(decodeURIComponent(out.headers['x-mail-ref']), 'mail:work-mail/quote-1%40example.com?in=Archive&uid=3', 'its reference as it is now');
    assert.equal(out.headers['content-security-policy'], SITE['content-security-policy'], 'the site\'s own rules');
    assert.deepEqual(asked.map((x) => [x.verb, x.person?.id]), [['mail.open', 'person:owner']], 'one read, the person\'s');
    /* Kept nowhere: no file of this server holds it. */
    const files = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
    for (const f of files(dir)) assert.ok(!readFileSync(f, 'latin1').includes('Le caf'), `${f} does not hold the mail`);
    /* Tether's journal says it was the person's read, not an agent's. */
    const journal = readFileSync(join(dir, 'tether', 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(journal.some((l) => l.op === 'read' && l.verb === 'mail.open' && l.by?.id === 'person:owner' && !l.agent));
});

test('its page with remote pictures: the .eml\'s own code and headers -- no script, a sandbox, nothing of the site', async () => {
    const { t } = tethers();
    const out = response();
    await mailRoute('/mail/page', new URLSearchParams({ ref: REF }), out, { tethers: t, headers: SITE, who: OWNER, may: () => true });
    const same = mailPage(new Uint8Array(Buffer.from(MAIL, 'latin1')));
    assert.equal(out.body.toString('utf8'), same.body, 'the very page an .eml of the same bytes gives');
    for (const [k, v] of Object.entries(MAIL_HEADERS)) assert.equal(out.headers[k], v, k);
    assert.match(out.body.toString('utf8'), /<img src="https:\/\/img\.example\.com\/track\.png">/);
    assert.doesNotMatch(out.body.toString('utf8'), /<script|onerror|alert\(/);
    assert.match(out.headers['content-security-policy'], /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none';/);
    assert.doesNotMatch(out.headers['content-security-policy'], /allow-scripts|allow-same-origin|script-src/);
    /* A conversation cut off: no remote pictures, as for an .eml. */
    await assert.rejects(() => mailRoute('/mail/page', new URLSearchParams({ ref: REF }), response(), { tethers: t, headers: SITE, who: OWNER, may: () => true, offline: true }), /offline/);
});

test('not theirs: nothing is read; gone, unreachable, an old reference: each said as itself', async () => {
    const { t, asked } = tethers();
    await assert.rejects(() => openMail(t, REF, { who: OWNER, may: () => false }), (e) => e.status === 403 && e.kind === 'not-yours');
    assert.equal(asked.length, 0, 'nothing was read for someone it is not');
    await assert.rejects(() => openMail(t, 'mail:work-mail/none%40example.com', { who: OWNER, may: () => true }), (e) => e.status === 410 && e.kind === 'gone');
    await assert.rejects(() => openMail(t, 'mail:no-such-box/x%40example.com', { who: OWNER, may: () => true }), (e) => e.kind === 'gone');
    t.store().putTarget({ ...BOX, config: { ...BOX.config, down: true } });
    await assert.rejects(() => openMail(t, REF, { who: OWNER, may: () => true }), (e) => e.status === 502 && e.kind === 'unreachable');
    /* A bare id a card kept: read where it can be without guessing -- the one mailbox its conversation was given. */
    t.store().putTarget(BOX);
    await assert.rejects(() => openMail(t, '7', { who: OWNER, may: () => true, of: 'asker' }), (e) => e.kind === 'old-ref');
    t.store().grant('work-mail', 'conversation:asker', 'watch');
    const old = await openMail(t, '7', { who: OWNER, may: () => true, of: 'asker' });
    assert.match(Buffer.from(old.bytes).toString('utf8'), /Subject: Caf/);
    await assert.rejects(() => openMail(t, '7', { who: OWNER, may: () => true }), (e) => e.kind === 'old-ref', 'no conversation: no guess');
    await assert.rejects(() => openMail(t, '8', { who: OWNER, may: () => true, of: 'asker' }), (e) => e.kind === 'old-ref', 'not found there: said old');
});

test('a device reads a mailbox only with Read on a mailbox asset of the same address', () => {
    const mailboxes = { list: () => [{ name: 'home-mail', user: 'Me@Example.org' }, { name: 'other', user: 'other@example.org' }] };
    assert.equal(deviceMayRead(BOX, [{ name: 'home-mail', type: 'mailbox', access: 'read' }], mailboxes), true);
    assert.equal(deviceMayRead(BOX, [{ name: 'other', type: 'mailbox', access: 'read' }], mailboxes), false);
    assert.equal(deviceMayRead(BOX, [{ name: 'home-mail', type: 'folder', access: 'read' }], mailboxes), false);
    assert.equal(deviceMayRead(BOX, [], mailboxes), false);
    assert.equal(deviceMayRead({ ...BOX, config: {} }, [{ name: 'home-mail', type: 'mailbox' }], mailboxes), false);
});

test('both doors route a reference through the one implementation, and the viewer draws it as an .eml', () => {
    const src = (f) => readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
    assert.match(src('api.mjs'), /pathname === '\/api\/mail\/open' \|\| pathname === '\/api\/mail\/page'[\s\S]{0,400}mailRoute\(/);
    assert.match(src('api.mjs'), /may: \(\) => true/, 'the owner may read every mailbox');
    assert.match(src('door.mjs'), /route === '\/mail\/open' \|\| route === '\/mail\/page'[\s\S]{0,300}mailRoute\(route[\s\S]{0,200}deviceMayRead\(t, own, mailboxes\)/);
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    /* The same viewer: a reference goes through preview -> showMail, whose frame runs nothing. */
    assert.match(app, /function openMailRef[\s\S]{0,600}preview\('', '', name, 0, `\$\{API\}\/mail\/open\?\$\{q\}`, \{ mailRef:/);
    assert.match(app, /showMail\(\{ bytes, name, tab, inner, from, note, ref: opts\.mailRef \}\)/);
    assert.match(app, /else if \(a\.kind === 'mail'\) openCardMail\(whose\(\), a\);/);
});
