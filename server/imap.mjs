/* THE FEW WORDS OF IMAP THIS SERVER SPEAKS, always read-only.
 *
 * Shared by the sign-in strip and by mailboxes kept as files. A mailbox is
 * opened with EXAMINE and read with BODY.PEEK: nothing is ever marked as
 * seen, moved, flagged, deleted or sent. */
import { Refusal } from './conversations.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* A string as IMAP wants it quoted: backslash and double quote escaped. A
   line break would end the command and start another: refused outright. */
export function quoted(text) {
    if (/[\r\n\0]/.test(text)) throw new Refusal(400, 'This value cannot contain a line break.');
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
export const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;


/* ---------- the IMAP conversation, read-only ---------- */

export class Exchange {
    #socket; #buffer = Buffer.alloc(0); #received = 0; #wake = null; #failure = null; #n = 0; #max;
    /* `bytesMax`: what this whole conversation may receive, and no more. */
    constructor(socket, bytesMax) {
        this.#max = bytesMax;
        this.#socket = socket;
        socket.on('data', (bytes) => {
            this.#received += bytes.length;
            if (this.#received > this.#max) return this.#fail(new Refusal(502, 'The mailbox sent more than expected.'));
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
    /* AUTHENTICATE XOAUTH2 with the base64 SASL response given inline (initial
       response, which Gmail and Outlook accept). On success the server answers the
       tag with OK. On failure it first sends a `+ <base64 error>` challenge and
       waits for an empty line before the tagged NO, so we finish that exchange and
       then surface the refusal, rather than hang. */
    async authenticateXoauth2(initial, failure) {
        const tag = `c${++this.#n}`;
        this.#socket.write(`${tag} AUTHENTICATE XOAUTH2 ${initial}\r\n`);
        let lines = await this.#until((l) => l.startsWith(`${tag} `) || l.startsWith('+ '));
        if ((lines.at(-1) ?? '').startsWith('+ ')) {
            this.#socket.write('\r\n');
            lines = await this.#until((l) => l.startsWith(`${tag} `));
        }
        if (!new RegExp(`^${tag} OK`, 'i').test(lines.at(-1) ?? '')) throw new Refusal(502, failure);
        return lines;
    }
}
