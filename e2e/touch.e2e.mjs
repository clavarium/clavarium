import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

/* A finger dragged over the terminal, as a touch screen reports it. */
async function drag(person, fromY, toY) {
    await person.page.evaluate(async ([from, to]) => {
        const area = document.getElementById('terminal');
        const box = area.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const touch = (y) => new Touch({ identifier: 1, target: area, clientX: x, clientY: box.top + y });
        const fire = (type, y, list) => area.dispatchEvent(new TouchEvent(type, { touches: list, changedTouches: [touch(y)], bubbles: true, cancelable: true }));
        fire('touchstart', from, [touch(from)]);
        const steps = 12;
        for (let i = 1; i <= steps; i++) { const y = from + ((to - from) * i) / steps; fire('touchmove', y, [touch(y)]); await new Promise((r) => setTimeout(r, 15)); }
        fire('touchend', to, []);
    }, [fromY, toY]);
}
const viewportY = (person) => person.page.evaluate(() => window.clavariumTerminal.buffer.active.viewportY);

test('a finger scrolls the terminal as a wheel does: down the screen to go back, up to return', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('long-output');
    /* tmux keeps the history: the wheel is passed to it, which scrolls back. */
    await me.type('seq 1 300');
    /* "300" is in the command itself: waited for as the last line printed. */
    await me.printed('300');
    assert.ok(!/^120$/m.test(await visibleNow(me)), 'line 120 is far above at first');
    await drag(me, 80, 380);                     /* the finger goes down: earlier lines come */
    /* tmux scrolls back and redraws when it can: waited for, not timed. */
    await me.until('the last line has left the screen', async () => !/^300$/m.test(await visibleNow(me)));
    await drag(me, 380, 80);                     /* and back */
    await drag(me, 380, 80);
    await me.until('the last line is back on the screen', async () => /^300$/m.test(await visibleNow(me)));
});

test('a tool that asked for the mouse receives the finger as its wheel', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('mouse-tool');
    /* The tool asks for mouse reports, then shows whatever arrives. */
    /* "listening" comes out after the request for the mouse, in order: once
       it is on the screen, the request has reached tmux. */
    await me.type("printf '\\033[?1000h\\033[?1006h'; echo listening; cat -v");
    await me.sees('\nlistening');
    await drag(me, 100, 300);
    await me.sees('[<64;', 5000);                /* wheel up, as a terminal reports it */
    await drag(me, 300, 100);
    await me.sees('[<65;', 5000);                /* wheel down */
});

test('what was copied elsewhere is pasted into the terminal, by the button or through the field', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('pasting');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await me.page.evaluate(() => navigator.clipboard.writeText('echo pasted-by-button'));
    await me.more();
    await me.page.locator('#copy-open').click();
    await me.page.locator('#paste-now').click();
    await me.sees('echo pasted-by-button');
    await me.page.keyboard.press('Enter');
    await me.until('the command ran', async () => (await me.screen()).split('pasted-by-button').length >= 3);
    /* Without the permission, the field does the same job. */
    await me.context.clearPermissions();
    await me.more();
    await me.page.locator('#copy-open').click();
    await me.page.fill('#paste-text', 'echo pasted-by-field');
    await me.page.locator('#paste-send').click();
    await me.sees('echo pasted-by-field');
    await me.page.keyboard.press('Enter');
    await me.until('the second command ran', async () => (await me.screen()).split('pasted-by-field').length >= 3).catch(async (e) => { throw new Error(`${e.message}; screen: ${JSON.stringify((await me.screen()).trim().slice(-200))}; sheet shown: ${await me.page.locator('#copy').isVisible()}; field: ${JSON.stringify(await me.page.inputValue('#paste-text'))}`); });
    assert.equal(await me.page.locator('#copy').isVisible(), false, 'the sheet closes itself after a paste');
});

test('an Enter pressed while the browser is still reading what was copied does not paste a second time', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('hasty');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    /* A slow clipboard, as when the browser asks first. */
    await me.page.evaluate(() => { navigator.clipboard.readText = () => new Promise((done) => setTimeout(() => done('pasted-once'), 700)); });
    await me.more();
    await me.page.locator('#copy-open').click();
    await me.page.locator('#paste-now').click();
    await me.page.keyboard.press('Enter');
    await me.page.keyboard.press('Enter');
    await me.sees('pasted-once');
    await wait(900);
    assert.equal((await me.screen()).split('pasted-once').length, 2, 'pasted once');
});

