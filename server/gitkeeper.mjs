/* WHAT HAPPENS TO A REPOSITORY WHEN NOBODY IS LOOKING -- and only what its
 * owner allowed.
 *
 * Three things. The first two per repository, set by the owner in the review
 * panel; the third per ATTACHMENT -- per conversation and repository -- set
 * where the conversation is given the repository for writing:
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
 *   AUTOMATIC SENDING, OFF UNLESS THE OWNER NAMES BRANCHES FOR A
 *   CONVERSATION. Two conversations writing in the same repository are two
 *   agents with two jobs: the owner may let one send its try/* branches by
 *   itself and keep the other under review, so the settings belong to the
 *   attachment, not to the repository. Each list is empty to begin with,
 *   and nothing is ever sent automatically to a branch outside it; "*" and
 *   the remote's default branch count only once the owner confirmed them
 *   (one click too many is cheaper than a tool sending to production). A
 *   branch whose tip has commits the remote lacks, and whose tip has not
 *   moved for that conversation's quiet delay, and whose name is in its
 *   list, is sent to the remote's branch of the same name exactly as Send
 *   would send it (gitpush.mjs): read again, never forced, a lease on the
 *   remote's tip, a branch the remote lacks made only where the owner
 *   allowed it. Only while that conversation's machine runs: its agent is
 *   the one at work, its checks run there (required unless the owner turned
 *   them off for it), its cap per hour stops it if it commits in a loop.
 *   Every attempt that matters is written in the repository's log, with
 *   the conversation it was for; the owner's phone can be told.
 *   (The folder is one for all the conversations that write in it: the
 *   runner reads its branches once, and each conversation's settings decide
 *   for the branches they name. Per-agent folders are deferred: see
 *   blueprint/git-runner-core.md.)
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
    refreshMinutes: 5, alert: true,
    checkCommand: '', checkSeconds: 600, runHook: true, requireForSend: false, fsck: {},
});
/* Automatic sending, for one conversation and one repository. A quiet
   delay in seconds: the read already waits READ_DELAY_MS after the last
   change, so a few seconds more are enough to let a commit series finish.
   `confirmed`: the patterns of the list that needed the owner's word and
   had it. `perHour` 0: no cap. */
export const AUTO_DEFAULTS = Object.freeze({ branches: [], confirmed: [], quietSeconds: 5, perHour: 20, create: false, checks: true });
export const QUIET_MAX = 86_400;
export const PER_HOUR_MAX = 1000;
/* What the previous version kept per repository; taken over per conversation, once. */
const OLD_KEYS = ['autoBranches', 'quietMinutes', 'perHour'];
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

/* The remote's default branch, or the usual names while it is not known:
   a guess that errs towards asking the owner once more. */
export function defaultsOf(defaultBranch) { return defaultBranch ? [defaultBranch] : ['main', 'master']; }
/* A pattern the owner must confirm: one made of nothing but "*" (any
   branch), or one that reaches the default branch (what is usually
   deployed). */
export function needsConfirmation(pattern, defaultBranch) {
    return /^[*/]+$/.test(pattern) || defaultsOf(defaultBranch).some((d) => allowed([pattern], d));
}
/* May a conversation with these settings send `branch` by itself? A
   pattern that needs confirmation and lacks it counts for nothing -- also
   when it came to need it later (the remote's default branch changed). */
export function mayAutoSend(settings, branch, defaultBranch) {
    const confirmed = settings?.confirmed ?? [];
    return (settings?.branches ?? []).some((p) => allowed([p], branch) && (!needsConfirmation(p, defaultBranch) || confirmed.includes(p)));
}
export function autoSettings(entry) { return Object.fromEntries(Object.keys(AUTO_DEFAULTS).map((k) => [k, entry?.[k] ?? AUTO_DEFAULTS[k]])); }
const branchList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map((p) => String(p).trim()).filter(Boolean);

/* The settings asked for, checked, from those there were. Refused with
   kind "confirm-wide" when a pattern needs the owner's word and `sure` is
   not set: the page asks, then sends again with `sure`. */
