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
    /* Its tool is an AI (it has an instruction file): what is dictated starts with a microphone, once per message. */
    await me.sees('\u{1F3A4} said out loud');
    assert.match(await me.page.locator('#voice-line').innerText(), /Typed: said out loud|Listening|Hearing|Writing/);
    assert.equal((await me.screen()).includes('command not found'), false, 'typed, not sent');
    /* With "auto", the phrase is sent once the person has stopped. */
    await me.page.locator('#auto').click();
    await me.sees('command not found', 25_000);
    await me.page.locator('#mic').click();
    await me.until('the microphone is closed', async () => (await me.page.locator('#mic').innerText()) === 'Dictate');
    /* In the chat: its own button beside Send; what is said fills its box, nothing is typed into the terminal behind it. */
    await me.api('/api/conversations/by-voice/talk', { on: true });
    await me.page.reload();
    const mic = me.page.locator('#simple-thread .parley-mic');
    const box = me.page.locator('#simple-thread .parley-box');
    await me.until('the chat has its microphone', async () => mic.isVisible());
    const typed = (await me.screen()).split('said out loud').length;
    await mic.click();
    await me.until('what is said fills the box', async () => (await box.inputValue()).includes('said out loud'), 25_000);
    const said = async () => (await me.api('/api/conversations/by-voice/talk')).body.messages.filter((m) => m.from === 'person' && m.text.includes('said out loud')).length;
    /* Send, while it listens: sent, with what is still being written. */
    await me.page.locator('#simple-thread .parley-send').click();
    await me.until('sent', async () => (await said()) === 1, 25_000);
    assert.equal((await me.api('/api/conversations/by-voice/talk')).body.messages.find((m) => m.from === 'person').via, 'voice', 'the tool is told it was dictated');
    /* "Send when I stop": a choice of the device, beside the view; spoken, then sent, in one gesture. */
    await me.page.locator('#simple-thread .parley-prefs-open').click();
    await me.page.locator('#simple-thread .parley-auto').click();
    assert.equal(await me.page.locator('#simple-thread .parley-auto').getAttribute('aria-pressed'), 'true');
    await me.until('sent by itself', async () => (await said()) >= 2, 30_000);
    await mic.click();
    assert.equal(await mic.getAttribute('aria-pressed'), 'false');
    assert.equal((await me.screen()).split('said out loud').length, typed, 'nothing typed into the terminal');
    assert.equal(await me.page.evaluate(() => localStorage.getItem('clavarium-chat-auto')), '1', 'kept by this device');
});

test('folders, from the owner: a read attachment mounts the read-only view, and Files lists, imports and downloads', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('with-folders');
    await me.newFolder('reports');
    const setAccess = (folder, access) => me.access(folder, access);
    await setAccess('reports', 'Write');
    assert.match(await me.page.locator('#view-assets').getAttribute('title'), /reports - write/);
    await me.type('echo "q3 is fine" > ../resources/reports/q3.txt; mkdir -p ../resources/reports/out; echo ok');
    await me.sees('\nok');
    /* What the VM manager was asked to mount: the folder itself for writing... */
    const mounted = () => readlinkSync(`${b.dir}/vms/clv-with-folders/root/resources/reports`);
    assert.equal(mounted(), `${b.dir}/data/resources/reports`);
    /* ...and, for reading, the read-only VIEW, never the folder. */
    await setAccess('reports', 'Read');
    assert.equal(mounted(), `${b.dir}/data/views/reports`);
    await me.files('reports');
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
    await me.page.locator('#view-terminal').click();
    /* Removed from Assets: only a folder attached nowhere can go -- the button is there, greyed, and says why. */
    const asset = await me.openAsset('folder', 'reports');
    await me.until('it says which conversation uses it', async () => (await asset.locator('.as-users .given-row[data-conversation="with-folders"]').count()) === 1);
    assert.equal(await asset.locator('.danger-link').isDisabled(), true);
    assert.match(await asset.innerText(), /used by 1 conversation: set it to Off first/);
    /* Set to Off from there, for that conversation. */
    await asset.locator('.given-row[data-conversation="with-folders"] .levels button', { hasText: 'Off' }).click();
    await me.until('it is not used any more', async () => /No conversation uses it/.test(await asset.innerText().catch(() => '')));
    await asset.locator('.danger-link').click();
    await asset.locator('button.danger').click();
    await me.until('the folder is gone from the list', async () => (await me.page.locator('#assets-rows .as-row[data-asset^="folder:"]').count()) === 0);
    await me.page.locator('#assets-close').click();
    assert.equal((await me.api('/api/resources')).body.length, 0);
});

