/* THE SCREEN ITSELF: keys that repeat when held, one text size for the whole
   page and its terminal, a phone that gives the terminal the room, and the
   settings of a conversation in chapters that fold. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { bench, SKIP, wait } from './bench.mjs';

const pane = (name) => spawnSync('tmux', ['-L', `e2e-clv-${name}`.slice(0, 40), 'list-panes', '-a', '-F', '#{pane_width}x#{pane_height}'], { encoding: 'utf8' }).stdout.trim();
const text = (me) => me.page.evaluate(() => window.clavariumText());

test('an arrow held down repeats, as on a keyboard, and stops when let go or when the pointer leaves it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('held');
    const up = me.page.locator('#keys button[data-keys="up"]');
    const box = await up.boundingBox();
    /* Counts the arrows that arrive within three seconds (three characters each). */
    const count = async (hold) => {
        await me.type('clear; echo armed; read -rs -t 3 -N 600 k; printf "COUNT-%s-END\\n" "$(( ${#k} / 3 ))"');
        await me.sees('\narmed');
        await me.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await me.page.mouse.down();
        await hold();
        await me.page.mouse.up();
        await me.until('counted', async () => /COUNT-\d+-END/.test(await me.screen()), 8000);
        return Number(/COUNT-(\d+)-END/.exec(await me.screen())[1]);
    };
    /* A second held: one at once, then after 400 ms one every 60 ms (some ten in all). */
    const held = await count(() => wait(1000));
    assert.ok(held >= 4 && held <= 16, `held one second: ${held}`);
    /* Held one second, then the pointer leaves the key for another second: it stopped when it left. */
    const left = await count(async () => { await wait(1000); await me.page.mouse.move(box.x + box.width / 2, box.y - 80); await wait(1200); });
    assert.ok(left >= 4 && left <= 16, `stopped when the pointer left: ${left}`);
    /* A plain click is one key, as before. */
    const once = await count(() => wait(50));
    assert.equal(once, 1);
    assert.deepEqual(me.errors, []);
});

test('the size of the text is one setting of the device: every text and the terminal follow, and the machine is told its new size', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('reader');
    const before = await me.page.evaluate(() => window.clavariumTerminal.cols);
    assert.deepEqual(await text(me), { scale: 1, terminal: 14 });
    await me.page.locator('#settings-open').click();
    await me.page.locator('#settings-text button[data-text="larger"]').click();
    assert.deepEqual(await text(me), { scale: 1.1, terminal: 15.5 });
    assert.equal(await me.page.locator('#settings-text .text-now').innerText(), '110%');
    /* Every text: the page's root size, in which all of it is written. */
    assert.equal(await me.page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '17.6px');
    assert.equal(await me.page.evaluate(() => getComputedStyle(document.getElementById('settings-close')).fontSize), '14.3px');
    await me.page.locator('#settings-close').click();
    await me.until('the terminal has fewer columns', async () => (await me.page.evaluate(() => window.clavariumTerminal.cols)) < before);
    await me.fullSize('reader');
    /* Ctrl + and Ctrl -, taken by the page: nothing reaches the tool. */
    await me.page.locator('#terminal').click();
    await me.page.keyboard.press('Control+Equal');
    assert.equal((await text(me)).scale, 1.25);
    await me.page.keyboard.press('Control+Minus');
    await me.page.keyboard.press('Control+Minus');
    await me.page.keyboard.press('Control+Minus');
    assert.deepEqual(await text(me), { scale: 0.9, terminal: 12.5 });
    /* Ctrl and the wheel. */
    await me.page.keyboard.down('Control');
    await me.page.mouse.wheel(0, -120);
    await me.page.keyboard.up('Control');
    assert.equal((await text(me)).scale, 1);
    await me.page.keyboard.press('Control+Minus');
    await me.until('the machine has the new size', async () => pane('reader') === await me.page.evaluate(() => `${window.clavariumTerminal.cols}x${window.clavariumTerminal.rows}`));
    await me.type('echo typed-after');
    await me.printed('typed-after');
    assert.match(await me.screen(), /ready> echo typed-after\n/, 'no key of the size went to the tool');
    /* Kept on this device. */
    await me.page.reload();
    await me.until('live again', async () => (await me.state()) === 'live');
    assert.deepEqual(await text(me), { scale: 0.9, terminal: 12.5 });
    await me.page.locator('#settings-open').click();
    await me.page.locator('#settings-text button[data-text="normal"]').click();
    assert.deepEqual(await text(me), { scale: 1, terminal: 14 });
    assert.deepEqual(me.errors, []);
});

