import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* Each animation frame, what the page shows: the name in its bar, the chat, the binders, the room. */
const SAMPLE = () => {
    const shown = (id) => { const e = document.getElementById(id); return e && e.checkVisibility?.() ? e.innerText.replace(/\s+/g, ' ') : ''; };
    window.frames2 = [];
    const tick = () => { window.frames2.push({ name: shown('name'), chat: shown('simple-thread'), lists: shown('clists-binder'), room: shown('salon-name'), roomThread: shown('salon-thread') }); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
};
const frames = (page) => page.evaluate(() => window.frames2);
/* An answer of the server held back `ms`. */
const slow = (page, pattern, ms) => page.route(pattern, async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.continue().catch(() => {}); });

test('Switching, the server slow: another conversation never shows the chat or the binders of the one before, not even for a frame; a room picked in the list folds it as a conversation does, and its address names it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    const page = me.page;
    await me.create('alpha');
    await me.create('beta');
    for (const [name, words] of [['alpha', 'ALPHA-WORDS of the first'], ['beta', 'BETA-WORDS of the second']]) {
        assert.ok((await me.api(`/api/conversations/${name}/talk`, { on: true })).status < 300);
        assert.ok((await me.api(`/api/conversations/${name}/talk`, { text: words })).status < 300);
    }
    /* A matrix given to alpha alone, a plain binder to beta alone. */
    const matrix = (await me.api('/api/binder', { op: 'create-list', args: { template: 'priorities', title: 'Alpha matrix' } })).body.data;
    await me.api('/api/binder', { op: 'grant', args: { list: matrix.id, to: 'conversation:alpha', access: 'write' } });
    const plain = (await me.api('/api/binder', { op: 'create-list', args: { template: 'batches', title: 'Beta batches' } })).body.data;
    await me.api('/api/binder', { op: 'grant', args: { list: plain.id, to: 'conversation:beta', access: 'write' } });

    const second = await b.person({ at: '/?c=alpha' });
    const p = second.page;
    await p.evaluate(() => { localStorage.setItem('clavarium-list-pin', 'on'); });
    await p.reload();
    await second.until('alpha\'s chat', async () => (await p.locator('#simple-thread').innerText().catch(() => '')).includes('ALPHA-WORDS'), 30_000);
    await second.until('alpha\'s Binders tab', async () => p.locator('#view-lists').isVisible(), 30_000);
    await p.locator('#view-lists').click();
    await second.until('alpha\'s matrix', async () => (await p.locator('#clists-binder').innerText().catch(() => '')).includes('Alpha matrix'));

    /* Beta picked: its chat state, its binders' people, slow. */
    await slow(p, '**/api/conversations/beta/talk?*', 800);
    await slow(p, '**/api/binder/people', 800);
    await p.evaluate(SAMPLE);
    await p.locator('#list .item[data-name="beta"]').first().click();
    await second.until('beta\'s chat', async () => (await p.locator('#simple-thread').innerText().catch(() => '')).includes('BETA-WORDS'), 30_000);
    await p.locator('#view-lists').click();
    await second.until('beta\'s binder', async () => (await p.locator('#clists-binder').innerText().catch(() => '')).includes('Beta batches'), 30_000);
    const seen = await frames(p);
    const wrongChat = seen.filter((f) => f.name === 'beta' && f.chat.includes('ALPHA-WORDS'));
    const wrongLists = seen.filter((f) => f.name === 'beta' && f.lists.includes('Alpha matrix'));
    assert.equal(wrongChat.length, 0, `alpha's chat shown under beta's name for ${wrongChat.length} frame(s)`);
    assert.equal(wrongLists.length, 0, `alpha's binder shown under beta's name for ${wrongLists.length} frame(s)`);
    await p.unrouteAll({ behavior: 'ignoreErrors' });

    /* Two rooms; one picked in the list, the list not pinned: it folds, as for a conversation; its address names it. */
    const kitchen = (await me.api('/api/rooms', { name: 'Kitchen', conversations: ['alpha'] })).body;
    const garden = (await me.api('/api/rooms', { name: 'Garden', conversations: ['beta'] })).body;
    await me.api(`/api/rooms/${kitchen.id}/talk`, { text: 'KITCHEN-WORDS' });
    await me.api(`/api/rooms/${garden.id}/talk`, { text: 'GARDEN-WORDS' });
    await p.evaluate(() => { localStorage.setItem('clavarium-list-pin', 'off'); localStorage.setItem('clavarium-list', 'open'); });
    await p.goto(`${new URL(p.url()).origin}/?c=alpha`);
    await second.until('the rooms in the list', async () => (await p.locator(`#list .room-item[data-room="${garden.id}"]`).count()) > 0, 30_000);
    await slow(p, '**/api/rooms/*/talk*', 600);
    await p.evaluate(SAMPLE);
    await p.locator(`#list .room-item[data-room="${kitchen.id}"]`).first().click();
    await second.until('the kitchen', async () => (await p.locator('#salon-thread').innerText().catch(() => '')).includes('KITCHEN-WORDS'), 30_000);
    assert.equal(await p.evaluate(() => document.getElementById('app').dataset.list), 'folded', 'the list folds, as for a conversation');
    assert.equal(new URL(p.url()).searchParams.get('room'), kitchen.id, 'its address names it');
    await p.locator('#salon .fold-here').click();
    await p.locator(`#list .room-item[data-room="${garden.id}"]`).first().click();
    await second.until('the garden', async () => (await p.locator('#salon-thread').innerText().catch(() => '')).includes('GARDEN-WORDS'), 30_000);
    const rooms = await frames(p);
    const wrongRoom = rooms.filter((f) => f.room === 'Garden' && f.roomThread.includes('KITCHEN-WORDS'));
    assert.equal(wrongRoom.length, 0, `the kitchen's thread shown under the garden's name for ${wrongRoom.length} frame(s)`);
    /* Reloaded, the same room. */
    await p.reload();
    await second.until('the garden again', async () => (await p.locator('#salon-thread').innerText().catch(() => '')).includes('GARDEN-WORDS'), 30_000);
    assert.deepEqual(second.errors, []);
});
