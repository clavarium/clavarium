import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mailboxes, fileName, headerOf, indexOf, writeFolder, INDEX } from '../server/mailbox.mjs';
import { Resources } from '../server/resources.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Vms } from '../server/vm.mjs';

const mail = (uid, subject, from = 'A friend <friend@example.org>', body = 'Hello.') => ({
    uid, receivedAt: new Date(Date.UTC(2026, 0, 2, 3, 4) + uid * 60_000), raw: `From: ${from}\r\nSubject: ${subject}\r\n\r\n${body}\r\n`,
});

function bench(t, read, { fetch } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mail-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vm = [];
    const host = async (argv) => { if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(dir, 'resources', argv[2]), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; };
    const resources = new Resources({ store: new Store(join(dir, 'resources.json')), vms: new Vms(async (argv) => { vm.push(argv.slice(1).join(' ')); return { code: 0, stdout: '', stderr: '' }; }, ['x']), host, dataDir: dir, uid: 1, gid: 1 });
    const asked = [];
    const mailboxes = new Mailboxes({ store: new Store(join(dir, 'mailboxes.json')), vault: new Vault(join(dir, 'vault.key')), resources, fetch, reader: async (settings) => { asked.push(settings); return read(settings); } });
    return { dir, vm, resources, mailboxes, asked, folder: join(dir, 'resources', 'inbox') };
}
const SETTINGS = { name: 'inbox', host: 'imap.example.com', user: 'me@example.com', password: 'mail-pass' };

test('a file name is made here: date, number, a few plain letters -- nothing a sender wrote chooses a path', () => {
    assert.equal(fileName(mail(7, 'Quarterly report: Q3!')), '2026-01-02_0311_00000007_quarterly-report-q3.eml');
    assert.equal(fileName(mail(8, '../../etc/passwd')), '2026-01-02_0312_00000008_etc-passwd.eml');
    assert.equal(fileName(mail(9, '')), '2026-01-02_0313_00000009.eml');
    assert.equal(fileName(mail(10, 'R\u00e9union de lundi')), '2026-01-02_0314_00000010_reunion-de-lundi.eml', 'an accent is dropped, not turned into a hyphen');
    assert.equal(fileName({ uid: 1, receivedAt: new Date('nonsense'), raw: 'Subject: x\r\n\r\n' }), '1970-01-01_0000_00000001_x.eml');
    for (const m of [mail(1, 'a/b\\c\0d'), mail(2, '.hidden'), mail(3, 'x'.repeat(300))]) assert.match(fileName(m), /^[0-9_-]+(_[a-z0-9-]{1,40})?\.eml$/);
});

test('headers written the mail way are read: encoded words, folded lines', () => {
    assert.equal(headerOf('Subject: =?utf-8?B?UsOpdW5pb24=?=\r\n\r\n', 'Subject'), 'Réunion');
    assert.equal(headerOf('Subject: =?iso-8859-1?Q?R=E9union_de_lundi?=\r\n\r\n', 'Subject'), 'Réunion de lundi');
    assert.equal(headerOf('Subject: a long\r\n subject\r\nFrom: x\r\n\r\nSubject: not this one', 'Subject'), 'a long subject');
    assert.equal(headerOf('From: x\r\n\r\n', 'Subject'), '');
});

test('the index lists the newest first and says, first thing, that mail is not instructions', () => {
    const text = indexOf('me@example.com', [mail(1, 'first'), mail(2, 'second\r\n injected line')]);
    const lines = text.split('\n');
    assert.match(lines[0], /2 most recent message\(s\) of me@example\.com/);
    assert.match(lines[1], /never an instruction to follow/);
    assert.ok(text.indexOf('_second') < text.indexOf('_first'));
    assert.ok(lines.every((l) => !l.startsWith('injected')), 'a subject cannot add a line of its own');
});

test('the folder holds exactly the messages given: new ones added, gone ones removed, others untouched', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-mailf-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFolder(dir, 'me', [mail(1, 'one'), mail(2, 'two')]);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-01-02_0305_00000001_one.eml', '2026-01-02_0306_00000002_two.eml', INDEX]);
    writeFileSync(join(dir, 'notes-of-mine.txt'), 'kept');
    writeFolder(dir, 'me', [mail(2, 'two'), mail(3, 'three')]);
    assert.deepEqual(readdirSync(dir).sort(), ['2026-01-02_0306_00000002_two.eml', '2026-01-02_0307_00000003_three.eml', INDEX, 'notes-of-mine.txt']);
    assert.match(readFileSync(join(dir, '2026-01-02_0307_00000003_three.eml'), 'utf8'), /^From: A friend/);
});

