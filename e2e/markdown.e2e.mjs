import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { bench, SKIP, wait } from './bench.mjs';

/* A real PNG, w x h, of one colour. */
function png(w, h, [r, g, b2]) {
    const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
    const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
    const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b2]).flat())]);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
const line = (id, s, rest) => `${JSON.stringify({ id: `${id}-0000-4000-8000-000000000000`.slice(0, 36), at: at(s), ...rest })}\n`;

const RICH = `## Disk full: why

| What | Size | State |
|---|--:|---|
| Snaps | 1.5 GB | [warn] |
| npm caches | 240 MB | [ok] freed |

- **Freed**: npm caches, ==1.4 GB free== now.
- The notes are in /work/notes.md.

\`\`\`js
const free = 1.4; // GB
\`\`\`

\`\`\`mermaid
pie title Disk
"system" : 3
"snaps" : 1.5
\`\`\`

![before](/work/before.png) ![after](/work/after.png)

> [!IMPORTANT]
> Decide: grow the disk, or remove the test database.`;
/* What an agent could write to harm whoever reads: none of it may run, load, or lead elsewhere. */
const ATTACK = `<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">
[click](javascript:window.__pwned=3) [data](data:text/html,<script>parent.__pwned=4</script>) [ok](https://example.com/)
![remote](https://evil.example/track.png) ![secret](/etc/passwd.png)

\`\`\`mermaid
graph TD
A["<img src=x onerror=window.__pwned=5>"] --> B
click A call alert(1)
click B "javascript:window.__pwned=6"
\`\`\``;

