/* THE LIST: folders (one level), an order kept by the server, a discreet
   search, the sizes of a machine greyed while it is not ready, and the name
   of this Clavarium. With CLAVARIUM_NAV_SHOTS set to a directory, the
   screens are saved there as pictures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const SHOTS = process.env.CLAVARIUM_NAV_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const names = (page) => page.locator('#items .item').evaluateAll((all) => all.map((b) => b.dataset.name));

async function made(me, list) {
    for (const [title, group] of list) {
        const r = await me.api('/api/conversations', { title, tool: 'shell', ...(group ? { group } : {}) });
        assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    await me.until('all are ready', async () => (await me.api('/api/conversations')).body.filter((c) => c.phase === 'ready').length === list.length, 30_000);
}

test('folders: made at creation and in General, folded on this device only, renamed for all, gone when empty; the one that needs you is said folded', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await made(me, [['Site web', ''], ['Été plans', 'Perso'], ['Taxes', 'Perso'], ['Invoices', 'Clients']]);
    await me.page.reload();
    /* Those in no group are a group of their own, "Not filed", before the groups. */
    await me.until('the list, groups after the others', async () => (await me.page.locator('#items .group').count()) === 3);
    assert.deepEqual(await me.page.locator('#items > *').evaluateAll((all) => all.map((x) => x.dataset.name ?? `[${x.dataset.group}]`)), ['[]', '[Perso]', '[Clients]']);
    assert.match(await me.page.locator('.group[data-group=""] .group-head').innerText(), /Not filed\s*1 conversation/);
    assert.match(await me.page.locator('.group[data-group="Perso"] .group-head').innerText(), /Perso\s*2 conversations/);
    assert.deepEqual(await names(me.page), ['site-web', 'taxes', 'ete-plans', 'invoices'], 'the newest first in its folder');
    /* Made in a folder from the form, with the folders there are offered. */
    await me.page.locator('#new').click();
    assert.deepEqual(await me.page.locator('#group-names option').evaluateAll((all) => all.map((o) => o.value)), ['Perso', 'Clients']);
    await me.page.fill('#create-name', 'Quote');
    await me.page.fill('#create-group', 'Clients');
    await me.page.locator('#create button[type=submit]').click();
    await me.until('in its folder, first', async () => (await me.page.locator('.group[data-group="Clients"] .item').first().getAttribute('data-name')) === 'quote');
    /* Folded: kept on this device after a reload, not on another. */
    await me.page.locator('.group[data-group="Perso"] .group-head').click();
    await me.until('folded', async () => (await me.page.locator('.group[data-group="Perso"] .item').count()) === 0);
    assert.equal(await me.page.locator('.group[data-group="Perso"] .group-head').getAttribute('aria-expanded'), 'false');
    await me.page.reload();
    await me.until('still folded after a reload', async () => (await me.page.locator('.group[data-group="Perso"] .group-head').count()) === 1 && (await me.page.locator('.group[data-group="Perso"] .item').count()) === 0);
    const other = await b.person();
    await other.until('open on another device', async () => (await other.page.locator('.group[data-group="Perso"] .item').count()) === 2);
    /* One that waits for you, folded: its folder says so. */
    await me.page.route('**/api/conversations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const r = await route.fetch(); const list = await r.json();
        for (const c of list) if (c.name === 'taxes') c.talk = { waiting: 1, state: 'waiting' };
        await route.fulfill({ response: r, json: list });
    });
    await me.page.reload();
    await me.until('the folded folder says one needs you', async () => (await me.page.locator('.group[data-group="Perso"] .group-head .needs-dot').count()) === 1);
    await me.page.unroute('**/api/conversations');
    /* In General: moved to another folder; the folder renamed for all its conversations. */
    await me.page.locator('#items .item[data-name="site-web"]').click();
    await me.page.locator('#folders').click();
    await me.chapter('general');
    await me.page.fill('#group-name', 'Clients');
    await me.page.locator('#group-form button[type=submit]').click();
    await me.until('site-web is in Clients', async () => (await me.api('/api/conversations')).body.find((c) => c.name === 'site-web').group === 'Clients');
    await me.until('rename is offered', async () => me.page.locator('#group-rename-form').isVisible());
    await me.page.fill('#group-rename', 'Customers <b>');
    await me.page.locator('#group-rename-form button[type=submit]').click();
    await me.until('renamed for all three', async () => (await me.api('/api/conversations')).body.filter((c) => c.group === 'Customers <b>').length === 3);
    await me.until('the list says it, as text', async () => (await me.page.locator('.group[data-group="Customers <b>"] .group-name').innerText()) === 'Customers <b>');
    assert.equal(await me.page.locator('.group-name b').count(), 0, 'never markup');
    assert.equal((await me.api('/api/conversations/site-web/group', { group: 'two\nlines' })).status, 400);
    /* Emptied: the folder is gone. */
    for (const n of ['taxes', 'ete-plans']) await me.api(`/api/conversations/${n}/group`, { group: '' });
    await me.page.reload();
    await me.until('Perso is gone', async () => (await me.page.locator('.group[data-group="Perso"]').count()) === 0 && (await me.page.locator('#items .group').count()) === 2); // Clients, and those in no group
    assert.deepEqual(me.errors, []);
});

