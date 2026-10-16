/* A START TOLD STEP BY STEP, from the page: a build, a restart (its tool
   taking up its last session, or starting a new one), a wake from a stop and
   a wake from sleep. The same panel for each: what it is, "Step N of M" with
   its clock, the step under way, those passed and those to come. Its steps go
   in order, all the way to the tool, and nothing said names the VM manager
   or an address. The stand-in VM manager says "Stopping" and "Starting" while
   it stops and starts, as the real one does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bench, SKIP } from './bench.mjs';

const BUILD = ['starting', 'preparing', 'installing', 'folders', 'tool'];
const RESTART = ['stopping', 'starting', 'answering', 'folders', 'tool'];
const WAKE = ['starting', 'answering', 'folders', 'tool'];

/* Every state of the panel the page shows, as it changes, and every word of it. */
const record = (page) => page.evaluate(() => {
    window.clavariumSeen = []; window.clavariumWords = new Set();
    setInterval(() => {
        const notice = document.getElementById('notice');
        if (!notice || notice.hidden || notice.dataset.progress === undefined) return;
        const items = [...document.querySelectorAll('#notice-steps li')];
        const now = items.find((li) => li.dataset.state === 'now');
        const seen = { title: document.getElementById('notice-title').textContent, count: document.getElementById('notice-count').textContent.replace(/ · \d+:\d\d$/, ''),
            steps: items.map((li) => li.dataset.step), now: now?.dataset.step, words: now?.textContent, done: items.filter((li) => li.dataset.state === 'done').map((li) => li.dataset.step) };
        if (JSON.stringify(window.clavariumSeen.at(-1)) !== JSON.stringify(seen)) window.clavariumSeen.push(seen);
        window.clavariumWords.add(notice.innerText); window.clavariumWords.add(document.getElementById('state').innerText);
    }, 40);
});
const taken = (page) => page.evaluate(() => { const seen = window.clavariumSeen; window.clavariumSeen = []; return seen; });
const words = (page) => page.evaluate(() => [...window.clavariumWords].join('\n'));

/* What the page showed, in order: the same steps throughout, each step reached after the one before. */
function inOrder(seen, steps, title) {
    assert.ok(seen.length > 0, 'the steps were shown');
    let last = -1;
    for (const s of seen) {
        assert.deepEqual(s.steps, steps);
        assert.equal(s.title, title);
        const at = steps.indexOf(s.now);
        assert.ok(at >= last, `${s.now} after ${steps[last]}`);
        assert.equal(s.count, `Step ${at + 1} of ${steps.length}`);
        assert.deepEqual(s.done, steps.slice(0, at), 'those before it are passed');
        last = at;
    }
    return seen.map((s) => s.now).filter((id, i, all) => all.indexOf(id) === i);
}

