import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bench, SKIP, tmuxOf } from './bench.mjs';

const TOOLS = [{ id: 'shell', label: 'Shell', command: ['env', 'PS1=ready> ', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [],
    signin: { senders: ['example.com'], links: ['example.com'], screen: ['code:PASTE-CODE-HERE'] } }];
const CODE = 'fieldCode9aZqX7mN2pLk4_value';
const CHAT_CODE = 'chatCode7bYwV3nK8qRt5sLm';
const everyFile = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); const s = statSync(p, { throwIfNoEntry: false }); return !s ? [] : s.isDirectory() ? everyFile(p) : s.isFile() ? [p] : []; });

test('a tool at its code prompt: the field types the code once and it is kept nowhere; a code in the chat is not typed', { skip: SKIP }, async (t) => {
    const b = await bench(t, { tools: TOOLS });
    const me = await b.person();
    await me.create('signing');
    assert.equal((await me.api('/api/conversations/signing/talk', { on: true })).status, 200);
    await me.type("printf 'PASTE-CODE%s\\n' -HERE; read -r got; echo \"got=[$got]\"");
    await me.sees('PASTE-CODE-HERE');
    const chat = join(b.dir, 'data', 'work', 'signing', '.parley');
    writeFileSync(join(chat, 'signin-ask.json'), JSON.stringify({ id: '12345678-0000-4000-8000-000000000000', at: new Date().toISOString(), link: 'https://example.com/oauth', around: '', told: true, field: true }));
    await me.page.setViewportSize({ width: 390, height: 780 });
    await me.page.goto(`${b.origin}/?c=signing`);
    const thread = me.page.locator('#simple-thread');
    const action = thread.locator('.parley-act[data-act=signincode]');
    await me.until('the line with its button', async () => (await action.count()) === 1, 30_000);

    await me.page.fill('#simple-thread .parley-box', CHAT_CODE);
    await me.page.locator('#simple-thread .parley-send').click();
    await me.until('the chat message is kept as a secret', async () => !readFileSync(join(chat, 'to-agent.jsonl'), 'utf8').includes(CHAT_CODE) && readFileSync(join(chat, 'to-agent.jsonl'), 'utf8').includes('secret:'));

    const errors = []; me.page.on('pageerror', (e) => errors.push(e.message));
    assert.equal(await action.innerText(), 'Paste the code');
    await action.click();
    const field = me.page.locator('#signin-code-value');
    assert.equal(await field.getAttribute('type'), 'password');
    const box = await me.page.locator('#signin-code').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, 'fits a phone');
    await field.fill(CODE);
    await me.page.locator('#signin-code-send').click();
    await me.until('closed', async () => !(await me.page.locator('#signin-code').evaluate((d) => d.open)));
    await me.until('sent, said in the chat', async () => (await thread.innerText()).includes('Code sent to the tool.'));
    const pane = () => spawnSync('tmux', ['-L', tmuxOf('signing'), 'capture-pane', '-p', '-t', '=main:'], { encoding: 'utf8' }).stdout;
    await me.until('typed into the tool, the field\'s code and not the chat\'s', async () => pane().includes(`got=[${CODE}]`));
    assert.equal(pane().includes(CHAT_CODE), false);
    spawnSync('tmux', ['-L', tmuxOf('signing'), 'send-keys', '-t', '=main:', 'clear', 'Enter']);
    const out = await me.api('/api/conversations/signing/talk');
    assert.equal(JSON.stringify(out.body).includes(CODE), false, 'not in the thread');
    for (const f of everyFile(join(b.dir, 'data'))) assert.equal(readFileSync(f).includes(CODE), false, f);
    assert.equal(await field.inputValue(), '', 'wiped from the page');
    assert.deepEqual(errors, [], 'no error in the page');
});

test('its sign-in waits: the code pasted in the plain chat box goes to the tool, and into no message', { skip: SKIP }, async (t) => {
    const PASTED = 'pastedCode8xKq2mZvT#stateValue9yTn4wR';
    const b = await bench(t, { tools: TOOLS });
    const me = await b.person();
    await me.create('signing');
    assert.equal((await me.api('/api/conversations/signing/talk', { on: true })).status, 200);
    await me.type("printf 'PASTE-CODE%s\\n' -HERE; read -r got; echo \"got=[$got]\"");
    await me.sees('PASTE-CODE-HERE');
    const chat = join(b.dir, 'data', 'work', 'signing', '.parley');
    writeFileSync(join(chat, 'signin-ask.json'), JSON.stringify({ id: '12345678-0000-4000-8000-000000000001', at: new Date().toISOString(), link: 'https://example.com/oauth', around: '', told: true, field: true }));
    await me.page.setViewportSize({ width: 390, height: 780 });
    await me.page.goto(`${b.origin}/?c=signing`);
    const thread = me.page.locator('#simple-thread');
    await me.until('the line with its button', async () => (await thread.locator('.parley-act[data-act=signincode]').count()) === 1, 30_000);
    const errors = []; me.page.on('pageerror', (e) => errors.push(e.message));
    await me.page.fill('#simple-thread .parley-box', PASTED);
    await me.page.locator('#simple-thread .parley-send').click();
    const pane = () => spawnSync('tmux', ['-L', tmuxOf('signing'), 'capture-pane', '-p', '-t', '=main:'], { encoding: 'utf8' }).stdout;
    await me.until('typed into the tool', async () => pane().includes(`got=[${PASTED}]`));
    await me.until('said in the chat', async () => (await thread.innerText()).includes('Code sent to the tool.'));
    assert.equal(await me.page.locator('#simple-thread .parley-box').inputValue(), '', 'the box is empty again');
    spawnSync('tmux', ['-L', tmuxOf('signing'), 'send-keys', '-t', '=main:', 'clear', 'Enter']);
    const out = await me.api('/api/conversations/signing/talk');
    assert.equal(JSON.stringify(out.body).includes(PASTED), false, 'not in the thread');
    for (const f of everyFile(join(b.dir, 'data'))) assert.equal(readFileSync(f).includes(PASTED), false, f);
    assert.deepEqual(errors, [], 'no error in the page');
});
