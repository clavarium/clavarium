/* THE MACHINE OF A CONVERSATION, from the page: its health said over the
   terminal, folders that came loose put back, a restart asked first, and
   more memory or a larger disk. The VM manager is the stand-in of the bench;
   what it is told to report about a machine is written in its directory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const vmHome = (b, name) => join(b.dir, 'vms', `clv-${name}`);
const report = (b, name, health) => writeFileSync(join(vmHome(b, name), 'health.json'), JSON.stringify(health));
const reported = (b, name) => JSON.parse(readFileSync(join(vmHome(b, name), 'health.json'), 'utf8'));
const stateOf = (b, name) => readFileSync(join(vmHome(b, name), 'state'), 'utf8');

test('folders that came loose while it slept are put back when it wakes; a machine asleep is never touched', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('loose');
    await me.newFolder('notes');
    await me.access('notes', 'Write');
    await me.page.locator('#folders').click();
    await me.page.locator('#sleep').click();
    await me.until('asleep', async () => (await me.state()) === 'asleep');
    /* The VM manager still believes both are mounted; inside, their links are dead. */
    report(b, 'loose', { dead: ['/work', '/resources/notes'] });
    /* Looked at while it sleeps: only its state is said, nothing is done, it stays asleep. */
    const asleep = await me.api('/api/conversations/loose/health', {});
    assert.equal(asleep.body.state, 'Suspended');
    assert.match(asleep.body.problems[0].text, /asleep/);
    assert.equal(stateOf(b, 'loose'), 'Suspended');
    assert.deepEqual(reported(b, 'loose').dead, ['/work', '/resources/notes'], 'nothing was remounted');
    /* Woken: while it wakes, what is known is said under the wait -- and no restart is offered for a start that is merely under way. */
    await me.page.evaluate(() => { window.clavariumTimes = { look: 300 }; });
    process.env.FAKE_VM_START_SECONDS = '2';
    t.after(() => { delete process.env.FAKE_VM_START_SECONDS; });
    await me.page.locator('#notice-action', { hasText: 'Wake it' }).click();
    /* Told step by step: what it is, the step of how many with its time so far, the step under way, and what is usual. */
    await me.until('the wait is said, with its time so far', async () => /^Step 1 of \d \u00b7 0:0\d$/.test(await me.page.locator('#notice-count').innerText().catch(() => '')));
    assert.equal(await me.page.locator('#state').innerText(), 'Waking the machine...');
    assert.match(await me.page.locator('#notice-title').innerText(), /waking it up/i);
    assert.equal(await me.page.locator('#notice-steps li[data-state="now"]').innerText(), 'Waking the machine');
    assert.match(await me.page.locator('#notice-text').innerText(), /^A start usually takes a minute or two\. Its work, its files and its chat are kept\.$/);
    /* Its machine looked at meanwhile: what is known is said, never a restart for a start that is merely under way. */
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await me.page.locator('#notice-restart').isVisible(), false, 'no restart offered while it starts');
    assert.doesNotMatch(await me.page.locator('#notice').innerText(), /asleep/, 'nothing said that the page is undoing');
    delete process.env.FAKE_VM_START_SECONDS;
    /* Both folders are unmounted and mounted again, and that is said. */
    await me.until('awake', async () => (await me.state()) === 'live');
    await me.until('both were put back', async () => ((await me.api('/api/conversations/loose/health')).body?.remounted ?? []).length === 2);
    assert.deepEqual(reported(b, 'loose').dead, []);
    await me.type('echo again > ../resources/notes/back.txt; cat ../resources/notes/back.txt');
    await me.sees('\nagain');
    await me.page.locator('#folders').click();
    await me.until('the Machine chapter says it', async () => /\/resources\/notes had come loose in the machine: it was mounted again/.test(await me.page.locator('#machine-health').innerText()));
    assert.deepEqual(me.errors, []);
});