export function readAuto(body, before, defaultBranch) {
    const next = { ...autoSettings(before) };
    if (body?.branches !== undefined) {
        const list = branchList(body.branches);
        if (list.length > PATTERNS_MAX) throw new Refusal(400, `At most ${PATTERNS_MAX} branches or patterns.`);
        for (const p of list) { const why = patternProblem(p); if (why) throw new Refusal(400, why); }
        next.branches = [...new Set(list)];
    }
    const whole = (value, high, why) => {
        if (value === undefined) return undefined;
        const n = Number(value);
        if (value === '' || value === null || !Number.isInteger(n) || n < 0 || n > high) throw new Refusal(400, why);
        return n;
    };
    const quiet = whole(body?.quietSeconds, QUIET_MAX, 'How many quiet seconds before sending? A whole number, a day at most.');
    if (quiet !== undefined) next.quietSeconds = quiet;
    const cap = whole(body?.perHour, PER_HOUR_MAX, `Automatic sendings an hour: a whole number from 0 (no cap) to ${PER_HOUR_MAX}.`);
    if (cap !== undefined) next.perHour = cap;
    for (const flag of ['create', 'checks']) if (body?.[flag] !== undefined) next[flag] = body[flag] === true;
    /* A confirmation is for the patterns it was given for: one removed from
       the list and typed again is asked about again. */
    const wide = next.branches.filter((p) => needsConfirmation(p, defaultBranch));
    next.confirmed = body?.sure === true ? wide : next.confirmed.filter((p) => wide.includes(p));
    const asked = wide.filter((p) => !next.confirmed.includes(p));
    if (asked.length) {
        const where = defaultsOf(defaultBranch).join(' or ');
        throw new GitFailure(409, 'confirm-wide', `Confirm: ${asked.join(', ')} would let this conversation send by itself to any branch, or to the remote's default branch (${where}).`);
    }
    return next;
}

/* A record of the previous version: its one setting for the repository
   becomes the starting setting of each conversation that writes in it, and
   is no longer kept. Branches that the remote lacked were made then, and
   the owner's list said "*" or "main" without being asked: both are kept as
   they were, so that nothing stops or starts on its own at an update.
   null: nothing to take over. */
export function migrated(record, writers) {
    if (!OLD_KEYS.some((k) => k in record)) return null;
    const branches = [...new Set(branchList(record.autoBranches).filter((p) => !patternProblem(p)))].slice(0, PATTERNS_MAX);
    const clamp = (n, high, otherwise) => (Number.isFinite(Number(n)) ? Math.min(high, Math.max(0, Math.round(Number(n)))) : otherwise);
    const start = { branches, confirmed: branches, quietSeconds: clamp(Number(record.quietMinutes ?? 10) * 60, QUIET_MAX, 600), perHour: clamp(record.perHour ?? 4, PER_HOUR_MAX, 4), create: true, checks: true, sent: [] };
    const auto = { ...(record.auto ?? {}) };
    for (const conversation of writers) if (!auto[conversation]) auto[conversation] = { ...start, branches: [...branches], confirmed: [...branches] };
    const rest = { ...record };
    for (const k of OLD_KEYS) delete rest[k];
    return { ...rest, auto };
}

export class GitKeeper {
    #store; #review; #resources; #checks; #alerts; #now; #tellAgent; #held = new Map(); #results = new Map(); #running = new Set(); #telling = new Map();

