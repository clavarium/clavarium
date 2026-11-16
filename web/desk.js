/* THE DESK ("Bureau", 16-11, mockup bureau-2): the home page as a grid of icons that snap to cells.
 *
 * One desk per person, kept by the server (GET/PUT /api/desktop, server/desktop.mjs), the same on every
 * screen. The grid takes as many columns as the screen allows; a thing whose cell does not fit is shown
 * in the first free cell, at display time only: its place is kept, and it is back when the screen widens.
 *
 *   - free placement in any cell; « Tidy » packs them to the top left, in their reading order
 *   - edit mode: a long press, or « Edit »; free cells dotted; dropped on a taken cell, the one there
 *     goes to the first free cell; dropped on the middle of another, a folder (or into that folder)
 *   - « ⋯ » on each: its size (icon, wide, large), moves by one cell, out of its folder, off the desk;
 *     the same from the keyboard (arrows move, Enter opens the menu): never only by dragging
 *   - folders of the desk are the desk's own: the list's groups never change
 *
 * It draws no card of its own: each thing is drawn by app.js with the kit (ConvCard, AssetCard), as
 * everywhere else. What it shows of a person's data is text nodes only.
 * Words: English here, others through the page's words (app.js uiSaid, server/settingswords.mjs). */
(() => {
    const W = (it, n) => Math.min(it.size === 'm' || it.size === 'l' ? 2 : 1, Math.max(1, n));
    const H = (it) => (it.size === 'l' ? 2 : 1);
    const overlap = (a, b) => a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;

    /* WHERE EACH ONE GOES on `n` columns: its own cell when it was put there and still fits (the last put
       wins a cell); else the first free one, in the desk's order. Pure: the items are not changed. */
    function layout(items, n) {
        const cols = Math.max(1, n | 0);
        const occ = new Set(); const k = (c, r) => `${c},${r}`;
        const fits = (c, r, w, h) => { if (c < 1 || r < 1 || c + w - 1 > cols) return false; for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) if (occ.has(k(c + i, r + j))) return false; return true; };
        const placed = items.filter((it) => it.c && it.r).sort((a, b) => (b.t || 0) - (a.t || 0) || a.r - b.r || a.c - b.c);
        const pos = new Map(); let rows = 0;
        for (const it of [...placed, ...items.filter((x) => !(x.c && x.r))]) {
            const w = W(it, cols); const h = H(it);
            let c = it.c ? Math.min(it.c, cols - w + 1) : 1; let r = it.r || 1;
            if (!(it.c && it.r && c === it.c && fits(c, r, w, h))) {
                search: for (r = 1; ; r++) for (c = 1; c <= cols - w + 1; c++) if (fits(c, r, w, h)) break search;
            }
            for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) occ.add(k(c + i, r + j));
            pos.set(it.id, { c, r, w, h }); rows = Math.max(rows, r + h - 1);
        }
        return { pos, rows, occ, cols };
    }

    /* PUT ONE ON A CELL: those it covers go to the first free cells; the others not placed yet keep the cell
       they are seen in (nothing else moves). `pos`: layout(items, n).pos as seen now. Changes `items`. */
    function moveTo(items, id, c, r, n, pos, now = Date.now()) {
        const it = items.find((x) => x.id === id); if (!it) return false;
        const w = W(it, n); const h = H(it);
        const at = { c: Math.max(1, Math.min(c, n - w + 1)), r: Math.max(1, r), w, h };
        for (const o of items) {
            if (o === it) continue;
            const p = pos.get(o.id); if (!p) continue;
            if (overlap(p, at)) { delete o.c; delete o.r; delete o.t; } else if (!(o.c && o.r)) { o.c = p.c; o.r = p.r; }
        }
        it.c = at.c; it.r = at.r; it.t = now;
        return true;
    }
    /* By one cell: ← → ↑ ↓ (dc, dr). */
    function moveBy(items, id, dc, dr, n, pos, now) {
        const p = pos.get(id); if (!p) return false;
        return moveTo(items, id, p.c + dc, Math.max(1, p.r + dr), n, pos, now);
    }
    /* TIDY: all packed to the top left, in the order they are read now. Returns the new order. */
    function tidy(items, pos) {
        const seen = (x) => pos.get(x.id) ?? { r: Infinity, c: Infinity };
        return [...items].sort((a, b) => seen(a).r - seen(b).r || seen(a).c - seen(b).c).map((x) => { const y = { ...x }; delete y.c; delete y.r; delete y.t; return y; });
    }
    /* Every id on the desk, those in folders too. */
    const idsOf = (items) => items.flatMap((x) => (x.folder !== undefined ? [x.id, ...x.items] : [x.id]));
    /* ONE DROPPED ON ANOTHER: into it if it is a folder; else both in a new folder at the other's place.
       A folder is never put in a folder. Returns the folder, or null. */
    function merge(items, dragId, ontoId, { id, name }) {
        const drag = items.find((x) => x.id === dragId); const onto = items.find((x) => x.id === ontoId);
        if (!drag || !onto || drag === onto || drag.folder !== undefined) return null;
        items.splice(items.indexOf(drag), 1);
        if (onto.folder !== undefined) { onto.items.push(drag.id); return onto; }
        const f = { id, folder: name, size: onto.size === 'l' ? 'm' : onto.size, items: [onto.id, drag.id] };
        if (onto.c && onto.r) { f.c = onto.c; f.r = onto.r; if (onto.t) f.t = onto.t; }
        items.splice(items.indexOf(onto), 1, f);
        return f;
    }
    /* A folder undone: its things back on the desk, as icons, in the first free cells. */
    function unfold(items, folderId) {
        const i = items.findIndex((x) => x.id === folderId);
        if (i < 0 || items[i].folder === undefined) return false;
        items.splice(i, 1, ...items[i].items.map((k) => ({ id: k, size: 's' })));
        return true;
    }
    /* Out of its folder, onto the desk; an emptied folder goes. */
    function takeOut(items, folderId, id) {
        const f = items.find((x) => x.id === folderId); if (!f || f.folder === undefined) return false;
        f.items = f.items.filter((k) => k !== id);
        items.push({ id, size: 's' });
        return true;
    }
    /* Off the desk (`folderId`: from that folder). Conversations and rooms taken off are said `gone`: a
       new one comes by itself, those do not. Returns the ids now gone. */
    function remove(items, id, folderId = '') {
        if (folderId) {
            const f = items.find((x) => x.id === folderId); if (!f) return [];
            f.items = f.items.filter((k) => k !== id);
            return /^[cr]:/.test(id) ? [id] : [];
        }
        const i = items.findIndex((x) => x.id === id); if (i < 0) return [];
        const [x] = items.splice(i, 1);
        return (x.folder !== undefined ? x.items : [x.id]).filter((k) => /^[cr]:/.test(k));
    }
    /* What the home cards show and the desk does not have yet (and was never taken off): added, in order.
       `wanted`: [{ id, size }]. Returns how many were added. */
    function addNew(items, gone, wanted) {
        const have = new Set(idsOf(items)); const off = new Set(gone);
        let added = 0;
        for (const w of wanted) if (!have.has(w.id) && !off.has(w.id)) { items.push({ id: w.id, size: w.size ?? 's' }); have.add(w.id); added++; }
        return added;
    }
    /* Emptied folders go (a last thing taken out, or removed from it). */
    const dropEmpty = (items) => items.filter((x) => x.folder === undefined || x.items.length > 0);

    /* ---------------- the page ---------------- */
    const el = (tag, cls = '', text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const button = (cls, text, label) => { const b = el('button', cls, text); b.type = 'button'; if (label) { b.setAttribute('aria-label', label); b.title = label; } return b; };

    /* `host`: where it is drawn. `o`:
         load()            -> { saved, items, gone }       save({ items, gone }) -> Promise (throws: not kept)
         has(id)           the thing exists (else not shown; its place is kept)
         name(id)          its name                         tile(id, size) -> its card (kit), not a button
         mini(id)          its small sign (an avatar)       waits(id) -> it waits for the person
         open(id)          opened                           wanted() -> [{ id, size }] the home cards, in order
         addable()         -> [{ title, items: [{ id, name, sign }] }]   create: [{ label, run }]
         word(key, en, vars)   the page's words
         toast(text)       said a moment */
    function Desk(host, o) {
        const toast = o.toast ?? ((text) => { const t = el('div', 'desk-toast', text); t.setAttribute('role', 'status'); document.body.append(t); setTimeout(() => t.remove(), 1800); });
        const w = (key, en, vars) => (o.word ? o.word(key, en, vars) : en.replace(/\{(\w+)\}/g, (a, k) => (vars && k in vars ? String(vars[k]) : a)));
        let items = []; let gone = []; let editing = false; let ready = false; let shownFolder = '';
        let cols = 0; let pos = new Map();
        const bar = el('div', 'desk-bar');
        const add = button('desk-add', w('desk-add', '+ Add'));
        const tidyB = button('desk-tidy', w('desk-tidy', 'Tidy'), w('desk-tidy-what', 'Pack to the top left')); tidyB.hidden = true;
        const edit = button('desk-edit', w('desk-edit', 'Edit')); edit.setAttribute('aria-pressed', 'false');
        bar.append(add, tidyB, edit);
        const grid = el('div', 'desk-grid'); grid.id = 'desk'; grid.setAttribute('role', 'list');
        const empty = el('p', 'desk-empty hint', w('desk-empty', 'Nothing on the desk yet: + Add')); empty.hidden = true;
        host.replaceChildren(bar, grid, empty);

        /* KEPT: a moment after the last change, the whole desk. */
        let saving = null;
        const save = () => {
            clearTimeout(saving);
            saving = setTimeout(async () => { try { await o.save({ items, gone }); } catch { toast(w('desk-not-saved', 'Desk not saved')); } }, 250);
        };
        const changed = () => { render(); save(); };

        /* HOW MANY COLUMNS fit: from the cell's size in the style sheet (--desk-cell), not from a grid drawn. */
        function measure() {
            const cs = getComputedStyle(grid);
            const gap = parseFloat(cs.columnGap) || 12;
            const cell = parseFloat(cs.getPropertyValue('--desk-cell')) || 104;
            const inner = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            return inner > 0 ? Math.max(1, Math.min(48, Math.floor((inner + gap) / (cell + gap)))) : 0;
        }
        function cellAt(x, y) {
            const cs = getComputedStyle(grid); const b = grid.getBoundingClientRect();
            const gap = parseFloat(cs.columnGap) || 12; const rowGap = parseFloat(cs.rowGap) || gap;
            const x0 = b.left + (parseFloat(cs.paddingLeft) || 0); const y0 = b.top + (parseFloat(cs.paddingTop) || 0);
            const inner = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            const cw = (inner - gap * (cols - 1)) / cols; const rh = parseFloat(cs.gridAutoRows) || cw;
            return { c: Math.max(1, Math.min(cols, Math.floor((x - x0) / (cw + gap)) + 1)), r: Math.max(1, Math.floor((y - y0) / (rh + rowGap)) + 1) };
        }
        const shown = () => items.filter((x) => (x.folder !== undefined ? true : o.has(x.id)));
        const find = (id) => items.find((x) => x.id === id);
        const kidsOf = (f) => f.items.filter((k) => o.has(k));

        function folderFace(f, size) {
            const kids = kidsOf(f);
            const box = el('div', 'desk-folder');
            const sign = el('span', 'desk-folder-ic'); sign.setAttribute('aria-hidden', 'true');
            for (const k of kids.slice(0, 4)) sign.append(o.mini(k));
            const head = el('span', 'desk-folder-head');
            const words = el('span', 'desk-folder-words');
            words.append(el('b', 'desk-folder-name', f.folder));
            if (size !== 's') words.append(el('small', 'when', w('desk-folder-n', '{n} items', { n: kids.length })));
            head.append(sign, words); box.append(head);
            if (size !== 's') {
                const mini = el('span', 'desk-folder-mini');
                for (const k of kids.slice(0, size === 'l' ? 9 : 6)) { const s = el('span', 'desk-folder-kid'); s.append(o.mini(k), el('em', '', o.name(k))); mini.append(s); }
                box.append(mini);
            }
            const waits = kids.filter((k) => o.waits?.(k)).length;
            if (waits) box.append(el('span', 'desk-badge', String(waits)));
            return box;
        }
        function tileOf(it, { inFolder = '' } = {}) {
            const size = inFolder ? 's' : it.size;
            const t = el('div', `desk-tile desk-${size}${it.folder !== undefined ? ' desk-is-folder' : ''}`);
            t.dataset.id = it.id; t.tabIndex = 0; t.setAttribute('role', 'listitem');
            const name = it.folder !== undefined ? it.folder : o.name(it.id);
            t.setAttribute('aria-label', it.folder !== undefined ? w('desk-folder-of', 'Folder {name}', { name }) : name);
            if (inFolder) t.dataset.folder = inFolder;
            const more = button('desk-more', '⋯', w('desk-options', 'Options'));
            t.append(more, it.folder !== undefined ? folderFace(it, size) : o.tile(it.id, size));
            return t;
        }

        function render() {
            if (!ready || drag) return;
            const n = measure(); if (!n) return;
            cols = n;
            grid.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
            grid.classList.toggle('desk-editing', editing);
            const list = shown();
            const lay = layout(list, n); pos = lay.pos;
            const nodes = [];
            if (editing) {
                for (let r = 1; r <= lay.rows + 2; r++) for (let c = 1; c <= n; c++) if (!lay.occ.has(`${c},${r}`)) {
                    const m = el('div', 'desk-cell'); m.style.gridColumn = String(c); m.style.gridRow = String(r); m.dataset.c = String(c); m.dataset.r = String(r); nodes.push(m);
                }
            }
            for (const it of list) {
                const p = pos.get(it.id); const t = tileOf(it);
                t.style.gridColumn = `${p.c} / span ${p.w}`; t.style.gridRow = `${p.r} / span ${p.h}`;
                t.dataset.c = String(p.c); t.dataset.r = String(p.r);
                nodes.push(t);
            }
            const had = document.activeElement?.closest?.('.desk-tile')?.dataset.id;
            grid.replaceChildren(...nodes);
            if (had) grid.querySelector(`.desk-tile[data-id="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
            empty.hidden = list.length > 0 || editing;
            tidyB.hidden = !editing;
            edit.textContent = editing ? w('desk-done', 'Done') : w('desk-edit', 'Edit');
            edit.setAttribute('aria-pressed', String(editing)); edit.classList.toggle('primary', editing);
            if (shownFolder) paintFolder();
        }
        const setEditing = (on) => { editing = on; closeMenu(); render(); };

        /* ---- the menu of one: its size, moves, out of its folder, off the desk ---- */
        let menu = null;
        function closeMenu() { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); }
        function outside(e) { if (menu && !menu.contains(e.target) && !e.target.closest?.('.desk-more')) closeMenu(); }
        function menuFor(id, anchor, inFolder = '') {
            closeMenu();
            const it = inFolder ? null : find(id);
            const m = el('div', 'desk-menu'); m.setAttribute('role', 'menu');
            const item = (text, act, label) => { const b = button('', text, label); b.setAttribute('role', 'menuitem'); b.dataset.act = act; return b; };
            if (it) {
                const sizes = el('div', 'desk-sizes'); sizes.setAttribute('role', 'group'); sizes.setAttribute('aria-label', w('desk-size', 'Size'));
                for (const [s, en] of [['s', 'Icon'], ['m', 'Wide'], ['l', 'Large']]) { const b = item(w(`desk-size-${s}`, en), `size-${s}`); b.setAttribute('aria-pressed', String(it.size === s)); sizes.append(b); }
                m.append(sizes);
                const arrows = el('div', 'desk-arrows');
                for (const [glyph, act, en] of [['←', 'left', 'Move left'], ['↑', 'up', 'Move up'], ['↓', 'down', 'Move down'], ['→', 'right', 'Move right']]) arrows.append(item(glyph, `mv-${act}`, w(`desk-mv-${act}`, en)));
                m.append(arrows);
            }
            if (it?.folder !== undefined) m.append(item(w('desk-folder-open', 'Open'), 'open'), item(w('desk-folder-undo', 'Undo the folder'), 'unfold'));
            if (inFolder) m.append(item(w('desk-folder-out', 'Take out of the folder'), 'out'));
            m.append(item(w('desk-remove', 'Remove from the desk'), 'remove'));
            document.body.append(m); menu = m;
            const a = anchor.getBoundingClientRect(); const r = m.getBoundingClientRect();
            m.style.left = `${Math.max(8, Math.min(a.left, innerWidth - r.width - 8))}px`;
            m.style.top = `${Math.max(8, Math.min(a.bottom + 4, innerHeight - r.height - 8))}px`;
            m.querySelector('button')?.focus();
            setTimeout(() => document.addEventListener('pointerdown', outside, true));
            m.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); anchor.closest('.desk-tile')?.focus(); }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    const all = [...m.querySelectorAll('button')]; const i = all.indexOf(document.activeElement);
                    e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
                }
            });
            m.addEventListener('click', (e) => {
                const b = e.target.closest('button[data-act]'); if (!b) return;
                const act = b.dataset.act;
                if (act.startsWith('size-')) { it.size = act.slice(5); changed(); menuFor(id, gridTile(id) ?? anchor); return; }
                if (act.startsWith('mv-')) {
                    const [dc, dr] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[act.slice(3)];
                    moveBy(items, id, dc, dr, cols, pos); changed(); menuFor(id, gridTile(id) ?? anchor); return;
                }
                closeMenu();
                if (act === 'open') { shownFolder = id; paintFolder(); return; }
                if (act === 'unfold') unfold(items, id);
                else if (act === 'out') { takeOut(items, inFolder, id); items = dropEmpty(items); }
                else if (act === 'remove') { const off = remove(items, id, inFolder); gone = [...new Set([...gone, ...off])]; if (inFolder) items = dropEmpty(items); }
                changed();
            });
        }
        const gridTile = (id) => grid.querySelector(`.desk-tile[data-id="${CSS.escape(id)}"]`);

        /* ---- a folder, opened over the desk ---- */
        let sheet = null;
        function closeFolder() { shownFolder = ''; sheet?.remove(); sheet = null; }
        function paintFolder() {
            const f = find(shownFolder);
            if (!f || f.folder === undefined) { closeFolder(); return; }
            const fresh = !sheet;
            if (fresh) {
                sheet = el('div', 'desk-sheet-bg');
                const box = el('div', 'desk-sheet'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
                const head = el('div', 'desk-sheet-head');
                const name = el('input', 'desk-folder-input'); name.maxLength = 60; name.setAttribute('aria-label', w('desk-folder-name', 'Folder name'));
                name.addEventListener('input', () => { const g = find(shownFolder); if (!g) return; g.folder = name.value.trim().replace(/[\u0000-\u001f\u007f]/g, '') || w('desk-folder-new', 'New folder'); box.setAttribute('aria-label', g.folder); render(); save(); });
                const close = button('desk-close', w('desk-close', 'Close'));
                close.addEventListener('click', () => { closeFolder(); gridTile(f.id)?.focus(); });
                head.append(name, close);
                const kids = el('div', 'desk-grid desk-in-folder'); kids.setAttribute('role', 'list');
                box.append(head, kids); sheet.append(box);
                sheet.addEventListener('click', (e) => { if (e.target === sheet) closeFolder(); });
                sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu) { e.stopPropagation(); closeFolder(); gridTile(f.id)?.focus(); } });
                kidsHandlers(kids);
                document.body.append(sheet);
                name.value = f.folder;
            }
            const box = sheet.querySelector('.desk-sheet'); box.setAttribute('aria-label', f.folder);
            const kids = sheet.querySelector('.desk-in-folder');
            kids.classList.toggle('desk-editing', editing);
            kids.replaceChildren(...kidsOf(f).map((k) => tileOf({ id: k, size: 's' }, { inFolder: f.id })));
            if (fresh) (kids.querySelector('.desk-tile') ?? sheet.querySelector('input'))?.focus();
        }
        function kidsHandlers(kids) {
            kids.addEventListener('click', (e) => {
                const t = e.target.closest('.desk-tile'); if (!t) return;
                if (e.target.closest('.desk-more')) { menuFor(t.dataset.id, e.target.closest('.desk-more'), t.dataset.folder); return; }
                if (!editing) { closeFolder(); o.open(t.dataset.id); }
            });
            kids.addEventListener('keydown', (e) => {
                const t = e.target.closest('.desk-tile'); if (!t || e.target !== t) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (editing) menuFor(t.dataset.id, t, t.dataset.folder); else { closeFolder(); o.open(t.dataset.id); } }
            });
        }

        /* ---- adding: what is not on the desk yet ---- */
        function openAdd() {
            const bg = el('div', 'desk-sheet-bg');
            const box = el('div', 'desk-sheet'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', w('desk-add-title', 'Add to the desk'));
            const head = el('div', 'desk-sheet-head'); head.append(el('h2', '', w('desk-add-title', 'Add to the desk')));
            const close = button('desk-close', w('desk-close', 'Close')); head.append(close);
            const pick = el('div', 'desk-pick');
            const on = new Set(idsOf(items));
            const row = (x, run) => { const b = button('desk-pick-row'); b.dataset.id = x.id ?? ''; b.append(x.sign, el('span', '', x.name)); if (x.what) b.append(el('small', '', x.what)); b.addEventListener('click', () => run(b)); return b; };
            let any = false;
            for (const group of o.addable()) {
                const free = group.items.filter((x) => !on.has(x.id));
                if (!free.length) continue;
                any = true;
                pick.append(el('h3', '', group.title));
                for (const x of free) pick.append(row(x, (b) => {
                    if (!idsOf(items).includes(x.id)) items.push({ id: x.id, size: 's' });
                    gone = gone.filter((g) => g !== x.id);
                    changed(); toast(w('desk-added', 'Added to the desk')); b.remove();
                }));
            }
            if (!any) pick.append(el('p', 'hint', w('desk-add-all', 'Everything is on the desk')));
            pick.append(el('h3', '', w('desk-add-more', 'Folders')));
            const folderSign = el('span', 'desk-folder-ic'); folderSign.setAttribute('aria-hidden', 'true');
            pick.append(row({ name: w('desk-folder-empty', 'Empty folder'), sign: folderSign }, () => {
                const f = { id: `f:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, folder: w('desk-folder-new', 'New folder'), size: 's', items: [] };
                /* Empty, it waits on the desk for things dropped on it (one emptied by taking things out goes). */
                items.push(f); bg.remove(); changed(); shownFolder = f.id; paintFolder(); sheet?.querySelector('input')?.select();
            }));
            if (o.create?.length) {
                pick.append(el('h3', '', w('desk-create', 'Create')));
                for (const c of o.create) { const b = button('desk-pick-row'); b.append(el('span', 'desk-plus', '+'), el('span', '', c.label)); b.addEventListener('click', () => { bg.remove(); c.run(); }); pick.append(b); }
            }
            box.append(head, pick); bg.append(box);
            const shut = () => { bg.remove(); add.focus(); };
            close.addEventListener('click', shut);
            bg.addEventListener('click', (e) => { if (e.target === bg) shut(); });
            bg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); shut(); } });
            document.body.append(bg);
            (pick.querySelector('button') ?? close).focus();
        }

        /* ---- the pointer: a press opens; a long press, or a drag in edit mode, moves ---- */
        let press = null; let drag = null; let tapped = '';
        const LONG_MS = 550;
        function down(e) {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            const t = e.target.closest('.desk-tile'); if (!t || t.closest('.desk-sheet') || e.target.closest('.desk-more')) return;
            press = { id: t.dataset.id, x: e.clientX, y: e.clientY, tile: t, timer: setTimeout(() => { if (!editing && press) { press = null; setEditing(true); toast(w('desk-editing', 'Edit mode')); } }, LONG_MS) };
            addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', cancel);
        }
        function stop() { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', cancel); }
        function cancel() { if (press) clearTimeout(press.timer); press = null; if (drag) endDrag(true); stop(); }
        function move(e) {
            if (drag) { moveDrag(e); return; }
            if (!press) return;
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) {
                clearTimeout(press.timer);
                if (editing) startDrag(e); else { press = null; stop(); }
            }
        }
        function up() {
            if (drag) { endDrag(false); stop(); return; }
            stop();
            if (!press) return;
            clearTimeout(press.timer);
            const p = press; press = null;
            if (editing) return;
            /* Opened on the click that follows, not here: on a touch screen that click lands where the finger was,
               which would be the folder's backdrop once open, and close it at once (16-11, a tablet). */
            tapped = p.id;
        }
        function startDrag(e) {
            const t = press.tile; const r = t.getBoundingClientRect();
            const ghost = t.cloneNode(true); ghost.classList.add('desk-drag'); ghost.removeAttribute('tabindex'); ghost.setAttribute('aria-hidden', 'true');
            Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, gridColumn: '', gridRow: '' });
            document.body.append(ghost);
            drag = { id: press.id, ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, over: '', since: 0, merge: '', cell: null };
            press = null;
            t.classList.add('desk-ghosted');
        }
        let hint = null; let mark = null;
        function clearMarks() { hint?.remove(); hint = null; mark?.remove(); mark = null; grid.querySelectorAll('.desk-target').forEach((x) => x.classList.remove('desk-target')); }
        function moveDrag(e) {
            const d = drag;
            d.ghost.style.left = `${e.clientX - d.dx}px`; d.ghost.style.top = `${e.clientY - d.dy}px`;
            const under = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains('desk-tile') && x.parentNode === grid && x.dataset.id !== d.id);
            const dragged = find(d.id);
            if (under && dragged?.folder === undefined) {
                const r = under.getBoundingClientRect();
                const cx = (e.clientX - r.left) / r.width; const cy = (e.clientY - r.top) / r.height;
                if (cx > 0.25 && cx < 0.75 && cy > 0.2 && cy < 0.8) {
                    if (d.over !== under.dataset.id) { d.over = under.dataset.id; d.since = performance.now(); d.merge = ''; }
                    if (!d.merge && performance.now() - d.since > 350) {
                        clearMarks(); d.merge = under.dataset.id; d.cell = null;
                        under.classList.add('desk-target');
                        hint = el('div', 'desk-hint', find(d.merge)?.folder !== undefined ? w('desk-drop-into', 'Drop: put in the folder') : w('desk-drop-folder', 'Drop: make a folder'));
                        document.body.append(hint);
                    }
                    if (d.merge) return;
                    mark?.remove(); mark = null; d.cell = null;
                    return;
                }
            }
            d.over = ''; d.merge = ''; clearMarks();
            const it = find(d.id); const g = d.ghost.getBoundingClientRect();
            const cell = cellAt(g.left + Math.min(20, g.width / 4), g.top + Math.min(20, g.height / 4));
            const span = W(it, cols); cell.c = Math.min(cell.c, cols - span + 1); d.cell = cell;
            mark = el('div', 'desk-dropmark'); mark.style.gridColumn = `${cell.c} / span ${span}`; mark.style.gridRow = `${cell.r} / span ${H(it)}`;
            grid.append(mark);
        }
        function endDrag(cancelled) {
            const d = drag; drag = null; d.ghost.remove(); clearMarks();
            if (!cancelled && d.merge) {
                const f = merge(items, d.id, d.merge, { id: `f:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: w('desk-folder-new', 'New folder') });
                changed();
                if (f && f.items.length === 2) { shownFolder = f.id; paintFolder(); sheet?.querySelector('input')?.select(); }
                return;
            }
            if (!cancelled && d.cell) { moveTo(items, d.id, d.cell.c, d.cell.r, cols, pos); changed(); return; }
            render();
        }

        grid.addEventListener('pointerdown', down);
        grid.addEventListener('contextmenu', (e) => { if (e.target.closest('.desk-tile')) e.preventDefault(); });
        grid.addEventListener('click', (e) => {
            const more = e.target.closest('.desk-more');
            if (more) { e.stopPropagation(); const t = more.closest('.desk-tile'); if (menu && menu.dataset.for === t.dataset.id) { closeMenu(); return; } menuFor(t.dataset.id, more); if (menu) menu.dataset.for = t.dataset.id; return; }
            const t = e.target.closest('.desk-tile'); const id = tapped; tapped = '';
            if (!t || editing || !id || t.dataset.id !== id) return;
            const it = find(id);
            if (it?.folder !== undefined) { shownFolder = it.id; paintFolder(); } else o.open(id);
        });
        grid.addEventListener('keydown', (e) => {
            const t = e.target.closest('.desk-tile'); if (!t || e.target !== t) return;
            const id = t.dataset.id;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (editing) { menuFor(id, t); return; }
                const it = find(id);
                if (it?.folder !== undefined) { shownFolder = id; paintFolder(); } else o.open(id);
                return;
            }
            const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (arrow && editing) { e.preventDefault(); moveBy(items, id, arrow[0], arrow[1], cols, pos); changed(); gridTile(id)?.focus(); }
            if (e.key === 'Escape' && editing) { e.preventDefault(); setEditing(false); }
        });
        edit.addEventListener('click', () => setEditing(!editing));
        tidyB.addEventListener('click', () => { items = tidy(items, pos); changed(); });
        add.addEventListener('click', openAdd);
        /* The screen narrower or wider: as many columns as it holds now (the places kept are not touched). */
        const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (ready && measure() !== cols) render(); }) : null;
        watch?.observe(grid);

        /* READ: the desk kept; none yet, the home cards as they are today (nothing disappears); the
           conversations and rooms made since, added. */
        async function refresh() {
            const got = await o.load();
            if (drag || press) return;
            items = Array.isArray(got?.items) ? got.items.map((x) => (x.folder !== undefined ? { ...x, items: [...x.items] } : { ...x })) : [];
            gone = Array.isArray(got?.gone) ? [...got.gone] : [];
            const added = addNew(items, gone, o.wanted());
            ready = true;
            render();
            if (!got?.saved || added) save();
        }
        return {
            refresh, render,
            get editing() { return editing; },
            state: () => ({ items: structuredClone(items), gone: [...gone], cols }),
            leave() { closeMenu(); closeFolder(); if (editing) setEditing(false); },
        };
    }

    window.clavariumDesk = { layout, moveTo, moveBy, tidy, merge, unfold, takeOut, remove, addNew, idsOf, dropEmpty, Desk };
})();
