/* MULTIPASS UPDATED IN CLAVARIUM'S OWN WINDOW (23-11, its owner's ask, after a morning on a real server: snap
 * updated Multipass by itself at 06:08, every machine was left suspended, nothing could be reached).
 *
 * At each turn of the updater (as root):
 *   - updates by itself (auto, asap): snap's own refresh of Multipass is held, for good;
 *   - never by itself (off, ask): the hold is taken off, so that Multipass still gets its fixes from snap;
 *   - machines left suspended by a turn that was cut are started again first;
 *   - in the update window, nothing being built or moved, a new Multipass out: the machines that run are put to
 *     sleep, written down, Multipass updated, those machines started again. Never more than one try a day.
 * Only the machines that ran are started again: one asleep before stays asleep.
 */
const SNAP_MS = 60_000;
const REFRESH_MS = 15 * 60_000;
const MACHINE_MS = 180_000;
const BACK_TRIES = 36;
const BACK_EVERY_MS = 5_000;
export const TRY_EVERY_MS = 20 * 3600_000;

const first = (r) => String(r?.stderr || r?.stdout || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 200) || `exit ${r?.code}`;

/* The line of `snap list multipass` says "held" in its notes. */
export const isHeld = (text) => String(text).split('\n').some((l) => /^multipass\s/.test(l) && /\bheld\b/.test(l.trim().split(/\s+/).pop() ?? ''));
/* A newer revision on the channel it follows, from `snap info multipass` (`snap refresh --list` leaves out a held snap). */
export function hasRefresh(text) {
    const t = String(text);
    const tracking = /^tracking:\s+(\S+)/m.exec(t)?.[1];
    const installed = Number(/^installed:.*\((\d+)\)/m.exec(t)?.[1]);
    if (!tracking || !Number.isFinite(installed)) return false;
    const line = t.split('\n').find((l) => l.trim().startsWith(`${tracking}:`));
    const offered = Number(/\((\d+)\)/.exec(line ?? '')?.[1]);
    return Number.isFinite(offered) && offered > installed;
}
/* The machines of this Clavarium that run, from `multipass list --format json`. */
export function runningMachines(text) {
    let list;
    try { list = JSON.parse(text).list; } catch { return null; }
    if (!Array.isArray(list)) return null;
    return list.filter((m) => m?.state === 'Running' && /^clv-[a-z0-9-]+$/.test(m?.name ?? '')).map((m) => m.name);
}

export async function multipassTurn({ run, mode, inWindow, busy, state, save, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), multipass = '/snap/bin/multipass' }) {
    const sh = (argv, timeoutMs = SNAP_MS) => Promise.resolve(run(argv, { timeoutMs })).catch((e) => ({ code: 1, stderr: e.message }));
    const list = await sh(['snap', 'list', 'multipass']);
    if (list.code !== 0) return 'no multipass here';
    const held = isHeld(list.stdout);
    const own = mode === 'auto' || mode === 'asap';
    if (!own) {
        if (held) { const r = await sh(['snap', 'refresh', '--unhold', 'multipass']); log(r.code === 0 ? 'multipass: snap updates it again (updates are not automatic here)' : `multipass: the hold could not be taken off: ${first(r)}`); }
    } else if (!held) {
        const r = await sh(['snap', 'refresh', '--hold', 'multipass']);
        if (r.code !== 0) { log(`multipass: snap's own updates could not be held: ${first(r)}`); return 'not held'; }
        log('multipass: updated in the update window from now on, no longer by snap at any hour');
    }

    const answers = async () => { for (let i = 0; i < BACK_TRIES; i += 1) { if ((await sh([multipass, 'list', '--format', 'json'], 30_000)).code === 0) return true; await sleep(BACK_EVERY_MS); } return false; };
    /* Started again; what could not be stays written down, for the next turn. */
    const back = async (names) => {
        if (!(await answers())) { log('multipass: it does not answer: its machines are started at the next turn'); return names; }
        const left = [];
        for (const name of names) {
            let r = await sh([multipass, 'start', name], MACHINE_MS);
            if (r.code !== 0) { await sleep(BACK_EVERY_MS); r = await sh([multipass, 'start', name], MACHINE_MS); }
            if (r.code !== 0) { left.push(name); log(`multipass: ${name} could not be started again: ${first(r)}`); }
        }
        return left;
    };

    const pending = state().multipassRefresh?.machines ?? [];
    if (pending.length) {
        const left = await back(pending);
        save({ multipassRefresh: { ...state().multipassRefresh, machines: left } });
        if (left.length) return `${left.length} machine(s) still to start again`;
        log('multipass: the machines of the last update are running again');
    }
    if (!own || !inWindow) return 'nothing to do';
    const tried = Date.parse(state().multipassRefresh?.triedAt ?? '');
    if (Number.isFinite(tried) && now() - tried < TRY_EVERY_MS) return 'tried lately';
    const out = await sh(['snap', 'info', 'multipass']);
    if (out.code !== 0 || !hasRefresh(out.stdout)) return 'up to date';
    const why = await busy();
    if (why) return `waits: ${why}`;
    const seen = await sh([multipass, 'list', '--format', 'json'], 30_000);
    const running = seen.code === 0 ? runningMachines(seen.stdout) : null;
    if (!running) { log(`multipass: its machines could not be read: not updated (${first(seen)})`); return 'not updated'; }

    /* Written down BEFORE anything stops: a turn cut here still brings them back. */
    save({ multipassRefresh: { triedAt: new Date(now()).toISOString(), machines: running } });
    log(`multipass: a new version: ${running.length} machine(s) put to sleep for its update`);
    for (const name of running) {
        const r = await sh([multipass, 'suspend', name], MACHINE_MS);
        if (r.code !== 0) {
            log(`multipass: ${name} could not be put to sleep (${first(r)}): not updated, its machines started again`);
            save({ multipassRefresh: { ...state().multipassRefresh, machines: await back(running) } });
            return 'not updated';
        }
    }
    /* --ignore-running: a client of Multipass still open (a terminal, a command) would make snap refuse (seen on a real machine); its machine is asleep. */
    const done = await sh(['snap', 'refresh', 'multipass', '--ignore-running'], REFRESH_MS);
    log(done.code === 0 ? 'multipass: updated' : `multipass: its update failed: ${first(done)}`);
    const left = await back(running);
    save({ multipassRefresh: { ...state().multipassRefresh, machines: left } });
    log(left.length ? `multipass: ${left.length} machine(s) to start again at the next turn` : 'multipass: its machines are running again');
    return done.code === 0 ? 'updated' : 'update failed';
}