test('a build, a restart, a wake: the same steps panel, in order, all the way to the tool, and its last session when it takes it up', { skip: SKIP }, async (t) => {
    const b = await bench(t, { launchSeconds: '3', stopDelayMs: 500 });
    const me = await b.person();
    await record(me.page);
    /* BUILT: five steps, the tool's start the last -- a new disk holds no session. */
    await me.create('stepper');
    const built = inOrder(await taken(me.page), BUILD, 'Building its machine');
    assert.equal(built[0], 'starting');
    /* RESTARTED, its tool taking up its last session: six steps. */
    process.env.FAKE_VM_STOP_SECONDS = '2'; process.env.FAKE_VM_START_SECONDS = '2';
    t.after(() => { delete process.env.FAKE_VM_STOP_SECONDS; delete process.env.FAKE_VM_START_SECONDS; });
    await me.page.locator('#folders').click();
    await me.page.locator('#restart').click();
    await me.page.locator('#notice-action', { hasText: 'Restart' }).click();
    await me.until('the machine stops, step 1 of 6', async () => (await me.page.locator('#notice-steps li[data-state="now"]').innerText().catch(() => '')) === 'The machine stops');
    assert.match(await me.page.locator('#notice-count').innerText(), /^Step 1 of 6 · 0:0\d$/);
    assert.deepEqual(await me.page.locator('#notice-steps li[data-state="later"]').allInnerTexts(), ['The machine starts', 'The machine answers', 'Its folders are ready', 'The tool starts', 'The tool resumes its last session']);
    assert.match(await me.page.locator('#notice-text').innerText(), /A restart usually takes one to two minutes/);
    await me.until('the machine starts, its stop passed', async () => (await me.page.locator('#notice-steps li[data-state="now"]').innerText().catch(() => '')) === 'The machine starts', 10_000);
    assert.deepEqual(await me.page.locator('#notice-steps li[data-state="done"]').allInnerTexts(), ['The machine stops']);
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    const restarted = inOrder(await taken(me.page), [...RESTART, 'resume'], 'Restarting its machine');
    assert.deepEqual(restarted.slice(0, 2), ['stopping', 'starting']);
    await me.type('echo "resumed:${RESUMED:-no}"');
    await me.sees('\nresumed:1');
    assert.equal((await me.api('/api/conversations')).body[0].progress, undefined, 'over once its tool is there');
    /* RESTARTED FRESH, as its owner chose: the last step says so. */
    await me.api('/api/conversations/stepper/resume', { on: false });
    await me.page.locator('#folders').click();
    await me.page.locator('#restart').click();
    await me.page.locator('#notice-action', { hasText: 'Restart' }).click();
    await me.until('its last step is a new session', async () => (await me.page.locator('#notice-steps li').last().innerText().catch(() => '')) === 'The tool starts a new session');
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    inOrder(await taken(me.page), [...RESTART, 'fresh'], 'Restarting its machine');
    await me.type('echo "resumed:${RESUMED:-no}"');
    await me.sees('\nresumed:no');
    await me.api('/api/conversations/stepper/resume', { on: true });
    /* WOKEN FROM A STOP (its tool exited, its machine stopped after the delay): started again on its last session. */
    await me.type('exit');
    await me.until('its tool exited', async () => (await me.state()) === 'ended');
    await me.until('its machine stopped', async () => (await me.api('/api/conversations/stepper/health', {})).body?.state === 'Stopped', 10_000);
    await me.page.locator('#notice-action', { hasText: 'Start it again' }).click();
    await me.until('it wakes, step 1 of 5', async () => /^Step 1 of 5/.test(await me.page.locator('#notice-count').innerText().catch(() => '')));
    assert.match(await me.page.locator('#notice-title').innerText(), /waking it up/i);
    assert.match(await me.page.locator('#notice-text').innerText(), /A start usually takes a minute or two/);
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    assert.equal(inOrder(await taken(me.page), [...WAKE, 'resume'], 'Waking it up')[0], 'starting');
    /* WOKEN FROM SLEEP: its memory was kept, and its tool is there as it was. */
    await me.type('KEPT=through-sleep; echo ok');
    await me.sees('\nok');
    await me.page.locator('#folders').click();
    await me.page.locator('#sleep').click();
    await me.until('asleep', async () => (await me.state()) === 'asleep');
    await me.page.locator('#notice-action', { hasText: 'Wake it' }).click();
    await me.until('it wakes', async () => (await me.page.locator('#notice-steps li[data-state="now"]').innerText().catch(() => '')) === 'The machine wakes');
    await me.until('live again', async () => (await me.state()) === 'live', 30_000);
    assert.equal(inOrder(await taken(me.page), ['waking', 'answering', 'folders', 'back'], 'Waking it up')[0], 'waking');
    await me.type('echo $KEPT');
    await me.sees('\nthrough-sleep');
    /* Nothing said names the VM manager, or an address. */
    const said = await words(me.page);
    assert.match(said, /The machine stops/);
    assert.doesNotMatch(said, /multipass/i);
    assert.doesNotMatch(said, /\b\d{1,3}(\.\d{1,3}){3}\b/);
    assert.deepEqual(me.errors, []);
});
