/* THE FEW THINGS THE PAGE ASKS FOR, as JSON.
 *
 *   GET  /api/tools
 *   GET  /api/conversations
 *   POST /api/conversations                 {name, tool, memoryMb?}
 *   POST /api/conversations/<name>/sleep
 *   POST /api/conversations/<name>/archive
 *   GET  /api/resources
 *   POST /api/resources                     {name}
 *   POST /api/conversations/<name>/resources {resource, access: read|write|none}
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
export async function handleApi(request, response, conversations, headers, resources) {
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
        if (request.method === 'GET' && pathname === '/api/files') return send(200, await list(attached(), query.get('p') ?? '')), true;
        if (request.method === 'GET' && pathname === '/api/files/download') {
            const file = await download(attached(), query.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.size,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            file.stream.pipe(response);
            return true;
        }
        if (request.method === 'POST' && pathname === '/api/files/import') {
            if (!sameOrigin(request.headers) || request.headers['content-type'] !== 'application/octet-stream') {
                return send(403, { error: 'This request does not come from this site.' }), true;
            }
            return send(201, await importFile(attached('write'), query.get('p') ?? '', query.get('name') ?? '', request)), true;
        }
        if (request.method === 'GET') {
            if (pathname === '/api/tools') return send(200, conversations.tools()), true;
            if (pathname === '/api/conversations') {
                return send(200, conversations.list().map((c) => ({ ...c, resources: resources?.of(c.name) ?? [] }))), true;
            }
            if (pathname === '/api/resources' && resources) return send(200, resources.list()), true;
            return send(404, { error: 'Not found.' }), true;
        }
        if (request.method !== 'POST') return send(405, { error: 'Method not allowed.' }), true;
        if (!sameOrigin(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
            return send(403, { error: 'This request does not come from this site.' }), true;
        }
        const body = await readBody(request);
        if (pathname === '/api/conversations') return send(201, conversations.create(body)), true;
        if (pathname === '/api/resources' && resources) return send(201, resources.create(body)), true;
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
        return send(200, { ok: true }), true;
    } catch (error) {
        if (error instanceof Refusal) return send(error.status, { error: error.message }), true;
        return send(500, { error: 'Something failed on the server.' }), true;
    }
}
