/* THE DESK ("Bureau", 16-11): the home page as a grid of icons, ONE per person, the same on every screen.
 *
 * What is kept is only where each thing sits: no name, no state -- those are read live from the
 * conversations, the rooms and the assets. The grid takes as many columns as the screen allows; a
 * place that does not fit a narrow screen is moved at display time only (web/desk.js), so the place
 * kept here is never rewritten by a small screen.
 *
 *   items   [{ id, size, c?, r?, t? }]          id: 'c:<conversation>' | 'r:<room>' | 'a:<asset key>'
 *           [{ id: 'f:<x>', folder, size, c?, r?, t?, items: [id] }]   a folder of the desk (one level;
 *                                                not the list's groups: the list never changes)
 *           size: 's' (an icon) | 'm' (wide) | 'l' (large); c, r: its column and row, from 1 (none: the
 *           first free cell); t: when it was put there (the last put wins a cell)
 *   gone    [id]  conversations and rooms taken off the desk: a new one comes by itself, these do not
 *
 * Kept per person: the name the gate gives (an operator's address, or 'local' on one machine). */
import { Refusal } from './conversations.mjs';
import { JsonFile } from './store.mjs';

export const DESK_LIMITS = { bytes: 64 * 1024, items: 300, inFolder: 200, ids: 1000, gone: 1000, cols: 48, rows: 400, id: 200, folderName: 60 };
const SIZES = new Set(['s', 'm', 'l']);
/* No control character, no line: an id is a key, never shown as markup. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const THING = /^[cra]:\S/;
const FOLDER = /^f:[A-Za-z0-9_-]{1,40}$/;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function idOk(id) { return typeof id === 'string' && id.length <= DESK_LIMITS.id && THING.test(id) && !CONTROL.test(id); }

/* The desk as sent, made safe or refused (Refusal 400): only the known fields are kept. Pure. */
export function cleanDesk(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) throw new Refusal(400, 'Send { items: [...] }.');
    const { items } = body;
    if (items.length > DESK_LIMITS.items) throw new Refusal(400, `At most ${DESK_LIMITS.items} things on the desk.`);
    const seen = new Set();
    const once = (id) => { if (seen.has(id)) throw new Refusal(400, `Twice on the desk: ${id}`); seen.add(id); if (seen.size > DESK_LIMITS.ids) throw new Refusal(400, `At most ${DESK_LIMITS.ids} things in all.`); };
    const out = [];
    for (const x of items) {
        if (!x || typeof x !== 'object') throw new Refusal(400, 'Each thing is an object.');
        const size = x.size ?? 's';
        if (!SIZES.has(size)) throw new Refusal(400, 'A size is s, m or l.');
        const one = { id: x.id, size };
        if (x.folder !== undefined) {
            if (typeof x.id !== 'string' || !FOLDER.test(x.id)) throw new Refusal(400, 'A folder\'s id is f: and up to 40 letters.');
            const name = typeof x.folder === 'string' ? x.folder.trim() : '';
            if (!name || name.length > DESK_LIMITS.folderName || CONTROL.test(name)) throw new Refusal(400, `A folder's name: one line, 1 to ${DESK_LIMITS.folderName} characters.`);
            if (!Array.isArray(x.items) || x.items.length > DESK_LIMITS.inFolder) throw new Refusal(400, `A folder holds at most ${DESK_LIMITS.inFolder} things.`);
            once(x.id);
            for (const k of x.items) { if (!idOk(k)) throw new Refusal(400, 'Not a thing of the desk.'); once(k); }
            one.folder = name; one.items = [...x.items];
        } else {
            if (!idOk(x.id)) throw new Refusal(400, 'Not a thing of the desk.');
            once(x.id);
        }
        if (x.c !== undefined || x.r !== undefined) {
            if (!intIn(x.c, 1, DESK_LIMITS.cols) || !intIn(x.r, 1, DESK_LIMITS.rows)) throw new Refusal(400, `A place is a column 1-${DESK_LIMITS.cols} and a row 1-${DESK_LIMITS.rows}.`);
            one.c = x.c; one.r = x.r;
            if (x.t !== undefined) { if (!Number.isFinite(x.t) || x.t < 0) throw new Refusal(400, 'Not a time.'); one.t = x.t; }
        }
        out.push(one);
    }
    const gone = body.gone ?? [];
    if (!Array.isArray(gone) || gone.length > DESK_LIMITS.gone || gone.some((g) => !idOk(g) || !/^[cr]:/.test(g))) throw new Refusal(400, 'gone: conversations and rooms only.');
    return { items: out, gone: [...new Set(gone)].filter((g) => !seen.has(g)) };
}

export class Desks {
    #file; #now;
    constructor({ file = new JsonFile(undefined, {}), now = () => Date.now() } = {}) { this.#file = file; this.#now = now; }
    #all() { const v = this.#file.get(); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    /* `who`: the gate's name for the person. None kept yet: saved false (the page fills it from the home cards). */
    get(who) {
        const d = Object.hasOwn(this.#all(), String(who)) ? this.#all()[String(who)] : null;
        return d ? { saved: true, items: d.items ?? [], gone: d.gone ?? [], at: d.at ?? null } : { saved: false, items: [], gone: [], at: null };
    }
    put(who, body) {
        if (typeof who !== 'string' || !who) throw new Refusal(403, 'Nobody to keep it for.');
        const desk = cleanDesk(body);
        const at = new Date(this.#now()).toISOString();
        this.#file.set({ ...this.#all(), [who]: { ...desk, at } });
        return { saved: true, ...desk, at };
    }
}

/* GET /api/desktop, PUT /api/desktop { items, gone }: `who` is the gate's answer for this request. */
export async function handleDesktop(request, response, desks, who, originOk, headers = {}) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (pathname !== '/api/desktop') return false;
    const send = (status, body) => { response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body)); return true; };
    try {
        if (request.method === 'GET') return send(200, desks.get(who));
        if (request.method !== 'PUT') return send(405, { error: 'GET or PUT.' });
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) return send(403, { error: 'This request does not come from this site.' });
        let text = '';
        for await (const piece of request) { text += piece; if (text.length > DESK_LIMITS.bytes) return send(413, { error: 'Too long.' }); }
        let body;
        try { body = JSON.parse(text); } catch { return send(400, { error: 'The request is not JSON.' }); }
        return send(200, desks.put(who, body));
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message });
        return send(500, { error: 'Something failed on the server.' });
    }
}
