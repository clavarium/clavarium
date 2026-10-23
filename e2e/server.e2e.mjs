import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const SHORT = ['place machines 2049 102400 4000', 'place data 2049 102400 4000', 'place folders 2049 102400 4000', 'memory 16384 1500', 'machine clv-alpha 800'].join('\n');

test('This server: its disk and memory in Settings; a small gauge only when it is short of room, which opens them; the reserve refuses a new machine, in words, and can be lowered', { skip: SKIP }, async (t) => {
    const b = await bench(t, { serverRoomMs: 200 });
    t.after(() => { delete process.env.FAKE_SERVER_ROOM; });
    const me = await b.person();
    await me.create('alpha');
    const gauge = me.page.locator('#server-gauge');
    assert.equal(await gauge.isVisible(), false, 'plenty of room: no gauge');
    await me.page.locator('#nav-settings').click();
    /* Settings: every chapter folded at first, in two groups. */
    await me.until('Settings are shown', async () => me.page.locator('#settings').isVisible());
    assert.deepEqual(await me.page.evaluate(() => [...document.querySelectorAll('#settings details.chapter')].filter((d) => d.open).length), 0);
    assert.deepEqual(await me.page.locator('#settings .chapter-group').allInnerTexts().then((x) => x.map((t) => t.toLowerCase())), ['this device', 'this server']);
    await me.chapter('s-resources');
    const disk = me.page.locator('#server-disks .server-block').first();
    await me.until('the disk is said', async () => (await disk.locator('.server-figures').innerText().catch(() => '')) === '60 GB free of 100 GB');
    assert.equal(await disk.locator('.server-note').innerText(), '55 GB above the 5.0 GB reserve');
    assert.equal(await me.page.locator('#server-memory-figures').innerText(), '12 GB free of 16 GB');
    await me.until('what takes the disk is said', async () => /This server's data[\s\S]*Shared folders[\s\S]*folders given to machines[\s\S]*Machines[\s\S]*alpha[\s\S]*images[\s\S]*The system and other programs/.test(await disk.locator('.server-parts').innerText()));
    /* Where each work folder is: here, one disk holds them all. */
    assert.match(await disk.locator('.server-parts').innerText(), /Work folders on this disk\s+alpha/);
    assert.match(await me.page.locator('#server-memory-parts').innerText(), /Running machines \(1\)[\s\S]*alpha\s+uses 0\.9 GB · given 0\.8 GB/);
    /* The reserve: a fixed amount or a share, the larger kept. */
    assert.deepEqual(await Promise.all(['#reserve-disk', '#reserve-disk-percent', '#reserve-memory', '#reserve-memory-percent'].map((id) => me.page.inputValue(id))), ['5', '5', '1', '5']);
    assert.equal(await me.page.locator('#reserve-now').innerText(), 'Kept free now: 5.0 GB of disk, 1.0 GB of memory.');
    /* What was promised: only said. */
    assert.match(await me.page.locator('#promised-disk').innerText(), /^Disks promised to machines, at their largest: \d+\.\d GB of 100 GB\.$/);
    assert.match(await me.page.locator('#promised-memory').innerText(), /^Memory given to running machines: \d+\.\d GB of 16 GB\.$/);
    assert.equal(await me.page.locator('#promised-disk').getAttribute('data-over'), 'false');
    assert.equal(await disk.locator('.server-state').isVisible(), false);
    await me.page.locator('#settings-close').click();
    /* Short of room: the gauge comes, and opens This server. */
    process.env.FAKE_SERVER_ROOM = SHORT;
    await me.page.reload();
    await me.until('the gauge is shown', async () => gauge.isVisible());
    assert.match(await gauge.innerText(), /This server is short of room[\s\S]*Disk[\s\S]*reserve reached[\s\S]*Memory[\s\S]*0\.5 GB left[\s\S]*See what takes room/);
    await gauge.click();
    await me.until('This server is open', async () => (await me.page.locator('#settings').isVisible()) && (await me.page.locator('#server-disks .server-state').first().innerText()) === 'Short');
    assert.ok(await me.page.locator('#settings-server-top').evaluate((e) => { const r = e.getBoundingClientRect(); return e.open && r.top >= 0 && r.top < innerHeight; }), 'opened and scrolled to it');
    /* A new machine would eat into the reserve: refused, with why and what to do. */
    const made = await me.api('/api/conversations', { name: 'beta', tool: 'shell' });
    assert.equal(made.status, 409);
    assert.match(made.body.error, /^Not created: this server cannot spare .* GB of memory for a new machine\. It has 1\.5 GB of memory free and keeps 1\.0 GB in reserve\. Put a conversation you are not using to sleep, or choose less memory, or lower the reserve in Settings, This server\.$/);
    /* The owner lowers the reserve: allowed. */
    await me.page.fill('#reserve-disk', '0');
    await me.page.fill('#reserve-memory', '0.5');
    await me.page.fill('#reserve-memory-percent', '0');
    await me.page.locator('#reserve-save').click();
    await me.until('saved', async () => (await me.page.locator('#reserve-saved').innerText()) === 'Saved.');
    const after = (await me.api('/api/server')).body;
    assert.deepEqual(after.reserve, { diskMb: 5120, memoryMb: 512 }, 'the disk share (5 % of 100 GB) still holds');
    assert.deepEqual(after.settings, { diskMb: 0, diskPercent: 5, memoryMb: 512, memoryPercent: 0 });
    /* A link to the chapter (an alert's) opens it, and only it. */
    await me.page.goto(`${b.origin}/?open=settings&at=updates`);
    await me.until('Updates opened by the link', async () => me.page.locator('#settings-updates-top').evaluate((d) => d.open));
    /* On a phone, the gauge sits at the bottom of the list, within the screen. */
    const phone = await b.person({ phone: true });
    const small = phone.page.locator('#server-gauge');
    await phone.until('the gauge is on the phone', async () => small.isVisible());
    const box = await small.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 780, JSON.stringify(box));
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
});