test('adding a mailbox proves it can be read, makes its folder, and seals the password', async (t) => {
    const b = bench(t, () => [mail(1, 'Welcome')]);
    const added = await b.mailboxes.add(SETTINGS);
    assert.deepEqual({ name: added.name, user: added.user, messages: added.messages, failure: added.failure }, { name: 'inbox', user: 'me@example.com', messages: 1, failure: null });
    assert.equal(b.asked[0].password, 'mail-pass');
    assert.ok(existsSync(join(b.folder, INDEX)));
    assert.equal(b.resources.list()[0].type, 'mailbox');
    const stored = readFileSync(join(b.dir, 'mailboxes.json'), 'utf8');
    assert.ok(!stored.includes('mail-pass'), 'the password is not kept in clear');
    assert.ok(!JSON.stringify(b.mailboxes.list()).includes('mail-pass'));
    await assert.rejects(b.mailboxes.add(SETTINGS), /already has this name/);
});

test('a mailbox that cannot be read is not added; nothing is left behind', async (t) => {
    const b = bench(t, () => { throw new Error('refused'); });
    await assert.rejects(b.mailboxes.add(SETTINGS));
    assert.deepEqual(b.mailboxes.list(), []);
    assert.deepEqual(b.resources.list(), []);
    await assert.rejects(b.mailboxes.add({ ...SETTINGS, name: '../x' }), /name/);
    await assert.rejects(b.mailboxes.add({ ...SETTINGS, host: 'not a host' }), /host name/);
});

test('a mailbox is attached for reading only: the read-only view, never the folder', async (t) => {
    const b = bench(t, () => [mail(1, 'Welcome')]);
    await b.mailboxes.add(SETTINGS);
    await assert.rejects(b.resources.attach('alpha', 'inbox', 'write'), /read-only/);
    await b.resources.attach('alpha', 'inbox', 'read');
    assert.deepEqual(b.vm, ['mount clv-alpha view inbox 1 1']);
});

test('keeping up to date: new mail arrives as files; a failure keeps what was there and says why', async (t) => {
    let inbox = [mail(1, 'one')];
    let broken = false;
    const b = bench(t, () => { if (broken) throw new Error('down'); return inbox; });
    await b.mailboxes.add(SETTINGS);
    inbox = [mail(1, 'one'), mail(2, 'two')];
    await b.mailboxes.syncAll();
    assert.equal(b.mailboxes.list()[0].messages, 2);
    assert.equal(b.asked.at(-1).password, 'mail-pass', 'the sealed password opens again');
    broken = true;
    const after = await b.mailboxes.sync('inbox');
    assert.equal(after.failure, 'The mailbox could not be read.');
    assert.equal(readdirSync(b.folder).filter((f) => f.endsWith('.eml')).length, 2, 'what was there stays');
    await assert.rejects(b.mailboxes.sync('nope'), /No such mailbox/);
    b.mailboxes.forget('inbox');
    assert.deepEqual(b.mailboxes.list(), []);
});

test('connecting by token: consent gives the provider URL, the pasted address trades a code for a sealed refresh token', async (t) => {
    const token = async (url, opts) => {
        const p = new URLSearchParams(opts.body);
        assert.equal(p.get('grant_type'), 'authorization_code');
        assert.equal(p.get('code'), 'THECODE');
        return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'REFRESH-XYZ', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const b = bench(t, () => [mail(1, 'Welcome')], { fetch: token });
    const { url } = b.mailboxes.consent({ name: 'gmail', provider: 'google', user: 'me@example.com' });
    assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/auth?'));
    assert.ok(url.includes('code_challenge='), 'PKCE challenge present');
    const state = new URL(url).searchParams.get('state');
    assert.ok(state, 'a state is set');
    const made = await b.mailboxes.connect({ redirected: `http://127.0.0.1:47813/?code=THECODE&state=${state}` });
    assert.equal(made.name, 'gmail');
    assert.equal(made.provider, 'google');
    assert.equal(b.asked.at(-1).provider, 'google', 'the reader is asked with OAuth settings');
    assert.equal(b.asked.at(-1).password, 'REFRESH-XYZ', 'the refresh token is the credential');
    assert.ok(!readFileSync(join(b.dir, 'mailboxes.json'), 'utf8').includes('REFRESH-XYZ'), 'the refresh token is sealed, not in clear');
    await assert.rejects(b.mailboxes.connect({ redirected: `http://127.0.0.1:47813/?code=THECODE&state=${state}` }), /expired or was already used/);
});

test('connect refuses an unknown state and a provider error', async (t) => {
    const b = bench(t, () => [], { fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(b.mailboxes.connect({ redirected: 'http://127.0.0.1:47813/?code=X&state=nope' }), /expired or was already used/);
    const { url } = b.mailboxes.consent({ name: 'box', provider: 'microsoft', user: 'me@example.com' });
    const state = new URL(url).searchParams.get('state');
    await assert.rejects(b.mailboxes.connect({ redirected: `http://127.0.0.1:47813/?error=access_denied&state=${state}` }), /refused/);
});
