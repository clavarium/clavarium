/* THE NETWORK OF A CONVERSATION, decided from OUTSIDE its VM.
 *
 * The agent is root in its VM: nothing set inside can hold. So the rules live
 * on the host, and they are keyed on the one thing the VM cannot change: the
 * host-side end of its network cable (its tap interface). Tried against a
 * real VM: with the cut in place, root inside could not get out by taking
 * another address, while its terminal and its shared folders kept working,
 * and the VM next to it stayed online.
 *
 * Two rules, rebuilt as one table each time something may have changed:
 *
 *   - ALWAYS: conversations cannot talk to each other. Each VM is a silo.
 *   - when a conversation is switched offline: its VM reaches the host only
 *     (that is how its terminal and its folders work), and not the host's
 *     name resolver, which would be a way to carry data out.
 *
 * AND NO VM PASSES FOR ANOTHER: root in a VM can give itself another VM's
 * address, or answer the host's ARP for it, and the server reaches each VM at
 * its address (its terminal, its folders, its secrets). So every frame from a
 * tap must carry that VM's own MAC (read from its qemu line, which the VM
 * cannot change), be IPv4 or ARP only (no IPv6: nothing of ours uses it, the
 * VM manager's network gives none), and come from that VM's own IPv4 address
 * (the lease the VM manager's DHCP server gave that MAC, pinned for the life
 * of its qemu process). Its DHCP must name its own MAC. While its address is
 * not known yet (it boots), it may lease one, but never use an address known
 * to be another VM's or the host's.
 *
 * WHAT THIS DOES NOT CLOSE, and it is said rather than hidden: a tap is only
 * known once its VM runs, so a VM is filtered a moment AFTER it starts, not
 * before. The rules are applied before the tool is attached. A VM whose qemu
 * line has no MAC we can read keeps its silo but no address check.
 */
import { isConversationName } from './names.mjs';

export const TABLE = 'clavarium';
const TAP = /^tap-[0-9a-f]{1,12}$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;
const ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export const isMac = (v) => typeof v === 'string' && MAC.test(v) && (parseInt(v.slice(0, 2), 16) & 1) === 0;  /* unicast */
export const isAddress = (v) => typeof v === 'string' && ADDRESS.test(v) && v.split('.').every((n) => Number(n) <= 255 && String(Number(n)) === n);
/* An address a VM may hold: not 0.0.0.0, not broadcast, not multicast. */
const isHostAddress = (v) => isAddress(v) && v.split('.')[0] !== '0' && Number(v.split('.')[0]) < 224;

/* How often what runs is looked at, for the rules (see watch). */
export const WATCH_MS = 20_000;
export const RELOAD_MS = 10 * 60_000;

/* The running conversation VMs, read from the process list:
   { conversation: { tap, mac, pid } }. Anything that does not look exactly as
   expected is left out (a bad tap: the VM; a bad or missing MAC: the MAC):
   a rule is never built from a string that was not checked. */
export function readTaps(processList) {
    const taps = {};
    for (const line of String(processList ?? '').split('\n')) {
        const name = /\/instances\/clv-([a-z0-9-]+)\//.exec(line)?.[1];
        const tap = /[ ,]ifname=([^, ]+)/.exec(line)?.[1];
        if (!(name && tap && isConversationName(name) && TAP.test(tap))) continue;
        const mac = /[ ,]mac=([^, ]+)/.exec(line)?.[1];
        const pid = /^\s*(\d{1,10}) /.exec(line)?.[1];
        taps[name] = { tap, mac: isMac(mac) ? mac : undefined, pid };
    }
    return taps;
}

/* The leases of the VM manager's DHCP server, as the host program prints them
   ("<mac> <ip>" per line): { mac: ip }. A MAC or an address seen twice is
   ambiguous: left out, unknown. */
export function readLeases(text) {
    const byMac = new Map(); const seen = new Map();
    for (const line of String(text ?? '').split('\n')) {
        const [mac, ip, extra] = line.trim().split(/\s+/);
        if (extra !== undefined || !isMac(mac) || !isHostAddress(ip)) continue;
        byMac.set(mac, byMac.has(mac) && byMac.get(mac) !== ip ? null : ip);
        seen.set(ip, (seen.get(ip) ?? new Set()).add(mac));
    }
    const leases = {};
    for (const [mac, ip] of byMac) if (ip && seen.get(ip).size === 1) leases[mac] = ip;
    return leases;
}

export function readBridgeAddress(text) {
    const address = /\binet (\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(text ?? ''))?.[1];
    return address && address.split('.').every((n) => Number(n) <= 255) ? address : undefined;
}

/* What a frame from one VM must be. `known` is every address held by another
   VM, and the host's, for a VM whose own is not known yet. */
function guard(tap, mac, ip, known) {
    const at = `    iifname "${tap}"`;
    const lines = [
        `${at} ether saddr != ${mac} drop`,
        `${at} ether type != { ip, arp } drop`,                                 /* IPv6, VLAN tags, the rest */
        `${at} arp saddr ether != ${mac} drop`,
        `${at} udp dport 67 @th,288,48 != 0x${mac.replaceAll(':', '')} drop`,   /* DHCP: its own MAC (chaddr) */
        `${at} ip saddr 0.0.0.0 ip daddr 255.255.255.255 udp dport 67 accept`,  /* its lease, before it has one */
    ];
    if (ip) {
        lines.push(`${at} ip saddr != ${ip} drop`);
        lines.push(`${at} arp saddr ip != { 0.0.0.0, ${ip} } drop`);
    } else if (known.length) {
        lines.push(`${at} ip saddr { ${known.join(', ')} } drop`);
        lines.push(`${at} arp saddr ip { ${known.join(', ')} } drop`);
    }
    return lines;
}