test('Settings, Logs and restart: a source over a span, secrets masked, copied whole, kept as a file; this server started again when asked twice', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-logs');
    await me.page.locator('#logs-source').selectOption('system');
    await me.page.locator('#logs-span').selectOption('boot');
    await me.page.locator('#logs-show').click();
    await me.until('the lines are shown', async () => /Out of memory: Killed process 4242/.test(await me.page.locator('#logs-text').innerText().catch(() => '')));
    const text = await me.page.locator('#logs-text').innerText();
    assert.match(text, /system\[1\]: started \(boot\)/);
    assert.match(text, /password=\[masked\]/);
    assert.doesNotMatch(text, /hunter2/);
    assert.equal(await me.page.locator('#logs-said').innerText(), '3 lines.');
    const [file] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#logs-save').click()]);
    assert.match(file.suggestedFilename(), /^clavarium-system-since-start-.*\.log$/);
    await me.page.locator('#logs-copy').click();
    await me.until('copied, or selected for Ctrl+C', async () => /^(Copied: 3 lines\.|Selected: )/.test(await me.page.locator('#logs-said').innerText()));
    /* No line folded into a narrow column: the box is as wide as the chapter. */
    const box = await me.page.locator('#logs-text').boundingBox();
    assert.ok(box.width > 300, JSON.stringify(box));
    /* Restart: the first click asks, the second does. */
    await me.page.locator('#server-restart').click();
    assert.equal(existsSync(join(b.dir, 'restart-asked')), false, 'one click does nothing yet');
    assert.match(await me.page.locator('#server-restart').innerText(), /Yes: restart this server now/);
    await me.page.locator('#server-restart').click();
    await me.until('asked of the host', async () => existsSync(join(b.dir, 'restart-asked')));
    assert.deepEqual(me.errors, []);
});

