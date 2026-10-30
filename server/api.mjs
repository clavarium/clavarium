/* THE FEW THINGS THE PAGE ASKS FOR, as JSON.
 *
 *   GET  /api/tools
 *   GET  /api/conversations
 *                                                each with lists: {lists, waiting} (binders.mjs given) or null
 *   POST /api/conversations                 {name, tool, memoryMb?}
 *   POST /api/conversations/<name>/sleep
 *   POST /api/conversations/<name>/restart       a clean stop (by force if it hangs), then a start
 *   POST /api/conversations/<name>/machine       {memoryMb?, diskGb?, cpus?}: stopped, set, started again (202);
 *                                                asleep: checked and kept for its wake, as `sizeAtWake` (200)
 *   POST /api/conversations/<name>/machine/cancel    the size kept for its wake, given up
 *   GET  /api/conversations/<name>/health        what was last seen of its machine
 *   POST /api/conversations/<name>/health        look now (never wakes a machine)
 *   POST /api/conversations/<name>/health/seen   what it says now no longer calls its owner (Needs you)
 *   POST /api/conversations/<name>/exit-report   why its tool ended: { now (read in its machine, if it runs), last (kept at its end) }
 *   POST /api/conversations/<name>/archive
 *   POST /api/conversations/<name>/ask-first     {on}: its tool asks before acting (true), or acts without asking in its machine (false, the default), from its next start
 *   POST /api/conversations/<name>/resume        {on}: its tool takes up its last session when it starts (true), or starts fresh
 *   POST /api/conversations/<name>/terminal/repair   its terminal does not come though its machine runs: repaired
 *   POST /api/conversations/<name>/talk          {text, answers?, files?, via?}: written in its chat; files from .../talk/file; via 'voice': dictated
 *   POST /api/conversations/<name>/talk/react    {to, reaction}: the owner's reaction to a message of the tool (null: taken back)
 *   POST /api/conversations/<name>/chat-name     {name}: the name the chat gives its tool ('' : the neutral word of the dictionary)
 *   POST /api/conversations/<name>/tasks-binder  {binder}: the binder shown beside its chat ('' automatic, '-' none, else an id)
 *   POST /api/conversations/<name>/voice-mark    {on}: what is dictated into its terminal starts with a microphone sign (AI tools only)
 *   POST /api/conversations/<name>/talk/file?name=<file name>   the body IS a file the person attaches -> {path, name, size}
 *   GET  /api/conversations/<name>/talk?last=|days=|before=|from=|since=   a part of its chat: the newest messages, those of the
 *                                                last days, the page before a message, up to a message found, what changed since a cursor
 *   GET  /api/conversations/<name>/talk/search?q=   its whole chat searched: {matches: [{id, at, from, kind, text}], count}
 *   GET  /api/talk/window                        what a tool reads of its chat after a restart: {ai, default, choices}
 *   POST /api/talk/window                        {ai: 'messages:100'|'messages:200'|'messages:500'|'days:1'|'days:3'|'days:7'}
 *   GET  /api/talk/thread                        what a chat shows of each kind of event: {levels, defaults, choices}
 *   POST /api/talk/thread                        {levels: {kind: 'needs-you'|'news'|'trace'}}: the owner's choice, whole or partial
 *   GET  /api/conversations/<name>/guide         what its tool is told about where it is: the exact texts, the owner's lines
 *   POST /api/conversations/<name>/guide         {lines}: the owner's own lines for it (short, plain text)
 *   POST /api/conversations/<name>/guide/tell    its guide written again, and one line typed in its terminal to read it
 *   POST /api/conversations/<name>/group    {group}: its folder in the list ('' none); first in it
 *   POST /api/conversations/<name>/move     {to: up|down}: one place among those of its folder
 *   POST /api/groups/rename                 {from, to}: for all its conversations
 *   POST /api/groups/move                   {group, to: up|down}
 *   POST /api/order                         {order?, groups?}: the whole order, as a drag and drop leaves it
 *   GET  /api/instance                      {name, defaultName, given}: the name of this Clavarium
 *   POST /api/instance                      {name}: '' for the one drawn from its address
 *   GET  /api/resources
 *   POST /api/resources                     {name} | {name, type: 'git', from?, via?: {method, key?, user?, secret?}}
 *   GET  /api/git-keys                      SSH keys made here: the public half only
 *   POST /api/git-keys                      {name} -> a new key; its private half never leaves the server
 *   POST /api/git-keys/<name>/remove        refused while a repository uses it
 *   GET  /api/git-hosts                     host keys recorded at first contact: {host, type, fingerprint}
 *   POST /api/git-hosts/forget              {host}: the next contact trusts the key it is shown
 *   GET  /api/shelf                         the ready-made machine: date, size, tools, rebuild in progress, last refusal
 *   POST /api/shelf/rebuild                 rebuild it now, in the background (refused when the disk is short)
 *   GET  /api/updates                       Settings, Updates: version, channel, mode, window, what is out, history, what to go back to
 *   POST /api/updates/check                 ask the registry now
 *   POST /api/updates/settings              { mode, channel, window }
 *   POST /api/updates/apply                 { version }: update to the version that is out (in the background)
 *   POST /api/updates/back                  { version }: go back to a release that is kept (in the background)
 *   GET  /api/git/<name>/outgoing?target=<branch>&branch=<branch>   what would go from the agent's branch, to that branch of the remote
 *   GET  /api/git/<name>/graph              the branch diagram: branches and their last commits
 *   GET  /api/git/<name>/commit?id=<sha>    one commit, as a review shows it (&base=<sha>: the commits from base to it)
 *   POST /api/git/<name>/push               {head, target?, sure?}: exactly that reviewed commit, to exactly that branch
 *   GET  /api/git/<name>/keep               origin kept up to date, checks, automatic sending, log
 *   POST /api/git/<name>/keep               {refreshMinutes?, alert?, checkCommand?, checkSeconds?, runHook?, requireForSend?, fsck?}
 *   GET  /api/conversations/<c>/git/<name>/auto   automatic sending for that conversation (attached for writing)
 *   POST /api/conversations/<c>/git/<name>/auto   {branches?, quietSeconds?, perHour?, create?, checks?, sure?}
 *   POST /api/git/<name>/refresh            fetch the origin into its mirror now
 *   POST /api/git/<name>/check              {head, target?}: run the checks in the machine
 *   GET  /api/binder/people                 who may own a record, or be given a list; and the number of changes so far
 *   POST /api/binder                        {op, args}: the owner's change to the lists (binders.mjs), as Binder's keeper answers it
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
 *   POST /api/secrets                       {name, value, expires?}  create or replace; expires YYYY-MM-DD
 *   POST /api/secrets/<NAME>/replace        {value?, expires?}: in place, its name and grants kept; '' removes the expiry
 *   POST /api/secrets/<NAME>/remove
 *   POST /api/secrets/<NAME>/rename         {name}: its value and where it is handed go with it
 *   GET  /api/asset-groups                  the owner's asset groups: [{id, label, members}]
 *   POST /api/asset-groups                  {label}: a new, empty group
 *   POST /api/asset-groups/place            {asset, group}: put an asset in a group (group null to take it out)
 *   POST /api/asset-groups/<id>/rename      {label}
 *   POST /api/asset-groups/<id>/remove
 *   GET  /api/conversations/<name>/health-react   POST the same {on?, message?, command?}: what it does when its machine is short
 *   GET  /api/machines/places   GET /api/machines/moving   POST /api/machines/move {to}: all the machines to another disk
 *   POST /api/machines/forget-old: the copy a move left behind, removed
 *   POST /api/machines/grow {mount}: room set aside and unused, given to that file system
 *   GET  /api/machines/disks: every disk, whole   POST /api/machines/mount {path}   POST /api/machines/prepare {path, typed}: erased
 *   GET  /api/wifi: this server's Wi-Fi   GET /api/wifi/scan: the networks it sees (looked for again)
 *   POST /api/wifi/join {ssid, password}: the switch started, back by itself if it does not work
 *   POST /api/wifi/forget {ssid}: a kept network deleted (never the one in use)
 *   POST /api/wifi/handover: the network handed over to NetworkManager (back as it was if it does not work)
 *   GET  /api/meshcentral: the remote screen (MeshCentral); POST /api/meshcentral/enable (turned on, in the background) /disable
 *   GET  /api/events?kind=&conversation=&q=&before=&limit=   what happened, newest first
 *   GET  /api/history?of=server|<name>&span=1h|24h|7d   the curves of memory, CPU and disk (and the reserve, for the server)
 *   GET  /api/history/all?span=1h|24h|7d    Settings, Usage: the server and every machine (asleep too) on one time axis,
 *                                           in GB and cores: {t, capacity, server, itself, machines: [{name, alloc, asleep, ...}]}
 *   GET  /api/server/logs?source=&span=    what the server's programs said   POST /api/server/restart
 *   GET  /api/operators                     who may sign in   POST /api/operators {email} -> {email, password}: shown once
 *   POST /api/operators/<email>/password -> {email, password}   POST /api/operators/<email>/disable|enable|remove
 *   POST /api/conversations/<name>/secrets  {secret, attached}
 *   GET  /api/shortcuts
 *   POST /api/shortcuts                     {label, text, enter}
 *   POST /api/shortcuts/<id>/remove
 *   GET  /api/voice                         is dictation available?
 *   POST /api/voice?lang=                   the body IS a WAV recording -> {text}; lang: the device's language
 *   GET  /api/dictation                     the engine chosen in Settings (never a key: a secret's name)
 *   POST /api/dictation                     {provider, url, model, secret, language}: chosen, at once
 *   POST /api/dictation/off                 the environment's engine, if any, again
 *   POST /api/dictation/try?provider=&url=&model=&secret=&language=&lang=   a WAV -> {text}, nothing saved
 *   GET  /api/files?c=<conversation>&r=<resource>&p=<path>          a listing
 *   GET  /api/flows                         who gets what: devices, conversations, assets, the rights between them, the flows
 *   POST /api/flows/name                    {around, name}: a flow named by the owner ('' gives it back its own)
 *   POST /api/setup/export                  {flow?} -> {name, text}: the configuration as one file, never the data
 *   POST /api/setup/preview                 {text, choices?}: what an import would do, said before anything is done
 *   POST /api/setup/import                  {text, choices?, bundle?}: made in the background; GET says how far it is
 *   GET  /api/setup/bundle?flow=            the flow WITH the files of its folders, a .tar.gz (bundle.mjs)   &stats=1: their sizes only
 *   POST /api/setup/bundle                  the body IS such a file -> {id, text, folders}: then preview and import with {bundle: id}
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
import { Refusal, DISK_GB } from './conversations.mjs';
import { VmUnknown } from './vm.mjs';
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
/* This run of the server: a page's count of binder changes is of one run, and starts again with the next. */
const BOOT = Math.random().toString(36).slice(2, 10);

