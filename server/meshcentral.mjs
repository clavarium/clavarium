/* THE REMOTE SCREEN (MeshCentral), from Settings (Remote screen): a self-hosted MeshCentral
 * server (Apache-2.0), OFF by default, turned on in a few clicks. All of it is done by the host
 * program as root (deploy/clavarium-host, verbs "meshcentral ..."): MeshCentral is installed in a
 * directory of its own, run under a hardened unit as a dedicated unprivileged account, and reached
 * only through the existing front (Caddy) under a path. This module drives that lifecycle; it does
 * NOT drive the screen (that is the separate screen connector).
 *
 * Turning it on installs MeshCentral the first time, which can take minutes: the turn-on runs in a
 * unit of the host's own and this returns at once, so the page shows its progress and the outcome
 * is read back from status().
 *
 *   status()   { installed, running, version, url, step, why, on }
 *              step (only while or after a turn-on): installing, starting, running, interrupted, failed, idle
 *   enable()   the turn-on started: { started: true }; the page follows it with status()
 *   disable()  stopped and its route removed, what was installed kept: { disabled: true }
 */
import { Refusal } from './conversations.mjs';

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 200) ?? '';
const STEPS = ['installing', 'starting', 'running', 'interrupted', 'failed', 'idle'];
/* After a turn-on, the outcome is looked for this often and this long, to be said once in What happened. */
const WATCH_EVERY_MS = 5000;
const WATCH_FOR_MS = 30 * 60_000;

/* "meshcentral status", line by line: only the lines of the expected shapes. */
export function readStatus(text) {
    const out = { installed: false, running: false, version: null, url: null, step: null, why: null };
    for (const line of String(text ?? '').split('\n').slice(0, 50)) {
        const word = line.split(' ', 1)[0]; const rest = line.slice(word.length + 1);
        if (word === 'installed') out.installed = rest === 'yes';
        else if (word === 'running') out.running = rest === 'yes';
        else if (word === 'version' && /^[0-9][0-9A-Za-z.+-]{0,30}$/.test(rest)) out.version = rest;
        else if (word === 'url' && /^(https:\/\/[A-Za-z0-9.-]{1,255})?\/[A-Za-z0-9/._-]{0,64}$/.test(rest)) out.url = rest;
        else if (word === 'step' && STEPS.includes(rest)) out.step = rest;
        else if (word === 'why' && /^[a-z-]{1,20}$/.test(rest)) out.why = rest;
    }
    out.on = out.running;
    return out;
}

export class MeshCentral {
    #host; #said; #watching = null; #everyMs; #forMs;
    /* `said(text)`: an outcome, in What happened (events.mjs). */
    constructor({ host, said = () => {}, watchEveryMs = WATCH_EVERY_MS, watchForMs = WATCH_FOR_MS }) {
        this.#host = host; this.#said = said; this.#everyMs = watchEveryMs; this.#forMs = watchForMs;
    }
    async status() {
        const r = await this.#host(['meshcentral', 'status'], { timeoutMs: 30_000 });
        if (r.code !== 0) return { ...readStatus(''), step: null, why: null, said: firstLine(r.stderr) || `exit ${r.code}` };
        return readStatus(r.stdout);
    }
    async enable() {
        const r = await this.#host(['meshcentral', 'enable'], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        this.#watch();
        return { started: true };
    }
    async disable() {
        const r = await this.#host(['meshcentral', 'disable'], { timeoutMs: 120_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { disabled: true };
    }
    /* The outcome, said once in What happened, whoever looks at the page: the turn-on goes on in
       its own unit, so it ends even if no page is there to see it. */
    #watch() {
        clearTimeout(this.#watching);
        const until = Date.now() + this.#forMs;
        const look = async () => {
            const s = await this.status().catch(() => null);
            const step = s?.step;
            if (step && !['installing', 'starting'].includes(step)) {
                this.#watching = null;
                const why = { install: 'could not install', start: 'did not start' }[s?.why] ?? s?.why ?? 'no reason given';
                const words = {
                    running: `Remote screen: on now${s?.url ? ` at ${s.url}` : ''}`,
                    failed: `Remote screen: did not turn on (${why})`,
                    interrupted: 'Remote screen: the turn-on was interrupted',
                };
                try { this.#said(words[step] ?? `Remote screen: ${step}`); } catch { /* never in the way */ }
                return;
            }
            if (Date.now() < until) { this.#watching = setTimeout(look, this.#everyMs); this.#watching.unref?.(); }
        };
        this.#watching = setTimeout(look, this.#everyMs); this.#watching.unref?.();
    }
}
