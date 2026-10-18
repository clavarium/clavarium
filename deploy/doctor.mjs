/* `sudo clavarium doctor [--fix]`: WHAT WORKS AND WHAT DOES NOT, each problem
 * with what to do about it. Run at the end of `clavarium online` too.
 *
 *   the services (clavarium; in server mode the edge: caddy, dex, oauth2-proxy,
 *   and the tunnel behind a relay), the domain's address, and the certificate
 *   the front actually serves: a public one, valid, not about to expire.
 *
 * --fix does only what is safe and undoes nothing of the operator's: it starts
 * a service that is down, and a certificate that is not a public one (made by
 * Caddy itself when Let's Encrypt could not be reached: its fallback, so the
 * site keeps answering) is dropped so that Caddy asks Let's Encrypt again.
 * The same is done by itself every 20 minutes (--certificate, from a timer).
 *
 * A password lost: `sudo clavarium password EMAIL` makes a new one (Dex's
 * static password of that administrator), shown once.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';

export const DOCTOR_PATHS = {
    unit: '/etc/systemd/system/clavarium.service',
    relayConf: '/etc/clavarium/relay.conf',
    caddyfile: '/etc/caddy/Caddyfile',
    caddyData: '/var/lib/caddy/caddy',
    dexConf: '/etc/dex/config.yaml',
    caddy: '/usr/local/bin/caddy',
    systemd: '/etc/systemd/system',
};
const EMAIL = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
export const domainOf = (P) => /--public-origin https:\/\/(\S+)/.exec(read(P.unit) ?? '')?.[1] ?? null;
const relayOf = (P) => /^HOST=(\S+)$/m.exec(read(P.relayConf) ?? '')?.[1] ?? null;

async function active(sys, unit) {
    const r = await sys.run(['systemctl', 'is-active', unit]);
    return r.out.trim() === 'active';
}

/* What the front serves for the domain, read on the loopback: issuer, end, verified or not. */
export async function servedCert(sys, domain) {
    const r = await sys.run(['openssl', 's_client', '-connect', '127.0.0.1:443', '-servername', domain, '-verify_hostname', domain, '-showcerts'], { input: '' });
    const pem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(r.out)?.[0];
    if (!pem) return { none: true, why: (r.err || r.out).trim().split('\n').filter(Boolean).pop() ?? 'nothing answers on 443' };
    const x = await sys.run(['openssl', 'x509', '-noout', '-issuer', '-enddate'], { input: pem });
    const issuer = /issuer=\s*(.*)/.exec(x.out)?.[1]?.trim() ?? '?';
    const end = Date.parse(/notAfter=(.*)/.exec(x.out)?.[1] ?? '');
    const code = /Verify return code: (\d+) \(([^)]*)\)/.exec(r.out);
    return { issuer, end, verified: code?.[1] === '0', why: code?.[2] ?? 'not verified', local: /Caddy Local Authority/i.test(issuer) };
}

/* The last error Caddy logged, in plain words. */
async function caddyError(sys) {
    const r = await sys.run(['journalctl', '-u', 'caddy', '-n', '300', '-o', 'cat', '--no-pager']);
    const lines = r.out.split('\n').filter((l) => /"level":"error"/.test(l));
    if (!lines.length) return null;
    try { const j = JSON.parse(lines.at(-1)); return [j.msg, j.error].filter(Boolean).join(': ').slice(0, 300); } catch { return lines.at(-1).slice(0, 300); }
}

