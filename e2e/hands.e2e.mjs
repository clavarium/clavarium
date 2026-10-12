import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bench, SKIP, wait } from './bench.mjs';
import { toWav, RATE } from '../web/voice-core.js';

test('shortcuts: one is sent with Enter, another is left to be completed; both can be removed', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('shortcuts');
    assert.deepEqual(await me.page.locator('#shortcut-row button.saved').allInnerTexts(), ['Yes, go on', 'Run the tests', 'Summarise']);
    const add = async (label, text, enter) => {
        await me.page.locator('#shortcut-row button', { hasText: '+ Shortcut' }).click();
        assert.equal(await me.page.locator('#shortcut-enter').isChecked(), true, 'the form starts from "press Enter", every time');
        await me.page.fill('#shortcut-label', label);
        await me.page.fill('#shortcut-text', text);
        if (!enter) await me.page.locator('#shortcut-enter').uncheck();
        await me.page.locator('#shortcut-new button[type=submit]').click();
        await me.until(`${label} is there`, async () => (await me.page.locator('#shortcut-row button.saved', { hasText: label }).count()) === 1);
    };
    await add('Say hi', 'echo sent-in-one-click', true);
    await add('Start of a line', 'echo completed-', false);
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Say hi' }).click();
    await me.until('it was sent', async () => (await me.screen()).split('sent-in-one-click').length >= 3);
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Start of a line' }).click();
    await wait(600);
    assert.equal((await me.screen()).split('completed-').length, 2, 'typed once, and not sent');
    await me.page.keyboard.type('by-hand');
    await me.page.keyboard.press('Enter');
    await me.sees('\ncompleted-by-hand');
    /* The same label twice is refused. */
    assert.match((await me.api('/api/shortcuts', { label: 'Say hi', text: 'x', enter: true })).body.error, /already has this label/);
    await me.page.locator('#shortcut-row button', { hasText: 'Remove...' }).click();
    await me.page.locator('#shortcut-row button.saved', { hasText: 'Remove "Say hi"' }).click();
    await me.until('it is gone', async () => (await me.page.locator('#shortcut-row button', { hasText: 'Say hi' }).count()) === 0);
    await me.page.locator('#shortcut-row button', { hasText: 'Done' }).click();
    assert.deepEqual(me.errors, []);
});

test('dictation: what is said is typed at the cursor, phrase by phrase; with "auto" it is sent', { skip: SKIP }, async (t) => {
    /* The "microphone" is a recording: two seconds of room, one second of
       voice-like sound, silence. The speech-to-text engine of the bench hears
       "said out loud" whatever it is given: what is tested is everything
       around it -- finding the phrase, sending it, typing the answer. */
    const second = (level) => { const s = new Float32Array(RATE); for (let i = 0; i < RATE; i++) s[i] = level * Math.sin((2 * Math.PI * 220 * i) / RATE); return s; };
    const microphone = join(mkdtempSync(join(tmpdir(), 'clv-mic-')), 'voice.wav');
    writeFileSync(microphone, toWav([second(0.004), second(0.004), second(0.5), second(0.004), second(0.004), second(0.004)]));
    const b = await bench(t, { microphone });
    const me = await b.person();
    await me.create('by-voice');
    await me.until('dictation is offered', async () => me.page.locator('#mic').isVisible());
    await me.page.locator('#mic').click();
    await me.until('the microphone is open', async () => (await me.page.locator('#mic').innerText()) === 'Stop');
    await me.sees('said out loud', 20_000);
    assert.match(await me.page.locator('#voice-line').innerText(), /Typed: said out loud|Listening|Hearing|Writing/);
    assert.equal((await me.screen()).includes('command not found'), false, 'typed, not sent');
    /* With "auto", the phrase is sent once the person has stopped. */
    await me.page.locator('#auto').click();
    await me.sees('command not found', 25_000);
    await me.page.locator('#mic').click();
    await me.until('the microphone is closed', async () => (await me.page.locator('#mic').innerText()) === 'Dictate');
});

