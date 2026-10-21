/* ALL THE MACHINES TO ANOTHER DISK, from Settings (deploy/move-machines.sh, run as
 * root in a service of its own by the host program: it stops this server on its
 * way, and starts it again).
 *
 *   places()   { now: { place, device, sizeMb, freeMb }, places: [{ at, device, sizeMb, freeMb, why }] }
 *              why: '' when they may go there, or why not (the same disk, too small)
 *   move(at)   started; the page loses this server for a while, and finds it again
 *   moving()   { state, said: [lines] }: how it goes, or how it went
 *   forgetOld() the copy a move left on the first disk removed (oldMb in places():
 *              its size, null when there is none)
 *   disks()    the disks of this server, WHOLE, formatted or not (lsblk): for each,
 *              what can be done -- move the machines to one of its file systems,
 *              mount one, or prepare (erase) the disk; and why not
 *   grow(mount) room set aside in a logical volume's group and not used, given to the
 *              file system at `mount` while in use (disks() says it: unused, by disk)
 *   mount(path) / prepare(path, typed)   a file system mounted under /mnt for good;
 *              a whole disk erased, one ext4 on it, mounted (its name typed again)
 */
import { Refusal } from './conversations.mjs';

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 200) ?? '';
const whole = (x) => (/^\d+$/.test(x ?? '') ? Number(x) : undefined);
const MB = (bytes) => Math.round(Number(bytes ?? 0) / 1048576);
export const FILE_SYSTEMS = ['ext4', 'xfs', 'btrfs'];
const PLACES = /^\/(mnt|media)(\/|$)|^\/home$/;
const SYSTEM_MOUNTS = /^(\/|\/boot(\/efi)?|\/usr|\/var|\[SWAP\])$/;
const PART_OF_MORE = /^(LVM2_member|crypto_LUKS|linux_raid_member|zfs_member)$/;
/* A disk the machines could live on: not a floppy or a CD, not read-only, not tiny; a loop
   device only when it is a disk mounted under /mnt or /media (a snap's is read-only squashfs). */