test('on a phone the terminal has the room: one line of bar, one line of keys, the rest when asked or when the tool asks', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('pocket');
    const layout = () => me.page.evaluate(() => {
        /* How many lines things sit on: a thing that starts below the bottom of another starts a new line. */
        const tops = (selector) => {
            const boxes = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).sort((x, y) => x.top - y.top);
            const lines = [];
            for (const box of boxes) if (!lines.length || box.top >= lines.at(-1).bottom - 1) lines.push({ bottom: box.bottom }); else lines.at(-1).bottom = Math.max(lines.at(-1).bottom, box.bottom);
            return lines;
        };
        return {
            terminal: document.getElementById('terminal').getBoundingClientRect().height / innerHeight,
            header: document.querySelector('header').getBoundingClientRect().height,
            headerLines: tops('header > *').length,
            keyLines: tops('#keys > button').length,
            shortcuts: document.getElementById('shortcuts').offsetParent !== null,
            sideways: document.documentElement.scrollWidth > innerWidth,
        };
    });
    const first = await layout();
    assert.ok(first.terminal >= 0.7, `the terminal takes ${Math.round(first.terminal * 100)}% of the height`);
    assert.equal(first.headerLines, 1);
    assert.ok(first.header <= 56, `the bar is ${first.header} px high`);
    assert.equal(first.keyLines, 1);
    assert.equal(first.shortcuts, false, 'ready-made answers wait until they are wanted');
    assert.equal(first.sideways, false);
    for (const hidden of ['#files-open', '#folders', '#simple-toggle', '#copy-open', '#keys button[data-keys="tab"]']) assert.equal(await me.page.locator(hidden).isVisible(), false, hidden);
    /* "More": the other keys, and the ready-made answers. */
    await me.page.locator('#keys-more').tap();
    for (const shown of ['#copy-open', '#keys button[data-keys="tab"]', '#keys button[data-keys="backspace"]', '#keys button[data-keys="stop"]', '#shortcuts']) assert.equal(await me.page.locator(shown).isVisible(), true, shown);
    await me.page.locator('#keys-more').tap();
    assert.equal(await me.page.locator('#shortcuts').isVisible(), false);
    /* The tool rings when it waits for an answer: they come by themselves, and go once something is sent. */
    await me.type("printf '\\a'; echo rang");
    await me.sees('\nrang');
    await me.until('the ready-made answers come', async () => me.page.locator('#shortcuts').isVisible());
    await me.page.locator('#keys button[data-keys="enter"]').tap();
    await me.until('and go', async () => !(await me.page.locator('#shortcuts').isVisible()));
    /* The bar's "...": Files, this conversation, the text size; a touch elsewhere folds it. */
    await me.page.locator('#menu').tap();
    for (const shown of ['#files-open', '#folders', '#simple-toggle', '#menu-items .text-size']) assert.equal(await me.page.locator(shown).isVisible(), true, shown);
    await me.page.locator('#terminal').tap();
    assert.equal(await me.page.locator('#files-open').isVisible(), false);
    /* Larger text, by its buttons then by two fingers: laid out again, never sideways. */
    await me.page.locator('#menu').tap();
    for (let i = 0; i < 3; i++) await me.page.locator('#menu-items .text-size button[data-text="larger"]').tap();
    assert.equal((await text(me)).scale, 1.4);
    const client = await me.page.context().newCDPSession(me.page);
    const fingers = (type, spread) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 195 - spread, y: 300, id: 1 }, { x: 195 + spread, y: 300, id: 2 }] });
    await fingers('touchStart', 40);
    for (const spread of [50, 60, 70]) await fingers('touchMove', spread);
    await fingers('touchEnd', 70);
    await me.until('the pinch is taken', async () => (await text(me)).scale > 2);
    const big = await layout();
    assert.equal(big.sideways, false, 'nothing to scroll sideways');
    assert.equal(big.headerLines, 1);
    assert.equal(big.keyLines, 1);
    assert.ok((await text(me)).terminal > 22, 'the terminal follows');
    await me.until('the machine has the new size', async () => pane('pocket') === await me.page.evaluate(() => `${window.clavariumTerminal.cols}x${window.clavariumTerminal.rows}`));
    assert.deepEqual(me.errors, []);
});

test('the settings of a conversation are chapters that fold; what is folded is kept on this device', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('tidy');
    await me.page.locator('#folders').click();
    const open = () => me.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('details.chapter')].map((d) => [d.dataset.chapter, d.open])));
    assert.deepEqual(await open(), { general: true, machine: true, access: true, wakeups: false, answerer: false, sharing: false, advanced: false });
    await me.until('General says what it is', async () => /Name\s+tidy[\s\S]*Tool\s+Shell[\s\S]*768 MB of memory, 8 GB disk/.test(await me.page.locator('#general-facts').innerText()));
    await me.page.locator('#chapter-wakeups > summary').click();
    await me.page.locator('#chapter-machine > summary').click();
    assert.equal(await me.page.locator('#sleep').isVisible(), false, 'folded away');
    await me.page.locator('#panel-close').click();
    await me.page.reload();
    await me.until('live again', async () => (await me.state()) === 'live');
    await me.page.locator('#folders').click();
    assert.deepEqual(await open(), { general: true, machine: false, access: true, wakeups: true, answerer: false, sharing: false, advanced: false });
    await me.chapter('machine');
    assert.equal(await me.page.locator('#sleep').isVisible(), true);
    assert.equal(await me.page.locator('#restart').isVisible(), true);
    assert.deepEqual(me.errors, []);
});
