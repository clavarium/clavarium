/* EXTERNAL MCP SERVERS, THROUGH TETHER (07-11). The owner adds a server reached over Streamable HTTP
 * (Assets › Access): its name, its address, its key. Tether (clavarium-tether 0.1.0-next.56, a target of
 * kind `mcp`) lists its tools, sorts them by their annotations (read / write / destructive), offers them to
 * each conversation by its rights, and asks a person where they say so (a card, demandes.mjs).
 *
 * THE KEY STAYS HERE. It is kept in this server's vault as a host-only secret (secrets.mjs: never put in a
 * machine), named MCP_<ID>_KEY, and Tether is handed only that NAME: the keeper reveals it for the
 * connector alone. It is never logged, returned or said back -- not even in an error (every answer is
 * scrubbed of it before it leaves). A pasted `mcpServers` file names its keys the same way ("${NAME}"),
 * each a secret already in the vault; a value written in it, or a program to start (stdio), is refused.
 *
 * Each function answers the route's body, or throws a Refusal (the page says its message). */
import { Refusal } from './conversations.mjs';

const AGENT = 'conversation:';
export const KEY_PREFIX = 'MCP_';
export const KEY_SUFFIX = '_KEY';
/* MCP_ + the id + _KEY within a secret's 40 characters. */
const ID_MAX = 40 - KEY_PREFIX.length - KEY_SUFFIX.length;
const REF = /^[A-Z][A-Z0-9_]{0,39}$/;
const HEADER_REF = /^(Bearer\s+)?\$\{([A-Za-z0-9_][A-Za-z0-9_.:-]{0,99})\}$/;
const CLASSES = ['read', 'write', 'destructive'];
const GOES = ['yes', 'ask', 'no'];

/* A server's id from its name: small letters, digits and dashes, as Tether keeps it. */
export function serverId(name) {
    return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, ID_MAX).replace(/-+$/, '');
}
/* The vault's name for a server's key. */
export const keyName = (id) => `${KEY_PREFIX}${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}${KEY_SUFFIX}`;

/* Everything said back, scrubbed of the key: a server that echoes it, an error that quotes it. */
function scrub(data, key) {
    if (!key) return data;
    try { return JSON.parse(JSON.stringify(data ?? null).split(key).join('[key]').split(JSON.stringify(key).slice(1, -1)).join('[key]')); } catch { return null; }
}
const said = (text, key) => (key ? String(text ?? '').split(key).join('[key]') : String(text ?? ''));
const known = (secrets, name) => { try { return (secrets?.list({ held: true }) ?? []).some((s) => s.name === name); } catch { return false; } };
/* A target as the page reads it: never a secret's value (Tether gives only their slots' names). */
const shown = (t) => { if (!t || typeof t !== 'object') return t; const { secrets: _s, ...rest } = t; return { ...rest, secrets: Array.isArray(_s) ? _s : Object.keys(_s ?? {}) }; };

/* ADD (or set again) one server: { name, url, key?, header?, allowHttp? } -> the target, its tools listed (or `error`). */
export async function mcpAdd({ tethers, secrets }, body = {}) {
    const name = String(body.name ?? '').trim();
    const url = String(body.url ?? '').trim();
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!name) throw new Refusal(400, 'Give the server a name.');
    if (name.length > 120) throw new Refusal(400, 'A name is 120 characters at most.');
    const id = serverId(name);
    if (!id) throw new Refusal(400, 'Give the server a name with letters or digits.');
    if (!url) throw new Refusal(400, 'Give the server\'s address (https://...).');
    if (key && /[\r\n\0]/.test(key)) throw new Refusal(400, 'A key is one line.');
    const before = tethers.store().target(id);
    if (before && before.kind !== 'mcp') throw new Refusal(409, 'That name is taken by another access.');
    const ref = keyName(id);
    const had = known(secrets, ref);
    /* Its key, in the vault, host-only: Tether gets its name. None given: the one it had, or none. */
    let secret = '';
    if (key) { secrets.set({ name: ref, value: key, hostOnly: true }); secret = ref; }
    else if (before?.secrets?.token) secret = String(before.secrets.token);
    const r = await tethers.act('mcp-add', { id, name, url, ...(secret ? { secret } : {}), ...(body.header ? { header: String(body.header) } : {}), ...(body.allowHttp === true ? { allowHttp: true } : {}) }, '');
    if (!r.ok) {
        /* Nothing was made: a key kept for it alone goes too. */
        if (key && !had && !before) { try { secrets.remove(ref); } catch { /* not there */ } }
        throw new Refusal(400, said(r.text, key));
    }
    return scrub(shown(r.data), key);
}

/* IMPORT a pasted { "mcpServers": { name: { url, headers: { Authorization: "Bearer ${NAME}" } } } }: each key a
   reference to a secret of the vault (none written in it), no program to start. -> the targets made. */