test('the order: Move up and down in General, dragged with a mouse, held then dragged with a finger; the same on every device', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await made(me, [['One', ''], ['Two', ''], ['Three', ''], ['Four', 'Box']]);
    await me.page.reload();
    await me.until('listed', async () => (await names(me.page)).length === 4);
    assert.deepEqual(await names(me.page), ['three', 'two', 'one', 'four']);
    await me.page.locator('#items .item[data-name="one"]').click();
    await me.page.locator('#folders').click();
    await me.chapter('general');
    await me.page.locator('#move-up').click();
    await me.until('one moved up', async () => (await names(me.page)).join() === 'three,one,two,four');
    await me.page.locator('#move-down').click();
    await me.until('and down', async () => (await names(me.page)).join() === 'three,two,one,four');
    /* The keyboard: Alt and an arrow. */
    await me.page.locator('#items .item[data-name="one"]').focus();
    await me.page.keyboard.press('Alt+ArrowUp');
    await me.until('Alt+Up moved it', async () => (await names(me.page)).join() === 'three,one,two,four');
    /* A mouse drag: onto the folder, then above another one. */
    const drag = async (from, to, dy = 0) => {
        const a = await me.page.locator(from).boundingBox(); const z = await me.page.locator(to).boundingBox();
        await me.page.mouse.move(a.x + 20, a.y + a.height / 2);
        await me.page.mouse.down();
        await me.page.mouse.move(a.x + 20, a.y + a.height / 2 + 12, { steps: 3 });
        await me.page.mouse.move(z.x + 20, z.y + z.height / 2 + dy, { steps: 6 });
        await me.page.mouse.up();
    };
    await drag('#items .item[data-name="two"]', '.group-head[data-group="Box"]');
    await me.until('two is in Box, first', async () => (await me.page.locator('.group[data-group="Box"] .item').first().getAttribute('data-name')) === 'two');
    assert.equal((await me.api('/api/conversations')).body.find((c) => c.name === 'two').group, 'Box');
    await drag('#items .item[data-name="one"]', '#items .item[data-name="three"]', -10);
    await me.until('one above three', async () => (await names(me.page)).slice(0, 2).join() === 'one,three');
    assert.equal(new URL(me.page.url()).searchParams.get('c'), 'one', 'a drag opens nothing');
    /* The same order on another device: a phone, where a finger holds, then drags. */
    const phone = await b.person({ phone: true });
    await phone.until('the same order', async () => (await names(phone.page)).join() === (await names(me.page)).join());
    const cdp = await phone.context.newCDPSession(phone.page);
    /* Below "Needs you" and "Recent": the groups are scrolled to first, as a finger would. */
    await phone.page.locator('#items .item[data-name="three"]').scrollIntoViewIfNeeded();
    /* Measured again if the list was painted at that moment (a row replaced has no box). */
    let a = null; let z = null;
    await phone.until('both rows measured', async () => { a = await phone.page.locator('#items .item[data-name="three"]').boundingBox(); z = await phone.page.locator('#items .item[data-name="one"]').boundingBox(); return Boolean(a && z); });
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', a.x + 30, a.y + a.height / 2);
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 1; i <= 6; i += 1) { await touch('touchMove', a.x + 30, a.y + a.height / 2 + ((z.y + 5) - (a.y + a.height / 2)) * (i / 6)); await new Promise((r) => setTimeout(r, 30)); }
    await touch('touchEnd');
    await phone.until('three above one, on the phone', async () => (await names(phone.page)).slice(0, 2).join() === 'three,one');
    assert.equal(new URL(phone.page.url()).searchParams.get('c'), null, 'held and dragged: nothing was opened');
    await me.until('and on the computer', async () => { await me.page.reload(); return (await names(me.page)).slice(0, 2).join() === 'three,one'; });
    /* A short touch still opens it; a finger that moves at once scrolls. */
    await phone.page.locator('#items .item[data-name="one"]').tap();
    await phone.until('a tap opens it', async () => new URL(phone.page.url()).searchParams.get('c') === 'one');
    assert.deepEqual(me.errors, []);
    assert.deepEqual(phone.errors, []);
});