    /* `review`: GitReview (reads, the reference, Send). `checks`: GitChecks.
       `alerts`: what tells the owner's phone. `tellAgent(repository, line,
       conversation?)`: what types one line to the agents that write in the
       repository (only to that conversation's, when one is named); it
       resolves false when nobody could be told (then it is tried again). */
    constructor({ store, review, resources, checks, alerts, now = () => new Date(), tellAgent = async () => {} }) {
        this.#store = store; this.#review = review; this.#resources = resources; this.#checks = checks; this.#alerts = alerts; this.#now = now; this.#tellAgent = tellAgent;
        review.listen({ read: (name, failure, got) => this.#readOutcome(name, failure, got), refresh: (name, result) => this.#refreshOutcome(name, result) });
        review.useWaivers?.((name) => this.settings(name).fsck);
        /* The previous version's per-repository setting, taken over once (see migrated). */
        for (const record of store.all()) {
            const next = migrated(record, this.#writers(record.name));
            if (next) store.put(next);
        }
    }

    #repository(name) {
        const r = this.#resources.get(String(name ?? ''));
        if (!r || r.type !== 'git') throw new Refusal(404, 'No such repository.');
        return r;
    }
    #record(name) { return this.#store.get(name) ?? { name }; }
    #patch(name, changes) { this.#store.put({ ...this.#record(name), ...changes }); }
    settings(name) { const r = this.#record(name); return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, r[k] ?? DEFAULTS[k]])); }
    /* The conversations that have the repository attached for writing, by name. */
    #writers(name) {
        let list;
        try { list = this.#resources.list(); } catch { return []; }
        return Object.entries(list.find((x) => x.name === name)?.attachments ?? {}).filter(([, access]) => access === 'write').map(([c]) => c).sort();
    }
    #autoOf(name, conversation) { return autoSettings(this.#record(name).auto?.[conversation]); }
    #defaultBranch(name) { return this.#review.defaultBranch?.(name) ?? null; }

    /* What the page shows: the settings, the reference and where the tool
       finds it, the last checks, the last read, the log. Never a key. */
    about(name) {
        const r = this.#repository(name);
        const record = this.#record(r.name);
        const hasRemote = Boolean(this.#review.remoteOf(r.name));
        const folder = originFolder(r.name);
        /* Which conversations send by themselves, for the review panel to say
           where that is set; the settings themselves are in each one's panel. */
        const auto = Object.fromEntries(this.#writers(r.name).map((c) => [c, this.#autoOf(r.name, c).branches]).filter(([, branches]) => branches.length > 0));
        return {
            settings: this.settings(r.name),
            auto,
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
        /* A page from before automatic sending moved to each conversation:
           refused, rather than saved where nothing reads it any more. */
        if (OLD_KEYS.some((k) => body?.[k] !== undefined)) throw new Refusal(400, 'Automatic sending is now set for each conversation, where it is given this repository for writing.');
        const seconds = whole(body?.checkSeconds, SECONDS_MIN, SECONDS_MAX, `The time limit of the checks: ${SECONDS_MIN} to ${SECONDS_MAX} seconds.`);
        if (seconds !== undefined) next.checkSeconds = seconds;
        if (body?.checkCommand !== undefined) {
            const command = String(body.checkCommand).trim();
            if (command.length > COMMAND_MAX || /[\r\n\0]/.test(command)) throw new Refusal(400, `The check command is one line, ${COMMAND_MAX} characters at most.`);
            next.checkCommand = command;
        }
        /* fsck waivers: only the ids kept for old histories, never one that guards a checkout. */
        if (body?.fsck !== undefined) {
            const why = waiversProblem(body.fsck);
            if (why) throw new Refusal(400, why);
            next.fsck = { ...body.fsck };
        }
        for (const flag of ['alert', 'runHook', 'requireForSend']) if (body?.[flag] !== undefined) next[flag] = body[flag] === true;
        this.#store.put({ ...this.#record(r.name), ...next });
        /* Settings just set start from now: what was decided before is looked at again. */
        this.#held.delete(r.name);
        return this.about(r.name);
    }

    /* ---------- automatic sending, per conversation ---------- */

    /* What the conversation's panel shows under "Automatic sending". Only
       where the repository is attached for writing: read-only, the agent
       has nothing of its own to send. */
    auto(name, conversation) {
        const r = this.#repository(name);
        if (!this.#writers(r.name).includes(conversation)) throw new Refusal(409, 'Automatic sending is set where the repository is attached for writing.');
        const entry = this.#record(r.name).auto?.[conversation];
        const defaultBranch = this.#defaultBranch(r.name);
        return { settings: autoSettings(entry), defaultBranch, asked: defaultsOf(defaultBranch), sentThisHour: this.#recentOf(entry?.sent).length };
    }
    setAuto(name, conversation, body) {
        const r = this.#repository(name);
        if (!this.#writers(r.name).includes(conversation)) throw new Refusal(409, 'Automatic sending is set where the repository is attached for writing.');
        const record = this.#record(r.name);
        const before = record.auto?.[conversation];
        const next = readAuto(body, before, this.#defaultBranch(r.name));
        this.#store.put({ ...record, auto: { ...(record.auto ?? {}), [conversation]: { ...next, sent: before?.sent ?? [] } } });
        this.#held.delete(r.name);
        return this.auto(r.name, conversation);
    }
    /* Detached (or made read-only): its settings go with the attachment, so
       that attaching it again starts from an empty list, not from a choice
       made for another job. */
    forgetAttachment(name, conversation) {
        const record = this.#store.get(name);
        if (!record?.auto?.[conversation]) return;
        const auto = { ...record.auto };
        delete auto[conversation];
        this.#store.put({ ...record, auto });
        this.#held.delete(name);
    }
    /* A conversation archived: all its settings, whatever the repository. */
    forgetConversation(conversation) { for (const record of this.#store.all()) this.forgetAttachment(record.name, conversation); }

    forget(name) { this.#store.remove(name); this.#held.delete(name); this.#results.delete(name); }

    /* ---------- what every read and every refresh says ---------- */

    #tell(title, body) { if (this.#alerts) void this.#alerts.tell({ title, body, url: '/' }).catch(() => {}); }
    /* Marked as told only once somebody was: a line typed to no machine
       (all asleep, a terminal that failed) is said again the next time. */
    #toAgent(name, line, conversation) {
        if (this.#record(name).toldAgent === line || this.#telling.get(name) === line) return;
        this.#telling.set(name, line);
        void Promise.resolve(this.#tellAgent(name, `Clavarium, repository ${name}: ${line}.`, conversation))
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
    /* `machine`: the conversation whose machine runs them (automatic sending). */
    async #check(name, seen, machine) {
        const s = this.settings(name);
        const result = await this.#checks.run(name, { head: seen.head, branch: seen.branch, target: seen.target, remoteTip: seen.remoteTip, remote: this.#review.remoteOf(name), command: s.checkCommand, hook: s.runHook, seconds: s.checkSeconds, ...(machine ? { machine } : {}) });
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

    #recentOf(times) { const hourAgo = this.#now().getTime() - 3_600_000; return (times ?? []).filter((at) => new Date(at).getTime() > hourAgo); }
    #recent(record) { return this.#recentOf(record.sent); }
    /* `sent`: counted in the hour of the repository (shown on the page) and,
       with `by`, in that conversation's (its cap). */
    #log(name, entry, { sent = false, by } = {}) {
        const record = this.#record(name);
        const at = this.#now().toISOString();
        const auto = sent && by && record.auto?.[by] ? { auto: { ...record.auto, [by]: { ...record.auto[by], sent: [...this.#recentOf(record.auto[by].sent), at] } } } : {};
        this.#store.put({ ...record, log: [{ at, ...entry, what: String(entry.what).slice(0, 300) }, ...(record.log ?? [])].slice(0, LOG_MAX), ...(sent ? { sent: [...this.#recent(record), at] } : {}), ...auto });
    }
    #mark(name) {
        const folder = this.#resources.folder(name);
        return MARKS.map((m) => { try { const s = lstatSync(`${folder}/${m}`); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return '-'; } }).join('|');
    }
    async #inUse(name) { try { return Boolean(await this.#checks.machineFor(name)); } catch { return false; } }
    async #runs(conversation, name) { try { return Boolean(await this.#checks.runs?.(conversation, name)); } catch { return false; } }

    /* Said once per commit, per branch and per conversation ('' for what is
       the repository's, whoever's settings): the log, the phone when asked,
       the agent of that conversation where it can act. */
    #once(name, held, b, tip, conversation, why, entry) {
        const key = `${tip.id}:${why}`;
        const said = held.said.get(b) ?? new Map();
        if (said.get(conversation) === key) return;
        said.set(conversation, key); held.said.set(b, said);
        const { tell, ai, ...rest } = entry;
        this.#log(name, { branch: b, head: tip.id, ok: false, ...(conversation ? { conversation } : {}), ...rest });
        if (tell && this.settings(name).alert) this.#tell(`${name}: not sent`, entry.what);
        if (ai) this.#toAgent(name, ai, conversation || undefined);
    }

    /* One branch of the last read: what the remote already has is left
       alone; otherwise each running conversation whose list names it, in
       turn, until one sent it. `listed`: the conversations with a list;
       `running`: those of them whose machine runs. A branch only a sleeping
       conversation names waits for it, and is not "outside every list". */
    async #consider(name, held, b, tip, listed, running) {
        const once = (why, entry) => this.#once(name, held, b, tip, '', why, entry);
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
        const defaultBranch = this.#defaultBranch(name);
        const deciding = listed.filter((c) => mayAutoSend(this.#autoOf(name, c), b, defaultBranch));
        if (deciding.length === 0) return once('list', { what: `Not sent: ${b} is not in the list of branches that may be sent to automatically.` });
        for (const conversation of deciding) if (running.includes(conversation) && await this.#considerFor(name, held, b, tip, conversation)) return;
    }

    /* The branch, as one conversation's settings say. True: it went (or was there already). */
    async #considerFor(name, held, b, tip, conversation) {
        const s = this.#autoOf(name, conversation);
        const alert = this.settings(name).alert;
        const now = this.#now().getTime();
        const once = (why, entry) => this.#once(name, held, b, tip, conversation, why, entry);
        if (now - new Date(tip.movedAt).getTime() < s.quietSeconds * 1000) return false;
        if (held.done.get(b) === tip.id) return false;
        /* A passing failure: tried again, but not at every tick. */
        const retry = held.retry.get(b);
        if (retry && retry.id === tip.id && now < retry.at) return false;
        const sentHere = this.#recentOf(this.#record(name).auto?.[conversation]?.sent).length;
        if (s.perHour > 0 && sentHere >= s.perHour) return once('cap', { what: `Not sent: ${s.perHour} automatic sending(s) this hour already for ${conversation}, the cap you set.`, tell: true }), false;
        const remoteTip = await this.#review.remoteTip(name, b);
        /* Only branches the remote has, unless the owner allowed this
           conversation to make them: asked again under the lock by the send. */
        if (!remoteTip && !s.create) return once('create', { what: `Not sent: ${b} does not exist on the remote, and ${conversation} may not create branches by itself.`, ai: `${plain(b)} was not sent: it does not exist on the remote, and only the owner can make it` }), false;
        if (s.checks) {
            const checks = await this.#check(name, { head: tip.id, branch: b, target: b, remoteTip }, conversation);
            if (checks.status !== 'passed') {
                /* Its machine did not run them: tried again later, when it may. */
                if (checks.status !== 'unavailable') held.done.set(b, tip.id);
                const why = checks.status === 'failed' ? `the checks failed in the machine of ${conversation}` : checks.status === 'none' ? 'automatic sending needs passing checks, and none is set (no pre-push hook, no check command)' : `the checks could not run: the machine of ${conversation} does not run`;
                return once(`checks-${checks.status}`, { what: `Not sent: ${why}.`, tell: true, ...(checks.status === 'failed' ? { ai: `the checks failed for ${plain(b)}, it was not sent` } : {}) }), false;
            }
        }
        const checked = s.checks ? 'checks passed' : 'no checks asked for';
        try {
            /* auto: no owner was shown a remote tip; the remote's tip of the
               moment is the lease, and "has it all" the guard. */
            const sent = await this.#review.send(name, { branch: b, head: tip.id, target: b, remoteTip, auto: true, create: s.create });
            held.done.set(b, tip.id); held.said.delete(b); held.retry.delete(b);
            if (sent.already) { this.#log(name, { branch: b, head: tip.id, conversation, ok: true, what: `Already on the remote: ${b}.` }, { sent: true, by: conversation }); return true; }
            this.#log(name, { branch: b, head: tip.id, conversation, ok: true, what: `Sent automatically for ${conversation}: ${sent.commits} commit(s) to ${sent.branch}${sent.made ? ' (a new branch)' : ''}, ${checked}.${sent.note ? ` ${sent.note}` : ''}` }, { sent: true, by: conversation });
            if (alert) this.#tell(`${name}: sent to ${sent.branch}`, `${sent.commits} commit(s), automatically for ${conversation}, ${checked}.`);
            return true;
        } catch (error) {
            const kind = error instanceof GitFailure ? error.kind : 'error';
            if (kind === 'unknown-unreachable') this.#patch(name, { blocked: { ...(this.#record(name).blocked ?? {}), [b]: { head: tip.id, at: new Date(now).toISOString() } } });
            /* Final for this commit: not tried again. Passing (the remote
               silent, the outcome unknown, the agent moving meanwhile, the
               branch gone from the remote since it was looked at): the same
               commit is tried again later -- a blocked one once a refresh
               settled it. */
            if (FINAL.has(kind)) held.done.set(b, tip.id);
            else if (!['agent-moved', 'busy', 'reread'].includes(kind)) held.retry.set(b, { id: tip.id, at: now + RETRY_MS });
            const why = kind === 'diverged' || kind === 'remote-moved' ? 'diverged' : `refused-${kind}`;
            /* A grave failure tells the phone whatever the option for
               routine notices says -- once, and once only. */
            const grave = error instanceof GitFailure && error.alert;
            if (grave && held.said.get(b)?.get(conversation) !== `${tip.id}:${why}`) this.#tell(`${name}: sending needs a look`, error.message);
            once(why, { what: error instanceof Refusal ? error.message : 'Not sent: the sending failed.', tell: !grave, ...(error.ai ? { ai: error.ai.replace(/origin\/(\S+)/g, (m, x) => `origin/${plain(x)}`) } : {}) });
            return false;
        }
    }

    async #autoSend(name, listed, running, held) {
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
        for (const [b, tip] of Object.entries(this.#review.tips(name))) await this.#consider(name, held, b, tip, listed, running).catch(() => {});
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
        /* Automatic sending: only for the conversations that write in it
           with a list, and only those whose machine runs. */
        const listed = this.#writers(r.name).filter((c) => this.#autoOf(r.name, c).branches.length > 0);
        if (listed.length === 0) { this.#held.delete(r.name); return; }
        const running = [];
        for (const c of listed) if (await this.#runs(c, r.name)) running.push(c);
        if (running.length === 0) return;
        let held = this.#held.get(r.name);
        if (!held) { held = { said: new Map(), done: new Map(), lacks: new Map(), retry: new Map() }; this.#held.set(r.name, held); }
        await this.#autoSend(r.name, listed, running, held).catch(() => {});
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