export async function mcpImport({ tethers, secrets }, body = {}) {
    let config = body.config;
    if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch { throw new Refusal(400, 'That is not JSON: paste the whole { "mcpServers": ... } block.'); }
    }
    const all = config && typeof config === 'object' ? (config.mcpServers ?? config.servers) : null;
    if (!all || typeof all !== 'object' || Array.isArray(all) || !Object.keys(all).length) throw new Refusal(400, 'Paste a block like { "mcpServers": { "name": { "url": "https://...", "headers": { "Authorization": "Bearer ${SECRET}" } } } }.');
    const servers = {};
    for (const [name, s] of Object.entries(all)) {
        const label = String(name).slice(0, 60);
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Refusal(400, `${label}: not a server.`);
        if (s.command !== undefined || s.args !== undefined || s.type === 'stdio') throw new Refusal(400, `${label}: a program to start (stdio) is not run here. Only a server reached by its address.`);
        const heads = s.headers && typeof s.headers === 'object' && !Array.isArray(s.headers) ? Object.entries(s.headers) : [];
        if (heads.length > 1) throw new Refusal(400, `${label}: one header for the key at most.`);
        for (const [h, v] of heads) {
            const m = HEADER_REF.exec(String(v ?? '').trim());
            /* Never said back: the header holds a value, whatever it is. */
            if (!m) throw new Refusal(400, `${label}: the header ${String(h).slice(0, 60)} holds a value. Write a reference instead: "\${SECRET_NAME}".`);
            if (!REF.test(m[2]) || !known(secrets, m[2])) throw new Refusal(400, `${label}: no secret named ${m[2].slice(0, 60)} here. Add it in Secrets first.`);
        }
        if (s.env && typeof s.env === 'object' && Object.keys(s.env).length) throw new Refusal(400, `${label}: "env" is for a program to start. Only a server reached by its address.`);
        servers[name] = { url: s.url ?? s.serverUrl, ...(heads.length ? { headers: Object.fromEntries(heads) } : {}), ...(s.allowHttp === true ? { allowHttp: true } : {}) };
    }
    const r = await tethers.act('mcp-import', { config: { mcpServers: servers } }, '');
    if (!r.ok) throw new Refusal(400, r.text);
    return { servers: (Array.isArray(r.data) ? r.data : []).map(shown) };
}

/* LIST AGAIN one server's tools, now. */
export async function mcpRefresh({ tethers }, body = {}) {
    const target = String(body.target ?? '');
    const t = tethers.store().target(target);
    if (!t || t.kind !== 'mcp') throw new Refusal(404, 'No such MCP server.');
    const r = await tethers.act('mcp-refresh', { target }, '');
    const now = tethers.store().target(target);
    /* Not reached: said, its last list kept. */
    return { catalog: now?.catalog ?? null, ...(r.ok ? {} : { error: r.text }) };
}

/* ONE CONVERSATION'S RIGHTS on a server, beyond its level: { target, agent, classes?, tools?, askOpen? } (null takes
   a setting back). Its level (Off / Read / All with approval / All / Custom) is /api/tether/level. */
export async function mcpRights({ tethers }, body = {}) {
    const target = String(body.target ?? '');
    const agent = String(body.agent ?? '');
    const t = tethers.store().target(target);
    if (!t || t.kind !== 'mcp') throw new Refusal(404, 'No such MCP server.');
    if (!agent.startsWith(AGENT) || agent.length <= AGENT.length) throw new Refusal(400, 'Rights are given to a conversation.');
    const args = { target, agent };
    if (body.classes !== undefined) {
        if (!body.classes || typeof body.classes !== 'object' || Array.isArray(body.classes)) throw new Refusal(400, 'classes: { read, write, destructive }, each yes, ask or no.');
        for (const [k, v] of Object.entries(body.classes)) if (!CLASSES.includes(k) || !(v === null || GOES.includes(v))) throw new Refusal(400, 'classes: { read, write, destructive }, each yes, ask or no.');
        args.classes = body.classes;
    }
    if (body.tools !== undefined) {
        if (!body.tools || typeof body.tools !== 'object' || Array.isArray(body.tools)) throw new Refusal(400, 'tools: { name: yes, ask or no }.');
        for (const v of Object.values(body.tools)) if (!(v === null || GOES.includes(v))) throw new Refusal(400, 'tools: { name: yes, ask or no }.');
        args.tools = body.tools;
    }
    if (body.askOpen !== undefined) args.askOpen = body.askOpen === null ? null : body.askOpen === true;
    const r = await tethers.act('mcp-rights', args, '');
    if (!r.ok) throw new Refusal(400, r.text);
    return r.data;
}

/* NEW TOOLS SEEN (Tether 0.1.0-next.57): a tool new on its server, or whose annotations changed, is `fresh` -- asked
   even at All until a person approves one call of it or marks it seen here. { target, tools? } (absent: every fresh
   tool of that server) -> { seen: [names] }. A Tether without the op says so. */
export async function mcpSeen({ tethers }, body = {}) {
    const target = String(body.target ?? '');
    const t = tethers.store().target(target);
    if (!t || t.kind !== 'mcp') throw new Refusal(404, 'No such MCP server.');
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((x) => typeof x !== 'string'))) throw new Refusal(400, 'tools: a list of tool names.');
    const r = await tethers.act('mcp-seen', { target, ...(body.tools ? { tools: body.tools } : {}) }, '');
    if (!r.ok) throw new Refusal(/there is no mcp-seen/.test(r.text ?? '') ? 501 : 400, /there is no mcp-seen/.test(r.text ?? '') ? 'This Tether cannot mark tools as seen yet: update it.' : r.text);
    return { seen: Array.isArray(r.data?.seen) ? r.data.seen : [] };
}

/* A server taken away: its key goes with it (only the one kept for it here). */
export function forgetKey(secrets, target) {
    const ref = target?.kind === 'mcp' ? String(target.secrets?.token ?? '') : '';
    if (!ref || ref !== keyName(target.id)) return;
    try { secrets?.remove(ref); } catch { /* not there */ }
}
