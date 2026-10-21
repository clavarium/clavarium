/* THE MAP (once "Who gets what"), AND FLOWS: the first tab of Access, with
 * its Map / Flows switch (app.js opens, closes and filters Access).
 *
 *   Map             devices, conversations and assets in columns that each
 *                   scroll on their own; a link is a right, coloured by what
 *                   it gives. At rest no line, a count on each box; a box
 *                   touched shows its links, greys the rest, and says them in
 *                   words. A link is made by dragging from a dot (or a box
 *                   touched, then another), changed by the knob on it, taken
 *                   away there: with the very requests and confirmations of
 *                   the per-conversation, per-device and per-asset screens.
 *                   On a phone: a list; a box touched rises from the bottom
 *                   with its links in words, and Edit gives them as rows.
 *   Flows           the trace of one box (what reaches it, what it reaches,
 *                   step by step; a loop shows on both sides), every flow on
 *                   its own, laid out in the order things go; a setup exported
 *                   to a file, or a file imported, shown whole first.
 *
 * The map comes from the server whole (GET /api/flows, see server/setup.mjs).
 * Nothing a name or a text holds is ever put in the page as HTML. Built by
 * app.js, which hands what it shares (requests, the share sheet, the
 * automatic sending form). */
(() => {
    const SVG = 'http://www.w3.org/2000/svg';
    /* Each kind's icon, from the set of the chat (Lucide, see icons.js): the same drawing on every screen, whatever its fonts. */
    const KIND_ICON = { device: 'smartphone', conversation: 'square-terminal', folder: 'folder', git: 'git-branch', mailbox: 'mail', secret: 'key-round' };
    /* An icon of that set, or, until it is there, nothing in its place. */
    const ic = (name, cls = 'lk-svg') => window.clavariumIcons?.icon(name, cls) ?? null;
    const kindIcon = (kind) => h('span', { class: 'lk-ic', 'aria-hidden': 'true' }, ic(KIND_ICON[kind]));
    /* A pill that points up or down: its arrow drawn, then its words. */
    const arrowed = (pill, dir, text) => { pill.replaceChildren(...[ic(dir === 'up' ? 'arrow-up' : 'arrow-down', 'lk-arrow')].filter(Boolean), text); return pill; };
    const KIND_WORD = { device: 'device', conversation: 'conversation', folder: 'folder', git: 'repository', mailbox: 'mailbox', secret: 'secret' };
    const COLUMN = { device: 'device', conversation: 'conversation', folder: 'asset', git: 'asset', mailbox: 'asset', secret: 'asset' };
    const TITLES = { device: 'Devices', conversation: 'Conversations', asset: 'Assets' };
    const VIEWS = {
        devices: { cols: [['device'], ['conversation', 'asset']], sources: ['device'] },
        convs: { cols: [['conversation'], ['asset']], sources: ['conversation'] },
        all: { cols: [['device'], ['conversation'], ['asset']], sources: ['device', 'conversation'] },
    };
    const WORDS = { term: 'Terminal', chat: 'Chat', both: 'Terminal + chat', read: 'Read', write: 'Read and write', use: 'Use' };

    /* A small maker of elements: text is always text. */
    function h(tag, props = {}, ...children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v === true ? '' : String(v));
        }
        for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
        return e;
    }
    const s = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
    const css = (k) => `var(--k-${k})`;
    const nameOf = (id) => id.slice(id.indexOf(':') + 1);
    const curve = (a, z) => { const dx = Math.max(30, (z.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}`; };
    const phone = () => matchMedia('(max-width: 600px)').matches;
    /* The map is on screen: Access is open, on its map. */
    const shownNow = () => !document.getElementById('links').hidden && !document.getElementById('access').hidden && !document.getElementById('access-map').hidden;

    window.clavariumLinks = (env) => {
        const $ = (id) => document.getElementById(id);
        let graph = { nodes: [], links: [], flows: [] };
        let byId = new Map();
        /* Everything by default, on every screen: the view that tells the most. */
        let view = 'all';
        try { const v = localStorage.getItem('clavarium-links-view'); if (VIEWS[v]) view = v; } catch { /* none kept */ }
        /* Every link is drawn unless this device chose to hide them: a screen with no line read as broken. */
        let allLines = true;
        try { allLines = localStorage.getItem('clavarium-links-all') !== '0'; } catch { /* none kept */ }
        let picked = null; let pinned = null; let focus = null; let drag = null; let pop = null; let popLink = null; let drawnMany = false;
        const ph = { screen: 'list', kind: 'device', id: null, adding: false, sheet: null };
        let traceOf = '*';

        const node = (id) => byId.get(id);
        /* What a link gives, as a colour. */
        const KIND = (l) => {
            const to = node(l.to);
            if (to?.kind === 'conversation') return l.rights.includes('x') && l.rights.includes('r') ? 'both' : l.rights.includes('x') ? 'term' : 'chat';
            if (to?.kind === 'secret') return 'use';
            return l.rights.includes('w') ? 'write' : 'read';
        };
        const said = (l) => {
            const k = KIND(l);
            if (k === 'chat' && !l.rights.includes('w')) return 'chat, read only';
            return WORDS[k].toLowerCase();
        };
        const allowed = (a, b) => !a.pending && !b.pending && ((a.kind === 'device' && ['conversation', 'folder', 'git', 'mailbox'].includes(b.kind)) || (a.kind === 'conversation' && ['folder', 'git', 'mailbox', 'secret'].includes(b.kind)));
        const inView = (n) => VIEWS[view].cols.flat().includes(COLUMN[n.kind]);
        const shown = (l) => VIEWS[view].sources.includes(node(l.from)?.kind) && inView(node(l.to));

        async function load() {
            const r = await fetch(`${env.API()}/flows`);
            graph = r.ok ? await r.json() : { nodes: [], links: [], flows: [] };
            byId = new Map(graph.nodes.map((n) => [n.id, n]));
            if (pinned && !byId.has(pinned)) pinned = null;
            if (picked && !byId.has(picked.id)) picked = null; else if (picked) picked = byId.get(picked.id);
        }
        const err = (text) => { const e = $('links-error'); e.textContent = text ?? ''; e.hidden = !text; };

        /* ---------- the requests: those of the other screens ---------- */
        async function request(path, body) {
            const r = await fetch(`${env.API()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw Object.assign(new Error(j.error || 'The request failed.'), { kind: j.kind });
            return j;
        }
        /* A link given or changed. `rights` as grants.mjs writes them. */
        async function give(l, rights, extra = {}) {
            const a = node(l.from); const b = node(l.to);
            if (a.kind === 'device') return request(`/devices/${nameOf(a.id)}/give`, { asset: b.id, rights });
            if (b.kind === 'secret') return request(`/conversations/${encodeURIComponent(a.name)}/secrets`, { secret: b.name, attached: true });
            return request(`/conversations/${encodeURIComponent(a.name)}/resources`, { resource: b.name, access: rights.includes('w') ? 'write' : 'read', ...extra });
        }
        async function takeAway(l) {
            const a = node(l.from); const b = node(l.to);
            if (a.kind === 'device') return request(`/devices/${nameOf(a.id)}/take`, { asset: b.id });
            if (b.kind === 'secret') return request(`/conversations/${encodeURIComponent(a.name)}/secrets`, { secret: b.name, attached: false });
            return request(`/conversations/${encodeURIComponent(a.name)}/resources`, { resource: b.name, access: 'none' });
        }
        const firstRights = (a, b) => (b.kind === 'conversation' ? env.partsFor(b.name) : b.kind === 'secret' ? 'x' : 'r');
        async function changed() { await load(); await env.refresh(); paint(); }
        async function link(a, b) {
            closePop(); picked = null; err('');
            const there = graph.links.find((x) => x.from === a.id && x.to === b.id);
            if (!there) {
                if (a.kind === 'conversation' && node(a.id).phase !== 'ready') { err(`${a.name} is not ready yet: its links are made once its machine is built.`); return; }
                try { await give({ from: a.id, to: b.id }, firstRights(a, b)); } catch (e) { err(e.message); return; }
                await changed();
            }
            const l = graph.links.find((x) => x.from === a.id && x.to === b.id);
            if (l && !phone()) openPop(l);
        }

        /* ---------- Who gets what: the board ---------- */
        const board = () => $('links-board');
        /* What each colour says. On a phone, every colour its list shows (dots, no lines). */
        function legend() {
            const box = $('links-legend'); box.replaceChildren();
            const small = phone();
            const parts = [];
            if (small || VIEWS[view].sources.includes('device')) parts.push('term', 'chat', 'both');
            parts.push('read', 'write'); if (small || VIEWS[view].sources.includes('conversation')) parts.push('use');
            const used = new Set(graph.links.filter((l) => small || shown(l)).map(KIND));
            for (const k of parts.filter((x) => used.has(x))) box.append(h('span', { class: `lk-key`, style: `color:${css(k)}` }, h('i'), h('span', { class: 'lk-key-w', text: WORDS[k] })));
            if (!small && graph.links.some((l) => shown(l) && node(l.from).kind === 'device' && COLUMN[node(l.to).kind] === 'asset')) box.append(h('span', { class: 'lk-key lk-dim' }, h('i', { class: 'dash' }), h('span', { class: 'lk-key-w', text: 'a device to an asset' })));
            if (graph.nodes.some((n) => n.pending)) box.append(h('span', { class: 'lk-key lk-dim' }, h('b', { class: 'lk-pending-key' }), h('span', { class: 'lk-key-w', text: 'dashed: to pair, or to add' })));
        }
        /* Boxes in the order that crosses least: each column in turn, both ways and a few
           times, puts each box at the average place of what it is linked to; the order
           that crossed least is kept. What is linked to nothing goes last, by name. */
        function layout() {
            const ASSETS = ['folder', 'git', 'mailbox', 'secret'];
            const base = (k) => graph.nodes.filter((n) => COLUMN[n.kind] === k).sort((a, b) => (ASSETS.indexOf(a.kind) - ASSETS.indexOf(b.kind)) || a.name.localeCompare(b.name));
            let cols = VIEWS[view].cols.map((ks) => ks.map(base));
            const colOf = new Map(); cols.forEach((gs, ci) => gs.flat().forEach((n) => colOf.set(n.id, ci)));
            const ls = graph.links.filter((l) => shown(l) && colOf.has(l.from) && colOf.has(l.to) && colOf.get(l.from) !== colOf.get(l.to));
            const near = new Map(); for (const l of ls) { near.set(l.from, [...(near.get(l.from) ?? []), l.to]); near.set(l.to, [...(near.get(l.to) ?? []), l.from]); }
            let pos = new Map();
            const rank = () => { pos = new Map(); for (const gs of cols) { const all = gs.flat(); all.forEach((n, i) => pos.set(n.id, all.length > 1 ? i / (all.length - 1) : 0.5)); } };
            const crossings = () => {
                let c = 0;
                for (let i = 0; i < ls.length; i += 1) for (let j = i + 1; j < ls.length; j += 1) {
                    const a = ls[i]; const b = ls[j];
                    if (colOf.get(a.from) !== colOf.get(b.from) || colOf.get(a.to) !== colOf.get(b.to)) continue;
                    if ((pos.get(a.from) - pos.get(b.from)) * (pos.get(a.to) - pos.get(b.to)) < 0) c += 1;
                }
                return c;
            };
            const sortCol = (ci) => {
                cols[ci] = cols[ci].map((g) => g.map((n, i) => { const r = (near.get(n.id) ?? []).map((id) => pos.get(id)); return { n, i, sc: r.length ? r.reduce((x, y) => x + y, 0) / r.length : Infinity }; })
                    .sort((x, y) => (x.sc === y.sc ? x.i - y.i : x.sc < y.sc ? -1 : 1)).map((x) => x.n));
                rank();
            };
            rank();
            let best = cols.slice(); let least = crossings();
            for (let round = 0; round < 6 && least > 0; round += 1) {
                for (let ci = 1; ci < cols.length; ci += 1) sortCol(ci);
                for (let ci = cols.length - 2; ci >= 0; ci -= 1) sortCol(ci);
                const c = crossings();
                if (c < least) { least = c; best = cols.slice(); }
            }
            return best;
        }
        function paint() {
            for (const b of document.querySelectorAll('#links-tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
            $('links-all').checked = allLines;
            legend();
            const bd = board();
            bd.className = `lk-board ${VIEWS[view].cols.length === 3 ? 'three' : 'two'}`;
            bd.querySelectorAll('.lk-col, .lk-knob, .lk-pop, .lk-edge').forEach((e) => e.remove()); pop = null; popLink = null;
            const lists = layout();
            VIEWS[view].cols.forEach((cols, ci) => {
                const col = h('div', { class: 'lk-col' });
                cols.forEach((k, i) => {
                    if (i) col.append(h('div', { class: 'lk-gap' }));
                    col.append(h('h3', { class: 'lk-colh' }, h('span', { text: TITLES[k] }), plus(k)));
                    const list = lists[ci][i];
                    for (const n of list) col.append(nodeEl(n));
                    if (!list.length) col.append(empty(k));
                });
                col.addEventListener('scroll', () => { place(); draw(); }, { passive: true });
                bd.append(col);
            });
            draw(); hint(); paintPhone();
        }
        /* How each kind is made: a device paired, a conversation created, an asset added. The same,
           from the small round "+" by each column's title (always there, however many it holds)
           and from an empty column. */
        const START = { device: () => env.newDevice(), conversation: () => env.newConversation(), asset: () => (env.newAsset ?? env.openAssets)() };
        const NEW = { device: 'New device', conversation: 'New conversation', asset: 'New asset' };
        const plus = (k) => h('button', { type: 'button', class: 'as-add lk-add', 'data-add': k, 'aria-label': NEW[k], title: NEW[k], text: '+', onclick: () => START[k]() });
        function empty(k) {
            const box = h('div', { class: 'lk-empty' }, h('p', { class: 'hint lk-none', text: k === 'device' ? 'No device paired yet.' : k === 'conversation' ? 'No conversation yet.' : 'Nothing kept here yet.' }));
            if (k === 'device') box.append(h('button', { type: 'button', class: 'primary', 'data-start': 'device', text: '+ Pair a device', onclick: START.device }));
            if (k === 'asset') box.append(h('button', { type: 'button', class: 'primary', 'data-start': 'asset', text: '+ Add an asset', onclick: START.asset }));
            if (k === 'conversation') box.append(h('button', { type: 'button', class: 'primary', 'data-start': 'conversation', text: '+ New conversation', onclick: START.conversation }));
            return box;
        }
        function nodeEl(n) {
            const cnt = graph.links.filter((l) => (l.from === n.id || l.to === n.id) && shown(l)).length;
            const e = h('div', { class: `lk-node lk-c-${COLUMN[n.kind]}${n.pending ? ' pending' : ''}`, 'data-id': n.id, 'data-kind': n.kind, tabindex: 0, role: 'button', 'aria-label': `${n.name}, ${n.sub}, ${cnt} link${cnt === 1 ? '' : 's'}` },
                kindIcon(n.kind),
                h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: n.name }), h('span', { class: 'lk-sb', text: n.sub })),
                h('span', { class: 'lk-cnt', text: String(cnt), title: `${cnt} link${cnt === 1 ? '' : 's'}` }));
            if (VIEWS[view].sources.includes(n.kind) && !n.pending) {
                const dot = h('span', { class: 'lk-handle', title: 'Drag to what it gets', 'aria-hidden': 'true' });
                dot.addEventListener('pointerdown', (ev) => startDrag(ev, n));
                e.append(dot);
            }
            e.addEventListener('click', (ev) => { if (!ev.target.closest('.lk-handle')) tap(n); });
            e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(n); } });
            e.addEventListener('pointerenter', (ev) => { if (!drag && ev.pointerType === 'mouse') { focus = n.id; draw(); } });
            e.addEventListener('pointerleave', (ev) => { if (!drag && ev.pointerType === 'mouse') { focus = null; draw(); } });
            return e;
        }
        const el = (id) => board().querySelector(`.lk-node[data-id="${CSS.escape(id)}"]`);
        /* Where a link meets a box; a box scrolled out of its column is met at the column's edge. */
        function anchor(id, side) {
            const n = el(id); const col = n.closest('.lk-col');
            const r = n.getBoundingClientRect(); const c = col.getBoundingClientRect(); const b = board().getBoundingClientRect();
            const top = c.top + 34; const bottom = c.bottom - 2;
            let y = r.top + r.height / 2; let away = 0;
            if (y < top) { y = top; away = -1; } else if (y > bottom) { y = bottom; away = 1; }
            return { x: (side === 'out' ? r.right : r.left) - b.left, y: y - b.top, away, col };
        }
        /* Everything a box reaches or is reached by, in this view. */
        function related(id) {
            const set = new Set([id]); const ls = graph.links.filter(shown);
            let grew = true;
            while (grew) { grew = false; for (const l of ls) if (set.has(l.from) && !set.has(l.to) && node(l.to).kind !== 'device') { set.add(l.to); grew = true; } }
            const up = new Set([id]); grew = true;
            while (grew) { grew = false; for (const l of ls) if (up.has(l.to) && !up.has(l.from)) { up.add(l.from); grew = true; } }
            for (const x of up) set.add(x);
            return set;
        }
        /* MANY LINKS: past this many in sight, every link is still drawn, but thin and
           pale, without its knob, and gathered: one trunk per box that opens into a fan
           near what it reaches. The box touched (or under the mouse) has its own links
           in full colour, with their knobs. Fewer than this: every link in full. */
        const MANY = 14;
        /* The way a link goes. Gathered, it leaves its box as one trunk and opens near
           its end. From a device to an asset over the conversations: it passes between
           two conversations (never through one, which would read as its link), by the
           free gap nearest to half way. */
        function route(a, z, over, gathered) {
            if (over) {
                const want = (a.y + z.y) / 2;
                let y = want; let best = Infinity;
                for (const [y0, y1] of over.free) {
                    const at = y1 - y0 >= 8 ? Math.min(Math.max(want, y0 + 4), y1 - 4) : (y0 + y1) / 2;
                    if (Math.abs(at - want) < best) { best = Math.abs(at - want); y = at; }
                }
                const g1 = over.left - a.x; const g2 = z.x - over.right;
                /* Its knob goes on the last stretch, after the conversations. */
                const knob = (t) => { const u = 1 - t; return { x: u ** 3 * over.right + 3 * u * u * t * (over.right + g2 / 2) + 3 * u * t * t * (z.x - g2 / 2) + t ** 3 * z.x, y: (u ** 3 + 3 * u * u * t) * y + (3 * u * t * t + t ** 3) * z.y }; };
                return { d: `M${a.x},${a.y} C${a.x + g1 / 2},${a.y} ${over.left - g1 / 2},${y} ${over.left},${y} L${over.right},${y} C${over.right + g2 / 2},${y} ${z.x - g2 / 2},${z.y} ${z.x},${z.y}`, knob };
            }
            if (!gathered) return { d: curve(a, z) };
            const g = Math.max(30, z.x - a.x); const t = a.x + g * 0.35;
            return { d: `M${a.x},${a.y} L${t},${a.y} C${t + g * 0.35},${a.y} ${z.x - g * 0.3},${z.y} ${z.x},${z.y}` };
        }
        /* The free gaps of the middle column, top to bottom, in the board's terms. */
        function gaps(col, b) {
            const c = col.getBoundingClientRect(); const out = [];
            let at = c.top + 34 - b.top;
            for (const n of [...col.querySelectorAll('.lk-node')].map((x) => x.getBoundingClientRect()).sort((x, y) => x.top - y.top)) {
                if (n.bottom - b.top < at) continue;
                if (n.top - b.top > at + 2) out.push([at, Math.min(n.top - b.top, c.bottom - b.top)]);
                at = Math.max(at, n.bottom - b.top);
                if (at > c.bottom - b.top) break;
            }
            if (at < c.bottom - b.top - 2) out.push([at, c.bottom - b.top]);
            return out;
        }
        function draw() {
            const bd = board(); const svg = $('links-svg');
            if (!shownNow() || phone()) return;
            const rel = (pinned || focus) ? related(pinned || focus) : null;
            const ls = graph.links.filter(shown).filter((l) => el(l.from) && el(l.to));
            const many = allLines && !drag && ls.length > MANY;
            bd.classList.toggle('simple', !allLines && !drag);
            bd.classList.toggle('many', many);
            const b = bd.getBoundingClientRect();
            const colEls = [...bd.querySelectorAll('.lk-col')]; const cols = colEls.map((c) => c.getBoundingClientRect());
            const middle = cols.length === 3 ? { left: cols[1].left - b.left, right: cols[1].right - b.left, free: gaps(colEls[1], b) } : null;
            svg.setAttribute('viewBox', `0 0 ${b.width} ${b.height}`);
            /* No arrowheads: the colour of a line says the right. */
            svg.replaceChildren();
            bd.querySelectorAll('.lk-knob, .lk-edge, .lk-hook').forEach((c) => c.remove());
            const edges = new Map(); const knobs = []; const wanted = []; const hooks = new Map();
            /* The pale ones first: the links in colour are drawn over them. */
            const layers = [s('g', { class: 'lk-pale' }), s('g')];
            svg.append(...layers);
            for (const l of ls) {
                const a = anchor(l.from, 'out'); const z = anchor(l.to, 'in'); const k = KIND(l);
                const off = rel && !(rel.has(l.from) && rel.has(l.to));
                const on = rel && !off;
                const pale = many && !on;
                const away = a.away || z.away;
                for (const [p, end] of [[a, l.from], [z, l.to]]) if (p.away && !off) { const e = edges.get(p.col) ?? { up: [], down: [] }; (p.away < 0 ? e.up : e.down).push(end); edges.set(p.col, e); }
                /* Gathered, a link to a box out of sight is a short hook at the end in sight, bent the way the
                   other end is; the pill at the column's edge says how many. */
                if (pale && away) {
                    /* Its other end hidden on the left: counted by the pill of that column only. */
                    if (a.away || off) continue;
                    const out = Boolean(z.away); const dir = a.away || z.away; const at = out ? a : z;
                    const key = `${out ? l.from : l.to}|${dir}`;
                    const g = hooks.get(key) ?? { box: out ? l.from : l.to, out, dir, x: at.x, y: at.y, room: z.x - a.x, k, ids: [] };
                    g.ids.push(out ? l.to : l.from); hooks.set(key, g);
                    continue;
                }
                const dash = node(l.from).kind === 'device' && COLUMN[node(l.to).kind] === 'asset';
                const over = dash && middle && !away ? middle : null;
                const r = route(a, z, over, many);
                const p = s('path', { d: r.d, class: [dash ? 'dash' : '', away ? 'away' : '', off ? 'dim' : '', on ? 'on' : '', pale ? 'pale' : '', l.pending ? 'later' : ''].join(' '), 'data-from': l.from, 'data-to': l.to, 'data-kind': k });
                p.style.stroke = css(k);
                layers[pale ? 0 : 1].append(p);
                if (away || pale || off) continue;
                const hit = s('path', { d: r.d, class: 'hit' }); hit.addEventListener('click', () => openPop(l)); layers[1].append(hit);
                const spots = (r.knob ? [0.5, 0.3, 0.7, 0.2, 0.82].map(r.knob) : [0.68, 0.55, 0.8, 0.45, 0.88, 0.38].map((f) => p.getPointAtLength(p.getTotalLength() * f)));
                wanted.push({ l, k, off, on, spots, late: Boolean(r.knob) });
            }
            /* Where several links meet, each knob takes the first spot along its own line clear of the others;
               a link over the conversations, which has more room, last. The knob: near the target, never on
               the dot it was drawn from, nor on a box. */
            for (const { l, k, off, on, spots } of wanted.sort((x, y) => Number(x.late) - Number(y.late))) {
                const room = (q) => Math.min(Infinity, ...knobs.map((o) => Math.hypot(o.x - q.x, o.y - q.y)));
                const at = spots.find((q) => room(q) > 24) ?? spots.reduce((x, y) => (room(y) > room(x) ? y : x));
                knobs.push(at);
                const kb = h('button', { type: 'button', class: `lk-knob${off ? ' dim' : ''}${on ? ' on' : ''}`, style: `background:${css(k)};left:${at.x}px;top:${at.y}px`, title: `${node(l.from).name} → ${node(l.to).name}: ${said(l)}`, 'aria-label': `${node(l.from).name} to ${node(l.to).name}: ${said(l)}. Change.`, 'data-from': l.from, 'data-to': l.to });
                kb.addEventListener('click', () => openPop(l));
                bd.append(kb);
            }
            /* A box whose links go to boxes out of sight: a short hook bent the way they are, and a small
               pill naming them; touched, it brings the first into sight. */
            const taken = [];
            for (const g of hooks.values()) {
                const len = Math.min(40, g.room * 0.3); const names = [...new Set(g.ids)].map((id) => node(id).name);
                const d = g.out ? `M${g.x},${g.y} L${g.x + len * 0.5},${g.y} Q${g.x + len},${g.y} ${g.x + len},${g.y + g.dir * 12}` : `M${g.x - len},${g.y + g.dir * 12} Q${g.x - len},${g.y} ${g.x - len * 0.5},${g.y} L${g.x},${g.y}`;
                const hook = s('path', { d, class: 'pale hook' }); hook.style.stroke = css(g.k); layers[0].append(hook);
                const pill = h('button', { type: 'button', class: `lk-hook ${g.out ? 'out' : 'in'}`, title: `${g.dir < 0 ? 'Above' : 'Below'}: ${names.join(', ')}`,
                    style: `${g.out ? `left:${g.x + 4}px` : `left:${g.x - 4}px`};top:${g.y + g.dir * 22}px;max-width:${Math.max(48, Math.min(170, g.room - 24))}px` });
                arrowed(pill, g.dir < 0 ? 'up' : 'down', `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}`);
                pill.addEventListener('click', () => { el([...g.ids].find((id) => el(id)))?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
                bd.append(pill);
                /* A name cut short says nothing: where it does not fit, the count, the names in its title. */
                if (pill.scrollWidth > pill.clientWidth + 1) {
                    /* No room in the gap: inside its box, at the end of its second line, where there is. */
                    const r = el(g.box)?.getBoundingClientRect();
                    if (r) { pill.classList.add('inbox'); pill.style.left = `${r.right - b.left - 20}px`; pill.style.top = `${r.bottom - b.top - 13}px`; pill.style.maxWidth = `${Math.max(48, r.width - 100)}px`; }
                    if (pill.scrollWidth > pill.clientWidth + 1) arrowed(pill, g.dir < 0 ? 'up' : 'down', String(names.length));
                }
                /* Never over another pill or a knob: moved further the same way, or left out (the hook stays). */
                const clear = () => { const r = pill.getBoundingClientRect(); return [...taken, ...knobs.map((q) => ({ left: q.x + b.left - 11, right: q.x + b.left + 11, top: q.y + b.top - 11, bottom: q.y + b.top + 11 }))].every((o) => r.right < o.left || r.left > o.right || r.bottom < o.top || r.top > o.bottom); };
                let tries = 0;
                while (!clear() && tries < 2) { tries += 1; pill.style.top = `${g.y + g.dir * (22 + tries * 20)}px`; }
                if (clear()) taken.push(pill.getBoundingClientRect()); else pill.remove();
            }
            /* Links to boxes scrolled away: a pill says how many, and brings the first into sight.
               Above: in the column's title band; below: in the strip under the column. Never over a name. */
            for (const [col, e] of edges) {
                const c = col.getBoundingClientRect();
                for (const [dir, ids] of [['up', e.up], ['down', e.down]]) {
                    if (!ids.length) continue;
                    const n = new Set(ids).size;
                    const pill = h('button', { type: 'button', class: `lk-edge ${dir}`, title: `${n} linked box${n === 1 ? '' : 'es'} ${dir === 'up' ? 'above' : 'below'}: bring into sight`,
                        style: dir === 'up' ? `left:${c.right - b.left - 14}px;top:${c.top - b.top + 8}px` : `left:${c.left - b.left + c.width / 2}px;top:${c.bottom - b.top + 4}px` });
                    arrowed(pill, dir, `${n} more linked`);
                    pill.addEventListener('click', () => { el(ids[0])?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
                    bd.append(pill);
                }
            }
            if (drag?.at) svg.append(s('path', { d: curve(anchor(drag.from.id, 'out'), drag.at), class: 'temp' }));
            const src = picked || drag?.from;
            bd.querySelectorAll('.lk-node').forEach((e) => {
                const n = node(e.dataset.id);
                e.classList.toggle('picked', Boolean(src) && src.id === n.id);
                e.classList.toggle('can', Boolean(src) && src.id !== n.id && allowed(src, n));
                e.classList.toggle('faded', Boolean(rel) && !rel.has(n.id));
            });
            if (many !== drawnMany) { drawnMany = many; hint(); }
        }

        /* A tap shows only what concerns that box; tapped again, everything comes back.
           A box that gives is also ready to be linked: tap a dashed box to link it. */
        function tap(n) {
            if (picked && picked.id !== n.id && allowed(picked, n)) { void link(picked, n); return; }
            const again = pinned === n.id;
            pinned = again ? null : n.id;
            picked = !again && VIEWS[view].sources.includes(n.kind) && !n.pending ? n : null;
            closePop(); hint(); reveal(); draw();
        }
        /* A box touched: what it is linked to, scrolled out of sight in another column, is brought into it. */
        function reveal() {
            if (!pinned || phone() || !el(pinned)) return;
            const rel = related(pinned); const mine = el(pinned).closest('.lk-col');
            for (const col of board().querySelectorAll('.lk-col')) {
                if (col === mine) continue;
                const ns = [...col.querySelectorAll('.lk-node')].filter((e) => rel.has(e.dataset.id));
                if (!ns.length) continue;
                const c = col.getBoundingClientRect(); const rs = ns.map((e) => e.getBoundingClientRect());
                if (rs.every((r) => r.top >= c.top + 30 && r.bottom <= c.bottom)) continue;
                const top = Math.min(...rs.map((r) => r.top)); const bottom = Math.max(...rs.map((r) => r.bottom));
                col.scrollTop += bottom - top < c.height - 50 ? (top + bottom) / 2 - (c.top + c.bottom) / 2 : top - c.top - 40;
            }
        }
        /* The board takes the height left on the screen: as many boxes in sight as can be. */
        function fit() {
            const bd = board(); const a = $('access');
            if (phone() || !shownNow()) return;
            const top = bd.getBoundingClientRect().top - a.getBoundingClientRect().top + a.scrollTop;
            const want = `${Math.round(Math.max(320, a.clientHeight - top - 20))}px`;
            if (bd.style.height !== want) { bd.style.height = want; requestAnimationFrame(() => draw()); }
        }
        function hint() {
            card();
            $('links-hint').textContent = pinned ? (picked ? `To give ${picked.kind === 'device' ? 'a conversation or an asset to' : 'an asset to'} ${picked.name}, tap it.` : '')
                : !graph.nodes.length ? 'Nothing here yet: pair a device, add an asset, or start a conversation.'
                : !graph.links.length ? 'Nothing is linked yet. Drag from the dot of a device or a conversation to what it gets.'
                : !allLines ? 'Tap a box to see its links. The number on a box is how many it has.'
                : drawnMany ? 'Many links: all drawn thin. Tap a box to see its own in colour.' : 'Tap a box to see its links in words.';
        }
        /* One box, in plain words: what it gives or gets, then what comes with it through a conversation. */
        function wordsFor(n) {
            const items = [];
            const out = graph.links.filter((l) => l.from === n.id); const inn = graph.links.filter((l) => l.to === n.id);
            const dot = (l) => h('span', { class: 'lk-sw', style: `background:${css(KIND(l))}` });
            const b = (t) => h('b', { text: t });
            const later = (l) => (l.pending ? h('span', { class: 'lk-via', text: ' (once added)' }) : null);
            if (n.kind === 'device') {
                for (const l of out) items.push([dot(l), `${said(l)} of `, b(node(l.to).name), later(l)]);
                for (const l of out.filter((x) => node(x.to).kind === 'conversation')) {
                    const ms = graph.links.filter((x) => x.from === l.to);
                    if (ms.length) items.push([h('span', { class: 'lk-via' }, `via ${node(l.to).name}: `, ms.map((m, i) => [i ? ', ' : '', `${said(m)} of `, b(node(m.to).name)]))]);
                }
            } else if (n.kind === 'conversation') {
                for (const l of inn) items.push([dot(l), b(node(l.from).name), ` may use its ${said(l)}`, later(l)]);
                for (const l of out) items.push([dot(l), `its agent: ${said(l)} of `, b(node(l.to).name), later(l)]);
            } else {
                for (const l of inn) items.push([dot(l), b(node(l.from).name), node(l.from).kind === 'conversation' ? "'s agent" : '', `: ${said(l)}`, later(l)]);
                for (const l of inn.filter((x) => node(x.from).kind === 'conversation')) for (const d of graph.links.filter((x) => x.to === l.from)) items.push([h('span', { class: 'lk-via' }, `via ${node(l.from).name}: `, b(node(d.from).name), ' sees what its agent does')]);
            }
            return items;
        }
        function card() {
            const c = $('links-card');
            if (!pinned || !node(pinned)) { c.hidden = true; fit(); return; }
            const n = node(pinned);
            const items = wordsFor(n);
            const actions = h('span', { class: 'lk-card-actions' });
            if (n.pending === 'pair') actions.append(h('button', { type: 'button', class: 'primary', text: 'Pair it...', onclick: () => { void pairIt(n); } }));
            if (n.pending === 'missing' || n.pending === 'connect') actions.append(h('button', { type: 'button', class: 'primary', text: n.pending === 'missing' ? 'Add its value...' : 'Add it...', onclick: () => { env.openAssets(); } }));
            if (n.pending) actions.append(h('button', { type: 'button', text: 'Forget it', onclick: () => { void forget(n); } }));
            actions.append(h('button', { type: 'button', id: 'links-trace-it', text: 'Trace it', onclick: () => { void openFlows(n.id); } }),
                h('button', { type: 'button', text: 'See everything', onclick: () => { pinned = null; picked = null; draw(); hint(); } }));
            c.replaceChildren(h('h3', {}, h('span', { text: n.name }), h('small', { text: n.sub }), actions),
                items.length ? h('ul', {}, items.map((i) => h('li', {}, i))) : h('p', { class: 'lk-none', text: 'No link yet.' }));
            /* A paired device: its own card -- rename it, revoke it, what it has (the Devices tab is gone). */
            const own = deviceCard(n);
            if (own) c.append(own);
            c.hidden = false; fit();
        }
        const deviceCard = (n) => (n.kind === 'device' && !n.pending && n.id.startsWith('device:') ? env.deviceCard?.(n.id.slice('device:'.length)) ?? null : null);
        async function pairIt(n) {
            try { const what = await request('/setup/pair', { label: n.name }); closeSheet(); await env.pairNew(what.grants, what.label); }
            catch (e) { err(e.message); }
        }
        async function forget(n) {
            const id = n.pending === 'pair' ? `device:${n.name}` : n.pending === 'missing' ? `secret:${n.name}` : `asset:${n.id}`;
            try { await request('/setup/drop', { id }); pinned = null; await changed(); } catch (e) { err(e.message); }
        }

        /* Dragging near a column's top or bottom scrolls it, so a target out of sight can be reached. */
        function startDrag(ev, n) {
            ev.preventDefault(); ev.stopPropagation(); closePop(); picked = null;
            drag = { from: n, at: null, x: 0, y: 0 };
            const tick = () => {
                if (!drag) return;
                const over = document.elementFromPoint(drag.x, drag.y)?.closest('.lk-col');
                if (over) { const c = over.getBoundingClientRect(); if (drag.y < c.top + 50) over.scrollTop -= 8; else if (drag.y > c.bottom - 40) over.scrollTop += 8; }
                requestAnimationFrame(tick);
            };
            const move = (e) => { const b = board().getBoundingClientRect(); drag.x = e.clientX; drag.y = e.clientY; drag.at = { x: e.clientX - b.left, y: e.clientY - b.top }; draw(); };
            const up = (e) => {
                removeEventListener('pointermove', move); removeEventListener('pointerup', up);
                const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.lk-node');
                const from = drag.from; drag = null;
                if (t && allowed(from, node(t.dataset.id))) void link(from, node(t.dataset.id)); else draw();
            };
            addEventListener('pointermove', move); addEventListener('pointerup', up);
            requestAnimationFrame(tick);
        }

        /* ---------- the knob: one link, changed or taken away ---------- */
        function closePop() { if (pop) { pop.remove(); pop = null; popLink = null; } }
        /* What can be chosen for a link, as the other screens offer it. */
        function choicesOf(l) {
            const a = node(l.from); const b = node(l.to);
            if (b.kind === 'conversation') return { type: 'parts' };
            if (b.kind === 'secret') return { type: 'fixed', text: 'Use: handed to its tool as a variable and a file, the next time it starts.' };
            if (b.kind === 'mailbox') return { type: 'fixed', text: 'Read only: a mailbox is never written here.' };
            return { type: 'levels', write: b.kind === 'git' && a.kind === 'conversation' ? 'Commits; sending stays under your rules' : 'Add, change, delete' };
        }
        function openPop(l) {
            closePop(); err('');
            const a = node(l.from); const b = node(l.to);
            popLink = l;
            pop = h('div', { class: 'lk-pop', role: 'dialog', 'aria-label': `${a.name} to ${b.name}` });
            pop.append(h('h4', {}, h('span', { text: `${a.name} → ${b.name}` }), h('small', { text: b.kind === 'conversation' ? 'What this device may use in the conversation' : a.kind === 'device' ? 'What this device may do with it' : 'What its agent may do with it' })));
            const note = h('p', { class: 'lk-note', role: 'alert', hidden: true });
            const fail = (e) => {
                note.textContent = e.message; note.hidden = false;
                if (e.kind === 'confirm-shared') note.append(' ', h('button', { type: 'button', class: 'danger', text: 'Confirm and attach', onclick: async () => { try { await give(l, 'rw', { shared: true }); await changed(); openPop(graph.links.find((x) => x.from === l.from && x.to === l.to) ?? l); } catch (x) { fail(x); } } }));
            };
            const set = async (rights) => { try { await give(l, rights); await changed(); const now = graph.links.find((x) => x.from === l.from && x.to === l.to); if (now) openPop(now); } catch (e) { fail(e); } };
            if (l.pending) pop.append(h('p', { class: 'lk-note', text: `Waiting: made once ${a.pending ? `${a.name} is paired` : `${b.name} is added here`}. ${said(l)}.` }));
            else {
                const c = choicesOf(l);
                if (c.type === 'parts') {
                    const has = { terminal: l.rights.includes('x'), chat: l.rights.includes('r') };
                    for (const [part, text, sub, k] of [['terminal', 'Terminal', 'The whole terminal: root in its machine', 'term'], ['chat', 'Chat', b.chat ? 'Read and write in its chat' : 'Its chat is off: the device sees it once you turn it on', 'chat']]) {
                        const box = h('input', { type: 'checkbox', name: 'part', value: part });
                        box.checked = has[part];
                        box.addEventListener('change', () => {
                            const next = { ...has, [part]: box.checked };
                            if (!next.terminal && !next.chat) { box.checked = true; need.hidden = false; return; }
                            const chat = next.chat ? (has.chat ? l.rights.replace('x', '') : 'rw') : '';
                            void set(`${chat}${next.terminal ? 'x' : ''}`);
                        });
                        pop.append(h('label', {}, box, h('span', { class: 'lk-sw', style: `background:${css(k)}` }), h('span', {}, text, h('small', { text: sub }))));
                    }
                    const need = h('p', { class: 'lk-note', hidden: true, text: 'At least one. To give nothing, remove the link.' });
                    pop.append(need, h('p', { class: 'lk-note', text: 'The device never turns the chat on or off.' }));
                } else if (c.type === 'levels') {
                    for (const [rights, text, sub, k] of [['r', 'Read', 'See and copy, never change', 'read'], ['rw', 'Read and write', c.write, 'write']]) {
                        const box = h('input', { type: 'radio', name: 'level', value: rights });
                        box.checked = l.rights === rights;
                        box.addEventListener('change', () => { void set(rights); });
                        pop.append(h('label', {}, box, h('span', { class: 'lk-sw', style: `background:${css(k)}` }), h('span', {}, text, h('small', { text: sub }))));
                    }
                    /* Automatic sending belongs to this very link: the form of the conversation's Access, here. */
                    if (b.kind === 'git' && a.kind === 'conversation' && l.rights === 'rw') pop.append(env.autoSending(a.name, b.name));
                } else pop.append(h('p', { class: 'lk-note', text: c.text }));
            }
            pop.append(note);
            const row = h('div', { class: 'lk-row' });
            const rm = h('button', { type: 'button', class: 'lk-rm', text: 'Remove link' });
            rm.addEventListener('click', () => {
                const last = a.kind === 'device' && graph.links.filter((x) => x.from === a.id).length === 1;
                /* The question in words above, two short buttons side by side below. */
                const question = a.kind === 'device' ? `Take ${b.name} back from ${a.name}?${last ? ' It has nothing else: the device is removed too.' : ''}` : b.kind === 'secret' ? `Stop handing ${b.name} to ${a.name}?` : `Detach ${b.name} from ${a.name}?`;
                const ask = h('p', { class: 'lk-ask', text: question });
                const sure = h('button', { type: 'button', class: 'danger', text: 'Remove' });
                const keep = h('button', { type: 'button', text: 'Cancel', onclick: () => openPop(l) });
                sure.addEventListener('click', async () => {
                    sure.disabled = true;
                    try { await takeAway(l); closePop(); await changed(); if (b.kind === 'secret') err(`${b.name} will no longer be handed to ${a.name}'s tool the next time it starts.`); } catch (e) { fail(e); }
                });
                row.before(ask);
                row.replaceChildren(sure, keep);
            });
            if (l.pending) rm.hidden = true;
            row.append(rm, h('button', { type: 'button', class: 'primary', text: 'Done', onclick: () => { closePop(); draw(); } }));
            pop.append(row);
            board().append(pop); place();
            /* Whole in sight: the board may reach below the screen. */
            pop.scrollIntoView({ block: 'nearest' });
            pop.querySelector('input')?.focus({ preventScroll: true });
        }
        function place() {
            if (!pop || !popLink || !el(popLink.from) || !el(popLink.to)) return;
            const a = anchor(popLink.from, 'out'); const z = anchor(popLink.to, 'in'); const b = board().getBoundingClientRect();
            const x = Math.min(Math.max(8, (a.x + z.x) / 2 - pop.offsetWidth / 2), b.width - pop.offsetWidth - 8);
            const y = Math.min(Math.max(8, (a.y + z.y) / 2 + 16), Math.max(8, b.height - pop.offsetHeight - 8));
            pop.style.left = `${x}px`; pop.style.top = `${y}px`;
        }

        /* ---------- on a phone: a list; a box touched rises from the bottom with its links; Edit gives its links as rows ---------- */
        function closeSheet() { if (!ph.sheet) return; ph.sheet = null; $('links-phone').querySelector('.lk-sheet-wrap')?.remove(); sheetSync(); }
        /* The page is told when the box rises and when it is gone: over the screen, Back closes it. */
        let sheetShown = false;
        function sheetSync() {
            const now = Boolean(ph.sheet) && phone();
            if (now === sheetShown) return;
            sheetShown = now;
            if (now) env.sheetOpened?.(() => { sheetShown = false; closeSheet(); }); else env.sheetClosed?.();
        }
        function sheetFor(n) {
            const items = wordsFor(n);
            const edit = () => { ph.sheet = null; ph.screen = 'one'; ph.id = n.id; ph.adding = false; paintPhone(); $('access').scrollTop = 0; };
            const actions = h('div', { class: 'lk-row lk-sheet-acts' });
            if (n.pending === 'pair') actions.append(h('button', { type: 'button', class: 'primary', text: 'Pair it...', onclick: () => { void pairIt(n); } }));
            if (n.pending === 'missing' || n.pending === 'connect') actions.append(h('button', { type: 'button', class: 'primary', text: 'Add it...', onclick: () => { closeSheet(); env.openAssets(); } }));
            actions.append(h('button', { type: 'button', id: 'links-sheet-edit', class: n.pending ? null : 'primary', text: 'Edit', onclick: edit }),
                h('button', { type: 'button', text: 'Trace it', onclick: () => { void openFlows(n.id); } }));
            return h('div', { class: 'lk-sheet-wrap', onclick: (e) => { if (e.target === e.currentTarget) closeSheet(); } },
                h('div', { class: `lk-sheet lk-c-${COLUMN[n.kind]}`, id: 'links-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${n.name}: its links`, 'data-id': n.id },
                    h('div', { class: 'lk-sheet-top' }, kindIcon(n.kind),
                        h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: n.name }), h('span', { class: 'lk-sb', text: n.sub })),
                        h('button', { type: 'button', class: 'lk-x', 'aria-label': 'Close', text: '×', onclick: closeSheet })),
                    items.length ? h('ul', { class: 'lk-sheet-links' }, items.map((i) => h('li', {}, i))) : h('p', { class: 'lk-none', text: 'No link yet.' }),
                    actions, deviceCard(n)));
        }
        const PHONE_KINDS = [['device', 'Devices'], ['conversation', 'Conversations'], ['asset', 'Assets']];
        function paintPhone() { paintPhone2(); sheetSync(); }
        function paintPhone2() {
            const box = $('links-phone');
            if (!phone()) { box.replaceChildren(); return; }
            if (ph.screen === 'one' && !node(ph.id)) ph.screen = 'list';
            if (ph.screen === 'list') {
                const kinds = h('div', { class: 'lk-kinds' }, h('span', { class: 'hint lk-show', text: 'Show' }), PHONE_KINDS.map(([k, w]) => h('button', { type: 'button', 'aria-pressed': String(k === ph.kind), text: w, onclick: () => { ph.kind = k; paintPhone(); } })));
                const list = h('ul', { class: 'lk-plist' });
                for (const n of graph.nodes.filter((x) => COLUMN[x.kind] === ph.kind).sort((a, b) => a.name.localeCompare(b.name))) {
                    const ls = graph.links.filter((l) => l.from === n.id || l.to === n.id);
                    list.append(h('li', {}, h('button', { type: 'button', class: `lk-item${n.pending ? ' pending' : ''}`, 'data-id': n.id, onclick: () => { ph.sheet = n.id; paintPhone(); $('links-sheet-edit')?.focus(); } },
                        h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: n.name }), h('span', { class: 'lk-sb', text: `${n.sub} · ${ls.length} link${ls.length === 1 ? '' : 's'}` })),
                        h('span', { class: 'lk-dots' }, ls.slice(0, 6).map((l) => h('i', { style: `background:${css(KIND(l))}` }))), h('span', { class: 'lk-chev', 'aria-hidden': 'true' }, ic('chevron-right') ?? '›'))));
                }
                if (!graph.nodes.length) list.append(h('li', { class: 'lk-start' }, ['device', 'conversation', 'asset'].map(empty)));
                else if (!list.children.length) list.append(h('li', {}, empty(ph.kind)));
                /* The kind shown, and its "+", always. */
                const head = h('div', { class: 'lk-phead' }, h('b', { text: TITLES[ph.kind] }), plus(ph.kind));
                box.replaceChildren(kinds, head, list);
                if (ph.sheet && node(ph.sheet)) box.append(sheetFor(node(ph.sheet))); else ph.sheet = null;
                return;
            }
            const n = node(ph.id);
            const seg = (l) => {
                const c = choicesOf(l);
                if (l.pending) return h('p', { class: 'lk-via', text: 'Waiting: made once it is added or paired.' });
                if (c.type === 'fixed') return h('p', { class: 'lk-via', text: c.text });
                const opts = c.type === 'parts' ? [['x', 'Terminal', 'term'], ['r', 'Chat', 'chat']] : [['r', 'Read', 'read'], ['rw', 'Read and write', 'write']];
                return h('div', { class: 'lk-seg' }, opts.map(([v, w, k]) => {
                    const on = c.type === 'parts' ? l.rights.includes(v) : l.rights === v;
                    return h('button', { type: 'button', 'aria-pressed': String(on), style: on ? `color:${css(k)}` : '', text: w, onclick: async () => {
                        let next = v;
                        if (c.type === 'parts') {
                            const has = { x: l.rights.includes('x'), r: l.rights.includes('r') }; has[v] = !has[v];
                            if (!has.x && !has.r) return;
                            next = `${has.r ? (l.rights.includes('r') ? l.rights.replace('x', '') : 'rw') : ''}${has.x ? 'x' : ''}`;
                        }
                        try { await give(l, next); await changed(); } catch (e) { err(e.message); }
                    } });
                }));
            };
            const row = (l, other, what) => h('div', { class: 'lk-prow', 'data-from': l.from, 'data-to': l.to },
                h('div', { class: 'lk-top' }, h('i', { style: `background:${css(KIND(l))}` }), h('b', { text: other.name }), h('span', { class: 'lk-sb', text: what }),
                    l.pending ? null : h('button', { type: 'button', class: 'lk-x', 'aria-label': `Remove the link to ${other.name}`, text: '×', onclick: (ev) => {
                        const btn = ev.currentTarget;
                        btn.replaceWith(h('button', { type: 'button', class: 'danger', text: n.kind === 'device' || node(l.from).kind === 'device' ? 'Take back' : 'Detach', onclick: async () => { try { await takeAway(l); await changed(); } catch (e) { err(e.message); } } }));
                    } })),
                seg(l));
            const out = graph.links.filter((l) => l.from === n.id); const inn = graph.links.filter((l) => l.to === n.id);
            const parts = [h('div', { class: 'lk-bar' }, h('button', { type: 'button', text: `‹ ${PHONE_KINDS.find((k) => k[0] === COLUMN[n.kind])[1]}`, onclick: () => { ph.screen = 'list'; paintPhone(); } })),
                h('h3', { class: 'lk-ptitle', text: n.name }), h('p', { class: 'lk-sb', text: n.sub })];
            const actions = h('div', { class: 'lk-row' }, h('button', { type: 'button', text: 'Trace it', onclick: () => { void openFlows(n.id); } }));
            if (n.pending === 'pair') actions.prepend(h('button', { type: 'button', class: 'primary', text: 'Pair it...', onclick: () => { void pairIt(n); } }));
            if (n.pending === 'missing' || n.pending === 'connect') actions.prepend(h('button', { type: 'button', class: 'primary', text: 'Add it...', onclick: () => { env.openAssets(); } }));
            parts.push(actions);
            if (n.kind === 'device' || n.kind === 'conversation') {
                parts.push(h('h4', { text: n.kind === 'device' ? 'This device may use' : 'Its agent may use' }), out.length ? h('div', { class: 'lk-rows' }, out.map((l) => row(l, node(l.to), KIND_WORD[node(l.to).kind]))) : h('p', { class: 'lk-none', text: 'Nothing yet.' }));
                if (n.kind === 'device') {
                    const via = out.filter((l) => node(l.to).kind === 'conversation').map((l) => [l, graph.links.filter((m) => m.from === l.to)]).filter(([, ms]) => ms.length)
                        .map(([l, ms]) => h('p', { class: 'lk-via' }, `via ${node(l.to).name}: `, ms.map((m, i) => [i ? ', ' : '', `${said(m)} of `, h('b', { text: node(m.to).name })])));
                    if (via.length) parts.push(h('h4', { text: 'Comes with it' }), ...via);
                }
                if (!n.pending) {
                    if (ph.adding) {
                        const can = graph.nodes.filter((t) => allowed(n, t) && !out.some((l) => l.to === t.id));
                        parts.push(h('h4', { text: 'Link to' }), h('ul', { class: 'lk-plist' }, can.map((t) => h('li', {}, h('button', { type: 'button', class: 'lk-item', 'data-add': t.id, onclick: async () => { ph.adding = false; await link(n, t); paintPhone(); } },
                            h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: t.name }), h('span', { class: 'lk-sb', text: t.sub })), h('span', { class: 'lk-chev', 'aria-hidden': 'true' }, ic('plus') ?? '+'))))));
                    } else parts.push(h('button', { type: 'button', class: 'lk-add', text: `+ Link to ${n.kind === 'device' ? 'a conversation or an asset' : 'an asset'}`, onclick: () => { ph.adding = true; paintPhone(); } }));
                }
            }
            if (n.kind !== 'device') parts.push(h('h4', { text: n.kind === 'conversation' ? 'Used from' : 'Given to' }), inn.length ? h('div', { class: 'lk-rows' }, inn.map((l) => row(l, node(l.from), KIND_WORD[node(l.from).kind]))) : h('p', { class: 'lk-none', text: 'No one.' }));
            box.replaceChildren(...parts);
        }

        /* ---------- Flows: the trace, every flow, a setup in a file ---------- */
        /* Which way things go: a device drives the conversations it may use; a
           conversation that may write puts into the asset; an asset is read by
           those that may read it; a secret is handed to its conversation. */
        function edges() {
            const e = [];
            for (const l of graph.links) {
                const a = node(l.from); const b = node(l.to); const k = KIND(l);
                if (!a || !b) continue;
                if (b.kind === 'conversation') e.push({ from: a.id, to: b.id, k, l });
                else if (b.kind === 'secret') e.push({ from: b.id, to: a.id, k: 'use', l });
                else { e.push({ from: b.id, to: a.id, k: 'read', l }); if (l.rights.includes('w')) e.push({ from: a.id, to: b.id, k: 'write', l }); }
            }
            return e;
        }
        const sentence = (e) => {
            const a = node(e.from).name; const b = node(e.to).name;
            if (e.k === 'read') return [b, ' reads ', a];
            if (e.k === 'write') return [a, ' writes in ', b];
            if (e.k === 'use') return [b, ' is handed ', a];
            return [a, ` uses the ${WORDS[e.k].toLowerCase().replace('+', 'and')} of `, b];
        };
        const sentenceEl = (e) => { const [x, verb, y] = sentence(e); return h('li', {}, h('span', { class: 'lk-sw', style: `background:${css(e.k)}` }), h('b', { text: x }), verb, h('b', { text: y }), e.l.pending ? h('span', { class: 'lk-via', text: ' (once added)' }) : null); };
        /* One link, one sentence: what the flows list says in words. */
        const linkSentence = (l) => {
            const a = node(l.from); const b = node(l.to); const k = KIND(l);
            const verb = b.kind === 'conversation' ? ` uses the ${said(l).replace('+', 'and')} of ` : k === 'use' ? ' is handed ' : k === 'write' ? ' reads and writes ' : ' reads ';
            return h('li', {}, h('span', { class: 'lk-sw', style: `background:${css(k)}` }), h('b', { text: a.name }), verb, h('b', { text: b.name }), l.pending ? h('span', { class: 'lk-via', text: ' (once added)' }) : null);
        };
        /* Each side walked on its own: a box can be both before and after (a loop), and is then shown on both sides. */
        function sides(id) {
            const E = edges(); const out = [];
            for (const [dir, step] of [['down', 1], ['up', -1]]) {
                const seen = new Set([id]); let front = [id]; let d = 0;
                while (front.length) {
                    d += step; const next = [];
                    for (const x of front) for (const e of E) {
                        const y = dir === 'down' ? (e.from === x ? e.to : null) : (e.to === x ? e.from : null);
                        if (y && !seen.has(y)) { seen.add(y); next.push(y); out.push({ id: y, d }); }
                    }
                    front = next;
                }
            }
            return [{ id, d: 0 }, ...out];
        }
        const tnode = (n, extra = '') => h('button', { type: 'button', class: `lk-tnode lk-c-${COLUMN[n.kind]}${n.pending ? ' pending' : ''}${extra}`, title: `Trace ${n.name}` }, h('b', { text: n.name }), h('small', { text: n.sub }));
        function drawEdges(boardEl, svgEl, list) {
            requestAnimationFrame(() => {
                const r = boardEl.getBoundingClientRect();
                svgEl.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
                svgEl.replaceChildren();
                for (const [ka, kz, k, pending] of list) {
                    const a = boardEl.querySelector(`[data-key="${CSS.escape(ka)}"]`)?.getBoundingClientRect(); const z = boardEl.querySelector(`[data-key="${CSS.escape(kz)}"]`)?.getBoundingClientRect();
                    if (!a || !z) continue;
                    const p = s('path', { d: curve({ x: a.right - r.left, y: a.top + a.height / 2 - r.top }, { x: z.left - r.left, y: z.top + z.height / 2 - r.top }), class: pending ? 'later' : '' });
                    p.style.stroke = css(k); svgEl.append(p);
                }
            });
        }
        function trace() {
            const box = $('flows-trace'); box.replaceChildren();
            const n = node(traceOf);
            if (!n) return;
            const all = sides(traceOf); const ds = [...new Set(all.map((x) => x.d))].sort((a, b) => a - b);
            const where = new Set(all.map((x) => `${x.id}@${x.d}`));
            const tb = h('div', { class: 'lk-tboard' }); const sv = s('svg', { class: 'lk-links', 'aria-hidden': 'true' }); tb.append(sv);
            const words = h('ol', { class: 'lk-steps' });
            for (const d of ds) {
                const col = h('div', { class: 'lk-tcol' }, h('h5', { text: d === 0 ? 'This' : d < 0 ? `${-d} step${d < -1 ? 's' : ''} before` : `${d} step${d > 1 ? 's' : ''} after` }));
                for (const x of all.filter((y) => y.d === d)) {
                    const b = tnode(node(x.id), d === 0 ? ' me' : ''); b.dataset.key = `${x.id}@${d}`;
                    b.addEventListener('click', () => { traceOf = x.id; paintFlows(); });
                    col.append(b);
                }
                tb.append(col);
            }
            const list = [];
            for (const e of edges()) for (const d of ds) {
                if (!(d >= 0 || d + 1 <= 0)) continue;
                if (where.has(`${e.from}@${d}`) && where.has(`${e.to}@${d + 1}`)) list.push([`${e.from}@${d}`, `${e.to}@${d + 1}`, e.k, e.l.pending, e, d]);
            }
            drawEdges(tb, sv, list);
            /* The same, in sentences, step by step: what a phone shows instead of the drawing. */
            for (const d of ds.filter((x) => x !== 0)) {
                const these = list.filter((x) => (d > 0 ? x[5] === d - 1 : x[5] === d));
                if (!these.length) continue;
                words.append(h('li', {}, h('b', { class: 'lk-step', text: d < 0 ? `${-d} step${d < -1 ? 's' : ''} before` : `${d} step${d > 1 ? 's' : ''} after` }), h('ul', {}, these.map((x) => sentenceEl(x[4])))));
            }
            const none = list.length === 0 ? h('p', { class: 'lk-none', text: `${n.name} is linked to nothing.` }) : null;
            box.append(...[h('div', { class: 'lk-tscroll' }, tb), none, h('details', { class: 'lk-words', open: phone() || undefined }, h('summary', { text: 'In words' }), words)].filter(Boolean));
        }
        /* Every flow: cut by computation into groups that touch nothing else,
           each laid out in the order things go: loops cut where a walk comes
           back on itself, then each box one step after the furthest that reaches it. */
        function islands() {
            const host = $('flows-all'); host.replaceChildren();
            const E = edges();
            const linked = new Set(graph.flows.flatMap((f) => f.nodes));
            graph.flows.forEach((f, gi) => {
                const g = f.nodes; const set = new Set(g); const es = E.filter((e) => set.has(e.from) && set.has(e.to));
                const indeg = new Map(g.map((x) => [x, es.filter((e) => e.to === x && e.from !== x).length]));
                const order = [...g].sort((x, y) => (indeg.get(x) - indeg.get(y)) || ((node(x).kind === 'device' ? 0 : 1) - (node(y).kind === 'device' ? 0 : 1)) || x.localeCompare(y));
                const state = new Map(); const back = new Set(); const topo = [];
                const visit = (x) => { state.set(x, 1); for (const e of es.filter((y) => y.from === x)) { if (state.get(e.to) === 1) back.add(e); else if (!state.has(e.to)) visit(e.to); } state.set(x, 2); topo.push(x); };
                for (const x of order) if (!state.has(x)) visit(x);
                topo.reverse();
                const lvl = new Map(g.map((x) => [x, 0]));
                for (const x of topo) for (const e of es) if (e.from === x && !back.has(e) && e.to !== x) lvl.set(e.to, Math.max(lvl.get(e.to), lvl.get(x) + 1));
                /* What nothing reaches sits just before the first thing it reaches, not far left behind other boxes. */
                for (const x of g) {
                    if (es.some((e) => e.to === x && !back.has(e) && e.from !== x)) continue;
                    const next = es.filter((e) => e.from === x && !back.has(e) && e.to !== x).map((e) => lvl.get(e.to));
                    if (next.length) lvl.set(x, Math.max(0, Math.min(...next) - 1));
                }
                const counts = ['device', 'conversation', 'asset'].map((k) => [k, g.filter((x) => COLUMN[node(x).kind] === k).length]).filter(([, c]) => c);
                const title = h('span', { class: 'lk-flow-name', text: f.name });
                const rename = h('button', { type: 'button', text: 'Rename', 'aria-label': `Rename the flow ${f.name}` });
                rename.addEventListener('click', () => {
                    const field = h('input', { value: f.name, maxlength: 60, 'aria-label': 'Name of this flow' });
                    const save = async () => { try { graph = await request('/flows/name', { around: f.around, name: field.value }); byId = new Map(graph.nodes.map((n) => [n.id, n])); } catch (e) { flowsErr(e.message); } paintFlows(); };
                    field.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') void save(); if (ev.key === 'Escape') paintFlows(); });
                    title.replaceWith(field); rename.replaceWith(h('button', { type: 'button', class: 'primary', text: 'Save', onclick: () => { void save(); } })); field.focus();
                });
                /* What ties it together: an asset several conversations share (clients that must not mix see it here). */
                const shared = g.filter((x) => COLUMN[node(x).kind] === 'asset' && new Set(graph.links.filter((l) => l.to === x && node(l.from).kind === 'conversation').map((l) => l.from)).size > 1).map((x) => node(x).name);
                const head = h('h4', {}, h('span', { text: `Flow ${gi + 1}: ` }), title, h('small', { text: counts.map(([k, c]) => `${c} ${k}${c > 1 ? 's' : ''}`).join(' · ') }),
                    shared.length ? h('span', { class: 'lk-shared', text: `shared: ${shared.join(', ')}` }) : null,
                    h('span', { class: 'lk-row' }, rename, h('button', { type: 'button', text: 'Export this flow', 'data-export': f.around, onclick: () => { void exportFile(f.around); } })));
                const tb = h('div', { class: 'lk-tboard' }); const sv = s('svg', { class: 'lk-links', 'aria-hidden': 'true' }); tb.append(sv);
                for (const d of [...new Set(lvl.values())].sort((a, b) => a - b)) {
                    const col = h('div', { class: 'lk-tcol' });
                    for (const x of g.filter((y) => lvl.get(y) === d).sort()) { const b = tnode(node(x)); b.dataset.key = x; b.addEventListener('click', () => { traceOf = x; paintFlows(); }); col.append(b); }
                    tb.append(col);
                }
                const list = es.filter((e) => !back.has(e) && lvl.get(e.to) > lvl.get(e.from)).map((e) => [e.from, e.to, e.k, e.l.pending]);
                drawEdges(tb, sv, list);
                const words = h('ul', { class: 'lk-steps' }, graph.links.filter((l) => set.has(l.from) && set.has(l.to)).map(linkSentence));
                host.append(h('section', { class: 'lk-island', 'data-around': f.around }, head, h('div', { class: 'lk-tscroll' }, tb), h('details', { class: 'lk-words', open: phone() || undefined }, h('summary', { text: 'In words' }), words)));
            });
            const alone = graph.nodes.filter((n) => !linked.has(n.id)).map((n) => n.name);
            if (!graph.flows.length) host.append(h('p', { class: 'lk-none', text: 'No flow yet: nothing is linked to anything.' }));
            if (alone.length) host.append(h('p', { class: 'lk-alone', text: `Linked to nothing: ${alone.join(', ')}.` }));
        }
        const flowsErr = (text) => { const e = $('flows-error'); e.textContent = text ?? ''; e.hidden = !text; };
        function paintFlows() {
            const sel = $('flows-of'); sel.replaceChildren(h('option', { value: '*', text: 'All flows, one by one' }));
            for (const [k, w] of [['device', 'Devices'], ['conversation', 'Conversations'], ['asset', 'Assets']]) {
                const g = h('optgroup', { label: w });
                for (const n of graph.nodes.filter((x) => COLUMN[x.kind] === k).sort((a, b) => a.name.localeCompare(b.name))) g.append(h('option', { value: n.id, text: n.name }));
                if (g.children.length) sel.append(g);
            }
            if (traceOf !== '*' && !node(traceOf)) traceOf = '*';
            sel.value = traceOf;
            $('flows-trace').hidden = traceOf === '*'; $('flows-all').hidden = traceOf !== '*';
            $('flows-note').textContent = traceOf === '*' ? 'Each flow touches nothing else. Tap a box to trace it.' : (phone() ? 'What reaches it, then what it reaches, step by step.' : 'Left: what reaches it. Right: what it reaches. Step by step.');
            if (traceOf === '*') islands(); else trace();
        }

        /* A setup to a file: the configuration, never the data -- or, with "and the files of its folders" ticked,
           the configuration and those files, as a .tar.gz (server/bundle.mjs), told first how large. */
        async function exportFile(flow) {
            flowsErr('');
            if ($('flows-with-files').checked) {
                try {
                    const q = flow ? `flow=${encodeURIComponent(flow)}&` : '';
                    const r = await fetch(`${env.API()}/setup/bundle?${q}stats=1`); const s = await r.json();
                    if (!r.ok) throw new Error(s.error ?? 'The files could not be counted.');
                    const files = s.folders.reduce((a, x) => a + x.files, 0); const bytes = s.folders.reduce((a, x) => a + x.bytes, 0);
                    const size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
                    const a = h('a', { href: `${env.API()}/setup/bundle?${q.replace(/&$/, '')}`, download: `${(s.name || 'setup').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'setup'}.clavarium.tar.gz` });
                    document.body.append(a); a.click(); a.remove();
                    $('flows-said').textContent = `Exporting ${s.name} with ${files} file${files === 1 ? '' : 's'} from ${s.folders.length} folder${s.folders.length === 1 ? '' : 's'} (about ${size}): your browser saves it as it comes. Names of secrets only, no key, no password.`;
                } catch (e) { flowsErr(e.message); }
                return;
            }
            try {
                const made = await request('/setup/export', flow ? { flow } : {});
                const a = h('a', { href: URL.createObjectURL(new Blob([made.text], { type: 'application/json' })), download: `${(made.name || 'setup').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'setup'}.clavarium.json` });
                document.body.append(a); a.click(); a.remove();
                $('flows-said').textContent = `Exported: ${made.name}. Names of secrets only, no key, no password, no file.`;
            } catch (e) { flowsErr(e.message); }
        }

        /* A file to a setup: read on the server, shown whole, made only when asked. */
        let importing = null;        /* { text, file, choices } */
        async function previewFile() {
            const box = $('flows-preview');
            let plan;
            try { plan = await request('/setup/preview', { text: importing.text, choices: importing.choices }); }
            catch (e) { box.replaceChildren(h('p', { class: 'error', role: 'alert', text: `${importing.file}: ${e.message}` }), h('div', { class: 'lk-row' }, h('button', { type: 'button', text: 'Close', onclick: () => { box.hidden = true; } }))); box.hidden = false; return; }
            const set = (fn) => { fn(importing.choices); void previewFile(); };
            const parts = [h('h3', {}, `Import ${importing.file}`, h('small', { text: [plan.name, plan.madeWith, plan.format === 1 ? 'a setup of the site (format 1)' : ''].filter(Boolean).join(' - ') })),
                h('p', { class: 'lk-said', text: plan.said }),
                checklist(plan)];
            /* What will act by itself, from somebody else's words: always in sight, in full, as text. */
            const texts = plan.items.filter((i) => i.status !== 'refused').flatMap((i) => (i.texts ?? []).map((t) => [i, t]));
            if (texts.length) parts.push(h('h4', {}, h('span', { class: 'lk-own', text: 'Runs on its own' }), ' read it whole'),
                h('ul', { class: 'lk-plan lk-texts' }, texts.map(([i, t]) => h('li', {}, h('b', { text: i.as ?? i.name }), h('div', { class: 'lk-text' }, h('small', { text: t.label }), h('pre', { text: t.text || '(empty)' }))))));
            const asks = plan.links.filter((l) => l.confirm);
            for (const l of asks) {
                const box = h('input', { type: 'checkbox' }); box.checked = l.confirmed === true;
                box.addEventListener('change', () => set((c) => { c.confirm = c.confirm ?? {}; c.confirm[`${l.from}|${l.to}`] = box.checked; }));
                parts.push(h('label', { class: 'check lk-confirm' }, box, ` ${l.fromName} \u2192 ${l.toName}: ${l.confirm}`));
            }
            const more = h('details', { class: 'lk-more', open: !plan.ready || undefined }, h('summary', { text: `Every item and link (${plan.items.length + plan.links.length})` }));
            if (plan.flows.length > 1) {
                const pick = h('select', { 'aria-label': 'What to import', id: 'flows-preview-flow' }, h('option', { value: '', text: `All of it (${plan.flows.length} flows)` }), plan.flows.map((f) => h('option', { value: String(f.index), text: `Only the flow ${f.name} (${f.size})` })));
                pick.value = plan.flow === null ? '' : String(plan.flow);
                pick.addEventListener('change', () => set((c) => { if (pick.value === '') delete c.flow; else c.flow = Number(pick.value); }));
                parts.push(h('label', { class: 'lk-row' }, 'Import ', pick));
            }
            const linkList = h('ul', { class: 'lk-plan' });
            const here = new Set(plan.items.filter((i) => i.status === 'exists').map((i) => i.id));
            for (const l of plan.links) {
                linkList.append(h('li', { 'data-status': l.status }, h('b', { text: l.fromName ?? l.from }), ` \u2192 ${l.gives} \u2192 `, h('b', { text: l.toName ?? l.to }),
                    l.status === 'new' && here.has(l.from) ? h('span', { class: 'lk-shared', text: 'new access' }) : null, l.status !== 'new' ? h('small', { text: ` - ${l.why ?? l.status}` }) : null));
            }
            if (plan.links.length) more.append(h('h4', { text: `Links (${plan.links.length})` }), linkList);
            const groups = [['new', 'To make'], ['exists', 'Already here'], ['missing', 'Missing: add them yourself'], ['to connect', 'To connect: add them yourself'], ['to pair', 'To pair once imported'], ['refused', 'Refused']];
            for (const [status, title] of groups) {
                const these = plan.items.filter((i) => i.status === status);
                if (!these.length) continue;
                more.append(h('h4', { text: `${title} (${these.length})` }));
                const list = h('ul', { class: 'lk-plan', 'data-status': status });
                for (const i of these) {
                    const li = h('li', { 'data-id': i.id }, h('span', { class: `lk-tag lk-c-${COLUMN[i.kind]}`, text: KIND_WORD[i.kind] }), h('b', { text: i.as ?? i.name }), i.was ? h('small', { text: ` (in the file: ${i.was})` }) : null, i.sub ? h('small', { text: ` - ${i.sub}` }) : null);
                    if (i.why) li.append(h('p', { class: i.status === 'refused' || i.blocked ? 'error' : 'lk-via', text: i.why }));
                    for (const n of i.notes ?? []) li.append(h('p', { class: 'lk-via', text: n }));
                    if (i.choices?.length > 1) {
                        const pick = h('select', { 'aria-label': `What to do with ${i.name}` }, i.choices.map((c) => h('option', { value: c, text: { keep: 'Keep the one here', rename: 'Make it under another name', replace: 'Replace its settings' }[c] })));
                        pick.value = i.act; pick.addEventListener('change', () => set((c) => { c.items = c.items ?? {}; c.items[i.id] = { do: pick.value, as: pick.value === 'rename' ? `${i.name}-2`.slice(0, i.kind === 'device' ? 40 : 32) : undefined }; }));
                        li.append(h('span', { class: 'lk-row' }, pick));
                        if (i.act === 'rename') {
                            const field = h('input', { value: i.as ?? '', 'aria-label': `New name for ${i.name}`, spellcheck: 'false', autocapitalize: 'none' });
                            field.addEventListener('keydown', (ev) => ev.stopPropagation());
                            field.addEventListener('change', () => set((c) => { c.items[i.id] = { do: 'rename', as: field.value.trim() }; }));
                            li.lastChild.append(field);
                        }
                    }
                    if (i.status === 'refused') for (const t of i.texts ?? []) li.append(h('div', { class: 'lk-text' }, h('small', { text: t.label }), h('pre', { text: t.text || '(empty)' })));
                    list.append(li);
                }
                more.append(list);
            }
            parts.push(more);
            const cuts = plan.shortcuts.filter((x) => x.status !== 'same');
            if (cuts.length) more.append(h('h4', { text: `Shortcuts (${cuts.length})` }), h('ul', { class: 'lk-plan' }, cuts.map((x) => h('li', {}, h('b', { text: x.label }), x.status === 'exists' ? h('small', { text: ' - one of this label is here: kept' }) : null, x.why ? h('p', { class: 'error', text: x.why }) : null, h('pre', { text: x.text })))));
            if (plan.notes.length) more.append(h('h4', { text: 'Not made here' }), h('ul', { class: 'lk-plan' }, plan.notes.map((n) => h('li', { text: n }))));
            const go = h('button', { type: 'button', class: 'primary', id: 'flows-import-go', text: 'Make it', disabled: !plan.ready || undefined });
            go.addEventListener('click', () => { void runImport(); });
            parts.push(h('div', { class: 'lk-row lk-sticky' }, go, h('button', { type: 'button', text: 'Cancel', onclick: () => { importing = null; box.hidden = true; } }), plan.ready ? null : h('span', { class: 'error', text: 'Choose another name where it says so.' })));
            box.replaceChildren(...parts); box.hidden = false;
        }
        /* The preview in three lines: what is made, what is needed, what is refused. */
        function checklist(plan) {
            const names = (f) => plan.items.filter(f).map((i) => i.as ?? i.name);
            const lines = [['Will make', names((i) => i.status === 'new' || (i.status === 'exists' && i.act === 'rename'))], ['Needs you', names((i) => ['missing', 'to connect', 'to pair'].includes(i.status))], ['Refused', names((i) => i.status === 'refused')]];
            return h('ul', { class: 'lk-check' }, lines.filter(([, l]) => l.length).map(([w, l]) => h('li', { 'data-line': w }, h('b', { text: `${w}: ` }), l.join(', '))));
        }
        async function runImport() {
            const box = $('flows-preview');
            try { await request('/setup/import', { text: importing.text, choices: importing.choices, ...(importing.bundle ? { bundle: importing.bundle } : {}) }); } catch (e) { flowsErr(e.message); return; }
            const steps = h('ol', { class: 'lk-job', id: 'flows-job' });
            box.replaceChildren(h('h3', { text: `Importing ${importing.file}` }), h('p', { class: 'hint', text: 'Machines are built one at a time: a few minutes each. This can be closed; it goes on.' }), steps);
            importing = null;
            for (;;) {
                const job = await (await fetch(`${env.API()}/setup/import`)).json().catch(() => null);
                if (!job) break;
                steps.replaceChildren(...job.steps.map((x) => h('li', { 'data-state': x.state }, h('span', { text: x.text }), x.why ? h('small', { text: ` - ${x.why}` }) : null)));
                if (job.done) {
                    const m = job.plan.missing;
                    box.prepend(h('p', { class: 'lk-said', role: 'status', text: `Imported${job.failed ? `, ${job.failed} step(s) failed` : ''}.${m.secrets.length ? ` Missing secrets: ${m.secrets.join(', ')}.` : ''}${m.connect.length ? ` To connect: ${m.connect.join(', ')}.` : ''}${m.pair.length ? ` To pair: ${m.pair.join(', ')}.` : ''} They are drawn dashed below.` }));
                    box.append(h('div', { class: 'lk-row' }, h('button', { type: 'button', text: 'Close', onclick: () => { box.hidden = true; } })));
                    await load(); await env.refresh(); traceOf = '*'; paintFlows();
                    break;
                }
                await new Promise((r) => setTimeout(r, 1000));
            }
        }

        /* ---------- shown in Access (app.js): the map, or its flows ---------- */
        function showPane(id) {
            closePop(); closeSheet();
            for (const x of ['links', 'flows']) $(x).hidden = x !== id;
            env.modeIs(id === 'flows' ? 'flows' : 'map');
        }
        /* Leaving is the page's: Access closes as a whole. */
        function close() { closePop(); closeSheet(); env.leave(); }
        /* `pin`: a box shown alone at once (Access opened from a conversation). */
        async function open({ pin = null } = {}) {
            err(''); picked = null; ph.screen = 'list';
            showPane('links');
            await load();
            pinned = pin && byId.has(pin) ? pin : null;
            if (pinned && phone()) { ph.kind = COLUMN[node(pinned).kind]; ph.sheet = pinned; }
            paint();
            if (document.fonts?.ready) document.fonts.ready.then(() => draw());
        }
        async function openFlows(of) {
            flowsErr('');
            showPane('flows');
            await load();
            traceOf = of ?? '*';
            paintFlows();
        }
        for (const b of document.querySelectorAll('#links-tabs [data-view]')) b.addEventListener('click', () => { view = b.dataset.view; picked = null; pinned = null; try { localStorage.setItem('clavarium-links-view', view); } catch { /* not kept */ } paint(); });
        $('links-all').addEventListener('change', () => { allLines = $('links-all').checked; try { localStorage.setItem('clavarium-links-all', allLines ? '1' : '0'); } catch { /* not kept */ } draw(); });
        $('flows-of').addEventListener('change', (e) => { traceOf = e.target.value; paintFlows(); });
        $('flows-export').addEventListener('click', () => { void exportFile(); });
        $('flows-import').addEventListener('click', () => { $('flows-file').click(); });
        $('flows-file').addEventListener('change', async () => {
            const file = $('flows-file').files?.[0]; $('flows-file').value = '';
            if (!file) return;
            flowsErr('');
            /* Imported from any tab: what it holds is shown in Flows. */
            await env.toFlows();
            /* A flow with its files: sent whole first, checked there; what it holds is shown as for a setup. */
            if (/\.tar\.gz$|\.tgz$/i.test(file.name)) {
                $('flows-said').textContent = `Sending ${file.name}...`;
                try {
                    const r = await fetch(`${env.API()}/setup/bundle`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
                    const got = await r.json().catch(() => ({}));
                    if (!r.ok) throw new Error(got.error ?? `It could not be sent (${r.status}).`);
                    const files = got.folders.reduce((a, x) => a + x.files, 0);
                    importing = { text: got.text, file: file.name, choices: {}, bundle: got.id };
                    $('flows-said').textContent = `${file.name}: ${files} file${files === 1 ? '' : 's'} for ${got.folders.length} folder${got.folders.length === 1 ? '' : 's'}. A folder made new gets its files; one already here keeps its own.`;
                } catch (e) { $('flows-said').textContent = ''; flowsErr(e.message); return; }
                await previewFile();
                $('flows-preview').scrollIntoView({ block: 'start' });
                return;
            }
            if (file.size > 512 * 1024) { flowsErr(`${file.name} is too large: a setup is at most 512 KB.`); return; }
            importing = { text: await file.text(), file: file.name, choices: {} };
            await previewFile();
            $('flows-preview').scrollIntoView({ block: 'start' });
        });
        $('links').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (ph.sheet) closeSheet(); else if (pop) { closePop(); draw(); } else if (pinned) { pinned = null; picked = null; draw(); hint(); } else close(); } });
        /* A click away from it closes the knob's card (a button it just replaced is not "away"). */
        document.addEventListener('click', (e) => { if (pop && e.target.isConnected && !e.target.closest('.lk-pop, .lk-knob, .lk-node, svg')) { closePop(); draw(); } });
        addEventListener('resize', () => { if (shownNow()) { legend(); paintPhone(); fit(); draw(); place(); } });
        $('links-scroller').addEventListener('scroll', () => draw(), { passive: true });
        return { open, openFlows, close, changed };
    };
})();
