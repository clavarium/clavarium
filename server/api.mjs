/* THE FEW THINGS THE PAGE ASKS FOR, as JSON.
 *
 *   GET  /api/tools
 *   GET  /api/conversations
 *   POST /api/conversations                 {name, tool, memoryMb?}
 *   POST /api/conversations/<name>/sleep
 *   POST /api/conversations/<name>/restart       a clean stop (by force if it hangs), then a start
 *   POST /api/conversations/<name>/machine       {memoryMb?, diskGb?}: stopped, set, started again
 *   GET  /api/conversations/<name>/health        what was last seen of its machine
 *   POST /api/conversations/<name>/health        look now (never wakes a machine)
 *   POST /api/conversations/<name>/archive
 *   POST /api/conversations/<name>/ask-first     {on}: its tool asks before acting (true), or acts without asking in its machine (false, the default), from its next start
 *   POST /api/conversations/<name>/resume        {on}: its tool takes up its last session when it starts (true), or starts fresh
 *   POST /api/conversations/<name>/terminal/repair   its terminal does not come though its machine runs: repaired
 *   POST /api/conversations/<name>/talk          {text, answers?, files?}: written in its chat; files from .../talk/file
 *   POST /api/conversations/<name>/talk/file?name=<file name>   the body IS a file the person attaches -> {path, name, size}
 *   GET  /api/talk/thread                        what a chat shows of each kind of event: {levels, defaults, choices}
 *   POST /api/talk/thread                        {levels: {kind: 'needs-you'|'news'|'trace'}}: the owner's choice, whole or partial
 *   GET  /api/conversations/<name>/guide         what its tool is told about where it is: the exact texts, the owner's lines
 *   POST /api/conversations/<name>/guide         {lines}: the owner's own lines for it (short, plain text)
 *   POST /api/conversations/<name>/guide/tell    its guide written again, and one line typed in its terminal to read it
 *   GET  /api/resources
 *   POST /api/resources                     {name} | {name, type: 'git', from?, via?: {method, key?, user?, secret?}}
 *   GET  /api/git-keys                      SSH keys made here: the public half only
 *   POST /api/git-keys                      {name} -> a new key; its private half never leaves the server
 *   POST /api/git-keys/<name>/remove        refused while a repository uses it
 *   GET  /api/git-hosts                     host keys recorded at first contact: {host, type, fingerprint}
 *   POST /api/git-hosts/forget              {host}: the next contact trusts the key it is shown
 *   GET  /api/shelf                         the ready-made machine: date, size, tools, rebuild in progress, last refusal
 *   POST /api/shelf/rebuild                 rebuild it now, in the background (refused when the disk is short)
 *   GET  /api/git/<name>/outgoing?target=<branch>&branch=<branch>   what would go from the agent's branch, to that branch of the remote
 *   POST /api/git/<name>/push               {head, target?, sure?}: exactly that reviewed commit, to exactly that branch
 *   GET  /api/git/<name>/keep               origin kept up to date, checks, automatic sending, log
 *   POST /api/git/<name>/keep               {refreshMinutes?, alert?, checkCommand?, checkSeconds?, runHook?, requireForSend?, fsck?}
 *   GET  /api/conversations/<c>/git/<name>/auto   automatic sending for that conversation (attached for writing)
 *   POST /api/conversations/<c>/git/<name>/auto   {branches?, quietSeconds?, perHour?, create?, checks?, sure?}
 *   POST /api/git/<name>/refresh            fetch the origin into its mirror now
 *   POST /api/git/<name>/check              {head, target?}: run the checks in the machine
 *   POST /api/resources/<name>/remove       only when attached nowhere; content is moved aside
 *   POST /api/conversations/<name>/resources {resource, access: read|write|none}
 *   POST /api/conversations/<name>/share    {rights?} -> {url, minutes, qr}: a one-use pairing code;
 *                                           rights "x" its terminal (the default), "rw" its chat, "rwx" both
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
 *   GET  /api/flows                         who gets what: devices, conversations, assets, the rights between them, the flows
 *   POST /api/flows/name                    {around, name}: a flow named by the owner ('' gives it back its own)
 *   POST /api/setup/export                  {flow?} -> {name, text}: the configuration as one file, never the data
 *   POST /api/setup/preview                 {text, choices?}: what an import would do, said before anything is done
 *   POST /api/setup/import                  {text, choices?}: made in the background; GET says how far it is
 *   POST /api/setup/pair                    {label}: what a device to pair will get (the code is made by /api/shares)
 *   POST /api/setup/drop                    {id}: something an import waits for, not wanted after all
 *   GET  /api/files/download?c=...&r=...&p=<path>                   one file
 *   POST /api/files/import?c=...&r=...&p=<folder>&name=<file name>[&dir=<subfolders>&exists=keep|replace|skip&batch=<id>]  the body IS the file
 *   GET  /api/files/thumb|text   POST /api/files/save|make|rename|move|remove|taken   ?c=...&r=...&p=...   (see files.mjs)
 *
 * A request that changes something must come from this site's own pages: the
 * Origin header is compared, and the body must be JSON, which a form on
 * another site cannot send. */
