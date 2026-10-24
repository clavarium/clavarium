import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { bench, SKIP } from './bench.mjs';

/* A one-page PDF saying "Hello from a tool", built here with exact offsets. */
function smallPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 18 Tf 20 100 Td (Hello from a tool) Tj ET';
    objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}
/* A 2x2 red PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoYQQwAHhYCAPmBfFgAAAAASUVORK5CYII=', 'base64');

/* Where on the page a piece of text of the terminal is: the middle of it. */
async function whereIs(page, text) {
    return page.evaluate((wanted) => {
        const t = window.clavariumTerminal; const buffer = t.buffer.active;
        for (let row = t.rows - 1; row >= 0; row--) {
            const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
            const col = line.lastIndexOf(wanted);
            if (col < 0) continue;
            const box = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: box.left + ((col + wanted.length / 2) * box.width) / t.cols, y: box.top + ((row + 0.5) * box.height) / t.rows };
        }
        return null;
    }, text);
}

test('a file is shown in the page: text as text, a picture as a picture, a PDF drawn page by page', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('viewer');
    const work = join(b.dir, 'kept-work', 'viewer', 'work');
    writeFileSync(join(work, 'summary.pdf'), smallPdf());
    writeFileSync(join(work, 'chart.png'), PNG);
    writeFileSync(join(work, 'page.html'), `<h1 id="planted">not a page of this site</h1><p id="asked"></p><p id="cookie"></p><p id="parent"></p><script>
        try { top.document.title = 'ran'; } catch { }
        document.getElementById('planted').textContent = 'ran inside';
        let c = 'none'; try { c = document.cookie || 'none'; } catch { } document.getElementById('cookie').textContent = c;
        let p = 'closed'; try { p = parent.document.title ? 'open' : 'open'; } catch { } document.getElementById('parent').textContent = p;
        fetch('/api/conversations').then((r) => { document.getElementById('asked').textContent = 'answered ' + r.status; }, () => { document.getElementById('asked').textContent = 'refused'; });
    </script>`);
    writeFileSync(join(work, 'data.bin'), Buffer.from([0, 1, 2, 3]));
    await me.files('work');
    const open = async (name) => { await me.page.locator('#files-rows .file', { hasText: name }).click(); };
    /* A PDF: drawn on a canvas by the page, never handed to the browser as a document. */
    await open('summary.pdf');
    await me.until('the page of the PDF is drawn', async () => (await me.page.locator('#preview-body canvas').count()) === 1 && /1 page\./.test(await me.page.locator('#preview-note').innerText()), 30_000);
    const inked = await me.page.evaluate(() => { const c = document.querySelector('#preview-body canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 0) dark++; return dark; });
    assert.ok(inked > 50, `the text is really drawn (${inked} dark points)`);
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#preview-download').click()]);
    assert.equal(download.suggestedFilename(), 'summary.pdf');
    await me.page.locator('#preview-close').click();
    /* A picture. */
    await open('chart.png');
    await me.until('the picture is shown', async () => me.page.evaluate(() => document.querySelector('#preview-body img')?.naturalWidth === 2));
    await me.page.locator('#preview-close').click();
    /* A web page written by a tool is SHOWN AS A PAGE, in a frame that is
       nobody: it runs, but it is not this site, has no session, and reaches
       nothing outside itself. */
    await open('page.html');
    const frame = me.page.frameLocator('#preview-body iframe');
    await me.until('the page is shown, and its own script ran', async () => (await frame.locator('#planted').innerText().catch(() => '')) === 'ran inside');
    assert.equal(await me.page.locator('#planted').count(), 0, 'nothing of it is built in this site\'s page');
    assert.notEqual(await me.page.title(), 'ran');
    assert.equal(await me.page.locator('#preview-body iframe').getAttribute('sandbox'), 'allow-scripts');
    const told = async (id) => frame.locator(id).innerText();
    await me.until('it tried what it could', async () => (await told('#asked').catch(() => '')) !== '' && (await told('#cookie').catch(() => '')) !== '');
    assert.equal(await told('#asked'), 'refused', 'it cannot ask this server for anything');
    assert.equal(await told('#cookie'), 'none', 'it has no cookie of the owner');
    assert.equal(await told('#parent'), 'closed', 'it cannot read the page around it');
    assert.match(await me.page.locator('#preview-note').innerText(), /closed frame/);
    /* Its source is one tap away. */
    await me.page.locator('#preview-body > button').click();
    await me.until('its source is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('<h1 id="planted">'));
    await me.page.locator('#preview-close').click();
    /* The answer itself carries the rules, whoever frames it. */
    const answer = await me.page.request.get(`${b.origin}/api/files/page?c=viewer&r=work&p=page.html`);
    assert.match(answer.headers()['content-security-policy'], /^sandbox allow-scripts; default-src 'none'/);
    assert.equal((await me.page.request.get(`${b.origin}/api/files/page?c=viewer&r=work&p=chart.png`)).status(), 400);
    /* A conversation whose network was cut: its page stays text, and the server refuses to serve it as a page. */
    await me.api('/api/conversations/viewer/network', { online: false });
    await me.page.reload(); await me.files('work');
    await open('page.html');
    await me.until('offline: its source is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('<h1 id="planted">'));
    assert.equal(await me.page.locator('#preview-body iframe').count(), 0);
    assert.match(await me.page.locator('#preview-note').innerText(), /offline/);
    assert.equal((await me.page.request.get(`${b.origin}/api/files/page?c=viewer&r=work&p=page.html`)).status(), 403);
    await me.page.locator('#preview-close').click();
    /* Anything else: said, and offered for download. */
    await open('data.bin');
    assert.match(await me.page.locator('#preview-note').innerText(), /not shown here\. Download it/);
    assert.deepEqual(me.errors, []);
});

test('a path the tool printed is clicked in the terminal and opens in Files, shown', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('pointer');
    await me.api('/api/resources', { name: 'reports' });
    await me.api('/api/conversations/pointer/resources', { resource: 'reports', access: 'write' });
    writeFileSync(join(b.dir, 'kept-work', 'pointer', 'work', 'summary.pdf'), smallPdf());
    await me.type('mkdir -p out; echo "figures" > out/q3.txt; echo "for the phone" > ../resources/reports/brief.txt; clear; echo "The PDF is ready: /work/summary.pdf (1 page)."; echo "See also /resources/reports/brief.txt, and the folder /work/out."; echo "Elsewhere: /etc/hostname"');
    await me.printed('Elsewhere: /etc/hostname');
    const click = async (text) => { const at = await whereIs(me.page, text); assert.ok(at, `${text} is on the screen`); await me.page.mouse.move(at.x, at.y); await me.page.mouse.click(at.x, at.y); };
    await click('/work/summary.pdf');
    await me.until('the PDF is shown in a window over the terminal', async () => (await me.page.locator('#viewer').isVisible()) && (await me.page.locator('#preview-name').innerText()) === 'summary.pdf' && (await me.page.locator('#preview-body canvas').count()) === 1, 30_000);
    assert.equal(await me.page.locator('#files').isVisible(), false, 'nobody was taken anywhere');
    /* Closed: the terminal is as it was, and takes what is typed. */
    await me.page.keyboard.press('Escape');
    assert.equal(await me.page.locator('#viewer').isVisible(), false);
    await me.page.keyboard.type('echo back-at-the-terminal');
    await me.page.keyboard.press('Enter');
    await me.sees('\nback-at-the-terminal');
    /* A file of an attached folder. */
    await click('/resources/reports/brief.txt');
    await me.until('the text is shown', async () => (await me.page.locator('#preview-body pre').innerText().catch(() => '')).includes('for the phone'));
    /* From the window, a way to the folder the file sits in: the Assets tab of the conversation, on it. */
    assert.equal(await me.page.locator('#preview-where').innerText(), 'Show in Assets');
    await me.page.locator('#preview-where').click();
    await me.until('its folder is listed, in the Assets tab', async () => (await me.page.locator('#cassets-detail').getAttribute('data-asset')) === 'folder:reports' && (await me.page.locator('#cassets-detail #files-rows').innerText()).includes('brief.txt'));
    assert.equal(await me.page.locator('#view-assets').getAttribute('aria-pressed'), 'true');
    assert.equal(await me.page.locator('#viewer').isVisible(), false);
    /* Back: the terminal, as it was. */
    await me.page.goBack(); await me.page.goBack();
    await me.until('the terminal again', async () => (await me.page.locator('#view-terminal').getAttribute('aria-pressed')) === 'true');
    /* A folder is listed, there too. */
    await click('/work/out');
    await me.until('the folder is listed', async () => (await me.page.locator('#cassets-detail #files-rows').innerText().catch(() => '')).includes('q3.txt') && (await me.page.locator('#files-path').innerText()).replace(/\s+/g, '') === 'work/out');
    await me.page.locator('#view-terminal').click();
    /* Any other path of the machine is not a link: a click there opens nothing. */
    await click('/etc/hostname');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await me.page.locator('#files').isVisible(), false);
    assert.deepEqual(me.errors, []);
});

test('on a tablet, a finger on the path opens it too -- even a file on the machine\'s own disk, fetched for the occasion', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person({ phone: true });
    await me.create('by-finger', 'Shell', { onDisk: true });
    writeFileSync(join(b.dir, 'vms', 'clv-by-finger', 'root', 'work', 'summary.pdf'), smallPdf());
    await me.type('clear; echo "Ready: /work/summary.pdf"; echo "Gone: /work/never-made.txt"');
    await me.printed('Gone: /work/never-made.txt');
    const tap = async (text) => { const at = await whereIs(me.page, text); await me.page.touchscreen.tap(at.x, at.y); };
    await tap('/work/summary.pdf');
    /* The canvas is there before its page is drawn and counted: wait for what is said, as the first test does. */
    await me.until('the PDF is drawn, and said to come from the machine', async () => (await me.page.locator('#preview-body canvas').count()) === 1 && /1 page\. Read from the disk of the machine: this file is not kept here/.test(await me.page.locator('#preview-note').innerText()), 30_000);
    /* Its Download button saves the same bytes. */
    const [download] = await Promise.all([me.page.waitForEvent('download'), me.page.locator('#preview-download').click()]);
    assert.equal(download.suggestedFilename(), 'summary.pdf');
    /* A finger outside the window closes it. */
    await me.page.touchscreen.tap(4, 200);
    await me.until('the window is closed', async () => !(await me.page.locator('#viewer').isVisible()));
    /* A path that leads nowhere says so. */
    await tap('/work/never-made.txt');
    await me.until('it says the file is not there', async () => /not on the machine/.test(await me.page.locator('#preview-note').innerText()));
    /* Nothing but /work is ever read from a machine. */
    assert.equal(await me.page.evaluate(async () => (await fetch('/api/files/machine?c=by-finger&p=/etc/hostname')).status), 400);
});

test('the screen can be light or dark: the terminal follows, and the choice is kept on this device', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('daylight');
    const look = () => me.page.evaluate(() => ({ theme: document.documentElement.dataset.theme, page: getComputedStyle(document.body).backgroundColor, terminal: window.clavariumTerminal.options.theme.background, button: document.querySelector('#theme [aria-pressed="true"]')?.textContent }));
    assert.deepEqual(await look(), { theme: 'dark', page: 'rgb(15, 20, 26)', terminal: '#0f141a', button: 'Dark' });
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-screen');
    await me.page.locator('#theme [data-theme="light"]').click();
    await me.page.locator('#settings-close').click();
    assert.deepEqual(await look(), { theme: 'light', page: 'rgb(251, 251, 250)', terminal: '#fbfbfa', button: 'Light' });
    /* Still typing in the same terminal. */
    await me.page.locator('#terminal').click();
    await me.type('echo still-here');
    await me.sees('\nstill-here');
    await me.page.reload();
    await me.until('the page is back', async () => (await me.state()) === 'live');
    assert.equal((await look()).theme, 'light', 'kept across a reload');
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-screen');
    await me.page.locator('#theme [data-theme="dark"]').click();
    await me.page.locator('#settings-close').click();
    assert.equal((await look()).theme, 'dark');
    /* System: as the device says, and as it changes. */
    await me.page.emulateMedia({ colorScheme: 'light' });
    await me.page.locator('#nav-settings').click();
    await me.chapter('s-screen');
    await me.page.locator('#theme [data-theme="system"]').click();
    assert.deepEqual(await look().then((x) => [x.theme, x.button]), ['light', 'System']);
    await me.page.emulateMedia({ colorScheme: 'dark' });
    await me.until('it follows the device', async () => (await look()).theme === 'dark');
});

