/* SETTINGS, MACHINES (09-11): every conversation's machine at a glance -- its state, the memory its
 * qemu holds on this server, and since when -- each one forced off from there; then the VM manager
 * (does it answer, restarted by its owner) and the two choices of this server: what is done when the
 * VM manager hangs (vmwatch.mjs) and when memory is short (capacity.mjs).
 *
 * Nothing here asks a machine anything: the states come in one question to the VM manager (shared with
 * every caller for a few seconds), the memory from the host's own figures. A VM manager that does not
 * answer gives "Unknown" for each, never "gone".
 */
import { Refusal } from './conversations.mjs';

export class MachineList {
    #conversations; #vms; #capacity; #vmWatch; #now;
    constructor({ conversations, vms, capacity, vmWatch, now = () => Date.now() }) {
        this.#conversations = conversations; this.#vms = vms; this.#capacity = capacity; this.#vmWatch = vmWatch; this.#now = now;
    }

    /* { machines: [{ name, state, rssMb, sizeMb, since, action }], manager, pressure }. `since`: when its qemu
       started (running, or asleep and still holding memory), else when it was last stopped or put to
       sleep here, else null. */
    async list() {
        const states = await this.#vms.states().catch(() => null);
        const room = await this.#capacity?.room().catch(() => null) ?? null;
        const held = new Map((room?.machines ?? []).map((m) => [m.vm, m]));
        const machines = this.#conversations.list().filter((c) => c.phase === 'ready').map((c) => {
            const vm = `clv-${c.name}`;
            const state = states ? (states.get(vm) ?? 'Gone') : 'Unknown';
            const rssMb = held.get(vm)?.rssMb ?? 0;
            const age = room?.machineAge?.[vm];
            const report = c.machineReport;
            const ended = report?.ok && ((state === 'Stopped' && ['stop', 'force'].includes(report.kind)) || (state === 'Suspended' && report.kind === 'sleep')) ? report.at : null;
            const since = age !== undefined && rssMb > 0 ? new Date(this.#now() - age * 1000).toISOString() : ended;
            return { name: c.name, state, rssMb, sizeMb: c.memoryMb ?? null, since, action: c.machine?.kind ?? null };
        }).sort((a, b) => b.rssMb - a.rssMb || a.name.localeCompare(b.name));
        return { machines, manager: this.#vmWatch?.about() ?? null, pressure: this.#capacity?.pressureWay() ?? null };
    }

    /* "Force stop" from the list: the same as from its conversation (one lock per machine). */
    async force(name) {
        if (!this.#conversations.get(name)) throw new Refusal(404, 'No such conversation.');
        await this.#conversations.machineAction(name, 'force');
        return this.list();
    }

    /* "Restart the manager", confirmed in the page: every machine is suspended and resumed. */
    async revive() {
        if (!this.#vmWatch) throw new Refusal(404, 'No machine manager here.');
        try { await this.#vmWatch.revive(); } catch (error) { throw new Refusal(error.status ?? 500, error.message); }
        return this.list();
    }

    setManagerMode(mode) {
        try { this.#vmWatch?.setMode(mode); } catch (error) { throw new Refusal(error.status ?? 400, error.message); }
        return this.list();
    }

    setPressure(way) { this.#capacity?.setPressureWay(way); return this.list(); }
}
