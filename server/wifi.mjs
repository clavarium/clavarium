/* WI-FI, from Settings (This server, Network): the networks THIS SERVER sees,
 * the one it is on, joining another, forgetting one it keeps. All of it is done
 * by the host program as root, through NetworkManager (deploy/clavarium-host,
 * verbs "wifi ...").
 *
 * The server is often reached from afar over that very Wi-Fi. So a join only
 * STARTS a switch, which runs in a unit of its own on the host: if the new
 * network gives no working one within a minute, the host goes back to the one
 * before by itself -- whether or not this server, the page or the request are
 * still there to see it. The outcome is read back from `status()`.
 *
 *   status()  { available, why, device, using: {ssid, signal} | null, saved: [ssid],
 *             last: {state, at, ssid, back, why} | null }
 *             why (not available): no-nmcli, not-running, no-device, unmanaged, unreadable
 *             last.state: joining, joined, went-back, back-failed, interrupted
 *   scan()    [{ ssid, signal, security, inUse }], the strongest first
 *             security: open, wpa, wpa3 (a password); wep, enterprise, other (not joined here)
 *   join(ssid, password)   the switch started: { started, ssid, back } (back: the network it
 *             goes back to, or null); the password goes to the host on standard input only
 *   forget(ssid)   a kept network deleted (never the one in use)
 *
 * THE NETWORK HANDED OVER TO NETWORKMANAGER: a server set up by the Ubuntu installer has
 * its network in netplan with systemd-networkd and no NetworkManager -- its Wi-Fi is not
 * chosen from here, a cable plugged in later is not taken. `status()` says when it can be
 * handed over (`handover: true`) and how the last one went (`hand: {state, at, why}`):
 *   handover()   started in a unit of the host's own: NetworkManager installed, netplan
 *             made to render through it; back as it was if the networks in use before do
 *             not work again within a minute and a half. { started: true }
 *             hand.state: installing, switching, handed, went-back, failed, interrupted
 */
import { Refusal } from './conversations.mjs';

const firstLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.replace(/^REFUSED: /, '').slice(0, 200) ?? '';
/* As the host program takes them: a name of 1 to 32 bytes on one line; a WPA password
   of 8 to 63 plain characters, or none (an open network). Checked here to say it at
   once, and again there, where it matters. */
export function nameOk(ssid) {
    const bytes = Buffer.byteLength(String(ssid ?? ''), 'utf8');
    return typeof ssid === 'string' && bytes >= 1 && bytes <= 32 && !/[\u0000-\u001f\u007f]/.test(ssid);
}
export function passwordWhy(password) {
    if (password === '') return '';
    if (typeof password !== 'string') return 'The password is missing.';
    if (password.length < 8 || password.length > 63) return 'A Wi-Fi password has 8 to 63 characters.';
    if (!/^[\x20-\x7e]+$/.test(password)) return 'A Wi-Fi password is made of plain characters: letters without accents, digits, signs, spaces.';
    if (/^ | $/.test(password)) return 'A password that starts or ends with a space cannot be given here.';
    return '';
}
const STATES = ['joining', 'joined', 'went-back', 'back-failed', 'interrupted'];
const HAND_STATES = ['installing', 'switching', 'handed', 'went-back', 'failed', 'interrupted'];
/* A handover is looked at this long: an install, then a minute and a half. */
const HAND_WATCH_FOR_MS = 20 * 60_000;
/* After a join, the outcome is looked for this often and this long, to be said in What happened. */
const WATCH_EVERY_MS = 5000;
const WATCH_FOR_MS = 6 * 60_000;

/* "wifi status", line by line: only the lines of the expected shapes. */
export function readStatus(text) {
    const out = { available: false, why: null, device: null, using: null, saved: [], last: null, handover: false, hand: null };
    let nmcli = false;
    for (const line of String(text ?? '').split('\n').slice(0, 300)) {
        const word = line.split(' ', 1)[0]; const rest = line.slice(word.length + 1);
        if (word === 'nmcli') nmcli = rest === 'yes';
        else if (word === 'wifiwhy' && /^[a-z-]{1,20}$/.test(rest)) out.why = rest;
        else if (word === 'device' && /^[A-Za-z0-9._-]{1,15}$/.test(rest)) out.device = rest;
        else if (word === 'using') { const m = /^(\d{1,3}) (.+)$/.exec(rest); if (m) out.using = { signal: Math.min(100, Number(m[1])), ssid: m[2] }; }
        else if (word === 'saved' && rest) out.saved.push(rest);
        else if (word === 'last') { const m = /^([a-z-]+) (\d{1,12})$/.exec(rest); if (m && STATES.includes(m[1])) out.last = { ...(out.last ?? {}), state: m[1], at: new Date(Number(m[2]) * 1000).toISOString() }; }
        else if (word === 'handover') out.handover = rest === 'possible';
        else if (word === 'hand') { const m = /^([a-z-]+) (\d{1,12})$/.exec(rest); if (m && HAND_STATES.includes(m[1])) out.hand = { ...(out.hand ?? {}), state: m[1], at: new Date(Number(m[2]) * 1000).toISOString() }; }
        else if (word === 'handwhy' && /^[a-z-]{1,20}$/.test(rest)) out.hand = { ...(out.hand ?? {}), why: rest };
        else if (['lastssid', 'lastback', 'lastwhy'].includes(word) && line.startsWith(`${word} `)) out.last = { ...(out.last ?? {}), [word.slice(4)]: rest || null };
    }
    out.available = nmcli && !out.why && Boolean(out.device);
    if (!nmcli && !out.why) out.why = 'unreadable';
    if (out.last && !out.last.state) out.last = null;
    if (out.hand && !out.hand.state) out.hand = null;
    return out;
}
/* "wifi scan": network <signal> <security> <now|other> <ssid>. */
export function readScan(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n').slice(0, 200)) {
        const m = /^network (\d{1,3}) ([a-z0-9]{1,12}) (now|other) (.+)$/.exec(line);
        if (m) out.push({ ssid: m[4], signal: Math.min(100, Number(m[1])), security: m[2], inUse: m[3] === 'now' });
    }
    return out;
}