test('Settings, the disks: every disk whole, formatted or not; the system one never erased; one prepared once its name is typed; one mounted; the machines offered a place', { skip: SKIP }, async (t) => {
    const b = await bench(t, { serverRoomMs: 200 });
    const me = await b.person();
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-resources');
    await me.page.locator('#move-machines-box > summary').click();
    const card = (name) => me.page.locator(`#move-machines-rows .disk-card[data-disk="${name}"]`);
    await me.until('the disks are listed', async () => (await me.page.locator('#move-machines-rows .disk-card').count()) === 4);
    assert.deepEqual(await me.page.locator('#move-machines-rows .disk-card').evaluateAll((all) => all.map((c) => c.dataset.disk)), ['sda', 'sdd', 'sdc', 'sdb'], 'never the floppy; the machines\' disk first, then the largest');
    assert.match(await card('sda').innerText(), /The system's disk\. The machines are here now\./);
    assert.equal(await card('sda').locator('.disk-prepare').count(), 0, 'the system disk is never offered to be erased');
    assert.match(await card('sdb').innerText(), /Empty: never formatted/);
    assert.match(await card('sdd').innerText(), /mounted at \/mnt\/data/);
    assert.equal(await card('sdd').getByRole('button', { name: 'Move the machines here...' }).isEnabled(), true);
    await me.page.screenshot({ path: join(b.dir, 'disks.png'), fullPage: true });
    if (process.env.SHOTS) await me.page.locator('#move-machines-box').screenshot({ path: join(process.env.SHOTS, 'disks.png') });
    /* The system's volume, made small at installation: its unused room offered, asked twice, given while it runs. */
    assert.match(await card('sda').innerText(), /1\.7 TB of this disk is set aside but not used/);
    const give = card('sda').getByRole('button', { name: /^Give 1\.7 TB to the system/ });
    await give.click();
    assert.match(await card('sda').getByRole('button', { name: /^Yes: grow \/ by 1\.7 TB$/ }).innerText(), /grow/);
    await card('sda').getByRole('button', { name: /^Yes: grow/ }).click();
    await me.until('grown', async () => /\/ has grown: 1\.8 TB now\./.test(await me.page.locator('#move-machines-said').innerText()));
    await me.until('no room left to offer', async () => !/set aside but not used/.test(await card('sda').innerText().catch(() => '')));
    /* Prepared: its name typed again, nothing before. */
    await card('sdb').getByRole('button', { name: 'Prepare for the machines...' }).click();
    const yes = card('sdb').getByRole('button', { name: 'Erase sdb' });
    assert.equal(await yes.isEnabled(), false);
    await card('sdb').locator('input').fill('sdc');
    assert.equal(await yes.isEnabled(), false, 'another name does not do');
    await card('sdb').locator('input').fill('sdb');
    await yes.click();
    await me.until('prepared and mounted', async () => /mounted at \/mnt\/sdb/.test(await card('sdb').innerText().catch(() => '')));
    /* A file system mounted as it is: nothing changed on it. */
    assert.match(await card('sdc').innerText(), /ext4, not mounted/);
    assert.match(await card('sdc').innerText(), /Erase and prepare/, 'what is on it would be erased: said');
    await card('sdc').getByRole('button', { name: 'Mount it' }).click();
    await me.until('mounted', async () => /mounted at \/mnt\/sdc1/.test(await card('sdc').innerText().catch(() => '')));
    assert.match(await card('sdc').innerText(), /too small/, 'too small for the machines: said, not offered');
    assert.equal(await me.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(me.errors, []);
});

test('the curves: memory, CPU and disk over time, of this server (with its reserve) and of a machine; the span chosen; the value under the pointer', { skip: SKIP }, async (t) => {
    const b = await bench(t, { serverRoomMs: 100, historyEveryMs: 300 });
    const me = await b.person();
    await me.create('alpha');
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-resources');
    const curves = me.page.locator('#server-curves');
    await me.until('three curves, with a line drawn', async () => (await curves.locator('.curve').count()) === 3 && (await curves.locator('.curve[data-measure="cpu"] .curve-line').count()) === 1, 30_000);
    assert.deepEqual(await curves.locator('.curve b').allInnerTexts(), ['Memory', 'CPU', 'Disk']);
    assert.match(await curves.locator('.curve[data-measure="memory"] .curve-now').innerText(), /^\d+ %$/);
    assert.equal(await curves.locator('.curve[data-measure="memory"] .curve-reserve').count(), 1, 'the reserve, dotted');
    const plot = curves.locator('.curve[data-measure="memory"] svg');
    await me.until('the value under the pointer', async () => {
        await plot.hover({ position: { x: 5, y: 30 } }); await plot.hover({ position: { x: 250, y: 30 } });
        return /: \d+ %$/.test(await curves.locator('.curve[data-measure="memory"] .curve-tip').innerText().catch(() => ''));
    });
    if (process.env.SHOTS) await curves.screenshot({ path: join(process.env.SHOTS, 'curves-server.png') });
    await curves.locator('.curves-span button[data-span="7d"]').click();
    await me.until('the week', async () => (await curves.locator('.curves-span button[aria-pressed="true"]').innerText()) === '7 days');
    /* A machine's own, in its Machine chapter. */
    await me.page.locator('#nav-conversations').click().catch(() => {});
    await me.page.goto(`${b.origin}/?c=alpha`);
    await me.page.locator('#folders').click();
    await me.chapter('machine');
    const mine = me.page.locator('#machine-curves');
    await me.until('its curves', async () => (await mine.locator('.curve[data-measure="cpu"] .curve-line').count()) === 1, 30_000);
    assert.equal(await mine.locator('.curve-reserve').count(), 0, 'a machine has no reserve of its own');
    if (process.env.SHOTS) await mine.screenshot({ path: join(process.env.SHOTS, 'curves-machine.png') });
    assert.equal(await me.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(me.errors, []);
});

test('What happened: what was done from the page, dated and in words; chosen by kind, searched; a secret by its name only', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('alpha');
    await me.api('/api/secrets', { name: 'DEPLOY_KEY', value: 'never-shown-anywhere' });
    await me.api('/api/resources', { name: 'notes' });
    await me.api('/api/conversations/alpha/resources', { resource: 'notes', access: 'write' });
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-events');
    const lines = () => me.page.locator('#events-list .event-text').allInnerTexts();
    await me.until('said, newest first', async () => (await lines()).length >= 4);
    assert.deepEqual((await lines()).slice(0, 4), ['notes given to alpha (write)', 'Folder notes added', 'Secret DEPLOY_KEY set', 'Conversation "alpha" made (shell)']);
    assert.doesNotMatch(await me.page.locator('#events-list').innerText(), /never-shown/);
    await me.page.locator('#events-kind').selectOption('asset');
    await me.until('only folders, repositories, secrets', async () => (await lines()).join('|') === 'Folder notes added|Secret DEPLOY_KEY set');
    await me.page.locator('#events-kind').selectOption('');
    await me.page.fill('#events-q', 'alpha');
    await me.until('searched', async () => (await lines()).join('|') === 'notes given to alpha (write)|Conversation "alpha" made (shell)');
    if (process.env.SHOTS) await me.page.locator('#settings-events-top').screenshot({ path: join(process.env.SHOTS, 'events.png') });
    assert.deepEqual(me.errors, []);
});

test('a flow exported with the files of its folders, and imported: the folder made again with its files, its conversation with it', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('alpha');
    await me.api('/api/resources', { name: 'notes' });
    await me.api('/api/conversations/alpha/resources', { resource: 'notes', access: 'write' });
    const notes = join(b.dir, 'data', 'resources', 'notes');
    mkdirSync(join(notes, 'deep'), { recursive: true });
    writeFileSync(join(notes, 'hello.txt'), 'kept across'); writeFileSync(join(notes, 'deep', 'more.txt'), 'and this');
    await me.page.locator('#nav-settings').click();
    await me.page.locator('#settings-ch-backup > summary').click();
    await me.page.locator('#flows-with-files').check();
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#flows-export').click()]);
    assert.match(download.suggestedFilename(), /\.clavarium\.tar\.gz$/);
    const file = join(b.dir, 'flow.clavarium.tar.gz'); await download.saveAs(file);
    await me.until('said how much', async () => /with 2 files from 1 folder/.test(await me.page.locator('#flows-said').innerText()));
    /* Gone from here: the conversation archived, the folder removed. */
    assert.equal((await me.api('/api/conversations/alpha/archive', {})).status, 200);
    assert.equal((await me.api('/api/resources/notes/remove', {})).status, 200);
    /* Imported back: shown first, then made. */
    await me.page.locator('#flows-file').setInputFiles(file);
    await me.until('shown first', async () => /2 files for 1 folder/.test(await me.page.locator('#flows-said').innerText()) && await me.page.locator('#flows-import-go').isVisible(), 30_000);
    await me.page.locator('#flows-import-go').click();
    await me.until('the files are back', async () => existsSync(join(notes, 'deep', 'more.txt')), 120_000);
    assert.equal(readFileSync(join(notes, 'hello.txt'), 'utf8'), 'kept across');
    await me.until('alpha made again', async () => (await me.api('/api/conversations')).body.some((c) => c.name === 'alpha'), 120_000);
    await me.until('the import done', async () => (await me.api('/api/setup/import')).body?.done === true, 180_000);
    const job = (await me.api('/api/setup/import')).body;
    assert.equal(job.failed, 0, JSON.stringify(job.steps));
    assert.ok(job.steps.some((s) => /^Folder notes: made, with its files$/.test(s.text) && s.why === '2 files'), JSON.stringify(job.steps));
    assert.deepEqual(me.errors, []);
});

test('Settings, Network: the Wi-Fi this server is on; another one joined with its password, said before what happens if it does not work; the outcome read back; one kept forgotten', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-network');
    await me.until('the network in use is said', async () => /^On Home \(Wi-Fi, wlan0\)/.test(await me.page.locator('#wifi-now').innerText().catch(() => '')));
    await me.page.locator('#wifi-scan').click();
    const net = (ssid) => me.page.locator(`#wifi-list .wifi-network[data-ssid="${ssid.replace(/"/g, '\\"')}"]`);
    await me.until('the networks are listed', async () => (await me.page.locator('#wifi-list .wifi-network').count()) === 4);
    assert.equal(await net('Corp').locator('button').isDisabled(), true, '802.1X: not joined here');
    assert.equal(await net('Home').locator('button').isDisabled(), true, 'the one in use');
    assert.equal(await net('Café "Guest"').locator('.wifi-lock').count(), 1, 'a lock on a protected one');
    assert.equal(await net('Open Lounge').locator('.wifi-lock').count(), 0);
    /* A wrong password: asked, never shown back; what happens if it does not work said before; back on Home. */
    await net('Café "Guest"').locator('button').click();
    assert.equal(await me.page.locator('#wifi-password').getAttribute('type'), 'password');
    assert.equal(await me.page.locator('#wifi-join-back').innerText(), 'If it does not work within a minute, the server goes back to "Home" by itself. This page may lose the server meanwhile: it comes back by itself.');
    if (process.env.SHOTS) await me.page.locator('#settings-wifi-top').screenshot({ path: join(process.env.SHOTS, 'wifi.png') });
    await me.page.fill('#wifi-password', 'not-the-password');
    await me.page.locator('#wifi-join-go').click();
    await me.until('it went back', async () => /did not work \(the password was not accepted\): the server went back to "Home"/.test(await me.page.locator('#wifi-last').innerText().catch(() => '')));
    assert.equal(await me.page.inputValue('#wifi-password'), '', 'not kept in the page');
    /* The right one: joined. */
    await me.page.locator('#wifi-scan').click();
    await me.until('listed again', async () => (await net('Café "Guest"').count()) === 1);
    await net('Café "Guest"').locator('button').click();
    await me.page.fill('#wifi-password', 'right-password');
    await me.page.locator('#wifi-join-go').click();
    await me.until('joined', async () => /^On Café "Guest"/.test(await me.page.locator('#wifi-now').innerText().catch(() => '')));
    assert.match(await me.page.locator('#wifi-last').innerText(), /"Café "Guest"" worked/);
    /* Forgotten, asked twice; never the one in use. */
    await me.page.locator('#wifi-saved-box > summary').click();
    assert.match(await me.page.locator('#wifi-saved').innerText(), /Café "Guest"\s*in use/);
    const office = me.page.locator('#wifi-saved .folder', { hasText: 'Office' }).getByRole('button');
    await office.click(); await office.click();
    await me.until('forgotten', async () => !/Office/.test(await me.page.locator('#wifi-saved').innerText()));
    const said = (await me.api('/api/events?kind=server')).body.map((e) => e.text);
    assert.ok(said.includes('Wi-Fi: joining "Café "Guest"" asked') && said.includes('Wi-Fi: "Office" forgotten'), said.join(' | '));
    assert.ok(!said.join(' ').includes('password'), 'no password in What happened');
    assert.deepEqual(me.errors, []);
});