test('a git repository is added from the page, attached like a folder, and is a repository for the tool', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('coder');
    await me.addAsset('git');
    await me.page.fill('#git-name', 'site');
    await me.page.locator('#git-new button[type=submit]').click();
    await me.until('the repository is listed', async () => (await me.page.locator('#assets-rows .as-row[data-asset="git:site"]').count()) === 1);
    await me.until('and opened', async () => (await me.page.locator('#assets-detail h2').innerText().catch(() => '')).includes('site'));
    await me.page.locator('#assets-close').click();
    await me.access('site', 'Write');
    assert.match(await me.page.locator('#view-assets').getAttribute('title'), /site - write/);
    await me.type('cd ../resources/site && git status --short --branch && echo "# site" > README.md && git add README.md && git -c user.name=t -c user.email=t@example.com commit -q -m first && git log --oneline | wc -l; cd - >/dev/null');
    await me.sees('## No commits yet on main');
    await me.sees('\n1\n');
    /* Its files are in Files; what git keeps for itself is not. */
    await me.files('site');
    await me.until('the file is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('README.md'));
    assert.equal((await me.page.locator('#files-rows').innerText()).includes('.git'), false);
    await me.page.locator('#view-terminal').click();
    /* And it can be given in a share, to read or to write, as any other thing. */
    await me.page.locator('#folders').click();
    await me.chapter('sharing');
    await me.until('its sheet is shown', async () => me.page.locator('#share').isVisible());
    await me.page.locator('#share').click();
    const offered = me.page.locator('#share-add .folder', { hasText: 'site' });
    await me.until('the repository is offered', async () => (await offered.count()) === 1);
    assert.match(await offered.innerText(), /site repository, attached here/);
    await offered.locator('button').click();
    assert.deepEqual(await me.page.locator('#share-basket .folder', { hasText: 'site' }).locator('.levels button').allInnerTexts(), ['Read', 'Write']);
    await me.page.locator('#sharing-close').click();
    /* An address that is not one is refused before git is run; ssh asks for a key. */
    assert.match((await me.api('/api/resources', { name: 'bad', type: 'git', from: 'file:///etc' })).body.error, /repository address is https/);
    assert.match((await me.api('/api/resources', { name: 'bad', type: 'git', from: 'ssh://git@example.com/x.git' })).body.error, /needs a key/);
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
    /* Where it is sent is set in Assets, the review says where. */
    await me.page.locator('#gitview-set-remote').click();
    await me.until('its remote form, in Assets', async () => me.page.locator('#gitview-url').isVisible());
    await me.page.fill('#gitview-url', remote);
    await me.page.fill('#gitview-key', 'a-token-the-tool-never-sees');
    await me.page.locator('#gitview-remote button[type=submit]').click();
    await me.until('it is saved', async () => /remote\.git/.test(await me.page.locator('#assets-detail .as-settings').innerText().catch(() => '')));
    await me.page.locator('#assets-detail button[data-act="review"]').click();
    /* What would go: the commit, the file, the change. */
    await me.until('the commit is shown', async () => /1 commit\(s\) would be sent to main/.test(await me.page.locator('#gitview-state').innerText()));
    assert.match(await me.page.locator('#gitview-commits').innerText(), /Add the home page/);
    assert.match(await me.page.locator('#gitview-stat').innerText(), /index\.html/);
    assert.match(await me.page.locator('#gitview-diff').innerText(), /\+\s*<h1>hello<\/h1>/);
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
    assert.deepEqual((await me.api('/api/git/site')).body, { remote, user: null, hasKey: true, sshKey: null });
    await me.page.locator('#gitview-close').click();
    await me.page.locator('#assets-close').click();
    /* The page closed: its Assets tab is there again, as it was left; the terminal is one tab away. */
    await me.page.locator('#view-terminal').click();
    await me.type('grep -r "a-token-the-tool-never-sees" ../resources/site /work 2>/dev/null | wc -l');
    await me.sees('\n0\n');
    assert.deepEqual(me.errors, []);
});