test('the chat renders what the tool writes: Markdown built element by element, pictures of the shared folder only, drawings as pictures, coloured code; nothing it writes runs', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('notes');
    assert.equal((await me.api('/api/conversations/notes/talk', { on: true })).status, 200);
    const work = join(b.dir, 'data', 'work', 'notes');
    writeFileSync(join(work, 'notes.md'), '# notes\nall of it');
    writeFileSync(join(work, 'before.png'), png(320, 200, [200, 80, 60]));
    writeFileSync(join(work, 'after.png'), png(320, 200, [60, 160, 90]));
    writeFileSync(join(work, '.parley', 'from-agent.jsonl'), line('a1', 0, { kind: 'say', text: RICH, short: 'Disk full: one decision for you' }) + line('a2', 2, { kind: 'say', text: ATTACK }));
    await me.page.goto(`${b.origin}/?c=notes`);
    const thread = me.page.locator('#simple-thread');
    await me.until('its message, short first', async () => (await thread.locator('.parley-short').first().innerText().catch(() => '')) === 'Disk full: one decision for you');
    assert.match(await thread.locator('.parley-callout[data-kind=important]').first().innerText(), /Decide: grow the disk/, 'its IMPORTANT box in sight, folded');
    await thread.locator('.parley-unfold').first().click();
    const first = thread.locator('.parley-said[data-from=agent]').first();
    await me.until('unfolded: a table, badges, a highlight', async () => (await first.locator('table').count()) === 1 && (await first.locator('.parley-badge').count()) === 2 && (await first.locator('mark').count()) === 1);
    /* Its code, coloured from Prism's token tree; a Copy button. */
    await me.until('the code is coloured', async () => (await first.locator('.parley-code .parley-tok-keyword').count()) > 0);
    assert.equal(await first.locator('.parley-code pre').innerText(), 'const free = 1.4; // GB');
    /* Its drawing: by Mermaid, shown as a picture. */
    await me.until('the drawing is a picture', async () => /^blob:/.test(await first.locator('.parley-diagram img').getAttribute('src').catch(() => '') ?? ''), 30_000);
    /* Its pictures, side by side, from the shared folder, by the route of the thumbnails. */
    const pictures = first.locator('.parley-pictures img');
    assert.equal(await pictures.count(), 2);
    for (const src of await pictures.evaluateAll((all) => all.map((i) => i.getAttribute('src')))) assert.match(src, /^\/api\/files\/thumb\?c=notes&r=work&p=(before|after)\.png$/);
    await me.until('they are loaded', async () => pictures.evaluateAll((all) => all.every((i) => i.complete && i.naturalWidth === 320)));
    /* A path it cites opens the file, and it is among its files. */
    await first.locator('.parley-pathlink', { hasText: '/work/notes.md' }).click();
    await me.until('the notes are shown', async () => (await me.page.locator('#preview-body').innerText().catch(() => '')).includes('all of it'));
    await me.page.locator('#preview-close').click();
    /* A picture, large: zoomed in, moved, the next one, closed with Escape. */
    await pictures.first().click();
    const zoom = thread.locator('.parley-zoom:not(.parley-draw)');
    await me.until('large', async () => zoom.isVisible());
    await me.until('its name and place', async () => /before \(\d\/\d\)/.test(await zoom.locator('.parley-zoom-name').innerText()));
    /* Nothing of the page under it is grabbed: not the edge that widens the list. */
    assert.equal(await me.page.locator('#list-resize').isVisible(), false, 'the edge of the list, put away under a picture');
    /* Pulled sideways: the next one, then back to the first. */
    const swipe = async (by) => { const r = await zoom.locator('.parley-zoom-stage').boundingBox(); const x = r.x + r.width / 2; const y = r.y + r.height / 2; await me.page.mouse.move(x, y); await me.page.mouse.down(); await me.page.mouse.move(x + by, y, { steps: 6 }); await me.page.mouse.up(); };
    await swipe(-160);
    await me.until('the next one, by a swipe', async () => /after/.test(await zoom.locator('.parley-zoom-name').innerText()));
    await swipe(30);
    await me.page.waitForTimeout(400);
    assert.match(await zoom.locator('.parley-zoom-name').innerText(), /after/, 'not far enough: it stays');
    await swipe(160);
    await me.until('the first again', async () => /before/.test(await zoom.locator('.parley-zoom-name').innerText()));
    await zoom.locator('.parley-zoom-plus').click(); await zoom.locator('.parley-zoom-plus').click();
    await me.until('zoomed', async () => (await zoom.getAttribute('data-zoomed')) === 'true');
    await me.page.keyboard.press('ArrowRight');
    await me.until('the next picture', async () => /after/.test(await zoom.locator('.parley-zoom-name').innerText()));
    await me.page.keyboard.press('Escape');
    await me.until('closed', async () => !(await zoom.isVisible()));
    /* One tap on the picture opens it, one tap on it closes it -- zoomed in too; dragging it moves it, never closes it. */
    await pictures.first().click();
    await me.until('large again', async () => zoom.isVisible());
    await zoom.locator('.parley-zoom-plus').click(); await zoom.locator('.parley-zoom-plus').click();
    await me.until('zoomed again', async () => (await zoom.getAttribute('data-zoomed')) === 'true');
    const big = await zoom.locator('img[draggable="false"]').boundingBox();
    const cx = Math.min(big.x + big.width / 2, 600); const cy = Math.min(big.y + big.height / 2, 400);
    await me.page.mouse.move(cx, cy); await me.page.mouse.down(); await me.page.mouse.move(cx + 60, cy + 30, { steps: 5 }); await me.page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await zoom.isVisible(), true, 'moved, not closed');
    await me.page.mouse.click(cx, cy);
    await me.until('closed by a tap on the picture, zoomed in', async () => !(await zoom.isVisible()));
    /* ATTACKS: nothing it wrote ran, loaded from elsewhere, or became a link elsewhere. */
    const second = thread.locator('.parley-said[data-from=agent]').nth(1);
    await me.until('the second message', async () => (await second.innerText().catch(() => '')).includes('<script>window.'));
    await me.until('its drawing was tried', async () => (await second.locator('.parley-diagram-wait').count()) === 0, 30_000);
    await wait(500);
    assert.equal(await me.page.evaluate(() => window.__pwned), undefined, 'nothing ran');
    assert.deepEqual(await second.locator('a').evaluateAll((all) => all.map((a) => a.href)), ['https://example.com/'], 'only an http(s) link is a link');
    assert.equal(await second.locator('img:not([src^="blob:"])').count(), 0, 'no picture from elsewhere, nor from outside the shared folders');
    assert.equal(await me.page.locator('#simple-thread script, #simple-thread iframe, #simple-thread object, #simple-thread svg foreignObject').count(), 0);
    assert.equal(await me.page.evaluate(() => [...document.querySelectorAll('img')].some((i) => /evil\.example|passwd/.test(i.src))), false, 'nothing asked of another place');
    /* Its drawing with a click and a script: drawn in Mermaid's strict mode, as a picture (which runs nothing), or shown as code. */
    const drawn = second.locator('.parley-diagram img');
    if (await drawn.count()) {
        assert.match(await drawn.getAttribute('src'), /^blob:/);
        /* What Mermaid made of it, with the settings the page gave it (a picture's own bytes are out of the page's reach). */
        const code = ATTACK.split('```mermaid\n')[1].split('```')[0];
        const svg = await me.page.evaluate((c) => window.mermaid.render('clv-check', c).then((r) => r.svg), code);
        assert.doesNotMatch(svg, /<script|<img|<foreignObject|\son\w+="|href="javascript:/i, 'strict: no script, no tag of the label, no handler, no javascript: link in the drawing');
    } else assert.match(await second.locator('pre').last().innerText(), /click A call alert/);
    /* Copy, on its code. */
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await first.locator('.parley-copy').click();
    await me.until('copied', async () => (await me.page.evaluate(() => navigator.clipboard.readText())) === 'const free = 1.4; // GB');
    /* Search in the thread: Ctrl+F, found, n of m. */
    await thread.locator('.parley-box').click();
    await me.page.keyboard.press('Control+f');
    await me.page.keyboard.type('disk');
    await me.until('found', async () => /^\d+ of \d+$/.test(await thread.locator('.parley-search-count').innerText()) && (await thread.locator('mark.parley-found').count()) > 1);
    await me.page.keyboard.press('Escape');
    await me.until('search closed', async () => (await thread.locator('mark.parley-found').count()) === 0);
    /* A screenshot pasted in the box is attached, shown as a picture, named by its time. */
    await thread.locator('.parley-box').evaluate((box) => {
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
        const data = new DataTransfer(); data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await me.until('a picture above the box', async () => (await thread.locator('.parley-pending-picture img').count()) === 1);
    assert.match(await thread.locator('.parley-pending-picture img').getAttribute('alt'), /^screenshot-\d{4}-\d\d-\d\d-\d{6}\.png/);
    assert.deepEqual(me.errors, []);

    /* A device given the chat alone sees the pictures of its chat, and no other file of the folder. */
    const share = await me.api('/api/conversations/notes/share', { rights: 'rw' });
    const device = await b.person({ phone: true, at: share.body.url.replace(/^https?:\/\/[^/]+/, '') });
    await device.until('the device is welcomed', async () => device.page.locator('#notice-action', { hasText: 'Start' }).isVisible());
    await device.page.locator('#notice-action', { hasText: 'Start' }).click();
    await device.until('its chat', async () => (await device.page.locator('#simple-thread .parley-said').count()) > 0);
    const pairing = await device.page.evaluate(() => document.documentElement.dataset.pairing);
    await device.page.locator('#simple-thread .parley-unfold').first().tap();
    await device.until('its pictures are shown there too', async () => device.page.locator('#simple-thread .parley-pictures img').first().evaluate((i) => i.complete && i.naturalWidth === 320).catch(() => false));
    writeFileSync(join(work, 'private.png'), png(4, 4, [0, 0, 0]));
    assert.equal((await device.api(`/c/api/${pairing}/files/thumb?c=notes&r=work&p=before.png`)).status, 200, 'a picture placed in a message');
    assert.equal((await device.api(`/c/api/${pairing}/files/thumb?c=notes&r=work&p=private.png`)).status, 403, 'not one the chat never showed');

    /* THE REAL THREAD, replayed, for the pictures of this step (not part of the check). */
    const real = process.env.CLAVARIUM_P5_THREAD;
    const out = process.env.CLAVARIUM_P5_SHOTS;
    if (!real || !out || !existsSync(join(real, 'from-agent.jsonl'))) return;
    mkdirSync(out, { recursive: true });
    await me.create('intranet-website');
    await me.api('/api/conversations/intranet-website/talk', { on: true });
    const realWork = join(b.dir, 'data', 'work', 'intranet-website');
    for (const f of ['from-agent.jsonl', 'to-agent.jsonl']) copyFileSync(join(real, f), join(realWork, '.parley', f));
    writeFileSync(join(realWork, '.parley', 'read.json'), JSON.stringify({ lines: readFileSync(join(real, 'to-agent.jsonl'), 'utf8').split('\n').filter(Boolean).length }));
    writeFileSync(join(realWork, 'PR-DESCRIPTION.md'), '# PR');
    /* And the same answer as the tool would now write it, told the chat renders Markdown (the second set of pictures). */
    if (process.env.CLAVARIUM_P5_REWRITE && existsSync(process.env.CLAVARIUM_P5_REWRITE)) {
        await me.create('rewritten');
        await me.api('/api/conversations/rewritten/talk', { on: true });
        const w = join(b.dir, 'data', 'work', 'rewritten');
        for (const f of ['from-agent.jsonl', 'to-agent.jsonl', 'read.json']) copyFileSync(join(process.env.CLAVARIUM_P5_REWRITE, f), join(w, '.parley', f));
        writeFileSync(join(w, 'disk-before.png'), png(640, 360, [180, 70, 60])); writeFileSync(join(w, 'disk-after.png'), png(640, 360, [60, 150, 90]));
    }
    const shots = await b.person({ locale: 'fr-FR' });
    for (const [conversation, tag] of [['intranet-website', 'real'], ['rewritten', 'rewritten']]) {
        if (tag === 'rewritten' && !process.env.CLAVARIUM_P5_REWRITE) continue;
        for (const [device, w, h] of [['phone', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]]) {
            for (const scheme of ['light', 'dark']) {
                await shots.page.emulateMedia({ colorScheme: scheme });
                await shots.page.setViewportSize({ width: w, height: h });
                for (const view of ['simple', 'detailed']) {
                    await shots.page.evaluate(([v, c]) => { localStorage.setItem('clavarium-chat-view', v); localStorage.setItem('clavarium-theme', c); }, [view, scheme]);
                    await shots.page.goto(`${b.origin}/?c=${conversation}`);
                    await shots.until('the chat', async () => (await shots.page.locator('#simple-thread .parley-said').count()) > 0);
                    await wait(1500);
                    await shots.page.screenshot({ path: join(out, `p5-${tag}-${device}-${scheme}-${view}.png`) });
                }
            }
        }
    }
});