test('Settings, Network: Wi-Fi managed outside Clavarium on this server: one sentence, no controls', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    writeFileSync(join(b.dir, 'wifi.json'), JSON.stringify({ using: null, saved: [], last: null }));
    const me = await b.person();
    await me.page.route('**/api/wifi', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: false, why: 'no-nmcli', device: null, using: null, saved: [], last: null }) }));
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-network');
    await me.until('said', async () => /managed outside Clavarium on this server/.test(await me.page.locator('#wifi-now').innerText().catch(() => '')));
    assert.equal(await me.page.locator('#wifi-controls').isVisible(), false);
});

test('Settings, Network: a network set up when Ubuntu was installed, handed over to NetworkManager from here, asked twice; its Wi-Fi then chosen here', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    writeFileSync(join(b.dir, 'wifi.json'), JSON.stringify({ using: 'Home', saved: ['Home'], last: null, outside: true }));
    const me = await b.person();
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-network');
    await me.until('said, and offered', async () => await me.page.locator('#wifi-hand').isVisible());
    assert.equal(await me.page.locator('#wifi-now').innerText(), 'Clavarium does not manage this server\'s network yet.');
    assert.equal(await me.page.locator('#wifi-hand-about').innerText(), 'Let Clavarium manage it: Wi-Fi chosen here, a cable taken by itself. Your Wi-Fi stays as it is.');
    assert.equal(await me.page.locator('#wifi-controls').isVisible(), false);
    const go = me.page.locator('#wifi-hand-go');
    await go.click();
    assert.equal(await go.innerText(), 'Confirm (undone by itself if it fails)');
    assert.equal(existsSync(join(b.dir, 'wifi.json')) && JSON.parse(readFileSync(join(b.dir, 'wifi.json'), 'utf8')).hand, undefined, 'one click asks nothing of the host');
    if (process.env.SHOTS) await me.page.locator('#settings-wifi-top').screenshot({ path: join(process.env.SHOTS, 'network-handover.png') });
    await go.click();
    await me.until('handed over, its Wi-Fi shown', async () => /^Done: Clavarium manages the network\.$/.test(await me.page.locator('#wifi-hand-said').innerText().catch(() => '')) && /^On Home \(Wi-Fi, wlan0\)/.test(await me.page.locator('#wifi-now').innerText().catch(() => '')), 20_000);
    assert.equal(await me.page.locator('#wifi-hand').isVisible(), false, 'not offered twice');
    assert.equal(await me.page.locator('#wifi-controls').isVisible(), true);
    if (process.env.SHOTS) await me.page.locator('#settings-wifi-top').screenshot({ path: join(process.env.SHOTS, 'network-handed.png') });
    const said = (await me.api('/api/events?kind=server')).body.map((e) => e.text);
    assert.ok(said.includes('Network: management by Clavarium asked'), said.join(' | '));
    assert.deepEqual(me.errors, []);
});
