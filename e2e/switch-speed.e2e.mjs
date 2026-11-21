import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP, wait } from './bench.mjs';

/* SWITCHING FEELS INSTANT (15-11): from one conversation to another, its chat's words are on the
   screen within a frame or two of the click -- never a blank chat while its thread comes, even when
   the server is far (each answer about a chat held back here, as over a phone's network). */
const NAMES = ['alpha', 'beta', 'gamma'];
const WORDS = (name, i) => `${name.toUpperCase()}-LINE-${i} said in the chat of ${name}`;
const FAR_MS = Number(process.env.SWITCH_FAR_MS ?? 150);

/* One switch, measured in the page: the click, then each frame until the chat shows the words.
   What is told back is small (numbers, a few words): never a node nor the page. */
const SWITCH = async ([name, words]) => {
    const shown = (id) => { const e = document.getElementById(id); return e && e.checkVisibility?.() ? e.innerText : ''; };
    const item = document.querySelector(`#list .item[data-name="${name}"]`);
    const t0 = performance.now();
    item.click();
    /* blank: no words of its chat yet; wrong: words of another's. */
    let blank = 0; let wrong = 0;
    return new Promise((done) => {
        const tick = () => {
            const ms = performance.now() - t0;
            const chat = shown('simple-thread');
            if (chat.includes(words)) { done({ ms: Math.round(ms), blank, wrong }); return; }
            if (shown('name').trim() === name) { if (/[A-Z]+-LINE-/.test(chat.replaceAll(`${name.toUpperCase()}-LINE-`, ''))) wrong += 1; else if (!chat.includes(`${name.toUpperCase()}-LINE-`)) blank += 1; }
            if (ms > 20_000) { done({ ms: -1, blank, wrong }); return; }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
};

test('Switching between conversations: the chat\'s words shown at once, no blank frame, even with a far server', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    for (const name of NAMES) {
        await me.create(name);
        assert.ok((await me.api(`/api/conversations/${name}/talk`, { on: true })).status < 300);
        for (let i = 1; i <= 12; i++) assert.ok((await me.api(`/api/conversations/${name}/talk`, { text: WORDS(name, i) })).status < 300);
    }
    const second = await b.person({ at: '/?c=alpha' });
    const p = second.page;
    await p.evaluate(() => { localStorage.setItem('clavarium-list-pin', 'on'); });
    await p.reload();
    await second.until('alpha\'s chat', async () => (await p.locator('#simple-thread').innerText().catch(() => '')).includes(WORDS('alpha', 12)), 30_000);
    /* The server far from here: every answer about a chat comes FAR_MS late. */
    await p.route('**/api/conversations/*/talk*', async (route) => { await wait(FAR_MS); await route.continue().catch(() => {}); });
    /* What was there to fetch, fetched in the background meanwhile (the others' chats). */
    await wait(3000);
    const runs = [];
    for (let round = 0; round < 3; round++) {
        for (const name of ['beta', 'gamma', 'alpha']) {
            const r = await p.evaluate(SWITCH, [name, WORDS(name, 12)]);
            runs.push({ name, ...r });
            await wait(400);
        }
    }
    const said = runs.map((r) => `${r.name} ${r.ms}ms blank=${r.blank} wrong=${r.wrong}`).join('; ');
    console.log(`switches: ${said}`);
    assert.ok(runs.every((r) => r.ms >= 0), `a chat never came: ${said}`);
    assert.equal(runs.filter((r) => r.wrong > 0).length, 0, `another's chat under this name: ${said}`);
    /* Once fetched, the chat is there before the far server answers: shown from what this page kept. */
    assert.equal(runs.filter((r) => r.blank > 0).length, 0, `a blank chat between the click and the words: ${said}`);
    assert.ok(runs.every((r) => r.ms < 100), `the words came later than 100 ms after the click: ${said}`);
    /* Kept, then put right: a message said meanwhile in a chat not open is there once it is opened. */
    await me.api('/api/conversations/beta/talk', { text: 'BETA-FRESH said while away' });
    const fresh = await p.evaluate(SWITCH, ['beta', 'BETA-FRESH said while away']);
    assert.ok(fresh.ms >= 0 && fresh.wrong === 0 && fresh.blank === 0, `the new message came, its kept chat shown meanwhile: ${JSON.stringify(fresh)}`);
    console.log(`a message said while away, shown ${fresh.ms}ms after the click (the far server's answer)`);
    await p.unrouteAll({ behavior: 'ignoreErrors' });
    assert.deepEqual(second.errors, []);
});
