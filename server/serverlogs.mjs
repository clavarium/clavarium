/* WHAT THE SERVER'S PROGRAMS SAID, for Settings (This server, Logs): read by the
 * host program (journalctl, as root), one source over a span, and shown to the
 * owner to read, copy whole, or keep as a file. And this server started again
 * from the page.
 *
 *   read(source, span)  { source, span, text, lines, cut } -- what looks like a
 *                       secret masked: a value after password=, token:, Bearer...;
 *                       any run of 32 letters and digits or more (a key, a token)
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

export class ServerLogs {
    #host;
    constructor({ host }) { this.#host = host; }
    async read(source, span) {
        if (!SOURCES.includes(source)) throw new Refusal(400, `Not a source of logs: say one of ${SOURCES.join(', ')}.`);
        if (!SPANS.includes(String(span))) throw new Refusal(400, 'Not a span: 10 minutes (10m), 1, 6, 24 or 168 hours, or since the server started (boot).');
        const r = await this.#host(['server', 'logs', source, String(span)], { timeoutMs: 120_000, maxBytes: TEXT_MAX * 2 });
        if (r.code !== 0) throw new Refusal(502, `The logs could not be read: ${String(r.stderr ?? '').trim().split('\n').pop()?.replace(/^REFUSED: /, '').slice(0, 200) || `exit ${r.code}`}`);
        let text = String(r.stdout ?? '');
        /* The newest kept when there is too much: they matter most. */
        const cut = text.length > TEXT_MAX;
        if (cut) text = text.slice(text.length - TEXT_MAX).replace(/^[^\n]*\n/, '');
        text = mask(text);
        return { source, span: String(span), text, lines: text ? text.split('\n').filter(Boolean).length : 0, cut };
    }
    async restart() {
        const r = await this.#host(['server', 'restart']);
        if (r.code !== 0) throw new Refusal(502, `This server could not be started again: ${String(r.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) || `exit ${r.code}`}`);
        return { restarting: true };
    }
}