for (const phone of [false, true]) {
    test(`the search, on a ${phone ? 'phone' : 'tablet'}: discreet, accents and case ignored, hidden ones found and marked, arrows and Enter, Escape empties then closes`, { skip: SKIP }, async (t) => {
        const b = await bench(t);
        const me = await b.person(phone ? { phone: true } : {});
        await me.page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1024, height: 768 });
        await made(me, [['Location voiture', ''], ['Été plans', 'Perso'], ['Taxes', 'Perso'], ['Secret', ''], ['Invoices', 'Clients']]);
        await me.api('/api/conversations/secret/hidden', { on: true });
        await me.page.reload();
        await me.until('listed', async () => (await me.page.locator('#items .group').count()) === 3);
        await me.page.locator('.group[data-group="Perso"] .group-head').click();
        assert.equal(await me.page.locator('#search').isVisible(), false, 'no bar until asked');
        /* A phone has no keyboard to speak of: the magnifier. */
        if (phone) await me.page.locator('#search-open').tap(); else await me.page.keyboard.press('/');
        await me.until('"/" opens the field', async () => (await me.page.locator('#search-field').isVisible()) && await me.page.locator('#search-field').evaluate((f) => f === document.activeElement));
        await me.page.keyboard.type('ETE');
        await me.until('found without accents, in its folder, opened', async () => (await names(me.page)).join() === 'ete-plans');
        await me.page.fill('#search-field', 'sec');
        await me.until('a hidden one is found, and said hidden', async () => (await names(me.page)).join() === 'secret' && /hidden/.test(await me.page.locator('#items .item').innerText()));
        await me.page.fill('#search-field', 'shell');
        await me.until('by its tool: all', async () => (await names(me.page)).length === 5);
        await shot(me.page, `${phone ? 'phone' : 'tablet'}-list-folders-search`);
        await me.page.fill('#search-field', 'perso');
        await me.until('by its folder', async () => (await names(me.page)).length === 2);
        await me.page.keyboard.press('ArrowDown');
        const second = (await names(me.page))[1];
        await me.until('the arrow chooses', async () => (await me.page.locator('#items .item[data-chosen]').getAttribute('data-name')) === second);
        await me.page.keyboard.press('Enter');
        await me.until('Enter opens it', async () => new URL(me.page.url()).searchParams.get('c') === second);
        await me.page.goBack();
        await me.until('back on the list, the search closed', async () => new URL(me.page.url()).searchParams.get('c') === null && !(await me.page.locator('#search').isVisible()));
        /* Escape: empties, then closes; the folders fold again as they were. */
        if (phone) await me.page.locator('#search-open').tap(); else await me.page.keyboard.press('Control+k');
        await me.until('Ctrl+K opens it', async () => me.page.locator('#search-field').isVisible());
        await me.page.keyboard.type('zzz');
        await me.until('nothing found, said', async () => me.page.locator('#search-none').isVisible());
        await me.page.keyboard.press('Escape');
        await me.until('Escape empties it', async () => (await me.page.locator('#search-field').inputValue()) === '' && await me.page.locator('#search-field').isVisible());
        await me.page.keyboard.press('Escape');
        await me.until('Escape again closes it', async () => !(await me.page.locator('#search').isVisible()));
        assert.equal(await me.page.locator('.group[data-group="Perso"] .item').count(), 0, 'Perso is folded again');
        assert.equal(new URL(me.page.url()).origin, b.origin);
        assert.deepEqual(me.errors, []);
    });
}

