/* THE DESK (server/desktop.mjs, web/desk.js): one per person, kept by the server, checked before it is kept;
   its places, moves, folders and tidying computed without a page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Desks, cleanDesk, handleDesktop, DESK_LIMITS } from '../server/desktop.mjs';
import { JsonFile } from '../server/store.mjs';
import { FILES } from '../server/main.mjs';
import { SETTINGS_WORDS_FR } from '../server/settingswords.mjs';

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
const window = {};
new Function('window', web('desk.js'))(window);
const D = window.clavariumDesk;

/* A request as the server sees it, and what was answered. */
async function ask(desks, { method = 'GET', path = '/api/desktop', body, who = 'you@example.com', origin = true, type = 'application/json' } = {}) {
    const request = new PassThrough();
    request.method = method; request.url = path; request.headers = { 'content-type': type };
    let status = 0; let text = '';
    const response = { writeHead(s) { status = s; return this; }, end(t) { text = t ?? ''; return this; } };
    const handled = handleDesktop(request, response, desks, who, () => origin, {});
    request.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    const done = await handled;
    return { done, status, body: text ? JSON.parse(text) : null };
}

test('kept per person, the same for every screen of that person; none yet says so (the page fills it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-desk-'));
    try {
        const file = join(dir, 'desktops.json');
        const desks = new Desks({ file: new JsonFile(file, {}), now: () => Date.parse('2026-11-16T10:00:00Z') });
        assert.deepEqual(desks.get('you@example.com'), { saved: false, items: [], gone: [], at: null });
        const items = [{ id: 'c:notes', size: 'm', c: 3, r: 2, t: 5 }, { id: 'f:a1', folder: 'Work', size: 's', items: ['c:site', 'a:list:4'] }];
        const put = await ask(desks, { method: 'PUT', body: { items, gone: ['r:old'] } });
        assert.equal(put.status, 200);
        assert.deepEqual(put.body.items, items);
        assert.equal(put.body.at, '2026-11-16T10:00:00.000Z');
        /* Another screen of the same person reads the same desk, from the file. */
        const again = new Desks({ file: new JsonFile(file, {}) });
        assert.deepEqual(again.get('you@example.com').items, items);
        assert.deepEqual(again.get('you@example.com').gone, ['r:old']);
        /* Another person has their own. */
        assert.equal(again.get('other@example.com').saved, false);
        assert.equal((await ask(again, { who: 'other@example.com' })).body.saved, false);
        /* The fields not known are not kept. */
        const extra = await ask(desks, { method: 'PUT', body: { items: [{ id: 'c:x', size: 's', html: '<b>', c: 1, r: 1 }], more: 1 } });
        assert.deepEqual(extra.body.items, [{ id: 'c:x', size: 's', c: 1, r: 1 }]);
        assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8'))['you@example.com'], 'more'), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checked before it is kept: shapes, sizes, places, twice, folders in folders, limits; refused whole', () => {
    const bad = [
        undefined, {}, { items: 'x' },
        { items: [{ id: 'x:1' }] }, { items: [{ id: 'c:' }] }, { items: [{ id: 'c:a\nb' }] },
        { items: [{ id: 'c:a', size: 'xl' }] },
        { items: [{ id: 'c:a', c: 0, r: 1 }] }, { items: [{ id: 'c:a', c: 1 }] }, { items: [{ id: 'c:a', c: DESK_LIMITS.cols + 1, r: 1 }] }, { items: [{ id: 'c:a', c: 1.5, r: 1 }] },
        { items: [{ id: 'c:a', c: 1, r: 1, t: -1 }] },
        { items: [{ id: 'c:a' }, { id: 'c:a' }] },
        { items: [{ id: 'c:a' }, { id: 'f:x', folder: 'F', items: ['c:a'] }] },
        { items: [{ id: 'f:x', folder: 'F', items: ['f:y'] }] },
        { items: [{ id: 'f:x', folder: '', items: [] }] }, { items: [{ id: 'f:x', folder: 'a\nb', items: [] }] }, { items: [{ id: 'f:x', folder: 'x'.repeat(61), items: [] }] },
        { items: [{ id: 'f:../x', folder: 'F', items: [] }] },
        { items: [{ id: 'c:a' }], gone: ['a:list:1'] },
        { items: Array.from({ length: DESK_LIMITS.items + 1 }, (_, i) => ({ id: `c:n${i}` })) },
        { items: [{ id: 'f:x', folder: 'F', items: Array.from({ length: DESK_LIMITS.inFolder + 1 }, (_, i) => `c:n${i}`) }] },
        { items: [{ id: `c:${'x'.repeat(DESK_LIMITS.id)}` }] },
    ];
    for (const body of bad) assert.throws(() => cleanDesk(body), (e) => e.status === 400, JSON.stringify(body)?.slice(0, 80));
    /* An empty folder is kept (made to have things dropped on it); a folder's name is trimmed. */
    assert.deepEqual(cleanDesk({ items: [{ id: 'f:x', folder: '  Mine ', items: [] }] }).items, [{ id: 'f:x', size: 's', folder: 'Mine', items: [] }]);
    /* What is on the desk again is no longer gone. */
    assert.deepEqual(cleanDesk({ items: [{ id: 'c:a' }], gone: ['c:a', 'r:b', 'r:b'] }).gone, ['r:b']);
});

