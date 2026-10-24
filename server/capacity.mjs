/* THIS SERVER'S ROOM: its disk and its memory, what takes them, and a
 * RESERVE that no machine may eat into.
 *
 * Read through two read-only verbs of the host program (deploy/clavarium-
 * host, "server room" and "server usage"), which take no argument from
 * anyone: what they print is numbers and our own names, and only lines of
 * the expected shape are taken. No machine is ever asked anything here: one
 * asleep stays asleep.
 *
 *   room    what is free (disk, memory) and what each running machine holds
 *           in memory. Cheap: asked again after ROOM_MS, and afresh before
 *           a machine is created, started, woken or grown.
 *   usage   what takes the disk (this server's data, the folders, the work
 *           disks, the machines' disks, the images). Slow (it measures
 *           folders): asked again after USAGE_MS at most, in the background.
 *
 * THE RESERVE (Settings, This server, Resources): for each of disk and
 * memory, the larger of a fixed amount and a share of the whole (by default
 * disk 5 GB or 5 %, memory 1 GB or 5 %). It is judged on what the system
 * says is free (df on the machines' disk, MemAvailable), never on sums of
 * what machines were given:
 *   - creating, starting, waking or growing a machine is refused, with a
 *     sentence that says why and what to do, when what is free less what the
 *     machine needs at first would be under the reserve. Memory: its size
 *     (or what it grows by). Disk: what a new machine takes, or what a disk
 *     grows by. Starting or waking is never refused for disk: a full disk is
 *     cleaned from inside the conversations.
 *   - all the time (watch): once what is free falls under the reserve, the
 *     owner is alerted and the running machine that takes the most is put to
 *     sleep, said in its conversation. Once: again only after what is free
 *     came back above the reserve.
 * What was PROMISED (the disks' largest sizes, the memory given to running
 * machines) is only said, with a warning when it is more than there is.
 *
 * When the figures cannot be read (a host program from before these verbs),
 * nothing is refused: the reserve is a guard, not a gate that jams.
 */
import { Refusal, DISK_GB } from './conversations.mjs';
import { MIN_FREE_MB } from './shelf.mjs';

export const RESERVE_DISK_MB = 5 * 1024;
export const RESERVE_MEMORY_MB = 1024;
export const RESERVE_DISK_PERCENT = 5;
export const RESERVE_MEMORY_PERCENT = 5;
/* How often what is free is looked at, against the reserve. */
export const WATCH_MS = 60_000;
/* What may be set, in megabytes. */
export const RESERVE_DISK_MAX_MB = 1024 * 1024;
export const RESERVE_MEMORY_MAX_MB = 256 * 1024;
export const ROOM_MS = 10_000;
export const USAGE_MS = 5 * 60_000;
/* The page shows its small gauge when disk or memory is fuller than this, or
   when what is free is under this many times the reserve. */
export const HIGH_PERCENT = 85;
export const HIGH_FACTOR = 1.5;
/* What a new machine takes on disk when no ready-made machine says it. */
export const NEW_MACHINE_MB = 3 * 1024;
const PLACES = ['machines', 'data', 'folders'];
const USED = ['data', 'folders', 'work', 'removed', 'tools', 'shelf', 'others', 'images'];
const VM = /^(clv-[a-z0-9-]{1,32}|clvshelf-[0-9]{8}-[0-9]{6})$/;
const whole = (text) => (/^\d{1,12}$/.test(String(text)) ? Number(text) : undefined);

