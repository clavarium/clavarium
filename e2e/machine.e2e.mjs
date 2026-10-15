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
    /* Woken: both are unmounted and mounted again, and that is said. */
    await me.page.locator('#notice-action', { hasText: 'Wake it' }).click();
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
    await me.type('MARK=before-restart; echo set');
    await me.sees('\nset');
    report(b, 'silent', { silent: true });
    await me.page.locator('#folders').click();
    await me.page.locator('#health-check').click();
    await me.until('the Machine chapter says it', async () => /Its machine does not answer/.test(await me.page.locator('#machine-health').innerText()));
    await me.page.locator('#panel-close').click();
    /* Over the terminal, with what can be done. */
    assert.equal(await me.page.locator('#health-strip').isVisible(), true);
    assert.match(await me.page.locator('#health-text').innerText(), /does not answer/);
    /* Asked first; Cancel changes nothing. */
    await me.page.locator('#health-restart').click();
    assert.match(await me.page.locator('#notice-text').innerText(), /Restart the machine of "silent"\?.*THE TOOL IS STOPPED AND STARTED AGAIN/);
    await me.page.locator('#notice-cancel').click();
    assert.equal(await me.state(), 'live');
    /* The clean stop will fail: the stop is then forced. */
    writeFileSync(join(vmHome(b, 'silent'), 'stuck'), '');
    rmSync(join(vmHome(b, 'silent'), 'health.json'));
    await me.page.locator('#health-restart').click();
    await me.page.locator('#notice-action', { hasText: 'Restart' }).click();
    await me.until('the page says it restarts', async () => /restarting/.test(await me.state()));
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    assert.equal(existsSync(join(vmHome(b, 'silent'), 'killed')), true, 'stopped by force');
    const c = (await me.api('/api/conversations')).body.find((x) => x.name === 'silent');
    assert.equal(c.restarted, 'Restarted.');
    assert.equal(c.phase, 'ready');
    /* The tool came back as on any start: a new shell. */
    await me.type('echo "mark:${MARK:-gone}"');
    await me.sees('\nmark:gone');
    /* Looked at again after the start: nothing wrong, nothing said over the terminal. */
    await me.until('looked at after the restart', async () => (await me.api('/api/conversations/silent/health')).body?.level === 'ok');
    await me.page.locator('#folders').click();
    await me.until('the strip is gone', async () => !(await me.page.locator('#health-strip').isVisible()));
    await me.until('the Machine chapter says it was restarted', async () => /Restarted\./.test(await me.page.locator('#machine-restarted').innerText()));
    assert.deepEqual(me.errors, []);
});

test('memory saturated and a full disk are said; memory and disk are changed from the Machine chapter, and the record holds what the machine has', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('roomy');
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
