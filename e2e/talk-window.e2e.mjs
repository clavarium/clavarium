import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A long chat: the page is given its end, the rest on demand, and at each look only what changed. */
test('a chat of 600 messages: the last 200 shown, "Earlier messages" brings 200 more where the reader was, the search finds an old one at its place, and a look after a new message does not fetch everything again', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('notes');
    /* Written before the chat is turned on: the server's own copy takes the thread as it was. */
    const bridge = join(b.dir, 'data', 'work', 'notes', '.parley');
    mkdirSync(bridge, { recursive: true });
    const start = Date.now() - 3 * 86_400_000;
    const at = (i) => new Date(start + i * 60_000).toISOString();
    const agent = []; const person = [];
    for (let i = 0; i < 600; i += 1) {
        if (i % 2 === 0) agent.push({ id: `a${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, at: at(i), kind: 'say', text: `Tool message ${i}: ${'the tests pass and the page is drawn again '.repeat(4)}` });
        else person.push({ id: `p${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, at: at(i), text: `Owner message ${i}` });
    }
    writeFileSync(join(bridge, 'from-agent.jsonl'), agent.map((x) => `${JSON.stringify(x)}\n`).join(''));
    writeFileSync(join(bridge, 'to-agent.jsonl'), person.map((x) => `${JSON.stringify(x)}\n`).join(''));
    writeFileSync(join(bridge, 'read.json'), JSON.stringify({ lines: person.length, reads: [] }));
    assert.equal((await me.api('/api/conversations/notes/talk', { on: true })).status, 200);
    /* What the page asks of the chat, and how much comes back. Noted when
       asked, its size when it has come (`read`): noted only once its body
       was read, a request was counted after the page had already drawn what
       it brought -- under load, after the step that looked for it. */
    const asked = [];
    me.page.on('request', (q) => {
        const url = new URL(q.url());
        if (!/\/api\/conversations\/notes\/talk(\/search)?$/.test(url.pathname) || q.method() !== 'GET') return;
        const x = { query: Object.fromEntries(url.searchParams), search: url.pathname.endsWith('/search'), bytes: null };
        x.read = q.response().then((r) => r?.body()).then((body) => { x.bytes = body?.length ?? 0; }, () => { x.bytes = 0; });
        asked.push(x);
    });
    await me.page.goto(`${b.origin}/?c=notes`);
    const thread = me.page.locator('#simple-thread');
    const said = thread.locator('.parley-said');
    await me.until('the last 200', async () => (await said.count()) === 200);
    assert.equal(await thread.locator('.parley-said[data-from=agent] .parley-md').first().innerText(), `Tool message 400: ${'the tests pass and the page is drawn again '.repeat(4).trim()}`);
    const first = asked.find((x) => x.query.last === '200' && !x.query.since);
    assert.ok(first, 'its window asked for');
    await first.read;
    /* The page before, the reader kept where they were. */
    const scroller = thread.locator('.parley-thread');
    await scroller.evaluate((e) => { e.scrollTop = 0; });
    const more = thread.locator('.parley-earlier');
    assert.equal(await more.innerText(), 'Earlier messages');
    await more.click();
    await me.until('200 more', async () => (await said.count()) === 400);
    assert.ok(await scroller.evaluate((e) => e.scrollTop) > 200, 'not thrown to the top: what was read is still in sight');
    assert.ok(asked.some((x) => x.query.before && x.query.last === '200'));
    /* The search looks in the whole chat: an old message, brought to its place. */
    await thread.locator('.parley-box').click();
    await me.page.keyboard.press('Control+f');
    await me.page.keyboard.type('Owner message 121');
    await me.until('found further back, and shown', async () => (await thread.locator('.parley-said[data-id="p0000121-0000-4000-8000-000000000000"] mark.parley-found').count()) === 1);
    assert.ok(asked.some((x) => x.search && x.query.q === 'Owner message 121'));
    assert.ok(asked.some((x) => x.query.from === 'p0000121-0000-4000-8000-000000000000'));
    await me.page.keyboard.press('Escape');
    /* A new message: the looks after it bring that message, not the thread. */
    const before = asked.length;
    appendFileSync(join(bridge, 'from-agent.jsonl'), `${JSON.stringify({ id: 'fresh-0000-4000-8000-000000000000', at: new Date().toISOString(), kind: 'say', text: 'One more: done.' })}\n`);
    await me.until('its new message', async () => (await thread.locator('.parley-said[data-id="fresh-0000-4000-8000-000000000000"]').count()) === 1, 30_000);
    /* Besides, every few seconds, the page asks whether the chat is on
       (state=1): nothing of the thread, small too. Under load one falls
       in this step. */
    const after = asked.slice(before).filter((x) => !x.search);
    const looks = after.filter((x) => x.query.state !== '1');
    assert.ok(looks.length >= 1);
    assert.ok(looks.every((x) => x.query.since), `only what changed is asked for: ${JSON.stringify(looks.map((x) => x.query))}`);
    await Promise.all(after.map((x) => x.read));
    assert.ok(after.every((x) => x.bytes < 6000), `small: ${after.map((x) => x.bytes).join(', ')} bytes, against ${first.bytes} for the window`);
    assert.ok(first.bytes > 20 * Math.max(...after.map((x) => x.bytes)));
    /* The files on disk are whole; the page threw nothing. */
    assert.equal(readFileSync(join(bridge, 'from-agent.jsonl'), 'utf8').split('\n').filter(Boolean).length, 301);
    assert.deepEqual(me.errors, []);
    /* Settings, Chat screen: what is shown at first on this device, what its tool reads after a restart. */
    assert.equal((await me.api('/api/talk/window', { ai: 'days:3' })).status, 200);
    assert.equal((await me.api('/api/talk/window')).body.ai, 'days:3');
    assert.equal((await me.api('/api/talk/window', { ai: 'days:30' })).status, 400);
});
