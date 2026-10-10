import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';
import { toWav, RATE } from '../web/voice-core.js';

test('shortcuts: one is sent with Enter, another is left to be completed; both can be removed', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('shortcuts');
    assert.deepEqual(await me.page.locator('#shortcut-row button.saved').allInnerTexts(), ['Yes, go on', 'Run the tests', 'Summarise']);
    const add = async (label, text, enter) => {
        await me.page.locator('#shortcut-row button', { hasText: '+ Shortcut' }).click();
        assert.equal(await me.page.locator('#shortcut-enter').isChecked(), true, 'the form starts from "press Enter", every time');
        await me.page.fill('#shortcut-label', label);
        await me.page.fill('#shortcut-text', text);
        if (!enter) await me.page.locator('#shortcut-enter').uncheck();
        await me.page.locator('#shortcut-new button[type=submit]').click();
        await me.until(`${label} is there`, async () => (await me.page.locator('#shortcut-row button.saved', { hasText: label }).count()) === 1);
    };
    await add('Say hi', 'echo sent-in-one-click', true);
    await add('Start of a line', 'echo completed-', false);
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Say hi' }).click();
    await me.until('it was sent', async () => (await me.screen()).split('sent-in-one-click').length >= 3);
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Start of a line' }).click();
    await wait(600);
    assert.equal((await me.screen()).split('completed-').length, 2, 'typed once, and not sent');
    await me.page.keyboard.type('by-hand');
    await me.page.keyboard.press('Enter');
    await me.sees('\ncompleted-by-hand');
    /* The same label twice is refused. */
    assert.match((await me.api('/api/shortcuts', { label: 'Say hi', text: 'x', enter: true })).body.error, /already has this label/);
    await me.page.locator('#shortcut-row button', { hasText: 'Remove...' }).click();
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Remove "Say hi"' }).click();
    await me.until('it is gone', async () => (await me.page.locator('#shortcut-row button', { hasText: 'Say hi' }).count()) === 0);
    await me.page.locator('#shortcut-row button', { hasText: 'Done' }).click();
    assert.deepEqual(me.errors, []);
});

test('dictation: what is said is typed at the cursor, phrase by phrase; with "auto" it is sent', { skip: SKIP }, async (t) => {
    /* The "microphone" is a recording: two seconds of room, one second of
       voice-like sound, silence. The speech-to-text engine of the bench hears
       "said out loud" whatever it is given: what is tested is everything
       around it -- finding the phrase, sending it, typing the answer. */
    const second = (level) => { const s = new Float32Array(RATE); for (let i = 0; i < RATE; i++) s[i] = level * Math.sin((2 * Math.PI * 220 * i) / RATE); return s; };
    const microphone = join(mkdtempSync(join(tmpdir(), 'clv-mic-')), 'voice.wav');
    writeFileSync(microphone, toWav([second(0.004), second(0.004), second(0.5), second(0.004), second(0.004), second(0.004)]));
    const b = await bench(t, { microphone });
    const me = await b.person();
    await me.create('by-voice');
    await me.until('dictation is offered', async () => me.page.locator('#mic').isVisible());
    await me.page.locator('#mic').click();
    await me.until('the microphone is open', async () => (await me.page.locator('#mic').innerText()) === 'Stop');
    await me.sees('said out loud', 20_000);
    assert.match(await me.page.locator('#voice-line').innerText(), /Typed: said out loud|Listening|Hearing|Writing/);
    assert.equal((await me.screen()).includes('command not found'), false, 'typed, not sent');
    /* With "auto", the phrase is sent once the person has stopped. */
    await me.page.locator('#auto').click();
    await me.sees('command not found', 25_000);
    await me.page.locator('#mic').click();
    await me.until('the microphone is closed', async () => (await me.page.locator('#mic').innerText()) === 'Dictate');
});

test('folders, from the owner: a read attachment mounts the read-only view, and Files lists, imports and downloads', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-folders');
    const setAccess = async (folder, access) => {
        await me.page.locator('#folders').click();
        if ((await me.page.locator('.folder', { hasText: folder }).count()) === 0) {
            await me.page.fill('#folder-name', folder);
            await me.page.locator('#folder-new button[type=submit]').click();
            await me.until(`${folder} is listed`, async () => (await me.page.locator('.folder', { hasText: folder }).count()) > 0);
        }
        await me.page.locator('.folder', { hasText: folder }).locator('.levels button', { hasText: access }).click();
        await me.until(`${folder} is ${access}`, async () => (await me.page.locator('.folder', { hasText: folder }).locator('.levels button[aria-pressed=true]').innerText()) === access);
        await me.page.locator('#panel-close').click();
    };
    await setAccess('reports', 'Write');
    assert.match(await me.page.locator('#chips').innerText(), /reports - write/);
    await me.type('echo "q3 is fine" > ../resources/reports/q3.txt; mkdir -p ../resources/reports/out; echo ok');
    await me.sees('\nok');
    /* What the VM manager was asked to mount: the folder itself for writing... */
    const mounted = () => readlinkSync(`${b.dir}/vms/clv-with-folders/root/resources/reports`);
    assert.equal(mounted(), `${b.dir}/data/resources/reports`);
    /* ...and, for reading, the read-only VIEW, never the folder. */
    await setAccess('reports', 'Read');
    assert.equal(mounted(), `${b.dir}/data/views/reports`);
    await me.page.locator('#files-open').click();
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('q3.txt'));
    assert.equal(await me.page.locator('#files-readonly').isVisible(), true);
    assert.equal(await me.page.locator('#files-import').isVisible(), false);
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#files-rows .file', { hasText: 'q3.txt' }).click()]);
    assert.equal(download.suggestedFilename(), 'q3.txt');
    await me.page.locator('#files-rows .file', { hasText: 'out' }).click();
    await me.until('inside the sub-folder', async () => (await me.page.locator('#files-path').innerText()).replace(/\s+/g, '') === 'reports/out');
    await me.page.locator('#files-close').click();
    /* Off, then removed: only a folder attached nowhere can go, and its files are kept aside. */
    await me.page.locator('#folders').click();
    assert.equal(await me.page.locator('.folder', { hasText: 'reports' }).locator('button', { hasText: 'Remove' }).count(), 0, 'not offered while attached');
    await me.page.locator('#panel-close').click();
    await setAccess('reports', 'Off');
    await me.page.locator('#folders').click();
    await me.page.locator('.folder', { hasText: 'reports' }).locator('button', { hasText: 'Remove' }).click();
    await me.page.locator('.folder button.danger').click();
    await me.until('the folder is gone from the list', async () => (await me.page.locator('.folder', { hasText: 'reports' }).count()) === 0);
    assert.equal((await me.api('/api/resources')).body.length, 0);
});