/* The lines currently shown, top to bottom. */
async function visibleNow(person) {
    return person.page.evaluate(() => { const t = window.clavariumTerminal, buffer = t.buffer.active; let s = ''; for (let i = buffer.viewportY; i < buffer.viewportY + t.rows; i++) s += `${(buffer.getLine(i)?.translateToString(true) ?? '').trim()}\n`; return s; });
}

test('on a touch screen the on-screen keyboard comes on demand: a finger on the terminal does not call it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('quiet');
    const field = () => me.page.evaluate(() => ({ mode: window.clavariumTerminal.textarea.getAttribute('inputmode'), focused: document.activeElement === window.clavariumTerminal.textarea }));
    assert.equal(await me.page.locator('#kbd').isVisible(), true);
    assert.equal((await field()).mode, 'none', 'the browser is told not to raise its keyboard');
    /* A finger on the terminal: it takes the focus (keys still arrive), the hint stays. */
    const box = await me.page.locator('#terminal').boundingBox();
    await me.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual(await field(), { mode: 'none', focused: true });
    /* The key row and a real keyboard go on working without it. */
    await me.type('echo no-keyboard-needed');
    await me.sees('\nno-keyboard-needed');
    /* Asked for: raised, and the button says how to put it away. */
    await me.page.locator('#kbd').tap();
    assert.deepEqual(await field(), { mode: 'text', focused: true });
    assert.equal(await me.page.locator('#kbd').innerText(), 'Hide keyboard');
    await me.page.locator('#kbd').tap();
    assert.equal((await field()).mode, 'none');
    assert.equal(await me.page.locator('#kbd').innerText(), 'Keyboard');
});

/* THE LOCK HOLDS ON EVERY PATH. The owner saw the on-screen keyboard come
   back "after some commands". Each way the page gives the focus back, or
   used to put it in a field by itself, is gone through here with the lock
   on: the helper field of the terminal must still say inputmode "none", and
   no field that raises a keyboard may have taken the focus unasked. */
const lockOf = (person) => person.page.evaluate(() => ({ mode: window.clavariumTerminal.textarea.getAttribute('inputmode'), button: document.getElementById('kbd').textContent }));
/* Records every field that took the focus; read and emptied by `unasked`. */
const recordFocus = (person) => person.page.evaluate(() => {
    window.focusedUnasked = [];
    document.addEventListener('focusin', (event) => {
        const field = event.target;
        if (field === window.clavariumTerminal.textarea) {
            if (field.getAttribute('inputmode') !== 'none') window.focusedUnasked.push('the terminal, without the lock');
            return;
        }
        const typed = field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit'].includes(field.type));
        if (typed && !field.readOnly) window.focusedUnasked.push(field.id || field.getAttribute('aria-label') || field.tagName);
    }, true);
});
const unasked = (person) => person.page.evaluate(() => window.focusedUnasked.splice(0));

