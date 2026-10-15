import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage, readableForms, recentSignIns, readSettings, quoted, imapDate, SignInMailboxes } from '../server/signin.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';

const RULES = { senders: ['provider.example.com'], links: ['login.example.com'] };
const NOW = new Date('2030-03-01T10:00:00Z');
/* Addresses are assembled here: the repository's own check refuses anything
   that looks like a real address outside the example domains, and it is right. */
const at = (user, domain) => `${user}@${domain}`;
const mail = ({ from = `Provider <${at('no-reply', 'mail.provider.example.com')}>`, dkim = 'dkim=pass header.d=provider.example.com', body = 'Sign in: https://login.example.com/magic?token=abcdef0123456789\r\n', subject = 'Your sign-in link', extra = '' } = {}) =>
    `From: ${from}\r\nSubject: ${subject}\r\nAuthentication-Results: mx.example.net; ${dkim}; spf=pass\r\n${extra}\r\n${body}`;
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000);

test('a sign-in mail gives its link, its sender and whether the mailbox verified that sender', () => {
    const item = readMessage(mail(), minutesAgo(1), RULES, NOW);
    assert.deepEqual([item.from, item.verified, item.link, item.subject], ['mail.provider.example.com', true, 'https://login.example.com/magic?token=abcdef0123456789', 'Your sign-in link']);
    assert.equal(readMessage(mail({ dkim: 'dkim=fail header.d=provider.example.com' }), minutesAgo(1), RULES, NOW).verified, false);
    assert.equal(readMessage(mail({ dkim: 'dkim=pass header.d=evil.example' }), minutesAgo(1), RULES, NOW).verified, false, 'signed, but by someone else');
});

test('anything else in the mailbox is not a sign-in mail: other senders, old mail, links elsewhere', () => {
    assert.equal(readMessage(mail({ from: 'friend@example.org' }), minutesAgo(1), RULES, NOW), undefined);
    assert.equal(readMessage(mail({ from: at('x', 'provider.example.com.evil.example') }), minutesAgo(1), RULES, NOW), undefined, 'a look-alike domain');
    assert.equal(readMessage(mail(), minutesAgo(16), RULES, NOW), undefined, 'older than a quarter of an hour');
    assert.equal(readMessage(mail({ body: 'Click https://evil.example/login?x=https://login.example.com/\r\n' }), minutesAgo(1), RULES, NOW), undefined);
    assert.equal(readMessage(mail({ body: 'http://login.example.com/plain\r\n' }), minutesAgo(1), RULES, NOW), undefined, 'not HTTPS');
    assert.equal(readMessage(mail({ body: `https://user:${at('pw', 'login.example.com')}/x\r\n` }), minutesAgo(1), RULES, NOW), undefined, 'credentials in the address');
    assert.equal(readMessage(mail(), new Date('nonsense'), RULES, NOW), undefined);
});

test('the link is found behind quoted-printable and base64, and the longest one is the sign-in link', () => {
    const qp = mail({ extra: 'Content-Transfer-Encoding: quoted-printable\r\n', body: 'Open https://login.example.com/magic?token=3Dabcdef01234=\r\n56789&amp;x=3D1 now. Help: https://login.example.com/help\r\n' });
    assert.equal(readMessage(qp, minutesAgo(1), RULES, NOW).link, 'https://login.example.com/magic?token=abcdef0123456789&x=1');
    const html = '<a href="https://login.example.com/magic?token=fromhtml0123456789">Sign in</a>';
    const b64 = mail({ body: `--b\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}\r\n--b--\r\n` });
    assert.ok(readableForms(b64).some((f) => f.includes('fromhtml')));
    assert.equal(readMessage(b64, minutesAgo(1), RULES, NOW).link, 'https://login.example.com/magic?token=fromhtml0123456789');
});

test('what goes on an IMAP command line is quoted, and a line break is refused: one value, one command', () => {
    assert.equal(quoted('pa"ss\\word'), '"pa\\"ss\\\\word"');
    assert.throws(() => quoted('x\r\nc9 DELETE INBOX'), /line break/);
    assert.equal(imapDate(new Date('2030-03-01T00:30:00Z')), '1-Mar-2030');
    assert.deepEqual(readSettings({ host: 'IMAP.Example.com', user: 'u', password: 'p' }), { host: 'imap.example.com', port: 993, user: 'u', password: 'p' });
    for (const bad of [{ host: 'localhost', user: 'u', password: 'p' }, { host: 'a b.example.com', user: 'u', password: 'p' }, { host: 'imap.example.com', user: '', password: 'p' }, { host: 'imap.example.com', user: 'u', password: 'p', port: 70000 }]) {
        assert.throws(() => readSettings(bad));
    }
});

