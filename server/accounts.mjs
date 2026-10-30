/* CONNECTING AN ACCOUNT BY TOKEN: a mailbox, a calendar, an address book of a
 * Google or Microsoft account, reached live through Tether -- not copied into a
 * folder (that is the older mailbox.mjs, kept until this replaces it).
 *
 * THE TOKEN NEVER ENTERS A MACHINE. The person allows the account in their own
 * browser; the code comes back here; this server trades it for a long-lived
 * refresh token and keeps it as a HOST-ONLY secret (secrets.mjs): a secret that
 * cannot be attached to a conversation, so it is never delivered to a VM. The
 * agent is root in its machine, so a token in the machine would be a token lost;
 * instead the keeper reveals it to the connector alone, host-side, and acts on
 * the agent's behalf within the level and rules the person set.
 *
 * ONE ACCOUNT, ONE TOKEN, SEVERAL TARGETS. A consent for mail+calendar+contacts
 * yields a single refresh token; this makes one host-only secret and a Tether
 * target per kind, each naming that secret. Both providers borrow Thunderbird's
 * own open-source desktop client, verified for all three: Google over IMAP +
 * CalDAV/CardDAV, Microsoft over Microsoft Graph (mail, calendar and contacts).
 *
 * A CLASSIC ACCOUNT (OVH, Infomaniak, Nextcloud... any IMAP/SMTP + CalDAV/CardDAV host)
 * has no token: it signs in with its password. The password is kept the same way, a
 * host-only secret the keeper reveals to the connector alone; each kind is tried live
 * before anything is kept, so a wrong server or password is said at once.
 *
 * A CREATED TARGET IS GIVEN TO NO ONE. The person grants it per conversation, at
 * its own level, from the page (Assets > Access) -- like git: one mailbox, many
 * conversations, each its own rights.
 */
import { Refusal } from './conversations.mjs';
import { createHash } from 'node:crypto';
import { consentUrl, exchangeCode, extractCode, thunderbird, scopeFor, kindsGranted, refreshAccess, pkcePair, newState, PROVIDERS } from './oauth.mjs';

/* The loopback the provider sends the code back to; nothing listens there. The
   person's browser lands on a page that will not load, and they copy the whole
   address -- which carries the code -- back into Clavarium. The same address
   trades the code, so it must match what the borrowed client registered. Both
   borrowed Thunderbird clients (one for Google, one for Microsoft) registered the
   loopback on any 127.0.0.1 port, so one address serves both. */
const REDIRECT = 'http://127.0.0.1:47813/';
const redirectFor = () => REDIRECT;
const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 20;

/* The kinds a provider can be connected for here, with the connector and the
   Tether kind each becomes, and whether the target needs the email address. */
const KIND = {
    mail: { connector: 'mail', kind: 'mail', title: 'Mail', needsUser: true },
    calendar: { connector: 'calendar', kind: 'calendar', title: 'Agenda', needsUser: true },
    contacts: { connector: 'contacts', kind: 'contacts', title: 'Contacts', needsUser: true },
};
/* What each provider's built-in (Thunderbird) client grants a refresh token for. */
const SUPPORTED = { google: ['mail', 'calendar', 'contacts'], microsoft: ['mail', 'calendar', 'contacts'] };

/* Servers of common classic hosts, by the address's domain (what ISPDB lacks: the
   calendar and contacts addresses). */
const CLASSIC = {
    'ovh.net': { imap: 'ssl0.ovh.net', smtp: 'ssl0.ovh.net' },
    'infomaniak.com': { imap: 'mail.infomaniak.com', smtp: 'mail.infomaniak.com', caldav: 'https://sync.infomaniak.com', carddav: 'https://sync.infomaniak.com' },
    'ik.me': { imap: 'mail.infomaniak.com', smtp: 'mail.infomaniak.com', caldav: 'https://sync.infomaniak.com', carddav: 'https://sync.infomaniak.com' },
    'fastmail.com': { imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com', caldav: 'https://caldav.fastmail.com', carddav: 'https://carddav.fastmail.com' },
};
const emailOk = (s) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);
/* A deterministic, valid secret name for an account's token: a short slug of the
   address plus a hash of it, so reconnecting the same account reuses the name
   (its value is replaced) and two different accounts never collide. */