/* Each check: { what, ok, detail, fix (words), repair (what --fix does) }. */
export async function diagnose(sys, P = DOCTOR_PATHS) {
    const checks = [];
    const add = (c) => { checks.push(c); return c; };
    const domain = domainOf(P);
    const relay = domain ? relayOf(P) : null;
    const units = ['clavarium', ...(domain ? ['caddy', 'dex', 'oauth2-proxy'] : []), ...(relay ? ['clavarium-tunnel'] : [])];
    for (const u of units) {
        const ok = await active(sys, u);
        add({ what: `service ${u}`, ok, detail: ok ? 'running' : 'not running', fix: `sudo systemctl restart ${u}; to see why: journalctl -u ${u} -n 50`, repair: ok ? null : 'restart', unit: u });
    }
    if (!domain) { add({ what: 'mode', ok: true, detail: 'local (this machine only): no certificate, no sign-in' }); return checks; }

    const addrs = await sys.resolve(domain);
    const want = !relay ? null : /^[0-9.]+$/.test(relay) ? [relay] : await sys.resolve(relay);
    const dnsOk = addrs.length > 0 && (!want || !want.length || addrs.some((a) => want.includes(a)));
    add({ what: `the name ${domain}`, ok: dnsOk, detail: addrs.length ? `leads to ${addrs.join(', ')}` : 'leads nowhere',
        fix: relay ? `make ${domain} lead to the relay (${want?.join(', ') || relay}) at your DNS host` : `make ${domain} lead to this machine at your DNS host` });

    const c = await servedCert(sys, domain);
    const days = Number.isFinite(c.end) ? Math.floor((c.end - sys.now()) / 86_400_000) : null;
    if (c.none) {
        add({ what: 'certificate', ok: false, detail: c.why, fix: 'sudo systemctl restart caddy', repair: 'restart', unit: 'caddy' });
    } else if (c.local || !c.verified) {
        const err = await caddyError(sys);
        add({ what: 'certificate', ok: false,
            detail: `${c.local ? 'made by Caddy itself, not by Let\'s Encrypt: browsers warn' : `not valid (${c.why})`}; issuer ${c.issuer}${err ? `. Caddy's last error: ${err}` : ''}`,
            fix: `check that ${domain} leads ${relay ? 'to the relay' : 'here'} and that port 80 reaches it, then: sudo clavarium doctor --fix (Caddy asks Let's Encrypt again; this is also tried by itself every 20 minutes)`,
            repair: 'certificate' });
    } else {
        add({ what: 'certificate', ok: days === null || days >= 10, detail: `from ${c.issuer}${days === null ? '' : `, ${days} days left`}`,
            fix: 'Caddy renews it by itself 30 days ahead; it has not: journalctl -u caddy -n 100, then sudo clavarium doctor --fix', repair: days !== null && days < 10 ? 'certificate' : null });
    }
    return checks;
}

export function report(sys, checks) {
    const bad = checks.filter((c) => !c.ok);
    sys.print('');
    sys.print(`Diagnosis: ${bad.length ? `${bad.length} problem${bad.length > 1 ? 's' : ''}` : 'everything works'}`);
    for (const c of checks) {
        sys.print(`  ${c.ok ? 'ok ' : 'NO '} ${c.what}: ${c.detail}`);
        if (!c.ok && c.fix) sys.print(`       what to do: ${c.fix}`);
    }
    return bad.length;
}

/* The certificate again from Let's Encrypt: the one Caddy made itself (its
   fallback when Let's Encrypt could not be reached) is dropped and Caddy
   restarted, so it asks Let's Encrypt again -- and falls back again if it still
   fails: the site keeps answering, with a warning, never down. */
async function renewCertificate(sys, P) {
    const domain = domainOf(P);
    const local = `${P.caddyData}/certificates/local/${domain}`;
    if (domain && existsSync(local)) { rmSync(local, { recursive: true, force: true }); sys.print('   the certificate made by Caddy itself: dropped'); }
    await sys.run(['systemctl', 'restart', 'caddy']);
    sys.print('   Caddy restarted: it asks Let\'s Encrypt now');
}

/* `clavarium doctor --certificate`, every 20 minutes (clavarium-certificate.timer):
   a certificate Caddy made itself is replaced by Let's Encrypt's as soon as it can.
   Nothing is done while the certificate is a public one. 3 tries an hour at most:
   under Let's Encrypt's limit of 5 failed validations an hour. */
export async function certificateWatch(sys, P = DOCTOR_PATHS) {
    const domain = domainOf(P);
    if (!domain) return 0;
    const c = await servedCert(sys, domain);
    if (!c.none && !c.local) return 0;
    sys.print(`${domain}: ${c.none ? 'no certificate served' : 'a certificate made by Caddy itself'}: asking Let's Encrypt again`);
    await renewCertificate(sys, P);
    return 0;
}