test('folders, from the owner: a read attachment mounts the read-only view, and Files lists, imports and downloads', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-folders');
    await me.newFolder('reports');
    const setAccess = (folder, access) => me.access(folder, access);
    await setAccess('reports', 'Write');
    assert.match(await me.page.locator('#chips').innerText(), /reports - write/);
    await me.type('echo "q3 is fine" > ../resources/reports/q3.txt; mkdir -p ../resources/reports/out; echo ok');
    await me.sees('\nok');
    /* What the VM manager was asked to mount: the folder itself for writing... */
    const mounted = () => readlinkSync(`${b.dir}/vms/clv-with-folders/root/resources/reports`);
    assert.equal(mounted(), `${b.dir}/data/resources/reports`);
    /* ...and, for reading, the read-only VIEW, never the folder. */
    await setAccess('reports', 'Read');
    assert.equal(mounted(), `${b.dir}/data/views/reports`);
    await me.page.locator('#files-open').click();
    await me.page.locator('#files-tabs button', { hasText: 'reports' }).click();
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('q3.txt'));
    assert.equal(await me.page.locator('#files-readonly').isVisible(), true);
    assert.equal(await me.page.locator('#files-import').isVisible(), false);
    /* A click shows the file; its Download button saves it. */
    await me.page.locator('#files-rows .file', { hasText: 'q3.txt' }).click();
    await me.until('the text is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('q3 is fine'));
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#preview-download').click()]);
    await me.page.locator('#preview-close').click();
    assert.equal(download.suggestedFilename(), 'q3.txt');
    await me.page.locator('#files-rows .file', { hasText: 'out' }).click();
    await me.until('inside the sub-folder', async () => (await me.page.locator('#files-path').innerText()).replace(/\s+/g, '') === 'reports/out');
    await me.page.locator('#files-close').click();
    /* Removed from Assets: only a folder attached nowhere can go -- the button is there, greyed, and says why. */
    await me.page.locator('#assets-open').click();
    const asset = me.page.locator('#assets-folder .asset[data-name="reports"]');
    await asset.locator('.asset-head').click();
    assert.match(await asset.locator('.asset-head').innerText(), /with-folders \(read\)/, 'it says which conversation uses it');
    assert.equal(await asset.locator('button', { hasText: 'Remove' }).isDisabled(), true);
    assert.match(await asset.innerText(), /attached to 1 conversation: set it to Off first/);
    /* Set to Off from there, for that conversation: no need to go and open it. */
    await asset.locator('.given-row[data-conversation="with-folders"] .levels button', { hasText: 'Off' }).click();
    await me.until('it is not used any more', async () => /not used/.test(await asset.locator('.asset-head').innerText().catch(() => '')));
    await asset.locator('button', { hasText: 'Remove' }).click();
    await me.page.locator('#assets button.danger').click();
    await me.until('the folder is gone from the list', async () => (await me.page.locator('#assets-folder .asset').count()) === 0);
    await me.page.locator('#assets-close').click();
    assert.equal((await me.api('/api/resources')).body.length, 0);
});

test('a git repository is added from the page, attached like a folder, and is a repository for the tool', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    await me.page.locator('#assets-open').click();
    await me.page.locator('#git-box summary').click();
    await me.page.fill('#git-name', 'site');
    await me.page.locator('#git-new button[type=submit]').click();
    await me.until('the repository is listed', async () => (await me.page.locator('#assets-git .asset[data-name="site"]').count()) === 1);
    assert.match(await me.page.locator('#assets-git-title').innerText(), /Repositories \(1\)/);
    await me.page.locator('#assets-close').click();
    await me.access('site', 'Write');
    assert.match(await me.page.locator('#chips').innerText(), /site - write/);
    await me.type('cd ../resources/site && git status --short --branch && echo "# site" > README.md && git add README.md && git -c user.name=t -c user.email=t@example.com commit -q -m first && git log --oneline | wc -l; cd - >/dev/null');
    await me.sees('## No commits yet on main');
    await me.sees('\n1\n');
    /* Its files are in Files; what git keeps for itself is not. */
    await me.page.locator('#files-open').click();
    await me.page.locator('#files-tabs button', { hasText: 'site' }).click();
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('README.md'));
    assert.equal((await me.page.locator('#files-rows').innerText()).includes('.git'), false);
    await me.page.locator('#files-close').click();
    /* And it can be given in a share, to read or to write, as any other thing. */
    await me.page.locator('#share').click();
    const offered = me.page.locator('#share-add .folder', { hasText: 'site' });
    await me.until('the repository is offered', async () => (await offered.count()) === 1);
    assert.match(await offered.innerText(), /site repository, attached here/);
    await offered.locator('button').click();
    assert.deepEqual(await me.page.locator('#share-basket .folder', { hasText: 'site' }).locator('.levels button').allInnerTexts(), ['Read', 'Write']);
    await me.page.locator('#sharing-close').click();
    /* An address that is not https is refused before git is run. */
    assert.match((await me.api('/api/resources', { name: 'bad', type: 'git', from: 'ssh://git@example.com/x.git' })).body.error, /https address/);
});