/* The whole table, as text for the firewall. Replaced atomically.
   `vms`: { conversation: { tap, mac?, ip? } } (mac and ip already checked). */
export function ruleset(vms, offline, bridgeAddress) {
    const all = Object.values(vms);
    const lines = [`table bridge ${TABLE}`, `delete table bridge ${TABLE}`, `table bridge ${TABLE} {`];
    lines.push('  chain between_vms {', '    type filter hook forward priority 0;');
    for (const { tap } of all) lines.push(`    iifname "${tap}" drop`);
    lines.push('  }', '  chain from_vm {', '    type filter hook input priority 0;');
    const held = [...new Set([...all.map((v) => v.ip).filter(isHostAddress), ...(isHostAddress(bridgeAddress) ? [bridgeAddress] : [])])].sort();
    for (const { tap, mac, ip } of all) {
        if (!isMac(mac)) continue;
        const own = isHostAddress(ip) ? ip : undefined;
        lines.push(...guard(tap, mac, own, held));
    }
    for (const [name, { tap }] of Object.entries(vms)) {
        if (!offline.includes(name)) continue;
        lines.push(`    iifname "${tap}" udp dport 67 accept`);                 /* its address lease */
        lines.push(`    iifname "${tap}" ether type arp accept`);
        lines.push(`    iifname "${tap}" ip daddr ${bridgeAddress} meta l4proto { tcp, udp } th dport 53 drop`);
        lines.push(`    iifname "${tap}" ip daddr ${bridgeAddress} accept`);    /* the host: terminal, folders */
        lines.push(`    iifname "${tap}" drop`);                                /* everything else, IPv6 included */
    }
    lines.push('  }', '}', '');
    return lines.join('\n');
}

export class Network {
    #host; #offline;
    /* The table last loaded, and whether it was: the same table is not loaded again. */
    #last = null;
    /* PINNED: the address first leased to a VM, kept for the life of its qemu
       process (its pid, tap and MAC). A lease that changes while it runs is
       the VM asking for another address by itself: not followed. */
    #pins = new Map();

    /* `host(argv)` reaches the host program;
       `offline()` returns the names of the conversations switched offline. */
    constructor({ host, offline }) { this.#host = host; this.#offline = offline; }

    /* Rebuilds the rules from what runs now. Returns false, and says nothing
       is filtered, only if the firewall refused the table. */
    async apply() {
        const taps = readTaps((await this.#host(['net', 'taps'])).stdout);
        const bridge = readBridgeAddress((await this.#host(['net', 'bridge'])).stdout);
        const leased = await this.#host(['net', 'leases']);
        const vms = this.#addresses(taps, leased.code === 0 ? readLeases(leased.stdout) : {});
        const wanted = this.#offline().filter((name) => taps[name]);
        /* Without the host's address the "offline" rules cannot be written
           safely; the silo rule still can, and is. */
        /* As ONE argument, not on standard input: this firewall tool refuses
           a pipe as its input file (measured), and nothing in the rules is
           secret. Every name, MAC and address in them was checked here, and the host
           program checks every line again before loading it. */
        const text = ruleset(vms, bridge ? wanted : [], bridge ?? '0.0.0.0');
        const ok = bridge !== undefined || wanted.length === 0;
        /* Loaded again anyway now and then: a table taken off by someone else comes back. */
        if (this.#last?.text === text && this.#last.loaded && Date.now() - this.#last.at < RELOAD_MS) return ok;
        const r = await this.#host(['net', 'apply', text]);
        this.#last = { text, loaded: r.code === 0, at: Date.now() };
        return r.code === 0 && ok;
    }

    /* Each VM's address: its pin, else its lease if no other VM holds it. */
    #addresses(taps, leases) {
        const keyOf = ({ pid, tap, mac }) => `${pid} ${tap} ${mac}`;
        const running = new Set(Object.values(taps).filter((v) => v.mac && v.pid).map(keyOf));
        for (const key of this.#pins.keys()) if (!running.has(key)) this.#pins.delete(key);
        const vms = {};
        for (const [name, v] of Object.entries(taps)) {
            let ip = v.mac && v.pid ? this.#pins.get(keyOf(v)) : undefined;
            const lease = v.mac ? leases[v.mac] : undefined;
            if (!ip && lease && v.pid && ![...this.#pins.values()].includes(lease)) { ip = lease; this.#pins.set(keyOf(v), ip); }
            vms[name] = { tap: v.tap, mac: v.mac, ip };
        }
        return vms;
    }

    /* KEPT UP TO DATE (04-11): a machine started by the VM manager itself -- after the server
       restarted -- has a new tap that no opening told: looked at every `everyMs`, the table loaded
       again only when what runs changed. Returns the stop. */
    watch(everyMs = WATCH_MS) {
        const timer = setInterval(() => { void this.apply().catch(() => {}); }, everyMs);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
