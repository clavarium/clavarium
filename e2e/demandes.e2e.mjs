import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

/* A REQUEST IN THE CHAT (05-11, "B enrichie"): a Tether call its agent asks the owner to allow arrives in the
   thread as Parley's request card -- one sentence of what will happen, the act's own verb, unfolded in place,
   everything in a sheet -- and the same card in Assets › Demandes. Refused in the thread, accepted from Assets
   (after its few seconds with Undo): each decision reaches Tether, and the card folds to one line. The mailbox is
   a target that leads nowhere: nothing is sent, the decision is what is checked. */
const MAILBOX = { id: 'work-mail', title: 'Work mailbox', kind: 'mail', connector: 'mail', config: { user: 'me@example.org', host: 'mail.example.org', port: 993, smtpHost: 'mail.example.org', smtpPort: 587 } };
const BODY = 'Hello,\nWe go for option B.\nWorks from the 16th.\nCould you confirm the deposit?\nThanks again,\nAlex\nP.S. the plan follows.\nThe last line of it.';

test('a request in the chat: its card, unfolded, everything in a sheet; refused there, accepted from Assets; each reaches Tether and folds to one line', { skip: SKIP }, async (t) => {
    const b = await bench(t, { tetherTargets: [MAILBOX] });
    const me = await b.person();
    await me.create('asker');
    assert.equal((await me.api('/api/conversations/asker/talk', { on: true })).status, 200);
    assert.equal((await me.api('/api/tether/level', { target: 'work-mail', agent: 'conversation:asker', level: 'propose' })).status, 200);
    /* Its agent asks, through its .tether folder: a mail to someone outside the owner's domain. */
    const side = join(b.dir, 'kept-work', 'asker', 'work', '.tether');
    mkdirSync(side, { recursive: true });
    const ask = (id, args) => appendFileSync(join(side, 'asks.jsonl'), `${JSON.stringify({ id, op: 'mail.send', args: { target: 'work-mail', ...args }, at: new Date().toISOString() })}\n`);
    ask('q1', { to: 'sales@example.com', subject: 'Re: Kitchen quote', body: BODY, why: 'you asked me to confirm option B' });
    await me.page.locator('#view-chat').click();
    const card = me.page.locator('#simple-thread .parley-request').first();
    await me.until('the request is a card in the thread', async () => (await card.count()) > 0, 30_000);
    assert.equal(await card.locator('.parley-request-title').innerText(), 'Send “Re: Kitchen quote” to sales@example.com');
    assert.match(await card.locator('.parley-request-sub').innerText(), /^Work mailbox · 8 lines$/);
    assert.equal(await card.getAttribute('data-irreversible'), 'true', 'it leaves the owner\'s domain');
    assert.match(await card.locator('.parley-request-risk').innerText(), /Goes outside your domain/);
    assert.equal(await card.locator('.parley-request-yes').innerText(), 'Send', 'the button says the act');
    /* The newest irreversible one arrives unfolded: who, with "outside", the first lines, why. */
    assert.equal(await card.locator('.parley-request-head').getAttribute('aria-expanded'), 'true');
    assert.match(await card.locator('.parley-request-body').innerText(), /sales@example\.com · outside/);
    const quote = await card.locator('.parley-request-quote').innerText();
    assert.ok(quote.includes('We go for option B.') && !quote.includes('The last line of it.'), 'its first lines only');
    assert.match(await card.locator('.parley-request-why').innerText(), /^Why: you asked me to confirm option B$/);
    /* Its whole head folds it, and unfolds it again. */
    await card.locator('.parley-request-head').click();
    assert.equal(await card.locator('.parley-request-body').count(), 0, 'folded');
    await card.locator('.parley-request-head').click();
    assert.equal(await card.locator('.parley-request-head').getAttribute('aria-expanded'), 'true');
    /* See all: a sheet over the thread, the whole text; Escape closes it, the thread where it was. */
    await card.locator('.parley-request-all').click();
    const sheet = me.page.locator('.parley-request-sheet');
    await me.until('the sheet is open', async () => sheet.isVisible());
    assert.ok((await sheet.locator('.parley-request-quote').innerText()).includes('The last line of it.'), 'all of it');
    assert.match(await sheet.locator('.parley-request-detail').innerText(), /^mail\.send/);
    await me.page.keyboard.press('Escape');
    await me.until('the sheet is closed', async () => (await sheet.count()) === 0);
    /* Refused here: Tether is told at once, the agent hears it, the card folds to one line. */
    await card.locator('.parley-request-no').click();
    const answers = join(side, 'answers.jsonl');
    const answerOf = (id) => (existsSync(answers) ? readFileSync(answers, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((a) => a.ask === id && a.held !== true) : undefined);
    await me.until('the agent is told it was refused', async () => Boolean(answerOf('q1')));
    assert.equal(answerOf('q1').ok, false);
    assert.match(answerOf('q1').text, /refused|no/i);
    const decidedNo = me.page.locator('#simple-thread .parley-request[data-state="no"]');
    await me.until('the card says it was refused, in one line', async () => (await decidedNo.count()) === 1, 15_000);
    assert.equal(await decidedNo.locator('.parley-request-done-text').innerText(), 'Refused · Send “Re: Kitchen quote” to sales@example.com');
    assert.equal(await decidedNo.locator('button').count(), 0);
    /* A second one, inside the domain: the same card in Assets › Demandes, accepted there. */
    ask('q2', { to: 'team@example.org', subject: 'Minutes', body: 'Here are the minutes.' });
    const second = me.page.locator('#simple-thread .parley-request:not([data-state])');
    await me.until('the second card is in the thread', async () => (await second.count()) === 1, 30_000);
    assert.equal(await second.getAttribute('data-irreversible'), null, 'inside the domain: reversible');
    assert.equal(await second.locator('.parley-request-head').getAttribute('aria-expanded'), 'false', 'folded');
    await me.page.goto(`${b.origin}/?open=assets`);
    const entry = me.page.locator('[data-asset="demandes:all"]');
    await me.until('Assets lists the requests', async () => (await entry.count()) > 0);
    await entry.click();
    const there = me.page.locator('.demandes-box .parley-request');
    await me.until('the same card in Assets', async () => (await there.count()) === 1);
    assert.equal(await there.locator('.parley-request-title').innerText(), 'Send “Minutes” to team@example.org');
    assert.match(await there.locator('.parley-request-sub').innerText(), /^asker · Work mailbox/, 'it names the conversation that asks');
    /* Accept: a few seconds with Undo first; undone, nothing went. */
    await there.locator('.parley-request-yes').click();
    await me.until('it waits, with Undo', async () => there.locator('.parley-request-hold').isVisible());
    await there.locator('.parley-request-undo').click();
    assert.equal(await there.locator('.parley-request-yes').isEnabled(), true);
    assert.equal(answerOf('q2'), undefined, 'undone: nothing went');
    await there.locator('.parley-request-yes').click();
    await me.until('Tether is told it was accepted, after its few seconds', async () => ((await me.api('/api/tether')).body.approvals ?? []).length === 0, 15_000);
    await me.until('the agent has its answer', async () => Boolean(answerOf('q2')));
    assert.doesNotMatch(answerOf('q2').text, /refused/i, 'accepted: the mailbox was tried, not refused');
    /* Back in the thread: both cards folded to one line each. */
    await me.page.goto(`${b.origin}/?c=asker`);
    await me.page.locator('#view-chat').click();
    const decidedYes = me.page.locator('#simple-thread .parley-request[data-state="yes"]');
    await me.until('the card says it was accepted', async () => (await decidedYes.count()) === 1, 15_000);
    assert.equal(await decidedYes.locator('.parley-request-done-text').innerText(), 'Accepted · Send “Minutes” to team@example.org');
    assert.deepEqual(me.errors, [], 'no page error');
});
