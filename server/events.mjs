/* WHAT HAPPENED (Settings, This server, What happened): the owner's actions and
 * what the server did by itself, dated, in one list -- a conversation made or
 * archived, a machine restarted, resized or put to sleep, a device paired or
 * revoked, a secret set (its name, never its value), an update, a sign-in, the
 * VM manager restarted... Each is one line of words, said once.
 *
 * Kept in a file of its own, one JSON line each, appended; when it grows past
 * FILE_MAX it is cut to its newest half. Read back newest first.
 *
 *   add({ kind, text, conversation?, who? })
 *   list({ kind?, conversation?, q?, before?, limit? })   newest first
 *   fromRequest(pathname, body, who, answer)   an owner's request that succeeded,
 *                       in words (only those worth saying: not a chat line, not a file)
 *   seen(who)           a sign-in, said once in SEEN_MS for the same person
 */
import { appendFileSync, readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';

export const KINDS = ['conversation', 'machine', 'access', 'asset', 'update', 'server', 'sign-in'];
const FILE_MAX = 4 * 1024 * 1024;
const TEXT_MAX = 300;
const SEEN_MS = 8 * 3600_000;
const LIMIT_MAX = 1000;

const clip = (v, max = 80) => String(v ?? '').replace(/[\r\n\0]/g, ' ').slice(0, max);

/* The owner's requests worth saying: [pattern, kind, words(match, body, answer)]. */
const SAID = [
    [/^\/api\/conversations$/, 'conversation', (m, b, a) => `Conversation "${clip(a?.title ?? b.title ?? b.name)}" made (${clip(a?.tool ?? b.tool, 30)})`],
    [/^\/api\/conversations\/([^/]+)\/archive$/, 'conversation', (m) => `Conversation ${m[1]} archived`],
    [/^\/api\/conversations\/([^/]+)\/title$/, 'conversation', (m, b) => `Conversation ${m[1]} renamed "${clip(b.title)}"`],
    [/^\/api\/conversations\/([^/]+)\/restart$/, 'machine', (m) => `Machine of ${m[1]} restarted`],
    [/^\/api\/conversations\/([^/]+)\/machine$/, 'machine', (m, b) => `Machine of ${m[1]} resized${b.memoryMb ? `: ${b.memoryMb} MB of memory` : ''}${b.diskGb ? `, ${b.diskGb} GB of disk` : ''}${b.cpus ? `, ${b.cpus} core${b.cpus > 1 ? 's' : ''}` : ''}`],
    [/^\/api\/conversations\/([^/]+)\/sleep$/, 'machine', (m) => `Machine of ${m[1]} put to sleep`],
    [/^\/api\/conversations\/([^/]+)\/rebuild$/, 'machine', (m) => `Machine of ${m[1]} built again`],
    [/^\/api\/conversations\/([^/]+)\/network$/, 'machine', (m, b) => `${m[1]} ${b.online ? 'put online' : 'put offline'}`],
    [/^\/api\/conversations\/([^/]+)\/share$/, 'access', (m) => `A pairing code made for ${m[1]}`],
    [/^\/api\/devices\/([^/]+)\/revoke$/, 'access', (m) => `Device ${clip(m[1], 40)} revoked`],
    [/^\/api\/conversations\/([^/]+)\/resources$/, 'access', (m, b) => (b.access === 'none' ? `${clip(b.resource, 40)} taken from ${m[1]}` : `${clip(b.resource, 40)} given to ${m[1]} (${b.access === 'write' ? 'write' : 'read'})`)],
    [/^\/api\/conversations\/([^/]+)\/secrets$/, 'access', (m, b) => `Secret ${clip(b.secret, 40)} ${b.attached ? 'handed to' : 'taken from'} ${m[1]}`],
    [/^\/api\/resources$/, 'asset', (m, b) => `${b.type === 'git' ? 'Repository' : 'Folder'} ${clip(b.name, 40)} added`],
    [/^\/api\/resources\/([^/]+)\/remove$/, 'asset', (m) => `${clip(decodeURIComponent(m[1]), 40)} removed (its content put aside)`],
    [/^\/api\/secrets$/, 'asset', (m, b) => `Secret ${clip(b.name, 40)} set`],
    [/^\/api\/secrets\/([^/]+)\/remove$/, 'asset', (m) => `Secret ${clip(m[1], 40)} removed`],
    [/^\/api\/secrets\/([^/]+)\/rename$/, 'asset', (m, b) => `Secret ${clip(m[1], 40)} renamed ${clip(b.name, 40)}`],
    [/^\/api\/git\/([^/]+)\/push$/, 'asset', (m, b) => `${clip(decodeURIComponent(m[1]), 40)}: a commit sent${b.target ? ` to ${clip(b.target, 40)}` : ''}`],
    [/^\/api\/mailboxes$/, 'asset', (m, b) => `Mailbox ${clip(b.name, 40)} added`],
    [/^\/api\/updates\/apply$/, 'update', (m, b) => `Update to ${clip(b.version, 30)} asked`],
    [/^\/api\/updates\/back$/, 'update', (m, b) => `Going back to ${clip(b.version, 30)} asked`],
    [/^\/api\/updates\/settings$/, 'update', (m, b) => `Updates set: ${['mode', 'channel', 'window'].filter((k) => b[k]).map((k) => `${k} ${clip(b[k], 20)}`).join(', ')}`],
    [/^\/api\/server\/restart$/, 'server', () => 'This server restarted'],
    [/^\/api\/server\/reserve$/, 'server', (m, b) => `Reserve set${b.diskMb !== undefined ? `: disk ${b.diskMb} MB` : ''}${b.memoryMb !== undefined ? `, memory ${b.memoryMb} MB` : ''}`],
    [/^\/api\/machines\/move$/, 'server', (m, b) => `All the machines moved to ${clip(b.to, 60)}`],
    [/^\/api\/machines\/prepare$/, 'server', (m, b) => `Disk ${clip(b.path, 40)} erased and prepared for the machines`],
    [/^\/api\/machines\/grow$/, 'server', (m, b, a) => `${clip(b.mount, 60)} grown with the room set aside on its disk${a?.sizeMb ? `: now ${Math.round(a.sizeMb / 1024)} GB` : ''}`],
    [/^\/api\/machines\/mount$/, 'server', (m, b) => `Disk ${clip(b.path, 40)} mounted`],
    [/^\/api\/machines\/forget-old$/, 'server', () => 'The old copy of the machines removed'],
    [/^\/api\/instance$/, 'server', (m, b) => (String(b.name ?? '').trim() ? `This Clavarium named "${clip(b.name, 40)}"` : 'This Clavarium given back the name drawn from its address')],
    [/^\/api\/operators$/, 'sign-in', (m, b) => `Administrator ${clip(b.email, 80)} added`],
    [/^\/api\/operators\/([^/]+)\/(password|disable|enable|remove)$/, 'sign-in', (m) => `Administrator ${clip(decodeURIComponent(m[1]), 80)}: ${{ password: 'new password', disable: 'disabled', enable: 'enabled', remove: 'removed' }[m[2]]}`],
    [/^\/api\/setup\/import$/, 'conversation', () => 'A setup imported from a file'],
];

export class Events {
    #file; #now; #seen = new Map();
    constructor({ file = null, now = () => Date.now() } = {}) { this.#file = file; this.#now = now; }

    add({ kind, text, conversation = null, who = null }) {
        if (!KINDS.includes(kind) || !text) return null;
        const e = { at: new Date(this.#now()).toISOString(), kind, text: clip(text, TEXT_MAX), ...(conversation ? { conversation: clip(conversation, 40) } : {}), ...(who ? { who: clip(who, 120) } : {}) };
        if (this.#file) {
            try {
                appendFileSync(this.#file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
                if (statSync(this.#file).size > FILE_MAX) this.#cut();
            } catch { /* said nowhere: never a reason to fail what was done */ }
        }
        return e;
    }

    /* Cut to its newest half. */
    #cut() {
        const lines = readFileSync(this.#file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(`${this.#file}.tmp`, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
        renameSync(`${this.#file}.tmp`, this.#file);
    }

    list({ kind = '', conversation = '', q = '', before = '', limit = 200 } = {}) {
        if (!this.#file || !existsSync(this.#file)) return [];
        const words = String(q).trim().toLowerCase();
        const out = [];
        const lines = readFileSync(this.#file, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0 && out.length < Math.min(LIMIT_MAX, Number(limit) || 200); i -= 1) {
            let e; try { e = JSON.parse(lines[i]); } catch { continue; }
            if (kind && e.kind !== kind) continue;
            if (conversation && e.conversation !== conversation) continue;
            if (before && !(e.at < before)) continue;
            if (words && !`${e.text} ${e.who ?? ''}`.toLowerCase().includes(words)) continue;
            out.push(e);
        }
        return out;
    }

    fromRequest(pathname, body = {}, who = '', answer = null) {
        for (const [pattern, kind, words] of SAID) {
            const m = pattern.exec(pathname);
            if (!m) continue;
            const match = m.map((x) => (x === undefined ? x : (() => { try { return decodeURIComponent(x); } catch { return x; } })()));
            const conversation = /^\/api\/conversations\/([^/]+)\//.exec(pathname)?.[1] ?? (pattern.source === '^\\/api\\/conversations$' ? answer?.name : null);
            return this.add({ kind, text: words(match, body ?? {}, answer), conversation: conversation ? decodeURIComponent(conversation) : null, who: who || null });
        }
        return null;
    }

    seen(who) {
        if (!who) return null;
        const last = this.#seen.get(who) ?? 0;
        if (this.#now() - last < SEEN_MS) return null;
        this.#seen.set(who, this.#now());
        return this.add({ kind: 'sign-in', text: `${who} signed in`, who });
    }
}
