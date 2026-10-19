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
 *   GET  .../files/thumb|text   POST .../files/save|make|rename|move|remove|taken   (see files.mjs)
 *   POST /c/api/<pairing>/leave   the device removes this pairing itself
 *   GET  /c/api/<pairing>/talk/words?lang=
 *   GET  /c/api/<pairing>/conversations/<any>/talk          POST the same {text, answers}
 *   POST /c/api/<pairing>/conversations/<any>/talk/remind
 *   POST /c/api/<pairing>/conversations/<any>/talk/react        {to, reaction}: a reaction to a message of the tool (null: taken back)
 *   POST /c/api/<pairing>/conversations/<any>/talk/file?name=   a file attached to a message
 *   POST /c/api/<pairing>/terminal/repair   its terminal does not come (see conversations.mjs)
 *        the chat of its conversation, where it talks through the app (see
 *        talk.mjs): read, written to, reminded. Turning it on and inviting
 *        the tool stay the owner's.
 *
 * A conversation is shared in two parts, chosen by the owner (grants.mjs):
 * its TERMINAL ("x") and its CHAT ("r" to read it, "w" to write there).
 * What was not given is refused here, not only left out of the page:
 *   no terminal   no terminal channel (see deviceTerminal); its shortcuts
 *                 and dictation only if it may write in the chat (they are
 *                 then its ready answers, and what is said fills its box)
 *   no chat       none of the talk routes, its words included
 * ITS FILES. Given its terminal, a device has its files too: the folders
 * of the conversation, to list, open, and import into where it may write.
 * Given its chat alone, it has the files OF THE CHAT, and nothing more: those
 * the tool showed there and those attached to a message, each opened from its
 * message; no listing, no import, no file of the machine's disk. (Folders
 * given to the device for itself stay its own, whatever it was given of a
 * conversation.)
 */
import { Refusal } from './conversations.mjs';
import { readCookie, sessionCookie, cookieNameOf, isPairingId } from './devices.mjs';
import { WORK_TAB } from './resources.mjs';
import { list, download, importFile, page, PAGE_HEADERS, changeRoute, CHANGE_ROUTES, IMAGE_HEADERS } from './files.mjs';
import { transcribe, AUDIO_MAX } from './voice.mjs';

const BODY_MAX = 16 * 1024;

async function readJson(request) {
    const parts = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > BODY_MAX) throw new Refusal(413, 'Request too large.'); parts.push(chunk); }
    try { const j = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); return j && typeof j === 'object' ? j : {}; }
    catch { throw new Refusal(400, 'The request is not JSON.'); }
}

/* The conversation the pairing asking speaks for, or undefined: the one it
   names, only if it was given it; naming none, the first it was given. */
export function deviceConversation(devices, headers, pairing, wanted) {
    if (!isPairingId(pairing)) return undefined;
    return devices.conversationOf(readCookie(headers.cookie, cookieNameOf(pairing)), pairing, wanted);
}
/* The conversation whose TERMINAL the pairing asking may open, or undefined:
   the one it speaks for, only if it was given that conversation's terminal.
   A pairing given its chat alone gets no terminal channel at all -- no
   keys, no shortcuts, no dictation typed into it. */
export function deviceTerminal(devices, headers, pairing, wanted) {
    /* A terminal is always asked for by the name of its conversation: nothing is guessed. */
    if (typeof wanted !== 'string' || wanted === '') return undefined;
    const name = deviceConversation(devices, headers, pairing, wanted);
    return name !== undefined && devices.rightsOn(pairing, name).includes('x') ? name : undefined;
}
/* The pairing itself, when its session is good -- it may have been given
   folders and no conversation at all. */
export function devicePairing(devices, headers, pairing) {
    if (!isPairingId(pairing)) return undefined;
    return devices.pairingOf(readCookie(headers.cookie, cookieNameOf(pairing)), pairing);
}

