import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bench, SKIP } from './bench.mjs';

const HOST = fileURLToPath(new URL('./fake-clavarium-host.mjs', import.meta.url));

test('a conversation whose machine is gone can have it built again, and finds its folders in the new one', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('survivor');
    await me.api('/api/resources', { name: 'notes' });
    await me.api('/api/conversations/survivor/resources', { resource: 'notes', access: 'write' });
    await me.type('echo kept-in-a-folder > ../resources/notes/kept.txt; echo made-where-the-tool-works > made-here.txt; echo done');
    await me.sees('\ndone');
    /* A machine that works is not rebuilt: this is not a reset button. */
    assert.match((await me.api('/api/conversations/survivor/rebuild', {})).body.error, /has its machine/);
    /* The machine disappears behind the server's back, as after a backup put
       back on a new computer. */
    spawnSync(process.execPath, [HOST, 'vm', 'delete', 'clv-survivor'], { env: { ...process.env, FAKE_VM_DIR: b.dir } });
    await me.page.reload();
    await me.until('the page says the machine is gone and offers to build it', async () => (await me.page.locator('#notice-action').innerText()) === 'Build its machine again');
    assert.match(await me.page.locator('#notice-text').innerText(), /no longer exists.*its folders are kept/);
    await me.page.locator('#notice-action').click();
    await me.until('the terminal is live again', async () => (await me.page.locator('#state').innerText()) === 'live', 60_000);
    /* Its attached folder is back, and so is what the tool had made where it
       works: that folder is kept by the server, not by the machine. */
    await me.type('cat ../resources/notes/kept.txt; cat made-here.txt; echo checked');
    await me.sees('kept-in-a-folder');
    await me.sees('\nmade-where-the-tool-works');
    assert.match(await me.page.locator('#chips').innerText(), /notes - write/);
    assert.deepEqual(me.errors.filter((e) => !/410|1011|WebSocket/.test(e)), []);
});
