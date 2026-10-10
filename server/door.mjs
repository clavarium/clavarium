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
 *   POST /c/api/session           {device, signature}   sets the session cookie
 *   GET  /c/api/me                the one conversation
 *   GET  /c/api/shortcuts
 *   GET  /c/api/voice   POST /c/api/voice
 *   GET  /c/api/files   GET /c/api/files/download   POST /c/api/files/import
 */
import { Refusal } from './conversations.mjs';
import { SESSION_COOKIE, readCookie, sessionCookie } from './devices.mjs';
import { list, download, importFile } from './files.mjs';
import { transcribe, AUDIO_MAX } from './voice.mjs';

const BODY_MAX = 16 * 1024;

async function readJson(request) {
    const parts = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > BODY_MAX) throw new Refusal(413, 'Request too large.'); parts.push(chunk); }
    try { const j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return j && typeof j === 'object' ? j : {}; }
    catch { throw new Refusal(400, 'The request is not JSON.'); }
}

/* The conversation of the device asking, or undefined. */
export function deviceConversation(devices, headers) {
    return devices.conversationOf(readCookie(headers.cookie, SESSION_COOKIE));
}

/* Returns true when the request was under /c/api/ (answered here). */
export async function handleDoor(request, response, { devices, conversations, resources, shortcuts, voice, originOk, headers, secure }) {
    const url = new URL(request.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/c/api/')) return false;
    const route = url.pathname.slice('/c/api'.length);
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
            return send(200, { ok: true }, { 'set-cookie': sessionCookie(session, hours, secure) });
        }

        /* ---- everything else: a device session, and its one conversation ---- */
        const name = deviceConversation(devices, request.headers);
        const mine = name === undefined ? undefined : conversations.list().find((c) => c.name === name);
        if (!mine) return send(401, { error: 'This device has no open session.' });
        const attached = (need) => {
            const found = resources.of(name).find((r) => r.name === url.searchParams.get('r'));
            if (!found) throw new Refusal(404, 'This folder is not attached to this conversation.');
            if (need === 'write' && found.access !== 'write') throw new Refusal(403, 'This folder is attached read-only.');
            return resources.folder(found.name);
        };

        if (request.method === 'GET' && route === '/me') {
            return send(200, { name: mine.name, toolLabel: mine.toolLabel, phase: mine.phase, step: mine.step, error: mine.error, resources: resources.of(name) });
        }
        if (request.method === 'GET' && route === '/shortcuts') return send(200, shortcuts.list());
        if (request.method === 'GET' && route === '/voice') return send(200, { available: voice !== undefined, engine: voice?.model ?? null });
        if (request.method === 'POST' && route === '/voice') {
            if (request.headers['content-type'] !== 'audio/wav') return send(400, { error: 'A recording is a WAV file.' });
            const parts = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.'); parts.push(chunk); }
            return send(200, { text: await transcribe(voice, Buffer.concat(parts)) });
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
