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
 *                  opened with a context (a conversation it will be attached to).
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
    function ConvCard(m, { size = 'row', tag, cls = '', onOpen = null, actions = [] } = {}) {
        const t = tag ?? (size === 'member' ? 'div' : 'button');
        const root = node(t, `kit-conv kit-conv-${size}${cls ? ` ${cls}` : ''}`);
        if (t === 'button') root.type = 'button';
        const state = stateOf(m.state);
        root.append(Avatar(m.avatar ?? { name: m.title }), StatusDot({ state, label: m.stateLabel ?? STATE_WORDS[state] }));
        const main = node('span', 'kit-conv-main');
        const head = node('span', 'kit-conv-head');
        head.append(node('b', '', m.title ?? ''));
        if (m.when) head.append(node('small', 'when', m.when));
        main.append(head);
        const lines = [];
        if (size === 'row') {
            if (m.last) lines.push(node('small', 'last', m.last));
            if (m.now) lines.push(node('small', 'kit-conv-now', m.now));
        } else if (size === 'card') {
            if (m.last) lines.push(node('small', 'last', m.last));
            const what = [m.now, m.who].filter(Boolean).join(' · ');
            if (what) lines.push(node('small', 'kit-conv-now', what));
        } else {
            const what = [m.who, m.now].filter(Boolean).join(' · ');
            if (what) lines.push(node('small', 'kit-conv-now', what));
        }
        main.append(...lines);
        /* Its chips by place: all on a card; a row leaves out the wide ones; a member only what waits for you. */
        const chips = Chips((m.chips ?? []).filter((c) => c && (size === 'card' || (size === 'row' ? !c.wide : c.tone === 'need' || c.tone === 'count'))));
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
       `onBack`: a way back to the kinds from a form, where the frame has none of its own. */
    function NewAsset({ kinds = [], kind = '', made = null, context = null, existing = null, form = () => null, words: w = {}, onKind = () => {}, onBack = null, onAnother = () => {}, onDone = () => {} } = {}) {
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
        head.append(StepFlow({ steps, at: made ? steps.length : kind ? 1 : 0 }));
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

    window.clavariumKit = {
        STATES, STATE_WORDS, stateOf, hueOf, initialOf,
        setWords(fn) { if (typeof fn === 'function') words = fn; },
        StatusDot, Avatar, Chips, Switch, Segmented, InlineConfirm, ConvCard, StepFlow, SecretPicker, NewAsset,
    };
})();