test('a machine not ready: its memory and disk are shown, greyed, and said available once it is built', { skip: SKIP }, async (t) => {
    const b = await bench(t, { launchSeconds: '12' });
    for (const phone of [false, true]) {
        const me = await b.person(phone ? { phone: true, chapters: { machine: true } } : { chapters: { machine: true } });
        await me.page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1024, height: 768 });
        const name = phone ? 'slow-phone' : 'slow';
        if (!phone) assert.equal((await me.api('/api/conversations', { name, tool: 'shell' })).status, 201);
        else await me.api('/api/conversations', { name, tool: 'shell' });
        await me.page.goto(`${b.origin}/?c=${name}`);
        await me.page.locator('#folders').click();
        await me.until('the machine chapter, while it is built', async () => (await me.page.locator('#machine-size').isVisible()) && me.page.locator('#machine-size-wait').isVisible());
        assert.equal(await me.page.locator('#machine-memory').isDisabled(), true);
        assert.equal(await me.page.locator('#machine-disk').isDisabled(), true);
        assert.equal(await me.page.locator('#machine-size-apply').isDisabled(), true);
        assert.match(await me.page.locator('#machine-memory').inputValue(), /^\d+$/, 'its memory is readable');
        assert.equal(await me.page.locator('#machine-size-wait').innerText(), 'Available once its machine is built.');
        await me.page.locator('#chapter-machine').scrollIntoViewIfNeeded();
        await me.page.locator('#machine-size').scrollIntoViewIfNeeded();
        await shot(me.page, `${phone ? 'phone' : 'tablet'}-machine-greyed`);
        /* And the server still refuses. */
        assert.equal((await me.api(`/api/conversations/${name}/machine`, { memoryMb: 4096 })).status, 409);
        {
            await me.until('ready: the choices come back', async () => !(await me.page.locator('#machine-memory').isDisabled()), 40_000);
            assert.equal(await me.page.locator('#machine-size-wait').isVisible(), false);
        }
        assert.deepEqual(me.errors, []);
    }
});

test('the name of this Clavarium: in Settings, in the tab, above the list, in the manifest of the owner and of a device', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    for (const phone of [false, true]) {
        const me = await b.person(phone ? { phone: true } : {});
        await me.page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1024, height: 768 });
        await me.until('the usual name', async () => (await me.page.title()) === (phone ? 'Atelier "<i>"' : 'Clavarium'));
        if (phone) continue;
        await me.page.locator('#nav-settings').click();
        await me.chapter('s-general');
        assert.equal(await me.page.locator('#instance-name').getAttribute('placeholder'), 'Clavarium');
        await me.page.fill('#instance-name', 'Atelier "<i>"');
        await me.page.locator('#instance-form button[type=submit]').click();
        await me.until('the tab says it', async () => (await me.page.title()) === 'Atelier "<i>"');
        assert.equal(await me.page.locator('#list-title').innerText(), 'Atelier "<i>"');
        assert.equal(await me.page.locator('#list-title i').count(), 0, 'text only');
        await shot(me.page, 'tablet-settings-instance-name');
        const manifest = await me.page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
        assert.equal(manifest.name, 'Atelier "<i>"');
        assert.equal(manifest.short_name, 'Atelier', 'under an icon: its first word');
        const device = await (await fetch(`${b.origin}/c/manifest.webmanifest?name=${encodeURIComponent('Dad‮')}`)).json();
        assert.equal(device.name, 'Atelier "<i>"', 'a device asking a name that is not one gets the usual one');
        assert.equal((await (await fetch(`${b.origin}/c/manifest.webmanifest?name=Kitchen`)).json()).name, 'Kitchen');
        assert.equal((await me.api('/api/instance', { name: 'two\nlines' })).status, 400);
    }
});

