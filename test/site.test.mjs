/* THE PUBLIC SITE (docs/), served as it is: no build step catches a broken link, so this does.
   Every page has a title and a viewport, runs no script from elsewhere, every relative link, picture
   and film leads somewhere inside docs/, and the addresses of the former site still lead somewhere.
   Plain text reading, no browser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
/* A script from elsewhere runs with the page's rights: only these. */
const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com/', 'https://cdn.jsdelivr.net/npm/'];
const walk = (dir, at = '') => readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
    const rel = at ? `${at}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, rel) : [rel];
});
const FILES = walk(ROOT);
const PAGES = FILES.filter((f) => f.endsWith('.html'));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const markup = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
const external = (v) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v);
const redirectOf = (html) => /<meta http-equiv="refresh" content="0; ?url=([^"]+)"/i.exec(html)?.[1];
const leads = (page, target) => {
    const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (!path) return true;
    const file = path.startsWith('/') ? path.slice(1) : posix.normalize(posix.join(posix.dirname(page), path));
    const full = join(ROOT, file);
    return existsSync(full) && (!statSync(full).isDirectory() || existsSync(join(full, 'index.html')));
};
const FORMER = ['how-it-works', 'how-to-install-it', 'how-to-use-it', 'how-it-is-kept-safe', 'questions', 'examples', 'for-you', 'cases/home', 'cases/code', 'cases/office', 'cases/europe', 'cases/family'];

test('the site is there: home, install line, domain', () => {
    for (const f of ['index.html', 'style.css', 'site.js', 'install.html', 'security.html', 'faq.html', 'roadmap.html', 'install.sh']) assert.ok(FILES.includes(f), f);
    assert.equal(read('CNAME').trim(), 'clavarium.org');
    assert.match(read('install.html'), /clavarium\.org\/install\.sh/);
});

test('every page has a title and a viewport, and runs no script from elsewhere', () => {
    for (const page of PAGES) {
        const html = read(page);
        assert.match(html, /<title>[^<\s][^<]*<\/title>/, `${page}: <title>`);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, `${page}: viewport`);
        for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) if (external(m[1])) assert.ok(SCRIPT_HOSTS.some((h) => m[1].startsWith(h)), `${page}: a script from ${m[1]}`);
    }
});

test('the real pages are open to search engines; the moved ones are not', () => {
    for (const page of PAGES) assert.equal(/name="robots"/.test(read(page)), redirectOf(read(page)) !== undefined, page);
});

test('every relative link, picture, stylesheet and film leads somewhere', () => {
    const broken = [];
    for (const page of PAGES) for (const m of markup(read(page)).matchAll(/\s(?:href|src|poster|srcset)="([^"]*)"/g)) {
        if (!m[1] || external(m[1]) || m[1].startsWith('#')) continue;
        if (!leads(page, m[1])) broken.push(`${page}: ${m[1]}`);
    }
    for (const m of read('site.js').matchAll(/'([\w-]+\.html)'/g)) if (!FILES.includes(m[1])) broken.push(`site.js: ${m[1]}`);
    assert.deepEqual(broken, []);
});

test('the addresses of the former site lead to a page of this one', () => {
    for (const name of FORMER) {
        const page = `${name}.html`;
        const to = redirectOf(read(page));
        assert.ok(to && leads(page, to), `${page} -> ${to}`);
    }
});

test('every setup offered for download is one the import reads', async () => {
    const { readSetup } = await import('../server/setup.mjs');
    const { readTools } = await import('../server/tools.mjs');
    const tools = readTools(readFileSync(join(ROOT, '..', 'config', 'tools.json'), 'utf8'));
    const setups = FILES.filter((x) => x.endsWith('.clavarium.json'));
    assert.ok(setups.length >= 5);
    for (const f of setups) {
        const { doc } = readSetup(read(f), tools);
        assert.ok(doc.nodes.filter((n) => n.kind === 'conversation').every((n) => tools.some((t) => t.id === n.tool)), `${f}: an agent on a tool Clavarium does not have`);
    }
});

/* ONE FOOTER, ONE HEADER (25-11): written into each page (read without a script, by search engines too), the same
   everywhere -- the install page alone without the install line, which the whole page is about. */
test('every page has the same header and the same footer (the install page: without the install line)', () => {
    const top = (p) => /<header class="top">[\s\S]*?<\/header>/.exec(read(p))?.[0];
    const foot = (p) => /<footer>[\s\S]*?<\/footer>/.exec(read(p))?.[0];
    const pages = PAGES.filter((p) => !p.includes('/') && foot(p));
    assert.ok(pages.length > 10, `${pages.length} pages with a footer`);
    const ref = foot('index.html');
    const refTop = top('index.html');
    assert.match(ref, /install\.sh \| sudo bash/);
    for (const p of pages) {
        const f = foot(p);
        if (p === 'install.html') assert.equal(f, ref.replace(/ {4}<p class="cmd-label">[\s\S]*?<\/div>\n(?= {4}<div class="meta">)/, ''), p);
        else assert.equal(f, ref, p);
        assert.equal(top(p), refTop, `${p}: its header`);
    }
});
