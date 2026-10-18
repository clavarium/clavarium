/* ONE SET OF ICONS: the chat's (Lucide, copied in Parley with its version and
   licence), for the page's own too. Drawn the same whatever the fonts: no
   character stands for an icon any more. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packageFile } from '../server/parley.mjs';
const { ICONS } = await import(packageFile('clavarium-parley', 'ui/parley-icons.js'));

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

test('the three places at the bottom left are drawn from the set, as it has them', () => {
    const html = web('index.html');
    for (const [id, name] of [['nav-conversations', 'message-square'], ['nav-access', 'waypoints'], ['nav-settings', 'settings']]) {
        const svg = new RegExp(`id="${id}"[^>]*><svg[^>]*data-icon="${name}">([\\s\\S]*?)</svg>`).exec(html)?.[1];
        assert.ok(svg, id);
        const drawn = [...svg.matchAll(/<(\w+) ([^>]*)\/>/g)].map(([, tag, a]) => [tag, Object.fromEntries([...a.matchAll(/([a-z-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))]);
        assert.deepEqual(drawn, ICONS[name].map(([tag, a]) => [tag, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, String(v)]))]), `${id}: ${name}`);
    }
});

test('the map and the files take their icons from the set: no character that a font draws', () => {
    const links = web('links.js');
    assert.doesNotMatch(links, /'[▭▤⑂⚿✉]'|'>_'|'↑'|'↓'|text: '›'/);
    for (const name of /KIND_ICON = (\{[^}]*\})/.exec(links)[1].match(/'([a-z-]+)'/g).map((x) => x.slice(1, -1)).filter((x) => x.includes('-') || ICONS[x])) assert.ok(ICONS[name], name);
    const app = web('app.js');
    for (const name of /KIND_ICONS = (\{[^}]*\})/.exec(app)[1].match(/: '([a-z-]+)'/g).map((x) => x.slice(3, -1))) assert.ok(ICONS[name], name);
});