/* The timer of certificateWatch. Written by install.sh, and by doctor --fix on a
   machine installed before it existed (an update does not rerun install.sh). */
export const WATCH_SERVICE = `[Unit]
Description=Clavarium - a certificate made by Caddy itself is replaced by Let's Encrypt's
After=caddy.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/clavarium doctor --certificate
`;
export const WATCH_TIMER = `[Unit]
Description=Clavarium - the certificate, every 20 minutes

[Timer]
OnBootSec=10min
OnUnitActiveSec=20min

[Install]
WantedBy=timers.target
`;
export async function installWatch(sys, P = DOCTOR_PATHS) {
    const svc = `${P.systemd}/clavarium-certificate.service`; const tim = `${P.systemd}/clavarium-certificate.timer`;
    if (read(svc) === WATCH_SERVICE && read(tim) === WATCH_TIMER) return false;
    writeFileSync(svc, WATCH_SERVICE); writeFileSync(tim, WATCH_TIMER);
    await sys.run(['systemctl', 'daemon-reload']);
    await sys.run(['systemctl', 'enable', '--now', '--quiet', 'clavarium-certificate.timer']);
    return true;
}

export async function doctor(sys, { fix = false } = {}, P = DOCTOR_PATHS) {
    let checks = await diagnose(sys, P);
    let bad = report(sys, checks);
    if (!bad) return 0;
    const repairs = checks.filter((c) => !c.ok && c.repair);
    if (!fix) { if (repairs.length) sys.print('To repair what can be: sudo clavarium doctor --fix'); return bad; }
    sys.print('');
    sys.print('Repairing:');
    if (domainOf(P) && await installWatch(sys, P)) sys.print('   the certificate is now checked every 20 minutes (clavarium-certificate.timer)');
    for (const c of repairs) {
        if (c.repair === 'restart') { await sys.run(['systemctl', 'restart', c.unit]); sys.print(`   ${c.unit}: restarted`); }
        if (c.repair === 'certificate') await renewCertificate(sys, P);
    }
    if (!repairs.length) { sys.print('   nothing this command can repair: see "what to do" above'); return bad; }
    /* Let's Encrypt answers in seconds when all is well. */
    for (let i = 0; i < 12; i += 1) {
        await sys.sleep(10_000);
        checks = await diagnose(sys, P);
        if (checks.every((c) => c.ok)) break;
    }
    return report(sys, checks);
}

/* `sudo clavarium password EMAIL`: a new password for that administrator, shown once. */
export async function newPassword(sys, email, P = DOCTOR_PATHS) {
    if (!EMAIL.test(String(email ?? ''))) throw new Error('usage: sudo clavarium password EMAIL');
    const conf = read(P.dexConf);
    if (!conf) throw new Error('no administrators on this machine: it is in local mode (no sign-in)');
    const at = conf.indexOf(`  - email: "${email}"\n    hash: "`);
    if (at < 0) throw new Error(`${email} is not an administrator here`);
    const pw = (await sys.run(['openssl', 'rand', '-base64', '18'])).out.trim().replace(/\+/g, '-').replace(/\//g, '_');
    if (pw.length < 20) throw new Error('no random password could be made');
    const hash = (await sys.run([P.caddy, 'hash-password'], { input: `${pw}\n` })).out.trim();
    if (!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(hash)) throw new Error('the password could not be hashed');
    const start = at + `  - email: "${email}"\n    hash: "`.length;
    const next = conf.slice(0, start) + hash + conf.slice(conf.indexOf('"', start));
    writeFileSync(`${P.dexConf}.new`, next, { mode: 0o640 });
    await sys.run(['chown', 'root:dex', `${P.dexConf}.new`]);
    renameSync(`${P.dexConf}.new`, P.dexConf);
    await sys.run(['systemctl', 'restart', 'dex']);
    sys.print(`New password for ${email} (shown ONCE, kept nowhere in clear):`);
    sys.print(`    ${pw}`);
}