/* What "server room" printed, as facts; any other line is left out. */
export function readRoom(text) {
    const facts = { places: [], memory: null, machines: [], cpu: null, machineCpu: {} };
    for (const line of String(text ?? '').slice(0, 64 * 1024).split('\n').slice(0, 500)) {
        const p = line.trim().split(' ');
        if (p[0] === 'place' && p.length === 5 && PLACES.includes(p[1]) && [2, 3, 4].every((i) => whole(p[i]) !== undefined) && !facts.places.some((x) => x.what === p[1])) facts.places.push({ what: p[1], device: whole(p[2]), sizeMb: whole(p[3]), freeMb: whole(p[4]) });
        if (p[0] === 'memory' && p.length === 3 && whole(p[1]) > 0 && whole(p[2]) !== undefined) facts.memory = { totalMb: whole(p[1]), availableMb: whole(p[2]) };
        if (p[0] === 'cpu' && p.length === 4 && [1, 2, 3].every((i) => whole(p[i]) !== undefined)) facts.cpu = { ticks: whole(p[1]), idle: whole(p[2]), cores: whole(p[3]) };
        if (p[0] === 'machinecpu' && p.length === 3 && VM.test(p[1]) && whole(p[2]) !== undefined) facts.machineCpu[p[1]] = whole(p[2]);
        if (p[0] === 'machine' && p.length === 3 && VM.test(p[1]) && whole(p[2]) !== undefined && !facts.machines.some((m) => m.vm === p[1])) facts.machines.push({ vm: p[1], rssMb: whole(p[2]) });
    }
    return facts;
}

/* What "server usage" printed, as facts. */
export function readUsage(text) {
    const facts = { machines: {} };
    for (const line of String(text ?? '').slice(0, 64 * 1024).split('\n').slice(0, 500)) {
        const p = line.trim().split(' ');
        if (p[0] !== 'used') continue;
        if (p.length === 3 && USED.includes(p[1]) && whole(p[2]) !== undefined) facts[p[1]] = whole(p[2]);
        if (p.length === 4 && p[1] === 'machine' && /^clv-[a-z0-9-]{1,32}$/.test(p[2]) && whole(p[3]) !== undefined) facts.machines[p[2].slice(4)] = whole(p[3]);
    }
    return facts;
}

export const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
const percent = (part, all) => (all > 0 ? Math.round((part / all) * 100) : 0);

export class Capacity {
    /* What the machines take on their disk, as last measured (MB), or undefined. */
    machinesUsedMb() { const u = this.#usage; if (!u) return undefined; return Object.values(u.machines ?? {}).reduce((a, b) => a + b, 0) + (u.shelf ?? 0) + (u.images ?? 0); }
    #run; #store; #conversations; #shelf; #now; #roomMs; #sleep; #alert; #say; #short = { disk: false, memory: false }; #room = null; #roomAt = -Infinity; #usage = null; #usageAt = -Infinity; #going = null; #measuring = null;

    /* `run(argv)`: the host program. `store`: where the reserve is kept.
       `conversations`: what each machine was given. `shelf`: how large a
       ready-made machine is (a new one is a copy of it). */
    /* `roomMs`: how long what is free is taken as known (ROOM_MS). */
    /* `sleep(name)`, `alert(payload)`, `say(name, text)`: what watch() does
       when what is free falls under the reserve. */
    constructor({ run, store, conversations, shelf = null, now = () => Date.now(), roomMs = ROOM_MS, sleep = null, alert = null, say = null }) {
        this.#roomMs = roomMs; this.#sleep = sleep; this.#alert = alert; this.#say = say;
        this.#run = run; this.#store = store; this.#conversations = conversations; this.#shelf = shelf; this.#now = now;
    }

    /* The two settings of each: a fixed amount and a share of the whole. */
    reserve() {
        const r = this.#store.get('reserve') ?? {};
        return { diskMb: r.diskMb ?? RESERVE_DISK_MB, diskPercent: r.diskPercent ?? RESERVE_DISK_PERCENT, memoryMb: r.memoryMb ?? RESERVE_MEMORY_MB, memoryPercent: r.memoryPercent ?? RESERVE_MEMORY_PERCENT };
    }
    setReserve({ diskMb, diskPercent, memoryMb, memoryPercent } = {}) {
        const now = this.reserve();
        const take = (value, max, what) => {
            if (value === undefined || value === null || value === '') return undefined;
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0 || n > max) throw new Refusal(400, max === 100 ? `The ${what} reserve share is a whole number of percent, from 0 to 100.` : `The ${what} reserve is a whole number of megabytes, from 0 to ${max}.`);
            return n;
        };
        const kept = {
            diskMb: take(diskMb, RESERVE_DISK_MAX_MB, 'disk') ?? now.diskMb,
            diskPercent: take(diskPercent, 100, 'disk') ?? now.diskPercent,
            memoryMb: take(memoryMb, RESERVE_MEMORY_MAX_MB, 'memory') ?? now.memoryMb,
            memoryPercent: take(memoryPercent, 100, 'memory') ?? now.memoryPercent,
        };
        this.#store.put({ name: 'reserve', ...kept });
        return this.reserve();
    }