test('Recent above the groups: the last used first, with when; never a hidden one; a few, then all; one asleep says what a tap does', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await made(me, [['First', ''], ['Second', 'Box'], ['Third', ''], ['Secret', '']]);
    await me.api('/api/conversations/secret/hidden', { on: true });
    await me.api('/api/conversations/first/sleep', {});
    await me.page.reload();
    await me.until('Recent is there', async () => (await me.page.locator('#recent .item').count()) === 3);
    const recent = await me.page.locator('#recent .item').evaluateAll((all) => all.map((x) => x.dataset.name));
    assert.deepEqual(recent, ['third', 'second', 'first'], 'the newest first; the hidden one never');
    assert.match(await me.page.locator('#recent .item[data-name="third"] .when').innerText(), /^\d{1,2}:\d{2}/);
    assert.match(await me.page.locator('#recent .list-head').first().innerText(), /recent/i);
    await me.until('asleep, in words', async () => /asleep, wakes when opened/.test(await me.page.locator('#recent .item[data-name="first"]').innerText()));
    /* The groups below it: Box, and those in no group. */
    assert.deepEqual(await me.page.locator('#recent .list-head').allInnerTexts().then((x) => x.map((s) => s.replace(/[^A-Za-z ]/g, '').trim().toLowerCase())), ['recent', 'groups']);
    assert.equal(await me.page.locator('#recent .list-fold[data-section="recent"] .list-count').count(), 0, 'open: no count, its rows say it');
    /* Recent folds, on this device, and stays folded; the groups stay. */
    await me.page.locator('#recent .list-fold[data-section="recent"]').click();
    await me.until('folded', async () => (await me.page.locator('#recent .item').count()) === 0);
    assert.equal(await me.page.locator('#recent .list-fold[data-section="recent"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await me.page.locator('#recent .list-fold[data-section="recent"] .list-count').innerText(), '3', 'folded: how many it holds');
    await me.page.reload();
    await me.until('still folded after a reload', async () => (await me.page.locator('#recent .list-fold[data-section="recent"]').count()) === 1 && (await me.page.locator('#recent .item').count()) === 0);
    assert.ok((await me.page.locator('#items .item').count()) >= 3, 'the groups are still there');
    await me.page.locator('#recent .list-fold[data-section="recent"]').click();
    await me.until('open again', async () => (await me.page.locator('#recent .item').count()) === 3);
    /* A tap on a row of Recent opens it. */
    await me.page.locator('#recent .item[data-name="second"]').click();
    await me.until('opened', async () => new URL(me.page.url()).searchParams.get('c') === 'second');
    assert.deepEqual(me.errors, []);
});

test('Recent: the last four, then "Show more"; the list scrolls as one, never a box of its own', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await made(me, [['One', 'Box'], ['Two', ''], ['Three', ''], ['Four', ''], ['Five', ''], ['Six', 'Box']]);
    await me.page.reload();
    await me.until('Recent is there', async () => (await me.page.locator('#recent .item').count()) === 4);
    assert.equal(await me.page.locator('#recent .more-recent').innerText(), 'Show more (2)');
    await me.page.locator('#recent .more-recent').click();
    await me.until('all of them', async () => (await me.page.locator('#recent .item').count()) === 6);
    assert.equal(await me.page.locator('#recent .more-recent').innerText(), 'Show fewer');
    /* No box scrolls on its own inside the list. */
    const inner = await me.page.evaluate(() => [...document.querySelectorAll('#list *')].filter((e) => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1; }).map((e) => e.id || e.className));
    assert.deepEqual(inner, []);
    assert.deepEqual(me.errors, []);
});
