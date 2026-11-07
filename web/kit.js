/* THE KIT (05-11): the small pieces every screen shares, one implementation each -- a screen is only a
 * frame that places them (05-11: the kit, then the conversation card).
 *
 *   StatusDot      the point of a state: problem · wait · work · busy · ok · sleep (the list's six)
 *   Avatar         an initial on a colour drawn from the name (always the same for the same name)
 *   Chips          small pills: what waits, its room, its boxes, a mark
 *   Switch         yes / no (role=switch, aria-checked)
 *   Segmented      one of a few (pressed buttons, aria-pressed)
 *   InlineConfirm  confirm in place of the button: Keep, then the action
 *   ConvCard       ONE CONVERSATION, three sizes: `row` (the list, Recent), `card` (the home deck),
 *                  `member` (a room's members, and the one that welcomes it). Same dot, name, line
 *                  of what it does now, chips; each place adds its own gestures (`actions`).
 *   StepFlow       the steps of a gesture, the one at hand marked, "2 / 3"
 *   SecretPicker   a key to choose, or "+ New key…" made in place
 *   NewAsset       ONE BOX to make an asset (05-11, step 3): kinds, the kind's form, one ending;
 *                  opened with a context (a conversation it will be attached to). A voice box and
 *                  a device are two of its kinds too (step 4).
 *   TopBar         THE BAR atop every page of the right-hand pane, two variants: `main` (a conversation, a room:
 *                  its views on the right) and `sub` (a page of its own or inside one: a way back on the right)
 *   ShareDonut     who takes a whole (memory, a disk): a small donut, its slices from shareSlices, the main
 *                  figure in its middle; ShareKey, a slice's swatch beside its row in the list
 *   AssetIcon      an asset's sign and colour, by its kind (one table, ASSET_ICONS)
 *   AssetCard      ONE ASSET, three sizes like ConvCard (06-11, assets step 1): `row` (a list), `chip` (a pill:
 *                  a folded group, the thread, a call waiting), `head` (atop its panel). On its right, who has
 *                  it (Holders) or, seen from one holder, its right (RightsBadge).
 *   AssetList      THE ONE LIST of assets (06-11, assets step 2): the Assets menu and a conversation's tab, only its
 *                  scope changes; by type or by group; an empty type not shown; assetListModel places the rows.
 *   AccessList     WHO HAS IT (06-11, assets step 3): a row per conversation or device, its RightsPicker; seen from one
 *                  conversation, its row first, then "Also with"; accessModel places the rows.
 *   AssetPanel     ONE ASSET OPENED, the same in the Assets menu and a conversation's tab: head, parts, foot (AssetDelete).
 *   RIGHTS         THE ONE TABLE of what an asset can be given at, by its kind and by who gets it (a
 *                  conversation, a device); "none" first. RightsBadge reads a right, RightsPicker sets it.
 *
 * No framework: each piece is a function that returns an element. Words: English here; the page
 * hands its own (`setWords`, app.js `uiSaid`) for the few the kit says by itself.
 * Loaded before app.js (index.html, device.html): window.clavariumKit. */
