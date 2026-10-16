import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('the chat screen: parley installed by the server from /tools, the tool asks with choices; its owner answers on a French device; the line that wakes it is typed once; what it does now, gone with its next message; times on hover; steps folded or unfolded; the chat first when opened; the owner\'s own words', { skip: SKIP }, async (t) => {
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
    await me.until('it says what the tool will be asked', async () => /parley is installed in its machine, to use it and to write to you in French/.test(await me.page.locator('#talk-declare').innerText().catch(() => '')));
    /* What its tool is told about where it is (guide.mjs): the exact text behind "see", made from these
       settings; the owner's lines, as text; in its machine, and pointed to from its own instruction file. */
    await me.page.locator('#guide-see').click();
    await me.until('the guide says its chat is on', async () => /^- Chat with the person: on\. Parley is installed: run parley --help\.$/m.test(await me.page.locator('#guide-text').innerText().catch(() => '')));
    await me.page.fill('#guide-lines', 'Answer in <b>French</b>.');
    await me.page.locator('#guide-save').click();
    await me.until('the line is in what it is told, as text', async () => (await me.page.locator('#guide-text').innerText()).includes('- Answer in \u2039b\u203aFrench\u2039/b\u203a.'));
    const vm = join(process.env.FAKE_VM_DIR, 'vms', 'clv-helper', 'root');
    await me.until('its machine has it', async () => existsSync(join(vm, 'etc/clavarium/conversation.md')) && readFileSync(join(vm, 'etc/clavarium/conversation.md'), 'utf8').includes('- Answer in'));
    assert.match(readFileSync(join(vm, '.tool/RULES.md'), 'utf8'), /^<!-- clavarium -->\nRead \/tools\/CLAVARIUM\.md and \/etc\/clavarium\/conversation\.md first/m);
    assert.match(readFileSync(join(vm, 'tools/CLAVARIUM.md'), 'utf8'), /^# Where you are \(Clavarium\)$/m);
    /* Told again only on a click: one line typed in its terminal. */
    await me.page.locator('#guide-tell').click();
    await me.until('it says what was typed', async () => /Typed in its terminal/.test(await me.page.locator('#guide-said').innerText()));
    /* Asked: one line typed in its terminal. A shell takes it for a command, and runs nothing of it. */
    await me.page.locator('#talk-invite').click();
    await me.page.locator('#panel-close').click();
    await me.sees('/etc/clavarium/conversation.md again: your setup changed.');
    await me.sees('Write to them in French.');
    const invited = (await me.screen()).replace(/\n/g, '');
    assert.match(invited, /Parley is installed: run "parley --help"\./);
    assert.doesNotMatch(invited, /npm|install -g|\.tgz/, 'the tool is never asked to install anything');
    assert.match(invited, /under \/work, never in \/tmp/, 'where to check out its branches');
    /* Installed by the server, before: in the machine's /usr/local (here, under the stand-in machine's root, whose PATH the shell is given). */
    assert.match(readFileSync(join(process.env.FAKE_VM_DIR, 'vms', 'clv-helper', 'npm-installs'), 'utf8'), /^\/tools\/clavarium-parley-\d+\.\d+\.\d+\.tgz\n$/);
    await me.type('clear; export PATH="$FAKE_VM_ROOT"/usr/local/bin:$PATH; grep -c sha256 "$FAKE_VM_ROOT"/tools/index.json');
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
    /* Above the box: its choices first, then the owner's ready answers; the bar's, which type into the terminal, are not shown. */
    const quickly = () => me.page.locator('#simple-thread .parley-replies button').allInnerTexts();
    await me.until('the quick answers are above the box', async () => (await quickly()).join('|') === 'blue|red|Yes, go on|Run the tests|Summarise');
    /* Its choices are near the box only when its own buttons scrolled away: never twice on the screen. */
    const rowChoice = me.page.locator('#simple-thread .parley-replies .parley-answer').first();
    await me.until('not twice', async () => !(await rowChoice.isVisible()));
    const threadEl = me.page.locator('#simple-thread .parley-thread');
    await threadEl.evaluate((e) => { e.style.flex = 'none'; e.style.height = '3em'; });
    await wait(300);
    await threadEl.evaluate((e) => { e.scrollTop = 0; });
    await me.until('near the box once scrolled away', async () => rowChoice.isVisible());
    await threadEl.evaluate((e) => { e.style.flex = ''; e.style.height = ''; });
    assert.deepEqual([await me.page.locator('#shortcuts').isVisible(), await me.page.locator('#keys').isVisible()], [false, false]);
    /* The owner answers with one touch; then writes, before the tool has read. */
    await asked.locator('button', { hasText: 'blue' }).click();
    await me.until('the answer is in the thread, and the choices are gone', async () => (await me.page.locator('#simple-thread .parley-said[data-from=person]').first().innerText().catch(() => '')).startsWith('blue') && (await asked.locator('button').count()) === 0);
    await me.until('its choices left the quick answers', async () => (await quickly())[0] === 'Yes, go on');
    /* With a keyboard: Shift+Enter is a new line, Enter sends, and the cursor stays in the box. */
    const chatBox = me.page.locator('#simple-thread .parley-box');
    await chatBox.click();
    await chatBox.pressSequentially('Keep it');
    await me.page.keyboard.press('Shift+Enter');
    assert.equal(await chatBox.inputValue(), 'Keep it\n', 'a new line, not sent');
    await me.page.fill('#simple-thread .parley-box', 'Keep it under two pages.');
    await me.page.keyboard.press('Enter');
    await me.until('sent with Enter', async () => (await chatBox.inputValue()) === '' && (await me.page.locator('#simple-thread .parley-said[data-from=person]').count()) === 2);
    assert.equal(await me.page.evaluate(() => document.activeElement?.className), 'parley-box');
    /* The size of the text, the page's one setting, is the chat's too. */
    const size = () => me.page.locator('#simple-thread .parley-said .parley-text').first().evaluate((e) => Number.parseFloat(getComputedStyle(e).fontSize));
    const before = await size();
    await me.page.keyboard.press('Control+=');
    await me.until('the chat\'s text grew', async () => (await size()) > before * 1.05);
    await me.page.keyboard.press('Control+0');
    await me.until('back to normal', async () => (await size()) === before);
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
    await me.page.locator('#nav-settings').click();
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
    /* A ready answer that presses Enter is sent from the chat at once; the other is put in its box, to be completed. */
    await me.api('/api/shortcuts', { label: 'Start with', text: 'Start with the cover', enter: false });
    await me.page.reload();
    await me.until('the new one is there', async () => (await me.page.locator('#simple-thread .parley-reply', { hasText: 'Start with' }).count()) === 1);
    await me.page.locator('#simple-thread .parley-reply', { hasText: 'Start with' }).click();
    assert.equal(await me.page.locator('#simple-thread .parley-box').inputValue(), 'Start with the cover');
    await me.page.fill('#simple-thread .parley-box', '');
    await me.page.locator('#simple-thread .parley-reply', { hasText: 'Summarise' }).click();
    await me.until('sent in one tap', async () => (await me.api('/api/conversations/helper/talk')).body.messages.some((m) => m.text === 'Summarise what you did, in five lines.'));
    assert.equal(await me.page.locator('#simple-thread .parley-send b').count(), 0, 'as text, never as markup');
    /* The chat is where it opens, everywhere: from the list on a phone, and on a device it was shared with. */
    /* Many ready answers, for the shared phone below. */
    for (const n of [1, 2, 3, 4]) await me.api('/api/shortcuts', { label: `Ready answer ${n}`, text: `Answer ${n}.`, enter: true });
    const pocket = await b.person({ phone: true, locale: 'fr-FR' });
    await pocket.page.locator('#items .item', { hasText: 'helper' }).click();
    await pocket.until('the phone opens on its chat', async () => (await pocket.page.locator('#simple-thread .parley-said[data-kind=ask]').count()) > 0);
    assert.equal(await pocket.page.locator('#simple-toggle').innerText(), 'Terminal', 'its terminal one tap away');
    /* Its terminal went with it, one screen at a time: the computer says so, and takes it back. */
    await me.until('the computer is told', async () => /now open on another screen/.test(await me.page.locator('#notice-text').innerText().catch(() => '')) && me.page.locator('#notice').isVisible());
    await me.page.locator('#notice-action', { hasText: 'Use it here' }).click();
    await me.until('back here', async () => (await me.state()) === 'live' && !(await me.page.locator('#notice').isVisible()));
    await me.page.locator('#folders').click();
    await me.chapter('sharing');
    await me.page.locator('#share').click();
    await me.until('the basket holds it', async () => (await me.page.locator('#share-basket .folder').count()) === 1);
    /* It talks through the app: its chat is proposed, not its terminal; the one ticked cannot be unticked. */
    const part = (where, name) => me.page.locator(`${where} label[data-part=${name}] input`);
    assert.deepEqual([await part('#share-basket', 'chat').isChecked(), await part('#share-basket', 'terminal').isChecked(), await part('#share-basket', 'chat').getAttribute('aria-disabled')], [true, false, 'true']);
    await part('#share-basket', 'chat').uncheck({ force: true }).catch(() => {});
    assert.equal(await part('#share-basket', 'chat').isChecked(), true, 'at least one');
    assert.equal(await me.page.locator('#share-basket .parts-need').isVisible(), true);
    assert.match(await me.page.locator('#sharing-summary').innerText(), /will be able to write in the chat of helper, and see its files\./);
    await me.page.fill('#sharing-label', 'A phone');
    await me.page.locator('#sharing-new').click();
    await me.until('a code is shown', async () => me.page.locator('#sharing-qr').isVisible());
    const code = (await me.page.locator('#sharing-link').innerText()).replace(/^https?:\/\/[^/]+/, '');
    await me.page.locator('#sharing-close').click();
    const device = await b.person({ phone: true, at: code, locale: 'fr-FR' });
    await device.until('the device is welcomed to a chat', async () => /as in a messaging app/.test(await device.page.locator('#notice-text').innerText().catch(() => '')));
    await device.page.locator('#notice-action', { hasText: 'Start' }).click();
    await device.until('the device opens on its chat', async () => (await device.page.locator('#simple-thread .parley-said[data-kind=ask]').count()) > 0);
    /* On a phone: the keyboard never comes up by itself; opened by a finger, it stays open after sending. */
    const phoneBox = device.page.locator('#simple-thread .parley-box');
    const focused = () => device.page.evaluate(() => document.activeElement?.className ?? '');
    assert.notEqual(await focused(), 'parley-box', 'not focused by the page');
    await phoneBox.tap();
    await phoneBox.fill('From the shared phone.');
    await device.page.locator('#simple-thread .parley-send').tap();
    await device.until('sent', async () => (await phoneBox.inputValue()) === '');
    assert.equal(await focused(), 'parley-box', 'the keyboard stays open');
    await phoneBox.press('Enter');
    assert.equal(await phoneBox.inputValue(), '\n', 'on a touch screen Enter is a new line; the button sends');
    await phoneBox.fill('');
    /* Many ready answers: one line, the rest one tap away, the keyboard left as it was. */
    const more = device.page.locator('#simple-thread .parley-replies-more');
    await device.until('folded, said how many more', async () => /^\d+ de plus$/.test(await more.innerText().catch(() => '')));
    const shownLine = () => device.page.locator('#simple-thread .parley-replies').evaluate((e) => e.getBoundingClientRect().height);
    const folded = await shownLine();
    await more.tap();
    assert.ok((await shownLine()) > folded * 1.5, 'unfolded on a tap');
    assert.equal(await focused(), 'parley-box', 'the keyboard, open, stays open');
    await me.until('written from the device, read here', async () => (await me.api('/api/conversations/helper/talk')).body.messages.some((m) => m.text === 'From the shared phone.'));
    const pairing = await device.page.evaluate(() => document.documentElement.dataset.pairing);
    /* Its chat alone: files travel in the chat, both ways -- what the tool showed, and what this phone attaches -- and nothing more. */
    assert.equal(await device.page.locator('#files-open').isVisible(), false, 'no file browser');
    assert.equal((await device.api(`/c/api/${pairing}/files?r=work&p=`)).status, 403, 'refused by the server too');
    await device.page.locator('#simple-thread .parley-said[data-kind=show] .parley-open').first().tap();
    await device.until('what the tool showed opens', async () => (await device.page.locator('#preview-body pre').innerText().catch(() => '')).includes('38 orders, 3 late'));
    assert.equal(await device.page.locator('#preview-where').isVisible(), false, 'no way to the folder it sits in');
    await device.page.locator('#preview-close').tap();
    await device.page.locator('#simple-thread input[type=file]').setInputFiles({ name: 'dad.txt', mimeType: 'text/plain', buffer: Buffer.from('a photo of dad') });
    await device.until('shown above the box', async () => (await device.page.locator('#simple-thread .parley-pending').innerText().catch(() => '')).includes('dad.txt'));
    await phoneBox.fill('The photo.');
    await device.page.locator('#simple-thread .parley-send').tap();
    await me.until('the tool is given its path', async () => (await me.api('/api/conversations/helper/talk')).body.messages.some((m) => m.text === 'The photo.' && /^\/work\/\.parley\/files\/[0-9a-f-]{36}\/dad\.txt$/.test(m.files?.[0]?.path ?? '')));
    assert.equal(await device.page.locator('#simple-thread .parley-pending').count(), 0, 'gone from above the box once sent');
    await device.page.locator('#simple-thread .parley-said[data-from=person]', { hasText: 'The photo.' }).locator('.parley-open').tap();
    await device.until('it opens from its message', async () => (await device.page.locator('#preview-body pre').innerText().catch(() => '')).includes('a photo of dad'));
    await device.page.locator('#preview-close').tap();
    assert.equal((await device.api(`/c/api/${pairing}/conversations/helper/talk`, { on: false })).status, 400, 'a device writes; turning it off is not a device\'s');
    assert.equal((await me.api('/api/conversations/helper/talk')).body.on, true);
    /* Its chat alone: no way to the terminal on the page, and none on the server either. */
    assert.equal(await device.page.locator('#simple-toggle').isVisible(), false);
    assert.equal(await device.page.locator('#keys button[data-keys]').first().isVisible(), false, 'no keys');
    assert.equal(await device.page.evaluate((d) => new Promise((done) => { const ws = new WebSocket(`ws://${location.host}/c/terminal?d=${d}&c=helper`); ws.onopen = () => { ws.close(); done('opened'); }; ws.onclose = () => done('refused'); }), pairing), 'refused');
    /* What it may write in, it may dictate into, and it has the owner's ready answers there. */
    assert.equal((await device.api(`/c/api/${pairing}/shortcuts`)).status, 200);
    await device.until('dictation and ready answers in its chat', async () => (await device.page.locator('#simple-thread .parley-mic').isVisible()) && (await device.page.locator('#simple-thread .parley-reply').count()) > 0);
    /* A device given its terminal alone, at the same time: the terminal, and nothing of the chat. */
    const typing = await b.person({ phone: true, at: (await me.api('/api/conversations/helper/share', { rights: 'x' })).body.url.replace(/^https?:\/\/[^/]+/, '') });
    await typing.until('welcomed to its terminal', async () => /Tap the dark screen/.test(await typing.page.locator('#notice-text').innerText().catch(() => '')));
    await typing.page.locator('#notice-action', { hasText: 'Start' }).click();
    await typing.until('its terminal is live', async () => (await typing.state()) === 'live');
    assert.deepEqual([await typing.page.locator('#simple').isVisible(), await typing.page.locator('#simple-toggle').isVisible()], [false, false], 'no chat, no way to it');
    const typingId = await typing.page.evaluate(() => document.documentElement.dataset.pairing);
    assert.equal((await typing.api(`/c/api/${typingId}/conversations/helper/talk`)).status, 403);
    /* Turned off: it opens on its terminal again, as it did before. */
    await me.api('/api/conversations/helper/talk', { on: false });
    await pocket.page.reload();
    await pocket.until('the terminal again', async () => (await pocket.state()) === 'live');
    assert.equal(await pocket.page.locator('#simple').isVisible(), false, 'off: nothing changed');
    await me.until('the computer is told again', async () => /now open on another screen/.test(await me.page.locator('#notice-text').innerText().catch(() => '')) && me.page.locator('#notice').isVisible());
    await me.page.locator('#notice-action', { hasText: 'Use it here' }).click();
    /* The device given its chat alone says so plainly -- and cannot turn it on. */
    await device.page.reload();
    await device.until('it says the chat is not on', async () => /The chat is not turned on/.test(await device.page.locator('#chat-off').innerText().catch(() => '')) && await device.page.locator('#chat-off').isVisible());
    assert.equal((await device.api(`/c/api/${pairing}/conversations/helper/talk`, { on: true })).status, 409, 'it is off: nothing to write in, and nothing turns it on');
    assert.equal((await me.api('/api/conversations/helper/talk')).body.on, false);
    /* Changed later, in the conversation's Sharing chapter: its terminal is given too, and the device opens on it. */
    await me.page.locator('#folders').click();
    await me.chapter('sharing');
    const row = me.page.locator('#share-here .given-row', { hasText: 'A phone' });
    await me.until('the device is listed with its parts', async () => (await row.count()) === 1);
    assert.match(await row.innerText(), /Its chat is off/);
    await row.locator('label[data-part=terminal] input').check();
    await me.until('its terminal is given', async () => (await me.api('/api/devices')).body.find((d) => d.id === pairing)?.grants[0].rights === 'rwx');
    await device.page.reload();
    await device.until('the device has its terminal now', async () => (await device.state()) === 'live');
    assert.equal(await device.page.locator('#chat-off').isVisible(), false);
    assert.deepEqual([me.errors, pocket.errors, device.errors, typing.errors], [[], [], [], []]);
});
