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
 * THE RESERVE (Settings, This server): creating, starting, waking or growing
 * a machine is refused, with a sentence that says why and what to do, when
 * it would leave less than the reserve. Memory: the machine's size (or what
 * it grows by) against the memory free -- less what the running machines
 * were given and have not taken yet, since they will. Disk: what a new
 * machine takes, or what a disk grows by, against the disk free where the
 * machines' disks are. Starting or waking is never refused for disk: a full
 * disk is cleaned from inside the conversations.
 *
 * When the figures cannot be read (a host program from before these verbs),
 * nothing is refused: the reserve is a guard, not a gate that jams.
 */
import { Refusal } from './conversations.mjs';

export const RESERVE_DISK_MB = 3 * 1024;
export const RESERVE_MEMORY_MB = 1024;
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
    const facts = { places: [], memory: null, machines: [] };
    for (const line of String(text ?? '').slice(0, 64 * 1024).split('\n').slice(0, 500)) {
        const p = line.trim().split(' ');
        if (p[0] === 'place' && p.length === 5 && PLACES.includes(p[1]) && [2, 3, 4].every((i) => whole(p[i]) !== undefined) && !facts.places.some((x) => x.what === p[1])) facts.places.push({ what: p[1], device: whole(p[2]), sizeMb: whole(p[3]), freeMb: whole(p[4]) });
        if (p[0] === 'memory' && p.length === 3 && whole(p[1]) > 0 && whole(p[2]) !== undefined) facts.memory = { totalMb: whole(p[1]), availableMb: whole(p[2]) };
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
    #run; #store; #conversations; #shelf; #now; #roomMs; #room = null; #roomAt = -Infinity; #usage = null; #usageAt = -Infinity; #going = null; #measuring = null;

    /* `run(argv)`: the host program. `store`: where the reserve is kept.
       `conversations`: what each machine was given. `shelf`: how large a
       ready-made machine is (a new one is a copy of it). */
    /* `roomMs`: how long what is free is taken as known (ROOM_MS). */
    constructor({ run, store, conversations, shelf = null, now = () => Date.now(), roomMs = ROOM_MS }) {
        this.#roomMs = roomMs;
        this.#run = run; this.#store = store; this.#conversations = conversations; this.#shelf = shelf; this.#now = now;
    }

    reserve() {
        const r = this.#store.get('reserve') ?? {};
        return { diskMb: r.diskMb ?? RESERVE_DISK_MB, memoryMb: r.memoryMb ?? RESERVE_MEMORY_MB };
    }
    setReserve({ diskMb, memoryMb } = {}) {
        const now = this.reserve();
        const take = (value, max, what) => {
            if (value === undefined || value === null || value === '') return undefined;
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0 || n > max) throw new Refusal(400, `The ${what} reserve is a whole number of megabytes, from 0 to ${max}.`);
            return n;
        };
        const disk = take(diskMb, RESERVE_DISK_MAX_MB, 'disk') ?? now.diskMb;
        const memory = take(memoryMb, RESERVE_MEMORY_MAX_MB, 'memory') ?? now.memoryMb;
        this.#store.put({ name: 'reserve', diskMb: disk, memoryMb: memory });
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
        const reserve = this.reserve();
        const records = new Map(this.#conversations.list().map((c) => [`clv-${c.name}`, c]));
        const machines = room.machines.map((m) => {
            const c = records.get(m.vm);
            return { name: c ? c.name : null, shelf: m.vm.startsWith('clvshelf-'), rssMb: m.rssMb, sizeMb: c?.memoryMb ?? null };
        });
        /* Given to running machines and not taken yet: it will be. */
        const promisedMb = machines.reduce((sum, m) => sum + (m.sizeMb ? Math.max(0, m.sizeMb - m.rssMb) : 0), 0);
        const memory = room.memory ? {
            totalMb: room.memory.totalMb, freeMb: room.memory.availableMb, promisedMb,
            spareMb: Math.max(0, room.memory.availableMb - promisedMb),
            /* Counted as taken: what running machines were given and will take. */
            usedPercent: percent(room.memory.totalMb - Math.max(0, room.memory.availableMb - promisedMb), room.memory.totalMb),
        } : null;
        const where = room.places.find((p) => p.what === 'machines') ?? room.places[0];
        /* The same disk named once, with all it holds. */
        const disks = [];
        for (const p of room.places) {
            const same = disks.find((d) => d.device === p.device);
            if (same) same.holds.push(p.what); else disks.push({ device: p.device, holds: [p.what], sizeMb: p.sizeMb, freeMb: p.freeMb, usedPercent: percent(p.sizeMb - p.freeMb, p.sizeMb) });
        }
        const disk = where ? { sizeMb: where.sizeMb, freeMb: where.freeMb, usedPercent: percent(where.sizeMb - where.freeMb, where.sizeMb), disks: disks.map(({ device, ...d }) => d) } : null;
        const high = {
            disk: Boolean(disk) && disks.some((d) => d.usedPercent > HIGH_PERCENT || d.freeMb < HIGH_FACTOR * reserve.diskMb),
            memory: Boolean(memory) && (memory.usedPercent > HIGH_PERCENT || memory.spareMb < HIGH_FACTOR * reserve.memoryMb),
        };
        return { reserve, disk, memory, machines, high };
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
        return { known: Boolean(figures), reserve: this.reserve(), ...(figures ?? {}), usage, measuring: Boolean(this.#measuring) };
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
            memory: f.memory ? { usedPercent: f.memory.usedPercent, freeMb: f.memory.spareMb, aboveMb: f.memory.spareMb - r.memoryMb, high: f.high.memory, level: level(f.high.memory, f.memory.usedPercent, f.memory.spareMb - r.memoryMb, r.memoryMb) } : null,
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
        if (f.memory && memoryMb > 0 && f.memory.spareMb - memoryMb < r.memoryMb) {
            const asks = kind === 'grow' ? `${gb(memoryMb)} more memory for ${who}` : `${gb(memoryMb)} of memory for ${who}`;
            const what = kind === 'create' ? 'Put a conversation you are not using to sleep, or choose less memory' : kind === 'grow' ? 'Put a conversation you are not using to sleep, or give it less' : 'Put a conversation you are not using to sleep';
            throw new Refusal(409, `${verb}: this server cannot spare ${asks}. It has ${gb(f.memory.spareMb)} free for machines and keeps ${gb(r.memoryMb)} in reserve. ${what}, or lower the reserve in Settings, This server.`);
        }
        const takes = kind === 'create' ? (this.#shelf?.about?.().current?.sizeMb ?? NEW_MACHINE_MB) : diskMb;
        if (f.disk && kind !== 'start' && takes > 0 && f.disk.freeMb - takes < r.diskMb) {
            const asks = kind === 'create' ? `the ${gb(takes)} of disk a new machine takes` : `${gb(takes)} more disk for ${who}`;
            throw new Refusal(409, `${verb}: this server cannot spare ${asks}. It has ${gb(f.disk.freeMb)} of disk free and keeps ${gb(r.diskMb)} in reserve. Archive conversations you no longer need, or lower the reserve in Settings, This server.`);
        }
    }
}