export async function handleApi(request, response, conversations, headers, resources, originOk = sameOrigin, shortcuts, voice, sharing, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, repair, guide, capacity, updates, instance, certificate, team, reacting, machinesMove, serverLogs, history, events, bundles, wifi, binders, meshcentral, tethers, accounts, groups) {
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (!pathname.startsWith('/api/')) return false;
    let send = (status, body) => {
        response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    };
    /* Files are reached THROUGH a conversation: only a folder attached to it,
       and writing only where the attachment says "write". */
    const query = new URL(request.url ?? '/', 'http://local').searchParams;
    /* Who asks (behind the edge; '' on this machine alone): see gate.mjs. */
    const identity = String(request.headers['x-forwarded-email'] ?? '').trim().toLowerCase();
    /* A sign-in, said once in a while for the same person (events.mjs). */
    events?.seen(identity);
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
        if (request.method === 'GET' && pathname === '/api/voice') return send(200, { available: voice?.current() !== undefined, engine: voice?.model ?? null }), true;
        if (request.method === 'GET' && pathname === '/api/dictation' && voice) return send(200, voice.about()), true;
        if (request.method === 'POST' && (pathname === '/api/voice' || (pathname === '/api/dictation/try' && voice))) {
            if (!originOk(request.headers) || request.headers['content-type'] !== 'audio/wav') {
                return send(403, { error: 'This request does not come from this site.' }), true;
            }
            const parts = []; let size = 0;
            for await (const chunk of request) { size += chunk.length; if (size > AUDIO_MAX) throw new Refusal(413, 'The recording is too long.'); parts.push(chunk); }
            const audio = Buffer.concat(parts);
            /* "Try it": the choice in the form, in the address's parameters (no key in it: a secret's name). */
            /* `lang`: the language of the device that dictates (voice.mjs, languageOf). */
            if (pathname === '/api/dictation/try') return send(200, { text: await voice.try(Object.fromEntries(query), audio, query.get('lang') ?? undefined) }), true;
            return send(200, { text: voice ? await voice.transcribe(audio, query.get('lang') ?? undefined) : await transcribe(undefined, audio) }), true;
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
                const lists = binders?.given() ?? {};
                return send(200, conversations.list().map((c) => ({ ...c, lists: lists[c.name] ?? null, resources: resources?.of(c.name) ?? [], secrets: secrets?.of(c.name) ?? [], ephemeralSecrets: secrets?.liveFor(c.name) ?? [], answerer: answerer?.of(c.name) ?? null, wakeups: wakeups?.of(c.name) ?? null, health: health?.of(c.name) ?? null, talk: talk?.brief(c.name) ?? null }))), true;
            }
            if (pathname === '/api/resources' && resources) return send(200, resources.list()), true;
            if (pathname === '/api/shortcuts' && shortcuts) return send(200, shortcuts.list()), true;
            if (pathname === '/api/secrets' && secrets) return send(200, secrets.list()), true;
            /* The owner's asset groups (groups.mjs): a label and the asset ids each
               holds. Distinct from /api/groups/* above, which are the conversation
               list's folders. */
            if (pathname === '/api/asset-groups' && groups) return send(200, groups.list()), true;
            if (pathname === '/api/mailboxes' && mailboxes) return send(200, mailboxes.list()), true;
            /* Which providers and kinds an account can be connected for here. */
            if (pathname === '/api/accounts' && accounts) return send(200, { supported: accounts.supported() }), true;
            /* Assets > Access: the targets, who was given each at which level, the
               calls waiting, and the recent journal -- all the page needs to read. */
            if (pathname === '/api/tether' && tethers) { const r = await tethers.act('state', { agent: query.get('agent') ?? undefined }, ''); return send(200, { given: tethers.given(), changes: tethers.changes(), ...(r.data ?? {}) }), true; }
            /* Every device, each with all it was given. */
            if (pathname === '/api/devices' && sharing) return send(200, sharing.devices.all()), true;
            if (pathname === '/api/git-keys' && gitAccess) return send(200, gitAccess.keys()), true;
            if (pathname === '/api/git-hosts' && gitAccess) return send(200, gitAccess.hosts()), true;
            if (pathname === '/api/platform' && platform) return send(200, platform), true;
            if (pathname === '/api/instance' && instance) return send(200, instance.about()), true;
            if (pathname === '/api/shelf' && shelf) return send(200, shelf.about()), true;
            /* Settings, Updates (updates.mjs): what runs, what is out, the mode, what happened. */
            if (pathname === '/api/updates' && updates) return send(200, updates.about()), true;
            /* Who may sign in (operators.mjs): none in local mode. */
            const reactOf = /^\/api\/conversations\/([^/]+)\/health-react$/.exec(pathname);
            if (reactOf && reacting) return send(200, reacting.settings(decodeURIComponent(reactOf[1]))), true;
            if (pathname === '/api/events' && events) {
                const ask = { kind: query.get('kind') ?? '', conversation: query.get('conversation') ?? '', q: query.get('q') ?? '', before: query.get('before') ?? '', limit: Math.min(1000, Number(query.get('limit')) || 200) };
                const said = events.list(ask);
                /* What the updater did is in its own history (updates.mjs): said here too, as it said it. */
                const words = { done: 'done', failed: 'failed', 'rolled-back': 'did not work: went back' };
                const updated = !ask.conversation && (!ask.kind || ask.kind === 'update') ? (updates?.about().history ?? []).map((h) => ({ at: h.at, kind: 'update', text: `${h.action === 'rollback' ? 'Back' : 'Update'} ${h.from ?? '?'} → ${h.to ?? '?'}: ${words[h.result] ?? h.result ?? ''}${h.why ? ` (${h.why})` : ''}` }))
                    .filter((e) => e.at && (!ask.before || e.at < ask.before) && (!ask.q || e.text.toLowerCase().includes(ask.q.toLowerCase()))) : [];
                return send(200, [...said, ...updated].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ask.limit)), true;
            }
            if (pathname === '/api/history' && history) {
                const of = query.get('of') ?? 'server';
                if (of !== 'server' && !conversations.list().some((c) => c.name === of)) throw new Refusal(404, 'No such conversation.');
                const curves = history.series(of, query.get('span') ?? '1h');
                /* The reserve as a level of the curve: where what is used meets what must stay free. */
                if (of === 'server' && capacity) {
                    const a = await capacity.about().catch(() => null);
                    const disk = a?.disk ?? a?.disks?.find?.((d) => d.holds?.includes('machines'));
                    curves.reserve = {
                        memory: a?.memory?.totalMb ? Math.max(0, 100 - (a.reserve.memoryMb / a.memory.totalMb) * 100) : null,
                        disk: disk?.sizeMb ? Math.max(0, 100 - (a.reserve.diskMb / disk.sizeMb) * 100) : null,
                    };
                }
                return send(200, curves), true;
            }
            if (pathname === '/api/history/all' && history) {
                const a = capacity ? await capacity.about().catch(() => null) : null;
                const room = capacity ? await capacity.room().catch(() => null) : null;
                /* What each machine's disk takes on this server, measured now and then (known asleep too). */
                const held = new Map((a?.usage?.machines?.each ?? []).map((x) => [x.name, x.mb]));
                const machines = conversations.list().filter((c) => ['ready', 'restarting', 'moving'].includes(c.phase)).map((c) => ({
                    name: c.name, memoryMb: c.memoryMb, cores: c.cpus ?? 1, asleep: c.asleep === true,
                    /* Its disk as its machine sees it when known, else the size it was given. */
                    diskMb: health?.of(c.name)?.disks?.['/']?.sizeMb ?? (c.diskGb ?? DISK_GB) * 1024, hostDiskMb: held.get(c.name),
                }));
                return send(200, history.together(query.get('span') ?? '1h', machines, { memoryMb: a?.memory?.totalMb, cores: room?.cpu?.cores, diskMb: a?.disk?.sizeMb })), true;
            }
            if (pathname === '/api/server/logs' && serverLogs) return send(200, await serverLogs.read(query.get('source') ?? 'clavarium', query.get('span') ?? '1')), true;
            if (pathname === '/api/machines/disks' && machinesMove) return send(200, await machinesMove.disks()), true;
            if (pathname === '/api/machines/places' && machinesMove) return send(200, await machinesMove.places()), true;
            if (pathname === '/api/machines/moving' && machinesMove) return send(200, await machinesMove.moving()), true;
            if (pathname === '/api/wifi' && wifi) return send(200, await wifi.status()), true;
            if (pathname === '/api/wifi/scan' && wifi) return send(200, await wifi.scan()), true;
            if (pathname === '/api/meshcentral' && meshcentral) return send(200, await meshcentral.status()), true;
            if (pathname === '/api/operators') return send(200, team ? { operators: team.list(), me: identity } : { local: true }), true;
            if (pathname === '/api/binder/people' && binders) return send(200, { people: binders.people(identity), changes: `${BOOT}:${binders.changes()}` }), true;
            if (pathname === '/api/certificate' && certificate) return send(200, await certificate.about({ fresh: query.get('fresh') === '1' })), true;
            /* This server's disk and memory (capacity.mjs): everything for Settings; only whether it is high for the list. */
            if (pathname === '/api/server' && capacity) return send(200, await capacity.about()), true;
            if (pathname === '/api/server/brief' && capacity) return send(200, { ...(await capacity.brief()), machines: platform?.machines ?? true }), true;
            if (pathname === '/api/alerts' && alerts) return send(200, alerts.about()), true;
            if (pathname === '/api/flows' && setup) return send(200, setup.graph()), true;
            if (pathname === '/api/setup/import' && setup) return send(200, setup.job()), true;
            if (pathname === '/api/setup/bundle' && setup && bundles) {
                const flow = query.get('flow') || undefined;
                const made = setup.exportText({ flow });
                const folders = JSON.parse(made.text).nodes.filter((n) => n.kind === 'folder').map((n) => n.name);
                if (query.get('stats') === '1') return send(200, { name: made.name, folders: bundles.folderStats(folders) }), true;
                const file = `${(made.name || 'setup').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'setup'}.clavarium.tar.gz`;
                response.writeHead(200, { ...headers, 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${file}"` });
                await bundles.pack(made.text, folders, response).catch((error) => { console.error(`bundle: ${error.message}`); response.destroy(); });
                return true;
            }
            const looked = /^\/api\/conversations\/([^/]+)\/health$/.exec(pathname);
            if (looked && health) return send(200, health.of(decodeURIComponent(looked[1]))), true;
            /* The words of the chat screen, for a screen whose language is `lang`; and the owner's choice of them. */
            if (pathname === '/api/talk/words' && talk) return send(200, talk.words(query.get('lang') ?? 'en')), true;
            if (pathname === '/api/talk/settings' && talk) return send(200, talk.settings()), true;
            if (pathname === '/api/talk/thread' && talk) return send(200, talk.thread()), true;
            if (pathname === '/api/talk/window' && talk) return send(200, talk.window()), true;
            const searched = /^\/api\/conversations\/([^/]+)\/talk\/search$/.exec(pathname);
            if (searched && talk) return send(200, talk.search(decodeURIComponent(searched[1]), query.get('q') ?? '')), true;
            const guided = /^\/api\/conversations\/([^/]+)\/guide$/.exec(pathname);
            if (guided && guide) return send(200, guide.about(decodeURIComponent(guided[1]))), true;
            const talked = /^\/api\/conversations\/([^/]+)\/talk$/.exec(pathname);
            if (talked && talk) return send(200, talk.of(decodeURIComponent(talked[1]), query)), true;
            /* Its docket: the reminders its tool set, the newest events (dockets.mjs). */
            const docketRead = /^\/api\/conversations\/([^/]+)\/docket$/.exec(pathname);
            if (docketRead && wakeups) return send(200, wakeups.docketOf(decodeURIComponent(docketRead[1]))), true;
            const answered = /^\/api\/conversations\/([^/]+)\/answerer\/log$/.exec(pathname);
            if (answered && answerer) return send(200, answerer.log(decodeURIComponent(answered[1]))), true;
            /* A repository: where its commits go, and what would go now. */
            const repo = /^\/api\/git\/([a-z0-9-]{1,32})(\/outgoing|\/keep)?$/.exec(pathname);
            const drawn = /^\/api\/git\/([a-z0-9-]{1,32})\/(graph|commit)$/.exec(pathname);
            if (drawn && gitReview) return send(200, drawn[2] === 'graph' ? await gitReview.graph(drawn[1]) : await gitReview.commit(drawn[1], query.get('id'), query.get('base'))), true;
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
        /* A flow with its files, sent from the page: the body is the .tar.gz. */
        if (pathname === '/api/setup/bundle' && setup && bundles) {
            if (!originOk(request.headers) || request.headers['content-type'] !== 'application/octet-stream') return send(403, { error: 'This request does not come from this site.' }), true;
            const got = await bundles.receive(request);
            try { return send(200, { id: got.id, bytes: got.bytes, ...bundles.open(got.id) }), true; } catch (error) { bundles.forget(got.id); throw error; }
        }
        if (!originOk(request.headers) || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
            return send(403, { error: 'This request does not come from this site.' }), true;
        }
        const body = await readBody(request, pathname === '/api/setup/preview' || pathname === '/api/setup/import' ? SETUP_BODY_MAX : BODY_MAX);
        /* What was done, once it was done: said in What happened (events.mjs), for those worth saying. */
        if (events) { const answer = send; send = (status, out) => { if (status < 300) { try { events.fromRequest(pathname, body, identity, out); } catch { /* never in the way */ } } answer(status, out); }; }
        if (pathname === '/api/conversations') { await conversations.admit?.(body); return send(201, conversations.create(body)), true; }
        /* The lists: every answer is 200, a refusal said in it ({ ok: false, text }), as the keeper says it to a tool. */
        if (pathname === '/api/binder' && binders) return send(200, binders.act(body.op, body.args, identity)), true;
        /* Who gets what, and a whole setup in one file: see setup.mjs. */
        if (pathname.startsWith('/api/setup/') || pathname === '/api/flows/name') {
            if (!setup) return send(404, { error: 'Not found.' }), true;
            const choices = body.choices && typeof body.choices === 'object' ? body.choices : {};
            if (pathname === '/api/flows/name') return send(200, setup.rename(body.around, body.name)), true;
            if (pathname === '/api/setup/export') return send(200, setup.exportText({ flow: typeof body.flow === 'string' ? body.flow : undefined })), true;
            if (pathname === '/api/setup/preview') return send(200, setup.preview(body.text, choices)), true;
            if (pathname === '/api/setup/import') {
                /* With the files of a flow sent before: each new folder gets its own, then the file sent goes. */
                const id = typeof body.bundle === 'string' ? body.bundle : null;
                const fill = id && bundles && resources ? (fileName, name) => bundles.fill(id, fileName, resources.folder(name)) : null;
                const started = setup.start(body.text, choices, { fill });
                if (id) void setup.done?.finally(() => bundles.forget(id));
                return send(202, started), true;
            }
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
        if (pathname === '/api/updates/check' && updates) return send(200, await updates.check()), true;
        if (pathname === '/api/updates/settings' && updates) return send(200, await updates.settings({ mode: body.mode, channel: body.channel, window: body.window })), true;
        if (pathname === '/api/updates/apply' && updates) return send(202, await updates.apply(body.version)), true;
        if (pathname === '/api/updates/back' && updates) return send(202, await updates.back(body.version)), true;
        if (pathname === '/api/server/reserve' && capacity) { capacity.setReserve({ diskMb: body.diskMb, diskPercent: body.diskPercent, memoryMb: body.memoryMb, memoryPercent: body.memoryPercent }); return send(200, await capacity.about()), true; }
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
        if (pathname === '/api/mailboxes/consent' && mailboxes) return send(200, mailboxes.consent(body)), true;
        if (pathname === '/api/mailboxes/connect' && mailboxes) { const made = await mailboxes.connect(body); void setup?.assetAdded(made.name).catch(() => {}); return send(201, made), true; }
        const fetched = /^\/api\/mailboxes\/([a-z0-9-]{1,32})\/sync$/.exec(pathname);
        if (fetched && mailboxes) return send(200, await mailboxes.sync(fetched[1])), true;
        /* Connecting an account by token (consent in the owner's browser, the token
           kept host-only, a Tether target made): see accounts.mjs. */
        if (pathname === '/api/accounts/consent' && accounts) return send(200, accounts.consent(body)), true;
        if (pathname === '/api/accounts/connect' && accounts) { const made = await accounts.connect(body); return send(201, made), true; }
        if (pathname === '/api/accounts/lookup' && accounts) return send(200, await accounts.lookup(body)), true;
        if (pathname === '/api/accounts/classic' && accounts) { const made = await accounts.classic(body); return send(201, made), true; }
        if (pathname === '/api/accounts/verify' && accounts) { const r = await accounts.verify(body); return send(200, r), true; }
        /* Assets > Access: the owner sets a conversation's level and rules on a
           target, decides a call that waited, or removes a target. Each is an op the
           keeper runs as the owner (person), never as an agent. */
        const tetherOp = /^\/api\/tether\/(level|allow|unallow|decide|remove-target|stop|resume)$/.exec(pathname);
        if (tetherOp && tethers) { const r = await tethers.act(tetherOp[1], body, ''); if (!r.ok) throw new Refusal(400, r.text); return send(200, r.data ?? { ok: true }), true; }
        /* A mailbox's signature (Markdown), added under what the agent sends from it. */
        if (pathname === '/api/tether/signature' && tethers) {
            const t = tethers.store().target(String(body.target ?? ''));
            if (!t || t.kind !== 'mail') throw new Refusal(404, 'No such mailbox.');
            const signature = String(body.signature ?? '').replace(/\r\n?/g, '\n').trim();
            if (signature.length > 2000) throw new Refusal(400, 'A signature is 2000 characters at most.');
            const { signature: _old, ...config } = t.config ?? {};
            tethers.store().putTarget({ ...t, config: signature ? { ...config, signature } : config });
            return send(200, { ok: true, signature }), true;
        }
        if (pathname === '/api/shortcuts' && shortcuts) return send(201, shortcuts.add(body)), true;
        if (pathname === '/api/secrets' && secrets) { const made = secrets.set(body); setup?.secretAdded(made.name); return send(201, made), true; }
        /* Asset groups (groups.mjs): a folder-style tidy-up, not a right. */
        if (pathname === '/api/asset-groups' && groups) return send(201, groups.create(body.label)), true;
        if (pathname === '/api/asset-groups/place' && groups) return send(200, groups.place(body.asset, body.group ?? null)), true;
        const groupOp = /^\/api\/asset-groups\/([0-9a-f]{12})\/(rename|remove)$/.exec(pathname);
        if (groupOp && groups) {
            if (groupOp[2] === 'rename') return send(200, groups.rename(groupOp[1], body.label)), true;
            return groups.remove(groupOp[1]), send(200, { ok: true }), true;
        }
        const reactSet = /^\/api\/conversations\/([^/]+)\/health-react$/.exec(pathname);
        if (reactSet && reacting) { const n = decodeURIComponent(reactSet[1]); if (!conversations.list().some((c) => c.name === n)) throw new Refusal(404, 'No such conversation.'); return send(200, reacting.set(n, body)), true; }
        if (pathname === '/api/machines/move' && machinesMove) return send(202, await machinesMove.move(String(body.to ?? ''))), true;
        if (pathname === '/api/server/restart' && serverLogs) return send(202, await serverLogs.restart()), true;
        if (pathname === '/api/machines/grow' && machinesMove) return send(200, await machinesMove.grow(String(body.mount ?? ''))), true;
        if (pathname === '/api/machines/mount' && machinesMove) return send(200, await machinesMove.mount(String(body.path ?? ''))), true;
        if (pathname === '/api/machines/prepare' && machinesMove) return send(200, await machinesMove.prepare(String(body.path ?? ''), body.typed)), true;
        if (pathname === '/api/machines/forget-old' && machinesMove) return send(200, await machinesMove.forgetOld()), true;
        /* The password goes on to the host program and nowhere else: not in an answer, not in What happened. */
        if (pathname === '/api/wifi/join' && wifi) return send(202, await wifi.join(body.ssid, body.password ?? '')), true;
        if (pathname === '/api/wifi/forget' && wifi) return send(200, await wifi.forget(body.ssid)), true;
        if (pathname === '/api/wifi/handover' && wifi) return send(202, await wifi.handover()), true;
        if (pathname === '/api/meshcentral/enable' && meshcentral) return send(202, await meshcentral.enable()), true;
        if (pathname === '/api/meshcentral/disable' && meshcentral) return send(200, await meshcentral.disable()), true;
        if (pathname === '/api/operators' && team) return send(201, await team.add(body.email)), true;
        const op = /^\/api\/operators\/([^/]{3,200})\/(password|disable|enable|remove)$/.exec(pathname);
        if (op && team) {
            const email = decodeURIComponent(op[1]);
            /* Not oneself out: another operator does it, or nobody would see it was a mistake. */
            if (op[2] !== 'password' && op[2] !== 'enable' && email.toLowerCase() === identity) throw new Refusal(409, 'You cannot do that to your own account: ask another operator.');
            return send(200, op[2] === 'password' ? await team.password(email) : { operators: await team[op[2]](email) }), true;
        }
        const renaming = /^\/api\/secrets\/([A-Z][A-Z0-9_]{0,39})\/rename$/.exec(pathname);
        if (renaming && secrets) return send(200, secrets.rename(renaming[1], String(body.name ?? '').trim())), true;
        /* A new value (never sent back) and/or a new expiry, in place. */
        const replacing = /^\/api\/secrets\/([A-Z][A-Z0-9_]{0,39})\/replace$/.exec(pathname);
        if (replacing && secrets) return send(200, secrets.replace(replacing[1], { value: body.value, expires: body.expires })), true;
        const dropped = /^\/api\/secrets\/([A-Z][A-Z0-9_]{0,39})\/remove$/.exec(pathname);
        if (dropped && secrets) { secrets.remove(dropped[1]); return send(200, { ok: true }), true; }
        if (pathname === '/api/alerts' && alerts) return send(201, alerts.add(body.subscription, body.label)), true;
        if (pathname === '/api/alerts/remove' && alerts) return send(200, alerts.remove(String(body.endpoint ?? ''))), true;
        if (pathname === '/api/alerts/test' && alerts) return send(200, { reached: await alerts.tell({ title: instance?.name() ?? 'Clavarium', body: 'This is what an alert looks like.', url: '/' }) }), true;
        if (pathname === '/api/talk/settings' && talk) return send(200, talk.setWords({ lang: body.lang, own: body.own })), true;
        if (pathname === '/api/talk/thread' && talk) return send(200, talk.setThread({ levels: body.levels })), true;
        if (pathname === '/api/talk/window' && talk) return send(200, talk.setWindow({ ai: body.ai })), true;
        const guiding = /^\/api\/conversations\/([^/]+)\/guide(\/tell)?$/.exec(pathname);
        if (guiding && guide) {
            const conversation = decodeURIComponent(guiding[1]);
            if (guiding[2]) return send(200, await guide.tellAgain(conversation)), true;
            return send(200, await guide.setLines(conversation, body.lines)), true;
        }
        /* A setting its tool is told about changed: its guide follows (never waking a machine). */
        const retell = (conversation) => { void guide?.changed(conversation).catch(() => {}); };
        const talking = /^\/api\/conversations\/([^/]+)\/talk(\/invite|\/remind|\/react)?$/.exec(pathname);
        if (talking && talk) {
            const conversation = decodeURIComponent(talking[1]);
            if (talking[2] === '/invite') return send(200, await talk.invite(conversation, typeof body.lang === 'string' ? body.lang : 'en')), true;
            if (talking[2] === '/remind') return send(200, await talk.remind(conversation)), true;
            if (talking[2] === '/react') return send(200, await talk.react(conversation, body.to, body.reaction ?? null)), true;
            if (typeof body.on === 'boolean') { const now = await talk.set(conversation, body.on); retell(conversation); return send(200, now), true; }
            /* What the chat may add to an answer: the choices ticked, the answers of a group, the zone of a picture it is about (Parley checks each). */
            return send(201, await talk.say(conversation, body.text, body.answers, body.files, body.via, { picked: body.picked, replies: body.replies, about: body.about })), true;
        }
        const docketed = /^\/api\/conversations\/([^/]+)\/docket(\/cancel)?$/.exec(pathname);
        if (docketed && wakeups) {
            const conversation = decodeURIComponent(docketed[1]);
            if (docketed[2]) return send(200, wakeups.cancelReminder(conversation, body.plan)), true;
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
            /* A machine that runs gets it (or loses it) now, in /run/secrets -- not only at the next
               opening of a terminal; its tool's variables still wait for the tool's next start. */
            const c = conversations.list().find((x) => x.name === conversation);
            if (c?.phase === 'ready' && !c.asleep) await secrets.deliver(conversation).catch(() => {});
            retell(conversation);
            return send(200, { ok: true, secrets: secrets.of(conversation) }), true;
        }
        /* Forget an ephemeral secret now (its stars in the chat have a button): gone from the vault and the machine. */
        const forgetSecret = /^\/api\/conversations\/([^/]+)\/secrets\/([^/]+)\/forget$/.exec(pathname);
        if (forgetSecret && secrets) {
            const conversation = decodeURIComponent(forgetSecret[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            await secrets.drop(conversation, decodeURIComponent(forgetSecret[2]));
            return send(200, { ok: true }), true;
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
            return send(200, body?.again === true ? await gitKeeper.checkAgain(kept[1], body) : await gitKeeper.check(kept[1], body)), true;
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
        /* Why its tool ended: read now in its machine when it runs, else the last kept at its end. */
        const exitOf = /^\/api\/conversations\/([^/]+)\/exit-report$/.exec(pathname);
        if (exitOf) {
            const conversation = decodeURIComponent(exitOf[1]);
            const c = conversations.list().find((x) => x.name === conversation);
            if (!c) throw new Refusal(404, 'No such conversation.');
            const now = await conversations.exitReport(conversation).catch(() => null);
            return send(200, { now, last: c.lastExit ?? null }), true;
        }
        /* "Seen": what its machine says now no longer calls its owner (health.mjs). */
        const seenOf = /^\/api\/conversations\/([^/]+)\/health\/seen$/.exec(pathname);
        if (seenOf && health) {
            const conversation = decodeURIComponent(seenOf[1]);
            if (!conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
            return send(200, health.markSeen(conversation)), true;
        }
        const machine = /^\/api\/conversations\/([^/]+)\/(restart|machine|health)$/.exec(pathname);
        if (machine) {
            const conversation = decodeURIComponent(machine[1]);
            if (machine[2] === 'health') {
                if (!health || !conversations.list().some((c) => c.name === conversation)) throw new Refusal(404, 'No such conversation.');
                await health.check(conversation, { asked: true }); return send(200, health.of(conversation)), true;
            }
            if (machine[2] === 'restart') return send(202, await conversations.restart(conversation)), true;
            const resized = await conversations.resize(conversation, { memoryMb: body.memoryMb, diskGb: body.diskGb, cpus: body.cpus });
            /* Asleep, nothing was started: the choice is only kept, for its wake. */
            return send(resized.phase === 'restarting' ? 202 : 200, resized), true;
        }
        const later = /^\/api\/conversations\/([^/]+)\/machine\/cancel$/.exec(pathname);
        if (later) return send(200, conversations.cancelResize(decodeURIComponent(later[1]))), true;
        const asking = /^\/api\/conversations\/([^/]+)\/ask-first$/.exec(pathname);
        if (asking) return send(200, conversations.setAskFirst(decodeURIComponent(asking[1]), body.on)), true;
        const naming = /^\/api\/conversations\/([^/]+)\/chat-name$/.exec(pathname);
        if (naming) return send(200, conversations.setChatName(decodeURIComponent(naming[1]), body.name)), true;
        const beside = /^\/api\/conversations\/([^/]+)\/tasks-binder$/.exec(pathname);
        if (beside) return send(200, conversations.setTasksBinder(decodeURIComponent(beside[1]), body.binder)), true;
        /* The list: folders and order, the same on every device (conversations.mjs). */
        if (pathname === '/api/instance' && instance) return send(200, instance.setName(body.name)), true;
        if (pathname === '/api/dictation' && voice) return send(200, voice.set(body)), true;
        if (pathname === '/api/dictation/off' && voice) return send(200, voice.off()), true;
        if (pathname === '/api/order') return send(200, conversations.setOrder({ order: body.order, groups: body.groups })), true;
        if (pathname === '/api/groups/rename') return send(200, conversations.renameGroup(body.from, body.to)), true;
        if (pathname === '/api/groups/move') return send(200, conversations.moveGroup(body.group, body.to)), true;
        const grouping = /^\/api\/conversations\/([^/]+)\/(group|move)$/.exec(pathname);
        if (grouping) return send(200, grouping[2] === 'group' ? conversations.setGroup(decodeURIComponent(grouping[1]), body.group) : conversations.move(decodeURIComponent(grouping[1]), body.to)), true;
        const titling = /^\/api\/conversations\/([^/]+)\/title$/.exec(pathname);
        if (titling) return send(200, conversations.setTitle(decodeURIComponent(titling[1]), body.title)), true;
        const hiding = /^\/api\/conversations\/([^/]+)\/hidden$/.exec(pathname);
        if (hiding) return send(200, conversations.setHidden(decodeURIComponent(hiding[1]), body.on)), true;
        const marking = /^\/api\/conversations\/([^/]+)\/voice-mark$/.exec(pathname);
        if (marking) return send(200, conversations.setVoiceMark(decodeURIComponent(marking[1]), body.on)), true;
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
        if (error instanceof Refusal || error instanceof VmUnknown) return send(error.status, { error: error.message, ...(error.kind ? { kind: error.kind } : {}), ...(error.offer ? { offer: error.offer } : {}), ...(error.retry ? { retry: true } : {}) }), true;
        return send(500, { error: 'Something failed on the server.' }), true;
    }
}
