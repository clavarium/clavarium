/* THE HTTP SIDE OF THE DEVICE DOOR: everything under /c/.
 *
 * The edge lets /c/ through without sign-on and strips any identity header
 * from it, so nothing here ever looks at who the operator is. A request is
 * either part of pairing, or it carries a device session -- and then it is
 * answered for THAT device's conversation, whatever its address says.
 *
 *   GET  /c/                      the device page (and its files)
 *   POST /c/api/pair              {code, key, label}
 *   POST /c/api/challenge         {device}
 *   POST /c/api/session           {device, signature}   sets that pairing's session cookie
 *
 * A device may hold several pairings (several conversations shared with it).
 * Everything else names the pairing it speaks for, in its path:
 *
 *   GET  /c/api/<pairing>/me      the one conversation of that pairing
 *   GET  /c/api/<pairing>/shortcuts
 *   GET  /c/api/<pairing>/voice   POST .../voice
 *   GET  /c/api/<pairing>/files   GET .../files/download   GET .../files/machine   POST .../files/import
 *   POST /c/api/<pairing>/leave   the device removes this pairing itself
 */
import { Refusal } from './conversations.mjs';
import { readCookie, sessionCookie, cookieNameOf, isPairingId } from './devices.mjs';
import { WORK_TAB } from './resources.mjs';
import { list, download, importFile } from './files.mjs';
import { transcribe, AUDIO_MAX } from './voice.mjs';

const BODY_MAX = 16 * 1024;

async function readJson(request) {
    const parts = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > BODY_MAX) throw new Refusal(413, 'Request too large.'); parts.push(chunk); }
    try { const j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return j && typeof j === 'object' ? j : {}; }
    catch { throw new Refusal(400, 'The request is not JSON.'); }
}

/* The conversation the pairing asking speaks for, or undefined: the one it
   names if it was given it, otherwise the first it was given. */
export function deviceConversation(devices, headers, pairing, wanted) {
    if (!isPairingId(pairing)) return undefined;
    return devices.conversationOf(readCookie(headers.cookie, cookieNameOf(pairing)), pairing, wanted);
}
/* The pairing itself, when its session is good -- it may have been given
   folders and no conversation at all. */
export function devicePairing(devices, headers, pairing) {
    if (!isPairingId(pairing)) return undefined;
    return devices.pairingOf(readCookie(headers.cookie, cookieNameOf(pairing)), pairing);
}

/* Returns true when the request was under /c/api/ (answered here). */
export async function handleDoor(request, response, { devices, conversations, resources, shortcuts, voice, originOk, headers, secure }) {
    const url = new URL(request.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/c/api/')) return false;
    /* "/<pairing>/me" -> the pairing and "/me"; "/pair" has no pairing yet. */
    const named = /^\/([0-9a-f-]{36})(\/.*)$/.exec(url.pathname.slice('/c/api'.length));
    const pairing = named?.[1];
    const route = named ? named[2] : url.pathname.slice('/c/api'.length);
    const send = (status, body, extra = {}) => {
        response.writeHead(status, { ...headers, ...extra, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
        return true;
    };
    try {
        if (request.method === 'POST' && !originOk(request.headers)) return send(403, { error: 'This request does not come from this site.' });

        /* ---- pairing: no session yet ---- */
        if (request.method === 'POST' && route === '/pair') return send(201, devices.pair(await readJson(request)));
        if (request.method === 'POST' && route === '/challenge') return send(200, devices.challenge(String((await readJson(request)).device ?? '')));
        if (request.method === 'POST' && route === '/session') {
            const body = await readJson(request);
            const { session, hours } = devices.open(String(body.device ?? ''), body.signature);
            return send(200, { ok: true }, { 'set-cookie': sessionCookie(String(body.device), session, hours, secure) });
        }

        /* ---- everything else: a device session, and its one conversation ---- */
        if (devicePairing(devices, request.headers, pairing) === undefined) return send(401, { error: 'This device has no open session.' });
        /* What this pairing was given: conversations to use, and things of its own to read or write. */
        const given = devices.grantsOf(pairing);
        const names = given.filter((g) => g.type === 'conversation').map((g) => g.name);
        const own = given.filter((g) => g.type !== 'conversation').filter((g) => resources.get(g.name))
            .map((g) => ({ name: g.name, type: g.type, access: g.rights.includes('w') ? 'write' : 'read' }));
        const name = deviceConversation(devices, request.headers, pairing, url.searchParams.get('c') ?? undefined);
        const mine = name === undefined ? undefined : conversations.list().find((c) => c.name === name);
        const attached = (need) => {
            const wanted = url.searchParams.get('r');
            /* Whoever may use a conversation sees ITS files: where its tool
               works, and what is attached to it. Then what the device was
               given for itself. Nothing else exists for it. */
            if (wanted === WORK_TAB) {
                if (mine?.work !== 'kept') throw new Refusal(404, 'This conversation works on the disk of its machine: its files are not kept here.');
                return resources.workFolder(name);
            }
            const found = (mine ? resources.of(name) : []).find((r) => r.name === wanted) ?? own.find((r) => r.name === wanted);
            if (!found) throw new Refusal(404, 'This folder is not attached to this conversation.');
            if (need === 'write' && found.access !== 'write') throw new Refusal(403, 'This folder is attached read-only.');
            return resources.folder(found.name);
        };

        if (request.method === 'GET' && route === '/me') {
            /* `conversations`: all this pairing may use. `shared`: what it was given for itself. */
            const about = mine ? { name: mine.name, toolLabel: mine.toolLabel, phase: mine.phase, step: mine.step, error: mine.error, work: mine.work, resources: resources.of(name) } : { name: null, resources: [] };
            return send(200, { ...about, conversations: names.filter((n) => conversations.list().some((c) => c.name === n)), shared: own });
        }
        /* The files a device was given for itself need no conversation; everything else does. */
        const forFiles = route === '/files' || route === '/files/download' || route === '/files/import' || route === '/leave';
        if (!mine && !forFiles) return send(404, { error: 'This device was given no conversation.' });
        if (request.method === 'GET' && route === '/shortcuts') return send(200, shortcuts.list());
        if (request.method === 'GET' && route === '/voice') return send(200, { available: voice !== undefined, engine: voice?.model ?? null });
        if (request.method === 'POST' && route === '/voice') {
            if (request.headers['content-type'] !== 'audio/wav') return send(400, { error: 'A recording is a WAV file.' });
            const parts = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.'); parts.push(chunk); }
            return send(200, { text: await transcribe(voice, Buffer.concat(parts)) });
        }
        /* The device takes itself out: this pairing is removed, here and on the server. */
        if (request.method === 'POST' && route === '/leave') { devices.revoke(pairing); return send(200, { ok: true }); }
        if (request.method === 'GET' && route === '/files/machine') {
            const file = await conversations.machineFile(name ?? '', url.searchParams.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            response.end(file.bytes);
            return true;
        }
        if (request.method === 'GET' && route === '/files') return send(200, await list(attached(), url.searchParams.get('p') ?? ''));
        if (request.method === 'GET' && route === '/files/download') {
            const file = await download(attached(), url.searchParams.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.size,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            file.stream.pipe(response);
            return true;
        }
        if (request.method === 'POST' && route === '/files/import') {
            if (request.headers['content-type'] !== 'application/octet-stream') return send(400, { error: 'An import is a file.' });
            return send(201, await importFile(attached('write'), url.searchParams.get('p') ?? '', url.searchParams.get('name') ?? '', request));
        }
        return send(404, { error: 'Not found.' });
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message });
        return send(500, { error: 'Something failed on the server.' });
    }
}
