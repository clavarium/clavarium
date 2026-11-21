/* WHAT AN AI SHOWS IN A ROOM, through the API (06-11): GET /api/rooms/<id>/shown opens a file an AI of the room cited
   there, read from ITS conversation's folders (its work folder, a folder attached to it) -- never another
   conversation's; GET /api/rooms/<id>/mail/open opens a mail it cited, as its conversation's chat would, and says
   which conversation (x-mail-of: Reply writes in that chat). Mails of example.com only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from '../server/api.mjs';
import { Rooms } from '../server/rooms.mjs';
import { JsonFile } from '../server/store.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MAIL = 'Message-ID: <quote-1@example.com>\r\nFrom: Ann <ann@example.com>\r\nSubject: Quote\r\n\r\nHello\r\n';
const REF = 'mail:work-mail/quote-1%40example.com?in=INBOX&uid=7';

/* The API's arguments by name, the rest undefined. */
const PARAMS = /^async function handleApi\(([^)]*)\)/.exec(handleApi.toString())[1].split(',').map((p) => p.trim().split('=')[0].trim());
async function get(path, given) {
    const request = Object.assign(Readable.from([]), { method: 'GET', url: path, headers: {} });
    const out = { status: 0, headers: {}, chunks: [] };
    const response = new (await import('node:stream')).Writable({ write(c, e, done) { out.chunks.push(Buffer.from(c)); done(); } });
    response.writeHead = (s, h) => { out.status = s; out.headers = h ?? {}; return response; };
    const ended = new Promise((done) => response.on('finish', done));
    await handleApi(...PARAMS.map((n) => (n === 'request' ? request : n === 'response' ? response : n === 'originOk' ? () => true : n === 'headers' ? {} : given[n])));
    await ended;
    return { status: out.status, headers: out.headers, body: Buffer.concat(out.chunks) };
}