test('what a tool committed is shown to the owner, then sent -- by the server, with a key the tool never sees', { skip: SKIP }, async (t) => {
    const { execFileSync } = await import('node:child_process');
    const b = await bench(t);
    const me = await b.person();
    await me.create('pusher');
    /* A remote, as a hosting service would be (the bench allows a directory for it). */
    const remote = `${b.dir}/remote.git`;
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await me.api('/api/resources', { name: 'site', type: 'git' });
    await me.api('/api/conversations/pusher/resources', { resource: 'site', access: 'write' });
    await me.type('cd ../resources/site && echo "<h1>hello</h1>" > index.html && git add index.html && git -c user.name=Tool -c user.email=tool@example.com commit -q -m "Add the home page" && echo committed; cd - >/dev/null');
    await me.sees('\ncommitted');
    await me.page.locator('#folders').click();
    await me.page.locator('#panel-rows .folder[data-name="site"]').locator('button', { hasText: 'Review & send' }).click();
    /* No address yet: said, and the form is open. */
    await me.until('it says where nothing is set', async () => /No address is set/.test(await me.page.locator('#gitview-state').innerText()));
    assert.equal(await me.page.locator('#gitview-push').isVisible(), false);
    await me.page.fill('#gitview-url', remote);
    await me.page.fill('#gitview-key', 'a-token-the-tool-never-sees');
    await me.page.locator('#gitview-remote button[type=submit]').click();
    /* What would go: the commit, the file, the change. */
    await me.until('the commit is shown', async () => /1 commit\(s\) would be sent to main/.test(await me.page.locator('#gitview-state').innerText()));
    assert.match(await me.page.locator('#gitview-commits').innerText(), /Add the home page/);
    assert.match(await me.page.locator('#gitview-stat').innerText(), /index\.html/);
    assert.match(await me.page.locator('#gitview-diff').innerText(), /\+<h1>hello<\/h1>/);
    assert.equal(await me.page.locator('#gitview h1').count(), 0, 'what the tool wrote is shown as text, never built');
    /* Two clicks to send; then the remote has it, and nothing is left to send. */
    await me.page.locator('#gitview-push').click();
    assert.match(await me.page.locator('#gitview-push').innerText(), /cannot be undone/);
    assert.equal(execFileSync('git', ['-C', remote, 'for-each-ref'], { encoding: 'utf8' }), '', 'nothing left yet');
    await me.page.locator('#gitview-push').click();
    await me.until('it says it was sent', async () => /Sent: 1 commit to main/.test(await me.page.locator('#gitview-state').innerText()));
    assert.match(execFileSync('git', ['-C', remote, 'log', '--format=%s', 'main'], { encoding: 'utf8' }), /Add the home page/);
    assert.equal(await me.page.locator('#gitview-push').isVisible(), false);
    /* The key: kept, sealed, and in nothing the tool can read. */
    assert.deepEqual((await me.api('/api/git/site')).body, { remote, user: null, hasKey: true });
    await me.page.locator('#gitview-close').click();
    await me.type('grep -r "a-token-the-tool-never-sees" ../resources/site /work 2>/dev/null | wc -l');
    await me.sees('\n0\n');
    assert.deepEqual(me.errors, []);
});