/* Returns true when the request was under /c/api/ (answered here). */
export async function handleDoor(request, response, { devices, conversations, resources, shortcuts, voice, originOk, headers, secure, talk, repair }) {
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
        /* The parts of that conversation this pairing was given. */
        const rights = name === undefined ? '' : devices.rightsOn(pairing, name);
        const part = { terminal: rights.includes('x'), chat: rights.includes('r') ? (rights.includes('w') ? 'write' : 'read') : null };
        const need = (ok, what) => { if (!ok) throw new Refusal(403, `This device was not given ${what} of this conversation.`); };
        /* Its chat alone: what is reached through the conversation is only what its chat holds. */
        const chatOnly = mine !== undefined && !part.terminal;
        /* `how`: 'list', 'open' (download, page) or 'write' (import). */
        const attached = (need, how = need === 'write' ? 'write' : 'list') => {
            const wanted = url.searchParams.get('r');
            const throughChat = () => {
                if (!chatOnly) return;
                if (how !== 'open') throw new Refusal(403, 'This device was given the chat of this conversation, not its files: only the files of the chat open here.');
                if (!talk?.shown(name, `${wanted}:${url.searchParams.get('p') ?? ''}`)) throw new Refusal(403, 'This file is not one of the chat: only the files of the chat open on this device.');
            };
            /* Whoever may use a conversation sees ITS files: where its tool
               works, and what is attached to it. Then what the device was
               given for itself. Nothing else exists for it. */
            if (wanted === WORK_TAB) {
                if (mine?.work !== 'kept') throw new Refusal(404, 'This conversation works on the disk of its machine: its files are not kept here.');
                throughChat();
                return resources.workFolder(name);
            }
            /* Reached both ways -- through the conversation and by a right of
               its own -- the device has the larger of the two. */
            const ways = [(mine ? resources.of(name) : []).find((r) => r.name === wanted), own.find((r) => r.name === wanted)].filter(Boolean);
            if (ways.length === 0) throw new Refusal(404, 'This folder is not attached to this conversation.');
            /* Given to the device for itself: its own, whatever it was given of the conversation. */
            if (!own.some((r) => r.name === wanted)) throughChat();
            if (need === 'write' && !ways.some((w) => w.access === 'write')) throw new Refusal(403, 'This folder is attached read-only.');
            return resources.folder(ways[0].name);
        };

        if (request.method === 'GET' && route === '/me') {
            /* `conversations`: all this pairing may use. `shared`: what it was given for itself. */
            /* `terminal` and `chat`: the parts it was given, for the page to show only those. */
            const about = mine ? { name: mine.name, toolLabel: mine.toolLabel, chatName: mine.chatName, voiceMark: mine.voiceMark, phase: mine.phase, step: mine.step, progress: mine.progress, error: mine.error, work: mine.work, resources: resources.of(name), ...part } : { name: null, resources: [] };
            return send(200, { ...about, conversations: names.filter((n) => conversations.list().some((c) => c.name === n)), shared: own });
        }
        /* The files a device was given for itself need no conversation; everything else does. */
        const forFiles = route === '/files' || route === '/files/download' || route === '/files/page' || route === '/files/import' || CHANGE_ROUTES.includes(route) || route === '/leave';
        if (!mine && !forFiles) return send(404, { error: 'This device was given no conversation.' });
        /* Shortcuts are typed into the terminal, or are the ready answers of the chat: one of the two must be its to write in. */
        if (request.method === 'GET' && route === '/shortcuts') { need(part.terminal || part.chat === 'write', 'the terminal or the chat'); return send(200, shortcuts.list()); }
        /* What is dictated goes into the terminal, or into the chat's box: one of the two must be its to write in. */
        const speaks = part.terminal || part.chat === 'write';
        if (request.method === 'GET' && route === '/voice') return send(200, { available: voice?.current() !== undefined && speaks, engine: speaks ? voice?.model ?? null : null });
        if (request.method === 'POST' && route === '/voice') {
            need(speaks, 'the terminal or the chat');
            if (request.headers['content-type'] !== 'audio/wav') return send(400, { error: 'A recording is a WAV file.' });
            const parts = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.'); parts.push(chunk); }
            return send(200, { text: voice ? await voice.transcribe(Buffer.concat(parts)) : await transcribe(undefined, Buffer.concat(parts)) });
        }
        /* Its conversation's chat, whatever conversation the address names: the device's own. */
        /* Only for a pairing given its chat: to read it, or to write there too. */
        const talking = /^\/conversations\/[^/]+\/talk(\/[a-z]+)?$/.exec(route);
        if (talk && (route === '/talk/words' || talking)) need(part.chat !== null, 'the chat');
        if (talk && request.method === 'GET' && route === '/talk/words') return send(200, talk.words(url.searchParams.get('lang') ?? 'en'));
        if (talk && talking) {
            if (request.method === 'GET' && !talking[1]) return send(200, talk.of(name));
            /* Reminding the tool and writing to it: a chat given to write in. Nothing else (turning it on, inviting the tool) is a device's. */
            if (request.method === 'POST' && (talking[1] === undefined || talking[1] === '/remind' || talking[1] === '/file' || talking[1] === '/react')) need(part.chat === 'write', 'the chat to write in');
            if (request.method === 'POST' && talking[1] === '/react') { const body = await readJson(request); return send(200, await talk.react(name, body.to, body.reaction ?? null)); }
            if (request.method === 'POST' && talking[1] === '/remind') return send(200, await talk.remind(name));
            if (request.method === 'POST' && talking[1] === '/file') {
                if (request.headers['content-type'] !== 'application/octet-stream') return send(400, { error: 'An attachment is a file.' });
                return send(201, await talk.attach(name, url.searchParams.get('name') ?? '', request));
            }
            if (request.method === 'POST' && talking[1] === undefined) { const body = await readJson(request); return send(201, await talk.say(name, body.text, body.answers, body.files, body.via)); }
        }
        /* Its terminal does not come: only a device given it asks for it to be repaired. */
        if (request.method === 'POST' && route === '/terminal/repair') { need(part.terminal, 'the terminal'); return send(200, await repair(name)); }
        /* The device takes itself out: this pairing is removed, here and on the server. */
        if (request.method === 'POST' && route === '/leave') { devices.revoke(pairing); return send(200, { ok: true }); }
        if (request.method === 'GET' && route === '/files/machine') {
            /* A path on its terminal's screen: a device without the terminal has none to click. */
            need(!chatOnly, 'the terminal');
            const file = await conversations.machineFile(name ?? '', url.searchParams.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            response.end(file.bytes);
            return true;
        }
        if (request.method === 'GET' && route === '/files') return send(200, await list(attached(), url.searchParams.get('p') ?? ''));
        if (request.method === 'GET' && route === '/files/page') {
            if (mine?.offline === true) throw new Refusal(403, 'This conversation is offline: its pages are shown as text, not run.');
            const file = await page(attached('read', 'open'), url.searchParams.get('p') ?? '');
            response.writeHead(200, { ...PAGE_HEADERS, 'content-length': file.size });
            file.stream.pipe(response);
            return true;
        }
        if (request.method === 'GET' && route === '/files/download') {
            const file = await download(attached('read', 'open'), url.searchParams.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.size,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            file.stream.pipe(response);
            return true;
        }
        if (request.method === 'POST' && route === '/files/import') {
            if (request.headers['content-type'] !== 'application/octet-stream') return send(400, { error: 'An import is a file.' });
            return send(201, await importFile(attached('write'), url.searchParams.get('p') ?? '', url.searchParams.get('name') ?? '', request,
                { exists: url.searchParams.get('exists') ?? 'keep', dir: url.searchParams.get('dir') ?? '', batch: url.searchParams.get('batch') ?? undefined }));
        }
        /* Thumbnails, editing, making, renaming, moving, removing: as listing
           and importing are. A device given the chat alone has none of them
           (`attached` refuses all but opening a file of the chat). */
        /* A thumbnail is the file read, as opening it is: a device given the chat alone sees the pictures of its chat. */
        const answer = await changeRoute(request.method, route, url.searchParams, request, (need) => attached(need, route === '/files/thumb' ? 'open' : undefined));
        if (answer?.picture) {
            response.writeHead(200, { ...headers, ...IMAGE_HEADERS, 'content-type': answer.picture.type, 'content-length': answer.picture.bytes.length });
            response.end(answer.picture.bytes);
            return true;
        }
        if (answer) return send(answer[0], answer[1]);
        return send(404, { error: 'Not found.' });
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message, ...(error.kind ? { kind: error.kind } : {}), ...(error.retry ? { retry: true } : {}) });
        return send(500, { error: 'Something failed on the server.' });
    }
}
