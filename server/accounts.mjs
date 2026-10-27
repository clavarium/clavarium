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
 * target per kind, each naming that secret. Both providers borrow an open-source
 * desktop client verified for all three: Google uses GNOME Online Accounts' over
 * IMAP + CalDAV/CardDAV, Microsoft uses its Graph client (mail, calendar and
 * contacts all over Microsoft Graph).
 *
 * A CREATED TARGET IS GIVEN TO NO ONE. The person grants it per conversation, at
 * its own level, from the page (Assets > Access) -- like git: one mailbox, many
 * conversations, each its own rights.
 */
import { Refusal } from './conversations.mjs';
import { createHash } from 'node:crypto';
import { consentUrl, exchangeCode, extractCode, thunderbird, scopeFor, pkcePair, newState, PROVIDERS } from './oauth.mjs';

/* The loopback the provider sends the code back to; nothing listens there. The
   person's browser lands on a page that will not load, and they copy the whole
   address -- which carries the code -- back into Clavarium. The same address
   trades the code, so it must match what the borrowed client registered. Both
   borrowed clients (Google's GNOME Online Accounts one, Microsoft's Thunderbird
   one) registered the loopback on any 127.0.0.1 port, so one address serves both. */
const REDIRECT = 'http://127.0.0.1:47813/';
const redirectFor = () => REDIRECT;
const PENDING_MS = 10 * 60_000;
const PENDING_MAX = 20;

/* The kinds a provider can be connected for here, with the connector and the
   Tether kind each becomes, and whether the target needs the email address. */
const KIND = {
    mail: { connector: 'mail', kind: 'mail', title: 'Mail', needsUser: true },
    calendar: { connector: 'calendar', kind: 'calendar', title: 'Agenda', needsUser: false },
    contacts: { connector: 'contacts', kind: 'contacts', title: 'Contacts', needsUser: true },
};
/* What each provider's built-in (Thunderbird) client grants a refresh token for. */
const SUPPORTED = { google: ['mail', 'calendar', 'contacts'], microsoft: ['mail', 'calendar', 'contacts'] };

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
    constructor({ secrets, targets, fetch = globalThis.fetch }) {
        if (!secrets?.set) throw new Error('accounts needs the secret store');
        if (!targets?.put) throw new Error('accounts needs the Tether target store');
        this.#secrets = secrets; this.#targets = targets; this.#fetch = fetch;
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
        let refreshToken;
        try { ({ refreshToken } = await exchangeCode(p.provider, { clientId, clientSecret, redirectUri: redirectFor(p.provider), code, codeVerifier: p.verifier, fetch: this.#fetch })); }
        catch (e) { throw new Refusal(502, `The connection could not be completed: ${e.message}`); }
        if (!refreshToken) throw new Refusal(502, 'The account returned no lasting token; allow offline access and try again.');
        /* The token is kept host-only: it can never be attached to a conversation,
           so it is never delivered to a machine -- the keeper reveals it by name. */
        const name = secretName(p.provider, p.user);
        this.#secrets.set({ name, value: refreshToken, hostOnly: true });
        const label = PROVIDERS[p.provider].label;
        const made = [];
        for (const k of p.kinds) {
            const spec = KIND[k];
            /* Pin the client that minted the token onto the target, so the keeper
               refreshes with the same one -- a refresh token is bound to its client,
               and this keeps a target working even if the built-in default later
               moves (the connector prefers config.clientId over its own default). */
            const config = { provider: p.provider, clientId };
            if (spec.needsUser) config.user = p.user;
            const target = this.#targets.put({
                id: targetId(k, p.provider, p.user),
                title: `${spec.title} — ${p.user} (${label})`,
                kind: spec.kind, connector: spec.connector, config, secrets: { refresh: name },
            });
            made.push({ id: target?.id ?? targetId(k, p.provider, p.user), title: target?.title, kind: spec.kind });
        }
        return { provider: p.provider, user: p.user, targets: made };
    }

    #sweep() { const now = Date.now(); for (const [k, v] of this.#pending) if (now - v.at > PENDING_MS) this.#pending.delete(k); }
}
