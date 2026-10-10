import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    await me.sees('300');
    const before = await me.screen();
    assert.ok(!/^120$/m.test(visible(before, me)), 'line 120 is far above at first');
    await drag(me, 80, 380);                     /* the finger goes down: earlier lines come */
    await wait(600);
    const after = await visibleNow(me);
    assert.ok(!/^300$/m.test(after), `the last line has left the screen: ${JSON.stringify(after.slice(-80))}`);
    await drag(me, 380, 80);                     /* and back */
    await drag(me, 380, 80);
    await wait(600);
    assert.match(await visibleNow(me), /^300$/m);
});

test('a tool that asked for the mouse receives the finger as its wheel', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('mouse-tool');
    /* The tool asks for mouse reports, then shows whatever arrives. */
    await me.type("printf '\\033[?1000h\\033[?1006h'; cat -v");
    await wait(500);
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
    await me.page.locator('#copy-open').click();
    await me.page.locator('#paste-now').click();
    await me.page.keyboard.press('Enter');
    await me.sees('pasted-by-button\npasted-by-button'.split('\n')[0]);
    await me.until('the command ran', async () => (await me.screen()).split('pasted-by-button').length >= 3);
    /* Without the permission, the field does the same job. */
    await me.context.clearPermissions();
    await me.page.locator('#copy-open').click();
    await me.page.fill('#paste-text', 'echo pasted-by-field');
    await me.page.locator('#paste-send').click();
    await me.page.keyboard.press('Enter');
    await me.until('the second command ran', async () => (await me.screen()).split('pasted-by-field').length >= 3).catch(async (e) => { throw new Error(`${e.message}; screen: ${JSON.stringify((await me.screen()).trim().slice(-200))}; sheet shown: ${await me.page.locator('#copy').isVisible()}; field: ${JSON.stringify(await me.page.inputValue('#paste-text'))}`); });
    assert.equal(await me.page.locator('#copy').isVisible(), false, 'the sheet closes itself after a paste');
});

/* The lines currently shown, top to bottom. */
function visible(text) { return text; }
async function visibleNow(person) {
    return person.page.evaluate(() => { const t = window.clavariumTerminal, buffer = t.buffer.active; let s = ''; for (let i = buffer.viewportY; i < buffer.viewportY + t.rows; i++) s += `${(buffer.getLine(i)?.translateToString(true) ?? '').trim()}\n`; return s; });
}