function world(t) {
    const dir = mkdtempSync(join(tmpdir(), 'api-roomshow-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const work = { hugo: join(dir, 'work-hugo'), compta: join(dir, 'work-compta') };
    for (const w of Object.values(work)) mkdirSync(join(w, 'out'), { recursive: true });
    writeFileSync(join(work.hugo, 'out', 'report.html'), '<p>hugo</p>');
    writeFileSync(join(work.hugo, 'out', 'plan.png'), PNG);
    writeFileSync(join(work.compta, 'out', 'secret.txt'), 'compta only');
    mkdirSync(join(dir, 'shared')); writeFileSync(join(dir, 'shared', 'notes.txt'), 'shared notes');
    const list = [{ name: 'hugo', work: 'kept' }, { name: 'compta', work: 'kept' }];
    const conversations = { list: () => list };
    const attachedTo = { hugo: ['shared'], compta: [] };
    const resources = { workFolder: (name) => work[name], of: (name) => (attachedTo[name] ?? []).map((n) => ({ name: n, access: 'read' })), folder: (n) => join(dir, n), get: () => null };
    /* As talk: a path of its own reached as its chat does; its chat has what its agent cited. */
    const reach = (name, path) => { if (path.startsWith('/work/')) return `work:${path.slice(6)}`; const m = /^\/resources\/([a-z]+)\/(.+)$/.exec(path); return m && attachedTo[name].includes(m[1]) ? `${m[1]}:${m[2]}` : null; };
    const chats = new Map([['hugo', new Set()], ['compta', new Set()]]);
    const rooms = new Rooms({ file: new JsonFile(join(dir, 'rooms.json'), []), dir: join(dir, 'rooms'), say: async () => {}, conversations: () => list, reach, shown: (name, ref) => chats.get(name)?.has(ref) === true });
    const answer = (name, roomId, text) => { for (const p of text.match(/\/(work|resources)\/[^\s)]+/g) ?? []) { const o = reach(name, p.replace(/[.,;:!?]+$/, '')); if (o) chats.get(name).add(o); } return rooms.answered(name, { room: roomId, text }); };
    const asked = [];
    const tethers = { store: () => ({ target: (id) => (id === 'work-mail' ? { id, kind: 'mail', title: 'Work mailbox' } : null), targets: () => [] }),
        read: async (verb, a, who) => { asked.push({ verb, a, who }); return { ok: true, data: { raw: Buffer.from(MAIL), folder: 'INBOX', ref: a.ref } }; } };
    return { rooms, answer, given: { conversations, resources, rooms, tethers }, asked };
}

test('a file an AI showed in a room opens through its conversation: its bytes, its picture; another conversation\'s refused', async (t) => {
    const { rooms, answer, given } = world(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'] });
    const hugo = r.members.find((m) => m.ref === 'hugo'); const compta = r.members.find((m) => m.ref === 'compta');
    answer('hugo', r.id, 'Voici /work/out/report.html, ![plan](/work/out/plan.png) et /resources/shared/notes.txt');
    const refs = rooms.read(r.id).messages.at(-1).refs.map((x) => x.open);
    const page = await get(`/api/rooms/${r.id}/shown?${new URLSearchParams({ o: `ai:${hugo.id}:work:out/report.html` })}`, given);
    assert.equal(page.status, 200); assert.equal(page.body.toString(), '<p>hugo</p>'); assert.equal(decodeURIComponent(page.headers['x-shown-by']), 'hugo');
    assert.ok(refs.includes(`ai:${hugo.id}:work:out/report.html`));
    const pic = await get(`/api/rooms/${r.id}/shown?${new URLSearchParams({ o: `ai:${hugo.id}:work:out/plan.png`, thumb: '1' })}`, given);
    assert.equal(pic.status, 200); assert.equal(pic.headers['content-type'], 'image/png'); assert.deepEqual(pic.body, PNG);
    const notes = await get(`/api/rooms/${r.id}/shown?${new URLSearchParams({ o: `ai:${hugo.id}:shared:notes.txt` })}`, given);
    assert.equal(notes.body.toString(), 'shared notes', 'a folder attached to its conversation');
    /* compta's work folder, through hugo; hugo's file, through compta; a folder compta was never given: refused. */
    for (const o of [`ai:${hugo.id}:work:out/secret.txt`, `ai:${compta.id}:work:out/report.html`, `ai:${compta.id}:shared:notes.txt`, `ai:${hugo.id}:work:../work-compta/out/secret.txt`]) {
        const no = await get(`/api/rooms/${r.id}/shown?${new URLSearchParams({ o })}`, given);
        assert.equal(no.status, 404, o); assert.ok(!no.body.toString().includes('compta only'), o);
    }
    answer('compta', r.id, 'Et /resources/shared/notes.txt ?');
    const viaCompta = await get(`/api/rooms/${r.id}/shown?${new URLSearchParams({ o: `ai:${compta.id}:shared:notes.txt` })}`, given);
    assert.equal(viaCompta.status, 404, 'a folder its conversation does not have, cited or not');
});

test('a mail an AI cited in a room opens as in its chat: read now for its conversation, said which', async (t) => {
    const { rooms, answer, given, asked } = world(t);
    const r = rooms.create({ name: 'La maison', conversations: ['hugo', 'compta'] });
    answer('compta', r.id, `Le devis : [Quote](${REF})`);
    const got = await get(`/api/rooms/${r.id}/mail/open?${new URLSearchParams({ ref: REF })}`, given);
    assert.equal(got.status, 200); assert.equal(got.headers['content-type'], 'message/rfc822');
    assert.equal(got.body.toString(), MAIL);
    assert.equal(decodeURIComponent(got.headers['x-mail-of']), 'compta', 'Reply writes in the chat of the AI that cited it');
    assert.equal(asked.length, 1); assert.equal(asked[0].verb, 'mail.open');
    const never = await get(`/api/rooms/${r.id}/mail/open?${new URLSearchParams({ ref: 'mail:work-mail/other%40example.com' })}`, given);
    assert.equal(never.status, 404, 'a mail nobody of the room cited'); assert.equal(asked.length, 1, 'nothing read');
});
