/* THE SIGN-IN MAILBOX: a mailbox dedicated to a tool's account, watched for
   one thing only -- the mail that lets the operator sign in.
 *
 * A tool that is not signed in asks for an email address and its provider
 * sends a link there. Instead of leaving the conversation to go and read
 * mail, the operator sees that link next to the terminal, seconds later.
 *
 * WHAT THIS IS NOT. Not a mail client: nothing else in the mailbox is ever
 * shown. Not a resource: it is never mounted in a VM -- an agent that could
 * read sign-in mail could sign itself in elsewhere. Not for shared devices:
 * only the operator's door serves it.
 *
 * THE MAILBOX IS NEVER TOUCHED: it is opened read-only (EXAMINE) and messages
 * are read with BODY.PEEK, which does not mark them as seen. Nothing is
 * moved, flagged, deleted or sent.
 *
 * NARROW ON PURPOSE. A message counts only if its sender's domain is one the
 * tool declares, it arrived in the last few minutes, and it carries an HTTPS
 * link to a domain the tool declares. A sender is easy to forge, so the
 * mailbox's own verdict on the sender (DKIM) is reported with each message,
 * and a link to anywhere else is never shown, whoever seems to send it.
 */
import { connect as tlsConnect } from 'node:tls';
import { Refusal } from './conversations.mjs';

export const TIMEOUT_MS = 15_000;
export const BYTES_MAX = 2_000_000;
export const RECENT_MINUTES = 15;
export const MESSAGES_MAX = 8;
const PART_BYTES = 65_536;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A string as IMAP wants it quoted: backslash and double quote escaped. A
   line break would end the command and start another: refused outright. */
