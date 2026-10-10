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
 *
 * A request that changes something must come from this site's own pages: the
 * Origin header is compared, and the body must be JSON, which a form on
 * another site cannot send. */
import { sameOrigin } from './bridge.mjs';
import { Refusal } from './conversations.mjs';

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
    try {
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