test('the list of conversations folds away with one click and comes back; the terminal takes the room', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('roomy');
    const cols = () => me.page.evaluate(() => window.clavariumTerminal.cols);
    const before = await cols();
    await me.page.locator('#fold').click();
    /* It slides away (a fifth of a second), then is out of the way. */
    await me.until('the list is folded away', async () => !(await me.page.locator('#list').isVisible()));
    await me.until('the terminal is wider', async () => (await cols()) > before);
    await me.type('echo still-typing');
    await me.sees('\nstill-typing');
    await me.page.reload();
    await me.until('back and live', async () => (await me.state()) === 'live');
    assert.equal(await me.page.locator('#list').isVisible(), false, 'kept across a reload');
    await me.page.locator('#fold').click();
    await me.until('the list is back, at its width again', async () => await me.page.locator('#list').isVisible() && (await me.page.locator('#list').boundingBox()).width > 200);
});

/* A whole 3x2 PNG, made here (the one above is cut short: shown, but not decoded strictly). */
function wholePng(width, height) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
    const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
/* A 1x1 GIF: a picture of another type than PNG, which goes to the clipboard as PNG. */
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

test('Copy in the window: all the text of a text file, the source of a page, a picture as PNG; refused, the text is selected; on a shared device too', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: b.origin });
    await me.create('copier');
    const work = join(b.dir, 'kept-work', 'copier', 'work');
    const notes = '# Notes\n\nLine one, with accents: café été.\n\tIndented line.\n';
    writeFileSync(join(work, 'notes.md'), notes);
    writeFileSync(join(work, 'table.csv'), 'a,b\n1,2\n');
    writeFileSync(join(work, 'page.html'), '<h1>A page</h1>\n');
    writeFileSync(join(work, 'chart.png'), wholePng(3, 2));
    writeFileSync(join(work, 'dot.gif'), GIF);
    writeFileSync(join(work, 'summary.pdf'), smallPdf());
    const clipboard = () => me.page.evaluate(() => navigator.clipboard.readText());
    const picture = () => me.page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        if (!item.types.includes('image/png')) return item.types.join(',');
        const bitmap = await createImageBitmap(await item.getType('image/png'));
        return `png ${bitmap.width}x${bitmap.height}`;
    });
    await me.files('work');
    const open = async (name) => { await me.page.locator('#files-rows .file', { hasText: name }).click(); await me.until(`${name} is shown`, async () => (await me.page.locator('#preview-name').innerText()) === name && (await me.page.locator('#preview-note').innerText().catch(() => '')) !== 'Loading...'); };
    const copy = me.page.locator('#preview-copy');
    /* Text, exactly as it is: every character, tabs and new lines kept. */
    await open('notes.md');
    await me.until('Copy is offered', () => copy.isVisible());
    assert.equal(await copy.innerText(), 'Copy');
    await copy.click();
    await me.until('it says it copied', async () => (await copy.innerText()) === 'Copied');
    assert.equal(await clipboard(), notes);
    await me.until('and goes back to Copy', async () => (await copy.innerText()) === 'Copy', 5000);
    await me.page.locator('#preview-close').click();
    await open('table.csv');
    await copy.click();
    await me.until('the table is copied', async () => (await clipboard()) === 'a,b\n1,2\n');
    await me.page.locator('#preview-close').click();
    /* A page shown in its frame: its source is what is copied. */
    await open('page.html');
    await copy.click();
    await me.until('the source is copied', async () => (await clipboard()) === '<h1>A page</h1>\n');
    await me.page.locator('#preview-close').click();
    /* A picture: "Copy image", as PNG; another type drawn as PNG. */
    await open('chart.png');
    await me.until('Copy image is offered', async () => (await copy.isVisible()) && (await copy.innerText()) === 'Copy image');
    await copy.click();
    await me.until('the picture is copied', async () => (await copy.innerText()) === 'Copied');
    assert.equal(await picture(), 'png 3x2');
    await me.page.locator('#preview-close').click();
    await open('dot.gif');
    await copy.click();
    await me.until('the GIF is copied', async () => (await copy.innerText()) === 'Copied');
    assert.equal(await picture(), 'png 1x1');
    await me.page.locator('#preview-close').click();
    /* A PDF has nothing to copy here. */
    await open('summary.pdf');
    await me.until('drawn', async () => /1 page\./.test(await me.page.locator('#preview-note').innerText()), 30_000);
    assert.equal(await copy.isVisible(), false);
    await me.page.locator('#preview-close').click();
    /* The browser refuses: the text is selected instead, for a copy by hand; a page is turned to its source for that. */
    await me.page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('refused', 'NotAllowedError')); });
    await open('page.html');
    await copy.click();
    await me.until('the source is shown and selected', async () => (await me.page.evaluate(() => String(window.getSelection()).trim())) === '<h1>A page</h1>');
    assert.match(await me.page.locator('#preview-note').innerText(), /the text is selected, copy it yourself/);
    assert.equal(await copy.innerText(), 'Copy');
    await me.page.locator('#preview-close').click();
    assert.deepEqual(me.errors, []);
    /* On a device the folder is shared with: the same button, the same copy. */
    await me.api('/api/resources', { name: 'album' });
    await me.api('/api/conversations/copier/resources', { resource: 'album', access: 'write' });
    writeFileSync(join(b.dir, 'data', 'resources', 'album', 'one.txt'), 'shared words\n');
    const shared = await me.api('/api/shares', { grants: [{ asset: 'folder:album', rights: 'r' }] });
    const viewer = await b.person({ phone: true, at: shared.body.url.replace(/^https?:\/\/[^/]+/, '') });
    await viewer.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: b.origin });
    await viewer.until('its files are shown', async () => (await viewer.page.locator('#files-rows').innerText().catch(() => '')).includes('one.txt'));
    await viewer.page.locator('#files-rows .file', { hasText: 'one.txt' }).click();
    await viewer.until('the file is shown', async () => (await viewer.page.locator('#preview-body pre').innerText().catch(() => '')).includes('shared words'));
    await viewer.page.locator('#preview-copy').tap();
    await viewer.until('copied on the device', async () => (await viewer.page.evaluate(() => navigator.clipboard.readText())) === 'shared words\n');
    assert.deepEqual(viewer.errors, []);
});

