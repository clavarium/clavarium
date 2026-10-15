/* WHO GETS WHAT, AND FLOWS: two sheets of the owner's page.
 *
 *   Who gets what   devices, conversations and assets in columns that each
 *                   scroll on their own; a link is a right, coloured by what
 *                   it gives. At rest no line, a count on each box; a box
 *                   touched shows its links, greys the rest, and says them in
 *                   words. A link is made by dragging from a dot (or a box
 *                   touched, then another), changed by the knob on it, taken
 *                   away there: with the very requests and confirmations of
 *                   the per-conversation, per-device and per-asset screens.
 *                   On a phone: a list, then one box and its links as rows.
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
    const KIND_ICON = { device: '▭', conversation: '>_', folder: '▤', git: '⑂', mailbox: '✉', secret: '⚿' };
    const KIND_WORD = { device: 'device', conversation: 'conversation', folder: 'folder', git: 'repository', mailbox: 'mailbox', secret: 'secret' };
    const COLUMN = { device: 'device', conversation: 'conversation', folder: 'asset', git: 'asset', mailbox: 'asset', secret: 'asset' };
    const TITLES = { device: 'Devices', conversation: 'Conversations', asset: 'Assets' };
    const VIEWS = {
        devices: { cols: [['device'], ['conversation', 'asset']], sources: ['device'] },
        convs: { cols: [['conversation'], ['asset']], sources: ['conversation'] },
        all: { cols: [['device'], ['conversation'], ['asset']], sources: ['device', 'conversation'] },
    };
    const WORDS = { term: 'Terminal', chat: 'Chat', both: 'Terminal + chat', read: 'Read', write: 'Read and write', use: 'Use' };
    const ALL_KINDS = ['term', 'chat', 'both', 'read', 'write', 'use'];

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
    const markers = (prefix) => { const d = s('defs'); for (const k of ALL_KINDS) { const m = s('marker', { id: `${prefix}-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' }); const p = s('path', { d: 'M0 0 10 5 0 10z' }); p.style.fill = css(k); m.append(p); d.append(m); } return d; };
    const phone = () => matchMedia('(max-width: 600px)').matches;

    window.clavariumLinks = (env) => {
        const $ = (id) => document.getElementById(id);
        let graph = { nodes: [], links: [], flows: [] };
        let byId = new Map();
        let view = matchMedia('(min-width: 900px)').matches ? 'all' : 'devices';
        try { const v = localStorage.getItem('clavarium-links-view'); if (VIEWS[v]) view = v; } catch { /* none kept */ }
        let allLines = false;
        try { allLines = localStorage.getItem('clavarium-links-all') === '1'; } catch { /* none kept */ }
        let picked = null; let pinned = null; let focus = null; let drag = null; let pop = null; let popLink = null;
        const ph = { screen: 'list', kind: 'device', id: null, adding: false };
        let traceOf = '*';
        let returnView = null;

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
        function legend() {
            const box = $('links-legend'); box.replaceChildren();
            const parts = [];
            if (VIEWS[view].sources.includes('device')) parts.push('term', 'chat', 'both');
            parts.push('read', 'write'); if (VIEWS[view].sources.includes('conversation')) parts.push('use');
            const used = new Set(graph.links.filter(shown).map(KIND));
            for (const k of parts.filter((x) => used.has(x))) box.append(h('span', { class: `lk-key`, style: `color:${css(k)}` }, h('i'), h('span', { class: 'lk-key-w', text: WORDS[k] })));
            if (VIEWS[view].sources.includes('device')) box.append(h('span', { class: 'lk-key lk-dim' }, h('i', { class: 'dash' }), h('span', { class: 'lk-key-w', text: 'a device to an asset' })));
            if (graph.nodes.some((n) => n.pending)) box.append(h('span', { class: 'lk-key lk-dim' }, h('b', { class: 'lk-pending-key' }), h('span', { class: 'lk-key-w', text: 'dashed: to pair, or to add' })));
        }
        /* Boxes in the order that crosses least: each under the average place of what links to it. */
        function ordered(col) {
            const base = graph.nodes.filter((n) => COLUMN[n.kind] === col).sort((a, b) => (a.kind === b.kind ? 0 : ['folder', 'git', 'mailbox', 'secret'].indexOf(a.kind) - ['folder', 'git', 'mailbox', 'secret'].indexOf(b.kind)) || a.name.localeCompare(b.name));
            if (col === 'device') return base;
            const before = col === 'conversation' ? ordered('device') : [...ordered('conversation'), ...ordered('device')];
            const pos = new Map(before.map((n, i) => [n.id, i]));
            const score = (n) => { const r = graph.links.filter((l) => l.to === n.id && pos.has(l.from) && VIEWS[view].sources.includes(node(l.from).kind)).map((l) => pos.get(l.from)); return r.length ? r.reduce((x, y) => x + y, 0) / r.length : Infinity; };
            return base.map((n, i) => ({ n, sc: score(n), i })).sort((x, y) => (x.sc - y.sc) || (x.i - y.i)).map((x) => x.n);
        }
        function paint() {
            for (const b of document.querySelectorAll('#links-tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
            $('links-all').checked = allLines;
            legend();
            const bd = board();
            bd.className = `lk-board ${VIEWS[view].cols.length === 3 ? 'three' : 'two'}`;
            bd.querySelectorAll('.lk-col, .lk-knob, .lk-pop, .lk-edge').forEach((e) => e.remove()); pop = null; popLink = null;
            for (const cols of VIEWS[view].cols) {
                const col = h('div', { class: 'lk-col' });
                cols.forEach((k, i) => {
                    if (i) col.append(h('div', { class: 'lk-gap' }));
                    col.append(h('h3', { text: TITLES[k] }));
                    const list = ordered(k);
                    for (const n of list) col.append(nodeEl(n));
                    if (!list.length) col.append(h('p', { class: 'hint lk-none', text: k === 'device' ? 'No device paired yet.' : k === 'conversation' ? 'No conversation yet.' : 'Nothing kept here yet.' }));
                });
                col.addEventListener('scroll', () => { place(); draw(); }, { passive: true });
                bd.append(col);
            }
            draw(); hint(); paintPhone();
        }
        function nodeEl(n) {
            const cnt = graph.links.filter((l) => (l.from === n.id || l.to === n.id) && shown(l)).length;
            const e = h('div', { class: `lk-node lk-c-${COLUMN[n.kind]}${n.pending ? ' pending' : ''}`, 'data-id': n.id, 'data-kind': n.kind, tabindex: 0, role: 'button', 'aria-label': `${n.name}, ${n.sub}, ${cnt} link${cnt === 1 ? '' : 's'}` },
                h('span', { class: 'lk-ic', text: KIND_ICON[n.kind], 'aria-hidden': 'true' }),
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
            const top = c.top + 34; const bottom = c.bottom - 6;
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
        function draw() {
            const bd = board(); const svg = $('links-svg');
            if ($('links').hidden || phone()) return;
            const rel = (pinned || focus) ? related(pinned || focus) : null;
            bd.classList.toggle('simple', !allLines && !drag);
            const b = bd.getBoundingClientRect();
            svg.setAttribute('viewBox', `0 0 ${b.width} ${b.height}`);
            svg.replaceChildren(markers('lkm'));
            bd.querySelectorAll('.lk-knob, .lk-edge').forEach((c) => c.remove());
            const edges = new Map();
            for (const l of graph.links.filter(shown)) {
                if (!el(l.from) || !el(l.to)) continue;
                const a = anchor(l.from, 'out'); const z = anchor(l.to, 'in'); const k = KIND(l);
                const off = rel && !(rel.has(l.from) && rel.has(l.to));
                const away = a.away || z.away;
                for (const [p, end] of [[a, l.from], [z, l.to]]) if (p.away && !off) { const e = edges.get(p.col) ?? { up: [], down: [] }; (p.away < 0 ? e.up : e.down).push(end); edges.set(p.col, e); }
                const d = curve(a, z);
                const p = s('path', { d, class: [node(l.from).kind === 'device' && COLUMN[node(l.to).kind] === 'asset' ? 'dash' : '', away ? 'away' : '', off ? 'dim' : '', rel && !off ? 'on' : '', l.pending ? 'later' : ''].join(' '), 'data-from': l.from, 'data-to': l.to, 'data-kind': k });
                p.style.stroke = css(k);
                if (!away) p.setAttribute('marker-end', `url(#lkm-${k})`);
                svg.append(p);
                if (away) continue;
                const hit = s('path', { d, class: 'hit' }); hit.addEventListener('click', () => openPop(l)); svg.append(hit);
                /* The knob sits at two thirds of the way, near the target: never over the dot it was drawn from. */
                const at = p.getPointAtLength(p.getTotalLength() * 0.68);
                const kb = h('button', { type: 'button', class: `lk-knob${off ? ' dim' : ''}${rel && !off ? ' on' : ''}`, style: `background:${css(k)};left:${at.x}px;top:${at.y}px`, title: `${node(l.from).name} → ${node(l.to).name}: ${said(l)}`, 'aria-label': `${node(l.from).name} to ${node(l.to).name}: ${said(l)}. Change.`, 'data-from': l.from, 'data-to': l.to });
                kb.addEventListener('click', () => openPop(l));
                bd.append(kb);
            }
            /* Links to boxes scrolled away: a pill at the column's edge says how many, and brings the first into sight. */
            for (const [col, e] of edges) {
                const c = col.getBoundingClientRect();
                for (const [dir, ids] of [['up', e.up], ['down', e.down]]) {
                    if (!ids.length) continue;
                    const pill = h('button', { type: 'button', class: 'lk-edge', text: `${dir === 'up' ? '↑' : '↓'} ${new Set(ids).size} linked`, style: `left:${c.left - b.left + c.width / 2}px;top:${dir === 'up' ? c.top - b.top + 32 : c.bottom - b.top - 30}px` });
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
        }

        /* A tap shows only what concerns that box; tapped again, everything comes back.
           A box that gives is also ready to be linked: tap a dashed box to link it. */
        function tap(n) {
            if (picked && picked.id !== n.id && allowed(picked, n)) { void link(picked, n); return; }
            const again = pinned === n.id;
            pinned = again ? null : n.id;
            picked = !again && VIEWS[view].sources.includes(n.kind) && !n.pending ? n : null;
            closePop(); draw(); hint();
        }
        function hint() {
            card();
            $('links-hint').textContent = !pinned ? 'Tap a box to see its links. The number on a box is how many it has.' : picked ? 'Tap a box outlined in dashes to link it.' : '';
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
            if (!pinned || !node(pinned)) { c.hidden = true; return; }
            const n = node(pinned);
            const items = wordsFor(n);
            const actions = h('span', { class: 'lk-card-actions' });
            if (n.pending === 'pair') actions.append(h('button', { type: 'button', class: 'primary', text: 'Pair it...', onclick: () => { void pairIt(n); } }));
            if (n.pending === 'missing' || n.pending === 'connect') actions.append(h('button', { type: 'button', class: 'primary', text: n.pending === 'missing' ? 'Add its value...' : 'Add it...', onclick: () => { close(); env.openAssets(); } }));
            if (n.pending) actions.append(h('button', { type: 'button', text: 'Forget it', onclick: () => { void forget(n); } }));
            actions.append(h('button', { type: 'button', id: 'links-trace-it', text: 'Trace it', onclick: () => { void openFlows(n.id); } }),
                h('button', { type: 'button', text: 'See everything', onclick: () => { pinned = null; picked = null; draw(); hint(); } }));
            c.replaceChildren(h('h3', {}, h('span', { text: n.name }), h('small', { text: n.sub }), actions),
                items.length ? h('ul', {}, items.map((i) => h('li', {}, i))) : h('p', { class: 'lk-none', text: 'No link yet.' }));
            c.hidden = false;
        }
        async function pairIt(n) {
            try { const what = await request('/setup/pair', { label: n.name }); close(); await env.pairNew(what.grants, what.label); }
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
                const question = a.kind === 'device' ? `Take ${b.name} back from ${a.name}${last ? ': it has nothing else, so the device is removed' : ''}` : b.kind === 'secret' ? `Stop handing ${b.name} to ${a.name}` : `Detach ${b.name} from ${a.name}`;
                const sure = h('button', { type: 'button', class: 'danger', text: question });
                const keep = h('button', { type: 'button', text: 'Keep', onclick: () => openPop(l) });
                sure.addEventListener('click', async () => {
                    sure.disabled = true;
                    try { await takeAway(l); closePop(); await changed(); if (b.kind === 'secret') err(`${b.name} will no longer be handed to ${a.name}'s tool the next time it starts.`); } catch (e) { fail(e); }
                });
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

        /* ---------- on a phone: a list, then one box and its links as rows ---------- */
        const PHONE_KINDS = [['device', 'Devices'], ['conversation', 'Conversations'], ['asset', 'Assets']];
        function paintPhone() {
            const box = $('links-phone');
            if (!phone()) { box.replaceChildren(); return; }
            if (ph.screen === 'one' && !node(ph.id)) ph.screen = 'list';
            if (ph.screen === 'list') {
                const kinds = h('div', { class: 'lk-kinds' }, PHONE_KINDS.map(([k, w]) => h('button', { type: 'button', 'aria-pressed': String(k === ph.kind), text: w, onclick: () => { ph.kind = k; paintPhone(); } })));
                const list = h('ul', { class: 'lk-plist' });
                for (const n of graph.nodes.filter((x) => COLUMN[x.kind] === ph.kind).sort((a, b) => a.name.localeCompare(b.name))) {
                    const ls = graph.links.filter((l) => l.from === n.id || l.to === n.id);
                    list.append(h('li', {}, h('button', { type: 'button', class: `lk-item${n.pending ? ' pending' : ''}`, 'data-id': n.id, onclick: () => { ph.screen = 'one'; ph.id = n.id; ph.adding = false; paintPhone(); $('links').scrollTop = 0; } },
                        h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: n.name }), h('span', { class: 'lk-sb', text: `${n.sub} - ${ls.length} link${ls.length === 1 ? '' : 's'}` })),
                        h('span', { class: 'lk-dots' }, ls.slice(0, 6).map((l) => h('i', { style: `background:${css(KIND(l))}` }))), h('span', { class: 'lk-chev', text: '›' }))));
                }
                if (!list.children.length) list.append(h('li', { class: 'lk-none', text: 'Nothing here yet.' }));
                box.replaceChildren(kinds, list);
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
            if (n.pending === 'missing' || n.pending === 'connect') actions.prepend(h('button', { type: 'button', class: 'primary', text: 'Add it...', onclick: () => { close(); env.openAssets(); } }));
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
                            h('span', { class: 'lk-tx' }, h('span', { class: 'lk-nm', text: t.name }), h('span', { class: 'lk-sb', text: t.sub })), h('span', { class: 'lk-chev', text: '+' }))))));
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
        function drawEdges(boardEl, svgEl, list, keyOf, prefix) {
            requestAnimationFrame(() => {
                const r = boardEl.getBoundingClientRect();
                svgEl.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
                svgEl.replaceChildren(markers(prefix));
                for (const [ka, kz, k, pending] of list) {
                    const a = boardEl.querySelector(`[data-key="${CSS.escape(ka)}"]`)?.getBoundingClientRect(); const z = boardEl.querySelector(`[data-key="${CSS.escape(kz)}"]`)?.getBoundingClientRect();
                    if (!a || !z) continue;
                    const p = s('path', { d: curve({ x: a.right - r.left, y: a.top + a.height / 2 - r.top }, { x: z.left - r.left, y: z.top + z.height / 2 - r.top }), 'marker-end': `url(#${prefix}-${k})`, class: pending ? 'later' : '' });
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
            drawEdges(tb, sv, list, null, 'lkt');
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
                drawEdges(tb, sv, list, null, `lki${gi}`);
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

        /* A setup to a file: the configuration, never the data. */
        async function exportFile(flow) {
            flowsErr('');
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
            try { await request('/setup/import', { text: importing.text, choices: importing.choices }); } catch (e) { flowsErr(e.message); return; }
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

        /* ---------- opening and closing ---------- */
        function showSheet(id) {
            env.hideSheets();
            for (const x of ['links', 'flows']) $(x).hidden = x !== id;
            /* On a phone the list and the room are two screens: the sheet lives in the room. */
            if (returnView === null) { returnView = document.getElementById('app').dataset.view ?? ''; document.getElementById('app').dataset.view = 'room'; }
        }
        function close() {
            closePop();
            $('links').hidden = true; $('flows').hidden = true;
            if (returnView !== null) { document.getElementById('app').dataset.view = returnView; returnView = null; }
            env.focusTerminal();
        }
        async function open() {
            err(''); pinned = null; picked = null; ph.screen = 'list';
            showSheet('links');
            await load(); paint();
            if (document.fonts?.ready) document.fonts.ready.then(() => draw());
        }
        async function openFlows(of) {
            flowsErr(''); $('flows-said').textContent = '';
            closePop();
            showSheet('flows');
            await load();
            traceOf = of ?? '*';
            paintFlows();
        }
        for (const b of document.querySelectorAll('#links-tabs [data-view]')) b.addEventListener('click', () => { view = b.dataset.view; picked = null; pinned = null; try { localStorage.setItem('clavarium-links-view', view); } catch { /* not kept */ } paint(); });
        $('links-all').addEventListener('change', () => { allLines = $('links-all').checked; try { localStorage.setItem('clavarium-links-all', allLines ? '1' : '0'); } catch { /* not kept */ } draw(); });
        $('links-close').addEventListener('click', close);
        $('links-flows').addEventListener('click', () => { void openFlows(); });
        $('flows-close').addEventListener('click', close);
        $('flows-back').addEventListener('click', () => { void open(); });
        $('flows-of').addEventListener('change', (e) => { traceOf = e.target.value; paintFlows(); });
        $('flows-export').addEventListener('click', () => { void exportFile(); });
        $('flows-import').addEventListener('click', () => { $('flows-file').click(); });
        $('flows-file').addEventListener('change', async () => {
            const file = $('flows-file').files?.[0]; $('flows-file').value = '';
            if (!file) return;
            flowsErr('');
            if (file.size > 512 * 1024) { flowsErr(`${file.name} is too large: a setup is at most 512 KB.`); return; }
            importing = { text: await file.text(), file: file.name, choices: {} };
            await previewFile();
            $('flows-preview').scrollIntoView({ block: 'start' });
        });
        $('links').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (pop) { closePop(); draw(); } else if (pinned) { pinned = null; picked = null; draw(); hint(); } else close(); } });
        /* A click away from it closes the knob's card (a button it just replaced is not "away"). */
        document.addEventListener('click', (e) => { if (pop && e.target.isConnected && !e.target.closest('.lk-pop, .lk-knob, .lk-node, svg')) { closePop(); draw(); } });
        addEventListener('resize', () => { if (!$('links').hidden) { paintPhone(); draw(); place(); } });
        $('links-scroller').addEventListener('scroll', () => draw(), { passive: true });
        return { open, openFlows, close };
    };
})();
