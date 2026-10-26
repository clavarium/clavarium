/* The one IMAP verb added for OAuth: AUTHENTICATE XOAUTH2. A scripted socket
 * stands in for the server -- no network. The happy path answers the tag with
 * OK; the failure path sends a `+ <base64 error>` challenge and waits for an
 * empty line before the tagged NO, which is the case the method must not hang on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Exchange } from '../server/imap.mjs';

/* A socket whose `script(text, nth)` returns the bytes to answer each write with
   (or null for silence). Replies arrive on a later tick, as a network's would. */
function scripted(script) {
    const s = new EventEmitter();
    s.destroy = () => {};
    const writes = [];
    s.write = (text) => {
        writes.push(text);
        const reply = script(text, writes.length);
        if (reply != null) setImmediate(() => s.emit('data', Buffer.from(reply)));
    };
    setImmediate(() => s.emit('data', Buffer.from('* OK ready\r\n')));
    return { s, writes };
}

test('authenticateXoauth2: the token goes inline and an OK is accepted', async () => {
    const { s, writes } = scripted((text) => (text.startsWith('c1 AUTHENTICATE XOAUTH2 ') ? 'c1 OK authenticated\r\n' : null));
    const ex = new Exchange(s, 1_000_000);
    await ex.greeting();
    const lines = await ex.authenticateXoauth2('BASE64TOKEN', 'the token was refused');
    assert.ok(writes.some((w) => w.includes('AUTHENTICATE XOAUTH2 BASE64TOKEN')), 'the token is the SASL initial response');
    assert.ok(/ OK/i.test(lines.at(-1) ?? ''), 'OK accepted');
});

test('authenticateXoauth2: a "+" error challenge is finished with an empty line, then refused (no hang)', async () => {
    const { s, writes } = scripted((text) => {
        if (text.startsWith('c1 AUTHENTICATE XOAUTH2 ')) return '+ eyJzdGF0dXMiOiI0MDEifQ==\r\n';  /* base64 error, tag not sent yet */
        if (text === '\r\n') return 'c1 NO AUTHENTICATE failed\r\n';                                /* only after we answer the challenge */
        return null;
    });
    const ex = new Exchange(s, 1_000_000);
    await ex.greeting();
    await assert.rejects(ex.authenticateXoauth2('BAD', 'the token was refused'), /the token was refused/);
    assert.ok(writes.includes('\r\n'), 'the empty line is sent to finish the SASL exchange');
});