export class Wifi {
    #host; #said; #watching = null; #handing = null; #everyMs; #forMs;
    /* `said(text)`: an outcome, in What happened (events.mjs). */
    constructor({ host, said = () => {}, watchEveryMs = WATCH_EVERY_MS, watchForMs = WATCH_FOR_MS }) {
        this.#host = host; this.#said = said; this.#everyMs = watchEveryMs; this.#forMs = watchForMs;
    }
    async status() {
        const r = await this.#host(['wifi', 'status'], { timeoutMs: 30_000 });
        if (r.code !== 0) return { ...readStatus(''), why: 'unreadable', said: firstLine(r.stderr) || `exit ${r.code}` };
        return readStatus(r.stdout);
    }
    async scan() {
        const r = await this.#host(['wifi', 'scan'], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, `The networks could not be listed: ${firstLine(r.stderr) || `exit ${r.code}`}`);
        return readScan(r.stdout);
    }
    async join(ssid, password) {
        if (!nameOk(ssid)) throw new Refusal(400, 'Not a network name: 1 to 32 bytes, on one line.');
        const why = passwordWhy(password ?? '');
        if (why) throw new Refusal(400, why);
        /* On standard input, never as an argument: arguments are seen by every account of the server. */
        const r = await this.#host(['wifi', 'join'], { input: `${ssid}\n${password ?? ''}\n`, timeoutMs: 60_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        const back = /^fallback (.*)$/m.exec(String(r.stdout ?? ''))?.[1] || null;
        this.#watch(ssid);
        return { started: true, ssid, back };
    }
    async handover() {
        const r = await this.#host(['wifi', 'handover'], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        this.#watchHand();
        return { started: true };
    }
    /* Its outcome, said once in What happened, as a switch's is. */
    #watchHand() {
        clearTimeout(this.#handing);
        const until = Date.now() + HAND_WATCH_FOR_MS;
        const look = async () => {
            const h = (await this.status().catch(() => null))?.hand;
            if (h && !['installing', 'switching'].includes(h.state)) {
                this.#handing = null;
                const why = { install: 'could not install NetworkManager', invalid: 'netplan refused', 'no-network': 'no network', stopped: 'stopped', copy: 'could not copy', write: 'could not write' }[h.why] ?? h.why ?? 'no reason given';
                const words = { handed: 'Network: now managed by Clavarium', 'went-back': `Network: did not work (${why}), back as before`, failed: `Network: did not work (${why}), nothing changed`, interrupted: 'Network: interrupted' };
                try { this.#said(words[h.state] ?? `Network: ${h.state}`); } catch { /* never in the way */ }
                return;
            }
            if (Date.now() < until) { this.#handing = setTimeout(look, this.#everyMs); this.#handing.unref?.(); }
        };
        this.#handing = setTimeout(look, this.#everyMs); this.#handing.unref?.();
    }
    async forget(ssid) {
        if (!nameOk(ssid)) throw new Refusal(400, 'Not a network name.');
        const r = await this.#host(['wifi', 'forget', ssid], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Refusal(r.code === 78 ? 409 : 502, firstLine(r.stderr) || `exit ${r.code}`);
        return { forgotten: ssid };
    }
    /* THE OUTCOME, said once in What happened, whoever looks at the page: this server
       keeps running through the switch (only its network comes and goes). */
    #watch(ssid) {
        clearTimeout(this.#watching);
        const until = Date.now() + this.#forMs;
        const look = async () => {
            const s = await this.status().catch(() => null);
            const last = s?.last;
            if (last && last.state !== 'joining' && last.ssid === ssid) {
                this.#watching = null;
                const words = { joined: `Wi-Fi: this server is on "${ssid}" now`, 'went-back': `Wi-Fi: "${ssid}" did not work (${{ password: 'wrong password', 'no-connection': 'no connection', 'no-internet': 'no working network within a minute', stopped: 'stopped' }[last.why] ?? last.why ?? 'no reason given'}): back on ${last.back ? `"${last.back}"` : 'the network before'}`, 'back-failed': `Wi-Fi: "${ssid}" did not work, and "${last.back ?? ''}" did not come back: NetworkManager goes on trying`, interrupted: `Wi-Fi: the switch to "${ssid}" was interrupted` };
                try { this.#said(words[last.state] ?? `Wi-Fi: ${last.state}`); } catch { /* never in the way */ }
                return;
            }
            if (Date.now() < until) { this.#watching = setTimeout(look, this.#everyMs); this.#watching.unref?.(); }
        };
        this.#watching = setTimeout(look, this.#everyMs); this.#watching.unref?.();
    }
}
