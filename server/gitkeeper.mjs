/* WHAT HAPPENS TO A REPOSITORY WHEN NOBODY IS LOOKING -- and only what its
 * owner allowed.
 *
 * Three things, per repository, each set by the owner in the review panel:
 *
 *   THE ORIGIN, KEPT UP TO DATE. Every few minutes (5 unless said otherwise;
 *   0: only when asked, with "Refresh now") this server fetches the origin,
 *   with the key kept here, into a mirror only it writes, shown read-only in
 *   the machine (see ORIGIN in resources.mjs). Git runs in the mirror, never
 *   in the tool's repository.
 *
 *   CHECKS. The project's pre-push hook and/or a command, run IN THE MACHINE
 *   (gitchecks.mjs), before Send is shown and before any automatic sending.
 *   For Send they are advice unless the owner requires them; for automatic
 *   sending they are always required.
 *
 *   AUTOMATIC SENDING, OFF UNLESS THE OWNER NAMES BRANCHES. The list of
 *   branches it may send to is empty to begin with, and nothing is ever sent
 *   automatically to a branch outside it. When the tool's branch has new
 *   commits and then NOTHING NEW for a quiet delay, and its name is in the
 *   list, the commit is sent there exactly as Send would send it: the same
 *   review, the same no-force push, so a remote that moved on is never
 *   overwritten. Every attempt that matters is written in a log the page
 *   shows; the owner's phone can be told; a cap per hour stops a tool that
 *   commits in a loop.
 *
 * HOW A NEW COMMIT IS NOTICED WITHOUT RUNNING GIT IN THE TOOL'S REPOSITORY:
 * the size and date of a few files git itself rewrites at each commit or
 * branch change are looked at (never read, links never followed), as the
 * wake-ups do. Only when they have been still for the quiet delay is the
 * repository copied and looked at the safe way (gitpush.mjs).
 */
import { lstatSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { runGit } from './gitpush.mjs';
import { originFolder } from './resources.mjs';
import { explain } from './gitaccess.mjs';
import { SECONDS_MIN, SECONDS_MAX, COMMAND_MAX } from './gitchecks.mjs';

export const TICK_MS = 30_000;
export const LOG_MAX = 50;
export const PATTERNS_MAX = 20;
export const DEFAULTS = Object.freeze({
    refreshMinutes: 5, autoBranches: [], quietMinutes: 10, perHour: 4, alert: true,
    checkCommand: '', checkSeconds: 600, runHook: true, requireForSend: false,
});
const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
/* What git in the tool's repository rewrites at a commit, a branch change, a pull: looked at, never read. */
const MARKS = ['.git/HEAD', '.git/logs/HEAD', '.git/packed-refs', '.git/ORIG_HEAD', '.git/FETCH_HEAD'];

/* A pattern of the list: a branch name where "*" stands for any part of one
   level ("try/*" is try/a, try/b, not try/a/b). */
export function patternProblem(text) {
    const p = String(text ?? '');
    if (!/^[A-Za-z0-9._\/*-]{1,200}$/.test(p)) return `"${p.slice(0, 40)}" is not a branch name or a pattern ("try/*").`;
    if (p.startsWith('-') || p.startsWith('/') || p.endsWith('/') || p.includes('..') || p.includes('//')) return `"${p.slice(0, 40)}" is not a branch name or a pattern ("try/*").`;
    return '';
}
export function allowed(patterns, branch) {
    return (patterns ?? []).some((p) => new RegExp(`^${p.split('*').map((part) => part.replace(/[.\\/+?^${}()|[\]-]/g, '\\$&')).join('[^/]*')}$`).test(branch));
}

export class GitKeeper {
    #store; #review; #resources; #checks; #alerts; #git; #now; #held = new Map(); #mirrorQueue = new Map(); #results = new Map(); #busy = false;

    /* `review`: GitReview (what would go, and Send). `checks`: GitChecks.
       `alerts`: what tells the owner's phone. */
    constructor({ store, review, resources, checks, alerts, git = runGit, now = () => new Date() }) {
        this.#store = store; this.#review = review; this.#resources = resources; this.#checks = checks; this.#alerts = alerts; this.#git = git; this.#now = now;
    }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #record(name) { return this.#store.get(name) ?? { name }; }
    settings(name) { const r = this.#record(name); return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, r[k] ?? DEFAULTS[k]])); }

    /* What the page shows: the settings, the origin and where the tool finds
       it, the last checks, the log. Never a key. */
    about(name) {
        const r = this.#repository(name);
        const record = this.#record(r.name);
        const hasRemote = Boolean(this.#review.remoteOf(r.name));
        const folder = originFolder(r.name);
        return {
            settings: this.settings(r.name),
            origin: hasRemote ? { path: `/resources/${folder}`, kept: this.#resources.hasOrigin(r.name), ...(record.mirror ?? {}) } : null,
            checks: this.#results.get(r.name) ?? null,
            log: record.log ?? [],
            sentThisHour: this.#recent(record).length,
        };
    }

    set(name, body) {
        const r = this.#repository(name);
        const now = this.settings(r.name);
        const whole = (value, low, high, why) => {
            if (value === undefined) return undefined;
            const n = Number(value);
            if (!Number.isInteger(n) || n < low || n > high) throw new Refusal(400, why);
            return n;
        };
        const next = { ...now };
        const minutes = whole(body?.refreshMinutes, 0, 1440, 'Refresh the origin every how many minutes? A whole number, 0 to turn it off, a day at most.');
        if (minutes !== undefined) next.refreshMinutes = minutes;
        const quiet = whole(body?.quietMinutes, 0, 1440, 'How many quiet minutes before sending? A whole number, a day at most.');
        if (quiet !== undefined) next.quietMinutes = quiet;
        const cap = whole(body?.perHour, 1, 60, 'Automatic sendings an hour: a whole number from 1 to 60.');
        if (cap !== undefined) next.perHour = cap;
        const seconds = whole(body?.checkSeconds, SECONDS_MIN, SECONDS_MAX, `The time limit of the checks: ${SECONDS_MIN} to ${SECONDS_MAX} seconds.`);
        if (seconds !== undefined) next.checkSeconds = seconds;
        if (body?.checkCommand !== undefined) {
            const command = String(body.checkCommand).trim();
            if (command.length > COMMAND_MAX || /[\r\n\0]/.test(command)) throw new Refusal(400, `The check command is one line, ${COMMAND_MAX} characters at most.`);
            next.checkCommand = command;
        }
        if (body?.autoBranches !== undefined) {
            const list = (Array.isArray(body.autoBranches) ? body.autoBranches : String(body.autoBranches).split(/[\s,]+/)).map((p) => String(p).trim()).filter(Boolean);
            if (list.length > PATTERNS_MAX) throw new Refusal(400, `At most ${PATTERNS_MAX} branches or patterns.`);
            for (const p of list) { const why = patternProblem(p); if (why) throw new Refusal(400, why); }
            next.autoBranches = [...new Set(list)];
        }
        for (const flag of ['alert', 'runHook', 'requireForSend']) if (body?.[flag] !== undefined) next[flag] = body[flag] === true;
        this.#store.put({ ...this.#record(r.name), ...next });
        /* A list just set starts from now: what was committed before waits for the quiet delay. */
        this.#held.delete(r.name);
        return this.about(r.name);
    }

    forget(name) { this.#store.remove(name); this.#held.delete(name); this.#results.delete(name); }

    /* ---------- the origin ---------- */

    /* Fetches the origin into the mirror, making it the first time. One at a time per repository. */
    refresh(name) {
        const r = this.#repository(name);
        const before = this.#mirrorQueue.get(r.name);
        if (before) return before;
        const run = this.#refresh(r).finally(() => this.#mirrorQueue.delete(r.name));
        this.#mirrorQueue.set(r.name, run);
        return run;
    }

    async #refresh(r) {
        const remote = this.#review.remoteOf(r.name);
        const at = this.#now().toISOString();
        const said = (ok, message) => { this.#store.put({ ...this.#record(r.name), mirror: { at, ok, message } }); return this.about(r.name); };
        if (!remote) return said(false, 'This repository has no origin: it was not cloned and no address is set.');
        const mirror = this.#resources.originPath(r.name);
        const first = !this.#resources.hasOrigin(r.name);
        try {
            if (first) {
                await this.#resources.makeOrigin(r.name);
                const made = await this.#git(['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', '--bare', '--initial-branch=main', mirror]);
                if (made.code !== 0) return said(false, `The origin could not be kept: ${firstLine(made.stderr)}`);
            }
            const fetched = await this.#review.reach(r.name, remote, (env) => this.#git(['-C', mirror, '-c', 'core.hooksPath=/dev/null', 'fetch', '--quiet', '--prune', '--no-tags', '--update-head-ok', '--', remote, '+refs/heads/*:refs/heads/*'], { env }));
            if (fetched.code !== 0) return said(false, `The origin did not answer as expected: ${explain(fetched.stderr)}`);
        } catch (error) {
            return said(false, error instanceof Refusal ? error.message : 'The origin could not be kept.');
        }
        /* Made just now: shown wherever the repository is attached. */
        if (first) await this.#resources.shareOrigin(r.name).catch(() => {});
        return said(true, 'Up to date with the origin.');
    }

    /* ---------- checks ---------- */

    /* Runs the checks for the exact commit and branch of a review; the result is remembered for Send. */
    async check(name, body) {
        const r = this.#repository(name);
        const seen = await this.#review.outgoing(r.name, { target: body?.target });
        if (seen.state !== 'ahead') throw new Refusal(409, seen.message);
        if (typeof body?.head !== 'string' || body.head !== seen.head) throw new Refusal(409, 'The repository changed since you looked: look again at what would be sent.');
        return this.#check(r.name, seen);
    }
    async #check(name, seen) {
        const s = this.settings(name);
        const result = await this.#checks.run(name, { head: seen.head, branch: seen.branch, target: seen.target, remoteTip: seen.remoteTip, remote: seen.remote, command: s.checkCommand, hook: s.runHook, seconds: s.checkSeconds });
        this.#results.set(name, result);
        return result;
    }

    /* Send, from the page: as GitReview.push, and refused when the owner
       requires passing checks and none passed for this commit and branch. */
    async send(name, body) {
        const r = this.#repository(name);
        if (this.settings(r.name).requireForSend) {
            const last = this.#results.get(r.name);
            const target = body?.target || undefined;
            if (!last || last.status !== 'passed' || last.head !== body?.head || (target !== undefined && last.target !== target)) {
                throw new Refusal(409, 'Passing checks are required before sending: run the checks for this commit first.');
            }
        }
        return this.#review.push(r.name, body);
    }

    /* ---------- the clock ---------- */

    #recent(record) { const hourAgo = this.#now().getTime() - 3_600_000; return (record.sent ?? []).filter((at) => new Date(at).getTime() > hourAgo); }
    #log(name, entry, { sent = false } = {}) {
        const record = this.#record(name);
        const at = this.#now().toISOString();
        this.#store.put({ ...record, log: [{ at, ...entry, what: String(entry.what).slice(0, 300) }, ...(record.log ?? [])].slice(0, LOG_MAX), ...(sent ? { sent: [...this.#recent(record), at] } : {}) });
    }
    #mark(name) {
        const folder = this.#resources.folder(name);
        return MARKS.map((m) => { try { const s = lstatSync(`${folder}/${m}`); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return '-'; } }).join('|');
    }
    #tell(title, body) { if (this.#alerts) void this.#alerts.tell({ title, body, url: '/' }).catch(() => {}); }

    async #autoSend(name, s, held) {
        const out = await this.#review.outgoing(name);
        /* Each reason not to send is written once per commit, not at every tick. */
        const once = (why, entry) => {
            if (held.said === `${out.head}:${why}`) return;
            held.said = `${out.head}:${why}`;
            const { tell, ...said } = entry;
            this.#log(name, said);
            if (entry.tell && s.alert) this.#tell(`${name}: not sent`, entry.what);
        };
        if (out.state === 'empty' || out.state === 'no-remote' || out.state === 'up-to-date') return;
        const base = { branch: out.target, head: out.head, ok: false };
        if (!allowed(s.autoBranches, out.target)) return once('list', { ...base, what: `Not sent: ${out.target} is not in the list of branches that may be sent to automatically.` });
        if (out.state === 'unreachable') return once('unreachable', { ...base, what: out.message, tell: true });
        if (out.state === 'diverged') return once('diverged', { ...base, what: `Not sent: ${out.message}`, tell: true });
        if (this.#recent(this.#record(name)).length >= s.perHour) {
            /* Tried again after another quiet delay: the hour may have room by then. */
            held.pending = true; held.moved = this.#now().getTime();
            return once('cap', { ...base, what: `Not sent: ${s.perHour} automatic sending(s) this hour already, the cap you set.`, tell: true });
        }
        const checks = await this.#check(name, out);
        if (checks.status !== 'passed') {
            /* No machine ran them: tried again later, when one may run. */
            if (checks.status === 'unavailable') { held.pending = true; held.moved = this.#now().getTime(); }
            const why = checks.status === 'failed' ? 'the checks failed in the machine' : checks.status === 'none' ? 'automatic sending needs passing checks, and none is set (no pre-push hook, no check command)' : 'the checks could not run: no machine with this repository runs';
            return once(`checks-${checks.status}`, { ...base, what: `Not sent: ${why}.`, tell: true });
        }
        try {
            const sent = await this.#review.push(name, { head: out.head, target: out.target });
            held.said = '';
            this.#log(name, { ...base, ok: true, what: `Sent automatically: ${sent.commits} commit(s) to ${sent.branch}${sent.made ? ' (a new branch)' : ''}, checks passed.` }, { sent: true });
            if (s.alert) this.#tell(`${name}: sent to ${sent.branch}`, `${sent.commits} commit(s), automatically, checks passed.`);
        } catch (error) {
            once('refused', { ...base, what: `Not sent: ${error instanceof Refusal ? error.message : 'the sending failed.'}`, tell: true });
        }
    }

    async tick() {
        if (this.#busy) return;
        this.#busy = true;
        try {
            const now = this.#now().getTime();
            for (const r of this.#resources.list().filter((x) => x.type === 'git')) {
                const s = this.settings(r.name);
                const remote = this.#review.remoteOf(r.name);
                if (!remote) continue;
                /* The origin, when due. */
                const last = this.#record(r.name).mirror?.at;
                if (s.refreshMinutes > 0 && (!last || now - new Date(last).getTime() >= s.refreshMinutes * 60_000)) await this.refresh(r.name).catch(() => {});
                /* Automatic sending: only with a list. */
                if (s.autoBranches.length === 0) { this.#held.delete(r.name); continue; }
                const mark = this.#mark(r.name);
                let held = this.#held.get(r.name);
                /* First look (a start, a list just set): looked at once the quiet delay has passed. */
                if (!held) { held = { mark, moved: now, pending: true, said: '' }; this.#held.set(r.name, held); }
                if (held.mark !== mark) { held.mark = mark; held.moved = now; held.pending = true; }
                if (!held.pending || now - held.moved < s.quietMinutes * 60_000) continue;
                held.pending = false;
                await this.#autoSend(r.name, s, held).catch(() => {});
            }
        } finally { this.#busy = false; }
    }

    start(everyMs = TICK_MS) {
        const timer = setInterval(() => { void this.tick(); }, everyMs);
        timer.unref?.();
        /* The origin is looked at soon after a start, not a whole period later. */
        setTimeout(() => { void this.tick(); }, Math.min(everyMs, 5000)).unref?.();
        return timer;
    }
}