test('with the lock on, nothing the page does brings the on-screen keyboard back', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('locked', 'Shell', { onDisk: true });
    await recordFocus(me);
    const LOCKED = { mode: 'none', button: 'Keyboard' };
    const holds = async (path) => {
        await wait(50);   /* a watcher answers after the change that woke it */
        assert.deepEqual(await lockOf(me), LOCKED, `the lock holds: ${path}`);
        assert.deepEqual(await unasked(me), [], `no field took the focus by itself: ${path}`);
    };
    const tap = (selector) => me.page.locator(selector).tap();
    await holds('at first');

    /* A key of the row, then a shortcut, then its own form, which used to put the cursor in its first field. */
    await tap('#keys button[data-keys="enter"]');
    await holds('a key of the row');
    await me.until('the shortcut row is painted', async () => (await me.page.locator('#shortcut-row button.quiet').count()) > 0);
    await me.more();
    await me.page.locator('#shortcut-row button.quiet', { hasText: '+ Shortcut' }).tap();
    await holds('the form of a new shortcut opens');
    await me.page.fill('#shortcut-label', 'Hello');
    await me.page.fill('#shortcut-text', 'echo from-a-shortcut');
    await unasked(me);   /* filled as a person does, by touching them */
    await me.page.locator('#shortcut-new button[type=submit]').tap();
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Hello' }).tap();
    await me.sees('\nfrom-a-shortcut');
    await holds('a shortcut sent');

    /* Commands that redraw the whole screen. */
    await me.type('clear; echo cleared-now');
    await me.printed('cleared-now');
    await me.page.evaluate(() => window.clavariumTerminal.reset());
    await holds('clear, and a reset of the terminal');

    /* Should anything rewrite the hint of the helper field, or take it away, the lock is put back. */
    await me.page.evaluate(() => window.clavariumTerminal.textarea.setAttribute('inputmode', 'text'));
    await holds('the hint rewritten from outside');
    await me.page.evaluate(() => window.clavariumTerminal.textarea.removeAttribute('inputmode'));
    await holds('the hint removed from outside');

    /* The screen turned, and back. */
    await me.page.setViewportSize({ width: 780, height: 390 });
    await me.page.setViewportSize({ width: 390, height: 780 });
    await holds('a resize');

    /* Sheets and windows that give the focus back when they close. */
    await tap('#view-assets'); await tap('#view-terminal');
    await holds('Assets closed');
    await me.menu(); await tap('#folders');
    await me.chapter('wakeups');
    await me.page.locator('#wakeups-new-box summary').tap();
    await me.page.selectOption('#wakeup-kind', 'cron');
    await me.page.selectOption('#wakeup-often', 'custom');
    await holds('a wake-up "by the clock", written by hand');
    await tap('#panel-close');
    await holds('the panel closed');
    await me.more(); await tap('#copy-open');
    /* The browser does not let the page read the clipboard here: it says
       so, and used to put the cursor in the field below. */
    await tap('#paste-now');
    await me.until('the refusal is said', async () => /did not let/.test(await me.page.locator('#paste-status').innerText()));
    await holds('pasting refused by the browser');
    await tap('#copy-close');
    await holds('Copy / paste closed');
    writeFileSync(join(b.dir, 'vms', 'clv-locked', 'root', 'work', 'note.txt'), 'a note\n');
    await me.type('clear; echo "See /work/note.txt"');
    await me.printed('See /work/note.txt');
    const at = await me.page.evaluate(() => {
        const t = window.clavariumTerminal; const buffer = t.buffer.active;
        for (let row = t.rows - 1; row >= 0; row--) {
            const col = (buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').lastIndexOf('/work/note.txt');
            if (col < 0) continue;
            const box = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: box.left + ((col + 7) * box.width) / t.cols, y: box.top + ((row + 0.5) * box.height) / t.rows };
        }
        return null;
    });
    await me.page.touchscreen.tap(at.x, at.y);
    await me.until('the file is shown', async () => /a note/.test(await me.page.locator('#preview-body').innerText().catch(() => '')));
    await tap('#preview-close');
    await holds('a file shown, then closed');

    /* A notice answered: archiving asked, then cancelled. */
    await me.menu(); await tap('#folders'); await me.chapter('advanced'); await tap('#archive');
    await tap('#notice-cancel');
    await holds('a notice cancelled');

    /* Asleep, then woken: the terminal is opened again. */
    await me.menu(); await tap('#folders'); await tap('#sleep');
    await me.until('asleep', async () => (await me.state()) === 'asleep');
    await me.page.locator('#notice-action', { hasText: 'Wake it' }).tap();
    await me.until('awake', async () => (await me.state()) === 'live');
    await holds('a wake-up');

    /* The tool left, and started again. */
    await me.type('exit');
    await me.until('the tool has exited', async () => (await me.page.locator('#notice-action').innerText()) === 'Start it again');
    await tap('#notice-action');
    await me.until('live again', async () => (await me.state()) === 'live');
    await holds('the tool started again');

    /* A reload remembers nothing, and starts locked. */
    await me.page.reload();
    await me.until('live after a reload', async () => (await me.state()) === 'live');
    await recordFocus(me);
    await holds('a reload');
    assert.deepEqual(me.errors, []);
});

test('a keyboard put away by the system puts the lock back on: the next key does not raise it again', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('put-away');
    /* The visible height, as the browser reports it while its keyboard comes and goes. */
    const viewport = (height) => me.page.evaluate((h) => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => h });
        window.visualViewport.dispatchEvent(new Event('resize'));
    }, height);
    await me.page.locator('#kbd').tap();
    assert.deepEqual(await lockOf(me), { mode: 'text', button: 'Hide keyboard' });
    await viewport(780); await viewport(430);
    /* Still up: a key of the row leaves it as asked (the lock is off). */
    await me.page.locator('#keys button[data-keys="esc"]').tap();
    assert.deepEqual(await lockOf(me), { mode: 'text', button: 'Hide keyboard' });
    /* Put away with the system's own button: the page sees the height come back. */
    await viewport(780);
    assert.deepEqual(await lockOf(me), { mode: 'none', button: 'Keyboard' });
    await me.page.locator('#keys button[data-keys="esc"]').tap();
    assert.deepEqual(await lockOf(me), { mode: 'none', button: 'Keyboard' });
});