test('a machine that does not answer is said over the terminal; Restart is asked first, and forces the stop when the clean one fails', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('silent');
    await me.type('MARK=before-restart; echo set rights:$RIGHTS');
    /* Every right in its machine: the default, given at its first start. */
    await me.sees('\nset rights:full');
    /* Parley was installed in it by the server (never by the tool), from /tools, offline. */
    assert.match(readFileSync(join(vmHome(b, 'silent'), 'npm-installs'), 'utf8'), /^\/tools\/clavarium-parley-\d+\.\d+\.\d+\.tgz\n$/);
    report(b, 'silent', { silent: true });
    await me.page.locator('#folders').click();
    await me.page.locator('#health-check').click();
    await me.until('the Machine chapter says it', async () => /Its machine does not answer/.test(await me.page.locator('#machine-health').innerText()));
    /* Its tool can take up its last session when it starts: the default. */
    assert.equal(await me.page.locator('#resume-on button[data-on=true]').getAttribute('aria-pressed'), 'true');
    /* Ask before acting: off by default, and the page says plainly what that means; turned on, from its next start. */
    assert.equal(await me.page.locator('#ask-first button[data-on=false]').getAttribute('aria-pressed'), 'true');
    assert.match(await me.page.locator('#rights-hint').innerText(), /the tool acts without asking you, with every right inside its own machine/);
    await me.page.locator('#ask-first button[data-on=true]').click();
    await me.until('it asks before acting', async () => (await me.page.locator('#ask-first button[data-on=true]').getAttribute('aria-pressed')) === 'true');
    assert.equal((await me.api('/api/conversations')).body.find((x) => x.name === 'silent').askFirst, true);
    await me.page.locator('#panel-close').click();
    /* Over the terminal, with what can be done. */
    assert.equal(await me.page.locator('#health-strip').isVisible(), true);
    assert.match(await me.page.locator('#health-text').innerText(), /does not answer/);
    /* Asked first; Cancel changes nothing. */
    await me.page.locator('#health-restart').click();
    assert.match(await me.page.locator('#notice-text').innerText(), /Restart the machine of "silent"\?.*THE TOOL IS STOPPED AND STARTED AGAIN/);
    await me.page.locator('#notice-cancel').click();
    assert.equal(await me.state(), 'live');
    /* The clean stop will fail: the stop is then forced. And once it is started again, its terminal will not come at first. */
    writeFileSync(join(vmHome(b, 'silent'), 'stuck'), '');
    rmSync(join(vmHome(b, 'silent'), 'health.json'));
    writeFileSync(join(vmHome(b, 'silent'), 'hang-attach'), '');
    await me.page.evaluate(() => { window.clavariumTimes = { repair: 1500 }; });
    await me.page.locator('#health-restart').click();
    await me.page.locator('#notice-action', { hasText: 'Restart' }).click();
    await me.until('the page says it restarts', async () => /restarting/.test(await me.state()));
    /* While it restarts, the page says the step, the time so far and what is usual. */
    await me.until('a clock while it restarts', async () => /^Step \d of 6 \u00b7 \d+:\d\d$/.test(await me.page.locator('#notice-count').innerText().catch(() => '')));
    assert.match(await me.page.locator('#notice-text').innerText(), /A restart usually takes one to two minutes/);
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    assert.equal(existsSync(join(vmHome(b, 'silent'), 'killed')), true, 'stopped by force');
    const c = (await me.api('/api/conversations')).body.find((x) => x.name === 'silent');
    assert.equal(c.restarted, 'Restarted.');
    assert.equal(c.phase, 'ready');
    /* Its terminal did not come: the page waited, the server repaired it, by itself. */
    await me.until('the hung terminal was met', async () => !existsSync(join(vmHome(b, 'silent'), 'hang-attach')), 30_000);
    await me.sees('ready>', 30_000);
    /* The tool came back as on any start: a new shell -- on its last session, as it does by default. */
    await me.type('echo "mark:${MARK:-gone} resumed:${RESUMED:-no} rights:${RIGHTS:-none}"');
    /* ... asking before acting now, as the owner chose before the restart. */
    await me.sees('\nmark:gone resumed:1 rights:ask');
    /* Known there already: not installed again. */
    assert.equal(readFileSync(join(vmHome(b, 'silent'), 'npm-installs'), 'utf8').split('\n').filter(Boolean).length, 1);
    /* Looked at again after the start: nothing wrong, nothing said over the terminal. */
    await me.until('looked at after the restart', async () => (await me.api('/api/conversations/silent/health')).body?.level === 'ok');
    await me.page.locator('#folders').click();
    await me.until('the strip is gone', async () => !(await me.page.locator('#health-strip').isVisible()));
    await me.until('the Machine chapter says it was restarted', async () => /Restarted\./.test(await me.page.locator('#machine-restarted').innerText()));
    await me.page.locator('#panel-close').click();
    /* A terminal that the repair does not bring back: said plainly, and only then a restart is offered. */
    writeFileSync(join(vmHome(b, 'silent'), 'hang-attach'), ''); writeFileSync(join(vmHome(b, 'silent'), 'hang-always'), '');
    assert.equal((await me.api('/api/conversations/silent/terminal/repair', {})).body.session, 'kept', 'its tool answers: kept as it is');
    await me.context.addInitScript(() => { window.clavariumTimes = { repair: 1500 }; });
    await me.page.reload();
    await me.until('said plainly, with the restart', async () => /repairing it did not help/.test(await me.page.locator('#notice-text').innerText().catch(() => '')), 30_000);
    assert.equal(await me.page.locator('#notice-restart').isVisible(), true);
    assert.deepEqual(me.errors, []);
});

