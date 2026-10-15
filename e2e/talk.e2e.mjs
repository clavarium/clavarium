import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('the chat screen: the tool installs parley from /tools and asks with choices; its owner answers on a French device; the line that wakes it is typed once; what it does now, gone with its next message; times on hover; steps folded or unfolded; the chat first when opened; the owner\'s own words', { skip: SKIP }, async (t) => {
    const alerted = [];
    const b = await bench(t, { alertSend: async (subscription, payload) => { alerted.push(JSON.parse(payload)); } });
    const me = await b.person({ locale: 'fr-FR' });
    await me.create('helper');
    await me.api('/api/alerts', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a-device', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }, label: 'Phone' });
    /* Off, and said plainly what turning it on means. */
    await me.page.locator('#folders').click();
    await me.until('it says what it is', async () => /WHAT THE TOOL POSTS THERE IS READ BY THIS SERVER/.test(await me.page.locator('#talk-about').innerText()));
    assert.equal(await me.page.locator('#talk-invite').isVisible(), false);
    await me.page.locator('#talk-on button[data-on=true]').click();
    await me.until('it says what the tool will be asked', async () => /install parley from \/tools and to write to you in French/.test(await me.page.locator('#talk-declare').innerText().catch(() => '')));
    /* Asked: one line typed in its terminal. A shell takes it for a command, and runs nothing of it. */
    await me.page.locator('#talk-invite').click();
    await me.page.locator('#panel-close').click();
    await me.sees('Write to them in French.');
    const invited = (await me.screen()).replace(/\n/g, '');
    assert.match(invited, /run "npm install -g \/tools\/clavarium-parley-\d+\.\d+\.\d+\.tgz"/);
    assert.match(invited, /under \/work, never in \/tmp/, 'where to check out its branches');
    /* The tool installs it, from the read-only /tools of its machine (here, under the stand-in machine's root). */
    await me.type('clear; P=$(mktemp -d); npm install -g --offline --no-audit --no-fund --prefix $P "$FAKE_VM_ROOT"/tools/clavarium-parley-*.tgz >/dev/null 2>&1 && export PATH=$P/bin:$PATH; grep -c sha256 "$FAKE_VM_ROOT"/tools/index.json');
    await me.printed('1', 30_000);
    /* It says where it is, and asks, with choices; it does not wait. */
    await me.type('clear; parley status working "on the cover" && parley ask "Blue or red cover?" blue red >/dev/null && echo posted');
    await me.printed('posted');
    /* The owner's phone is told that the tool asks, in French. */
    await me.until('the phone is told', async () => alerted.length === 1, 15_000);
    assert.deepEqual(alerted[0], { title: 'helper vous pose une question', body: 'Blue or red cover?', url: '/?c=helper' });
    await me.until('the plain screen is its chat', async () => (await me.page.locator('#simple-toggle').innerText()) === 'Chat');
    await me.page.locator('#simple-toggle').click();
    const asked = me.page.locator('#simple-thread .parley-said[data-kind=ask]');
    await me.until('the question is on the chat screen, in French', async () => (await asked.innerText().catch(() => '')).includes('Blue or red cover?') && (await asked.innerText()).includes('Il vous demande'));
    assert.equal(await me.page.locator('#simple-thread .parley-send').innerText(), 'Envoyer');
    assert.equal(await me.page.locator('#simple-says').isVisible(), false, 'what its terminal shows is not on the chat screen');
    /* The owner answers with one touch; then writes, before the tool has read. */
    await asked.locator('button', { hasText: 'blue' }).click();
    await me.until('the answer is in the thread, and the choices are gone', async () => (await me.page.locator('#simple-thread .parley-said[data-from=person]').first().innerText().catch(() => '')).startsWith('blue') && (await asked.locator('button').count()) === 0);
    await me.page.fill('#simple-thread .parley-box', 'Keep it under two pages.');
    await me.page.locator('#simple-thread .parley-send').click();
    await me.until('said not read yet', async () => (await me.page.locator('#simple-thread').innerText()).includes('Pas encore lu'));
    /* In its terminal, ONE line, once somebody stopped typing there: that a message arrived, and only that. */
    await me.until('the line was typed to the tool', async () => (await me.screen()).includes('You have a new message: run "parley read".'), 20_000);
    await new Promise((r) => setTimeout(r, 600));
    const screen = await me.screen();
    assert.equal(screen.split('You have a new message').length - 1, 1, 'once, though two messages wait');
    assert.equal(screen.includes('Keep it under two pages'), false, 'what was written is not typed');
    /* The tool reads: the answer to its question, and the message; then says what it does now. */
    await me.page.locator('#simple-toggle').click();
    await me.type('clear; parley read; parley doing "counting the late orders"; echo doing');
    await me.printed('doing');
    const read = (await me.screen()).replace(/\n/g, '');
    assert.ok(read.includes('Answer to your question "Blue or red cover?": blue') && read.includes('Message: Keep it under two pages.'), read);
    /* Under the last message, one line, moving, while it works. */
    await me.page.locator('#simple-toggle').click();
    const now = me.page.locator('#simple-thread .parley-now');
    await me.until('what it does now, under the last message', async () => (await now.innerText().catch(() => '')).includes('counting the late orders'));
    assert.equal(await now.getAttribute('data-live'), 'true');
    assert.equal(await me.page.locator('#simple-thread .parley-thread > :last-child').getAttribute('class'), 'parley-now', 'the last thing in the thread');
    /* It shows two files, one it cannot share, and says it is done. */
    await me.page.locator('#simple-toggle').click();
    await me.type('clear; echo "38 orders, 3 late" > report.txt; printf \'%s\\n\' \'{"id":"s1","at":"2030-01-01T00:00:00.000Z","kind":"show","path":"/work/report.txt","text":"The report."}\' >> .parley/from-agent.jsonl; echo x > /tmp/clv-e2e-secret.txt; parley show /tmp/clv-e2e-secret.txt >/dev/null; parley status done; echo shown');
    await me.printed('shown');
    await me.page.locator('#simple-toggle').click();
    await me.until('the file it can share is there', async () => (await me.page.locator('#simple-thread .parley-said[data-kind=show]').count()) === 1);
    /* Its next message came: the line is gone, and the steps that led there are one click away. */
    assert.equal(await now.count(), 0, 'gone with its next message');
    const report = me.page.locator('#simple-thread .parley-said[data-kind=show]');
    assert.equal(await me.page.locator('#simple-thread .parley-chip').count(), 0, 'simple: no line of their own between messages');
    assert.equal(await report.getAttribute('aria-expanded'), 'false', 'simple: folded into the message they led to');
    assert.match(await report.locator('.parley-time').innerText(), / - 2 étapes$/, 'said with its time');
    await report.locator('.parley-text').click();
    assert.equal(await report.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await me.page.locator('#simple-thread .parley-trail[data-for=s1] .parley-step').allInnerTexts(), ['counting the late orders', 'Terminé'], 'opened above it, as they came');
    /* The day, and the time of a message on hover; on a touch screen, a long press. */
    assert.ok((await me.page.locator('#simple-thread .parley-divider').allInnerTexts()).includes("Aujourd'hui"));
    const mine = me.page.locator('#simple-thread .parley-said[data-from=person]').first();
    const opacity = () => mine.locator('.parley-time').evaluate((e) => getComputedStyle(e).opacity);
    assert.equal(await opacity(), '0', 'simple: not in the way');
    await mine.hover();
    await me.until('its time, on hover', async () => (await opacity()) === '1');
    assert.match(await mine.locator('.parley-time').innerText(), /^\d{1,2}:\d{2}/);
    await me.page.mouse.move(0, 0);
    const pressed = me.page.locator('#simple-thread .parley-said[data-kind=ask]').first();
    await pressed.dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
    await me.until('its time, after a long press', async () => (await pressed.getAttribute('data-reveal')) === 'true');
    assert.equal((await me.page.locator('#simple-thread').innerText()).includes('clv-e2e-secret'), false, 'the simple view shows nothing the person cannot open');
    await me.until('read now', async () => !(await me.page.locator('#simple-thread').innerText()).includes('Pas encore lu'));
    await me.page.locator('#simple-thread .parley-said[data-kind=show] .parley-open').first().click();
    await me.until('the report is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('38 orders, 3 late'));
    await me.page.locator('#preview-close').click();
    /* The detailed view: where it is, the steps it said, every file, a way to its terminal. Remembered on this device. */
    await me.page.locator('#simple-thread .parley-views button[data-view=detailed]').click();
    await me.until('the detailed view', async () => (await me.page.locator('#simple-thread .parley-status').innerText()).startsWith('Terminé'));
    const steps = await me.page.locator('#simple-thread .parley-steps .parley-step').allInnerTexts();
    assert.deepEqual(steps, ['Au travail - on the cover', 'counting the late orders', 'Terminé'], 'every step unfolded where it came, with its state');
    assert.equal(await me.page.locator('#simple-thread .parley-steps .parley-trail[hidden]').count(), 0);
    assert.equal(await me.page.locator('#simple-thread .parley-steps .parley-time').count(), 3, 'each with its time');
    assert.equal(await mine.locator('.parley-time').evaluate((e) => getComputedStyle(e).opacity), '1', 'detailed: the time of every message');
    assert.ok((await me.page.locator('#simple-thread .parley-thread').innerText()).includes("Pas dans un dossier partagé : il ne peut pas être ouvert d'ici."), 'the file it cannot share is said to be outside');
    assert.equal(await me.page.locator('#simple-thread .parley-files li').count(), 2);
    assert.equal(await me.page.locator('#simple-thread .parley-files li[data-outside=true]').count(), 1);
    /* Opened again, it shows its chat first, as it was left; its terminal is one click away, for now. */
    await me.page.locator('#simple-toggle').click();
    assert.equal(await me.page.locator('#simple').isVisible(), false);
    await me.page.reload();
    await me.until('detailed again after a reload', async () => (await me.page.locator('#simple-thread .parley-views button[data-view=detailed]').getAttribute('aria-pressed').catch(() => '')) === 'true');
    assert.equal(await me.page.locator('#simple-thread').isVisible(), true, 'the chat first');
    assert.equal(await me.page.locator('#simple-toggle').innerText(), 'Terminal');
    await me.until('what is typed goes to the chat', async () => (await me.page.evaluate(() => document.activeElement?.className)) === 'parley-box');
    await me.page.locator('#simple-thread .parley-terminal').click();
    assert.equal(await me.page.locator('#simple').isVisible(), false, 'its terminal, as it was');
    /* The owner's own words, for every device, whatever they say: shown as text. */
    await me.page.locator('#settings-open').click();
    await me.page.locator('#words-box summary').click();
    await me.page.fill('#words-own', '{"send": "Clique ici pour faire <b>taratata</b>"}');
    await me.page.locator('#words-save').click();
    await me.until('saved', async () => (await me.page.locator('#words-saved').innerText()) === 'Saved.');
    await me.page.fill('#words-own', '{"sned": "x"}');
    await me.page.locator('#words-save').click();
    await me.until('a word that does not exist is refused', async () => /no such word: sned/.test(await me.page.locator('#words-error').innerText()));
    await me.page.locator('#settings-close').click();
    await me.page.locator('#simple-toggle').click();
    await me.until('the button says it', async () => (await me.page.locator('#simple-thread .parley-send').innerText().catch(() => '')) === 'Clique ici pour faire <b>taratata</b>');
    assert.equal(await me.page.locator('#simple-thread .parley-send b').count(), 0, 'as text, never as markup');
    /* The chat is where it opens, everywhere: from the list on a phone, and on a device it was shared with. */
    const pocket = await b.person({ phone: true, locale: 'fr-FR' });
    await pocket.page.locator('#items .item', { hasText: 'helper' }).click();
    await pocket.until('the phone opens on its chat', async () => (await pocket.page.locator('#simple-thread .parley-said[data-kind=ask]').count()) > 0);
    assert.equal(await pocket.page.locator('#simple-toggle').innerText(), 'Terminal', 'its terminal one tap away');
    await me.page.locator('#folders').click();
    await me.chapter('sharing');
    await me.page.locator('#share').click();
    await me.until('the basket holds it', async () => (await me.page.locator('#share-basket .folder').count()) === 1);
    await me.page.fill('#sharing-label', 'A phone');
    await me.page.locator('#sharing-new').click();
    await me.until('a code is shown', async () => me.page.locator('#sharing-qr').isVisible());
    const code = (await me.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    await me.page.locator('#sharing-close').click();
    const device = await b.person({ phone: true, at: code, locale: 'fr-FR' });
    await device.until('the device is welcomed to a chat', async () => /as in a messaging app/.test(await device.page.locator('#notice-text').innerText().catch(() => '')));
    await device.page.locator('#notice-action', { hasText: 'Start' }).click();
    await device.until('the device opens on its chat', async () => (await device.page.locator('#simple-thread .parley-said[data-kind=ask]').count()) > 0);
    await device.page.fill('#simple-thread .parley-box', 'From the shared phone.');
    await device.page.locator('#simple-thread .parley-send').click();
    await me.until('written from the device, read here', async () => (await me.api('/api/conversations/helper/talk')).body.messages.some((m) => m.text === 'From the shared phone.'));
    const pairing = await device.page.evaluate(() => document.documentElement.dataset.pairing);
    assert.equal((await device.api(`/c/api/${pairing}/conversations/helper/talk`, { on: false })).status, 400, 'a device writes; turning it off is not a device\'s');
    assert.equal((await me.api('/api/conversations/helper/talk')).body.on, true);
    /* Turned off: it opens on its terminal again, as it did before. */
    await me.api('/api/conversations/helper/talk', { on: false });
    await pocket.page.reload();
    await pocket.until('the terminal again', async () => (await pocket.state()) === 'live');
    assert.equal(await pocket.page.locator('#simple').isVisible(), false, 'off: nothing changed');
    assert.deepEqual([me.errors, pocket.errors, device.errors], [[], [], []]);
});
