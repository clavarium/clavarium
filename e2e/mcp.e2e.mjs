import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* AN EXTERNAL MCP SERVER THROUGH TETHER (07-11): added in Assets with its name, address and key -- the key never
   shown again, never in the page; its tools listed, each with its kind; a conversation given it at Custom, each kind
   of tool set; Refresh lists again; a call of a tool that deletes asks, as a card in the thread. The server is a
   connector of this test (Tether's own HTTP client is proved in Tether): it lists the tools below. */
const KEY = 'sk-e2e-0123456789-never-in-the-page';
const TOOLS = [
    { name: 'search', description: 'Find a contact', annotations: { readOnlyHint: true } },
    { name: 'update', description: 'Change a contact', annotations: { destructiveHint: false } },
    { name: 'erase', description: 'Delete a contact', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
];

test('an MCP server: added with its key (never shown), its tools by kind, Custom rights, Refresh, a call asked as a card', { skip: SKIP }, async (t) => {
    const keys = []; let more = [];
    const mcp = {
        discover: async (target, ctx) => { keys.push(await ctx.secret('token')); return [...TOOLS, ...more]; },
        run: async () => ({ text: 'done', size: 4 }),
        forget() {}, attach() {},
    };
    const b = await bench(t, { tetherConnectors: { mcp } });
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.create('asker');
    assert.equal((await me.api('/api/conversations/asker/talk', { on: true })).status, 200);

    /* Added: the form, then its panel, its tools each with its kind. */
    await me.addAsset('mcp');
    await me.page.locator('#mcp-hand summary').click();
    await me.page.fill('#mcp-name', 'CRM');
    await me.page.fill('#mcp-url', 'https://mcp.example.com/mcp');
    await me.page.fill('#mcp-key', KEY);
    await me.page.locator('#mcp-add').click();
    const panel = me.page.locator('#assets-detail');
    await me.until('its tools listed', async () => (await panel.locator('.mcp-tool').count()) === 3, 20_000);
    assert.deepEqual(await panel.locator('.mcp-tool').evaluateAll((li) => li.map((x) => [x.dataset.tool, x.querySelector('.mcp-tool-class').textContent])),
        [['search', 'Reads only'], ['update', 'Writes'], ['erase', 'Deletes or overwrites']], 'a tool without annotations deletes or overwrites');
    assert.deepEqual(keys, [KEY], 'the key reached the server, from the server');
    assert.ok(!(await me.page.content()).includes(KEY), 'never in the page');
    assert.equal(await me.page.inputValue('#mcp-key'), '', 'the field emptied');
    const state = await me.api('/api/tether');
    assert.ok(!JSON.stringify(state.body).includes(KEY));

    /* Given to asker: Off / Read / All with approval / All / Custom; Custom, then each kind of tool. */
    await panel.locator('.kit-access-give').click();
    const row = panel.locator('.given-row[data-conversation="asker"]');
    assert.deepEqual(await row.locator('.kit-rights-pick button').allInnerTexts(), ['Off', 'Read', 'All with approval', 'All', 'Custom']);
    await row.locator('.kit-rights-pick button[data-value="frame"]').click();
    const custom = panel.locator('.mcp-custom[data-conversation="asker"]');
    await me.until('its Custom rights', async () => (await custom.count()) === 1, 15_000);
    await custom.locator('.mcp-custom-line[data-class="write"] button[data-value="yes"]').click();
    await me.until('kept', async () => (await me.api('/api/tether')).body.targets.find((x) => x.id === 'crm')?.grants?.['conversation:asker']?.classes?.write === 'yes', 15_000);
    await me.page.screenshot({ path: join(process.env.MCP_SHOTS ?? b.dir, 'mcp-panel.png') });

    /* Refresh: a tool added on the server is listed. */
    more = [{ name: 'archive', description: 'Archive a contact', annotations: { destructiveHint: false } }];
    await panel.locator('button[data-act="mcp-refresh"]').click();
    await me.until('listed again', async () => (await panel.locator('.mcp-tool').count()) === 4, 15_000);

    /* A call of a tool that deletes: asked, its card in asker's thread -- server, tool, kind, arguments, why. */
    const side = join(b.dir, 'kept-work', 'asker', 'work', '.tether');
    mkdirSync(side, { recursive: true });
    appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id: 'm1', op: 'mcp.call', args: { target: 'crm', tool: 'erase', arguments: { id: '42' }, why: 'a duplicate' }, at: new Date().toISOString() })}\n`);
    await me.page.goto(`${b.origin}/?c=asker`);
    const card = me.page.locator('#simple-thread .parley-request').first();
    await me.until('the call is a card in the thread', async () => (await card.count()) === 1, 30_000);
    const text = await card.innerText();
    for (const said of ['Use erase on CRM', 'Deletes or overwrites', 'a duplicate']) assert.ok(text.includes(said), `${said} in: ${text}`);
    assert.ok(!(await me.page.content()).includes(KEY));
    assert.deepEqual(me.errors, [], 'no error in the page');
});

/* PASTED (11-11): the block a service gives, its key written in it -- name, address and key read and shown ticked, the
   key masked; two servers added at once, each with its key (one by Bearer, one by its own header); a program to start
   refused in words; the key never in the page after. */
test('an MCP server pasted as the service gives it: read, shown ticked, key masked, two at once, a program refused', { skip: SKIP }, async (t) => {
    const keys = [];
    const mcp = { discover: async (target, ctx) => { keys.push([target.id, await ctx.secret('token'), target.config?.header ?? '']); return TOOLS.slice(0, 1); }, run: async () => ({ text: 'done', size: 4 }), forget() {}, attach() {} };
    const b = await bench(t, { tetherConnectors: { mcp } });
    const me = await b.person();
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.addAsset('mcp');
    await me.page.fill('#mcp-config', JSON.stringify({ mcpServers: { local: { command: 'npx', args: ['-y', 'x'] } } }));
    await me.until('a program refused', async () => /programme|program/.test(await me.page.locator('#mcp-error').innerText()));
    await me.page.fill('#mcp-config', JSON.stringify({ mcpServers: {
        agenda: { url: 'https://agenda.example.com/mcp', headers: { Authorization: `Bearer ${KEY}` } },
        bills: { serverUrl: 'https://bills.example.com/mcp', headers: { 'X-API-Key': 'ak-e2e-second-key-0099' } } } }, null, 2));
    await me.until('read and ticked', async () => (await me.page.locator('#mcp-found').isVisible()) && (await me.page.locator('#mcp-found-name').innerText()) === 'agenda');
    assert.equal(await me.page.locator('#mcp-found-url').innerText(), 'https://agenda.example.com/mcp');
    assert.equal(await me.page.locator('#mcp-found-key').innerText(), `${KEY.slice(0, 4)}••••${KEY.slice(-3)}`, 'the key masked');
    assert.equal(await me.page.locator('#mcp-pick button').count(), 2);
    await me.page.locator('#mcp-pick button', { hasText: 'bills' }).click();
    assert.match(await me.page.locator('#mcp-found-key').innerText(), /X-API-Key$/);
    if (process.env.MCP_SHOTS) for (const [w, h, name] of [[1280, 800, 'desktop'], [900, 1200, 'tablet'], [390, 844, 'phone']]) {
        await me.page.setViewportSize({ width: w, height: h });
        for (const scheme of ['dark', 'light']) {
            await me.page.evaluate((x) => { document.documentElement.dataset.theme = x; }, scheme);
            await me.page.locator('#mcp-box').screenshot({ path: join(process.env.MCP_SHOTS, `mcp-paste-${name}-${scheme}.png`) });
        }
    }
    await me.page.setViewportSize({ width: 1280, height: 800 });
    await me.page.locator('#mcp-add').click();
    await me.until('both added', async () => (await me.api('/api/tether')).body.targets.filter((x) => x.kind === 'mcp').length === 2, 20_000);
    await me.until('both reached with their keys', async () => keys.length >= 2, 20_000);
    assert.deepEqual(keys.sort(), [['agenda', KEY, ''], ['bills', 'ak-e2e-second-key-0099', 'X-API-Key']]);
    assert.equal(await me.page.inputValue('#mcp-config'), '', 'the block emptied');
    assert.ok(!(await me.page.content()).includes(KEY), 'never in the page');
    assert.deepEqual(me.errors, [], 'no error in the page');
});
