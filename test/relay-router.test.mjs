/* THE RELAY'S ROUTER (written by relay/clavarium-relay), on real sockets on this machine: two homes,
   A and B, TLS servers with certificates of their own, behind the router. The name asked for leads to
   its home; an unknown name, or none, leads nowhere; the bytes go through untouched (the certificate
   seen is the home's, a megabyte comes back the same). The router itself is the text the program
   writes on the relay, taken from it here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer as tlsServer, connect as tlsConnect } from 'node:tls';
import { createServer as tcpServer, connect as tcpConnect } from 'node:net';
import { randomBytes, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROGRAM = new URL('../relay/clavarium-relay', import.meta.url);
const LOOPBACK = ['127', '0', '0', '1'].join('.');

function routerSource() {
    const m = /<<'ROUTER'\n([\s\S]*?)\nROUTER\n/.exec(readFileSync(PROGRAM, 'utf8'));
    assert.ok(m, 'the router is in the program');
    return m[1];
}
function certFor(dir, name) {
    const keyFile = join(dir, `${name}.key`); const certFile = join(dir, `${name}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
        '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}
const listen = (server) => new Promise((resolve) => server.listen(0, LOOPBACK, () => resolve(server.address().port)));

/* A home: TLS that answers "<who>:" then echoes; HTTP that says who it is and what Host it got. */
async function home(dir, name, who) {
    const pair = certFor(dir, name);
    const tls = tlsServer({ ...pair }, (s) => { s.write(`${who}:`); s.pipe(s); });
    const http = tcpServer((s) => {
        let head = '';
        s.on('data', (d) => {
            head += d;
            if (head.includes('\r\n\r\n')) {
                const host = /^host: *(\S+)/im.exec(head)?.[1] ?? '';
                const body = `${who} ${host}\n`;
                s.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
            }
        });
    });
    return { ...pair, tls, http, tlsPort: await listen(tls), httpPort: await listen(http) };
}

async function startRouter(dir, list) {
    const file = join(dir, 'router.js'); const homes = join(dir, 'homes');
    writeFileSync(file, routerSource());
    writeFileSync(homes, list);
    const child = spawn(process.execPath, [file, '--homes', homes, '--tls', '0', '--http', '0', '--bind', LOOPBACK], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ports = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => { out += d; const m = /tls (\d+), http (\d+)/.exec(out); if (m) resolve({ tls: +m[1], http: +m[2] }); });
        child.on('exit', (code) => reject(new Error(`the router stopped (${code})`)));
    });
    return { child, homes, ...ports };
}

/* A TLS client asking for `servername`, trusting `ca` only. */
function ask(port, servername, ca, payload = Buffer.from('ping'), { anyName = !servername } = {}) {
    return new Promise((resolve) => {
        const chunks = [];
        const s = tlsConnect({ host: LOOPBACK, port, servername, ca, ...(anyName ? { checkServerIdentity: () => undefined } : {}) });
        let cert = null;
        s.on('secureConnect', () => { cert = s.getPeerX509Certificate?.() ?? null; s.write(payload); });
        s.on('data', (d) => { chunks.push(d); if (Buffer.concat(chunks).length >= payload.length + 2) s.end(); });
        s.on('error', (e) => resolve({ error: e.code || e.message, cert }));
        s.on('close', () => resolve({ data: Buffer.concat(chunks), cert }));
        s.setTimeout(5000, () => s.destroy(new Error('timeout')));
    });
}
function httpAsk(port, host) {
    return new Promise((resolve) => {
        let got = '';
        const s = tcpConnect(port, LOOPBACK, () => s.write(`GET /.well-known/acme-challenge/x HTTP/1.1\r\n${host ? `Host: ${host}\r\n` : ''}User-Agent: test\r\n\r\n`));
        s.on('data', (d) => { got += d; });
        s.on('close', () => resolve(got));
        s.on('error', () => resolve(got));
        s.setTimeout(5000, () => s.destroy());
    });
}

