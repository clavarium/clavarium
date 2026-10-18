/* THE READY-MADE MACHINE, from the page: rebuilt from Settings, then a new
   conversation is a copy of it and goes through the three steps quickly,
   where the long way would take its full launch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

/* One install step, so that "Installing" means something on both ways. */
const TOOLS = [{ id: 'shell', label: 'Shell', command: ['env', 'PS1=ready> ', 'bash', '--norc', '--noprofile'], memoryMb: 768, install: [['true']] }];
const LONG_LAUNCH = 10;

test('a conversation built from the ready-made machine goes through its three steps quickly', { skip: SKIP }, async (t) => {
    const b = await bench(t, { tools: TOOLS, launchSeconds: String(LONG_LAUNCH) });
    process.env.FAKE_VM_LOG = join(b.dir, 'vm-log');
    t.after(() => { delete process.env.FAKE_VM_LOG; delete process.env.FAKE_VM_STEP_SECONDS; delete process.env.FAKE_SHELF_ROOM; });
    const me = await b.person();

    /* Settings -> Advanced: none yet. A short disk refuses the rebuild, and says so. */
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-advanced');
    await me.until('it says there is none yet', async () => /None yet/.test(await me.page.locator('#shelf-state').innerText()));
    process.env.FAKE_SHELF_ROOM = 'free 2048';
    await me.page.locator('#shelf-rebuild').click();
    await me.until('the refusal is said', async () => /Not rebuilt: 2\.0 GB free on the server, 6\.0 GB needed/.test(await me.page.locator('#shelf-error').innerText()));
    assert.ok(!(await me.page.locator('#shelf-rebuild').isDisabled()), 'it can be tried again');

    /* Room enough: rebuilt in the background, then shown with its date and size. */
    process.env.FAKE_SHELF_ROOM = 'free 40000';
    await me.page.locator('#shelf-rebuild').click();
    await me.until('it is made', async () => /Made .*4\.1 GB on disk\. Holds: Shell\./.test(await me.page.locator('#shelf-state').innerText()), 30_000);
    assert.ok(await me.page.locator('#shelf-error').isHidden());
    const shelf = (await me.api('/api/shelf')).body;
    assert.ok(shelf.current.fresh);
    await me.page.locator('#settings-close').click();

    /* A new conversation: each step of the copy is given a moment, so that
       every one of them is seen, and the whole is still much quicker than a
       launch. */
    process.env.FAKE_VM_STEP_SECONDS = '0.8';
    const seen = [];
    let watching = true;
    const watch = (async () => {
        while (watching) {
            const c = (await me.api('/api/conversations').catch(() => ({ body: [] }))).body?.find?.((x) => x.name === 'quick');
            if (c?.step && seen.at(-1) !== c.step) seen.push(c.step);
            await wait(80);
        }
    })();
    const started = Date.now();
    await me.create('quick');
    const took = (Date.now() - started) / 1000;
    watching = false; await watch;
    assert.deepEqual(seen, ['Starting the machine', 'Preparing the machine', 'Installing Shell (already on the machine)']);
    assert.ok(took < LONG_LAUNCH, `built in ${took.toFixed(1)} s, under the ${LONG_LAUNCH} s a launch alone takes here`);
    const log = readFileSync(process.env.FAKE_VM_LOG, 'utf8');
    assert.match(log, /^clone clvshelf-\d{8}-\d{6} clv-quick 768$/m);
    assert.doesNotMatch(log, /^launch clv-quick/m, 'not launched from the stock image');
    assert.doesNotMatch(log, /^exec clv-quick -- sudo -n snap install/m, 'sharing was already there');
    assert.doesNotMatch(log, /^exec clv-quick -- true$/m, 'the tool was already there');
    /* The copy is a machine of its own: what the tool writes stays in it. */
    await me.type('echo from-the-copy > here.txt; cat here.txt');
    await me.sees('\nfrom-the-copy');
    assert.deepEqual(me.errors, []);
});