export function quoted(text) {
    if (/[\r\n\0]/.test(text)) throw new Refusal(400, 'This value cannot contain a line break.');
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
export const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

const inDomain = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/* ---------- reading one message ---------- */

function decodeQuotedPrintable(text) {
    const bytes = [];
    const raw = text.replace(/=\r?\n/g, '');
    for (let i = 0; i < raw.length; i++) {
        const hex = raw.slice(i + 1, i + 3);
        if (raw[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; } else bytes.push(...Buffer.from(raw[i], 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
}

/* The text of the message, part by part, each one decoded the way IT says it
   is encoded. Decoding a part with another part's encoding would corrupt it:
   quoted-printable undone over plain text turns "=ab" into one wrong byte,
   which is exactly where a sign-in token sits (measured by the first test
   written for this file). */
export function readableForms(raw) {
    const forms = [];
    for (const part of raw.split(/\r?\n--[^\r\n]*(?:\r?\n|$)/)) {
        const cut = part.search(/\r?\n\r?\n/);
        const head = cut < 0 ? '' : part.slice(0, cut);
        const body = cut < 0 ? part : part.slice(cut).replace(/^\s+/, '');
        const encoding = (/^Content-Transfer-Encoding:[ \t]*([A-Za-z0-9-]+)/im.exec(head)?.[1] ?? '').toLowerCase();
        if (encoding === 'base64') forms.push(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'));
        else if (encoding === 'quoted-printable') forms.push(decodeQuotedPrintable(body));
        else forms.push(body);
    }
    return forms;
}

function header(raw, name) {
    const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
    const match = new RegExp(`^${name}:[ \\t]*([^\\n]*(?:\\n[ \\t]+[^\\n]*)*)`, 'im').exec(head);
    return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

/* What a sign-in strip needs from one message, or undefined if it is not a
   sign-in mail by the rules above. */
export function readMessage(raw, receivedAt, rules, now) {
    const from = header(raw, 'From');
    const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(from) ?? /([^\s<>]+@[^\s<>]+)/.exec(from))?.[1]?.toLowerCase() ?? '';
    const senderDomain = address.split('@')[1] ?? '';
    if (!inDomain(senderDomain, rules.senders)) return undefined;
    if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) return undefined;
    const age = now.getTime() - receivedAt.getTime();
    if (age < -120_000 || age > RECENT_MINUTES * 60_000) return undefined;
    let link;
    for (const form of readableForms(raw)) {
        for (const candidate of form.matchAll(/https:\/\/[^\s"'<>\\)\]]+/g)) {
            let url;
            try { url = new URL(candidate[0].replace(/&amp;/g, '&').replace(/[.,;]+$/, '')); } catch { continue; }
            if (url.protocol === 'https:' && url.username === '' && url.password === '' && inDomain(url.hostname, rules.links)) {
                /* The longest wins: a sign-in link carries a token, a footer link does not. */
                if (link === undefined || url.href.length > link.length) link = url.href;
            }
        }
    }
    if (link === undefined) return undefined;
    /* The mailbox's own verdict, when it gives one: did the sender's domain sign this mail? */
    const verdict = header(raw, 'Authentication-Results');
    const signedBy = /dkim=pass[^;]*header\.(?:d|i)=@?([A-Za-z0-9.-]+)/i.exec(verdict)?.[1]?.toLowerCase();
    return { from: senderDomain, verified: signedBy !== undefined && inDomain(signedBy, rules.senders), at: receivedAt.toISOString(), link,
        subject: header(raw, 'Subject').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').slice(0, 120) };
}

/* ---------- the IMAP conversation, read-only ---------- */

class Exchange {
    #socket; #buffer = Buffer.alloc(0); #received = 0; #wake = null; #failure = null; #n = 0;
    constructor(socket) {
        this.#socket = socket;
        socket.on('data', (bytes) => {
            this.#received += bytes.length;
            if (this.#received > BYTES_MAX) return this.#fail(new Refusal(502, 'The mailbox sent more than expected.'));
            this.#buffer = Buffer.concat([this.#buffer, bytes]);
            this.#wake?.();
            return undefined;
        });
        socket.on('error', () => this.#fail(new Refusal(502, 'The mailbox cannot be reached.')));
        socket.on('close', () => this.#fail(new Refusal(502, 'The mailbox closed the connection.')));
    }
    #fail(error) { this.#failure ??= error; this.#wake?.(); }
    /* Lines up to the one `done` accepts; a literal {n} is taken whole. */
    async #until(done) {
        for (;;) {
            const lines = []; let i = 0; let current = '';
            while (i < this.#buffer.length) {
                const end = this.#buffer.indexOf('\r\n', i);
                if (end < 0) break;
                const piece = this.#buffer.subarray(i, end).toString('utf8');
                i = end + 2;
                const literal = /\{(\d+)\}$/.exec(piece);
                if (literal) {
                    const n = Number(literal[1]);
                    if (this.#buffer.length < i + n) { i = -1; break; }
                    current += `${piece}\n${this.#buffer.subarray(i, i + n).toString('utf8')}`;
                    i += n;
                    continue;
                }
                current += piece;
                lines.push(current);
                if (done(current)) { this.#buffer = this.#buffer.subarray(i); return lines; }
                current = '';
            }
            if (this.#failure) throw this.#failure;
            await new Promise((resolve) => { this.#wake = () => { this.#wake = null; resolve(); }; });
        }
    }
    async greeting() {
        const [line] = await this.#until((l) => l.startsWith('* '));
        if (!/^\* (OK|PREAUTH)/i.test(line ?? '')) throw new Refusal(502, 'The mailbox did not greet as an IMAP server.');
    }
    async command(text, failure) {
        const tag = `c${++this.#n}`;
        this.#socket.write(`${tag} ${text}\r\n`);
        const lines = await this.#until((l) => l.startsWith(`${tag} `));
        if (!new RegExp(`^${tag} OK`, 'i').test(lines.at(-1) ?? '')) throw new Refusal(502, failure);
        return lines;
    }
}

export function readSettings(body) {
    const host = String(body?.host ?? '').trim().toLowerCase();
    const user = String(body?.user ?? '').trim();
    const password = String(body?.password ?? '');
    const port = body?.port === undefined || body.port === '' ? 993 : Number(body.port);
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || !host.includes('.')) throw new Refusal(400, 'The mail server is a host name, such as imap.example.com.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal(400, 'The port is a number, usually 993.');
    if (user === '' || user.length > 200 || password === '' || password.length > 500) throw new Refusal(400, 'The mailbox needs a user and a password.');
    return { host, port, user, password };
}

/* Recent sign-in messages of this mailbox, newest first. `connect` and `now`
   are injectable; a connection is always TLS, and never anything else. */
export async function recentSignIns(settings, rules, { connect = tlsConnect, now = new Date(), ca } = {}) {
    const socket = connect({ host: settings.host, port: settings.port, servername: settings.host, ...(ca ? { ca } : {}) });
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), TIMEOUT_MS);
    try {
        const imap = new Exchange(socket);
        await imap.greeting();
        await imap.command(`LOGIN ${quoted(settings.user)} ${quoted(settings.password)}`, 'The mailbox refused the user or the password.');
        await imap.command('EXAMINE INBOX', 'The inbox could not be opened.');
        const since = new Date(now.getTime() - 24 * 3_600_000);
        const found = await imap.command(`UID SEARCH SINCE ${imapDate(since)}`, 'The mailbox could not be searched.');
        const uids = (found.find((l) => /^\* SEARCH/i.test(l)) ?? '').split(' ').slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(-MESSAGES_MAX);
        const items = [];
        for (const uid of uids.reverse()) {
            const lines = await imap.command(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[]<0.${PART_BYTES}>)`, 'A message could not be read.');
            const fetched = lines.find((l) => /^\* \d+ FETCH/i.test(l)) ?? '';
            const received = new Date((/INTERNALDATE "([^"]+)"/i.exec(fetched)?.[1] ?? '').replace(/^(\d+)-(\w+)-(\d+) /, '$1 $2 $3 '));
            const item = readMessage(fetched.slice(fetched.indexOf('\n') + 1), received, rules, now);
            if (item) items.push(item);
        }
        await imap.command('LOGOUT', 'x').catch(() => {});
        return items.sort((a, b) => b.at.localeCompare(a.at));
    } finally {
        clearTimeout(timer);
        socket.destroy();
    }
}

/* ---------- one mailbox per conversation ---------- */

const CACHE_MS = 5_000;

export class SignInMailboxes {
    #store; #vault; #rules; #cache = new Map(); #reader;

    /* `rules(conversation)` gives the tool's sign-in rules, or undefined. */
    constructor({ store, vault, rules, reader = recentSignIns }) { this.#store = store; this.#vault = vault; this.#rules = rules; this.#reader = reader; }

    /* What the page may know: that a mailbox is set, and where. Never the password. */
    settings(conversation) {
        const s = this.#store.get(conversation);
        return { available: this.#rules(conversation) !== undefined, configured: s !== undefined, host: s?.host ?? null, user: s?.user ?? null };
    }

    /* Saves a mailbox after proving it can be read; an empty host removes it. */
    async set(conversation, body) {
        this.#cache.delete(conversation);
        if (String(body?.host ?? '').trim() === '') { this.#store.remove(conversation); return this.settings(conversation); }
        const rules = this.#rules(conversation);
        if (!rules) throw new Refusal(400, 'The tool of this conversation has no sign-in by mail.');
        const settings = readSettings(body);
        await this.#reader(settings, rules);
        this.#store.put({ name: conversation, host: settings.host, port: settings.port, user: settings.user, sealed: this.#vault.seal(settings.password) });
        return this.settings(conversation);
    }

    /* Recent sign-in mails. Asked for by a page every few seconds: the
       mailbox itself is asked at most once in five. */
    async recent(conversation) {
        const s = this.#store.get(conversation);
        const rules = this.#rules(conversation);
        if (!s || !rules) return [];
        const cached = this.#cache.get(conversation);
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;
        const items = await this.#reader({ host: s.host, port: s.port, user: s.user, password: this.#vault.open(s.sealed) }, rules);
        this.#cache.set(conversation, { at: Date.now(), items });
        return items;
    }

    forget(conversation) { this.#store.remove(conversation); this.#cache.delete(conversation); }
}