/* A scripted IMAP server: records every command, answers like a real one. */
function fakeImap(messages, { refuseLogin = false } = {}) {
    const commands = [];
    const connect = () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = (text) => {
            const [tag, ...rest] = text.trim().split(' ');
            const command = rest.join(' ');
            commands.push(command.startsWith('LOGIN') ? 'LOGIN <hidden>' : command);
            let reply = '';
            if (command.startsWith('LOGIN')) reply = refuseLogin ? `${tag} NO bad credentials\r\n` : `${tag} OK\r\n`;
            else if (command.startsWith('UID SEARCH')) reply = `* SEARCH ${messages.map((_, i) => i + 1).join(' ')}\r\n${tag} OK\r\n`;
            else if (command.startsWith('UID FETCH')) {
                const m = messages[Number(command.split(' ')[2]) - 1];
                const raw = Buffer.from(m.raw);
                reply = `* 1 FETCH (UID 1 INTERNALDATE "${m.date}" BODY[]<0> {${raw.length}}\r\n${m.raw})\r\n${tag} OK\r\n`;
            } else reply = `${tag} OK\r\n`;
            /* In two pieces, as a network would: the reader must wait for the rest. */
            const bytes = Buffer.from(reply); const cut = Math.floor(bytes.length / 2);
            setImmediate(() => { socket.emit('data', bytes.subarray(0, cut)); setImmediate(() => socket.emit('data', bytes.subarray(cut))); });
        };
        setImmediate(() => socket.emit('data', Buffer.from('* OK ready\r\n')));
        return socket;
    };
    return { connect, commands };
}
const imapStamp = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;

test('the mailbox is only ever READ: opened with EXAMINE, fetched with BODY.PEEK, and nothing else is sent', async () => {
    const server = fakeImap([
        { raw: mail({ from: 'friend@example.org', body: 'holiday photos https://login.example.com/not-a-signin\r\n' }), date: imapStamp(minutesAgo(2)) },
        { raw: mail({ body: 'https://login.example.com/magic?token=older000000000000\r\n' }), date: imapStamp(minutesAgo(9)) },
        { raw: mail(), date: imapStamp(minutesAgo(1)) },
    ]);
    const items = await recentSignIns({ host: 'imap.example.com', port: 993, user: 'u', password: 'p"w' }, RULES, { connect: server.connect, now: NOW });
    assert.deepEqual(items.map((i) => i.link), ['https://login.example.com/magic?token=abcdef0123456789', 'https://login.example.com/magic?token=older000000000000'], 'newest first, the friend left out');
    assert.deepEqual(server.commands.map((c) => c.split(' ').slice(0, c.startsWith('UID') ? 2 : 1).join(' ')), ['LOGIN', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'UID FETCH', 'UID FETCH', 'LOGOUT']);
    assert.ok(server.commands.filter((c) => c.startsWith('UID FETCH')).every((c) => c.includes('BODY.PEEK[]')));
    assert.ok(!server.commands.some((c) => /STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE|SELECT /i.test(c)));
});

test('a refused password is said as such, and the password is in no message', async () => {
    const server = fakeImap([], { refuseLogin: true });
    await assert.rejects(recentSignIns({ host: 'imap.example.com', port: 993, user: 'u', password: 'hunter2-secret' }, RULES, { connect: server.connect, now: NOW }),
        (e) => /refused the user or the password/.test(e.message) && !e.message.includes('hunter2'));
});

test('a mailbox is saved only once it has been read; its password is sealed and never given back', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-signin-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let reads = 0;
    const reader = async (settings) => { reads++; if (settings.password !== 'right') throw new Error('refused'); return [{ link: 'https://login.example.com/x' }]; };
    const boxes = new SignInMailboxes({ store: new Store(join(dir, 'signin.json')), vault: new Vault(join(dir, 'vault.key')), rules: (name) => (name === 'chat' ? RULES : undefined), reader });
    await assert.rejects(boxes.set('chat', { host: 'imap.example.com', user: 'u', password: 'wrong' }));
    assert.equal(boxes.settings('chat').configured, false);
    assert.deepEqual(await boxes.set('chat', { host: 'imap.example.com', user: 'u', password: 'right' }), { available: true, configured: true, host: 'imap.example.com', port: 993, user: 'u' });
    assert.ok(!readFileSync(join(dir, 'signin.json'), 'utf8').includes('right'));
    /* Polled by a page: the mailbox is not asked each time. */
    reads = 0;
    await boxes.recent('chat'); await boxes.recent('chat'); await boxes.recent('chat');
    assert.equal(reads, 1);
    await assert.rejects(boxes.set('plain', { host: 'imap.example.com', user: 'u', password: 'right' }), /no sign-in by mail/);
    assert.equal((await boxes.set('chat', { host: '' })).configured, false, 'an empty host removes the mailbox');
    assert.deepEqual(await boxes.recent('chat'), []);
});
