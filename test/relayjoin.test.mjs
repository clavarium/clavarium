/* ANOTHER HOME JOINS THIS MACHINE'S RELAY (server/relayjoin.mjs): what the public route lets through to
   the host program, what it answers, and how often. The code itself is checked by root (online.test). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { RelayJoin, handleRelayJoin, RELAY_JOIN_PATH, PER_MINUTE } from '../server/relayjoin.mjs';

const BODY = `AAAAC3NzaC1lZDI1NTE5AAAAI${'B'.repeat(43)}`;
const KEY = `ssh-ed25519 ${BODY}`;
const PRINT = `SHA256:${'Q'.repeat(43)}`;
const ANSWER = { name: 'clav2.example.com', relay: { host: 'relay.example.net', port: 22, fingerprint: PRINT }, ports: { tls: 8444, http: 8081 } };

function joiner(answer = { code: 0, stdout: `${JSON.stringify(ANSWER)}\n`, stderr: '' }) {
    const asked = []; let t = 0;
    const j = new RelayJoin({ host: async (argv) => { asked.push(argv); return typeof answer === 'function' ? answer(argv) : answer; }, now: () => t });
    return { j, asked, later: (ms) => { t += ms; } };
}

test('a code and a public key go to the host program, in its exact form; the answer is rebuilt field by field', async () => {
    const { j, asked } = joiner({ code: 0, stdout: `${JSON.stringify({ ...ANSWER, secret: 'x', relay: { ...ANSWER.relay, key: 'PRIVATE' } })}\n`, stderr: '' });
    const r = await j.join(JSON.stringify({ code: 'abcd-efgh', key: `${KEY} clavarium-tunnel` }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, ANSWER, 'nothing but the name, the relay\'s address and fingerprint, two ports');
    assert.deepEqual(asked, [['relay', 'join', 'ABCDEFGH', 'ssh-ed25519', BODY]], 'the comment of the key dropped');
});

test('anything but a code and a public key is refused before the host program; a refused code is 403, said the same for all', async () => {
    const { j, asked, later } = joiner({ code: 78, stdout: '', stderr: 'REFUSED: not a valid code' });
    const tries = [
        ['nope', 400], [JSON.stringify([1]), 400], [JSON.stringify({ code: 'ABCDEFGH' }), 400],
        [JSON.stringify({ code: 'ABCDEFGH', key: KEY, name: 'x.example.com' }), 400],
        [JSON.stringify({ code: 'ABCDEFG0', key: KEY }), 403], [JSON.stringify({ code: 7, key: KEY }), 403],
        [JSON.stringify({ code: 'ABCDEFGH', key: 'ssh-rsa AAAA' }), 400],
        [JSON.stringify({ code: 'ABCDEFGH', key: '-----BEGIN OPENSSH PRIVATE KEY-----' }), 400],
        [JSON.stringify({ code: 'ABCDEFGH', key: `${KEY}\nssh-ed25519 ${BODY}` }), 400],
    ];
    for (const [text, status] of tries) { later(61_000); assert.equal((await j.join(text)).status, status, text); }
    assert.equal(asked.length, 0);
    later(61_000);
    const refused = await j.join(JSON.stringify({ code: 'ABCDEFGH', key: KEY }));
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /not valid: wrong, used or expired/);
    assert.deepEqual(Object.keys(refused.body), ['error']);
});

test(`at most ${PER_MINUTE} tries a minute, from everybody together`, async () => {
    const { j, asked, later } = joiner({ code: 78, stdout: '', stderr: '' });
    const body = JSON.stringify({ code: 'ABCDEFGH', key: KEY });
    for (let i = 0; i < PER_MINUTE; i++) assert.equal((await j.join(body)).status, 403);
    assert.equal((await j.join(body)).status, 429);
    assert.equal(asked.length, PER_MINUTE, 'the host program not asked past the limit');
    later(61_000);
    assert.equal((await j.join(body)).status, 403);
});

test('a relay that fails, or answers something odd: 502, nothing of it passed on', async () => {
    for (const answer of [{ code: 1, stdout: '', stderr: 'the relay did not add it: secret detail' }, { code: 0, stdout: 'not json', stderr: '' },
        { code: 0, stdout: JSON.stringify({ ...ANSWER, ports: { tls: 22, http: 8081 } }), stderr: '' }]) {
        const r = await joiner(answer).j.join(JSON.stringify({ code: 'ABCDEFGH', key: KEY }));
        assert.equal(r.status, 502);
        assert.ok(!JSON.stringify(r.body).includes('secret'));
    }
});

test('the route: POST only, small bodies, under /c/ (no sign-in, the code is the right), wired in the server', async (t) => {
    const { j } = joiner();
    const server = createServer((q, s) => handleRelayJoin(q, s, j));
    await new Promise((r) => server.listen(0, ['127', '0', '0', '1'].join('.'), r));
    t.after(() => server.close());
    const at = `http://${['127', '0', '0', '1'].join('.')}:${server.address().port}${RELAY_JOIN_PATH}`;
    assert.equal((await fetch(at)).status, 405);
    assert.equal((await fetch(at, { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
    const ok = await fetch(at, { method: 'POST', body: JSON.stringify({ code: 'ABCD-EFGH', key: KEY }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(RELAY_JOIN_PATH, '/c/relay-join');
    const main = readFileSync(new URL('../server/main.mjs', import.meta.url), 'utf8');
    assert.ok(main.indexOf('pathname === RELAY_JOIN_PATH') < main.indexOf("door && pathname.startsWith('/c/')"), 'answered before the device door');
    /* The host program takes exactly this form, and runs the root side of it. */
    const host = readFileSync(new URL('../deploy/clavarium-host', import.meta.url), 'utf8');
    assert.match(host, /"relay join"\)[\s\S]*?\[ \$# -eq 3 \] && \[\[ "\$1" =~ \^\[A-HJKMNP-Z2-9\]\{8\}\$ \]\] && \[ "\$2" = "ssh-ed25519" \] && \[\[ "\$3" =~ \^\[A-Za-z0-9\+\/\]\{68\}\$ \]\] \|\| usage\n\s*run "\$UPDATER_NODE" "\$CODE\/current\/app\/deploy\/clavarium\.mjs" relay join "\$1" "\$2 \$3" ;;/);
});