test('memory saturated and a full disk are said; memory and disk are changed from the Machine chapter, and the record holds what the machine has', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('roomy');
    /* It talks through the app: what is wrong with its machine is said in its chat too. */
    await me.api('/api/conversations/roomy/talk', { on: true });
    report(b, 'roomy', { oom: 2, availableMb: 20, diskLeftMb: 50 });
    await me.page.locator('#folders').click();
    await me.page.locator('#health-check').click();
    await me.until('it is said', async () => /ran out of memory 2 times/.test(await me.page.locator('#machine-health').innerText()));
    const said = await me.page.locator('#machine-health').innerText();
    assert.match(said, /Its memory is almost full: 20 MB free of 768 MB/);
    assert.match(said, /Its disk is almost full: 50 MB left/);
    rmSync(join(vmHome(b, 'roomy'), 'health.json'));
    /* What it has now, and only larger disks. */
    assert.equal(await me.page.locator('#machine-memory').inputValue(), '768');
    assert.equal(await me.page.locator('#machine-disk').inputValue(), '8');
    assert.equal(await me.page.locator('#machine-disk option[value="8"]').innerText(), '8 GB (now)');
    /* Over its screen: "More memory..." opens its memory, the next size up picked, nothing applied yet. */
    await me.page.locator('#panel-close').click();
    assert.match(await me.page.locator('#health-text').innerText(), /ran out of memory 2 times/);
    await me.page.locator('#health-memory').click();
    await me.until('its memory, ready to be chosen', async () => (await me.page.evaluate(() => document.activeElement?.id)) === 'machine-memory');
    assert.equal(await me.page.locator('#machine-memory').inputValue(), '1024');
    /* Its chat says it too, where it happened, with the same ways out; and the terminal is shown only when asked. */
    await me.page.locator('#panel-close').click();
    await me.page.locator('#simple-toggle').click();
    const line = me.page.locator('#simple-thread .parley-system');
    await me.until('a line of the machine in its chat', async () => /ran out of memory 2 times/.test(await line.first().innerText().catch(() => '')));
    assert.deepEqual(await line.first().locator('button').allInnerTexts(), ['More memory...', 'Restart...', 'See the terminal']);
    assert.equal(await me.page.locator('#health-terminal').isVisible(), true, 'the strip offers its terminal over the chat');
    await line.first().locator('button', { hasText: 'See the terminal' }).click();
    assert.equal(await me.page.locator('#simple').isVisible(), false);
    await me.page.locator('#folders').click();
    await me.page.selectOption('#machine-memory', '2048');
    await me.page.selectOption('#machine-disk', '16');
    await me.page.locator('#machine-size-apply').click();
    const asked = await me.page.locator('#notice-text').innerText();
    assert.match(asked, /Give "roomy" 2 GB of memory \(now 768 MB\) and a disk of 16 GB \(now 8 GB; it can never shrink again\)\?/);
    assert.match(asked, /ITS MACHINE IS STOPPED CLEANLY, SET, AND STARTED AGAIN/);
    await me.page.locator('#notice-action', { hasText: 'Change it' }).click();
    await me.until('done', async () => /It now has/.test((await me.api('/api/conversations')).body[0].restarted ?? ''), 30_000);
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    const c = (await me.api('/api/conversations')).body[0];
    assert.equal(c.restarted, 'It now has 2048 MB of memory, 16 GB of disk.');
    /* Its chat says it, and the tool, started again with nothing of the chat in mind, is told once to read it whole. */
    await me.sees('Your chat with the person is kept: run "parley read --all" before going on.');
    assert.ok((await me.api('/api/conversations/roomy/talk')).body.messages.some((m) => m.from === 'system' && m.text === 'Its machine was restarted with 2048 MB of memory, 16 GB of disk: the tool started again.'));
    assert.equal(c.memoryMb, 2048); assert.equal(c.diskGb, 16);
    assert.deepEqual(JSON.parse(readFileSync(join(vmHome(b, 'roomy'), 'size.json'), 'utf8')), { memory: 2048, disk: 16 });
    /* A disk never shrinks; a tool's least memory is kept. */
    assert.match((await me.api('/api/conversations/roomy/machine', { diskGb: 8 })).body.error, /can only grow: it has 16 GB/);
    assert.match((await me.api('/api/conversations/roomy/machine', { memoryMb: 512 })).body.error, /between 768 MB/);
    await me.page.locator('#folders').click();
    await me.until('the choices follow what it has now', async () => (await me.page.locator('#machine-disk option').first().innerText()) === '16 GB (now)');
    assert.equal(await me.page.locator('#machine-memory').inputValue(), '2048');
    assert.equal(await me.page.locator('#machine-memory option[value="2048"]').innerText(), '2 GB (now)');
    assert.match(await me.page.locator('#general-facts').innerText(), /2 GB of memory, 16 GB disk/);
    await me.page.locator('#panel-close').click();
    await me.type('echo still-here');
    await me.sees('\nstill-here');
    assert.deepEqual(me.errors, []);
});
