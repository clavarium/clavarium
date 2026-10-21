/* THE CURVES OF THE RESOURCES (Settings, This server, Resources; a conversation's
 * Machine chapter): memory, CPU and disk, of this server and of each machine, one
 * look a minute, kept seven days.
 *
 * Nothing is asked of any machine here: what the server knows already is taken --
 * "server room" (capacity.mjs: memory, disks, the CPU time of the whole server
 * and of each machine's process), and what health.mjs last saw inside a machine
 * (its memory, its disk, the programs stopped for lack of memory). A machine
 * frozen inside never holds a look back.
 *
 *   sample(room, machines)  one look: `machines` [{ name, vm, cores, memoryMb,
 *                           health }] (health: health.mjs's last record, or null)
 *   series(of, span)        { t: [ms...], <measure>: [percent or null...], marks: [ms...] }
 *                           of: 'server' or a conversation's name; span: '1h' '24h' '7d'
 *
 * Kept: every minute for a day, then fifteen-minute blocks (their highest value:
 * a peak stays seen) for a week. A few hundred kilobytes in a file of its own,
 * written every few minutes; lost minutes at a restart are only a gap.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const STEP_MS = 60_000;
export const BLOCK_MS = 15 * 60_000;
const MINUTES = 24 * 60;
const BLOCKS = 7 * 24 * 4;
const SAVE_MS = 5 * 60_000;
/* What health.mjs saw inside a machine is used for this long, no more. */
const FRESH_MS = 15 * 60_000;
export const MEASURES = ['memory', 'cpu', 'disk'];
export const SPANS = { '1h': 60 * 60_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 };

const pct = (part, all) => (all > 0 ? Math.max(0, Math.min(100, Math.round((part / all) * 1000) / 10)) : null);

export class History {
    #file; #now; #keys = new Map(); #last = null; #savedAt = 0;
    constructor({ file = null, now = () => Date.now() } = {}) {
        this.#file = file; this.#now = now;
        if (file) {
            try {
                const kept = JSON.parse(readFileSync(file, 'utf8'));
                for (const [key, v] of Object.entries(kept.keys ?? {})) if (Array.isArray(v.minutes) && Array.isArray(v.blocks)) this.#keys.set(key, { minutes: v.minutes, blocks: v.blocks, block: v.block ?? null, oom: v.oom ?? null });
            } catch { /* none yet, or unreadable: a new history */ }
        }
    }

    sample(room, machines = []) {
        if (!room) return;
        const t = this.#now();
        const before = this.#last; this.#last = { t, cpu: room.cpu, machineCpu: room.machineCpu ?? {} };
        const dTicks = before?.cpu && room.cpu ? room.cpu.ticks - before.cpu.ticks : 0;
        const cores = room.cpu?.cores || 1;
        /* This server: memory as the system says it, CPU since the last look, the machines' disk. */
        const disk = room.places?.find((p) => p.what === 'machines') ?? room.places?.[0];
        this.#push('server', t, {
            memory: room.memory ? pct(room.memory.totalMb - room.memory.availableMb, room.memory.totalMb) : null,
            cpu: dTicks > 0 ? pct(dTicks - (room.cpu.idle - before.cpu.idle), dTicks) : null,
            disk: disk ? pct(disk.sizeMb - disk.freeMb, disk.sizeMb) : null,
        }, false);
        for (const m of machines) {
            const h = m.health && t - Date.parse(m.health.at ?? 0) < FRESH_MS ? m.health : null;
            const was = before?.machineCpu?.[m.vm]; const now = room.machineCpu?.[m.vm];
            /* Its CPU as a share of the cores it was given: what one core of the server does in that time, times its cores. */
            const cpu = dTicks > 0 && was !== undefined && now !== undefined && now >= was ? pct(now - was, (dTicks / cores) * (m.cores || 1)) : null;
            const rss = room.machines?.find((x) => x.vm === m.vm)?.rssMb;
            /* Its memory as seen inside when known (what its programs use), else what its process holds here. */
            const memory = h?.memory?.totalMb ? pct(h.memory.totalMb - h.memory.availableMb, h.memory.totalMb) : rss !== undefined && m.memoryMb ? pct(rss, m.memoryMb) : null;
            const d = h?.disks?.['/'];
            const running = rss !== undefined;
            const key = this.#keys.get(m.name);
            /* A program stopped for lack of memory since the last look: a mark on the curve. */
            const oom = Number.isInteger(h?.oomKills) && key?.oom !== null && key?.oom !== undefined && h.oomKills > key.oom;
            this.#push(m.name, t, running ? { memory, cpu, disk: d ? pct(d.sizeMb - d.availableMb, d.sizeMb) : null } : { memory: null, cpu: null, disk: null }, oom);
            if (Number.isInteger(h?.oomKills)) this.#keys.get(m.name).oom = h.oomKills;
        }
        if (this.#file && t - this.#savedAt >= SAVE_MS) this.save();
    }

    #push(key, t, values, mark) {
        let k = this.#keys.get(key);
        if (!k) { k = { minutes: [], blocks: [], block: null, oom: null }; this.#keys.set(key, k); }
        const row = [t, ...MEASURES.map((x) => values[x] ?? null), mark ? 1 : 0];
        k.minutes.push(row);
        if (k.minutes.length > MINUTES) k.minutes.splice(0, k.minutes.length - MINUTES);
        /* The block of fifteen minutes: its highest value of each, and any mark. */
        const start = t - (t % BLOCK_MS);
        if (k.block && k.block[0] !== start) {
            k.blocks.push(k.block);
            if (k.blocks.length > BLOCKS) k.blocks.splice(0, k.blocks.length - BLOCKS);
            k.block = null;
        }
        if (!k.block) k.block = [start, ...MEASURES.map(() => null), 0];
        MEASURES.forEach((_, i) => { const v = row[i + 1]; if (v !== null && (k.block[i + 1] === null || v > k.block[i + 1])) k.block[i + 1] = v; });
        if (mark) k.block[MEASURES.length + 1] = 1;
    }

    series(of, span = '1h') {
        const k = this.#keys.get(of);
        const wide = SPANS[span] ?? SPANS['1h'];
        const from = this.#now() - wide;
        const rows = !k ? [] : span === '7d' ? [...k.blocks, ...(k.block ? [k.block] : [])] : k.minutes;
        const kept = rows.filter((r) => r[0] >= from);
        const out = { span: SPANS[span] ? span : '1h', from, to: this.#now(), t: kept.map((r) => r[0]), marks: kept.filter((r) => r[MEASURES.length + 1]).map((r) => r[0]) };
        MEASURES.forEach((m, i) => { out[m] = kept.map((r) => r[i + 1]); });
        return out;
    }

    forget(name) { this.#keys.delete(name); }

    save() {
        if (!this.#file) return;
        this.#savedAt = this.#now();
        try {
            writeFileSync(`${this.#file}.tmp`, JSON.stringify({ keys: Object.fromEntries(this.#keys) }), { mode: 0o600 });
            renameSync(`${this.#file}.tmp`, this.#file);
        } catch { /* the next save tries again */ }
    }
}
