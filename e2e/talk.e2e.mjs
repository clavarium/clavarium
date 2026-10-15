import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

/* The tool here is a plain shell: what an agent would run, the test types. */
test('the chat screen: the tool installs parley from /tools and asks with choices; its owner answers on a French device; the line that wakes it is typed once; steps and files in the detailed view; the owner\'s own words', { skip: SKIP }, async (t) => {
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
    /* The tool reads: the answer to its question, and the message. It shows two files, one it cannot share. */
    await me.page.locator('#simple-toggle').click();
    await me.type('clear; parley read; echo "38 orders, 3 late" > report.txt; printf \'%s\\n\' \'{"id":"s1","at":"2030-01-01T00:00:00.000Z","kind":"show","path":"/work/report.txt","text":"The report."}\' >> .parley/from-agent.jsonl; echo x > /tmp/clv-e2e-secret.txt; parley show /tmp/clv-e2e-secret.txt >/dev/null; parley status done; echo shown');
    await me.printed('shown');
    const read = (await me.screen()).replace(/\n/g, '');
    assert.ok(read.includes('Answer to your question "Blue or red cover?": blue') && read.includes('Message: Keep it under two pages.'), read);
    await me.page.locator('#simple-toggle').click();
    await me.until('the file it can share is there', async () => (await me.page.locator('#simple-thread .parley-said[data-kind=show]').count()) === 1);
    assert.equal((await me.page.locator('#simple-thread').innerText()).includes('clv-e2e-secret'), false, 'the simple view shows nothing the person cannot open');
    await me.until('read now', async () => !(await me.page.locator('#simple-thread').innerText()).includes('Pas encore lu'));
    await me.page.locator('#simple-thread .parley-said[data-kind=show] .parley-open').first().click();
    await me.until('the report is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('38 orders, 3 late'));
    await me.page.locator('#preview-close').click();
    /* The detailed view: where it is, the steps it said, every file, a way to its terminal. Remembered on this device. */
    await me.page.locator('#simple-thread .parley-views button[data-view=detailed]').click();
    await me.until('the detailed view', async () => (await me.page.locator('#simple-thread .parley-status').innerText()).startsWith('Terminé'));
    const steps = await me.page.locator('#simple-thread .parley-steps li').allInnerTexts();
    assert.deepEqual(steps, ['on the cover'], 'the steps behind it; where it is now is the status line');
    assert.ok((await me.page.locator('#simple-thread .parley-thread').innerText()).includes("Pas dans un dossier partagé : il ne peut pas être ouvert d'ici."), 'the file it cannot share is said to be outside');
    assert.equal(await me.page.locator('#simple-thread .parley-files li').count(), 2);
    assert.equal(await me.page.locator('#simple-thread .parley-files li[data-outside=true]').count(), 1);
    await me.page.reload();
    await me.until('detailed again after a reload', async () => (await me.page.locator('#simple-thread .parley-views button[data-view=detailed]').getAttribute('aria-pressed').catch(() => '')) === 'true');
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
    assert.deepEqual(me.errors, []);
});
