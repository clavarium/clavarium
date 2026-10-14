/* WHAT HAPPENS TO A REPOSITORY WHEN NOBODY IS LOOKING -- and only what its
 * owner allowed.
 *
 * Three things, per repository, each set by the owner in the review panel:
 *
 *   THE REFERENCE, KEPT UP TO DATE. Every few minutes (5 unless said
 *   otherwise; 0: only when asked, with "Refresh now") this server fetches
 *   the remote, with the key kept here, into the reference -- the remote's
 *   history and nothing else, which only the refresh writes -- shown
 *   read-only in the machine as <name>-origin (see ORIGIN in resources.mjs).
 *
 *   CHECKS. The project's pre-push hook and/or a command, run IN THE MACHINE
 *   (gitchecks.mjs), before Send is shown and before any automatic sending.
 *   For Send they are advice unless the owner requires them; for automatic
 *   sending they are always required.
 *
 *   AUTOMATIC SENDING, OFF UNLESS THE OWNER NAMES BRANCHES. The list of
 *   branches it may send to is empty to begin with, and nothing is ever sent
 *   automatically to a branch outside it. A branch whose tip has commits the
 *   remote lacks, and whose tip has not moved for the quiet delay, and whose
 *   name is in the list, is sent to the remote's branch of the same name
 *   exactly as Send would send it (gitpush.mjs): read again, never forced, a
 *   lease on the remote's tip. Every attempt that matters is written in a
 *   log the page shows; the owner's phone can be told; a cap per hour stops
 *   a tool that commits in a loop.
 *
 * ONLY WHILE A MACHINE USES IT. A repository that no running machine has
 * attached does nothing by nature: the clock neither refreshes it nor sends
 * anything from it (GitChecks.machineFor says which machine uses it). "Refresh
 * now" still works on demand: the owner asked.
 *
 * HOW A NEW COMMIT IS NOTICED WITHOUT RUNNING GIT IN THE TOOL'S REPOSITORY:
 * the size and date of a few files git itself rewrites at each commit or
 * branch change are looked at (never read, links never followed). A change
 * schedules a READ (through the host program's sandbox, gitrunner.mjs) a few
 * seconds after the last one; a change during a read asks for one more; a
 * read every 10 minutes catches what the marks miss. Each read records the
 * tip of each branch and when it first saw it: that is the quiet delay's
 * clock.
 *
 * EVERY FAILURE IS SAID: written in the log (once while it lasts), the
 * owner's phone told after two in a row (at once for the grave ones), and the
 * agent told one line where it can do something about it.
 */
import { lstatSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { originFolder } from './resources.mjs';
import { GitFailure, waiversProblem } from './gitrunner.mjs';
import { SECONDS_MIN, SECONDS_MAX, COMMAND_MAX } from './gitchecks.mjs';

export const TICK_MS = 30_000;
/* A read waits this long after the last change of the marks. */
export const READ_DELAY_MS = 5_000;
/* And happens at least this often while a machine uses the repository. */
export const SAFETY_READ_MS = 10 * 60_000;
export const UPKEEP_MS = 24 * 3_600_000;
export const LOG_MAX = 50;
/* An automatic sending that failed for a passing reason (the remote did not
   answer, the outcome unknown, a workspace) is tried again, not before this. */
export const RETRY_MS = 5 * 60_000;
/* Sending failures that are final for a commit: nothing changes them but a
   new commit, or the agent pulling. Every other failure passes, and the same
   commit is tried again later. */
const FINAL = new Set(['diverged', 'remote-moved', 'refused', 'forced', 'no-address', 'look', 'confirm']);
/* Read failures whose message carries a number that changes from one read to
   the next (free room, bytes counted): the same failure all the same. */
const VARYING = new Set(['space', 'cap']);
export const PATTERNS_MAX = 20;
export const DEFAULTS = Object.freeze({
    refreshMinutes: 5, autoBranches: [], quietMinutes: 10, perHour: 4, alert: true,
    checkCommand: '', checkSeconds: 600, runHook: true, requireForSend: false, fsck: {},
});
/* What git in the tool's repository rewrites at a commit, a branch change, a pull: looked at, never read. */
const MARKS = ['.git/HEAD', '.git/logs/HEAD', '.git/packed-refs', '.git/ORIG_HEAD', '.git/FETCH_HEAD', '.git/refs/heads'];
/* A name the agent chose, as it may be typed to it: plain characters only. */
const plain = (text) => String(text ?? '').replace(/[^A-Za-z0-9._/-]/g, '?').slice(0, 80);

/* A pattern of the list: a branch name where "*" stands for any part of one
   level ("try/*" is try/a, try/b, not try/a/b). */
export function patternProblem(text) {
    const p = String(text ?? '');
    if (!/^[A-Za-z0-9._/*-]{1,200}$/.test(p)) return `"${p.slice(0, 40)}" is not a branch name or a pattern ("try/*").`;
    if (p.startsWith('-') || p.startsWith('/') || p.endsWith('/') || p.includes('..') || p.includes('//')) return `"${p.slice(0, 40)}" is not a branch name or a pattern ("try/*").`;
    return '';
}
export function allowed(patterns, branch) {
    return (patterns ?? []).some((p) => new RegExp(`^${p.split('*').map((part) => part.replace(/[.\\/+?^${}()|[\]-]/g, '\\$&')).join('[^/]*')}$`).test(branch));
}

export class GitKeeper {
    #store; #review; #resources; #checks; #alerts; #now; #tellAgent; #held = new Map(); #results = new Map(); #running = new Set(); #telling = new Map();

    /* `review`: GitReview (reads, the reference, Send). `checks`: GitChecks.
       `alerts`: what tells the owner's phone. `tellAgent(repository, line)`:
       what types one line to the agents that write in the repository;
       it resolves false when nobody could be told (then it is tried again). */
    constructor({ store, review, resources, checks, alerts, now = () => new Date(), tellAgent = async () => {} }) {
        this.#store = store; this.#review = review; this.#resources = resources; this.#checks = checks; this.#alerts = alerts; this.#now = now; this.#tellAgent = tellAgent;
        review.listen({ read: (name, failure, got) => this.#readOutcome(name, failure, got), refresh: (name, result) => this.#refreshOutcome(name, result) });
        review.useWaivers?.((name) => this.settings(name).fsck);
    }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #record(name) { return this.#store.get(name) ?? { name }; }
    #patch(name, changes) { this.#store.put({ ...this.#record(name), ...changes }); }
    settings(name) { const r = this.#record(name); return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, r[k] ?? DEFAULTS[k]])); }

    /* What the page shows: the settings, the reference and where the tool
       finds it, the last checks, the last read, the log. Never a key. */
    about(name) {
        const r = this.#repository(name);
        const record = this.#record(r.name);
        const hasRemote = Boolean(this.#review.remoteOf(r.name));
        const folder = originFolder(r.name);
        return {
            settings: this.settings(r.name),
            origin: hasRemote ? { path: `/resources/${folder}`, kept: this.#resources.hasOrigin(r.name), ...(record.mirror ?? {}) } : null,
            checks: this.#results.get(r.name) ?? null,
            read: record.lastRead ?? null,
            blocked: Object.keys(record.blocked ?? {}),
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
        /* fsck waivers: only the ids kept for old histories, never one that guards a checkout. */
        if (body?.fsck !== undefined) {
            const why = waiversProblem(body.fsck);
            if (why) throw new Refusal(400, why);
            next.fsck = { ...body.fsck };
        }
        for (const flag of ['alert', 'runHook', 'requireForSend']) if (body?.[flag] !== undefined) next[flag] = body[flag] === true;
        this.#store.put({ ...this.#record(r.name), ...next });
        /* A list just set starts from now: what was decided before is looked at again. */
        this.#held.delete(r.name);
        return this.about(r.name);
    }

    forget(name) { this.#store.remove(name); this.#held.delete(name); this.#results.delete(name); }

    /* ---------- what every read and every refresh says ---------- */

    #tell(title, body) { if (this.#alerts) void this.#alerts.tell({ title, body, url: '/' }).catch(() => {}); }
    /* Marked as told only once somebody was: a line typed to no machine
       (all asleep, a terminal that failed) is said again the next time. */
    #toAgent(name, line) {
        if (this.#record(name).toldAgent === line || this.#telling.get(name) === line) return;
        this.#telling.set(name, line);
        void Promise.resolve(this.#tellAgent(name, `Clavarium, repository ${name}: ${line}.`))
            .then((heard) => { if (heard !== false) this.#patch(name, { toldAgent: line }); }, () => {})
            .finally(() => { if (this.#telling.get(name) === line) this.#telling.delete(name); });
    }

    #readOutcome(name, failure, got) {
        const at = this.#now().toISOString();
        if (!failure) {
            const record = this.#record(name);
            if (record.lastRead?.ok === false) this.#log(name, { ok: true, what: 'The repository is read again.' });
            const dropped = got?.dropped ?? [];
            this.#patch(name, { lastRead: { at, ok: true, ...(dropped.length ? { dropped: dropped.map((d) => plain(d.name)) } : {}) }, readFailures: 0, ...(dropped.length ? {} : { toldAgent: undefined }) });
            /* A branch whose name cannot be taken: the agent can rename it. */
            if (dropped.length) this.#toAgent(name, `branch ${plain(dropped[0].name)} was not taken: ${dropped[0].why}`);
            return;
        }
        const message = failure.message ?? 'The repository could not be read.';
        const kind = failure.kind ?? 'error';
        const record = this.#record(name);
        const count = (record.readFailures ?? 0) + 1;
        /* The same failure as the last read's: the same kind, and the same
           words unless the words carry a number that moves at every read. */
        const same = record.lastRead?.ok === false && record.lastRead.kind === kind && (VARYING.has(kind) || record.lastRead.what === message);
        this.#patch(name, { lastRead: { at, ok: false, kind, what: message, ...(failure.offer ? { offer: failure.offer } : {}) }, readFailures: count });
        if (kind === 'busy') return;
        if (!same) this.#log(name, { ok: false, what: message });
        /* The phone: once while it lasts -- at once for a grave failure (the
           host's, or no room), after two in a row for the others. */
        const grave = kind === 'host' || kind === 'space';
        if (failure.alert || grave) { if (!same) this.#tell(grave ? `${name}: the host needs a look` : `${name}: could not be read`, message); }
        else if (count === 2) this.#tell(`${name}: could not be read`, message);
        /* The agent is told where it can act; a git failure, or refs that may
           only have been changing during the read, only after two in a row. */
        if (failure.ai && (!['git', 'refs'].includes(kind) || count >= 2)) this.#toAgent(name, failure.ai);
    }

    #refreshOutcome(name, result) {
        const at = this.#now().toISOString();
        const record = this.#record(name);
        const failures = result.ok ? 0 : (record.refreshFailures ?? 0) + 1;
        this.#patch(name, { mirror: { at, ok: result.ok, message: result.ok ? 'Up to date with the origin.' : result.message }, refreshFailures: failures });
        if (!result.ok && failures === 3) this.#tell(`${name}: the remote does not answer`, result.message);
        if (result.stale?.length) this.#log(name, { ok: false, what: `A refresh was stopped by its time limit; stale lock files removed: ${result.stale.join(', ')}.` });
        for (const w of result.rewritten ?? []) {
            const what = w.now ? `${w.branch} was rewritten on the remote: its tip ${w.was.slice(0, 8)} is not in its new history.` : `${w.branch} was deleted on the remote.`;
            this.#log(name, { ok: false, branch: w.branch, what });
            this.#tell(`${name}: ${w.branch} ${w.now ? 'rewritten' : 'deleted'} on the remote`, what);
            if (w.now) this.#toAgent(name, `origin/${plain(w.branch)} was rewritten; fetch again`);
        }
        if (result.ok && Object.keys(record.blocked ?? {}).length > 0) void this.#settle(name).catch(() => {});
    }

    /* A push whose outcome was unknown, settled by a refresh that worked. */
    async #settle(name) {
        const blocked = { ...(this.#record(name).blocked ?? {}) };
        for (const [target, { head }] of Object.entries(blocked)) {
            const tip = await this.#review.remoteTip(name, target);
            delete blocked[target];
            this.#patch(name, { blocked });
            if (tip === head) this.#log(name, { ok: true, branch: target, head, what: `The earlier sending to ${target} did arrive (settled by a refresh).` }, { sent: true });
            else {
                /* As the log says: automatic sending takes that commit again. */
                const held = this.#held.get(name);
                held?.done.delete(target); held?.retry.delete(target); held?.said.delete(target);
                this.#log(name, { ok: false, branch: target, head, what: `The earlier sending to ${target} did not arrive (settled by a refresh): it can be sent again.` });
            }
        }
    }

    /* ---------- the reference ---------- */

    /* "Refresh now": the owner asked, whatever runs. */
    async refresh(name) {
        const r = this.#repository(name);
        await this.#review.refresh(r.name);
        return this.about(r.name);
    }

    /* ---------- checks ---------- */

    /* Runs the checks for the exact commit and branch of a review; the result is remembered for Send. */
    async check(name, body) {
        const r = this.#repository(name);
        const target = body?.target || undefined;
        const seen = typeof body?.head === 'string' ? this.#review.reviewOf(r.name, body.head, target) : undefined;
        if (!seen) throw new Refusal(409, 'The repository changed since you looked: look again at what would be sent.');
        return this.#check(r.name, seen);
    }
    async #check(name, seen) {
        const s = this.settings(name);
        const result = await this.#checks.run(name, { head: seen.head, branch: seen.branch, target: seen.target, remoteTip: seen.remoteTip, remote: this.#review.remoteOf(name), command: s.checkCommand, hook: s.runHook, seconds: s.checkSeconds });
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
        try {
            return await this.#review.push(r.name, body);
        } catch (error) {
            if (error instanceof GitFailure) this.#sendFailed(r.name, error, { branch: body?.target, head: body?.head });
            throw error;
        }
    }
    #sendFailed(name, error, { branch, head }) {
        if (['look', 'confirm', 'busy'].includes(error.kind)) return;
        this.#log(name, { ok: false, branch: branch ?? null, head: head ?? null, what: error.message });
        if (error.alert) this.#tell(`${name}: sending needs a look`, error.message);
        if (error.kind === 'unknown-unreachable' && branch) this.#patch(name, { blocked: { ...(this.#record(name).blocked ?? {}), [branch]: { head, at: this.#now().toISOString() } } });
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
    async #inUse(name) { try { return Boolean(await this.#checks.machineFor(name)); } catch { return false; } }

    /* One branch of the last read: sent, or the reason not, said once per commit. */
    async #consider(name, s, held, b, tip) {
        const now = this.#now().getTime();
        const once = (why, entry) => {
            const key = `${tip.id}:${why}`;
            if (held.said.get(b) === key) return;
            held.said.set(b, key);
            const { tell, ai, ...said } = entry;
            this.#log(name, { branch: b, head: tip.id, ok: false, ...said });
            if (tell && s.alert) this.#tell(`${name}: not sent`, entry.what);
            if (ai) this.#toAgent(name, ai);
        };
        if (this.#record(name).blocked?.[b]) return once('blocked', { what: `Not sent: the outcome of an earlier sending to ${b} is unknown; automatic sending waits until a refresh settles it.` });
        /* What the remote has already (or the agent's branch only behind it): nothing to do, nothing said. */
        /* Asked again only when the tip or the reference changed: a tick
           would otherwise ask it of every branch, every 30 seconds. */
        const refreshed = this.#record(name).mirror?.at ?? '';
        let lacks = held.lacks.get(b);
        if (!lacks || lacks.id !== tip.id || lacks.at !== refreshed) {
            lacks = { id: tip.id, at: refreshed, value: await this.#review.remoteLacks(name, b, tip.id) };
            held.lacks.set(b, lacks);
        }
        if (!lacks.value) { held.said.delete(b); return; }
        if (!allowed(s.autoBranches, b)) return once('list', { what: `Not sent: ${b} is not in the list of branches that may be sent to automatically.` });
        if (now - new Date(tip.movedAt).getTime() < s.quietMinutes * 60_000) return;
        if (held.done.get(b) === tip.id) return;
        /* A passing failure: tried again, but not at every tick. */
        const retry = held.retry.get(b);
        if (retry && retry.id === tip.id && now < retry.at) return;
        if (this.#recent(this.#record(name)).length >= s.perHour) return once('cap', { what: `Not sent: ${s.perHour} automatic sending(s) this hour already, the cap you set.`, tell: true });
        const remoteTip = await this.#review.remoteTip(name, b);
        const checks = await this.#check(name, { head: tip.id, branch: b, target: b, remoteTip });
        if (checks.status !== 'passed') {
            /* No machine ran them: tried again later, when one may run. */
            if (checks.status !== 'unavailable') held.done.set(b, tip.id);
            const why = checks.status === 'failed' ? 'the checks failed in the machine' : checks.status === 'none' ? 'automatic sending needs passing checks, and none is set (no pre-push hook, no check command)' : 'the checks could not run: no machine with this repository runs';
            return once(`checks-${checks.status}`, { what: `Not sent: ${why}.`, tell: true, ...(checks.status === 'failed' ? { ai: `the checks failed for ${plain(b)}, it was not sent` } : {}) });
        }
        try {
            /* auto: no owner was shown a remote tip; the remote's tip of the
               moment is the lease, and "has it all" the guard. */
            const sent = await this.#review.send(name, { branch: b, head: tip.id, target: b, remoteTip, auto: true });
            held.done.set(b, tip.id); held.said.delete(b); held.retry.delete(b);
            if (sent.already) { this.#log(name, { branch: b, head: tip.id, ok: true, what: `Already on the remote: ${b}.` }, { sent: true }); return; }
            this.#log(name, { branch: b, head: tip.id, ok: true, what: `Sent automatically: ${sent.commits} commit(s) to ${sent.branch}${sent.made ? ' (a new branch)' : ''}, checks passed.${sent.note ? ` ${sent.note}` : ''}` }, { sent: true });
            if (s.alert) this.#tell(`${name}: sent to ${sent.branch}`, `${sent.commits} commit(s), automatically, checks passed.`);
        } catch (error) {
            const kind = error instanceof GitFailure ? error.kind : 'error';
            if (kind === 'unknown-unreachable') this.#patch(name, { blocked: { ...(this.#record(name).blocked ?? {}), [b]: { head: tip.id, at: new Date(now).toISOString() } } });
            /* Final for this commit: not tried again. Passing (the remote
               silent, the outcome unknown, the agent moving meanwhile): the
               same commit is tried again later -- a blocked one once a
               refresh settled it. */
            if (FINAL.has(kind)) held.done.set(b, tip.id);
            else if (!['agent-moved', 'busy', 'reread'].includes(kind)) held.retry.set(b, { id: tip.id, at: now + RETRY_MS });
            const why = kind === 'diverged' || kind === 'remote-moved' ? 'diverged' : `refused-${kind}`;
            /* A grave failure tells the phone whatever the option for
               routine notices says -- once, and once only. */
            const grave = error instanceof GitFailure && error.alert;
            if (grave && held.said.get(b) !== `${tip.id}:${why}`) this.#tell(`${name}: sending needs a look`, error.message);
            once(why, { what: error instanceof Refusal ? error.message : 'Not sent: the sending failed.', tell: !grave, ...(error.ai ? { ai: error.ai.replace(/origin\/(\S+)/g, (m, x) => `origin/${plain(x)}`) } : {}) });
        }
    }

    async #autoSend(name, s, held) {
        const now = this.#now().getTime();
        const mark = this.#mark(name);
        if (held.mark !== mark) { held.mark = mark; held.changedAt = now; held.dirty = true; }
        const due = held.lastRead === undefined || (held.dirty && now - held.changedAt >= READ_DELAY_MS) || now - held.lastRead >= SAFETY_READ_MS;
        if (due) {
            held.dirty = false; held.lastRead = now;
            try { await this.#review.readTips(name); } catch { /* said by the read's listener */ }
            /* Changed while it was read: one more read. */
            const after = this.#mark(name);
            if (after !== held.mark) { held.mark = after; held.changedAt = this.#now().getTime(); held.dirty = true; }
        }
        if (held.dirty) return;
        if (this.#record(name).lastRead?.ok === false) return;
        for (const [b, tip] of Object.entries(this.#review.tips(name))) await this.#consider(name, s, held, b, tip).catch(() => {});
    }

    /* Each repository on its own: a read, a refresh or a send of one never
       waits for another's. A repository whose read takes its whole time
       limit (a FIFO in .git, a huge history) would otherwise hold up every
       other repository of the server, tick after tick. One run per
       repository at a time: a tick skips a repository still busy from an
       earlier one. (The host still reads two repositories at a time:
       gitrunner.mjs HOST_READS.) */
    async tick() {
        let list;
        try { list = this.#resources.list().filter((x) => x.type === 'git'); } catch { return; }
        const now = this.#now().getTime();
        const runs = [];
        for (const r of list) {
            if (this.#running.has(r.name)) continue;
            this.#running.add(r.name);
            runs.push(this.#tickOne(r, now).catch(() => { /* the next tick tries again */ }).finally(() => this.#running.delete(r.name)));
        }
        await Promise.all(runs);
    }

    async #tickOne(r, now) {
        const s = this.settings(r.name);
        if (!this.#review.remoteOf(r.name)) return;
        /* Left alone while no machine uses it (see the top of this file). */
        if (!await this.#inUse(r.name)) return;
        /* The reference, when due; its upkeep once a day. */
        const last = this.#record(r.name).mirror?.at;
        if (s.refreshMinutes > 0 && (!last || now - new Date(last).getTime() >= s.refreshMinutes * 60_000)) {
            await this.#review.refresh(r.name).catch(() => {});
            const upkeep = this.#record(r.name).upkeepAt;
            if (!upkeep || now - new Date(upkeep).getTime() >= UPKEEP_MS) {
                await this.#review.upkeep(r.name).catch(() => {});
                this.#patch(r.name, { upkeepAt: new Date(now).toISOString() });
            }
        }
        /* Automatic sending: only with a list. */
        if (s.autoBranches.length === 0) { this.#held.delete(r.name); return; }
        let held = this.#held.get(r.name);
        if (!held) { held = { said: new Map(), done: new Map(), lacks: new Map(), retry: new Map() }; this.#held.set(r.name, held); }
        await this.#autoSend(r.name, s, held).catch(() => {});
    }

    async #staleLocks(name) {
        const runner = this.#review.runner;
        if (!runner || !this.#resources.hasOrigin(name)) return [];
        const reference = this.#resources.originPath(name);
        const release = await runner.lock(reference, 60_000);
        let removed;
        try { removed = runner.staleLocks(reference); } finally { release(); }
        if (removed.length) this.#log(name, { ok: false, what: `Stale lock files left in the reference by a stop of the server were removed: ${removed.join(', ')}.` });
        return removed;
    }

    start(everyMs = TICK_MS) {
        /* A read the server gave up on when it stopped is stopped on the host;
           a fetch it killed may have left lock files in the reference, which
           would refuse every later refresh. No git of ours runs there yet:
           they are removed under the reference's lock, and said. */
        for (const r of this.#resources.list().filter((x) => x.type === 'git')) {
            void this.#review.runner?.stopReads(r.name);
            void this.#staleLocks(r.name).catch(() => {});
        }
        const timer = setInterval(() => { void this.tick(); }, everyMs);
        timer.unref?.();
        /* Looked at soon after a start, not a whole period later. */
        setTimeout(() => { void this.tick(); }, Math.min(everyMs, 5000)).unref?.();
        return timer;
    }
}