test('the router: each name to its home, untouched; an unknown name nowhere; a home added is found at once', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clavarium-router-'));
    const a = await home(dir, 'a.example.com', 'A');
    const b = await home(dir, 'b.example.com', 'B');
    const r = await startRouter(dir, `# the list\na.example.com ${a.tlsPort} ${a.httpPort} ssh-ed25519 x\nb.example.com,www.b.example.com ${b.tlsPort} ${b.httpPort} ssh-ed25519 y\n`);
    t.after(() => { r.child.kill(); for (const x of [a, b]) { x.tls.close(); x.http.close(); } rmSync(dir, { recursive: true, force: true }); });

    /* A reaches A, B reaches B: the certificate seen is the home's own (the relay holds none). */
    const toA = await ask(r.tls, 'a.example.com', a.cert);
    assert.equal(toA.error, undefined, String(toA.error));
    assert.equal(toA.data.toString(), 'A:ping');
    assert.equal(toA.cert.fingerprint256, new X509Certificate(a.cert).fingerprint256);
    const toB = await ask(r.tls, 'b.example.com', b.cert);
    assert.equal(toB.data.toString(), 'B:ping');
    assert.equal(toB.cert.fingerprint256, new X509Certificate(b.cert).fingerprint256);
    assert.equal((await ask(r.tls, 'www.b.example.com', b.cert, Buffer.from('x'), { anyName: true })).cert?.fingerprint256, new X509Certificate(b.cert).fingerprint256, 'a second name of B');
    assert.equal((await ask(r.tls, 'A.EXAMPLE.COM', a.cert)).data?.toString(), 'A:ping', 'names are not case-sensitive');

    /* The bytes, untouched both ways: a megabyte of random bytes comes back as it went. */
    const big = randomBytes(1024 * 1024);
    const echoed = await ask(r.tls, 'a.example.com', a.cert, big);
    assert.ok(echoed.data.subarray(2).equals(big), 'a megabyte, the same');

    /* A name the router does not know, or none: closed before any certificate, never a default home. */
    for (const name of ['c.example.com', 'example.com', undefined]) {
        const no = await ask(r.tls, name, a.cert, undefined, { anyName: true });
        assert.ok(no.error, `${name}: refused`);
        assert.equal(no.cert, null, `${name}: no certificate shown`);
    }
    /* Not TLS at all on 443: closed. */
    assert.equal(await httpAsk(r.tls, 'a.example.com'), '');

    /* Port 80: by the Host line; an unknown one answered 421. */
    assert.match(await httpAsk(r.http, 'a.example.com'), /^HTTP\/1\.1 200 OK[\s\S]*\r\n\r\nA a\.example\.com\n$/);
    assert.match(await httpAsk(r.http, 'b.example.com:80'), /\r\n\r\nB b\.example\.com:80\n$/, 'with a port, to B, the request as it was');
    assert.match(await httpAsk(r.http, 'c.example.com'), /^HTTP\/1\.1 421 Misdirected Request/);
    assert.match(await httpAsk(r.http, ''), /^HTTP\/1\.1 421 Misdirected Request/);

    /* A home added to the list: found without a restart. One gone: nowhere. */
    const c = await home(dir, 'c.example.com', 'C');
    t.after(() => { c.tls.close(); c.http.close(); });
    writeFileSync(`${r.homes}.new`, `a.example.com ${a.tlsPort} ${a.httpPort} ssh-ed25519 x\nc.example.com ${c.tlsPort} ${c.httpPort} ssh-ed25519 z\n`);
    execFileSync('mv', ['-f', `${r.homes}.new`, r.homes]);
    assert.equal((await ask(r.tls, 'c.example.com', c.cert)).data?.toString(), 'C:ping');
    assert.ok((await ask(r.tls, 'b.example.com', b.cert)).error, 'B removed: refused');

    /* A home in the list whose tunnel is down: 80 says so, 443 closes. */
    c.http.close(); c.tls.close();
    await new Promise((res) => setTimeout(res, 50));
    assert.match(await httpAsk(r.http, 'c.example.com'), /^HTTP\/1\.1 502 Bad Gateway/);
    assert.ok((await ask(r.tls, 'c.example.com', c.cert)).error);
});

test('the router: a first message cut into pieces is waited for; one that never ends is dropped', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clavarium-router-'));
    const a = await home(dir, 'a.example.com', 'A');
    const r = await startRouter(dir, `a.example.com ${a.tlsPort} ${a.httpPort} ssh-ed25519 x\n`);
    t.after(() => { r.child.kill(); a.tls.close(); a.http.close(); rmSync(dir, { recursive: true, force: true }); });
    /* The HTTP head one byte at a time. */
    const got = await new Promise((resolve) => {
        let out = '';
        const s = tcpConnect(r.http, LOOPBACK, async () => {
            for (const ch of 'GET / HTTP/1.1\r\nHost: a.example.com\r\n\r\n') { s.write(ch); await new Promise((res) => setTimeout(res, 2)); }
        });
        s.on('data', (d) => { out += d; }); s.on('close', () => resolve(out));
    });
    assert.match(got, /\r\n\r\nA a\.example\.com\n$/);
    /* Garbage that looks like a start of TLS and never finishes, past the limit: closed. */
    const closed = await new Promise((resolve) => {
        const s = tcpConnect(r.tls, LOOPBACK, () => { s.write(Buffer.from([22, 3, 1, 0xff, 0xff])); s.write(Buffer.alloc(70_000)); });
        s.on('close', () => resolve(true)); s.on('error', () => {});
        s.setTimeout(5000, () => { s.destroy(); resolve(false); });
    });
    assert.ok(closed);
});