    /* What is free now. `fresh`: asked again whatever the cache says. */
    async room({ fresh = false } = {}) {
        if (!fresh && this.#room && this.#now() - this.#roomAt < this.#roomMs) return this.#room;
        if (this.#going) return this.#going;
        this.#going = (async () => {
            const r = await this.#run(['server', 'room'], { timeoutMs: 20_000 }).catch(() => ({ code: 1 }));
            const facts = r.code === 0 ? readRoom(r.stdout) : null;
            if (facts?.memory || facts?.places.length) { this.#room = facts; this.#roomAt = this.#now(); }
            return this.#room;
        })().finally(() => { this.#going = null; });
        return this.#going;
    }

    /* What takes the disk; measured in the background when it is old. */
    #measure() {
        if (this.#measuring) return this.#measuring;
        this.#measuring = (async () => {
            const r = await this.#run(['server', 'usage'], { timeoutMs: 600_000 }).catch(() => ({ code: 1 }));
            if (r.code === 0) { this.#usage = readUsage(r.stdout); this.#usageAt = this.#now(); }
            return this.#usage;
        })().finally(() => { this.#measuring = null; });
        return this.#measuring;
    }

    /* The figures, as the page shows them. Never waits for a measure of the
       disk but the first one, and that one not long. */
    #figures(room) {
        if (!room) return null;
        const set = this.reserve();
        const all = this.#conversations.list();
        const records = new Map(all.map((c) => [`clv-${c.name}`, c]));
        const machines = room.machines.map((m) => {
            const c = records.get(m.vm);
            return { name: c ? c.name : null, shelf: m.vm.startsWith('clvshelf-'), rssMb: m.rssMb, sizeMb: c?.memoryMb ?? null };
        });
        /* What the system says is available: the machines' own use is in it already. */
        const memory = room.memory ? { totalMb: room.memory.totalMb, freeMb: room.memory.availableMb, usedPercent: percent(room.memory.totalMb - room.memory.availableMb, room.memory.totalMb) } : null;
        const where = room.places.find((p) => p.what === 'machines') ?? room.places[0];
        /* The reserve kept, in megabytes: the larger of the fixed amount and the share of the whole. */
        const share = (totalMb, pct) => Math.round((totalMb * pct) / 100);
        const reserve = {
            diskMb: Math.max(set.diskMb, where ? share(where.sizeMb, set.diskPercent) : 0),
            memoryMb: Math.max(set.memoryMb, memory ? share(memory.totalMb, set.memoryPercent) : 0),
        };
        /* Promised, only said: every disk at its largest, the memory given to running machines. */
        const diskPromisedMb = all.reduce((sum, c) => sum + (c.diskGb ?? DISK_GB) * 1024, 0);
        const memoryPromisedMb = machines.reduce((sum, m) => sum + (m.sizeMb ?? 0), 0);
        const promised = {
            disk: where ? { mb: diskPromisedMb, totalMb: where.sizeMb, over: diskPromisedMb > where.sizeMb } : null,
            memory: memory ? { mb: memoryPromisedMb, totalMb: memory.totalMb, over: memoryPromisedMb > memory.totalMb } : null,
        };
        /* The same disk named once, with all it holds. */
        const disks = [];
        for (const p of room.places) {
            const same = disks.find((d) => d.device === p.device);
            if (same) same.holds.push(p.what); else disks.push({ device: p.device, holds: [p.what], sizeMb: p.sizeMb, freeMb: p.freeMb, usedPercent: percent(p.sizeMb - p.freeMb, p.sizeMb) });
        }
        const disk = where ? { sizeMb: where.sizeMb, freeMb: where.freeMb, usedPercent: percent(where.sizeMb - where.freeMb, where.sizeMb), disks: disks.map(({ device, ...d }) => d) } : null;
        const high = {
            disk: Boolean(disk) && disks.some((d) => d.usedPercent > HIGH_PERCENT || d.freeMb < HIGH_FACTOR * reserve.diskMb),
            memory: Boolean(memory) && (memory.usedPercent > HIGH_PERCENT || memory.freeMb < HIGH_FACTOR * reserve.memoryMb),
        };
        return { reserve, settings: set, disk, memory, machines, promised, high };
    }

    /* For Settings, This server: everything known. */
    async about() {
        const room = await this.room();
        if (!this.#usage || this.#now() - this.#usageAt >= USAGE_MS) {
            const measuring = this.#measure();
            /* The first time, waited for a moment: after that, the page asks again. */
            if (!this.#usage) await Promise.race([measuring, new Promise((r) => { setTimeout(r, 3000).unref?.(); })]);
        }
        const figures = this.#figures(room);
        const u = this.#usage;
        const usage = u ? {
            clavarium: { dataMb: u.data ?? null, foldersMb: u.folders ?? null, workMb: u.work ?? null, removedMb: u.removed ?? null, toolsMb: u.tools ?? null },
            machines: { disksMb: Object.values(u.machines).reduce((a, b) => a + b, 0), each: Object.entries(u.machines).map(([name, mb]) => ({ name, mb })).sort((a, b) => b.mb - a.mb), shelfMb: u.shelf ?? null, imagesMb: u.images ?? null, othersMb: u.others ?? null },
            at: new Date(this.#usageAt).toISOString(),
        } : null;
        return { known: Boolean(figures), reserve: { diskMb: this.reserve().diskMb, memoryMb: this.reserve().memoryMb }, settings: this.reserve(), ...(figures ?? {}), usage, measuring: Boolean(this.#measuring) };
    }

    /* For the list: only whether it is high, and how much. Cheap: what is
       free is asked again only when it is old (ROOM_MS). */
    async brief() {
        const f = this.#figures(await this.room().catch(() => null));
        if (!f) return { known: false, high: false };
        const r = f.reserve;
        /* The disk said is the shortest one (the machines' when none is). */
        const short = f.disk ? [...f.disk.disks].sort((a, b) => (a.freeMb - HIGH_FACTOR * r.diskMb) - (b.freeMb - HIGH_FACTOR * r.diskMb))[0] : null;
        const disk = short && f.high.disk ? short : f.disk;
        const level = (high, usedPercent, aboveMb, reserveMb) => (!high ? 'ok' : usedPercent > 95 || aboveMb < reserveMb / 2 ? 'bad' : 'warn');
        return {
            known: true, high: f.high.disk || f.high.memory,
            disk: disk ? { usedPercent: disk.usedPercent, freeMb: disk.freeMb, aboveMb: disk.freeMb - r.diskMb, high: f.high.disk, level: level(f.high.disk, disk.usedPercent, disk.freeMb - r.diskMb, r.diskMb) } : null,
            memory: f.memory ? { usedPercent: f.memory.usedPercent, freeMb: f.memory.freeMb, aboveMb: f.memory.freeMb - r.memoryMb, high: f.high.memory, level: level(f.high.memory, f.memory.usedPercent, f.memory.freeMb - r.memoryMb, r.memoryMb) } : null,
        };
    }

    /* MAY THIS BE DONE? Throws a Refusal that says why and what to do.
       `kind`: 'create' (a new machine, or one built again), 'start' (a
       stopped machine started: a wake or a restart), 'grow'. `memoryMb`:
       what it takes (or grows by); `diskMb`: what its disk grows by (a new
       machine: what it takes is known here). */
    async check({ kind, name, memoryMb = 0, diskMb = 0 }) {
        const f = this.#figures(await this.room({ fresh: true }).catch(() => null));
        if (!f) return;
        const r = f.reserve;
        const verb = kind === 'create' ? 'Not created' : kind === 'start' ? 'Not started' : 'Not changed';
        const who = name ? `${name}` : 'a new machine';
        if (f.memory && memoryMb > 0 && f.memory.freeMb - memoryMb < r.memoryMb) {
            const asks = kind === 'grow' ? `${gb(memoryMb)} more memory for ${who}` : `${gb(memoryMb)} of memory for ${who}`;
            const what = kind === 'create' ? 'Put a conversation you are not using to sleep, or choose less memory' : kind === 'grow' ? 'Put a conversation you are not using to sleep, or give it less' : 'Put a conversation you are not using to sleep';
            throw new Refusal(409, `${verb}: this server cannot spare ${asks}. It has ${gb(f.memory.freeMb)} of memory free and keeps ${gb(r.memoryMb)} in reserve. ${what}, or lower the reserve in Settings, This server.`);
        }
        const takes = kind === 'create' ? (this.#shelf?.about?.().current?.sizeMb ?? NEW_MACHINE_MB) : diskMb;
        /* A disk grown: the host program refuses it under its own floor
           (grow_room in deploy/clavarium-host: what it grows by, plus
           SHELF_MIN_FREE_MB), whatever reserve is set here. The same rule
           here, so that it is refused before anything is stopped. */
        if (f.disk && kind === 'grow' && takes > 0) {
            const needMb = takes + Math.max(r.diskMb, MIN_FREE_MB);
            if (f.disk.freeMb < needMb) throw new Refusal(409, `${verb}: ${gb(f.disk.freeMb)} of disk free, ${gb(needMb)} needed.`);
        }
        if (f.disk && kind === 'create' && takes > 0 && f.disk.freeMb - takes < r.diskMb) {
            const asks = `the ${gb(takes)} of disk a new machine takes`;
            throw new Refusal(409, `${verb}: this server cannot spare ${asks}. It has ${gb(f.disk.freeMb)} of disk free and keeps ${gb(r.diskMb)} in reserve. Archive conversations you no longer need, or lower the reserve in Settings, This server.`);
        }
    }

    /* WATCHED: what is free against the reserve, all the time. Under it, once
       (again only after it came back above): the owner alerted, and the
       running machine that takes the most put to sleep and told so in its
       conversation. Disk: the one whose disk is largest (by the last
       measure; memory held when none is known). Resolves with what was done. */
    async watch() {
        const f = this.#figures(await this.room({ fresh: true }).catch(() => null));
        if (!f) return [];
        const done = [];
        const awake = new Set(this.#conversations.awake?.() ?? []);
        for (const what of ['disk', 'memory']) {
            const free = f[what]?.freeMb;
            const short = free !== undefined && free < f.reserve[`${what}Mb`];
            const was = this.#short[what];
            this.#short[what] = short;
            if (!short || was) continue;
            const running = f.machines.filter((m) => m.name && awake.has(m.name));
            const takes = (m) => (what === 'disk' ? this.#usage?.machines?.[m.name] ?? -1 : m.rssMb);
            const most = running.sort((a, b) => takes(b) - takes(a) || b.rssMb - a.rssMb)[0] ?? null;
            let slept = null;
            if (most && this.#sleep) slept = await Promise.resolve(this.#sleep(most.name)).then(() => most.name, () => null);
            const figures = `${gb(free)} free, ${gb(f.reserve[`${what}Mb`])} kept in reserve`;
            this.#alert?.({ title: `This server is short of ${what}`, body: `${figures}.${slept ? ` ${slept} was put to sleep.` : ''}`, url: '/?open=settings&at=resources' });
            if (slept) this.#say?.(slept, `This server ran short of ${what} (${figures}). This machine took the most, so it was put to sleep. Wake it once there is room again.`);
            done.push({ what, slept });
        }
        return done;
    }

    /* Watches every `everyMs`; returns what stops it. */
    start(everyMs = WATCH_MS) {
        const timer = setInterval(() => { void this.watch().catch(() => {}); }, everyMs);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
