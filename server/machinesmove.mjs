/* ALL THE MACHINES TO ANOTHER DISK, from Settings (deploy/move-machines.sh, run as
 * root in a service of its own by the host program: it stops this server on its
 * way, and starts it again).
 *
 *   places()   { now: { place, device, sizeMb, freeMb }, places: [{ at, device, sizeMb, freeMb, why }] }
 *              why: '' when they may go there, or why not (the same disk, too small)
 *   move(at)   started; the page loses this server for a while, and finds it again
 *   moving()   { state, said: [lines] }: how it goes, or how it went
 */
import { Refusal } from './conversations.mjs';

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 200) ?? '';
const whole = (x) => (/^\d+$/.test(x ?? '') ? Number(x) : undefined);

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
        return { now, places, needMb: need ?? null };
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
    async moving() {
        const r = await this.#host(['machines', 'moving']);
        const lines = String(r.stdout ?? '').split('\n');
        const state = lines.find((l) => l.startsWith('state '))?.slice(6).trim() || 'unknown';
        const said = lines.filter((l) => l.startsWith('said ')).map((l) => l.slice(5)).slice(-12);
        return { state, said, done: said.some((l) => l.startsWith('Done:')), failed: said.some((l) => /REFUSED|putting everything back/.test(l)) };
    }
}
