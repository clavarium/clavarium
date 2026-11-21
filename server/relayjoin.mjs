/* ANOTHER HOME JOINS THIS MACHINE'S RELAY: POST /c/relay-join, with no sign-in (the front lets /c/
 * through), the one-time code being the right. See deploy/online.mjs ("SEVERAL HOMES ON ONE RELAY").
 *
 *   POST /c/relay-join   {"code": "ABCD-EFGH", "key": "ssh-ed25519 AAAA..."}
 *   200  {"name", "relay": {"host", "port", "fingerprint"}, "ports": {"tls", "http"}}
 *   400  not this shape;  403  not a valid code (wrong, used or expired);  429  too many tries;  502  the relay did not add it
 *
 * The server only carries it: the code is checked, spent and acted on by root (host program, "relay
 * join"), where the server cannot read the codes. Here: a body of exactly these two fields, a code of
 * the right shape, a PUBLIC ed25519 key (its comment dropped) and nothing else; at most PER_MINUTE
 * tries a minute, from everybody together (behind the relay, every caller has the same address). The
 * answer is rebuilt field by field from what root printed: nothing else can go out.
 */
import { Refusal } from './conversations.mjs';

export const RELAY_JOIN_PATH = '/c/relay-join';
export const PER_MINUTE = 6;
const CODE = /^[A-HJKMNP-Z2-9]{8}$/;
const KEY = /^ssh-ed25519 ([A-Za-z0-9+/]{68})( [A-Za-z0-9@._-]{1,64})?$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$|^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
const PRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const NOT_VALID = 'This code is not valid: wrong, used or expired. Ask the owner of that Clavarium for a new one.';

export class RelayJoin {
    #host; #now; #tries = [];
    /* `host(argv)`: the host program (vm.mjs, runner) -> { code, stdout, stderr }. */
    constructor({ host, now = Date.now }) { this.#host = host; this.#now = now; }

    /* -> { status, body }. `text`: the request's body. */
    async join(text) {
        const now = this.#now();
        this.#tries = this.#tries.filter((t) => t > now - 60_000);
        if (this.#tries.length >= PER_MINUTE) return { status: 429, body: { error: 'Too many tries: wait a minute.' } };
        this.#tries.push(now);
        let given;
        try { given = JSON.parse(text); } catch { return { status: 400, body: { error: 'Not JSON.' } }; }
        if (!given || typeof given !== 'object' || Array.isArray(given) || Object.keys(given).sort().join(',') !== 'code,key') return { status: 400, body: { error: 'Send {"code", "key"} and nothing else.' } };
        const code = String(given.code).toUpperCase().replace(/[\s-]/g, '');
        const key = KEY.exec(typeof given.key === 'string' ? given.key.trim() : '');
        if (typeof given.code !== 'string' || !CODE.test(code)) return { status: 403, body: { error: NOT_VALID } };
        if (!key) return { status: 400, body: { error: 'The key is the PUBLIC tunnel key: one line, ssh-ed25519 and the key.' } };
        const r = await this.#host(['relay', 'join', code, 'ssh-ed25519', key[1]], { timeoutMs: 120_000 });
        if (r.code === 78) return { status: 403, body: { error: NOT_VALID } };
        if (r.code !== 0) return { status: 502, body: { error: 'The relay did not add this home just now: try again, or ask the owner of that Clavarium.' } };
        let a;
        try { a = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { a = null; }
        const port = (v, lo) => Number.isInteger(v) && v >= lo && v <= 65535;
        if (!a || typeof a.name !== 'string' || !HOST.test(a.name) || !HOST.test(a.relay?.host ?? '') || !port(a.relay?.port, 1) || !PRINT.test(a.relay?.fingerprint ?? '')
            || !port(a.ports?.tls, 1024) || !port(a.ports?.http, 1024)) return { status: 502, body: { error: 'The relay did not answer as expected.' } };
        return { status: 200, body: { name: a.name, relay: { host: a.relay.host, port: a.relay.port, fingerprint: a.relay.fingerprint }, ports: { tls: a.ports.tls, http: a.ports.http } } };
    }
}

/* The route, answered here when it is this one (true). */
export async function handleRelayJoin(request, response, join, headers = {}) {
    const say = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body)); return true; };
    if (request.method !== 'POST') return say(405, { error: 'Call this address with POST.' });
    let text = '';
    for await (const piece of request) { text += piece; if (text.length > 2048) return say(413, { error: 'Too long.' }); }
    try {
        const { status, body } = await join.join(text);
        return say(status, body);
    } catch (error) {
        if (error instanceof Refusal) return say(error.status, { error: error.message });
        return say(502, { error: 'The relay did not add this home just now.' });
    }
}