test('with the lock off, a field opened for typing still takes the cursor', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('unlocked');
    await me.page.locator('#kbd').tap();
    await me.until('the shortcut row is painted', async () => (await me.page.locator('#shortcut-row button.quiet').count()) > 0);
    await me.more();
    await me.page.locator('#shortcut-row button.quiet', { hasText: '+ Shortcut' }).tap();
    assert.equal(await me.page.evaluate(() => document.activeElement?.id), 'shortcut-label');
});

test('with a mouse and a real keyboard nothing changes: no button, no hint', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('desk');
    assert.equal(await me.page.locator('#kbd').isVisible(), false);
    assert.equal(await me.page.evaluate(() => window.clavariumTerminal.textarea.getAttribute('inputmode')), null);
    /* A field opened for typing takes the cursor, as before. */
    await me.page.locator('#new').click();
    await me.until('the name of a new conversation takes the cursor', async () => (await me.page.evaluate(() => document.activeElement?.id)) === 'create-name');
});

/* Where on the page a piece of text of the terminal starts and ends. */
async function spanOf(page, text) {
    return page.evaluate((wanted) => {
        const t = window.clavariumTerminal; const buffer = t.buffer.active;
        for (let row = t.rows - 1; row >= 0; row--) {
            const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
            const col = line.lastIndexOf(wanted);
            if (col < 0) continue;
            const box = document.querySelector('.xterm-screen').getBoundingClientRect();
            const x = (c) => box.left + ((c + 0.5) * box.width) / t.cols;
            return { from: x(col), to: x(col + wanted.length - 1), y: box.top + ((row + 0.5) * box.height) / t.rows };
        }
        return null;
    }, text);
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
/* Selects a text with the mouse, Shift held, once, and waits for it to be
   copied. The screen must be still (see `printed` and `fullSize` in
   bench.mjs): a selection made while the output still arrives, or while tmux
   redraws the screen, is dropped. It used to be made again up to five times,
   which hid the redraws (see answerForAbsentScreen in bridge.mjs). */
async function mouseSelect(me, text) {
    const at = await spanOf(me.page, text);
    assert.ok(at, `${text} is on the screen`);
    await me.page.keyboard.down('Shift');
    await me.page.mouse.move(at.from - 3, at.y); await me.page.mouse.down(); await me.page.mouse.move(at.to + 3, at.y, { steps: 6 }); await me.page.mouse.up();
    await me.page.keyboard.up('Shift');
    await me.until(`${text} is copied`, async () => (await clipboard(me.page)) === text, 5000).catch(async (e) => {
        throw new Error(`${e.message}: ${JSON.stringify(await me.page.evaluate(async () => ({ selected: window.clavariumTerminal.getSelection(), focus: document.hasFocus(), sheet: !document.getElementById('copy').hidden, viewer: !document.getElementById('viewer').hidden, notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent, clip: await navigator.clipboard.readText().catch((err) => String(err)) })))}`);
    });
}

/* A finger put down and HELD, as the browser tells a page, until the page
   shows it took it for a long press (something is selected) -- as a person
   waits for the highlight before moving. A fixed hold (700 ms) assumed the
   page's own timer had fired by then; on a busy machine it may not have,
   and the move then cancels the press. Returns what moves and lifts that finger. */
async function press(me, x, y) {
    const client = await me.page.context().newCDPSession(me.page);
    const send = (type, at) => client.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [at] });
    await send('touchStart', { x, y });
    await me.until('the long press is taken', () => me.page.evaluate(() => window.clavariumTerminal.hasSelection()), 5000);
    return { move: (to) => send('touchMove', { x: to, y }), lift: () => send('touchEnd') };
}