import { sameOrigin } from './bridge.mjs';
import { Refusal } from './conversations.mjs';
import { list, download, importFile, page, PAGE_HEADERS, changeRoute, IMAGE_HEADERS } from './files.mjs';
import { WORK_TAB } from './resources.mjs';
import { transcribe, AUDIO_MAX } from './voice.mjs';
import { FILE_MAX } from './setup.mjs';

const BODY_MAX = 16 * 1024;
/* A setup file travels inside the JSON of a request: room for it, escaped. */
const SETUP_BODY_MAX = 3 * FILE_MAX;

function readBody(request, max = BODY_MAX) {
    return new Promise((resolve, reject) => {
        let size = 0; const parts = [];
        request.on('data', (d) => { size += d.length; if (size > max) { reject(new Refusal(413, 'Request too large.')); request.destroy(); } else parts.push(d); });
        request.on('end', () => {
            if (parts.length === 0) return resolve({});
            try { const j = JSON.parse(Buffer.concat(parts).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
            catch { reject(new Refusal(400, 'The request is not JSON.')); }
        });
        request.on('error', reject);
    });
}

/* Returns true when the request was an API request (answered here). */
export async function handleApi(request, response, conversations, headers, resources, originOk = sameOrigin, shortcuts, voice, sharing, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, repair, guide, capacity) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (!pathname.startsWith('/api/')) return false;
    const send = (status, body) => {
        response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    };
    /* Files are reached THROUGH a conversation: only a folder attached to it,
       and writing only where the attachment says "write". */
    const query = new URL(request.url ?? '/', 'http://local').searchParams;
    const attached = (need) => {
        /* The conversation's own work folder, when the server keeps it. */
        if (query.get('r') === WORK_TAB && resources) {
            const c = conversations.list().find((x) => x.name === query.get('c'));
            if (c?.work !== 'kept') throw new Refusal(404, 'This conversation works on the disk of its machine: its files are not kept here.');
            return resources.workFolder(c.name);
        }
        /* THE OWNER MAY DO EVERYTHING, ALWAYS: this is the owner's side, so any
           folder, repository or mailbox is reachable, attached to the
           conversation shown or not. (A mailbox is never written by hand: it
           is a copy that the next reading of the mail would undo.) */
        const any = resources?.get(query.get('r') ?? '');
        if (!any) throw new Refusal(404, 'No such folder.');
        if (need === 'write' && any.type === 'mailbox') throw new Refusal(403, 'A mailbox is a copy of the mail: nothing can be added to it here.');
        /* Shown through a conversation that has it READ-ONLY, it is read-only here too: the page says so, and offers nothing that writes. */
        if (need === 'write' && resources.of(query.get('c') ?? '').some((r) => r.name === any.name && r.access === 'read')) throw new Refusal(403, 'This folder is attached read-only to this conversation: nothing is changed in it from here.');
        return resources.folder(any.name);
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
        if (request.method === 'GET' && pathname === '/api/files/machine') {
            const file = await conversations.machineFile(query.get('c') ?? '', query.get('p') ?? '');
            response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
                'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
            response.end(file.bytes);
            return true;
        }
        if (request.method === 'GET' && pathname === '/api/files/page') {
            /* A conversation whose network was cut does not get a way out through the reader's browser. */
            if (conversations.list().find((x) => x.name === query.get('c'))?.offline === true) throw new Refusal(403, 'This conversation is offline: its pages are shown as text, not run.');
            const file = await page(attached(), query.get('p') ?? '');
            response.writeHead(200, { ...PAGE_HEADERS, 'content-length': file.size });
            file.stream.pipe(response);
            return true;
        }
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
            return send(201, await importFile(attached('write'), query.get('p') ?? '', query.get('name') ?? '', request, { exists: query.get('exists') ?? 'keep', dir: query.get('dir') ?? '', batch: query.get('batch') ?? undefined })), true;
        }
        if (pathname.startsWith('/api/files/')) {
            if (request.method === 'POST' && !originOk(request.headers)) return send(403, { error: 'This request does not come from this site.' }), true;
            const answer = await changeRoute(request.method, pathname.slice('/api'.length), query, request, attached);
            if (answer?.picture) {
                response.writeHead(200, { ...headers, ...IMAGE_HEADERS, 'content-type': answer.picture.type, 'content-length': answer.picture.bytes.length, etag: `"${answer.picture.version}"` });
                response.end(answer.picture.bytes);
                return true;
            }
            if (answer) return send(answer[0], answer[1]), true;
        }
        if (request.method === 'GET') {
            if (pathname === '/api/tools') return send(200, conversations.tools()), true;
            if (pathname === '/api/conversations') {
                return send(200, conversations.list().map((c) => ({ ...c, resources: resources?.of(c.name) ?? [], secrets: secrets?.of(c.name) ?? [], answerer: answerer?.of(c.name) ?? null, wakeups: wakeups?.of(c.name) ?? null, health: health?.of(c.name) ?? null, talk: talk?.brief(c.name) ?? null }))), true;
            }
            if (pathname === '/api/resources' && resources) return send(200, resources.list()), true;
            if (pathname === '/api/shortcuts' && shortcuts) return send(200, shortcuts.list()), true;
            if (pathname === '/api/secrets' && secrets) return send(200, secrets.list()), true;
            if (pathname === '/api/mailboxes' && mailboxes) return send(200, mailboxes.list()), true;
            /* Every device, each with all it was given. */
            if (pathname === '/api/devices' && sharing) return send(200, sharing.devices.all()), true;
            if (pathname === '/api/git-keys' && gitAccess) return send(200, gitAccess.keys()), true;
            if (pathname === '/api/git-hosts' && gitAccess) return send(200, gitAccess.hosts()), true;
            if (pathname === '/api/platform' && platform) return send(200, platform), true;
            if (pathname === '/api/shelf' && shelf) return send(200, shelf.about()), true;
            /* This server's disk and memory (capacity.mjs): everything for Settings; only whether it is high for the list. */
            if (pathname === '/api/server' && capacity) return send(200, await capacity.about()), true;
            if (pathname === '/api/server/brief' && capacity) return send(200, await capacity.brief()), true;
            if (pathname === '/api/alerts' && alerts) return send(200, alerts.about()), true;
            if (pathname === '/api/flows' && setup) return send(200, setup.graph()), true;
            if (pathname === '/api/setup/import' && setup) return send(200, setup.job()), true;
            const looked = /^\/api\/conversations\/([^/]+)\/health$/.exec(pathname);
            if (looked && health) return send(200, health.of(decodeURIComponent(looked[1]))), true;
            /* The words of the chat screen, for a screen whose language is `lang`; and the owner's choice of them. */
            if (pathname === '/api/talk/words' && talk) return send(200, talk.words(query.get('lang') ?? 'en')), true;
            if (pathname === '/api/talk/settings' && talk) return send(200, talk.settings()), true;
            if (pathname === '/api/talk/thread' && talk) return send(200, talk.thread()), true;
            const guided = /^\/api\/conversations\/([^/]+)\/guide$/.exec(pathname);
            if (guided && guide) return send(200, guide.about(decodeURIComponent(guided[1]))), true;
            const talked = /^\/api\/conversations\/([^/]+)\/talk$/.exec(pathname);
            if (talked && talk) return send(200, talk.of(decodeURIComponent(talked[1]))), true;
            const answered = /^\/api\/conversations\/([^/]+)\/answerer\/log$/.exec(pathname);
            if (answered && answerer) return send(200, answerer.log(decodeURIComponent(answered[1]))), true;
            /* A repository: where its commits go, and what would go now. */
            const repo = /^\/api\/git\/([a-z0-9-]{1,32})(\/outgoing|\/keep)?$/.exec(pathname);
            if (repo && repo[2] === '/keep' && gitKeeper) return send(200, gitKeeper.about(repo[1])), true;
            if (repo && gitReview) return send(200, repo[2] ? await gitReview.outgoing(repo[1], { target: query.get('target') ?? undefined, branch: query.get('branch') ?? undefined }) : gitReview.settings(repo[1])), true;
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
            const sending = /^\/api\/conversations\/([^/]+)\/git\/([a-z0-9-]{1,32})\/auto$/.exec(pathname);
            if (sending && gitKeeper) return send(200, gitKeeper.auto(sending[2], decodeURIComponent(sending[1]))), true;
            return send(404, { error: 'Not found.' }), true;
        }
        if (request.method !== 'POST') return send(405, { error: 'Method not allowed.' }), true;
        /* A file the person attaches to a message of the chat: the body is the file. */
        const attaching = /^\/api\/conversations\/([^/]+)\/talk\/file$/.exec(pathname);
        if (attaching && talk) {
            if (!originOk(request.headers) || request.headers['content-type'] !== 'application/octet-stream') return send(403, { error: 'This request does not come from this site.' }), true;
            return send(201, await talk.attach(decodeURIComponent(attaching[1]), query.get('name') ?? '', request)), true;
        }
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
            return send(403, { error: 'This request does not come from this site.' }), true;
        }
        const body = await readBody(request, pathname === '/api/setup/preview' || pathname === '/api/setup/import' ? SETUP_BODY_MAX : BODY_MAX);
        if (pathname === '/api/conversations') { await conversations.admit?.(body); return send(201, conversations.create(body)), true; }
        /* Who gets what, and a whole setup in one file: see setup.mjs. */
        if (pathname.startsWith('/api/setup/') || pathname === '/api/flows/name') {
            if (!setup) return send(404, { error: 'Not found.' }), true;
            const choices = body.choices && typeof body.choices === 'object' ? body.choices : {};
            if (pathname === '/api/flows/name') return send(200, setup.rename(body.around, body.name)), true;
            if (pathname === '/api/setup/export') return send(200, setup.exportText({ flow: typeof body.flow === 'string' ? body.flow : undefined })), true;
            if (pathname === '/api/setup/preview') return send(200, setup.preview(body.text, choices)), true;
            if (pathname === '/api/setup/import') return send(202, setup.start(body.text, choices)), true;
            if (pathname === '/api/setup/pair') return send(200, setup.toPair(body.label)), true;
            if (pathname === '/api/setup/drop') { setup.drop(body.id); return send(200, { ok: true }), true; }
            return send(404, { error: 'Not found.' }), true;
        }
        /* A folder, or a git repository (empty, or cloned from `from`). A mailbox has its own way in. */
        if (pathname === '/api/resources' && resources) {
            const made = await resources.create({ name: body.name, type: body.type === 'git' ? 'git' : 'folder', from: body.from, via: body.via });
            /* One an import was waiting for: attached where the file said. */
            void setup?.assetAdded(made.name).catch(() => {});
            return send(201, made), true;
        }
        if (pathname === '/api/git-keys' && gitAccess) return send(201, gitAccess.makeKey(body)), true;
        if (pathname === '/api/shelf/rebuild' && shelf) return send(202, await shelf.rebuild()), true;
        if (pathname === '/api/server/reserve' && capacity) { capacity.setReserve({ diskMb: body.diskMb, memoryMb: body.memoryMb }); return send(200, await capacity.about()), true; }
        if (pathname === '/api/git-hosts/forget' && gitAccess) return send(200, gitAccess.forgetHost(body.host)), true;
        const unkeyed = /^\/api\/git-keys\/([a-z0-9-]{1,32})\/remove$/.exec(pathname);
        if (unkeyed && gitAccess) { gitAccess.removeKey(unkeyed[1]); return send(200, { ok: true }), true; }
        const unlisted = /^\/api\/resources\/([a-z0-9-]{1,32})\/remove$/.exec(pathname);
        if (unlisted && resources) {
            const gone = resources.get(unlisted[1]);
            await resources.remove(unlisted[1]); mailboxes?.forget(unlisted[1]); gitReview?.forget(unlisted[1]);
            /* A device that had been given it loses it. */
            if (gone) sharing?.devices.forgetAsset(resources.assetOf(gone));
            return send(200, { ok: true }), true;
        }
        if (pathname === '/api/mailboxes' && mailboxes) { const made = await mailboxes.add(body); void setup?.assetAdded(made.name).catch(() => {}); return send(201, made), true; }
        const fetched = /^\/api\/mailboxes\/([a-z0-9-]{1,32})\/sync$/.exec(pathname);
        if (fetched && mailboxes) return send(200, await mailboxes.sync(fetched[1])), true;
        if (pathname === '/api/shortcuts' && shortcuts) return send(201, shortcuts.add(body)), true;
        if (pathname === '/api/secrets' && secrets) { const made = secrets.set(body); setup?.secretAdded(made.name); return send(201, made), true; }
        const dropped = /^\/api\/secrets\/([A-Z][A-Z0-9_]{0,39})\/remove$/.exec(pathname);
        if (dropped && secrets) { secrets.remove(dropped[1]); return send(200, { ok: true }), true; }
        if (pathname === '/api/alerts' && alerts) return send(201, alerts.add(body.subscription, body.label)), true;
        if (pathname === '/api/alerts/remove' && alerts) return send(200, alerts.remove(String(body.endpoint ?? ''))), true;
        if (pathname === '/api/alerts/test' && alerts) return send(200, { reached: await alerts.tell({ title: 'Clavarium', body: 'This is what an alert looks like.', url: '/' }) }), true;
        if (pathname === '/api/talk/settings' && talk) return send(200, talk.setWords({ lang: body.lang, own: body.own })), true;
        if (pathname === '/api/talk/thread' && talk) return send(200, talk.setThread({ levels: body.levels })), true;
        const guiding = /^\/api\/conversations\/([^/]+)\/guide(\/tell)?$/.exec(pathname);
        if (guiding && guide) {
            const conversation = decodeURIComponent(guiding[1]);
            if (guiding[2]) return send(200, await guide.tellAgain(conversation)), true;
            return send(200, await guide.setLines(conversation, body.lines)), true;
        }
        /* A setting its tool is told about changed: its guide follows (never waking a machine). */
        const retell = (conversation) => { void guide?.changed(conversation).catch(() => {}); };
        const talking = /^\/api\/conversations\/([^/]+)\/talk(\/invite|\/remind)?$/.exec(pathname);
        if (talking && talk) {
            const conversation = decodeURIComponent(talking[1]);
            if (talking[2] === '/invite') return send(200, await talk.invite(conversation, typeof body.lang === 'string' ? body.lang : 'en')), true;
            if (talking[2] === '/remind') return send(200, await talk.remind(conversation)), true;
            if (typeof body.on === 'boolean') { const now = await talk.set(conversation, body.on); retell(conversation); return send(200, now), true; }
            return send(201, await talk.say(conversation, body.text, body.answers, body.files)), true;
        }
        const woken = /^\/api\/conversations\/([^/]+)\/wakeups(?:\/([0-9a-f-]{36})(\/remove)?)?$/.exec(pathname);
        if (woken && wakeups) {
            const conversation = decodeURIComponent(woken[1]);
            if (woken[3]) return send(200, wakeups.remove(conversation, woken[2])), true;
            if (woken[2]) return send(200, wakeups.turn(conversation, woken[2], body.on === true)), true;
            if (body.kind === undefined) return send(200, wakeups.setLimit(conversation, body.perHour)), true;
            return send(201, wakeups.add(conversation, body)), true;
        }
        const mandate = /^\/api\/conversations\/([^/]+)\/answerer(\/resume)?$/.exec(pathname);
        if (mandate && answerer) {
            const conversation = decodeURIComponent(mandate[1]);
            if (mandate[2]) { answerer.resume(conversation); return send(200, answerer.of(conversation)), true; }
            return send(200, answerer.set(conversation, body)), true;
        }
        const wired = /^\/api\/conversations\/([^/]+)\/network$/.exec(pathname);
        if (wired && network) {
            conversations.setOffline(decodeURIComponent(wired[1]), body.online !== true);
            if (!(await network.apply())) throw new Refusal(502, 'The network rules could not be applied on the host.');
            retell(decodeURIComponent(wired[1]));
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
            retell(conversation);
            return send(200, { ok: true, secrets: secrets.of(conversation) }), true;
        }
        const share = /^\/api\/conversations\/([^/]+)\/share$/.exec(pathname);
        if (share && sharing) {
            const conversation = decodeURIComponent(share[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            const { code, minutes } = sharing.devices.share(body.rights === undefined ? conversation : [{ asset: `conversation:${conversation}`, rights: body.rights }]);
            /* The code rides in the fragment: it is never sent to a server by
               the browser that opens the address, so it reaches no log. */
            const url = `${sharing.origin(request.headers)}/c/#${code}`;
            return send(201, { url, minutes, qr: await sharing.qr(url) }), true;
        }
        /* A share made of a chosen list: conversations, folders, mailboxes, repositories. */
        if (pathname === '/api/shares' && sharing) {
            const asked = Array.isArray(body.grants) ? body.grants : [];
            for (const g of asked) {
                const [type, name] = String(g?.asset ?? '').split(':');
                const exists = type === 'conversation' ? conversations.list().some((c) => c.name === name) : resources?.list().some((r) => resources.assetOf(r) === g.asset);
                if (!exists) throw new Refusal(404, `There is no such thing to share: ${String(g?.asset ?? '')}.`);
            }
            const { code, minutes } = sharing.devices.share(asked, body.label);
            const url = `${sharing.origin(request.headers)}/c/#${code}`;
            return send(201, { url, minutes, qr: await sharing.qr(url) }), true;
        }
        const kept = /^\/api\/git\/([a-z0-9-]{1,32})\/(keep|refresh|check)$/.exec(pathname);
        if (kept && gitKeeper) {
            if (kept[2] === 'keep') return send(200, gitKeeper.set(kept[1], body)), true;
            if (kept[2] === 'refresh') return send(200, await gitKeeper.refresh(kept[1])), true;
            return send(200, await gitKeeper.check(kept[1], body)), true;
        }
        /* Automatic sending belongs to the attachment: set in the conversation's panel. */
        const sending = /^\/api\/conversations\/([^/]+)\/git\/([a-z0-9-]{1,32})\/auto$/.exec(pathname);
        if (sending && gitKeeper) return send(200, gitKeeper.setAuto(sending[2], decodeURIComponent(sending[1]), body)), true;
        const pushed = /^\/api\/git\/([a-z0-9-]{1,32})\/(remote|push)$/.exec(pathname);
        if (pushed && gitReview) return send(200, pushed[2] === 'remote' ? gitReview.setRemote(pushed[1], body) : gitKeeper ? await gitKeeper.send(pushed[1], body) : await gitReview.push(pushed[1], body)), true;
        if (pathname === '/api/shares/cancel' && sharing) { sharing.devices.cancel(body.code); return send(200, { ok: true }), true; }
        const more = /^\/api\/devices\/([0-9a-f-]{36})\/(give|rename)$/.exec(pathname);
        if (more && sharing) {
            if (more[2] === 'rename') { sharing.devices.rename(more[1], body.label); return send(200, { ok: true }), true; }
            const [type, name] = String(body.asset ?? '').split(':');
            const exists = type === 'conversation' ? conversations.list().some((c) => c.name === name) : resources?.list().some((r) => resources.assetOf(r) === body.asset);
            if (!exists) throw new Refusal(404, `There is no such thing to share: ${String(body.asset ?? '')}.`);
            sharing.devices.give(more[1], body.asset, body.rights);
            return send(200, { ok: true }), true;
        }
        const taken = /^\/api\/devices\/([0-9a-f-]{36})\/take$/.exec(pathname);
        if (taken && sharing) { sharing.devices.take(taken[1], body.asset); return send(200, { ok: true }), true; }
        const revoked = /^\/api\/devices\/([0-9a-f-]{36})\/revoke$/.exec(pathname);
        if (revoked && sharing) { sharing.devices.revoke(revoked[1]); return send(200, { ok: true }), true; }
        const unwanted = /^\/api\/shortcuts\/([0-9a-f-]{36})\/remove$/.exec(pathname);
        if (unwanted && shortcuts) { shortcuts.remove(unwanted[1]); return send(200, { ok: true }), true; }
        const attach = /^\/api\/conversations\/([^/]+)\/resources$/.exec(pathname);
        if (attach && resources) {
            const conversation = decodeURIComponent(attach[1]);
            if (!conversations.list().some((c) => c.name === conversation && c.phase === 'ready')) throw new Refusal(404, 'No such conversation, or it is not ready.');
            const name = String(body.resource ?? ''); const access = String(body.access ?? '');
            /* A second writer next to one that sends by itself: confirmed first. */
            if (access === 'write') gitKeeper?.beforeWriter(name, conversation, body.shared === true);
            /* Its automatic sending goes with the write attachment -- forgotten
               BEFORE the change, so that a change that fails half-way (unmounted,
               not mounted again) never leaves settings to come back later. */
            if (access !== 'write') gitKeeper?.forgetAttachment(name, conversation);
            await resources.attach(conversation, name, access);
            retell(conversation);
            return send(200, { ok: true, resources: resources.of(conversation) }), true;
        }
        const moved = /^\/api\/conversations\/([^/]+)\/work$/.exec(pathname);
        if (moved) return send(202, await conversations.moveWork(decodeURIComponent(moved[1]), body.to)), true;
        const machine = /^\/api\/conversations\/([^/]+)\/(restart|machine|health)$/.exec(pathname);
        if (machine) {
            const conversation = decodeURIComponent(machine[1]);
            if (machine[2] === 'health') {
                if (!health || !conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
                return send(200, await health.check(conversation)), true;
            }
            if (machine[2] === 'restart') return send(202, await conversations.restart(conversation)), true;
            return send(202, await conversations.resize(conversation, { memoryMb: body.memoryMb, diskGb: body.diskGb })), true;
        }
        const asking = /^\/api\/conversations\/([^/]+)\/ask-first$/.exec(pathname);
        if (asking) return send(200, conversations.setAskFirst(decodeURIComponent(asking[1]), body.on)), true;
        const resuming = /^\/api\/conversations\/([^/]+)\/resume$/.exec(pathname);
        if (resuming) return send(200, conversations.setResume(decodeURIComponent(resuming[1]), body.on)), true;
        const repairing = /^\/api\/conversations\/([^/]+)\/terminal\/repair$/.exec(pathname);
        if (repairing && repair) {
            const conversation = decodeURIComponent(repairing[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            return send(200, await repair(conversation)), true;
        }
        const again = /^\/api\/conversations\/([^/]+)\/rebuild$/.exec(pathname);
        if (again) return send(202, await conversations.rebuild(decodeURIComponent(again[1]))), true;
        const action = /^\/api\/conversations\/([^/]+)\/(sleep|archive)$/.exec(pathname);
        if (!action) return send(404, { error: 'Not found.' }), true;
        await conversations[action[2]](decodeURIComponent(action[1]));
        if (action[2] === 'archive') resources?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') gitKeeper?.forgetConversation(decodeURIComponent(action[1]));
        if (action[2] === 'archive') sharing?.devices.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') secrets?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') signin?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') answerer?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') wakeups?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') talk?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') guide?.forget(decodeURIComponent(action[1]));
        if (action[2] === 'archive') health?.forget(decodeURIComponent(action[1]));
        return send(200, { ok: true }), true;
    } catch (error) {
        /* A git failure also says which (`kind`), and an fsck id the owner may waive (`offer`). */
        if (error instanceof Refusal) return send(error.status, { error: error.message, ...(error.kind ? { kind: error.kind } : {}), ...(error.offer ? { offer: error.offer } : {}), ...(error.retry ? { retry: true } : {}) }), true;
        return send(500, { error: 'Something failed on the server.' }), true;
    }
}
