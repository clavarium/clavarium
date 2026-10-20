/* The certificate the front serves, read as a browser does: a real TLS server here, with a certificate of its own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { served, Certificate, ALERT_DAYS } from '../server/certificate.mjs';

function selfSigned(t, days) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-cert-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', String(days), '-subj', '/O=Test Authority/CN=clav.example.com', '-addext', 'subjectAltName=DNS:clav.example.com']);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
}

test('what the front serves: its issuer, its end, how many days are left, and whether a browser would trust it', async (t) => {
    const server = tls.createServer(selfSigned(t, 30), (s) => s.end());
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => server.close());
    const c = await served('clav.example.com', { port: server.address().port });
    assert.equal(c.domain, 'clav.example.com');
    assert.match(c.issuer, /Test Authority/);
    assert.ok(c.daysLeft >= 29 && c.daysLeft <= 30, String(c.daysLeft));
    assert.equal(c.trusted, false, 'its own authority: not trusted');
    assert.match(c.why, /SELF_SIGNED|self.signed/i);
    assert.equal(c.local, false);
    const none = await served('clav.example.com', { port: 1 });
    assert.equal(none.none, true);
});

test('said once an hour at most, nothing in local mode; the owner is told once a day when it is not trusted or ends soon', async () => {
    let clock = 1_000_000_000_000; const told = []; let looks = 0;
    let answer = { domain: 'clav.example.com', issuer: "Let's Encrypt, R11", validTo: new Date(clock + 60 * 86_400_000).toISOString(), daysLeft: 60, trusted: true, why: '', local: false };
    const cert = new Certificate({ origin: 'https://clav.example.com', alerts: { tell: async (m) => { told.push(m); } }, look: async () => { looks += 1; return answer; }, now: () => clock });
    assert.equal((await cert.about()).daysLeft, 60);
    await cert.about(); assert.equal(looks, 1, 'kept for an hour');
    assert.equal(told.length, 0, 'all is well: nothing said');
    answer = { ...answer, daysLeft: ALERT_DAYS - 1 };
    clock += 3600_001; await cert.about();
    assert.equal(told.length, 1); assert.match(told[0].body, /ends in 9 day\(s\)/);
    clock += 3600_001; await cert.about();
    assert.equal(told.length, 1, 'once a day');
    clock += 24 * 3600_000; await cert.about({ fresh: true });
    assert.equal(told.length, 2);
    assert.deepEqual(await new Certificate({ origin: undefined }).about(), { local: true });
    assert.deepEqual(await new Certificate({ origin: 'http://127.0.0.1:7717' }).about(), { local: true });
});