test('pictures shown together are one gallery with their titles, large one after the other and closed with a tap; a reaction is put on a message, and "stop" wakes the tool at once', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('pages');
    assert.equal((await me.api('/api/conversations/pages/talk', { on: true })).status, 200);
    const work = join(b.dir, 'data', 'work', 'pages');
    writeFileSync(join(work, 'home-before.png'), png(320, 200, [200, 80, 60]));
    writeFileSync(join(work, 'home-after.png'), png(320, 200, [60, 160, 90]));
    /* The tool shows both at once, each with its title (as "parley show a.png=title b.png=title" posts it; its paths as the machine sees them). */
    writeFileSync(join(work, '.parley', 'from-agent.jsonl'), line('g1', 0, { kind: 'show', path: '/work/home-before.png', text: 'The new header', files: [{ path: '/work/home-before.png', title: 'Home, before' }, { path: '/work/home-after.png', title: 'Home, after' }] })
        /* The same picture cited in a message after it: one picture still, in the viewer as in the media. */
        + line('g2', 1, { kind: 'say', text: 'The header, as it is now:\n\n![Home, after](/work/home-after.png)' })
        /* A message it waits on for a decision: Go ahead and Disagree under it, in sight. */
        + line('g3', 2, { kind: 'say', text: 'I propose to keep the new header. Shall I?' })
        + line('g4', 3, { kind: 'status', state: 'waiting', text: 'your decision on the header' }));
    await me.page.goto(`${b.origin}/?c=pages`);
    const thread = me.page.locator('#simple-thread');
    await me.until('one gallery, titled', async () => (await thread.locator('.parley-gallery .parley-caption').allInnerTexts()).join('|') === 'Home, before|Home, after');
    /* Large, from its thumbnail: the strip of the others, the title; a tap on the ground closes it. */
    await thread.locator('.parley-gallery img').first().click();
    const zoom = thread.locator('.parley-zoom:not(.parley-draw)');
    await me.until('large', async () => zoom.isVisible());
    assert.match(await zoom.locator('.parley-zoom-name').innerText(), /^Home, before \(1\/2\)$/);
    assert.equal(await zoom.locator('.parley-zoom-thumb').count(), 2, 'a picture shown and cited is one picture');
    /* Each button says what it does; Close apart, with its word. */
    assert.deepEqual(await zoom.locator('.parley-zoom-tools button:visible').evaluateAll((all) => all.map((x) => x.getAttribute('aria-label'))), ['Zoom out', 'Zoom in', 'Actual size', 'Fit to the screen', 'Previous', 'Next', 'Draw on it and send it']);
    assert.equal((await zoom.locator('.parley-zoom-close').innerText()).trim(), 'Close');
    await zoom.locator('.parley-zoom-thumb').nth(1).click();
    await me.until('the other one', async () => /^Home, after/.test(await zoom.locator('.parley-zoom-name').innerText()));
    await me.page.mouse.click(5, 450);
    await me.until('closed with a tap beside it', async () => !(await zoom.isVisible()));
    /* The media of the thread, from the menu: both, and back to where they were shown. */
    await thread.locator('.parley-prefs-open').click();
    await thread.locator('.parley-media-open').click();
    assert.deepEqual(await thread.locator('.parley-media-item figcaption').allInnerTexts(), ['Home, after', 'Home, before']);
    await thread.locator('.parley-media-where').first().click();
    assert.equal(await thread.locator('.parley-media').isVisible(), false);
    /* A reaction: on hover, the choice with its words; "Stop" types the line in its terminal at once. */
    const shown = thread.locator('.parley-said[data-kind=show]');
    await shown.hover();
    await shown.locator('.parley-react-open').click();
    assert.deepEqual(await thread.locator('.parley-react-choice').allInnerTexts(), ['Go ahead', 'Agree', 'Not clear', 'Love it', 'Later', 'Another way', 'Disagree', 'Stop']);
    await thread.locator('.parley-react-choice[data-reaction=agree]').click();
    await me.until('noted on the message', async () => (await shown.locator('.parley-reaction').getAttribute('data-reaction').catch(() => '')) === 'agree');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await me.screen()).includes('You have a new message'), false, 'a thumbs up wakes nobody');
    await shown.locator('.parley-reaction').click();
    await thread.locator('.parley-react-choice[data-reaction=stop]').click();
    await me.until('stop: the line typed at once', async () => (await me.screen()).includes('You have a new message: run "parley read".'), 20_000);
    /* What the tool will read: the reaction, with the words and the time of the message it is about. */
    const last = readFileSync(join(work, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([last.reaction, last.to, last.quote, typeof last.toAt], ['stop', 'g1-0000-4000-8000-000000000000'.slice(0, 36), 'The new header', 'string']);
    /* The decision it waits for, answered from under the message. */
    const asked = thread.locator('.parley-said[data-id^="g3"]');
    assert.deepEqual(await asked.locator('.parley-decide-choice').allInnerTexts(), ['Go ahead', 'Disagree']);
    await asked.locator('.parley-decide-choice[data-reaction=go]').click();
    await me.until('its reaction in place of the two', async () => (await asked.locator('.parley-reaction').getAttribute('data-reaction').catch(() => '')) === 'go' && (await asked.locator('.parley-decide').count()) === 0);
    const went = readFileSync(join(work, '.parley', 'to-agent.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([went.reaction, went.to], ['go', 'g3-0000-4000-8000-000000000000'.slice(0, 36)]);
    assert.deepEqual(me.errors, []);
    /* Drawn on and sent again: the same drawing as a picture attached, its note saying where it came from,
       the message answering the one it was in. */
    await thread.locator('.parley-gallery img').first().click();
    await me.until('large again', async () => zoom.isVisible());
    await zoom.locator('.parley-zoom-draw').click();
    const drawing = thread.locator('.parley-zoom.parley-draw');
    await me.until('the drawing is open', async () => drawing.isVisible());
    const area = await drawing.locator('canvas').boundingBox();
    await me.page.mouse.move(area.x + area.width * 0.3, area.y + area.height * 0.4); await me.page.mouse.down();
    await me.page.mouse.move(area.x + area.width * 0.6, area.y + area.height * 0.5, { steps: 5 }); await me.page.mouse.up();
    await drawing.locator('.parley-draw-note').fill('This one, smaller');
    await drawing.locator('.parley-zoom-done').click();
    await me.until('waiting in the box, drawn on', async () => (await thread.locator('.parley-pending-picture[data-marked="true"]').count()) === 1);
    assert.equal(await thread.locator('.parley-replying').isVisible(), true, 'answering the message the picture was in');
    await thread.locator('.parley-box').fill('Look');
    await thread.locator('.parley-send').click();
    await me.until('sent with its picture', async () => (await me.api('/api/conversations/pages/talk')).body.messages.some((m) => m.from === 'person' && m.text === 'Look' && m.files?.length === 1));
    const drawnSent = (await me.api('/api/conversations/pages/talk')).body.messages.find((m) => m.from === 'person' && m.text === 'Look');
    assert.match(drawnSent.files[0].note, /^This one, smaller \(drawn on Home, before, a picture of this chat\)$/);
    assert.match(drawnSent.files[0].path, /home-before-annotated\.png$/);
    assert.ok(drawnSent.re || drawnSent.answers, 'it answers the message the picture was in');
});

test('on a touch screen, a pinch on a picture in the viewer zooms the picture alone, never the page; a page zoomed all the same leaves the viewer its size', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('pinch');
    assert.equal((await me.api('/api/conversations/pinch/talk', { on: true })).status, 200);
    const work = join(b.dir, 'data', 'work', 'pinch');
    writeFileSync(join(work, 'map.png'), png(320, 200, [60, 90, 200]));
    writeFileSync(join(work, '.parley', 'from-agent.jsonl'), line('p1', 0, { kind: 'show', path: '/work/map.png', text: 'The map', files: [{ path: '/work/map.png', title: 'Map' }] }));
    await me.page.goto(`${b.origin}/?c=pinch`);
    const thread = me.page.locator('#simple-thread');
    await me.until('the picture', async () => (await thread.locator('.parley-said[data-kind=show] img').count()) > 0);
    await thread.locator('.parley-said[data-kind=show] img').first().click();
    const zoom = thread.locator('.parley-zoom:not(.parley-draw)');
    await me.until('large', async () => zoom.isVisible());
    await me.until('fitted', async () => (await zoom.locator('.parley-zoom-stage img').evaluate((i) => i.complete && i.naturalWidth > 0)));
    await wait(300);
    const barBefore = (await zoom.locator('.parley-zoom-bar').boundingBox()).height;
    const scaleOf = () => zoom.locator('.parley-zoom-stage img').evaluate((i) => new DOMMatrix(getComputedStyle(i).transform).a);
    const fitted = await scaleOf();
    const text = await me.page.evaluate(() => window.clavariumText().scale);
    /* Two fingers on the picture, moved apart: the browser's own touch events. */
    const box = await zoom.locator('.parley-zoom-stage img').boundingBox();
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
    const cdp = await me.context.newCDPSession(me.page);
    const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] });
    await touch('touchStart', 20);
    for (let d = 30; d <= 120; d += 10) { await touch('touchMove', d); await wait(16); }
    await touch('touchEnd', 120);
    await me.until('the picture is zoomed', async () => (await scaleOf()) > fitted * 2);
    assert.equal(await zoom.getAttribute('data-zoomed'), 'true');
    assert.equal(await me.page.evaluate(() => window.visualViewport.scale), 1, 'the page did not zoom');
    assert.equal(await me.page.evaluate(() => window.clavariumText().scale), text, 'the text of the page did not grow');
    const barAfter = (await zoom.locator('.parley-zoom-bar').boundingBox()).height; assert.ok(Math.abs(barAfter - barBefore) < 1, `its bars kept their size (${barAfter} for ${barBefore})`);
    /* The page zoomed all the same (a browser that forces it): the viewer is sized back to the screen. */
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await me.until('the page is zoomed', async () => (await me.page.evaluate(() => window.visualViewport.scale)) > 1.9);
    await me.until('the viewer kept its size', async () => (await zoom.getAttribute('data-kept')) === 'true');
    const kept = await me.page.evaluate(() => { const r = document.querySelector('#simple-thread .parley-zoom-bar').getBoundingClientRect(); const v = window.visualViewport; return { height: r.height * v.scale, left: r.left - v.offsetLeft, width: document.querySelector('#simple-thread .parley-zoom').getBoundingClientRect().width * v.scale, screen: v.width * v.scale }; });
    assert.ok(Math.abs(kept.height - barBefore) < 1.5, `its bars as tall on the screen (${kept.height} for ${barBefore})`);
    assert.ok(Math.abs(kept.left) < 1.5 && Math.abs(kept.width - kept.screen) < 1.5, 'across the screen, where the screen is');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await zoom.locator('.parley-zoom-close').click();
    assert.equal(await zoom.isVisible(), false);
    assert.deepEqual(me.errors, []);
});
