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
 * WHAT THIS DOES NOT CLOSE, and it is said rather than hidden: a tap is only
 * known once its VM runs, so a VM is filtered a moment AFTER it starts, not
 * before. The rules are applied before the tool is attached.
 */
import { isConversationName } from './names.mjs';

export const BRIDGE = 'mpqemubr0';
export const TABLE = 'clavarium';
const TAP = /^tap-[0-9a-f]{1,12}$/;

/* The taps of the running conversation VMs, read from the process list:
   { conversation: tap }. Anything that does not look exactly as expected is
   left out: a rule is never built from a string that was not checked. */
export function readTaps(processList) {
    const taps = {};
    for (const line of String(processList ?? '').split('\n')) {
        const name = /\/instances\/clv-([a-z0-9-]+)\//.exec(line)?.[1];
        const tap = /[ ,]ifname=([^, ]+)/.exec(line)?.[1];
        if (name && tap && isConversationName(name) && TAP.test(tap)) taps[name] = tap;
    }
    return taps;
}

export function readBridgeAddress(text) {
    const address = /\binet (\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(text ?? ''))?.[1];
    return address && address.split('.').every((n) => Number(n) <= 255) ? address : undefined;
}

/* The whole table, as text for the firewall. Replaced atomically. */
export function ruleset(taps, offline, bridgeAddress) {
    const all = Object.values(taps);
    const lines = [`table bridge ${TABLE}`, `delete table bridge ${TABLE}`, `table bridge ${TABLE} {`];
    lines.push('  chain between_vms {', '    type filter hook forward priority 0;');
    for (const tap of all) lines.push(`    iifname "${tap}" drop`);
    lines.push('  }', '  chain from_vm {', '    type filter hook input priority 0;');
    for (const [name, tap] of Object.entries(taps)) {
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

    /* `host(argv, {input})` runs a privileged command on the host;
       `offline()` returns the names of the conversations switched offline. */
    constructor({ host, offline }) { this.#host = host; this.#offline = offline; }

    /* Rebuilds the rules from what runs now. Returns false, and says nothing
       is filtered, only if the firewall refused the table. */
    async apply() {
        const taps = readTaps((await this.#host(['pgrep', '-a', 'qemu-system'])).stdout);
        const bridge = readBridgeAddress((await this.#host(['ip', '-4', '-o', 'addr', 'show', BRIDGE])).stdout);
        const wanted = this.#offline().filter((name) => taps[name]);
        /* Without the host's address the "offline" rules cannot be written
           safely; the silo rule still can, and is. */
        const r = await this.#host(['nft', '-f', '-'], { input: ruleset(taps, bridge ? wanted : [], bridge ?? '0.0.0.0') });
        return r.code === 0 && (bridge !== undefined || wanted.length === 0);
    }
}
