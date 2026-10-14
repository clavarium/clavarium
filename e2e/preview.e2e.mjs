import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    await me.page.locator('#files-open').click();
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
    await me.page.reload(); await me.page.locator('#files-open').click();
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
    /* From the window, a way to the folder the file sits in. */
    await me.page.locator('#preview-where').click();
    await me.until('its folder is listed', async () => (await me.page.locator('#files').isVisible()) && (await me.page.locator('#files-rows').innerText()).includes('brief.txt'));
    assert.match(await me.page.locator('#files-tabs button[aria-selected=true]').innerText(), /reports/);
    assert.equal(await me.page.locator('#viewer').isVisible(), false);
    await me.page.locator('#files-close').click();
    /* A folder is listed. */
    await click('/work/out');
    await me.until('the folder is listed', async () => (await me.page.locator('#files-rows').innerText()).includes('q3.txt') && (await me.page.locator('#files-path').innerText()).replace(/\s+/g, '') === 'work/out');
    await me.page.locator('#files-close').click();
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
    const look = () => me.page.evaluate(() => ({ theme: document.documentElement.dataset.theme, page: getComputedStyle(document.body).backgroundColor, terminal: window.clavariumTerminal.options.theme.background, button: document.getElementById('theme').textContent }));
    assert.deepEqual(await look(), { theme: 'dark', page: 'rgb(15, 20, 26)', terminal: '#0f141a', button: 'Light' });
    await me.page.locator('#settings-open').click();
    await me.page.locator('#theme').click();
    await me.page.locator('#settings-close').click();
    assert.deepEqual(await look(), { theme: 'light', page: 'rgb(251, 251, 250)', terminal: '#fbfbfa', button: 'Dark' });
    /* Still typing in the same terminal. */
    await me.page.locator('#terminal').click();
    await me.type('echo still-here');
    await me.sees('\nstill-here');
    await me.page.reload();
    await me.until('the page is back', async () => (await me.state()) === 'live');
    assert.equal((await look()).theme, 'light', 'kept across a reload');
    await me.page.locator('#settings-open').click();
    await me.page.locator('#theme').click();
    await me.page.locator('#settings-close').click();
    assert.equal((await look()).theme, 'dark');
});

test('the list of conversations folds away with one click and comes back; the terminal takes the room', { skip: SKIP }, async (t) => {
    const b = await bench(t);
    const me = await b.person();
    await me.create('roomy');
    const cols = () => me.page.evaluate(() => window.clavariumTerminal.cols);
    const before = await cols();
    await me.page.locator('#fold').click();
    assert.equal(await me.page.locator('#list').isVisible(), false);
    await me.until('the terminal is wider', async () => (await cols()) > before);
    await me.type('echo still-typing');
    await me.sees('\nstill-typing');
    await me.page.reload();
    await me.until('back and live', async () => (await me.state()) === 'live');
    assert.equal(await me.page.locator('#list').isVisible(), false, 'kept across a reload');
    await me.page.locator('#fold').click();
    assert.equal(await me.page.locator('#list').isVisible(), true);
});