function secretName(provider, user) {
    const slug = user.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 8).replace(/_+$/, '') || 'X';
    const hex = createHash('sha256').update(`${provider}:${user}`).digest('hex').slice(0, 6).toUpperCase();
    return `OAUTH_${provider.toUpperCase()}_${slug}_${hex}`;
}
/* A stable target id per account and kind. */
const targetId = (kind, provider, user) => `${kind}-${provider}-${user.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60);

export class Accounts {
    #secrets; #targets; #fetch; #pending = new Map();

    /* `secrets`: the vault (set host-only, by name). `targets`: { put(spec) } onto
       the Tether store. `fetch`: injected for tests. */
    #probe;
    constructor({ secrets, targets, fetch = globalThis.fetch, probe = null }) {
        if (!secrets?.set) throw new Error('accounts needs the secret store');
        if (!targets?.put) throw new Error('accounts needs the Tether target store');
        this.#secrets = secrets; this.#targets = targets; this.#fetch = fetch; this.#probe = probe;
    }

    /* The servers of a classic address, as far as they can be known: a few common
       hosts, else the public Thunderbird database of mail providers (ISPDB). What
       is not known stays empty for the person to fill. */
    async lookup({ user } = {}) {
        const address = String(user ?? '').trim();
        if (!emailOk(address)) throw new Refusal(400, 'The account needs its email address.');
        const domain = address.split('@')[1].toLowerCase();
        const known = Object.entries(CLASSIC).find(([d]) => domain === d || domain.endsWith(`.${d}`))?.[1];
        const out = { imap: '', smtp: '', caldav: '', carddav: '', ...(known ?? {}) };
        if (!out.imap || !out.smtp) {
            try {
                const r = await this.#fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`);
                if (r.ok) {
                    const xml = await r.text();
                    const servers = (kind) => [...xml.matchAll(new RegExp(`<(incomingServer|outgoingServer) type="${kind}">([\\s\\S]*?)</\\1>`, 'g'))].map((m) => ({ host: /<hostname>([^<]+)</.exec(m[2])?.[1] ?? '', port: /<port>(\\d+)</.exec(m[2])?.[1] ?? '', socket: /<socketType>([^<]+)</.exec(m[2])?.[1] ?? '' }));
                    const imap = servers('imap').find((x) => x.socket === 'SSL') ?? null;
                    const smtp = servers('smtp').find((x) => x.socket === 'STARTTLS') ?? null;
                    if (!out.imap && imap?.host) out.imap = `${imap.host}${imap.port && imap.port !== '993' ? `:${imap.port}` : ''}`;
                    if (!out.smtp && smtp?.host) out.smtp = `${smtp.host}${smtp.port && smtp.port !== '587' ? `:${smtp.port}` : ''}`;
                }
            } catch { /* not known there: the person fills it */ }
        }
        return out;
    }

    /* Connect a classic account: its password kept host-only, a target per kind,
       each tried live first (nothing is kept if one fails). */
    async classic({ user, password, imap, smtp, caldav, carddav, kinds } = {}) {
        const address = String(user ?? '').trim();
        if (!emailOk(address)) throw new Refusal(400, 'The account needs its email address.');
        const secret = String(password ?? '');
        if (!secret) throw new Refusal(400, 'The account needs its password.');
        const wanted = (Array.isArray(kinds) && kinds.length ? kinds : ['mail']).map(String).filter((k) => KIND[k]);
        if (!wanted.length) throw new Refusal(400, 'Choose at least mail, calendar or contacts.');
        const hostPort = (v, what, port) => {
            const m = /^([a-z0-9.-]+\.[a-z]{2,})(?::(\d{1,5}))?$/i.exec(String(v ?? '').trim());
            if (!m) throw new Refusal(400, `The ${what} server is a name like mail.example.com.`);
            return { host: m[1].toLowerCase(), port: Number(m[2] ?? port) };
        };
        const davUrl = (v, what) => {
            let u; try { u = new URL(/^https?:\/\//i.test(String(v ?? '').trim()) ? String(v).trim() : `https://${String(v ?? '').trim()}`); } catch { u = null; }
            if (!u || u.protocol !== 'https:' || !u.hostname.includes('.')) throw new Refusal(400, `The ${what} address is an https address, like https://dav.example.com.`);
            return u.href;
        };
        const name = secretName('classic', address);
        const specs = [];
        for (const k of wanted) {
            const config = { user: address };
            if (k === 'mail') { const i = hostPort(imap, 'mail (IMAP)', 993); const o = hostPort(smtp, 'sending (SMTP)', 587); Object.assign(config, { host: i.host, port: i.port, smtpHost: o.host, smtpPort: o.port }); }
            if (k === 'calendar') config.caldav = davUrl(caldav, 'calendar (CalDAV)');
            if (k === 'contacts') config.carddav = davUrl(carddav, 'contacts (CardDAV)');
            specs.push({ id: targetId(k, 'classic', address), title: `${KIND[k].title} — ${address}`, kind: KIND[k].kind, connector: KIND[k].connector, config, secrets: { password: name } });
        }
        if (this.#probe) for (const t of specs) {
            try { await this.#probe(t, secret); }
            catch (e) { throw new Refusal(400, `${KIND[t.connector === 'mail' ? 'mail' : t.connector].title}: ${String(e?.message ?? e).replace(/^.*?: /, '')}`); }
        }
        this.#secrets.set({ name, value: secret, hostOnly: true });
        const made = specs.map((t) => { const saved = this.#targets.put(t); return { id: saved?.id ?? t.id, title: saved?.title ?? t.title, kind: t.kind }; });
        return { provider: 'classic', user: address, targets: made, authorized: wanted, denied: [] };
    }

    /* Which kinds may be connected, per provider, for the page to offer. */
    supported() { return { ...SUPPORTED }; }

    /* Start a connection: build the provider's consent page for the kinds asked,
       and keep the state and PKCE verifier until the person pastes the address. */
    consent({ provider, user, kinds } = {}) {
        const prov = String(provider ?? '');
        if (!PROVIDERS[prov] || !SUPPORTED[prov]) throw new Refusal(400, 'Choose Google or Microsoft.');
        const address = String(user ?? '').trim();
        if (!emailOk(address)) throw new Refusal(400, 'The account needs its email address.');
        const wanted = (Array.isArray(kinds) && kinds.length ? kinds : ['mail']).map(String);
        const chosen = SUPPORTED[prov].filter((k) => wanted.includes(k));
        if (!chosen.length) throw new Refusal(400, `${PROVIDERS[prov].label} can be connected here for: ${SUPPORTED[prov].join(', ')}.`);
        this.#sweep();
        if (this.#pending.size >= PENDING_MAX) throw new Refusal(429, 'Too many connections in progress; try again shortly.');
        const { clientId } = thunderbird(prov);
        const state = newState();
        const { verifier, challenge } = pkcePair();
        const url = consentUrl(prov, { clientId, redirectUri: redirectFor(prov), scope: scopeFor(prov, chosen), state, codeChallenge: challenge, loginHint: address });
        this.#pending.set(state, { provider: prov, user: address, kinds: chosen, verifier, at: Date.now() });
        return { url };
    }

    /* Finish it: from the pasted address read the code, trade it for a refresh
       token, keep the token host-side, and make a Tether target per kind. */
    async connect({ redirected } = {}) {
        this.#sweep();
        let state;
        try { state = new URL(String(redirected ?? '').trim()).searchParams.get('state'); } catch { throw new Refusal(400, 'Paste the whole address from the bar, after you allow.'); }
        const p = state && this.#pending.get(state);
        if (!p) throw new Refusal(400, 'This connection has expired or was already used; start it again.');
        this.#pending.delete(state);
        let code;
        try { code = extractCode(redirected, { state }); } catch (e) { throw new Refusal(400, e.message); }
        const { clientId, clientSecret } = thunderbird(p.provider);
        let refreshToken, grantedScope;
        try { ({ refreshToken, scope: grantedScope } = await exchangeCode(p.provider, { clientId, clientSecret, redirectUri: redirectFor(p.provider), code, codeVerifier: p.verifier, fetch: this.#fetch })); }
        catch (e) { throw new Refusal(502, `The connection could not be completed: ${e.message}`); }
        if (!refreshToken) throw new Refusal(502, 'The account returned no lasting token; allow offline access and try again.');
        /* What was actually allowed. A provider may grant fewer kinds than asked
           (the person unticks one); the token's scope says so, so we make a target
           only for a kind that was really granted, and tell the caller which were
           denied -- no guessing. If the scope is unreadable (matched nothing) we
           trust what was asked, as before. */
        const matched = kindsGranted(p.provider, grantedScope);
        const useScope = matched.length > 0;
        const authorized = useScope ? p.kinds.filter((k) => matched.includes(k)) : p.kinds;
        const denied = useScope ? p.kinds.filter((k) => !matched.includes(k)) : [];
        /* The token is kept host-only: it can never be attached to a conversation,
           so it is never delivered to a machine -- the keeper reveals it by name. */
        const name = secretName(p.provider, p.user);
        this.#secrets.set({ name, value: refreshToken, hostOnly: true });
        const label = PROVIDERS[p.provider].label;
        const made = [];
        for (const k of authorized) {
            const spec = KIND[k];
            /* Pin the client that minted the token onto the target, so the keeper
               refreshes with the same one -- a refresh token is bound to its client,
               and this keeps a target working even if the built-in default later
               moves (the connector prefers config.clientId over its own default). */
            const config = { provider: p.provider, clientId, authorizedKinds: authorized };
            if (spec.needsUser) config.user = p.user;
            const target = this.#targets.put({
                id: targetId(k, p.provider, p.user),
                title: `${spec.title} — ${p.user} (${label})`,
                kind: spec.kind, connector: spec.connector, config, secrets: { refresh: name },
            });
            made.push({ id: target?.id ?? targetId(k, p.provider, p.user), title: target?.title, kind: spec.kind });
        }
        return { provider: p.provider, user: p.user, targets: made, authorized, denied };
    }

    /* Check, live, what a connected account is really authorized for right now --
       not only at connection. A refresh host-side (the token never leaves the
       server) reads the token's current scopes, so the page can say "mail yes,
       calendar no" at any time and reflect a permission removed since. Records the
       result on every target of the account, so it shows without another check. */
    async verify({ id } = {}) {
        const all = this.#targets.all?.() ?? [];
        const target = all.find((t) => t.id === id);
        if (!target) throw new Refusal(404, 'No such connexion.');
        const provider = target.config?.provider;
        if (!PROVIDERS[provider]) throw new Refusal(400, 'This connexion is not an account.');
        const secretRef = target.secrets?.refresh;
        const refreshToken = secretRef && this.#secrets.reveal(secretRef);
        if (!refreshToken) throw new Refusal(404, 'The account token is gone; connect it again.');
        const def = thunderbird(provider);
        const clientId = target.config?.clientId || def.clientId;
        let scope, fresh;
        try { ({ scope, refreshToken: fresh } = await refreshAccess(provider, { clientId, clientSecret: def.clientSecret, refreshToken, fetch: this.#fetch })); }
        catch (e) { throw new Refusal(502, `The account could not be checked: ${e.message}`); }
        /* Keep the token current if the provider rotated it on the refresh. */
        if (fresh && fresh !== refreshToken) this.#secrets.set({ name: secretRef, value: fresh, hostOnly: true });
        const authorized = kindsGranted(provider, scope);
        for (const t of all.filter((x) => x.secrets?.refresh === secretRef)) this.#targets.put({ ...t, config: { ...t.config, authorizedKinds: authorized } });
        return { id, provider, all: SUPPORTED[provider], authorized };
    }

    #sweep() { const now = Date.now(); for (const [k, v] of this.#pending) if (now - v.at > PENDING_MS) this.#pending.delete(k); }
}
