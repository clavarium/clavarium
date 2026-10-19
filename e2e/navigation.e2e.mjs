/* THE NAVIGATION CONTRACT, on a phone and on a tablet. Three kinds of
   display: a page of the menu (Assets, Access, Settings), a zone of a
   conversation (its tabs Chat, Terminal, Assets, Settings, and what opens in
   them), and at most one thing over the screen. Every screen is walked to:
   Back comes back to where it was opened from, Escape does the same
   (outside a field and the terminal), nothing stays on top once the tab or
   the conversation changed, and the link that leaves says where it leads.
   With CLAVARIUM_NAV_SHOTS set to a directory, a few screens are saved
   there as pictures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bench, SKIP } from './bench.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Robin', GIT_AUTHOR_EMAIL: ['robin', 'example.com'].join('@'), GIT_COMMITTER_NAME: 'Robin', GIT_COMMITTER_EMAIL: ['robin', 'example.com'].join('@') };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SHOTS = process.env.CLAVARIUM_NAV_SHOTS;
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };

/* A conversation that talks through the app, given a repository (the agent one commit ahead of its remote) and a folder with a file. */
async function setUp(b, me) {
    const remote = join(b.dir, 'remote.git');
    git(b.dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    const seed = join(b.dir, 'seed');
    git(b.dir, 'clone', '--quiet', remote, seed);
    writeFileSync(join(seed, 'README.md'), '# site\n'); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    await me.create('coder');
    await me.api('/api/conversations/coder/talk', { on: true });
    await me.api('/api/resources', { name: 'site', type: 'git' });
    await me.api('/api/git/site/remote', { url: remote });
    await me.api('/api/resources', { name: 'notes' });
    writeFileSync(join(b.dir, 'data', 'resources', 'notes', 'brief.txt'), 'The brief.\n');
    await me.api('/api/conversations/coder/resources', { resource: 'site', access: 'write' });
    await me.api('/api/conversations/coder/resources', { resource: 'notes', access: 'read' });
    await me.until('the origin is kept', async () => (await me.api('/api/git/site/keep')).body.origin?.ok === true, 20_000);
    const work = join(b.dir, 'data', 'resources', 'site');
    git(work, 'fetch', '-q', join(b.dir, 'data', 'resources', 'site-origin'), '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(work, 'light.js'), 'export const light = "green";\n');
    git(work, 'add', '.'); git(work, 'commit', '--quiet', '-m', 'A light');
    const head = git(work, 'rev-parse', 'main');
    /* Sent by hand: its chat says so, with "See the commit", and names the commit. */
    const out = await me.api('/api/git/site/outgoing');
    assert.equal(out.body.head, head);
    const sent = await me.api('/api/git/site/push', { head, target: 'main' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    return { head };
}

async function walk(t, { phone }) {
    const b = await bench(t);
    const context = await b.browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1024, height: 768 } });
    const me = await b.person({ context });
    const page = me.page;
    const { head } = await setUp(b, me);
    /* One device paired already: the map still offers a new one, as plainly as the first. */
    const shared = (await me.api('/api/shares', { grants: [{ asset: 'folder:notes', rights: 'r' }], label: 'Kitchen tablet' })).body;
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const paired = await fetch(`${b.origin}/c/api/pair`, { method: 'POST', headers: { origin: b.origin, 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(shared.url).hash.slice(1), key: publicKey.export({ format: 'jwk' }), label: 'Kitchen tablet' }) });
    assert.equal(paired.status, 201);
    const tag = phone ? 'phone' : 'tablet';
    const pressed = async (id) => (await page.locator(id).getAttribute('aria-pressed')) === 'true';
    const shown = (sel) => page.locator(sel).isVisible();
    /* Failing, it says where the page was. */
    const until = (what, check) => me.until(what, check).catch(async (e) => { throw new Error(`${e.message} (at ${page.url()}, on top: ${await page.evaluate(() => [...document.querySelectorAll('#gitview, #viewer, #copy, #cassets, #panel, #access, #assets, #settings')].filter((x) => !x.hidden).map((x) => x.id).join(' '))})`); });
    /* Escape from nowhere in particular: not a field, not the terminal. */
    const escape = async () => { await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press('Escape'); };
    /* Each way back, tried in turn: the device's Back, then Escape. */
    const bothWays = async (open, opened, closed, what) => {
        for (const how of ['Back', 'Escape']) {
            await open();
            await until(`${what} is open (${how})`, opened);
            if (how === 'Back') await page.goBack(); else await escape();
            await until(`${how} closes ${what}`, closed);
        }
    };
    const inChat = async () => (await pressed('#view-chat')) && await shown('#simple');
    const openCoder = async () => {
        await page.locator('#items .item', { hasText: 'coder' }).click();
        await until('coder is open, on its chat', inChat);
    };

    /* In a folder of the list. */
    assert.equal((await me.api('/api/conversations/coder/group', { group: 'Work' })).status, 200);
    /* THE LIST, THEN A CONVERSATION: a step; Back comes back to the list (and never out of the app). */
    await page.goto(`${b.origin}/`);
    await until('the list', async () => await shown('#items .item'));
    await openCoder();
    await page.goBack();
    await until('Back: the list', async () => new URL(page.url()).searchParams.get('c') === null && (!phone || await shown('#list')));
    assert.equal(new URL(page.url()).origin, b.origin, 'still in the app');
    if (phone) assert.equal(await page.locator('#back').getAttribute('aria-label'), 'Conversations', 'its "<" says where it leads');
    /* THE SEARCH: a step; Back and Escape close it; Escape in its field empties it first, then closes it. */
    const onList = async () => new URL(page.url()).searchParams.get('c') === null && (!phone || await shown('#list'));
    await bothWays(() => page.locator('#search-open').click(), () => shown('#search-field'), async () => !(await shown('#search')) && await onList(), 'the search');
    await page.locator('#search-open').click();
    await page.locator('#search-field').fill('COD');
    await until('found', async () => (await page.locator('#items .item').count()) === 1);
    await page.locator('#search-field').press('Escape');
    await until('Escape empties the field', async () => (await page.locator('#search-field').inputValue()) === '' && await shown('#search'));
    await page.locator('#search-field').press('Escape');
    await until('Escape again closes it', async () => !(await shown('#search')) && await onList());
    /* A folder folded and opened again: no step; Back still leaves nothing behind. */
    const work = page.locator('.group-head[data-group="Work"]');
    await work.click();
    await until('Work folded', async () => (await page.locator('.group[data-group="Work"] .item').count()) === 0);
    await work.click();
    await until('Work open', async () => (await page.locator('.group[data-group="Work"] .item').count()) === 1);
    await openCoder();
    await page.goBack();
    await until('Back: the list, past the folder', onList);
    await openCoder();
    if (phone) { await page.locator('#back').click(); await until('"<": the list', async () => shown('#list')); await openCoder(); }

    /* THE TABS: the one it opened on (its chat) is no step; each other is one, Back and Escape come back to the chat. */
    assert.equal(await page.locator('#folders').getAttribute('aria-label'), 'Settings', 'the fourth tab, named for a screen reader');
    for (const [tab, id] of [['terminal', '#view-terminal'], ['assets', '#view-assets'], ['settings', '#folders']]) {
        await bothWays(() => page.locator(id).click(), () => pressed(id), inChat, `the ${tab} tab`);
    }
    /* From one other tab to another: still one step from the chat. */
    await page.locator('#view-terminal').click();
    await page.locator('#view-assets').click();
    await page.locator('#folders').click();
    await until('its settings, as a tab', async () => (await pressed('#folders')) && await shown('#panel'));
    assert.equal(await shown('#panel-close'), false, 'a tab has no Close');
    await shot(page, `${tag}-settings-tab`);
    await page.goBack();
    await until('one Back: the chat again', inChat);

    /* AN ASSET of the conversation: a step; its link says "< Assets". */
    await page.locator('#view-assets').click();
    const notes = page.locator('#cassets-rows .as-row[data-asset="folder:notes"]');
    const detailOf = (key) => async () => (await page.locator('#cassets-detail').getAttribute('data-asset')) === key && await shown('#cassets-detail');
    await until('notes is listed', async () => (await notes.count()) === 1);
    await bothWays(() => notes.click(), async () => (await detailOf('folder:notes')()) && await shown('#cassets-detail #files'),
        async () => (await pressed('#view-assets')) && (!phone || !(await shown('#cassets-detail'))), 'an asset');
    if (phone) {
        await notes.click();
        await until('notes opened', detailOf('folder:notes'));
        assert.equal(await page.locator('#cassets-detail .as-back').innerText(), '‹ Assets');
        await page.locator('#cassets-detail .as-back').click();
        await until('"< Assets": the list', async () => !(await shown('#cassets-detail')));
    }

    /* OVER THE SCREEN: a file of it; Back and Escape close it, and only it. */
    await notes.click();
    await until('its files', async () => (await page.locator('#cassets-detail #files-rows').innerText()).includes('brief.txt'));
    await bothWays(() => page.locator('#files-rows .file', { hasText: 'brief.txt' }).click(), () => shown('#viewer'),
        async () => !(await shown('#viewer')) && (await detailOf('folder:notes')()), 'the viewer');
    assert.equal(await page.locator('#preview-close').getAttribute('aria-label'), 'Close');

    /* THE REVIEW, from the repository: a step; its link names the repository. */
    const site = page.locator('#cassets-rows .as-row[data-asset="git:site"]');
    if (phone) { await page.goBack(); await until('the list of its assets', async () => !(await shown('#cassets-detail'))); }
    await site.click();
    await until('site, on its branches', async () => (await page.locator('#cassets-detail button[data-act="review"]').count()) === 1);
    await bothWays(() => page.locator('#cassets-detail button[data-act="review"]').click(), () => shown('#gitview'),
        async () => !(await shown('#gitview')) && (await detailOf('git:site')()), 'the review');
    await page.locator('#cassets-detail button[data-act="review"]').click();
    await until('the review', async () => shown('#gitview'));
    assert.equal(await page.locator('#gitview-close').innerText(), '‹ site');
    await page.locator('#gitview-close').click();
    await until('"< site": the repository', async () => !(await shown('#gitview')) && (await detailOf('git:site')()));
    await page.goBack();
    await page.goBack();
    await until('the chat, two steps down', inChat);

    /* FROM THE CHAT, DIRECT: the line that says the commit was sent opens its review, and the commit it names too. */
    const line = page.locator('#simple-thread .parley-system', { hasText: 'Sent by hand to main of site' });
    await until('the line of the sending', async () => (await line.count()) > 0);
    assert.match(await line.first().innerText(), new RegExp(`\\(up to ${head.slice(0, 7)}\\)`));
    await bothWays(() => line.first().locator('button.parley-act', { hasText: 'See the commit' }).click(),
        async () => (await shown('#cassets #gitview')) && (await page.locator('#gitview-from').innerText()).includes(head.slice(0, 7)) && (await pressed('#view-assets')),
        async () => (await inChat()) && !(await shown('#gitview')), 'the review of the commits sent');
    await line.first().locator('button.parley-act', { hasText: 'See the commit' }).click();
    await until('the review, from the chat', async () => (await shown('#gitview')) && (await page.locator('#gitview-commits').textContent()).includes('A light'));
    assert.equal(await page.locator('#gitview-close').innerText(), '‹ Chat', 'its link says it goes back to the chat');
    await shot(page, `${tag}-review-from-chat`);
    await page.locator('#gitview-close').click();
    await until('"< Chat": the chat', inChat);
    await bothWays(() => line.first().locator('button.parley-ref', { hasText: head.slice(0, 7) }).click(),
        async () => (await shown('#gitview')) && (await page.locator('#gitview-from').innerText()) === head.slice(0, 7),
        async () => (await inChat()) && !(await shown('#gitview')), 'the review of the commit it names');

    /* WHAT THE CHAT OPENS OVER ITSELF (its menu): Back closes it, and the chat stays. */
    await bothWays(() => page.locator('.parley-prefs-open').click(), () => shown('.parley-prefs-menu'),
        async () => !(await shown('.parley-prefs-menu')) && await inChat(), 'the menu of the chat');

    /* NOTHING STAYS ON TOP once the tab changed: Copy over the terminal, then the chat. */
    await page.locator('#view-terminal').click();
    if (phone) await me.more();
    await page.locator('#copy-open').click();
    await until('Copy, over the terminal', async () => shown('#copy'));
    assert.equal(await page.locator('#copy-close').getAttribute('aria-label'), 'Close');
    await page.locator('#view-chat').click();
    await until('the chat, nothing over it', async () => (await inChat()) && !(await shown('#copy')));
    await page.goBack();
    await until('Back now leaves the conversation: Copy and the terminal took no step any more', async () => new URL(page.url()).searchParams.get('c') === null);
    await openCoder();

    /* A DEVICE TO PAIR, from its settings: Access, and Back to its settings. */
    await page.locator('#folders').click();
    await me.chapter('sharing');
    await page.locator('#share').click();
    await until('what the device gets', async () => shown('#share-compose'));
    assert.equal(await page.locator('#sharing-close').innerText(), '‹ coder');
    await page.goBack();
    await until('Back: its settings, as they were', async () => (await pressed('#folders')) && await shown('#panel') && !(await shown('#access')));
    await page.goBack();
    await until('then its chat', inChat);
    if (phone) { await page.goBack(); await until('the list', async () => shown('#list')); }

    /* THE PAGES OF THE MENU: each a step, its link "< Conversations"; Back and Escape close it. */
    for (const [item, id] of [['assets', '#assets'], ['access', '#access'], ['settings', '#settings']]) {
        await bothWays(() => page.locator(`#nav-${item}`).click(), () => shown(id), async () => !(await shown(id)) && new URL(page.url()).searchParams.get('open') === null, `the page ${item}`);
        await page.locator(`#nav-${item}`).click();
        await until(`${item} again`, () => shown(id));
        assert.equal(await page.locator(`#${item}-close`).innerText(), '‹ Conversations');
        await page.locator(`#${item}-close`).click();
        await until(`"< Conversations" closes ${item}`, async () => !(await shown(id)));
    }
    /* Access: all the devices, a step over the map. */
    await page.locator('#nav-access').click();
    await until('the map', async () => (await page.locator('#links-board .lk-node, #links-phone .lk-item').count()) > 0 || await shown('#map-all-devices'));
    await shot(page, `${tag}-access-map`);
    await bothWays(() => page.locator('#map-all-devices').click(), () => shown('#share-manage'), async () => (await shown('#access-map')) && !(await shown('#share-manage')), 'all devices');
    await page.locator('#map-all-devices').click();
    assert.equal(await page.locator('#share-manage-close').innerText(), '‹ Access');
    await page.locator('#share-manage-close').click();
    await until('"< Access": the map', () => shown('#access-map'));
    /* EACH COLUMN OF THE MAP HAS ITS "+", with things in it already: a new device, a new conversation, a new asset; Back, the map. */
    const onMap = async () => (await shown('#access-map')) && !(await shown('#sharing')) && !(await shown('#create')) && !(await shown('#assets'));
    for (const [kind, title, word, opened] of [
        ['device', 'Devices', 'New device', () => shown('#share-compose')],
        ['conversation', 'Conversations', 'New conversation', () => shown('#create')],
        ['asset', 'Assets', 'New asset', async () => (await shown('#assets')) && (await page.locator('#assets-detail .as-kinds button').count()) === 4],
    ]) {
        if (phone) await page.locator('#links-phone .lk-kinds button', { hasText: title }).click();
        const plus = page.locator(`#links [data-add="${kind}"] >> visible=true`);
        await until(`the "+" of ${title}`, async () => (await plus.count()) === 1);
        assert.equal(await plus.getAttribute('aria-label'), word);
        await bothWays(() => plus.click(), opened, onMap, `${word}, from the map`);
    }
    /* A new asset: which kind, then its form; still one step over the map. */
    await page.locator('#links [data-add="asset"] >> visible=true').click();
    await page.locator('#assets-detail .as-kinds button[data-kind="folder"]').click();
    await until('the form of a new folder', () => shown('#folder-box'));
    await page.goBack();
    await until('Back: the map', onMap);
    /* A new device from the map: Back to the map. */
    await bothWays(() => page.locator('#map-new-device').click(), () => shown('#share-compose'), async () => (await shown('#access-map')) && !(await shown('#sharing')), 'a new device, from the map');
    await page.locator('#map-new-device').click();
    await until('compose', () => shown('#share-compose'));
    assert.equal(await page.locator('#sharing-close').innerText(), '‹ Access');
    await page.locator('#sharing-close').click();
    await until('"< Access"', () => shown('#access-map'));
    /* From an asset of the Assets page: Back to that asset. */
    await page.locator('#nav-assets').click();
    await page.locator('#assets-rows .as-row[data-asset="folder:notes"]').click();
    await until('notes, in Assets', async () => /a=folder%3Anotes/.test(page.url()));
    const share = page.locator('#assets-detail button', { hasText: 'Share with a device...' });
    await bothWays(() => share.click(), () => shown('#share-compose'), async () => (await shown('#assets')) && /a=folder%3Anotes/.test(page.url()) && !(await shown('#access')), 'a device to share an asset with');
    await share.click();
    assert.equal(await page.locator('#sharing-close').innerText(), '‹ Assets');
    await page.locator('#sharing-close').click();
    await until('"< Assets"', () => shown('#assets'));
    await page.locator('#assets-close').click();
    await until('Assets closed', async () => !(await shown('#assets')));

    /* A conversation picked while a page is open: the page gives way, with no step of it left behind. */
    if (!phone) {
        await page.locator('#nav-settings').click();
        await until('settings', () => shown('#settings'));
        await openCoder();
        assert.equal(await shown('#settings'), false);
        await page.goBack();
        await until('Back: the list, not the page', async () => new URL(page.url()).searchParams.get('c') === null && !(await shown('#settings')));
    }
    assert.deepEqual(me.errors, []);
}

test('navigation, on a phone: every screen, Back and Escape to where it came from, the words of each way out', { skip: SKIP }, async (t) => { await walk(t, { phone: true }); });
test('navigation, on a tablet: every screen, Back and Escape to where it came from, the words of each way out', { skip: SKIP }, async (t) => { await walk(t, { phone: false }); });
