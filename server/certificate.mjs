/* THE CERTIFICATE THIS SITE SERVES, as a browser gets it: asked of the front
 * itself (Caddy, on this machine), by its public name, so that what is said is
 * what a visitor is given -- never a file read on the disk, which this server
 * may not read and which may not be the one served.
 *
 *   { domain, issuer, validTo, daysLeft, trusted, why, local }
 *   trusted  a browser accepts it (a known authority, the right name, in date)
 *   local    Caddy's own authority: the site answers, with a warning, until
 *            Let's Encrypt gives one (sudo clavarium doctor --certificate)
 *
 * Looked at once an hour at most; the owner is told, once a day, when it is
 * not trusted or ends within ALERT_DAYS (its renewal should have happened).
 */
import tls from 'node:tls';

export const ALERT_DAYS = 10;
const EVERY_MS = 3600_000;
const ALERT_EVERY_MS = 24 * 3600_000;

/* What the front serves for `domain`, or { none, why }. */
export function served(domain, { host = '127.0.0.1', port = 443, connect = tls.connect, now = Date.now, timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const end = (value) => { if (done) return; done = true; try { socket.destroy(); } catch { /* gone */ } resolve(value); };
        const socket = connect({ host, port, servername: domain, rejectUnauthorized: false, timeout: timeoutMs }, () => {
            const cert = socket.getPeerCertificate();
            if (!cert || !cert.valid_to) { end({ domain, none: true, why: 'no certificate was served' }); return; }
            const validTo = new Date(cert.valid_to);
            const issuer = [cert.issuer?.O, cert.issuer?.CN].filter(Boolean).join(', ') || '?';
            end({
                domain, issuer, validTo: validTo.toISOString(),
                daysLeft: Math.floor((validTo.getTime() - now()) / 86_400_000),
                trusted: socket.authorized === true,
                why: socket.authorized ? '' : String(socket.authorizationError ?? 'not trusted'),
                local: /Caddy Local Authority/i.test(issuer),
            });
        });
        socket.on('timeout', () => end({ domain, none: true, why: `nothing answered on ${port} in time` }));
        socket.on('error', (error) => end({ domain, none: true, why: error.code === 'ECONNREFUSED' ? `nothing answers on ${port}` : String(error.message ?? error) }));
    });
}

export class Certificate {
    #domain; #look; #alerts; #now; #last = null; #at = 0; #alertedAt = 0;
    /* `origin`: the public address (none in local mode: nothing to say). */
    constructor({ origin, alerts, look = (domain) => served(domain), now = Date.now }) {
        this.#domain = origin && origin.startsWith('https:') ? new URL(origin).hostname : null;
        this.#look = look; this.#alerts = alerts; this.#now = now;
    }
    /* For the page: { local: true } in local mode, else what the front serves. */
    async about({ fresh = false } = {}) {
        if (!this.#domain) return { local: true };
        if (fresh || !this.#last || this.#now() - this.#at > EVERY_MS) {
            this.#last = await this.#look(this.#domain).catch((error) => ({ domain: this.#domain, none: true, why: String(error?.message ?? error) }));
            this.#at = this.#now();
            this.#warn(this.#last);
        }
        return this.#last;
    }
    #warn(c) {
        const bad = c.none || !c.trusted || c.daysLeft < ALERT_DAYS;
        if (!bad || !this.#alerts || this.#now() - this.#alertedAt < ALERT_EVERY_MS) return;
        this.#alertedAt = this.#now();
        const body = c.none ? `No certificate: ${c.why}.` : !c.trusted ? `Browsers do not trust it: ${c.why}.` : `It ends in ${c.daysLeft} day(s) and was not renewed.`;
        void this.#alerts.tell({ title: `The certificate of ${c.domain}`, body, url: '/?open=settings&at=updates' })?.catch?.(() => {});
    }
}