test('a Markdown file is shown formatted, built element by element; its text is one tap away', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('reader');
    const work = join(b.dir, 'kept-work', 'reader', 'work');
    mkdirSync(join(work, 'docs', 'shots'), { recursive: true });
    writeFileSync(join(work, 'docs', 'shots', 'chart.png'), PNG);
    writeFileSync(join(work, 'outside.png'), PNG);
    writeFileSync(join(work, 'docs', 'other.md'), '# The other page\n');
    writeFileSync(join(work, 'docs', 'report.md'), [
        '# Disk report', '', 'Written by the tool, with **bold**, *emphasis*, `code` and a [link](https://example.com/docs).', '',
        '> [!IMPORTANT]', '> The disk is almost full.', '', '## What takes room', '',
        '| Folder | Size | Share |', '|:--|--:|:-:|', '| /var/log | 12 GB | 40% |', '| /home | 9 GB | 30% |', '',
        '- [x] logs rotated', '- [ ] old images removed', '', '1. first', '2. second', '',
        '> A plain quote.', '', '```js', 'const free = disk.size - disk.used;', '```', '',
        '![the chart](shots/chart.png) ![above its folder](../../outside.png) ![far](https://example.com/x.png)', '',
        'See [the other page](other.md). <script id="planted">top.document.title = "ran"</script> <b id="bold">not markup</b>', '',
    ].join('\n'));
    await me.files('work');
    await me.page.locator('#files-rows .file', { hasText: 'docs' }).click();
    await me.until('the folder is shown', async () => (await me.page.locator('#files-rows').innerText()).includes('report.md'));
    await me.page.locator('#files-rows .file', { hasText: 'report.md' }).click();
    const view = me.page.locator('#preview-body .md-view');
    await me.until('it is formatted', async () => (await view.locator('h2').first().innerText().catch(() => '')) === 'Disk report');
    assert.equal(await view.locator('h3').innerText(), 'What takes room');
    /* A table, in a box that scrolls; its alignment kept. */
    assert.equal(await view.locator('.parley-table table tbody tr').count(), 2);
    assert.deepEqual(await view.locator('.parley-table th').allInnerTexts(), ['Folder', 'Size', 'Share']);
    assert.equal(await view.locator('.parley-table td').nth(1).evaluate((td) => td.style.textAlign), 'right');
    assert.equal(await view.locator('.parley-callout[data-kind="important"]').count(), 1);
    assert.match(await view.locator('.parley-callout').innerText(), /almost full/);
    assert.equal(await view.locator('strong').innerText(), 'bold');
    assert.equal(await view.locator('em').innerText(), 'emphasis');
    assert.equal(await view.locator('.parley-task').count(), 2);
    assert.equal(await view.locator('ol li').count(), 2);
    assert.equal(await view.locator('blockquote').innerText(), 'A plain quote.');
    assert.match(await view.locator('.parley-code pre').innerText(), /const free = disk\.size - disk\.used;/);
    /* A link to the web: a new tab, sending nothing of this page. */
    const link = view.locator('a.parley-link');
    assert.equal(await link.getAttribute('href'), 'https://example.com/docs');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
    /* Pictures: only from its own folder, by the route of the thumbnails; any other is its caption. */
    const images = view.locator('img');
    assert.equal(await images.count(), 1);
    assert.match(await images.getAttribute('src'), /^\/api\/files\/thumb\?c=reader&r=work&p=docs%2Fshots%2Fchart\.png$/);
    await me.until('the picture is loaded', async () => images.evaluate((i) => i.complete && i.naturalWidth === 2));
    assert.deepEqual(await view.locator('.parley-noimg').allInnerTexts(), ['above its folder', 'far']);
    /* What looks like markup is text. */
    assert.equal(await me.page.locator('#planted, #bold').count(), 0);
    assert.match(await view.innerText(), /<b id="bold">not markup<\/b>/);
    assert.notEqual(await me.page.title(), 'ran');
    /* Its text, one tap away, exactly as it is; and back. */
    const choice = (label) => me.page.locator('#preview-body .md-switch button', { hasText: label });
    assert.equal(await choice('Formatted').getAttribute('aria-pressed'), 'true');
    await choice('Text').click();
    await me.until('its text is shown', async () => (await me.page.locator('#preview-body pre.source').innerText().catch(() => '')).startsWith('# Disk report\n'));
    assert.equal(await view.count(), 0);
    assert.equal(await choice('Text').getAttribute('aria-pressed'), 'true');
    await choice('Formatted').click();
    await me.until('formatted again', async () => (await view.locator('h2').count()) === 1);
    /* A file of the same folder it links to opens in the window. */
    await view.locator('button.parley-pathlink', { hasText: 'the other page' }).click();
    await me.until('the other page is shown', async () => (await me.page.locator('#preview-name').innerText()) === 'other.md' && (await view.locator('h2').innerText().catch(() => '')) === 'The other page');
    await me.page.locator('#preview-close').click();
    assert.deepEqual(me.errors, []);
    /* Pictures of it, dark, on a tablet and on a phone, when asked for. */
    const shots = process.env.CLAVARIUM_MD_SHOTS;
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    const p = me;
    await p.page.emulateMedia({ colorScheme: 'dark' });
    for (const [device, width, height] of [['tablet', 1180, 820], ['phone', 390, 844]]) {
        await p.page.setViewportSize({ width, height });
        await p.page.locator('#files-rows .file', { hasText: 'report.md' }).click();
        await p.until('formatted', async () => (await p.page.locator('#preview-body .md-view h3').count()) === 1);
        await p.until('its picture is loaded', async () => p.page.locator('#preview-body .md-view img').evaluate((i) => i.complete && i.naturalWidth === 2));
        await p.page.screenshot({ path: join(shots, `markdown-preview-${device}.png`) });
        await p.page.locator('#preview-close').click();
    }
});