test('the door: GET and PUT only, this site only, JSON only, a size limit; other addresses are not its own', async () => {
    const desks = new Desks();
    assert.equal((await ask(desks, { method: 'POST', body: { items: [] } })).status, 405);
    assert.equal((await ask(desks, { method: 'PUT', body: { items: [] }, origin: false })).status, 403);
    assert.equal((await ask(desks, { method: 'PUT', body: { items: [] }, type: 'text/plain' })).status, 403);
    assert.equal((await ask(desks, { method: 'PUT', body: '{nope' })).status, 400);
    assert.equal((await ask(desks, { method: 'PUT', body: 'x'.repeat(DESK_LIMITS.bytes + 10) })).status, 413);
    assert.equal((await ask(desks, { method: 'PUT', body: { items: [{ id: 'nope' }] } })).status, 400);
    assert.equal((await ask(desks, { method: 'PUT', body: { items: [] }, who: '' })).status, 403);
    assert.equal((await ask(desks, { path: '/api/desktop/other' })).done, false);
    /* Served, and in the page before app.js; its words in French. */
    assert.deepEqual(FILES['/desk.js'], ['web/desk.js', 'text/javascript; charset=utf-8']);
    assert.match(web('index.html'), /<script src="\/desk\.js"><\/script>[\s\S]*<script src="\/app\.js">/);
    const asked = new Set([...web('desk.js').matchAll(/w\(`?'?(desk-[a-z-]+)/g), ...web('app.js').matchAll(/uiSaid\('(desk-[a-z-]+)'/g)].map((m) => m[1]));
    for (const s of ['s', 'm', 'l']) asked.add(`desk-size-${s}`);
    for (const m of ['left', 'right', 'up', 'down']) asked.add(`desk-mv-${m}`);
    assert.ok(asked.size > 30, `${asked.size}`);
    for (const k of asked) if (!k.endsWith('-')) assert.ok(k in SETTINGS_WORDS_FR, k);
    /* A person's data as text only: no markup written by the desk. */
    assert.doesNotMatch(web('desk.js'), /innerHTML|insertAdjacentHTML|outerHTML/);
});

const it = (id, size = 's', more = {}) => ({ id, size, ...more });
const at = (items, n) => Object.fromEntries([...D.layout(items, n).pos].map(([id, p]) => [id, [p.c, p.r]]));

test('a place kept is used when it fits; else the first free cell, at display time only', () => {
    const items = [it('c:a'), it('c:b', 'm'), it('c:c', 's', { c: 6, r: 3, t: 1 }), it('c:d', 'l')];
    assert.deepEqual(at(items, 8), { 'c:c': [6, 3], 'c:a': [1, 1], 'c:b': [2, 1], 'c:d': [4, 1] });
    /* A narrow screen (4 columns): c:c's column is past the edge: shown in the first free cell; its place is kept. */
    assert.deepEqual(at(items, 4), { 'c:c': [1, 1], 'c:a': [2, 1], 'c:b': [3, 1], 'c:d': [1, 2] });
    assert.deepEqual([items[2].c, items[2].r], [6, 3]);
    /* Wide again: back where it was put. */
    assert.deepEqual(at(items, 8)['c:c'], [6, 3]);
    /* One column: wide and large ones take the one column. */
    assert.deepEqual(D.layout([it('c:b', 'l')], 1).pos.get('c:b'), { c: 1, r: 1, w: 1, h: 2 });
    /* Two put on the same cell (two screens): the last put wins it. */
    assert.deepEqual(at([it('c:x', 's', { c: 2, r: 2, t: 1 }), it('c:y', 's', { c: 2, r: 2, t: 9 })], 4), { 'c:y': [2, 2], 'c:x': [1, 1] });
});

test('put on a taken cell, the one there goes to the first free cell; nothing else moves; arrows move by one', () => {
    const items = [it('c:a'), it('c:b'), it('c:c'), it('c:d')];
    const n = 4;
    D.moveTo(items, 'c:d', 1, 1, n, D.layout(items, n).pos, 100);
    assert.deepEqual(at(items, n), { 'c:d': [1, 1], 'c:b': [2, 1], 'c:c': [3, 1], 'c:a': [4, 1] });
    /* Far from the others: any cell. */
    D.moveTo(items, 'c:b', 3, 5, n, D.layout(items, n).pos, 200);
    assert.deepEqual(at(items, n)['c:b'], [3, 5]);
    assert.deepEqual(at(items, n)['c:c'], [3, 1], 'the others stay where they were seen');
    D.moveBy(items, 'c:b', 0, -1, n, D.layout(items, n).pos, 300);
    D.moveBy(items, 'c:b', 1, 0, n, D.layout(items, n).pos, 400);
    assert.deepEqual(at(items, n)['c:b'], [4, 4]);
    /* Not past the edge, nor above the first row. */
    D.moveBy(items, 'c:b', 1, 0, n, D.layout(items, n).pos, 500);
    assert.deepEqual(at(items, n)['c:b'], [4, 4]);
    /* A wide one put on two: both go to free cells. */
    const two = [it('c:w', 'm'), it('c:p', 's', { c: 3, r: 2, t: 1 }), it('c:q', 's', { c: 4, r: 2, t: 1 })];
    D.moveTo(two, 'c:w', 3, 2, n, D.layout(two, n).pos, 9);
    const seen = at(two, n);
    assert.deepEqual(seen['c:w'], [3, 2]);
    assert.notDeepEqual(seen['c:p'], [3, 2]); assert.notDeepEqual(seen['c:q'], [4, 2]);
});

test('tidy packs to the top left in reading order; folders made by a drop, filled, undone; off the desk is gone', () => {
    let items = [it('c:a', 's', { c: 4, r: 3, t: 1 }), it('c:b', 's', { c: 2, r: 1, t: 1 }), it('a:list:1', 'm', { c: 1, r: 2, t: 1 })];
    items = D.tidy(items, D.layout(items, 4).pos);
    assert.deepEqual(items.map((x) => x.id), ['c:b', 'a:list:1', 'c:a']);
    assert.ok(items.every((x) => x.c === undefined && x.r === undefined));
    assert.deepEqual(at(items, 4), { 'c:b': [1, 1], 'a:list:1': [2, 1], 'c:a': [4, 1] });
    /* c:a dropped on c:b: a folder at c:b's place, c:b first. */
    const f = D.merge(items, 'c:a', 'c:b', { id: 'f:1', name: 'New folder' });
    assert.deepEqual(f.items, ['c:b', 'c:a']);
    assert.deepEqual(items.map((x) => x.id), ['f:1', 'a:list:1']);
    /* Into it; a folder never into a folder. */
    items.push(it('r:room'));
    assert.equal(D.merge(items, 'r:room', 'f:1', {}), f);
    assert.deepEqual(f.items, ['c:b', 'c:a', 'r:room']);
    items.push({ id: 'f:2', folder: 'Other', size: 's', items: ['c:z'] });
    assert.equal(D.merge(items, 'f:2', 'f:1', {}), null);
    assert.deepEqual(D.idsOf(items).sort(), ['a:list:1', 'c:a', 'c:b', 'c:z', 'f:1', 'f:2', 'r:room']);
    /* Out of it; off the desk from it; a conversation and a room off the desk are gone, an asset is not. */
    D.takeOut(items, 'f:1', 'c:a');
    assert.deepEqual(D.remove(items, 'r:room', 'f:1'), ['r:room']);
    assert.deepEqual(D.remove(items, 'a:list:1'), []);
    assert.deepEqual(D.remove(items, 'f:2'), ['c:z']);
    D.unfold(items, 'f:1');
    assert.deepEqual(items.map((x) => x.id), ['c:b', 'c:a']);
    assert.deepEqual(D.dropEmpty([{ id: 'f:e', folder: 'E', items: [] }, it('c:a')]).map((x) => x.id), ['c:a']);
});

test('day one: today\'s home cards; then the new ones come by themselves, never one taken off', () => {
    const items = [];
    assert.equal(D.addNew(items, [], [{ id: 'r:1', size: 'm' }, { id: 'c:a', size: 'm' }, { id: 'c:b', size: 'm' }]), 3);
    assert.deepEqual(items.map((x) => [x.id, x.size]), [['r:1', 'm'], ['c:a', 'm'], ['c:b', 'm']]);
    items.splice(0, 3, { id: 'f:1', folder: 'F', size: 's', items: ['c:a'] });
    assert.equal(D.addNew(items, ['c:b'], [{ id: 'r:1' }, { id: 'c:a' }, { id: 'c:b' }, { id: 'c:new' }]), 2);
    assert.deepEqual(D.idsOf(items), ['f:1', 'c:a', 'r:1', 'c:new']);
});

/* 18-11, option A of the panel (bureau-centrage): the same picture on every screen, centred, a little bigger or smaller. */
test('how the desk is shown: the columns it uses, cells 75-125 %, centred; a phone in reading order; edit mode every column', () => {
    const { fit, reading } = window.clavariumDesk;
    const items = [{ id: 'a', c: 1, r: 1, size: 'm' }, { id: 'b', c: 10, r: 1, size: 'm' }, { id: 'c', c: 3, r: 2 }];
    const g = 12; const cell = 104;
    const wide = fit(items, { room: 2000, cell, gap: g });
    assert.equal(wide.cols, 11, 'its rightmost thing: column 10, two wide');
    assert.equal(wide.cell, 130, 'at most 125 %');
    assert.equal(wide.order, 'own');
    const tablet = fit(items, { room: 11 * 104 + 10 * g, cell, gap: g });
    assert.deepEqual([tablet.cols, tablet.cell], [11, 104], 'where it was arranged: as it was');
    const smaller = fit(items, { room: 1000, cell, gap: g });
    assert.equal(smaller.cols, 11); assert.ok(smaller.cell >= 78 && smaller.cell < 104, String(smaller.cell));
    const phone = fit(items, { room: 360, cell: 72, gap: 10 });
    assert.equal(phone.order, 'reading'); assert.equal(phone.cell, 0);
    assert.deepEqual(reading(items).map((x) => x.id), ['a', 'b', 'c'], 'rows first, then columns');
    assert.ok(reading(items).every((x) => x.c === undefined && x.r === undefined), 'packed: their cells left out, for the screen only');
    assert.equal(items[1].c, 10, 'nothing kept changes');
    const edit = fit(items, { room: 2000, cell, gap: g, editing: true });
    assert.deepEqual([edit.cols, edit.cell, edit.order], [17, 0, 'own'], 'edit mode: every column, from the left');
    assert.equal(fit([], { room: 2000, cell, gap: g }).cell, 0, 'an empty desk: as before');
    assert.deepEqual(fit([...items, { id: 'new' }], { room: 2000, cell, gap: g }), { cols: 17, cell: 0, order: 'own' }, 'one never put anywhere: every column, as before');
});
