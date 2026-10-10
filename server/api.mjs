/* THE FEW THINGS THE PAGE ASKS FOR, as JSON.
 *
 *   GET  /api/tools
 *   GET  /api/conversations
 *   POST /api/conversations                 {name, tool, memoryMb?}
 *   POST /api/conversations/<name>/sleep
 *   POST /api/conversations/<name>/archive
 *   GET  /api/resources
 *   POST /api/resources                     {name}
 *   POST /api/resources/<name>/remove       only when attached nowhere; content is moved aside
 *   POST /api/conversations/<name>/resources {resource, access: read|write|none}
 *   POST /api/conversations/<name>/share    -> {url, minutes, qr}: a one-use pairing code
 *   GET  /api/conversations/<name>/devices
 *   POST /api/devices/<id>/revoke
 *   POST /api/conversations/<name>/network  {online}
 *   GET  /api/conversations/<name>/signin   {available, configured, host, user, items}
 *   POST /api/conversations/<name>/signin   {host, port?, user, password}; empty host removes
 *   GET  /api/secrets                       names only: a value never comes back
 *   POST /api/secrets                       {name, value}  create or replace
 *   POST /api/secrets/<NAME>/remove
 *   POST /api/conversations/<name>/secrets  {secret, attached}
 *   GET  /api/shortcuts
 *   POST /api/shortcuts                     {label, text, enter}
 *   POST /api/shortcuts/<id>/remove
 *   GET  /api/voice                         is dictation available?
 *   POST /api/voice                         the body IS a WAV recording -> {text}
 *   GET  /api/files?c=<conversation>&r=<resource>&p=<path>          a listing
 *   GET  /api/files/download?c=...&r=...&p=<path>                   one file
 *   POST /api/files/import?c=...&r=...&p=<folder>&name=<file name>  the body IS the file
 *
 * A request that changes something must come from this site's own pages: the
 * Origin header is compared, and the body must be JSON, which a form on
 * another site cannot send. */
import { sameOrigin } from './bridge.mjs';
import { Refusal } from './conversations.mjs';
import { list, download, importFile } from './files.mjs';
import { transcribe, AUDIO_MAX } from './voice.mjs';

const BODY_MAX = 16 * 1024;

function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0; const parts = [];
        request.on('data', (d) => { size += d.length; if (size > BODY_MAX) { reject(new Refusal(413, 'Request too large.')); request.destroy(); } else parts.push(d); });
        request.on('end', () => {
            if (parts.length === 0) return resolve({});
            try { const j = JSON.parse(Buffer.concat(parts).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
            catch { reject(new Refusal(400, 'The request is not JSON.')); }
        });
        request.on('error', reject);
    });
}