(() => {
    /* THE STATES, worst first (the order a folded group sums them in). */
    const STATES = ['problem', 'wait', 'work', 'busy', 'ok', 'sleep'];
    const STATE_WORDS = { problem: 'a problem', wait: 'waits for you', work: 'at work', busy: 'busy', ok: 'fine', sleep: 'asleep' };
    /* Older names some places used for the same states: one vocabulary from now on. */
    const ALIASES = { ready: 'ok', online: 'ok', idle: 'ok', done: 'ok', waits: 'wait', waiting: 'wait', working: 'work', asleep: 'sleep', off: 'sleep', failed: 'problem', bad: 'problem' };
    const stateOf = (s) => (STATES.includes(s) ? s : ALIASES[s] ?? 'ok');

    let words = (key, fallback) => fallback;
    const say = (key, fallback) => { try { const w = words(key, fallback); return typeof w === 'string' && w ? w : fallback; } catch { return fallback; } };

    /* A colour of its own, from its name: the same name, the same colour, on every screen. */
    const hueOf = (text) => { let h = 0; for (const ch of String(text ?? '')) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; };
    const initialOf = (name) => ([...String(name ?? '').trim()][0] ?? '?').toUpperCase();

    const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };

    function StatusDot({ state = 'ok', label = '' } = {}) {
        const d = node('span', 'state-dot'); d.dataset.state = stateOf(state);
        if (label) d.title = label;
        return d;
    }

    /* `glyph`: an element drawn in place of the initial (a room's sign). */
    function Avatar({ name = '', glyph = null, hue } = {}) {
        const a = node('span', 'kit-av'); a.setAttribute('aria-hidden', 'true');
        a.style.setProperty('--h', String(hue ?? hueOf(name)));
        if (glyph) a.append(glyph); else a.textContent = initialOf(name);
        return a;
    }

    /* A chip: { text, cls?, tone?: 'need' | 'note', icon?: 'room' | 'box', title? }. Empty: nothing. */
    function Chips(list = []) {
        const shown = list.filter((c) => c && c.text !== undefined && c.text !== '');
        if (!shown.length) return null;
        const box = node('span', 'kit-chips');
        for (const c of shown) {
            const chip = node('small', `kit-chip${c.cls ? ` ${c.cls}` : ''}`);
            if (c.tone) chip.dataset.tone = c.tone;
            if (c.icon) { const i = node('span', `kit-chip-ic kit-ic-${c.icon}`); i.setAttribute('aria-hidden', 'true'); chip.append(i); }
            chip.append(String(c.text));
            if (c.title) chip.title = c.title;
            box.append(chip);
        }
        return box;
    }

    /* Yes / no. `onChange(on)`; the page paints again, or calls `.set(on)`. */
    function Switch({ on = false, label = '', onChange = () => {}, disabled = false } = {}) {
        const b = node('button', 'kit-switch'); b.type = 'button';
        b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(Boolean(on)));
        if (label) b.setAttribute('aria-label', label);
        if (disabled) b.disabled = true;
        b.set = (v) => b.setAttribute('aria-checked', String(Boolean(v)));
        b.addEventListener('click', () => { const next = b.getAttribute('aria-checked') !== 'true'; b.set(next); onChange(next); });
        return b;
    }

    /* One of a few: `options` [{ value, label }], the chosen one pressed. `onChange(value)`. */
    function Segmented({ options = [], value, label = '', onChange = () => {} } = {}) {
        const g = node('div', 'kit-seg'); g.setAttribute('role', 'group');
        if (label) g.setAttribute('aria-label', label);
        const buttons = options.map((o) => {
            const b = node('button', '', o.label ?? o.value); b.type = 'button'; b.dataset.value = String(o.value);
            b.addEventListener('click', () => { g.set(o.value); onChange(o.value); });
            return b;
        });
        g.set = (v) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === String(v))); };
        g.append(...buttons); g.set(value);
        return g;
    }

    /* Confirm in place of `button`: the question, Keep (focused), then the action. Escape keeps.
       Returns { close }. `onYes()` may be async; the action stays pressed till it is done. */
    function InlineConfirm(button, { question = '', yes = 'Remove', keep, danger = true, onYes = () => {} } = {}) {
        const ask = node('span', 'kit-confirm'); ask.setAttribute('role', 'alertdialog');
        if (question) ask.append(node('span', 'kit-confirm-q', question));
        const k = node('button', '', keep ?? say('kit-keep', 'Keep')); k.type = 'button';
        const y = node('button', danger ? 'danger' : 'primary', yes); y.type = 'button';
        ask.append(k, y);
        const close = () => { if (ask.isConnected) { ask.replaceWith(button); button.focus?.(); } };
        k.addEventListener('click', close);
        ask.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
        y.addEventListener('click', async () => { y.disabled = k.disabled = true; try { await onYes(); } finally { y.disabled = k.disabled = false; } });
        button.replaceWith(ask); k.focus?.();
        return { close, element: ask };
    }

    /* ONE CONVERSATION (or a room, drawn the same). `m`, what the page knows of it, said once:
         title     its free name                       state, stateLabel   its point
         avatar    { name, glyph?, hue? }              when                when it was last used ('' : none)
         last      its last words ('' : none)          now                 what it does now ('' : nothing to say)
         who       its assistant · its tool            chips               [{ text, cls?, tone?, icon?, wide? }]
       `size`: 'row' | 'card' | 'member'. A `wide` chip (its room, its boxes) is said on a card only; a
       member says only what waits for you (tone 'need' or 'count').
       `tag`: 'button' (opens it: `onOpen`) or 'div' (a member: its gestures are `actions`). `cls`: the
       page's own classes, kept for its rules and tests. */
    /* A line of a message as plain words: Markdown's marks taken off (**, __, `, #, > , links' addresses). */
    const plainLine = (t) => String(t ?? '').replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/(\*\*|__|\*|_|`+|~~)(?=\S)([^\n]*?\S)\1/g, '$2').replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
    function ConvCard(m, { size = 'row', tag, cls = '', onOpen = null, actions = [] } = {}) {
        const t = tag ?? (size === 'member' ? 'div' : 'button');
        const root = node(t, `kit-conv kit-conv-${size}${cls ? ` ${cls}` : ''}`);
        if (t === 'button') root.type = 'button';
        const state = stateOf(m.state);
        root.append(Avatar(m.avatar ?? { name: m.title }), StatusDot({ state, label: m.stateLabel ?? STATE_WORDS[state] }));
        const main = node('span', 'kit-conv-main');
        const head = node('span', 'kit-conv-head');
        head.append(node('b', '', m.title ?? ''));
        /* A row (05-11, the designers' review): its unread count beside its time, its marks as small words on
           the line below, beside its last words -- one line less than pills. */
        const counts = size === 'row' ? (m.chips ?? []).filter((c) => c && !c.wide && c.tone === 'count') : [];
        const countChips = Chips(counts);
        if (countChips) head.append(countChips);
        if (m.when) head.append(node('small', 'when', m.when));
        main.append(head);
        const lines = [];
        if (size === 'row') {
            const marks = Chips((m.chips ?? []).filter((c) => c && !c.wide && c.tone !== 'count'));
            const sub = [m.last ? node('small', 'last', m.last) : null, m.now ? node('small', 'kit-conv-now', m.now) : null].filter(Boolean);
            if (marks && sub.length) { const line = node('span', 'kit-conv-sub'); line.append(sub[0], marks); lines.push(line, ...sub.slice(1)); }
            else if (marks) lines.push(marks);
            else lines.push(...sub);
        } else if (size === 'card') {
            /* 06-11 (the owner's review): its last words without their Markdown marks; what it does now only when it
               says something the point does not (asleep: the grey point says it); its tool in the details, not here. */
            if (m.last) lines.push(node('small', 'last', plainLine(m.last)));
            if (m.now && state !== 'sleep') lines.push(node('small', 'kit-conv-now', m.now));
        } else {
            const what = [m.who, m.now].filter(Boolean).join(' · ');
            if (what) lines.push(node('small', 'kit-conv-now', what));
        }
        main.append(...lines);
        /* Its chips by place: all on a card; a row leaves out the wide ones; a member only what waits for you. */
        const chips = size === 'row' ? null : Chips((m.chips ?? []).filter((c) => c && (size === 'card' || c.tone === 'need' || c.tone === 'count')));
        if (chips) main.append(chips);
        root.append(main);
        if (actions.length) { const acts = node('span', 'kit-conv-acts'); acts.append(...actions.filter(Boolean)); root.append(acts); }
        if (onOpen && t === 'button') root.addEventListener('click', () => onOpen());
        return root;
    }

    /* The steps of a gesture: done ones ticked, the one at hand `aria-current="step"`, and "2 / 3".
       `at`: the step at hand (0 is the first); `steps.length`: all done. */
    function StepFlow({ steps = [], at = 0, label = '' } = {}) {
        const box = node('div', 'kit-steps');
        const list = node('ol', 'kit-steps-list');
        if (label) list.setAttribute('aria-label', label);
        steps.forEach((s, i) => {
            const li = node('li', i < at ? 'done' : '');
            if (i === at) li.setAttribute('aria-current', 'step');
            const n = node('span', 'kit-step-n', i < at ? '✓' : String(i + 1)); n.setAttribute('aria-hidden', 'true');
            li.append(n, node('span', 'kit-step-w', s));
            list.append(li);
        });
        box.append(list, node('small', 'kit-steps-count', `${Math.min(at + 1, steps.length)} / ${steps.length}`));
        return box;
    }

    /* A KEY TO CHOOSE, or one made in place: its keys, then "+ New key…" opens a name and Create right
       there. `ids` keeps the page's names for its parts { select, add, row, name, go }. `keys` [{ value,
       label }]; `none`: said when there is none. `suggest()`: the name offered; `onMake(name)`: the page
       makes it (and calls `.set` with the new list). `.set(keys, chosen)` fills it again, the chosen kept. */
    function SecretPicker({ ids = {}, keys = [], value = '', label = '', none = '', addLabel, makeLabel, nameLabel = '', nameAttrs = {}, suggest = () => '', onMake = async () => {}, onChange = () => {} } = {}) {
        const box = node('div', 'kit-secret');
        const select = node('select'); if (ids.select) select.id = ids.select;
        if (label) select.setAttribute('aria-label', label);
        const add = node('button', 'kit-secret-add', addLabel ?? say('kit-new-key', '+ New key…')); add.type = 'button'; if (ids.add) add.id = ids.add;
        const pick = node('div', 'row'); pick.append(select, add);
        const make = node('div', 'row kit-secret-make'); if (ids.row) make.id = ids.row; make.hidden = true;
        const name = node('input'); if (ids.name) name.id = ids.name;
        if (nameLabel) name.setAttribute('aria-label', nameLabel);
        for (const [k, v] of Object.entries(nameAttrs)) name.setAttribute(k, v);
        const go = node('button', 'primary', makeLabel ?? say('kit-create', 'Create')); go.type = 'button'; if (ids.go) go.id = ids.go;
        make.append(name, go);
        box.append(pick, make);
        box.set = (list, chosen = select.value) => {
            select.replaceChildren();
            if (!list.length && none) { const o = node('option', '', none); o.value = ''; select.append(o); }
            for (const k of list) { const o = node('option', '', k.label ?? k.value); o.value = k.value; select.append(o); }
            if (list.some((k) => k.value === chosen)) select.value = chosen;
        };
        box.set(keys, value);
        select.addEventListener('change', () => onChange(select.value));
        add.addEventListener('click', () => { name.value = suggest() ?? ''; make.hidden = false; name.focus?.(); });
        go.addEventListener('click', async () => {
            go.disabled = true;
            try { if ((await onMake(name.value.trim())) !== false) make.hidden = true; } finally { go.disabled = false; }
        });
        return box;
    }

    /* NEW ASSET: ONE BOX, wherever an asset is made (Assets, a conversation's Attach). Its kinds, then
       that kind's form (the page's own: `form(kind)`), then one ending: "✓ <name> created", Create
       another, Done. Opened with a context, it says it on top (`context`: { line, level? }, `level` a
       Segmented's options) and the page attaches what is made at the end. `existing`: what is there
       already, offered above "or a new one". `made`: { said, note? } draws the ending.
         kinds  [{ kind, label, icon? }]     kind   '' : choose one       words  { title, there, orNew, steps[3], back, another, done }
       `onBack`: a way back to the kinds from a form, where the frame has none of its own.
       `at`: the step at hand, for a kind of more steps than one (a voice box: where, plug it, pair it). */
    function NewAsset({ kinds = [], kind = '', made = null, context = null, existing = null, form = () => null, words: w = {}, at = null, onKind = () => {}, onBack = null, onAnother = () => {}, onDone = () => {} } = {}) {
        const root = node('div', 'kit-newasset');
        root.dataset.step = made ? 'done' : kind ? 'form' : 'kind';
        const steps = w.steps ?? [say('kit-step-kind', 'Kind'), say('kit-step-set', 'Set up'), say('kit-step-made', 'Created')];
        if (context) {
            const top = node('div', 'kit-na-context');
            top.append(node('span', '', context.line ?? ''));
            if (context.level) top.append(Segmented(context.level));
            root.append(top);
        }
        const head = node('div', 'kit-na-head');
        const title = w.title ?? say('kit-new-asset', 'New asset');
        if (!kind && !made && title) head.append(node('h3', '', title));
        head.append(StepFlow({ steps, at: made ? steps.length : kind ? (Number.isInteger(at) ? at : 1) : 0 }));
        root.append(head);
        if (made) {
            const end = node('div', 'kit-na-made');
            const line = node('p', ''); line.setAttribute('role', 'status');
            line.append(StatusDot({ state: 'ok' }), node('span', '', `✓ ${made.said}`));
            end.append(line);
            if (made.note) end.append(node('p', 'hint', made.note));
            const acts = node('div', 'row kit-na-acts');
            const again = node('button', '', w.another ?? say('kit-create-another', 'Create another')); again.type = 'button'; again.dataset.act = 'another';
            const done = node('button', 'primary', w.done ?? say('kit-done', 'Done')); done.type = 'button'; done.dataset.act = 'done';
            again.addEventListener('click', () => onAnother());
            done.addEventListener('click', () => onDone());
            acts.append(again, done); end.append(acts);
            root.append(end);
            return root;
        }
        if (kind) {
            /* Back to the kinds, when the frame has no way back of its own. */
            if (onBack) { const back = node('button', 'as-link kit-na-back', `\u2039 ${w.back ?? say('kit-back', 'Back')}`); back.type = 'button'; back.addEventListener('click', () => onBack()); root.append(back); }
            const f = form(kind); if (f) root.append(f);
            return root;
        }
        if (existing) root.append(node('h4', 'kit-na-sub', w.there ?? say('kit-already-there', 'Already there')), existing, node('h4', 'kit-na-sub', w.orNew ?? say('kit-or-new', 'or a new one')));
        /* `.as-kinds`, `data-kind`: the names the page's rules and tests know. */
        const list = node('div', 'as-kinds');
        for (const k of kinds) {
            const b = node('button', '', k.label ?? k.kind); b.type = 'button'; b.dataset.kind = k.kind;
            if (k.icon) b.prepend(k.icon);
            b.addEventListener('click', () => onKind(k.kind));
            list.append(b);
        }
        root.append(list);
        return root;
    }

    /* THE TOP BAR (06-11, the owner: « un ou deux composants réutilisables, le même visuel au final »): one bar
       atop every page of the right-hand pane -- a conversation, a room, their settings, Assets, Access, Settings,
       the deck, a new conversation. The same height, padding, type and places everywhere:
         [fold «] [‹ back, main: a narrow screen's] [dot] [title / its one small line under it] .... [actions] [‹ Back, sub]
       variant  'main': a conversation or a room (its views: tabs, its gear); 'sub': a page (a way back, last).
       fold     true (a new « button, `onFold`) or the page's own element; null: none (a device's page).
       back     { element?, id?, label, said? } (`said`: the page's key for its words, kept on the label).
       state    { id?, state?, label? } (a dot drawn here) or the page's own element; null: no state, no dot.
       title    words, or the page's element (its id kept); `sub`: words or elements, one line under it.
       actions  elements on its right. `cls`: the page's own classes. Ids and listeners of what it is given stay. */
    const addClass = (e, cls) => { e.className = [...new Set(`${e.className ?? ''} ${cls}`.split(/\s+/).filter(Boolean))].join(' '); return e; };
    function TopBar({ variant = 'main', fold = null, onFold = null, back = null, state = null, title = '', sub = null, actions = [], cls = '' } = {}) {
        const v = variant === 'sub' ? 'sub' : 'main';
        const bar = node('header', `topbar kit-topbar${cls ? ` ${cls}` : ''}`); bar.dataset.variant = v;
        if (fold) {
            const f = fold === true ? node('button', 'fold-here', '«') : fold;
            if (fold === true) {
                f.type = 'button'; f.title = say('kit-fold', 'Hide or show the list of conversations');
                f.setAttribute('aria-label', say('kit-fold-hide', 'Hide the list of conversations')); f.setAttribute('aria-pressed', 'false');
                if (onFold) f.addEventListener('click', () => onFold());
            }
            bar.append(addClass(f, 'topbar-fold'));
        }
        let backButton = null;
        if (back) {
            const label = back.label ?? say('kit-back', 'Back');
            backButton = back.element ?? node('button'); backButton.type = 'button';
            if (back.id) backButton.id = back.id;
            if (v === 'main') {
                /* A conversation's or a room's way back: its sign alone, on a narrow screen (wide: the list is there). */
                backButton.className = 'topbar-lead-back'; backButton.textContent = '‹';
                backButton.setAttribute('aria-label', label); backButton.title = label;
                if (back.said) backButton.dataset.saidLabel = back.said;
                bar.append(backButton);
            } else {
                backButton.className = 'as-link place-back topbar-back';
                const words = node('span', 'topbar-back-label', label); if (back.said) words.dataset.said = back.said;
                backButton.replaceChildren('‹ ', words);
            }
        }
        if (state) {
            const dot = state.tagName ? state : node('span', 'bar-state');
            if (dot !== state) { if (state.id) dot.id = state.id; dot.dataset.state = stateOf(state.state ?? 'ok'); dot.setAttribute('aria-hidden', 'true'); if (state.label) dot.title = state.label; }
            bar.append(addClass(dot, 'topbar-dot'));
        }
        const head = node('span', 'topbar-title');
        const name = typeof title === 'string' ? node('b', '', title) : title;
        if (name) head.append(addClass(name, 'topbar-name'));
        const subs = (Array.isArray(sub) ? sub : [sub]).filter((x) => x !== null && x !== undefined && x !== '');
        if (subs.length) { const line = node('span', 'topbar-sub'); line.append(...subs.map((x) => (typeof x === 'string' ? node('small', '', x) : x))); head.append(line); }
        bar.append(head);
        const right = node('div', 'bar-right');
        right.append(...actions.filter(Boolean));
        if (backButton && v === 'sub') right.append(backButton);
        bar.append(right);
        return bar;
    }

    /* WHO TAKES IT (06-11): one whole -- a server's memory or a disk -- split by who takes it: each machine
       (the largest first, at most `max`, the rest folded into "Others"), the rest of the system, and what is
       free. `parts` [{ key, label, mb }]. A machine keeps its colour while the page lives (`slots`, shared by
       the memory and the disks: a colour follows the machine, never its rank). Slots 1..6 are Parley's chart
       colours (--parley-s1..s6); 0 is "Others"; 'rest' and 'free' are neutral. */
    function shareSlices(parts, { restMb = 0, freeMb = 0, max = 6, slots = new Map(), words: w = {} } = {}) {
        const most = Math.max(1, Math.min(6, max));
        const sorted = (parts ?? []).filter((x) => Number.isFinite(x?.mb) && x.mb > 0).sort((a, b) => b.mb - a.mb);
        const shown = sorted.length > most ? sorted.slice(0, most) : sorted;
        const folded = sorted.slice(shown.length);
        const used = new Set();
        const held = new Set(slots.values());
        const out = shown.map((x) => {
            let s = slots.get(x.key);
            if (!s || used.has(s)) s = [1, 2, 3, 4, 5, 6].find((n) => !used.has(n) && !held.has(n)) ?? [1, 2, 3, 4, 5, 6].find((n) => !used.has(n));
            slots.set(x.key, s); held.add(s); used.add(s);
            return { key: x.key, label: x.label, mb: x.mb, slot: s };
        });
        if (folded.length) out.push({ key: 'others', label: w.others ?? 'Others', mb: folded.reduce((a, x) => a + x.mb, 0), slot: 0, keys: folded.map((x) => x.key) });
        if (restMb > 0) out.push({ key: 'rest', label: w.rest ?? 'System and others', mb: restMb, slot: 'rest' });
        if (freeMb > 0) out.push({ key: 'free', label: w.free ?? 'Free', mb: freeMb, slot: 'free' });
        const total = out.reduce((a, x) => a + x.mb, 0);
        for (const x of out) x.share = total > 0 ? x.mb / total : 0;
        return out;
    }
    const sharePct = (x) => `${x.share > 0 && x.share < 0.01 ? '<1' : Math.round(x.share * 100)} %`;
    /* The swatch of a slice, beside its row in the list (the list is the legend). */
    function ShareKey(slot) { const k = node('span', 'share-key'); k.dataset.s = String(slot); k.setAttribute('aria-hidden', 'true'); return k; }
    const SVG = 'http://www.w3.org/2000/svg';
    const svgNode = (tag, cls) => { const e = document.createElementNS(SVG, tag); if (cls) e.setAttribute('class', cls); return e; };
    /* A SMALL DONUT of those slices (a "camembert"), its size set by the page's style; in its middle the main
       figure (`center`: { top, main, sub }), or the slice under the pointer or the finger: its name, its size,
       its share. Said whole to a screen reader. */
    function ShareDonut({ slices = [], label = '', fmt = (mb) => `${mb} MB`, center = {} } = {}) {
        const root = node('div', 'share-donut');
        const svg = svgNode('svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${label}: ${slices.map((x) => `${x.label} ${fmt(x.mb)} ${sharePct(x)}`).join('; ')}`);
        const R = 40; const C = 2 * Math.PI * R; const gap = slices.length > 1 ? 1.2 : 0;
        const mid = node('div', 'share-mid'); mid.setAttribute('aria-hidden', 'true');
        const top = node('span', 'share-mid-top'); const main = node('b', 'share-mid-main'); const sub = node('span', 'share-mid-sub');
        mid.append(top, main, sub);
        const say = (t, m, b) => { top.textContent = t ?? ''; main.textContent = m ?? ''; sub.textContent = b ?? ''; };
        const rest = () => { say(center.top, center.main, center.sub); for (const a of arcs) a.removeAttribute('data-on'); svg.removeAttribute('data-on'); };
        let at = 0; let on = null;
        const arcs = slices.map((x) => {
            const len = x.share * C;
            const a = svgNode('circle', 'share-arc'); a.dataset.s = String(x.slot);
            for (const [k, v] of [['cx', 50], ['cy', 50], ['r', R], ['stroke-dasharray', `${Math.max(0.6, len - gap).toFixed(2)} ${C.toFixed(2)}`], ['stroke-dashoffset', (-at).toFixed(2)], ['transform', 'rotate(-90 50 50)']]) a.setAttribute(k, String(v));
            at += len;
            const show = () => { on = x.key; for (const o of arcs) o.setAttribute('data-on', String(o === a)); svg.setAttribute('data-on', 'true'); say(x.label, fmt(x.mb), sharePct(x)); };
            a.addEventListener('pointerenter', (event) => { if (event?.pointerType !== 'touch') show(); });
            /* A tap shows it; a second tap on the same slice puts the main figure back (a mouse's click only shows). */
            a.addEventListener('click', (event) => { if (event?.pointerType !== 'mouse' && on === x.key && svg.getAttribute('data-on')) { on = null; rest(); } else show(); });
            return a;
        });
        svg.addEventListener('pointerleave', (event) => { if (event?.pointerType !== 'touch') { on = null; rest(); } });
        svg.append(...arcs);
        rest();
        root.append(svg, mid);
        return root;
    }

    /* ---------- ASSETS (06-11, the unified assets, step 1: the pieces; the screens move to them in step 2) ---------- */

    /* AN ASSET'S SIGN, by its kind: the icon set's name (Lucide, icons.js), or '' for one drawn here (a binder).
       A live link (a connexion) takes the sign of what it links (a mailbox, a calendar); `acces`, any other. */
    const ASSET_ICONS = { folder: 'folder', git: 'git-branch', mailbox: 'mail', agenda: 'calendar', contacts: 'user', secret: 'key-round', list: '', acces: 'link', send: 'arrow-up', demandes: 'arrow-up', box: 'mic', device: 'smartphone', conversation: 'message-square' };
    const ASSET_KINDS = Object.keys(ASSET_ICONS);
    /* A binder: the set has no such sign, so it is drawn here, in its style (was app.js listIcon). */
    function listSign() {
        const svg = svgNode('svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        for (const d of ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8']) { const p = svgNode('path'); p.setAttribute('d', d); svg.append(p); }
        return svg;
    }
    function AssetIcon({ kind = 'folder', cls = '' } = {}) {
        const k = kind in ASSET_ICONS ? kind : 'folder';
        const box = node('span', `kit-asset-ic${cls ? ` ${cls}` : ''}`); box.dataset.kind = k; box.setAttribute('aria-hidden', 'true');
        const name = ASSET_ICONS[k];
        const svg = name ? window.clavariumIcons?.icon?.(name) : listSign();
        if (svg) box.append(svg);
        return box;
    }

    /* THE RIGHTS: one level each, its tone (r: reads, w: changes, x: uses or watches, n: none). The words come
       three ways: `badge` (what it has: "Reads"), `pick` (a choice: "Read"), `hint` (one line, its title). */
    const RIGHT_LEVELS = {
        none: { tone: 'n', badge: 'None', pick: 'None', hint: 'Not given' },
        read: { tone: 'r', badge: 'Reads', pick: 'Read', hint: 'Reads only' },
        write: { tone: 'w', badge: 'Writes', pick: 'Write', hint: 'Reads and writes' },
        use: { tone: 'x', badge: 'Uses', pick: 'Use', hint: 'Handed to its tool, never shown' },
        watch: { tone: 'x', badge: 'Watches', pick: 'Watch', hint: 'Reads only' },
        propose: { tone: 'x', badge: 'Proposes', pick: 'Propose', hint: 'Asks you before each action' },
        frame: { tone: 'w', badge: 'Framed', pick: 'Frame', hint: 'Acts within its rules, asks the rest' },
        free: { tone: 'w', badge: 'Free', pick: 'Free', hint: 'Acts, kept in the journal' },
        terminal: { tone: 'x', badge: 'Terminal', pick: 'Terminal', hint: 'Its whole terminal' },
        chat: { tone: 'r', badge: 'Chat', pick: 'Chat', hint: 'Reads and writes in its chat' },
        both: { tone: 'w', badge: 'Chat + terminal', pick: 'Both', hint: 'Its chat and its terminal' },
    };
    /* THE ONE TABLE (was app.js levelOptionsFor, the "Used by" options, levelControl, partsControl, fixedRight,
       fixedUse, Attach's Read / Write / Use): what each kind can be given at, by who gets it. "none" is first,
       always: it replaces Off, Detach, Remove all and Take back. A kind not in a holder's column is not given
       to it. `connexion`: a live link (Tether: a mailbox, a calendar, contacts or an access connected). */
    const RIGHTS = {
        folder: { conversation: ['none', 'read', 'write'], device: ['none', 'read', 'write'] },
        git: { conversation: ['none', 'read', 'write'], device: ['none', 'read', 'write'] },
        mailbox: { conversation: ['none', 'read'], device: ['none', 'read'] },
        secret: { conversation: ['none', 'use'] },
        list: { conversation: ['none', 'read', 'write'] },
        connexion: { conversation: ['none', 'watch', 'propose', 'frame', 'free'] },
        conversation: { device: ['none', 'terminal', 'chat', 'both'] },
    };
    const HOLDERS = ['conversation', 'device'];
    /* The table's key of an asset: a live link is a connexion, whatever it links; else its kind. */
    const rightsKey = (a) => (a?.live || a?.target ? 'connexion' : a?.kind ?? '');
    const rightsFor = (key, holder = 'conversation') => [...(RIGHTS[key]?.[HOLDERS.includes(holder) ? holder : 'conversation'] ?? [])];
    /* The lightest real level (what "give the group" gives): the first after none. */
    const lightest = (key, holder) => rightsFor(key, holder)[1] ?? null;
    /* AS THE SERVER KEEPS THEM -> a level, and back. A secret is 'off' / 'use' (secrets.mjs); a device's
       grant is 'r' / 'rw', a conversation given to a device 'x' (terminal), 'rw' (chat), 'rwx' (devices.mjs);
       the rest keeps the level's own name. Nothing, '', null, 'off': none. */
    function rightOf(key, stored, holder = 'conversation') {
        const s = String(stored ?? '').trim();
        if (!s || s === 'off' || s === 'none') return 'none';
        if (holder === 'device' || /^(r|rw|x|rwx)$/.test(s)) {
            if (key === 'conversation') return { x: 'terminal', rw: 'chat', r: 'chat', rwx: 'both', xrw: 'both' }[s] ?? (s in RIGHT_LEVELS ? s : 'none');
            if (s === 'r') return 'read';
            if (s === 'rw' || s === 'rwx') return 'write';
        }
        return s in RIGHT_LEVELS ? s : 'none';
    }
    function storedOf(key, level, holder = 'conversation') {
        if (holder === 'device') {
            if (level === 'none') return null;
            if (key === 'conversation') return { terminal: 'x', chat: 'rw', both: 'rwx' }[level] ?? null;
            return { read: 'r', write: 'rw' }[level] ?? null;
        }
        if (key === 'secret') return level === 'use' ? 'use' : 'off';
        return level;
    }
    const levelOf = (opts) => { const l = opts.level ?? rightOf(opts.key ?? '', opts.value, opts.holder); return l in RIGHT_LEVELS ? l : 'none'; };
    const rightWord = (level, form = 'badge') => {
        const l = RIGHT_LEVELS[level] ?? RIGHT_LEVELS.none;
        return say(`set-rt-${form === 'badge' ? '' : `${form}-`}${level in RIGHT_LEVELS ? level : 'none'}`, l[form] ?? l.badge);
    };

    /* A RIGHT, READ: a small pill, its tone by what it lets do. `level`, or `value` as kept (with its `key`, `holder`). */
    function RightsBadge(opts = {}) {
        const level = levelOf(opts);
        const b = node('span', `kit-rights${opts.cls ? ` ${opts.cls}` : ''}`, rightWord(level, 'badge'));
        b.dataset.level = level; b.dataset.tone = RIGHT_LEVELS[level].tone;
        b.title = rightWord(level, 'hint');
        return b;
    }

    /* A RIGHT, SET: the kind's levels from the table, "None" first, the one held pressed. `onChange(level,
       stored)`: the level, and as the server keeps it; the buttons wait while it works (a promise). Nothing
       to choose (a kind not given to that holder): null. */
    /* A CALENDAR, CONTACTS: given live, Read is Watch and Write is Propose (what Attach made of them) -- said on the picker. */
    const RIGHT_SAME = { agenda: { watch: 'read', propose: 'write' }, contacts: { watch: 'read', propose: 'write' } };
    function RightsPicker({ key = '', kind = '', holder = 'conversation', value, level, label = '', cls = '', onChange = () => {} } = {}) {
        const levels = rightsFor(key, holder);
        if (!levels.length) return null;
        const now = level ?? rightOf(key, value, holder);
        const options = levels.map((l) => ({ value: l, label: rightWord(l, 'pick') }));
        let held = now;
        const pick = Segmented({ options, value: now, label, onChange: async (l) => {
            if (l === held) return;
            const buttons = pick.children; for (const b of buttons) b.disabled = true;
            try { if ((await onChange(l, storedOf(key, l, holder))) === false) pick.set(held); else held = l; }
            catch { pick.set(held); }
            finally { for (const b of buttons) b.disabled = false; }
        } });
        addClass(pick, `kit-rights-pick${cls ? ` ${cls}` : ''}`);
        pick.dataset.key = key; pick.dataset.holder = holder;
        const same = key === 'connexion' ? RIGHT_SAME[kind] : null;
        for (const b of pick.children) {
            b.title = rightWord(b.dataset.value, 'hint');
            const as = same?.[b.dataset.value];
            if (as) { const w = rightWord(as, 'pick'); b.append(node('small', 'kit-rights-same', `= ${w}`)); b.title = `${b.title} (= ${w})`; }
        }
        return pick;
    }

    /* WHO HAS IT: their initials, up to `max`, then "+n"; nobody, said in grey. `list` [{ name, hue?, glyph? }]. */
    function Holders(list = [], { max = 3 } = {}) {
        const box = node('span', 'kit-holders');
        const all = (list ?? []).filter((h) => h && h.name);
        if (!all.length) { box.dataset.none = 'true'; box.append(node('small', 'kit-holders-none', say('set-as-nobody', 'nobody'))); return box; }
        for (const h of all.slice(0, max)) box.append(Avatar(h));
        if (all.length > max) box.append(node('small', 'kit-holders-more', `+${all.length - max}`));
        box.title = all.map((h) => h.name).join(', ');
        return box;
    }

    /* ONE ASSET. `a`, what the page knows of it, said once:
         key, kind   'folder:reports', its kind (ASSET_ICONS)   name    its name
         live        a live link (a connexion): its rights are a connexion's
         sub         its one line ('' : none)                   state   a point when it asks for you (wait,
                                                                        problem: expiring, failing); else none
         tone        its line's shade, when the page has one ('warn': soon; 'bad': past, failing)
         count       a number that waits for you (calls waiting)
         holders     [{ name, hue? }] who has it (Assets)       right   { level | value, holder? } its right,
                                                                        seen from one holder (a conversation)
         chips       [{ text, … }] on a head (its group ▾, its type, its size)
       `size`: 'row' | 'chip' | 'head'. `tag`: 'button' (it opens: `onOpen`) or the page's; a head is a div.
       `current`: the one open (aria-current). `actions`: the place's own gestures, on its right. */
    function AssetCard(a, { size = 'row', tag, cls = '', current = false, onOpen = null, actions = [] } = {}) {
        const s = ['row', 'chip', 'head'].includes(size) ? size : 'row';
        const t = tag ?? (s === 'head' ? 'div' : onOpen || s === 'row' ? 'button' : 'span');
        const root = node(t, `kit-asset kit-asset-${s}${cls ? ` ${cls}` : ''}`);
        if (t === 'button') root.type = 'button';
        if (a.key) root.dataset.asset = a.key;
        root.dataset.kind = a.kind ?? 'folder'; root.dataset.name = a.name ?? '';
        if (current) root.setAttribute('aria-current', 'true');
        root.append(AssetIcon({ kind: a.kind }));
        if (s === 'chip') {
            root.append(node('span', 'kit-asset-name', a.name ?? ''));
            if (a.right) root.append(RightsBadge({ ...a.right, key: a.right.key ?? rightsKey(a) }));
        } else {
            const main = node('span', 'kit-asset-main');
            main.append(node(s === 'head' ? 'h2' : 'b', 'kit-asset-name', a.name ?? ''));
            if (a.sub || a.state) {
                const line = node('small', 'kit-asset-sub');
                if (a.state) { line.append(StatusDot({ state: a.state, label: a.sub ?? '' })); line.dataset.state = stateOf(a.state); }
                if (a.tone) line.dataset.tone = a.tone;
                if (a.sub) line.append(node('span', '', a.sub));
                main.append(line);
            }
            if (s === 'head') { const chips = Chips(a.chips ?? []); if (chips) main.append(chips); }
            root.append(main);
            const side = node('span', 'kit-asset-side');
            if (Number.isFinite(a.count) && a.count > 0) side.append(Chips([{ text: String(a.count), tone: 'count' }]));
            if (a.right) side.append(RightsBadge({ ...a.right, key: a.right.key ?? rightsKey(a) }));
            else if (a.holders && s === 'row') side.append(Holders(a.holders));
            side.append(...actions.filter(Boolean));
            if (side.children.length) root.append(side);
        }
        if (onOpen && t === 'button') root.addEventListener('click', () => onOpen(a.key));
        return root;
    }

    /* THE LIST OF ASSETS (06-11, assets step 2): ONE LIST in the Assets menu and in a conversation's Assets tab;
       only its scope changes -- 'all' (every asset, who has each on its right) or 'conversation:<name>' (what it
       was given, each with its right). Two views of the same rows: by type, or by the owner's groups (the menu
       only). A type with nothing in it is not shown; a group is (a place to drag to), unless a search empties it.

       assetListModel: the rows placed, no page needed (tested alone).
         items   [{ key, kind, name, … }] as AssetCard takes them       groups  [{ id, label, members: [key] }]
         scope   'all' | 'conversation:x'                              by      the view kept ('type' | 'group'), or
                                                                               '': groups once one exists, else types
         query   a name searched (any case)     folded   group ids folded shut     kinds   [[kind, title]] in order
       -> { view, canGroup, sections: [{ id, title, kind | group, items, holders, folded, drop, empty }], shown, total } */
    const scopeOf = (scope) => (String(scope ?? 'all').startsWith('conversation:') ? 'conversation' : 'all');
    function assetListModel({ items = [], groups = [], scope = 'all', by = '', query = '', folded = [], kinds = [] } = {}) {
        const canGroup = scopeOf(scope) === 'all';
        const view = canGroup && (by === 'group' || (by !== 'type' && groups.length > 0)) ? 'group' : 'type';
        const q = String(query ?? '').trim().toLowerCase();
        const shown = q ? items.filter((i) => String(i.name ?? '').toLowerCase().includes(q)) : [...items];
        const sections = [];
        if (view === 'type') {
            const order = kinds.length ? kinds : [...new Set(shown.map((i) => i.kind))].map((k) => [k, k]);
            const known = new Set(order.map(([k]) => k));
            for (const [kind, title] of order) {
                const mine = shown.filter((i) => i.kind === kind);
                if (mine.length) sections.push({ id: `kind:${kind}`, kind, title, items: mine });
            }
            /* A kind the page did not name is never dropped: it comes last, under its own name. */
            for (const kind of [...new Set(shown.map((i) => i.kind).filter((k) => !known.has(k)))]) sections.push({ id: `kind:${kind}`, kind, title: kind, items: shown.filter((i) => i.kind === kind) });
        } else {
            const byKey = new Map(shown.map((i) => [i.key, i]));
            const shut = new Set(folded);
            const grouped = new Set();
            for (const g of groups) {
                for (const k of g.members ?? []) grouped.add(k);
                const mine = (g.members ?? []).map((k) => byKey.get(k)).filter(Boolean);
                if (q && !mine.length) continue;
                const seen = new Set(); const holders = [];
                for (const h of mine.flatMap((i) => i.holders ?? [])) if (h?.name && !seen.has(h.name)) { seen.add(h.name); holders.push(h); }
                sections.push({ id: `group:${g.id}`, group: g.id, title: g.label, items: mine, holders, folded: shut.has(g.id), drop: g.id, empty: mine.length ? '' : 'group' });
            }
            const loose = shown.filter((i) => !grouped.has(i.key));
            /* The loose ones stay a place to drag to (out of a group) while there are groups, even emptied. */
            if (loose.length || (!q && items.length)) sections.push({ id: 'group:', group: '', title: say('set-as-no-group', 'No group'), items: loose, drop: '', empty: loose.length ? '' : groups.length ? 'grouped' : 'nogroups' });
        }
        return { view, canGroup, sections, shown: shown.length, total: items.length };
    }

    /* The list drawn from its model. A row is an AssetCard (`rowCls` added: the page's handle on it); `pinned`,
       rows above every section (what waits: To send, Demandes). `onOpen(key)`; a group's head folds it
       (`onFold(id)`), its ⚙ opens it (`onGroup(id)`). `empty`: said when there is nothing at all; `noMatch`,
       when a search finds nothing. */
    function AssetList(model, { chosen = '', onOpen = () => {}, onFold = () => {}, onGroup = () => {}, rowCls = '', pinned = [], empty = '', noMatch = '' } = {}) {
        const box = node('div', 'kit-aslist'); box.dataset.view = model.view;
        box.append(...pinned.filter(Boolean));
        const hints = {
            group: say('set-as-group-empty', 'Empty: drag an asset here'),
            grouped: say('set-as-all-grouped', 'Every asset is in a group'),
            nogroups: say('set-as-no-groups', 'Make a group, then drag an asset into it'),
        };
        for (const s of model.sections) {
            const sec = node('section', `kit-aslist-sec${s.group !== undefined ? ' kit-aslist-group' : ''}`);
            if (s.kind !== undefined) sec.dataset.kind = s.kind;
            if (s.drop !== undefined) sec.dataset.drop = s.drop;
            const head = node('div', 'kit-aslist-head');
            if (s.group) {
                if (s.folded) head.dataset.folded = 'true';
                const toggle = node('button', 'kit-aslist-fold'); toggle.type = 'button';
                if (`group:${s.group}` === chosen) toggle.setAttribute('aria-current', 'true');
                toggle.setAttribute('aria-expanded', String(!s.folded));
                toggle.title = s.folded ? say('set-as-unfold', 'Unfold') : say('set-as-fold', 'Fold');
                toggle.append(node('span', 'kit-aslist-chev', s.folded ? '▸' : '▾'), node('h3', '', s.title), node('span', 'kit-aslist-n', String(s.items.length)));
                toggle.addEventListener('click', () => onFold(s.group));
                head.append(toggle);
                if (s.holders?.length) head.append(Holders(s.holders));
                const gear = node('button', 'kit-aslist-gear', '⚙'); gear.type = 'button';
                gear.setAttribute('aria-label', say('set-as-group-open', 'Settings for {name}').replace('{name}', s.title));
                gear.title = say('set-as-group-gear', 'Give, rename, remove');
                gear.addEventListener('click', (e) => { e?.stopPropagation?.(); onGroup(s.group); });
                head.append(gear);
            } else head.append(node('h3', '', s.title));
            sec.append(head);
            if (!s.folded) {
                for (const a of s.items) sec.append(AssetCard(a, { size: 'row', cls: rowCls, current: a.key === chosen, onOpen }));
                if (s.empty) sec.append(node('p', 'hint kit-aslist-none', hints[s.empty] ?? ''));
            }
            box.append(sec);
        }
        if (!model.total && empty) box.append(node('p', 'hint kit-aslist-said', empty));
        else if (model.total && !model.shown && noMatch) box.append(node('p', 'hint kit-aslist-said', noMatch));
        return box;
    }

    /* WHO HAS IT (06-11, assets step 3): ONE LIST of who was given an asset -- each conversation and each device on a
       row, its right set in place (RightsPicker, "None" first). Seen from a conversation, its own row comes first, then
       "Also with" the others. "+ Give to…" opens the conversations that do not have it yet, each at None.

       accessModel: the rows placed, no page needed (tested alone).
         key      the table's key (rightsKey)       from    'conversation:x' when seen from it ('' : the Assets menu)
         holders  [{ id: 'conversation:x' | 'device:y', name, sub?, value | level, ready?: false, hue? }]
       -> { here, given: [rows], others: [rows], count, said: '' | 'nobody' | 'everyone' | 'noready' } -- a row with its
          `holder` ('conversation' | 'device') and its `level`; a device is never offered (it is shared from its own sheet). */
    const holderOf = (id) => (String(id ?? '').startsWith('device:') ? 'device' : 'conversation');
    function accessModel({ key = '', holders = [], from = '' } = {}) {
        const rows = (holders ?? []).filter((h) => h && h.id).map((h) => {
            const holder = holderOf(h.id);
            const level = h.level ?? rightOf(key, h.value, holder);
            return { ...h, holder, level: level in RIGHT_LEVELS ? level : 'none' };
        }).filter((r) => rightsFor(key, r.holder).length > 0);
        const here = from ? rows.find((r) => r.id === from) ?? null : null;
        const rest = rows.filter((r) => r !== here);
        const given = [...rest.filter((r) => r.holder === 'conversation' && r.level !== 'none'), ...rest.filter((r) => r.holder === 'device' && r.level !== 'none')];
        const others = rest.filter((r) => r.holder === 'conversation' && r.level === 'none' && r.ready !== false);
        const count = given.length + (here && here.level !== 'none' ? 1 : 0);
        const convs = rows.filter((r) => r.holder === 'conversation' && r.ready !== false);
        const said = !convs.length && !count ? 'noready' : !count ? 'nobody' : !others.length && !here ? 'everyone' : '';
        return { here, given, others, count, said };
    }

    /* The list drawn from its model. `onChange(row, level, stored)` sets one right (the picker waits on it); `kind`, the
       asset's own kind (a calendar's levels say what they mean); `actions`, more gestures under it (Share with a device…).
       Its old handles kept for the pages' tests: .as-chapter .as-add, .as-users, .as-picker, .given-row[data-conversation]. */
    function AccessList(model, { key = '', kind = '', name = '', onChange = () => {}, actions = [] } = {}) {
        const box = node('section', 'kit-access');
        const head = node('div', 'as-chapter kit-access-head');
        head.append(node('h3', '', say('set-acc-title', 'Who has it')));
        const picker = node('div', 'as-users as-picker kit-access-pick'); picker.hidden = true;
        const give = node('button', 'as-add kit-access-give', '+'); give.type = 'button';
        const giveWord = say('set-acc-give', 'Give to…');
        give.setAttribute('aria-label', giveWord); give.title = giveWord; give.setAttribute('aria-expanded', 'false');
        give.addEventListener('click', () => { picker.hidden = !picker.hidden; give.setAttribute('aria-expanded', String(!picker.hidden)); });
        head.append(give);
        box.append(head);
        const row = (r) => {
            const line = node('div', 'given-row kit-access-row');
            line.dataset[r.holder === 'device' ? 'device' : 'conversation'] = String(r.id).replace(/^[a-z]+:/, '');
            line.dataset.level = r.level;
            const who = node('span', 'kit-access-who');
            who.append(Avatar({ name: r.name, hue: r.hue }));
            const nm = node('span', 'kit-access-name', r.name);
            const sub = r.sub ?? (r.holder === 'device' ? say('set-acc-device', 'Device') : '');
            if (sub) nm.append(node('small', '', sub));
            who.append(nm);
            line.append(who);
            const pick = RightsPicker({ key, kind, holder: r.holder, level: r.level, label: say('set-acc-what', 'What {who} may do with {name}').replace('{who}', r.name).replace('{name}', name),
                onChange: (level, stored) => onChange(r, level, stored) });
            if (pick) line.append(pick);
            return line;
        };
        if (model.here) {
            const mine = node('div', 'as-users kit-access-here');
            mine.append(row(model.here));
            box.append(mine);
        }
        const users = node('div', 'as-users kit-access-given');
        if (model.here && model.given.length) users.append(node('h4', 'kit-access-also', say('set-acc-also', 'Also with')));
        for (const r of model.given) users.append(row(r));
        const said = { nobody: say('set-acc-nobody', 'No conversation uses it.'), everyone: '', noready: say('set-acc-noready', 'No conversation is ready.') }[model.said];
        if (said && !model.here) users.append(node('p', 'hint', said));
        if (users.children.length) box.append(users);
        for (const r of model.others) picker.append(row(r));
        if (!model.others.length) picker.append(node('p', 'hint', model.said === 'noready' ? say('set-acc-noready', 'No conversation is ready.') : say('set-acc-everyone', 'Every conversation has it.')));
        box.append(picker);
        const more = actions.filter(Boolean);
        if (more.length) { const acts = node('div', 'kit-access-acts'); acts.append(...more); box.append(acts); }
        return box;
    }

    /* ONE ASSET OPENED (06-11, assets step 3): the same panel in the Assets menu and in a conversation's tab. Its head (an
       AssetCard head: sign, name, line, chips) under "‹ Assets" (a phone's way back), then its parts in order -- what it is,
       who has it (AccessList), what is in it (files, branches, cards) -- then its foot (rename, delete…).
         back      { label?, onBack } the way back            parts    [node | { title, extra: [nodes], body: [nodes], cls }]
         foot      [nodes]                                   before   [nodes] above the head (an ending: "✓ created")
       A part's title draws a chapter head (.as-chapter), its `extra` on its right. */
    function AssetPanel(card, { back = null, parts = [], foot = [], before = [], cls = '' } = {}) {
        const root = node('div', `kit-aspanel${cls ? ` ${cls}` : ''}`);
        if (card?.key) root.dataset.asset = card.key;
        root.append(...before.filter(Boolean));
        const top = node('div', 'as-title kit-aspanel-top');
        if (back) {
            const b = node('button', 'as-link as-back', back.label ?? `‹ ${say('set-as-assets', 'Assets')}`); b.type = 'button';
            b.addEventListener('click', () => back.onBack?.());
            top.append(b);
        }
        top.append(AssetCard(card ?? {}, { size: 'head' }));
        root.append(top);
        for (const p of parts) {
            if (!p) continue;
            if (!p.title && !p.body) { root.append(p); continue; }
            const part = node('section', `kit-aspanel-part${p.cls ? ` ${p.cls}` : ''}`);
            if (p.title) { const h = node('div', 'as-chapter'); h.append(node('h3', '', p.title), ...(p.extra ?? []).filter(Boolean)); part.append(h); }
            part.append(...(p.body ?? []).filter(Boolean));
            root.append(part);
        }
        const f = foot.filter(Boolean);
        if (f.length) { const box = node('div', 'as-foot kit-aspanel-foot'); box.append(...f); root.append(box); }
        return root;
    }

    /* DELETE…, out of the way: refused while `blocked` (said why, beside it); else confirmed in place (InlineConfirm):
       what is lost, Keep, then `yes`. */
    function AssetDelete({ label, blocked = '', lost = '', yes = '', onYes = () => {} } = {}) {
        const box = node('span', 'kit-asdelete');
        const b = node('button', 'as-link danger-link', label ?? say('set-acc-delete', 'Delete…')); b.type = 'button';
        box.append(b);
        if (blocked) { b.disabled = true; box.append(node('small', 'hint', ` ${blocked}`)); return box; }
        b.addEventListener('click', () => InlineConfirm(b, { question: lost, yes: yes || say('set-acc-delete-yes', 'Delete'), onYes }));
        return box;
    }

    /* A BOX'S COLLECT SESSION (boxcollect.mjs), from GET /api/boxes/<id>/collect, in one state for its one line:
       none · scheduled (from, until) · running (kept) · ended (kept). */
    function collectModel(c, now = Date.now()) {
        if (c?.until) {
            const from = Date.parse(c.from); const until = Date.parse(c.until);
            if (!c.on && from > now) return { state: 'scheduled', from: c.from, until: c.until };
            return { state: c.on || now < until ? 'running' : 'ended', kept: c.kept ?? 0, from: c.from, until: c.until };
        }
        if (c?.last) return { state: 'ended', kept: c.last.kept ?? 0, from: c.last.from, until: c.last.until };
        return { state: 'none' };
    }

    window.clavariumKit = {
        collectModel,
        AssetIcon, AssetCard, Holders, RightsBadge, RightsPicker, AssetList, assetListModel, AccessList, accessModel, AssetPanel, AssetDelete, RIGHT_SAME,
        ASSET_ICONS, ASSET_KINDS, RIGHTS, RIGHT_LEVELS, rightsKey, rightsFor, rightOf, storedOf, lightest, rightWord,
        shareSlices, ShareDonut, ShareKey,
        STATES, STATE_WORDS, stateOf, hueOf, initialOf,
        setWords(fn) { if (typeof fn === 'function') words = fn; },
        StatusDot, Avatar, Chips, Switch, Segmented, InlineConfirm, ConvCard, StepFlow, SecretPicker, NewAsset, TopBar,
    };
})();
