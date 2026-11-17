/* WHAT THE SERVER'S PROGRAMS SAID, for Settings (This server, Logs): read by the
 * host program (journalctl, as root), one source over a span, and shown to the
 * owner to read, copy whole, or keep as a file. And this server started again
 * from the page.
 *
 *   read(source, span)  { source, span, text, lines, cut } -- what looks like a
 *                       secret masked: a value after password=, token:, Bearer...;
 *                       any run of 32 letters and digits or more (a key, a token)
 *                       `note`: why it may be short (the journal too slow, journalctl's last word)
 *   load()              the host commands of the last windows (vm.mjs HostTally): Settings, Load
 *   restart()           this server starts again in two seconds (its machines go on)
 */
import { Refusal } from './conversations.mjs';

export const SOURCES = ['clavarium', 'machines', 'updates', 'web', 'signin', 'tunnel', 'system'];
export const SPANS = ['10m', '1', '6', '24', '168', 'boot'];
/* What a page reads at once: masking and sending more held this server for seconds (found 31-10:
   the front then said "being updated" to every other page meanwhile). The newest are kept. */
const TEXT_MAX = 4 * 1024 * 1024;

const NAMED = /\b(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|bearer|client[_-]?secret)(["']?\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const LONG = /[A-Za-z0-9_+/=]{32,}/g;
export function mask(text) {
    return String(text).replace(NAMED, (all, word, between) => `${word}${between}[masked]`).replace(LONG, '[masked]');
}

/* A read longer than this is answered "still reading": the front cuts a request that waits
   much longer (found 31-10 on a big journal: even 10 minutes took too long there). */
export const WAIT_MS = 12_000;
export const KEPT_MS = 120_000;

/* Sudo's and PAM's lines for each call of the host program: a line a second on a busy server, nothing to read
   (the host program leaves them out too: these are for one older than it). */
export const NOISE = / (sudo|pkexec)\[\d+\]: | pam_unix\((sudo|sudo-i|pkexec):session\)/;
/* The last line of what it said, without the host program's REFUSED:. */
const lastWord = (text) => String(text ?? '').trim().split('\n').pop()?.replace(/^(REFUSED|NOTE): /, '').slice(0, 200) ?? '';

export class ServerLogs {
    #host; #reads = new Map(); #now; #load;
    constructor({ host, now = () => Date.now(), load = () => ({ everyMs: 0, windows: [] }) }) { this.#host = host; this.#now = now; this.#load = load; }
    load() { return this.#load(); }

    /* The same read asked again while it runs is the same read; once done, kept a moment for
       the page that comes back for it. Resolves { pending: true } past `wait`. */
    async start(source, span, wait = WAIT_MS) {
        const key = `${source}:${span}`;
        const now = this.#now();
        for (const [k, r] of this.#reads) if (r.done && now - r.done > KEPT_MS) this.#reads.delete(k);
        let r = this.#reads.get(key);
        if (!r) {
            r = { done: 0 };
            r.promise = this.read(source, span).then((v) => { r.value = v; }, (e) => { r.error = e; }).finally(() => { r.done = this.#now(); });
            this.#reads.set(key, r);
        }
        await Promise.race([r.promise, new Promise((ok) => { setTimeout(ok, wait).unref?.(); })]);
        if (!r.done) return { pending: true, source, span: String(span) };
        this.#reads.delete(key);
        if (r.error) throw r.error;
        return r.value;
    }

    async read(source, span) {
        if (!SOURCES.includes(source)) throw new Refusal(400, `Not a source of logs: say one of ${SOURCES.join(', ')}.`);
        if (!SPANS.includes(String(span))) throw new Refusal(400, 'Not a span: 10 minutes (10m), 1, 6, 24 or 168 hours, or since the server started (boot).');
        const r = await this.#host(['server', 'logs', source, String(span)], { timeoutMs: 120_000, maxBytes: TEXT_MAX * 2 });
        if (r.code !== 0) {
            const why = r.timedOut ? 'no answer in 120 s' : r.tooLong ? 'more than 8 MB' : lastWord(r.stderr) || `exit ${r.code}`;
            throw new Refusal(502, `The logs could not be read: ${why}`);
        }
        /* What may make it short (the host program's NOTE: lines): said beside it. */
        const note = String(r.stderr ?? '').split('\n').filter((l) => l.startsWith('NOTE: ')).map((l) => l.slice(6).slice(0, 200)).join('; ') || null;
        let text = String(r.stdout ?? '');
        if (NOISE.test(text)) text = text.split('\n').filter((l) => !NOISE.test(l)).join('\n');
        /* The newest kept when there is too much: they matter most. */
        const cut = text.length > TEXT_MAX;
        if (cut) text = text.slice(text.length - TEXT_MAX).replace(/^[^\n]*\n/, '');
        text = mask(text);
        return { source, span: String(span), text, lines: text ? text.split('\n').filter(Boolean).length : 0, cut, ...(note ? { note } : {}) };
    }
    async restart() {
        const r = await this.#host(['server', 'restart']);
        if (r.code !== 0) throw new Refusal(502, `This server could not be started again: ${String(r.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) || `exit ${r.code}`}`);
        return { restarting: true };
    }
    /* THE WHOLE SERVER STARTED AGAIN (04-11): its machines stop with it and start again after. */
    async reboot() {
        const r = await this.#host(['server', 'reboot']);
        if (r.code !== 0) throw new Refusal(502, `This server could not be restarted: ${String(r.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) || `exit ${r.code}`}`);
        return { rebooting: true };
    }
}
