/* THE PUBLIC SITE (docs/), served as it is: no build step catches a broken
   link, so this does. Every page has the same header and footer, the menu
   lists every case, and every relative link, picture, download and anchor
   leads somewhere that exists inside docs/. Plain text reading, no browser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
/* A script from elsewhere runs with the page's rights: only these. */
const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com/', 'https://cdn.jsdelivr.net/npm/'];

function walk(dir, at = '') {
    return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
        const rel = at ? `${at}/${e.name}` : e.name;
        return e.isDirectory() ? walk(dir, rel) : [rel];
    });
}
const FILES = walk(ROOT);
const PAGES = FILES.filter((f) => f.endsWith('.html'));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const markup = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
const scripts = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1], body: m[2] }));
/* The home page reads its anchor to open a case (`#family`): those are ids too. */
const CASE_IDS = () => [...read('index.html').matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)"/g)].map((m) => m[1]);
const ids = new Map();
const idsOf = (rel) => {
    if (!ids.has(rel)) ids.set(rel, new Set([...markup(read(rel)).matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1]).concat(rel === 'index.html' ? CASE_IDS() : [])));
    return ids.get(rel);
};
const decode = (v) => v.replace(/&amp;/g, '&');
const external = (v) => /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//');

/* A link as written in `page`, to a path from docs/ (and its anchor), or a
   reason it goes nowhere. */
function resolve(page, value) {
    const [path, hash] = decode(value).split('#');
    const target = path === '' ? page : posix.normalize(posix.join(posix.dirname(page), path.split('?')[0]));
    if (target.startsWith('..')) return { error: 'leaves docs/' };
    const file = target.endsWith('/') || target === '.' ? posix.join(target, 'index.html') : target;
    if (!existsSync(join(ROOT, file)) || !statSync(join(ROOT, file)).isFile()) return { error: 'no such file' };
    if (hash !== undefined) {
        if (hash === '') return { error: 'an empty anchor' };
        if (!file.endsWith('.html') || !idsOf(file).has(decodeURIComponent(hash))) return { error: `no id "${hash}" in ${file}` };
    }
    return { file, hash };
}

/* The header or footer of a page, its links written from docs/, so that a
   page in cases/ compares with one at the top. */
function block(page, tag) {
    const m = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`).exec(markup(read(page)));
    if (!m) return null;
    return m[0].replace(/ aria-current="page"/g, '')
        .replace(/href="([^"]*)"/g, (all, v) => {
            if (external(v)) return all;
            const r = resolve(page, v);
            return r.error ? `href="BROKEN:${v}"` : `href="/${r.file}${r.hash === undefined ? '' : `#${r.hash}`}"`;
        })
        .replace(/\s+/g, ' ');
}
const menu = (header) => [...header.matchAll(/<a href="\/([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2].trim()]);

test('the site is there: pages, styles, pictures, setups', () => {
    for (const f of ['index.html', 'base.css', 'how-it-works.html', 'how-to-install-it.html']) assert.ok(FILES.includes(f), f);
    assert.ok(PAGES.length >= 10);
    assert.equal(FILES.some((f) => f.startsWith('blueprint/') || f.startsWith('_')), false, 'design notes and checks are not published');
});

test('every page has a title and a viewport, and runs no script from elsewhere', () => {
    for (const page of PAGES) {
        const html = read(page);
        assert.match(html, /<title>[^<\s][^<]*<\/title>/, `${page}: <title>`);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, `${page}: viewport`);
        for (const { attrs } of scripts(html)) {
            const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
            if (src && external(src)) assert.ok(SCRIPT_HOSTS.some((h) => src.startsWith(h)), `${page}: a script from ${src}`);
        }
    }
});

test('every page has the same header and the same footer', () => {
    const first = { header: block('index.html', 'header'), footer: block('index.html', 'footer') };
    assert.ok(first.header && first.footer);
    for (const page of PAGES) {
        assert.equal(block(page, 'header'), first.header, `${page}: its header differs from the home page's`);
        assert.equal(block(page, 'footer'), first.footer, `${page}: its footer differs from the home page's`);
    }
});

test('the menu has every case and "How it works"; the home page offers the same cases', () => {
    const header = block('index.html', 'header');
    const links = menu(header).map(([f]) => f);
    const cases = FILES.filter((f) => /^cases\/[^/]+\.html$/.test(f));
    assert.ok(cases.length >= 5);
    for (const c of cases) assert.ok(links.includes(c), `the menu lacks ${c}`);
    assert.ok(links.includes('how-it-works.html'), 'the menu lacks How it works');
    const drop = /<span class="drop-menu">([\s\S]*?)<\/span> <\/span>/.exec(header)?.[1] ?? '';
    const dropped = menu(drop).filter(([f]) => f.startsWith('cases/'));
    assert.deepEqual(dropped.map(([f]) => f).sort(), [...cases].sort(), 'the Use cases menu lists exactly the case pages');
    const offered = [...read('index.html').matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)"/g)].map((m) => [`cases/${m[1]}.html`, m[2]]);
    assert.deepEqual(offered, dropped, 'the cases on the home page are the menu\'s, with the same words');
});

test('every relative link, picture, stylesheet, download and anchor leads somewhere', () => {
    const broken = [];
    for (const page of PAGES) {
        const html = read(page);
        for (const m of markup(html).matchAll(/\s(href|src|poster)="([^"]*)"/g)) {
            if (external(m[2])) continue;
            const r = resolve(page, m[2]);
            if (r.error) broken.push(`${page}: ${m[1]}="${m[2]}": ${r.error}`);
        }
        /* What a script fetches or links to by name. */
        for (const { body } of scripts(html)) {
            for (const m of body.matchAll(/["']((?:\.\.\/|[\w-]+\/)*[\w.-]+\.(?:html|json|css|png|jpe?g|svg|webp))["']/g)) {
                const r = resolve(page, m[1]);
                if (r.error) broken.push(`${page}: "${m[1]}" in a script: ${r.error}`);
            }
        }
    }
    for (const sheet of FILES.filter((f) => f.endsWith('.css'))) {
        for (const m of read(sheet).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
            if (external(m[1]) || m[1].startsWith('#')) continue;
            if (!existsSync(join(ROOT, posix.dirname(sheet), m[1]))) broken.push(`${sheet}: url(${m[1]})`);
        }
    }
    assert.deepEqual(broken, []);
});

test('every setup offered for download is valid JSON', () => {
    for (const f of FILES.filter((x) => x.endsWith('.json'))) assert.doesNotThrow(() => JSON.parse(read(f)), f);
});

/* "Import it in Clavarium", the case pages say: so it must be a file the
   import reads (server/setup.mjs), with every agent on a tool Clavarium has. */
test('every setup offered for download is one the import reads', async () => {
    const { readSetup } = await import('../server/setup.mjs');
    const { readTools } = await import('../server/tools.mjs');
    const tools = readTools(readFileSync(join(ROOT, '..', 'config', 'tools.json'), 'utf8'));
    const setups = FILES.filter((x) => x.endsWith('.clavarium.json'));
    assert.ok(setups.length >= 5);
    for (const f of setups) {
        const { doc } = readSetup(read(f), tools);
        assert.ok(doc.nodes.filter((n) => n.kind === 'conversation').every((n) => tools.some((t) => t.id === n.tool)), `${f}: an agent on a tool Clavarium does not have`);
        assert.match(read(f.replace('.clavarium.json', '.html')), /Scripts are not built yet/, `${f}: its page says what the import does not do`);
    }
});