function aDisk(d) {
    if (d.ro || /^(fd|sr|zram|ram)\d*/.test(d.name)) return false;
    /* (A conversation's own work disk is a loop device too, mounted elsewhere: never listed.) */
    if (d.type === 'loop') return FILE_SYSTEMS.includes(d.fstype) && /^\/(mnt|media)\//.test(d.mountpoint ?? '');
    return d.type === 'disk' && MB(d.size) >= 4096;
}
/* "disks room": [{ mount, volume, group, freeMb, fs }], only lines of the expected shape. */
export function readRooms(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n').slice(0, 50)) {
        const p = line.trim().split(' ');
        if (p[0] !== 'lvroom' || p.length !== 6 || !/^\/[A-Za-z0-9/._-]*$/.test(p[1]) || !/^\d+$/.test(p[4])) continue;
        out.push({ mount: p[1], volume: p[2], group: p[3], freeMb: Number(p[4]), fs: p[5] });
    }
    return out;
}
/* lsblk -J (deploy/clavarium-host, "disks list") as the page needs it. */
export function readDisks(json) {
    let all;
    try { all = JSON.parse(json).blockdevices ?? []; } catch { return []; }
    const flat = (d) => [d, ...(d.children ?? []).flatMap(flat)];
    return all.filter(aDisk).map((d) => {
        const inside = flat(d);
        const parts = (d.children?.length ? d.children : [d]).map((p) => {
            const deeper = flat(p);
            const mount = deeper.map((x) => x.mountpoint).find(Boolean) ?? null;
            const state = PART_OF_MORE.test(p.fstype ?? '') || deeper.some((x) => ['lvm', 'crypt', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10'].includes(x.type)) ? 'part-of-more'
                : mount && SYSTEM_MOUNTS.test(mount) ? 'system'
                : mount && PLACES.test(mount) && FILE_SYSTEMS.includes(p.fstype) ? 'place'
                : mount ? 'in-use'
                : FILE_SYSTEMS.includes(p.fstype) ? 'mountable'
                : p.fstype ? 'other' : 'empty';
            return { name: p.name, path: p.path, sizeMb: MB(p.size), fstype: p.fstype ?? null, label: p.label ?? null, mount, state };
        });
        const system = parts.some((p) => p.state === 'system') || inside.some((x) => x.mountpoint && SYSTEM_MOUNTS.test(x.mountpoint));
        const busy = parts.some((p) => p.mount || p.state === 'part-of-more');
        return {
            name: d.name, path: d.path, sizeMb: MB(d.size), model: (d.model ?? '').trim() || null, removable: Boolean(d.rm), loop: d.type === 'loop',
            system, parts, prepare: system ? 'it is the system\'s disk' : busy ? 'something on it is in use' : d.type === 'loop' ? 'not a whole disk' : '',
            erases: parts.some((p) => p.fstype),
        };
    });
}

export class MachinesMove {
    #host; #usedMb;
    /* `usedMb()`: what the machines take now (capacity.mjs, server usage), or undefined. */
    constructor({ host, usedMb = () => undefined }) { this.#host = host; this.#usedMb = usedMb; }
    async places() {
        const r = await this.#host(['machines', 'places']);
        if (r.code !== 0) throw new Refusal(502, `The disks could not be listed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        let now = null; const places = [];
        for (const p of String(r.stdout).split('\n').map((l) => l.trim().split(' '))) {
            if (p[0] === 'now' && p.length === 5) now = { place: p[1], device: whole(p[2]), sizeMb: whole(p[3]), freeMb: whole(p[4]) };
            if (p[0] === 'place' && p.length === 5) places.push({ at: p[1], device: whole(p[2]), sizeMb: whole(p[3]), freeMb: whole(p[4]) });
        }
        const used = this.#usedMb();
        const need = used === undefined ? undefined : Math.round(used * 1.1) + 512;
        for (const p of places) {
            p.why = now && p.device === now.device ? 'the machines are on this disk already'
                : need !== undefined && p.freeMb < need ? `too small: ${Math.round(p.freeMb / 1024)} GB free, about ${Math.ceil(need / 1024)} GB needed`
                : '';
        }
        const old = await this.#host(['machines', 'old']).catch(() => ({ code: 1 }));
        const oldMb = old.code === 0 ? whole(/^old (\d+)$/m.exec(String(old.stdout ?? ''))?.[1]) ?? null : null;
        return { now, places, needMb: need ?? null, oldMb };
    }
    async move(at) {
        const { places } = await this.places();
        const p = places.find((x) => x.at === at);
        if (!p) throw new Refusal(404, 'This disk is not one the machines can go to.');
        if (p.why) throw new Refusal(409, `Not there: ${p.why}.`);
        const r = await this.#host(['machines', 'move', at]);
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 400 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { started: true, to: `${at.replace(/\/$/, '')}/clavarium-machines` };
    }
    async forgetOld() {
        const r = await this.#host(['machines', 'forget-old']);
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { removed: true };
    }
    async disks() {
        const [r, places, room] = await Promise.all([this.#host(['disks', 'list']), this.places().catch(() => null), this.#host(['disks', 'room']).catch(() => ({ code: 1 }))]);
        if (r.code !== 0) throw new Refusal(502, `The disks could not be listed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        const disks = readDisks(r.stdout);
        /* Room set aside and not used (a logical volume made small at installation): said on its disk, offered. */
        const rooms = room.code === 0 ? readRooms(room.stdout) : [];
        for (const d of disks) {
            const mounts = d.parts.map((p) => p.mount).filter(Boolean);
            d.unused = rooms.filter((x) => mounts.includes(x.mount) || (d.system && x.mount === '/'));
        }
        const now = places?.now?.place ?? null;
        for (const d of disks) for (const p of d.parts) {
            const at = places?.places.find((x) => x.at === p.mount);
            if (p.state === 'place') { p.freeMb = at?.freeMb ?? null; p.why = at ? at.why : 'not a place the VM manager may use'; }
            if (now && p.mount && (now === p.mount || now.startsWith(`${p.mount.replace(/\/$/, '')}/`))) p.machines = true;
        }
        /* The machines' disk first, then the others by size. */
        disks.sort((a, b) => Number(b.parts.some((p) => p.machines)) - Number(a.parts.some((p) => p.machines)) || b.sizeMb - a.sizeMb);
        return { disks, needMb: places?.needMb ?? null, now };
    }
    /* That room given to the file system mounted at `mount`, while in use. */
    async grow(mount) {
        const { disks } = await this.disks();
        const x = disks.flatMap((d) => d.unused).find((u) => u.mount === mount);
        if (!x) throw new Refusal(404, 'There is no room set aside for that place.');
        if (x.freeMb < 1024) throw new Refusal(409, 'Less than 1 GB is set aside there: nothing worth giving.');
        const r = await this.#host(['disks', 'grow', mount], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        const m = /^grown (\S+) (\d+)$/m.exec(String(r.stdout ?? ''));
        return { grown: mount, sizeMb: m ? Number(m[2]) : null };
    }
    async mount(path) {
        const { disks } = await this.disks();
        const p = disks.flatMap((d) => d.parts).find((x) => x.path === path);
        if (!p) throw new Refusal(404, 'Not a disk of this server.');
        if (p.state !== 'mountable') throw new Refusal(409, 'This one cannot be mounted here: it is in use, or holds no file system the machines can live on.');
        const r = await this.#host(['disks', 'mount', path], { timeoutMs: 120_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { mounted: String(r.stdout).trim().replace(/^mounted /, '') };
    }
    async prepare(path, typed) {
        const { disks } = await this.disks();
        const d = disks.find((x) => x.path === path);
        if (!d) throw new Refusal(404, 'Not a disk of this server.');
        if (d.prepare) throw new Refusal(409, `Not this one: ${d.prepare}.`);
        if (String(typed ?? '') !== d.name) throw new Refusal(400, `Type its name, ${d.name}, to erase it.`);
        const r = await this.#host(['disks', 'prepare', path, d.name], { timeoutMs: 600_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { prepared: String(r.stdout).trim() };
    }
    async moving() {
        const r = await this.#host(['machines', 'moving']);
        const lines = String(r.stdout ?? '').split('\n');
        const state = lines.find((l) => l.startsWith('state '))?.slice(6).trim() || 'unknown';
        const said = lines.filter((l) => l.startsWith('said ')).map((l) => l.slice(5)).slice(-12);
        return { state, said, done: said.some((l) => l.startsWith('Done:')), failed: said.some((l) => /REFUSED|putting everything back/.test(l)) };
    }
}