/* Returns true when the request was an API request (answered here). */
export async function handleApi(request, response, conversations, headers, resources, originOk = sameOrigin, shortcuts, voice, sharing, secrets, network, signin, mailboxes) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (!pathname.startsWith('/api/')) return false;
    const send = (status, body) => {
        response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    };
    /* Files are reached THROUGH a conversation: only a folder attached to it,
       and writing only where the attachment says "write". */
    const query = new URL(request.url ?? '/', 'http://local').searchParams;
    const attached = (need) => {
        const found = resources?.of(query.get('c') ?? '').find((r) => r.name === query.get('r'));
        if (!found) throw new Refusal(404, 'This folder is not attached to this conversation.');
        if (need === 'write' && found.access !== 'write') throw new Refusal(403, 'This folder is attached read-only.');
        return resources.folder(found.name);
    };
    try {
        if (request.method === 'GET' && pathname === '/api/voice') return send(200, { available: voice !== undefined, engine: voice?.model ?? null }), true;
        if (request.method === 'POST' && pathname === '/api/voice') {
            if (!originOk(request.headers) || request.headers['content-type'] !== 'audio/wav') {
                return send(403, { error: 'This request does not come from this site.' }), true;
            }
            const parts = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.'); parts.push(chunk); }
            return send(200, { text: await transcribe(voice, Buffer.concat(parts)) }), true;
        }
        if (request.method === 'GET' && pathname === '/api/files') return send(200, await list(attached(), query.get('p') ?? '')), true;
        if (request.method === 'GET' && pathname === '/api/files/download') {
            const file = await download(attached(), query.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.size,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            file.stream.pipe(response);
            return true;
        }
        if (request.method === 'POST' && pathname === '/api/files/import') {
            if (!originOk(request.headers) || request.headers['content-type'] !== 'application/octet-stream') {
                return send(403, { error: 'This request does not come from this site.' }), true;
            }
            return send(201, await importFile(attached('write'), query.get('p') ?? '', query.get('name') ?? '', request)), true;
        }
        if (request.method === 'GET') {
            if (pathname === '/api/tools') return send(200, conversations.tools()), true;
            if (pathname === '/api/conversations') {
                return send(200, conversations.list().map((c) => ({ ...c, resources: resources?.of(c.name) ?? [], secrets: secrets?.of(c.name) ?? [] }))), true;
            }
            if (pathname === '/api/resources' && resources) return send(200, resources.list()), true;
            if (pathname === '/api/shortcuts' && shortcuts) return send(200, shortcuts.list()), true;
            if (pathname === '/api/secrets' && secrets) return send(200, secrets.list()), true;
            if (pathname === '/api/mailboxes' && mailboxes) return send(200, mailboxes.list()), true;
            const watched = /^\/api\/conversations\/([^/]+)\/signin$/.exec(pathname);
            if (watched && signin) {
                const conversation = decodeURIComponent(watched[1]);
                const settings = signin.settings(conversation);
                /* A mailbox that cannot be read just now is not an error of the page. */
                const items = settings.configured ? await signin.recent(conversation).catch((e) => ({ failure: e.message })) : [];
                return send(200, { ...settings, items: Array.isArray(items) ? items : [], failure: items.failure ?? null }), true;
            }
            const paired = /^\/api\/conversations\/([^/]+)\/devices$/.exec(pathname);
            if (paired && sharing) return send(200, sharing.devices.of(decodeURIComponent(paired[1]))), true;
            return send(404, { error: 'Not found.' }), true;
        }
        if (request.method !== 'POST') return send(405, { error: 'Method not allowed.' }), true;
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
            return send(403, { error: 'This request does not come from this site.' }), true;
        }
        const body = await readBody(request);
        if (pathname === '/api/conversations') return send(201, conversations.create(body)), true;
        if (pathname === '/api/resources' && resources) return send(201, await resources.create(body)), true;
        const unlisted = /^\/api\/resources\/([a-z0-9-]{1,32})\/remove$/.exec(pathname);
        if (unlisted && resources) { await resources.remove(unlisted[1]); mailboxes?.forget(unlisted[1]); return send(200, { ok: true }), true; }
        if (pathname === '/api/mailboxes' && mailboxes) return send(201, await mailboxes.add(body)), true;
        const fetched = /^\/api\/mailboxes\/([a-z0-9-]{1,32})\/sync$/.exec(pathname);
        if (fetched && mailboxes) return send(200, await mailboxes.sync(fetched[1])), true;
        if (pathname === '/api/shortcuts' && shortcuts) return send(201, shortcuts.add(body)), true;
        if (pathname === '/api/secrets' && secrets) return send(201, secrets.set(body)), true;
        const dropped = /^\/api\/secrets\/([A-Z][A-Z0-9_]{0,39})\/remove$/.exec(pathname);
        if (dropped && secrets) { secrets.remove(dropped[1]); return send(200, { ok: true }), true; }
        const wired = /^\/api\/conversations\/([^/]+)\/network$/.exec(pathname);
        if (wired && network) {
            conversations.setOffline(decodeURIComponent(wired[1]), body.online !== true);
            if (!(await network.apply())) throw new Refusal(502, 'The network rules could not be applied on the host.');
            return send(200, { ok: true, online: body.online === true }), true;
        }
        const mailbox = /^\/api\/conversations\/([^/]+)\/signin$/.exec(pathname);
        if (mailbox && signin) {
            const conversation = decodeURIComponent(mailbox[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            return send(200, await signin.set(conversation, body)), true;
        }
        const handed = /^\/api\/conversations\/([^/]+)\/secrets$/.exec(pathname);
        if (handed && secrets) {
            const conversation = decodeURIComponent(handed[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            secrets.attach(conversation, String(body.secret ?? ''), body.attached === true);
            return send(200, { ok: true, secrets: secrets.of(conversation) }), true;
        }
        const share = /^\/api\/conversations\/([^/]+)\/share$/.exec(pathname);
        if (share && sharing) {
            const conversation = decodeURIComponent(share[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            const { code, minutes } = sharing.devices.share(conversation);
            /* The code rides in the fragment: it is never sent to a server by
               the browser that opens the address, so it reaches no log. */
            const url = `${sharing.origin(request.headers)}/c/#${code}`;
            return send(201, { url, minutes, qr: await sharing.qr(url) }), true;
        }
        const revoked = /^\/api\/devices\/([0-9a-f-]{36})\/revoke$/.exec(pathname);
        if (revoked && sharing) { sharing.devices.revoke(revoked[1]); return send(200, { ok: true }), true; }
        const unwanted = /^\/api\/shortcuts\/([0-9a-f-]{36})\/remove$/.exec(pathname);
        if (unwanted && shortcuts) { shortcuts.remove(unwanted[1]); return send(200, { ok: true }), true; }
        const attach = /^\/api\/conversations\/([^/]+)\/resources$/.exec(pathname);
        if (attach && resources) {
            const conversation = decodeURIComponent(attach[1]);
            if (!conversations.list().some((c) => c.name === conversation && c.phase === 'ready')) throw new Refusal(404, 'No such conversation, or it is not ready.');
            await resources.attach(conversation, String(body.resource ?? ''), String(body.access ?? ''));
            return send(200, { ok: true, resources: resources.of(conversation) }), true;
        }
        const action = /^\/api\/conversations\/([^/]+)\/(sleep|archive)$/.exec(pathname);
        if (!action) return send(404, { error: 'Not found.' }), true;
        await conversations[action[2]](decodeURIComponent(action[1]));
        if (action[2] === 'archive') resources?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') sharing?.devices.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') secrets?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') signin?.forget(decodeURIComponent(action[1]));
        return send(200, { ok: true }), true;
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message }), true;
        return send(500, { error: 'Something failed on the server.' }), true;
    }
}