test('a long press selects, the finger stretches the selection, lifting it copies', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('select');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await me.type('clear; echo "token: abc-123-def and more"');
    await me.printed('token: abc-123-def and more');
    const at = await spanOf(me.page, 'abc-123-def and');
    /* Held on the first word, then dragged to the end of "and". */
    const held = await press(me, at.from + 2, at.y);
    await held.move((at.from + at.to) / 2); await held.move(at.to);
    await held.lift();
    /* Copying goes through the clipboard, which answers when it answers: waited for. */
    await me.until('the selection is copied', async () => (await clipboard(me.page)) === 'abc-123-def and', 5000);
    assert.equal(await me.page.evaluate(() => window.clavariumTerminal.getSelection()), 'abc-123-def and');
    assert.match(await me.page.locator('#flash').innerText(), /Copied: 15 characters/);
    /* A long press alone takes the word under the finger. */
    const word = await spanOf(me.page, 'abc-123-def');
    await (await press(me, word.from + 30, word.y)).lift();
    await me.until('the word is copied', async () => (await clipboard(me.page)) === 'abc-123-def', 5000);
    /* A short drag is still a scroll, not a selection; a tap clears what was
       selected. The finger goes down and moves in one go, in the page: a
       stalled browser cannot then let the long press fire between the two,
       which a person's quick swipe never allows either. */
    assert.equal(await me.page.evaluate(() => window.clavariumTerminal.hasSelection()), true);
    await me.page.evaluate(([x, y]) => {
        const area = document.getElementById('terminal');
        const touch = (at) => new Touch({ identifier: 2, target: area, clientX: x, clientY: at });
        const fire = (type, at, list) => area.dispatchEvent(new TouchEvent(type, { touches: list, changedTouches: [touch(at)], bubbles: true, cancelable: true }));
        fire('touchstart', y, [touch(y)]);
        fire('touchmove', y - 60, [touch(y - 60)]);
        fire('touchend', y - 60, []);
    }, [word.from, word.y]);
    assert.equal(await me.page.evaluate(() => window.clavariumTerminal.hasSelection()), false);
    /* Had the long press fired late after all, it would select and copy on its own: given the time to. */
    await wait(800);
    assert.equal(await me.page.evaluate(() => window.clavariumTerminal.hasSelection()), false);
    assert.equal(await clipboard(me.page), 'abc-123-def', 'nothing new was copied');
});

test('with a mouse, text selected with Shift held is copied when the button is released', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('desk-select');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await me.type('clear; echo "order 7741-B is ready"');
    await me.printed('order 7741-B is ready');
    await mouseSelect(me, '7741-B');
    assert.match(await me.page.locator('#flash').innerText(), /Copied: 6 characters/);
});

test('what was selected is offered for what it is: a web address opens elsewhere, a file opens here; nothing else is offered', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('offers');
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await me.type('echo "the report" > report.txt; mkdir -p out; echo deep > out/q3.txt; clear; echo "See https://example.com/docs/page?x=1 for more."; echo "Wrote report.txt and out/q3.txt"; echo "bad: javascript:alert(1) and https://user:pw@example.org/x end"; echo "also ftp://example.net/f end"; echo "plain words here"');
    await me.printed('plain words here');
    const select = async (text) => { await mouseSelect(me, text); return me.page.locator('#flash-act'); };
    /* A web address: the button names the site, and it opens in another tab. */
    const link = await select('https://example.com/docs/page?x=1');
    assert.equal(await link.innerText(), 'Open example.com');
    const [popup] = await Promise.all([me.context.waitForEvent('page'), link.click()]);
    assert.equal(popup.url().startsWith('https://example.com/docs/page?x=1') || popup.url() === 'about:blank', true);
    assert.equal(await popup.evaluate(() => window.opener), null, 'the other tab knows nothing of this one');
    await popup.close();
    await me.page.bringToFront();      /* back on this tab, as the person is: a page out of sight may not write what is copied */
    /* A file, by a relative name: shown in the window of this page. */
    const file = await select('report.txt');
    assert.equal(await file.innerText(), 'Show the file');
    await file.click();
    await me.until('the file is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('the report'));
    await me.page.locator('#preview-close').click();
    const deep = await select('out/q3.txt');
    await deep.click();
    await me.until('the deeper file is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('deep'));
    await me.page.locator('#preview-close').click();
    /* What must never be offered: another scheme, an address carrying a name and a password, plain words. */
    for (const text of ['javascript:alert(1)', 'https://user:pw@example.org/x', 'ftp://example.net/f', 'plain words']) {
        const none = await select(text);
        assert.equal(await none.isVisible(), false, text);
    }
    assert.deepEqual(me.errors, []);
});