test('Settings, Dictation: a provider fills in its address and model; saved, it is used at once; "Try it" shows what was heard; the key never reaches the page', { skip: SKIP }, async (t) => {
    const second = (level) => { const s = new Float32Array(RATE); for (let i = 0; i < RATE; i++) s[i] = level * Math.sin((2 * Math.PI * 220 * i) / RATE); return s; };
    const microphone = join(mkdtempSync(join(tmpdir(), 'clv-mic-')), 'voice.wav');
    writeFileSync(microphone, toWav([second(0.004), second(0.004), second(0.5), second(0.004), second(0.004), second(0.004)]));
    const b = await bench(t, { microphone });
    const me = await b.person();
    assert.equal((await me.api('/api/secrets', { name: 'STT_KEY', value: 'a-key-never-shown' })).status, 201);
    await me.page.locator('#nav-settings').click();
    /* EVERY CHAPTER HAS SOMETHING TO ACT ON, but About, where the facts are, one line each. */
    await me.chapter('s-about');
    await me.until('the facts', async () => /^Clavarium \S+/.test(await me.page.locator('#settings-about').innerText()));
    assert.match(await me.page.locator('#settings-people').innerText(), /Development mode|Who may sign in/);
    assert.match(await me.page.locator('#settings-address').innerText(), /^Address: /);
    assert.equal(await me.page.locator('#settings-ch-people').count(), 0, 'People & address: merged into About');
    const idle = await me.page.locator('#settings details.chapter').evaluateAll((all) => all.filter((d) => !['s-about', 's-shortcuts'].includes(d.dataset.chapter) && !d.querySelector('.chapter-body button, .chapter-body select, .chapter-body input, .chapter-body textarea')).map((d) => d.dataset.chapter));
    assert.deepEqual(idle, [], 'a chapter that only ever shows text');
    /* No shortcut: one line, how to add one. */
    if ((await me.api('/api/shortcuts')).body.length === 0) { await me.chapter('s-shortcuts'); assert.match(await me.page.locator('#settings-shortcuts-hint').innerText(), /No shortcut yet/); }
    await me.chapter('s-dictation');
    await me.until('the environment\'s engine is said', async () => /set on the server \(CLAVARIUM_TRANSCRIPTION_URL\)/.test(await me.page.locator('#settings-dictation').innerText()));
    /* Each provider fills in its address and its model. */
    await me.page.selectOption('#dictation-provider', 'mistral');
    assert.equal(await me.page.inputValue('#dictation-url'), 'https://api.mistral.ai/v1/audio/transcriptions');
    assert.equal(await me.page.inputValue('#dictation-model'), 'voxtral-mini-latest');
    await me.page.selectOption('#dictation-provider', 'groq');
    assert.equal(await me.page.inputValue('#dictation-model'), 'whisper-large-v3-turbo');
    /* An address of this server's own network with a named provider: refused, and why. */
    await me.page.fill('#dictation-url', b.engineUrl);
    await me.page.locator('#dictation-save').click();
    await me.until('refused', async () => /only with "Other/.test(await me.page.locator('#dictation-error').innerText()));
    /* "Other (compatible)": an engine of one's own, here the bench's. */
    await me.page.selectOption('#dictation-provider', 'other');
    assert.equal(await me.page.inputValue('#dictation-url'), '');
    assert.equal(await me.page.locator('#dictation-other-hint').isVisible(), true);
    await me.page.fill('#dictation-url', b.engineUrl);
    await me.page.fill('#dictation-model', 'local-whisper');
    await me.page.selectOption('#dictation-secret', 'STT_KEY');
    await me.page.selectOption('#dictation-language', 'fr');
    await me.page.locator('#dictation-try').click();
    await me.until('heard', async () => (await me.page.locator('#dictation-heard').innerText()) === 'Heard: said out loud', 20_000);
    assert.equal(b.engineKeys.at(-1), 'Bearer a-key-never-shown', 'the server put the key in, from the secret');
    assert.equal((await me.api('/api/dictation')).body.source, 'env', 'trying saves nothing');
    await me.page.locator('#dictation-save').click();
    await me.until('saved', async () => /chosen here/.test(await me.page.locator('#settings-dictation').innerText()));
    const about = await me.api('/api/dictation');
    assert.deepEqual([about.body.provider, about.body.model, about.body.secret, about.body.language], ['other', 'local-whisper', 'STT_KEY', 'fr']);
    assert.equal(JSON.stringify(about.body).includes('a-key-never-shown'), false);
    assert.equal(await me.page.content().then((html) => html.includes('a-key-never-shown')), false);
    /* Turned off: the environment's engine again. */
    await me.page.locator('#dictation-off').click();
    await me.until('off', async () => (await me.api('/api/dictation')).body.source === 'env');
    assert.deepEqual(me.errors, []);
});
