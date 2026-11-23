/* CHANGING ITS AI, from the page (#404): chosen in its settings, confirmed, the same conversation; the one before offered to go back. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

const shell = (id, label, prompt) => ({ id, label, instructions: `.${id}/RULES.md`, state: { keep: [`.${id}`] }, command: ['env', `PS1=${prompt}> `, 'bash', '--norc', '--noprofile'], resume: ['env', `PS1=${prompt}-again> `, 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [] });

test('its AI is changed from its settings, asked first, and changed back', { skip: SKIP }, async (t) => {
    const b = await bench(t, { tools: [{ ...shell('shell', 'Shell', 'ready') }, shell('second', 'Second AI', 'second'), { id: 'plain', label: 'Plain', command: ['bash'], memoryMb: 768, install: [] }] });
    const me = await b.person();
    const errors = []; me.page.on('pageerror', (e) => errors.push(e.message));
    await me.create('swap', 'Shell', { chat: false });
    await me.page.locator('#folders').click();
    await me.chapter('general');
    const box = me.page.locator('#ai-box');
    await me.until('the choice is shown', () => box.isVisible());
    await me.until('both AIs are offered, not the plain tool', async () => (await me.page.locator('#ai-choice option').allTextContents()).join() === 'Shell,Second AI');
    assert.equal(await me.page.locator('#ai-back').isVisible(), false, 'no way back yet');
    /* Chosen: nothing happens before it is confirmed; cancelled, nothing happened. */
    await me.page.locator('#ai-choice').selectOption('second');
    await me.until('it asks first', () => me.page.locator('#ai-sure').isVisible());
    assert.match(await me.page.locator('#ai-ask').innerText(), /Second AI/);
    await me.page.locator('#ai-no').click();
    assert.equal(await me.page.locator('#ai-choice').inputValue(), 'shell');
    const tool = async () => (await me.api('/api/conversations')).body.find((x) => x.name === 'swap');
    assert.equal((await tool()).tool, 'shell');
    await me.page.locator('#ai-choice').selectOption('second');
    await me.page.locator('#ai-go').click();
    await me.until('it runs the new AI', async () => { const c = await tool(); return c.tool === 'second' && !c.toolSwitch; }, 30_000);
    /* The way back, offered by name, resumes the first AI. */
    await me.until('the way back', async () => /Back to Shell/.test(await me.page.locator('#ai-back').innerText().catch(() => '')));
    await me.until('its lock is given back', async () => (await me.api('/api/conversations/swap/tool', { tool: 'second' })).status === 409 && /already runs/.test(JSON.stringify((await me.api('/api/conversations/swap/tool', { tool: 'second' })).body)), 30_000);
    await me.page.locator('#ai-back').click();
    await me.page.locator('#ai-go').click();
    await me.until('back on the first AI', async () => { const c = await tool(); return c.tool === 'shell' && c.previousTool === 'second' && !c.toolSwitch; }, 30_000);
    assert.deepEqual(errors, [], 'no error on the page');
});
