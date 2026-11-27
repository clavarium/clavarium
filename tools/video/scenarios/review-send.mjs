/* DEMO: REVIEW, THEN SEND THE CODE. The agent commits in its own copy; the person sees every repository on one
 * screen (To send), the checks run, one review of the changes, one button sends; the agent never holds the key
 * of the remote. Plan: demos-plan #14. The repository and its remote are local, made here. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '../stage.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Robin', GIT_AUTHOR_EMAIL: 'robin@example.com', GIT_COMMITTER_NAME: 'Robin', GIT_COMMITTER_EMAIL: 'robin@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const CONV = 'my-app-lys';
/* The remote is a local bare repository; the screen shows the address a person would have (the film rewrites
   the text, nothing else). */
const SHOWN = 'git.example.com/robin/lys-app.git';

export default {
    name: 'review-send',
    title: 'Review, then send the code',
    opening: 'The code waits for your review.',
    page: 'coding-agents.html',
    formats: ['desk'],
    tools: [tool('claude-code', 'Claude Code')],
    lines: [
        'Your agent fixed the bug, in its own copy.',
        'Everything to send, on one screen. The checks run.',
        'Read the changes.',
        'Then send, with one button.',
        'Clavarium. The agent never holds the key.',
    ],
    gaps: [0.6, 0.5, 0.5, 0.5, 0.6],

    async seed(b, me, { bridge }) {
        const made = await me.api('/api/conversations', { title: 'My app Lys', tool: 'claude-code' });
        if (made.status !== 201) throw new Error(`create: ${made.status}`);
        await me.until('it is ready', async () => (await me.api('/api/conversations')).body.find((c) => c.name === CONV)?.phase === 'ready', 60_000);
        await me.api(`/api/conversations/${CONV}/talk`, { on: true });
        const name = 'lys-app';
        const remote = join(b.dir, `${name}.git`);
        git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
        const seed = join(b.dir, `${name}-seed`);
        git(b.dir, 'clone', '--quiet', remote, seed);
        writeFileSync(join(seed, 'session.js'), 'export const SESSION_MINUTES = 5;\n');
        git(seed, 'add', '.'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
        await me.api('/api/resources', { name, type: 'git' });
        await me.api(`/api/git/${name}/remote`, { url: remote });
        await me.api(`/api/conversations/${CONV}/resources`, { resource: name, access: 'write' });
        await me.until(`the origin of ${name} is kept`, async () => (await me.api(`/api/git/${name}/keep`)).body.origin?.ok === true, 20_000);
        const work = join(b.dir, 'data', 'resources', name);
        git(work, 'fetch', '-q', join(b.dir, 'data', 'resources', `${name}-origin`), '+refs/heads/*:refs/remotes/origin/*');
        git(work, 'reset', '-q', '--hard', 'origin/main');
        writeFileSync(join(work, 'session.js'), '/* Users were logged out after 5 minutes. */\nexport const SESSION_MINUTES = 60;\n');
        git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'Keep the session for 60 minutes');
        const agent = bridge(join(b.dir, 'kept-work', CONV, 'work', '.parley'));
        agent.tell('Found it: the session ended after 5 minutes.');
        return { agent, remote };
    },

    async play(f, cue, { b, agent, remote }) {
        const { page, tap, spot, badge, card, uncard, reveal, me } = f;
        await page.goto(`${b.origin}/?c=${CONV}`);
        await page.locator('#view-chat').waitFor();
        const x = page.locator('.ft-x').first();
        if (await x.isVisible().catch(() => false)) await x.click().catch(() => {});
        await page.evaluate(() => document.getElementById('view-chat').click());
        await page.locator('#simple-thread', { hasText: 'Found it' }).first().waitFor({ timeout: 60_000 });
        await page.evaluate(({ from, to }) => {
            const fix = (n) => { if (n.nodeType === 3) { if (n.data.includes(from)) n.data = n.data.split(from).join(to); } else n.childNodes.forEach(fix); };
            fix(document.body);
            new MutationObserver((ms) => ms.forEach((m) => { m.addedNodes.forEach(fix); if (m.type === 'characterData') fix(m.target); })).observe(document.body, { childList: true, subtree: true, characterData: true });
        }, { from: remote, to: SHOWN });
        await f.settled();
        await sleep(800);
        f.begin();
        await sleep(1700);
        await badge();
        await uncard();
        agent.tell('Fixed and committed: the session now lasts 60 minutes. Ready for your review.');
        const said = page.locator('#simple-thread').getByText('Ready for your review').first();
        await said.waitFor({ timeout: 15_000 });
        await cue(0);
        await spot(said, 1800);
        await tap('#view-assets', 600);
        const entry = page.locator('#cassets-rows .as-row[data-asset="send:all"]');
        await me.until('To send is offered', async () => await entry.isVisible(), 30_000);
        await tap(entry, 600);
        const progress = page.locator('#cassets-detail .ts-progress');
        await me.until('all read', async () => /all read$/.test(await progress.innerText().catch(() => '')), 30_000);
        const go = page.locator('#cassets-detail [data-act="send-all"]');
        await cue(1);
        await spot(page.locator('#cassets-detail .ts-row').first(), 1500);
        await tap(go, 500);
        await me.until('checked', async () => /^Send /.test(await go.innerText()), 30_000);
        await spot(page.locator('#cassets-detail .ts-row .ts-state').first(), 1200);
        await tap(page.locator('#cassets-detail [data-act="send-review"]'), 600);
        const diff = page.locator('#cassets-detail .ts-diff').first();
        await diff.waitFor({ timeout: 15_000 });
        await reveal(diff);
        await cue(2);
        await spot(diff, 2600);
        await page.keyboard.press('Escape');
        await me.until('the review is closed', async () => !(await page.locator('#cassets-detail .ts-review').isVisible()));
        await sleep(400);
        await cue(3);
        await tap(go, 700);
        await me.until('it asks to be sure', async () => /^Yes, send/.test(await go.innerText()), 10_000);
        await sleep(700);
        await tap(go, 600);
        await f.skip(() => me.until('sent', async () => /Sent to main/.test(await page.locator('#cassets-detail .ts-row .ts-state').first().innerText().catch(() => '')), 30_000));
        await spot('#cassets-detail .ts-said', 1800);
        if (!/60 minutes/.test(git(remote, 'log', '-1', '--format=%s', 'main'))) throw new Error('the remote did not get the commit');
        await cue(4);
        await card('The agent never holds the key.', { sub: 'clavarium.org' });
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
