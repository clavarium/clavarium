/* FEATURES (04-11): what this Clavarium can do, where each thing stands, and its next step -- one
 * component, three places (blueprint: the house and the card):
 *
 *   welcome    first start, no conversation yet: "What would you like to do?" (goals as tiles),
 *              the house lighting the rooms they need, importing a setup, the sharing line; then
 *              the card and the house, and "Create a conversation"
 *   home       a banner over the conversations' cards: a mini house, the next step, its gesture
 *   settings   a chapter at the top of Settings: goals, the card, the other steps, the house
 *
 * The card (left) says what to do next; the house (right, on top on a phone) shows what it lights
 * up. Everything comes from GET /api/features (server/features.mjs), already ordered: this page
 * orders nothing. A gesture calls the endpoint that already does the thing (POST /api/dictation,
 * /api/meshcentral/enable...) or opens the place where it is done; nothing is turned on by itself.
 * Words: English here, others through the words of the page (app.js `word`, /api/talk/words).
 * Built by app.js, which hands what it shares (requests, words, the mascot, its places). */
(() => {
    const SVG_ICONS = {
        mic: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7"/>',
        box: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.2"/><path d="M12 7.2v.1"/>',
        wave: '<path d="M3 11v2M7 7.5v9M11 4v16M15 7.5v9M19 10v4"/>',
        mailcal: '<rect x="2" y="9" width="13" height="11" rx="1.6"/><path d="m2.5 10.5 6 4.3 6-4.3"/><path d="M15 3.5h5.5a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H17M15 7h7M17 2v3M20 2v3"/>',
        shield: '<path d="M12 2.8 4.5 5.8v5.7c0 4.8 3.2 8.2 7.5 9.7 4.3-1.5 7.5-4.9 7.5-9.7V5.8z"/><path d="m8.8 12 2.2 2.2 4.4-4.6"/>',
        key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 9.7-9.7M16.5 6.5l3 3M13.8 9.2l2.2 2.2"/>',
        monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/>',
        chat: '<path d="M3.5 4.5h10a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H8.5l-4 3.2V14h-1a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><path d="M18 8.5h1.5a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-1v3l-3.8-3h-3.2"/>',
        bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.8 2H4.2z"/><path d="M10 21h4"/>',
        moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="M17 3v3M15.5 4.5h3"/>',
        refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.6M4.5 3v4h4M4 13a8 8 0 0 0 14.5 4.6M19.5 21v-4h-4"/>',
        lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
        check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
        alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.1"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        house: '<path d="M3 11 12 3.5 21 11"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-6h4v6"/>',
        code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
        work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18M11 12.5v1.5h2v-1.5"/>',
        upload: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M12 18v-6.5M9 14l3-3 3 3"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
        out: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
        sparkle: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/>',
    };
    const ic = (n, cls) => `<svg class="ft-ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${SVG_ICONS[n] ?? ''}</svg>`;
    /* The house's rooms, in the registry's order (the server's list comes ordered by impact). */
    const ROOMS = ['dictation', 'boxes', 'speech', 'alerts', 'opencode', 'answerer', 'mail', 'screen', 'backup', 'signin', 'updates'];
    const LOOK = { dictation: ['mic', 38], boxes: ['box', 320], speech: ['wave', 280], alerts: ['bell', 18], opencode: ['chat', 255], answerer: ['moon', 230], mail: ['mailcal', 200], screen: ['monitor', 175], backup: ['shield', 150], signin: ['key', 45], updates: ['refresh', 120] };
    const GOALS = [['home', 'house', 320, 'Talk at home'], ['dictate', 'mic', 38, 'Dictate'], ['mail', 'mailcal', 200, 'Mail & calendar'], ['code', 'code', 255, 'Code'], ['work', 'work', 20, 'Work'], ['calm', 'shield', 150, 'Peace of mind']];
    const BUTTON = { dictation: 'Turn on', alerts: 'Turn on', screen: 'Turn on', updates: 'Automatic', backup: 'Export', opencode: 'Create…', secret: '+ Key…', boxes: 'Add…', mail: 'Connect…', settings: 'Set up…' };
    const SHORT = { boxes: 'Boxes', answerer: 'Away', mail: 'Mail', screen: 'Screen' };

    window.clavariumFeatures = (env) => {
        const S = { data: null, step: 1, sel: null, keyOpen: null, moreOpen: false, bannerOpen: false, seeSent: false, busy: null, fx: null, places: new Map(), entered: new Set(), model: {} };
        const w = (key, en, vars) => env.word(key, en, vars);
        const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
        const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const btn = (html, cls, onclick, label) => { const b = el('button', cls || '', html); b.type = 'button'; if (onclick) b.addEventListener('click', onclick); if (label) { b.setAttribute('aria-label', label); b.title = label; } return b; };
        const colon = () => (env.lang?.() === 'fr' ? ' : ' : ': ');

        /* ---- what the server said, in words ---- */
        const caps = () => S.data?.capabilities ?? [];
        const byId = (id) => caps().find((c) => c.id === id);
        const works = (c) => c && (c.status === 'ready' || c.status === 'partial');
        const nameOf = (c) => w(`features-${c.id}-name`, c.name);
        const shortOf = (c) => w(`features-${c.id}-short`, SHORT[c.id] ?? c.name);
        const benefitOf = (c) => w(`features-${c.id}-benefit`, c.benefit);
        /* A state's word: its numbers become {n}, {m} (« 2 devices » -> features-w-{n} devices). */
        const wordOf = (text) => {
            if (!text) return '';
            const nums = String(text).match(/\d+/g) ?? []; const names = ['n', 'm'];
            let i = 0; const key = String(text).replace(/\d+/g, () => `{${names[i++] ?? 'x'}}`);
            return w(`features-w-${key}`, key, Object.fromEntries(nums.slice(0, 2).map((v, k) => [names[k], v])));
        };
        const labelOf = (s) => w(s.say?.key ?? '', s.label, s.say?.vars ?? {});
        const buttonOf = (s) => w(`features-btn-${s.action}`, BUTTON[s.action] ?? 'Open');
        const effortOf = (e) => w(`features-e-${String(e).replace(/ /g, '-')}`, String(e).replace(/^./, (x) => x.toUpperCase()));
        const nextCap = () => (S.data?.next ? byId(S.data.next) : null);
        const steps = () => caps().filter((c) => c.suggestion && c.status !== 'problem');
        const problems = () => caps().filter((c) => c.status === 'problem');
        const readyN = () => S.data?.counts?.ready ?? 0;
        const total = () => S.data?.counts?.total ?? ROOMS.length;
        const litOf = () => w('features-lit-of', '{n} of {t} rooms lit', { n: readyN(), t: total() });
        const friendly = () => { const r = readyN() / Math.max(1, total()); const k = r >= 1 ? 3 : r > 0.6 ? 2 : r > 0.4 ? 1 : 0; return w(`features-f${k}`, ['The house is waking up.', 'It is coming to life.', 'Almost all lit up.', 'Everything shines.'][k]); };
        const afterWord = (c) => w('features-after', 'After: {x}', { x: c.blockedBy.map((id) => byId(id)).filter(Boolean).map((x) => nameOf(x).toLowerCase()).join(', ') });
        function stateOf(c) {
            const nx = nextCap();
            if (S.busy === c.id) return { k: 'busy', glyph: 'sparkle', word: w('features-testing', 'Testing…') };
            if (c.status === 'problem') return { k: 'problem', glyph: 'alert', word: wordOf(c.word) };
            if (c.suggestion && c.blockedBy.length && !works(c)) return { k: 'locked', glyph: 'lock', word: afterWord(c) };
            if (works(c)) return { k: 'on', glyph: 'check', word: wordOf(c.word) || w('features-ready', 'Ready') };
            if (nx && nx.id === c.id) return { k: 'next', glyph: 'sparkle', word: `✦ ${effortOf(c.suggestion.effort)}` };
            if (c.suggestion) return { k: 'off', glyph: null, word: effortOf(c.suggestion.effort) };
            return { k: 'off', glyph: null, word: wordOf(c.word) || w('features-not-yet', 'Not yet') };
        }
        /* What to configure, and where: in Clavarium, or outside it. */
        const configureLine = (c) => {
            const out = c.configure?.where === 'outside';
            return el('div', 'ft-cfg', `${ic(out ? 'out' : 'gear')}<span><b>${esc(out ? w('features-configure-out', 'To set up elsewhere') : w('features-configure-in', 'To set up here'))}</b>${esc(colon())}${esc(w(`features-cfg-${c.id}`, c.configure?.what ?? ''))}</span>`);
        };

        /* ---- the server ---- */
        async function load() {
            await env.loadWords?.().catch(() => {});
            const r = await fetch(`${env.API}/features`);
            if (!r.ok) throw new Error('features');
            S.data = await r.json();
            return S.data;
        }
        async function send(path, body) { S.data = await env.post(`${env.API}/features/${path}`, body); render(); return S.data; }

        /* ---- joy: toast, sheep, sparks, confetti (none with less motion) ---- */
        function toast(text) {
            let t = document.getElementById('ft-toast');
            if (!t) { t = el('div', 'ft-toast'); t.id = 'ft-toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
            t.textContent = text; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2800);
        }
        function sheep(pose, width, bg) {
            const m = el('div', `mascot ft-mascot ${pose || ''}`, env.mascot());
            if (width) { m.style.width = `${width}px`; m.style.height = `${Math.round(width * 0.75)}px`; }
            if (bg) m.style.setProperty('--sheep-bg', bg);
            return m;
        }
        function sheepJoy() {
            for (const m of document.querySelectorAll('.ft-mascot')) {
                m.classList.remove('asleep', 'ft-hop'); void m.offsetWidth; m.classList.add('ft-hop');
                setTimeout(() => m.classList.remove('ft-hop'), 900);
                if (reduced()) continue;
                const r = m.getBoundingClientRect(); if (!r.width) continue;
                for (let i = 0; i < 4; i++) {
                    const s = el('span', 'ft-spark', '✦'); s.style.left = `${r.left + r.width * (0.3 + Math.random() * 0.5)}px`; s.style.top = `${r.top + r.height * 0.2}px`;
                    document.body.append(s);
                    s.animate([{ transform: 'translate(0,0) scale(.6)', opacity: 1 }, { transform: `translate(${(Math.random() - 0.5) * 60}px, ${-30 - Math.random() * 40}px) scale(1.2)`, opacity: 0 }], { duration: 900 + i * 120, easing: 'ease-out' }).onfinish = () => s.remove();
                }
            }
        }
        function confetti(node) {
            if (reduced() || !node) return;
            const r = node.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + Math.min(r.height / 2, 120);
            const shades = ['#d2a94e', '#e9c877', '#b98a2e', '#f3dfa6', '#8a5d00'];
            for (let i = 0; i < 26; i++) {
                const c = el('span', 'ft-confetti'); c.style.left = `${cx}px`; c.style.top = `${cy}px`; c.style.background = shades[i % shades.length];
                document.body.append(c);
                const a = Math.random() * Math.PI * 2; const d = 60 + Math.random() * 110;
                c.animate([{ transform: 'translate(-50%,-50%) rotate(0)', opacity: 1 },
                    { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 40}px) rotate(${Math.random() * 540}deg)`, opacity: 1, offset: 0.7 },
                    { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d + 30}px) rotate(${Math.random() * 720}deg)`, opacity: 0 }], { duration: 1100 + Math.random() * 400, easing: 'cubic-bezier(.2,.7,.4,1)' }).onfinish = () => c.remove();
            }
        }

        /* ---- the gestures: always the owner's tap; each through what already does it ---- */
        const later = (ms) => new Promise((done) => { setTimeout(done, ms); });
        async function celebrate(c, wasReady) {
            const before = new Set(caps().filter((x) => !x.blockedBy.length).map((x) => x.id));
            const flip = document.querySelector(`.ft-hero[data-id="${c.id}"]`);
            if (flip && !reduced()) { flip.classList.add('flip'); confetti(flip); await later(900); }
            await load().catch(() => {});
            const now = byId(c.id);
            if (!wasReady && works(now)) {
                S.fx = { lit: c.id, freed: caps().filter((x) => !before.has(x.id) && !x.blockedBy.length).map((x) => x.id) };
                toast(w('features-done', '{x}: done', { x: nameOf(c) })); sheepJoy();
            }
            S.sel = null; render();
            if (!flip) confetti(document.querySelector(`.ft-room[data-id="${c.id}"]`));
        }
        async function act(c, s = c.suggestion, origin = null) {
            if (!s) return;
            const fail = (e) => { S.busy = null; render(); toast(w('features-failed', 'Not done: {e}', { e: e.message })); };
            if (s.action === 'secret') { S.keyOpen = c.id; S.sel = c.id; render(); document.querySelector(`[data-key="${c.id}"] input`)?.focus(); return; }
            const wasReady = works(c);
            const direct = { dictation: true, screen: true, updates: true, backup: true, alerts: true };
            if (!direct[s.action]) {
                /* Somewhere else of this app: the place where it is set up, open on it. */
                try { await env.open(s.action, { ...s, chapter: s.chapter ?? c.chapter }); } catch (e) { fail(e); }
                return;
            }
            S.busy = c.id; render();
            try {
                if (s.action === 'dictation') {
                    const model = S.model[c.id] ?? s.model;
                    await env.post(`${env.API}/dictation`, { provider: s.provider, url: s.url, model, secret: s.secret, language: '' });
                } else if (s.action === 'screen') await env.post(`${env.API}/meshcentral/enable`, {});
                else if (s.action === 'updates') await env.post(`${env.API}/updates/settings`, { mode: 'auto', channel: s.channel, window: s.window });
                else if (s.action === 'backup') { await env.backup(); await later(1200); }
                else if (s.action === 'alerts') await env.alerts();
            } catch (e) { fail(e); return; }
            S.busy = null;
            await celebrate(c, wasReady, origin);
        }
        async function keep(c, input) {
            const value = input.value.trim();
            if (!value) { input.focus(); return; }
            try { await env.post(`${env.API}/secrets`, { name: c.suggestion.secret, value }); } catch (e) { toast(w('features-failed', 'Not done: {e}', { e: e.message })); return; }
            input.value = ''; S.keyOpen = null; toast(w('features-key-saved', 'Key kept'));
            await celebrate(c, works(c));
        }
        async function hide(c) { S.sel = null; await send('dismiss', { id: c.id }).catch(() => {}); toast(w('features-hidden', 'Hidden.')); }
        const pick = (id) => { S.sel = id; render(); };
        async function repair(c) {
            if (!c.repair) return;
            if (c.repair.action === 'screen') { S.busy = c.id; render(); try { await env.post(`${env.API}/meshcentral/enable`, {}); } catch (e) { toast(w('features-failed', 'Not done: {e}', { e: e.message })); } S.busy = null; await celebrate(c, false); return; }
            await env.open(c.repair.action, { chapter: c.repair.chapter ?? c.chapter });
        }

        /* The gesture of a step: the model menu (the next step only), its button, "Not for me". */
        function gesture(c, primary) {
            const box = el('div', 'ft-row'); const s = c.suggestion;
            if (S.keyOpen === c.id) {
                const k = el('div', 'ft-keyrow'); k.dataset.key = c.id;
                const i = el('input', 'ft-field'); i.type = 'password'; i.placeholder = w('features-paste-key', 'Paste the key'); i.autocomplete = 'off'; i.setAttribute('aria-label', `${w('features-paste-key', 'Paste the key')} ${s.secret}`);
                i.addEventListener('keydown', (e) => { if (e.key === 'Enter') void keep(c, i); });
                k.append(el('code', '', esc(s.secret)), i, btn(esc(w('features-keep', 'Keep')), 'ft-go', () => { void keep(c, i); }), btn(esc(w('features-cancel', 'Cancel')), 'as-link', () => { S.keyOpen = null; render(); }));
                box.append(k); return box;
            }
            if (primary && s.models?.length > 1) {
                const sel = el('select', 'ft-select'); sel.setAttribute('aria-label', w('features-model', 'Model'));
                for (const m of s.models) { const o = el('option', ''); o.value = m.id; o.textContent = m.word ? `${m.id} · ${w(`features-${m.word}`, m.word)}` : m.id; sel.append(o); }
                sel.value = S.model[c.id] ?? s.model; sel.addEventListener('change', () => { S.model[c.id] = sel.value; });
                box.append(sel);
            }
            const b = btn(esc(S.busy === c.id ? w('features-testing', 'Testing…') : buttonOf(s)), primary ? 'ft-go' : '', (e) => { void act(c, s, e.currentTarget); });
            b.disabled = Boolean(S.busy) || c.blockedBy.length > 0; box.append(b);
            box.append(btn(ic('x'), 'icon-btn ft-x', () => { void hide(c); }, w('features-not-for-me', 'Not for me')));
            return box;
        }
        function problemCallouts() {
            const f = document.createDocumentFragment();
            for (const c of problems()) {
                const p = el('div', 'callout bad ft-callout', `${ic('alert')}<span class="t"><b>${esc(w('features-repair-t', '{x}: {w}', { x: nameOf(c), w: wordOf(c.word) }))}</b></span>`);
                p.dataset.tone = 'bad';
                if (c.repair) p.append(btn(esc(w(`features-r-${c.repair.label}`, c.repair.label)), '', () => { void repair(c); }));
                f.append(p);
            }
            return f;
        }
        const importChoice = () => btn(`<span class="ft-ib">${ic('upload')}</span><span><b>${esc(w('features-import-t', 'Already have a setup? Import a file'))}</b><span class="ft-h">${esc(w('features-import-h', 'Pick up the settings of another install'))}</span></span>`, 'ft-import', () => { void env.open('import'); });
        const goalsNow = () => new Set(S.data?.goals ?? []);
        async function toggleGoal(id) {
            const g = goalsNow(); if (g.has(id)) g.delete(id); else g.add(id);
            S.data.goals = [...g]; render();
            await send('goals', { goals: [...g] }).catch(() => {});
        }
        const goalLabel = (g) => w(`features-g-${g[0]}`, g[3]);
        function goalChips() {
            const r = el('div', 'ft-goalrow'); r.append(el('span', '', esc(w('features-your-goals', 'Your goals'))));
            const g = goalsNow();
            for (const x of GOALS) { const b = btn(ic(x[1]) + esc(goalLabel(x)), 'choice ft-choice', () => { void toggleGoal(x[0]); }); b.setAttribute('aria-pressed', String(g.has(x[0]))); r.append(b); }
            return r;
        }
        function hiddenLine() {
            const n = S.data?.counts?.hidden ?? 0; if (!n) return null;
            const l = el('div', 'ft-hiddenline'); l.append(btn(esc(w('features-show-hidden', 'Show hidden suggestions ({n})', { n })), 'as-link', () => { void send('dismiss', { restore: true }); })); return l;
        }

        /* ---- THE HOUSE: a room per feature, a wire from the meter, the ring of what is lit on the roof ---- */
        function house(host, opts) {
            const wid = Math.max(260, Math.round(host.clientWidth || 520));
            const cpt = wid < 520; const cols = 4; const pad = 4;
            const roofH = cpt ? 58 : Math.round(Math.min(118, Math.max(88, wid * 0.17)));
            const rowH = cpt ? 64 : 126; const lamp = cpt ? 36 : 54; const ly0 = cpt ? 8 : 16; const wy = cpt ? 3 : 8;
            const ids = [...ROOMS.filter((id) => byId(id)), ...caps().map((c) => c.id).filter((id) => !ROOMS.includes(id))];
            const rows = Math.ceil(ids.length / cols); const H = roofH + rows * rowH + (cpt ? 14 : 26);
            const left = pad + 2; const right = wid - pad - 2; const trunkX = left + (cpt ? 9 : 12); const x0 = left + (cpt ? 18 : 26);
            const cellW = (right - x0) / cols;
            const wrap = el('div', `ft-house${cpt ? ' cpt' : ''}${opts.enter ? ' enter' : ''}`); wrap.style.height = `${H}px`; wrap.style.setProperty('--lamp', `${lamp}px`);
            wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', w('features-house', 'Map of your features as a house'));
            const cell = (i) => { const r = Math.floor(i / cols); const col = i % cols; const top = roofH + r * rowH; return { cx: x0 + cellW * (col + 0.5), top, ly: top + ly0, i }; };
            const pos = Object.fromEntries(ids.map((id, i) => [id, cell(i)]));
            const n = readyN(); const T = total(); const rr = Math.round(roofH * (cpt ? 0.3 : 0.26)); const rcx = wid / 2; const rcy = Math.round(roofH * 0.6); const circ = 2 * Math.PI * rr;
            let svg = `<svg class="ft-frame" viewBox="0 0 ${wid} ${H}" aria-hidden="true"><defs><linearGradient id="ft-sky-${opts.key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ft-sky1)"/><stop offset="1" stop-color="var(--ft-sky2)"/></linearGradient></defs>`;
            svg += `<g class="ft-stars">${[[0.12, 0.25], [0.2, 0.12], [0.82, 0.18], [0.9, 0.32], [0.7, 0.08]].map(([a, b]) => `<circle cx="${a * wid}" cy="${b * roofH}" r="1.4"/>`).join('')}</g>`;
            svg += `<rect x="${wid * 0.7}" y="${roofH * 0.28}" width="${cpt ? 11 : 16}" height="${roofH * 0.45}" class="ft-shell" fill="url(#ft-sky-${opts.key})"/>`;
            svg += `<path class="ft-shell" fill="url(#ft-sky-${opts.key})" d="M${left} ${roofH} L${wid / 2} ${cpt ? 4 : 8} L${right} ${roofH} V${H - 3} H${left} Z"/>`;
            for (let r = 0; r < rows; r++) svg += `<line class="ft-floor" x1="${left}" x2="${right}" y1="${roofH + r * rowH}" y2="${roofH + r * rowH}"/>`;
            svg += `<circle class="ft-ring-track" cx="${rcx}" cy="${rcy}" r="${rr}"/><circle class="ft-ring" cx="${rcx}" cy="${rcy}" r="${rr}" transform="rotate(-90 ${rcx} ${rcy})" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - n / Math.max(1, T))}"/>`;
            svg += `<text class="ft-ringtxt" x="${rcx}" y="${rcy}">${n}/${T}</text>`;
            const dh = cpt ? 12 : 28;
            svg += `<rect class="ft-door" x="${wid / 2 - dh / 2}" y="${H - 3 - dh}" width="${dh}" height="${dh}" rx="2"/><rect class="ft-meter" x="${trunkX - 5}" y="${H - 16}" width="10" height="10" rx="3"/>`;
            const wire = (id) => { const p = pos[id]; return `M${trunkX} ${H - 11} V${p.top + wy} H${p.cx} V${p.ly}`; };
            for (const id of ids) svg += `<path class="ft-wire" d="${wire(id)}"/>`;
            let k = 0;
            for (const id of ids) if (works(byId(id))) svg += `<path class="ft-wire lit${S.fx?.lit === id ? ' draw' : ''}" style="--i:${k++}" pathLength="1" d="${wire(id)}"/>`;
            for (const c of caps()) for (const src of c.requires ?? []) {
                const a = pos[src]; const b = pos[c.id]; if (!a || !b) continue;
                const y = a.ly + lamp / 2; const lit = works(byId(src));
                const x1 = a.cx + lamp / 2 + 4; const x2 = b.cx - lamp / 2 - 4; const my = y - (cpt ? 10 : 18);
                const d = a.top === b.top ? `M${x1} ${y} Q${(x1 + x2) / 2} ${my} ${x2} ${y}` : `M${a.cx} ${a.ly + lamp} C${a.cx} ${b.ly} ${b.cx} ${a.ly + lamp} ${b.cx} ${b.ly}`;
                svg += `<path class="ft-link${lit ? ' lit' : ''}${lit && S.fx?.lit === src ? ' draw' : ''}" pathLength="1" d="${d}"/>`;
                if (lit && !reduced()) svg += `<circle class="ft-spark-dot" r="${cpt ? 2.4 : 3}"><animateMotion dur="2.4s" repeatCount="indefinite" path="${d}"/></circle>`;
            }
            wrap.innerHTML = `${svg}</svg>`;
            const nx = nextCap(); const sel = S.sel || nx?.id; const want = goalsNow();
            for (const id of ids) {
                const c = byId(id); const st = stateOf(c); const p = pos[id]; const [icon] = LOOK[id] ?? ['sparkle'];
                const b = btn('', `ft-room ${st.k}`, opts.preview ? null : () => pick(id)); b.dataset.id = id;
                if (opts.want && c.goals.some((g) => want.has(g))) b.classList.add('want');
                if (S.fx?.lit === id) b.classList.add('just');
                if (S.fx?.freed?.includes(id)) b.classList.add('pop');
                if (!opts.preview && sel === id) b.setAttribute('aria-current', 'true');
                b.style.left = `${p.cx - cellW / 2}px`; b.style.top = `${p.ly}px`; b.style.width = `${cellW}px`; b.style.setProperty('--i', p.i);
                let badge = st.glyph && st.k !== 'next' && st.k !== 'busy' ? `<span class="ft-badge">${ic(st.glyph)}</span>` : '';
                if (cpt && st.k === 'next') badge = '<span class="ft-badge">✦</span>';
                b.innerHTML = `<span class="ft-lamp">${ic(icon)}${badge}</span><span class="ft-nm">${esc(cpt ? shortOf(c) : nameOf(c))}</span><span class="ft-st">${esc(st.word)}</span>`;
                b.setAttribute('aria-label', `${nameOf(c)}: ${st.word}${nx?.id === id ? `, ${w('features-lg-next', 'Next step')}` : ''}`);
                if (opts.preview) { b.tabIndex = -1; b.classList.add('preview'); }
                wrap.append(b);
            }
            if (opts.sheep && ids.length % cols) {   /* the sheep lives in the empty room */
                const p = cell(ids.length); const sw = cpt ? 58 : 92; const sh = Math.round(sw * 0.75);
                const m = sheep('', sw, 'var(--ft-sky2)'); m.style.left = `${p.cx - sw / 2}px`; m.style.top = `${p.top + rowH - sh - (cpt ? 2 : 8)}px`;
                wrap.append(m);
            }
            return wrap;
        }
        const legend = () => el('div', 'ft-legend', `<span><i class="ft-lg on"></i>${esc(w('features-lg-on', 'Ready'))}</span><span><i class="ft-lg nx"></i>✦ ${esc(w('features-lg-next', 'Next step'))}</span><span><i class="ft-lg lk"></i>${ic('lock')}${esc(w('features-lg-later', 'Later'))}</span>`);
        /* The house is drawn to its width: once its holder is in the page. */
        function houseIn(holder, opts) { const draw = () => holder.replaceChildren(house(holder, opts)); draw(); requestAnimationFrame(() => { if (Math.abs((holder.clientWidth || 0) - (Number(holder.dataset.w) || 0)) > 8) { holder.dataset.w = String(holder.clientWidth); draw(); } }); }

        /* ---- THE CARD: the next step, big; another feature's card when its room is touched ---- */
        function hero(enter) {
            const nx = nextCap(); const c = S.sel ? byId(S.sel) : nx;
            if (!c) { const d = el('section', 'ft-stepcard'); d.append(el('h3', '', esc(w('features-all-done', 'Nothing left to set up. Enjoy.')))); return d; }
            const isNext = nx && c.id === nx.id; const st = stateOf(c); const [icon, hue] = LOOK[c.id] ?? ['sparkle', 40];
            const h = el('section', `ft-hero${isNext ? '' : ` plain ${st.k}`}${enter ? ' deal' : ''}`);
            h.dataset.id = c.id; h.style.setProperty('--h', hue); h.setAttribute('aria-label', isNext ? w('features-your-next', 'Your next step') : nameOf(c));
            const inner = el('div', 'ft-inner'); const f = el('div', 'ft-face front');
            f.append(el('div', 'ft-art', ic(icon) + (isNext ? '<span class="ft-orb" style="left:16%;top:18%">✦</span><span class="ft-orb" style="right:14%;top:30%;animation-delay:.8s">✦</span><span class="ft-orb" style="left:28%;bottom:14%;animation-delay:1.5s;font-size:12px">✦</span>' : '')));
            const b = el('div', 'ft-body');
            b.append(el('div', 'ft-eyebrow', isNext ? `✦ ${esc(w('features-your-next', 'Your next step'))} · ${esc(effortOf(c.suggestion.effort))}` : (st.glyph ? ic(st.glyph) : '') + esc(nameOf(c)) + ' · ' + esc(st.word)));
            b.append(el('h2', '', esc(c.suggestion ? labelOf(c.suggestion) : nameOf(c))), el('p', 'ft-fun', esc(benefitOf(c))));
            b.append(configureLine(c));
            const op = works(c) ? [] : (c.unlocks ?? []).map(byId).filter(Boolean);
            if (op.length && c.suggestion) {
                const al = el('div', 'ft-also');
                for (const x of op) { const th = el('span', 'ft-thumb', ic(LOOK[x.id]?.[0] ?? 'sparkle')); th.style.setProperty('--h', LOOK[x.id]?.[1] ?? 40); al.append(th); }
                al.append(el('span', '', `${esc(w('features-unlocks', 'Also unlocks'))}${esc(colon())}<b>${op.map((x) => esc(nameOf(x))).join(', ')}</b>`)); b.append(al);
            }
            if (c.status === 'problem' && c.repair) { const r = el('div', 'ft-row'); r.append(btn(esc(w(`features-r-${c.repair.label}`, c.repair.label)), 'ft-go', () => { void repair(c); })); b.append(r); }
            else if (c.suggestion && !c.blockedBy.length) b.append(gesture(c, true));
            else if (c.suggestion) b.append(el('div', 'ft-also', `${ic('lock')} ${esc(afterWord(c))}`));
            else b.append(btn(`${ic('check')} ${esc(w('features-details', 'Details in Settings'))} ›`, 'as-link ft-details', () => { void env.open('settings', { chapter: c.chapter }); }));
            if (!isNext && nx) b.append(btn(esc(w('features-back-next', '✦ Back to your next step')), 'as-link ft-backnext', () => pick(null)));
            f.append(b); inner.append(f);
            inner.append(el('div', 'ft-face back', `${ic('check')}<b>${esc(w('features-unlocked', 'Unlocked!'))}</b><span>${esc(nameOf(c))}</span>`));
            h.append(inner);
            return h;
        }
        function stepRow(c, i) {
            const st = stateOf(c); const r = el('div', `ft-srow ${st.k}`); r.style.setProperty('--i', i);
            if (S.fx?.freed?.includes(c.id)) r.classList.add('pop');
            if (S.sel === c.id) r.setAttribute('aria-current', 'true');
            const th = el('span', 'ft-thumb', ic(LOOK[c.id]?.[0] ?? 'sparkle')); th.style.setProperty('--h', LOOK[c.id]?.[1] ?? 40); r.append(th);
            const word = st.k === 'locked' ? ic('lock') + esc(st.word) : `${esc(nameOf(c))} · <span class="chip">${esc(effortOf(c.suggestion.effort))}</span>`;
            r.append(btn(`<b>${esc(labelOf(c.suggestion))}</b><span>${word}</span>`, 'ft-sm', () => pick(c.id)));
            if (S.keyOpen === c.id && S.sel !== c.id) r.append(gesture(c, false));
            else if (!c.blockedBy.length) { const g = btn(esc(S.busy === c.id ? w('features-testing', 'Testing…') : buttonOf(c.suggestion)), '', (e) => { void act(c, c.suggestion, e.currentTarget); }); g.disabled = Boolean(S.busy); r.append(g); }
            return r;
        }
        function stepList() {
            const box = el('div'); const shown = S.sel || nextCap()?.id;
            const rest = steps().filter((x) => x.id !== shown);
            if (rest.length) {
                box.append(el('h3', '', `${esc(w('features-other-steps', 'Other steps'))} · ${rest.length}`));
                const list = el('div', 'ft-srows'); const first = S.moreOpen ? rest : rest.slice(0, 3);
                first.forEach((c, i) => list.append(stepRow(c, i))); box.append(list);
                if (rest.length > 3) { const m = btn(esc(S.moreOpen ? w('features-fewer', 'Fewer') : w('features-n-more', '{n} more steps', { n: rest.length - 3 })), 'as-link ft-more-t', () => { S.moreOpen = !S.moreOpen; render(); }); m.setAttribute('aria-expanded', String(S.moreOpen)); box.append(m); }
            }
            const hl = hiddenLine(); if (hl) box.append(hl);
            return box;
        }
        function combo(host, key, enter) {
            const g = el('div', 'ft-combo');
            const cc = el('div', 'ft-c-card'); const cl = el('div', 'ft-c-list'); const chs = el('div', 'ft-c-house');
            g.append(cc, cl, chs); host.append(g);
            cc.append(hero(enter)); cl.append(stepList());
            chs.append(legend()); const holder = el('div'); chs.append(holder); houseIn(holder, { enter, sheep: true, key });
        }
        const cHead = () => { const h = el('div', 'ft-c-head'); h.append(el('h2', '', esc(litOf())), el('p', '', esc(friendly()))); return h; };

        /* ---- THE THREE PLACES ---- */
        function shareLine(host) {
            const on = S.data?.sharing?.on !== false;
            const line = el('div', 'ft-share');
            const sw = btn('', 'ft-sw', async () => { const now = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(now)); try { const r = await env.post(`${env.API}/features/sharing`, { on: now }); S.data.sharing = r; } catch { sw.setAttribute('aria-checked', String(!now)); } });
            sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on)); sw.setAttribute('aria-labelledby', 'ft-share-lbl');
            const lb = el('span', 'ft-lbl', esc(w('features-share-t', 'Help improve Clavarium by sharing anonymous usage information'))); lb.id = 'ft-share-lbl';
            const see = btn(esc(w('features-share-see', 'See what is sent')), 'as-link', () => { S.seeSent = !S.seeSent; render(); }); see.setAttribute('aria-expanded', String(S.seeSent)); see.setAttribute('aria-controls', 'ft-sent');
            line.append(sw, lb, see); host.append(line);
            if (S.seeSent) {
                const c = S.data?.counts ?? {};
                const pre = el('pre', 'ft-sent', esc(JSON.stringify({ day: new Date().toISOString().slice(0, 10), counts: { 'features.ready': c.ready ?? 0, 'features.total': c.total ?? 0 } }, null, 2)));
                pre.id = 'ft-sent'; host.append(pre, el('p', 'ft-sent-note', esc(w('features-share-note', 'Counts only, never names. Nothing is sent yet: only your choice is kept.'))));
            }
        }
        async function welcomeDone(then) { await send('welcome', {}).catch(() => {}); S.step = 1; env.welcomed?.(); await then?.(); }
        function welcome(m, enter) {
            if (S.step === 1) {
                const g = el('div', 'ft-w1');
                const hello = el('div', 'ft-hello'); const sh = sheep(enter && !reduced() ? 'asleep' : '', 120); hello.append(sh);
                const tx = el('div'); tx.append(el('h2', '', esc(w('features-hello', 'Welcome home.'))), el('p', '', esc(w('features-hello-p', 'Your assistants live here. Pick what you want: the right rooms light up.')))); hello.append(tx);
                if (enter && !reduced()) setTimeout(() => { sh.classList.remove('asleep'); sh.classList.add('waking'); setTimeout(() => sh.classList.remove('waking'), 1600); }, 900);
                const hs = el('div', 'ft-w-house'); const pk = el('div', 'ft-w-pick');
                g.append(hello, hs, pk); m.append(g);
                pk.append(el('h3', 'ft-q', esc(w('features-want-q', 'What would you like to do?'))), el('p', 'chapter-about', esc(w('features-want-hint', 'Pick one or more. You can change later.'))));
                const gr = el('div', 'ft-goals'); const chosen = goalsNow();
                GOALS.forEach((x, i) => {
                    const b = btn(`<span class="ft-gi" style="--h:${x[2]}">${ic(x[1])}</span><span class="ft-gl">${esc(goalLabel(x))}</span><span class="ft-tick">${ic('check')}</span>`, 'ft-goal', () => { void toggleGoal(x[0]); });
                    b.style.setProperty('--i', i); if (!enter) b.style.animation = 'none'; b.setAttribute('aria-pressed', String(chosen.has(x[0]))); gr.append(b);
                });
                pk.append(gr);
                const acts = el('div', 'ft-acts');
                acts.append(btn(esc(w('features-continue', 'Continue')), 'ft-go', () => { S.step = 2; render(); }), btn(esc(w('features-skip', 'Skip')), 'as-link', () => { void welcomeDone(); }));
                pk.append(acts); const imp = el('div', 'ft-acts'); imp.append(importChoice()); pk.append(imp);
                shareLine(pk);
                hs.append(legend()); const holder = el('div'); hs.append(holder); houseIn(holder, { enter, want: true, preview: true, key: 'w1' });
            } else {
                m.append(cHead(), problemCallouts()); combo(m, 'w2', enter);
                const acts = el('div', 'ft-acts');
                acts.append(btn(esc(w('features-create-conv', 'Create a conversation')), '', () => { void welcomeDone(() => env.open('new')); }), btn(esc(w('features-back', 'Back')), 'as-link', () => { S.step = 1; render(); }), btn(esc(w('features-skip', 'Skip')), 'as-link', () => { void welcomeDone(); }));
                m.append(acts);
            }
        }
        function miniHouse() {
            const cols = 6; let s = '<svg class="ft-mh" viewBox="0 0 118 64" aria-hidden="true"><path class="ft-mshell" d="M4 22 L59 2 L114 22 V62 H4 Z"/>';
            const nx = nextCap(); const ids = ROOMS.filter((id) => byId(id));
            ids.forEach((id, i) => { const c = byId(id); const x = 12 + (i % cols) * 16; const y = 28 + Math.floor(i / cols) * 16;
                const cls = works(c) ? 'on' : nx?.id === id ? 'nx' : ''; s += `<rect class="ft-win ${cls}${S.fx?.lit === id ? ' just' : ''}" x="${x}" y="${y}" width="11" height="11" rx="2"/>`; });
            return `${s}</svg>`;
        }
        function banner(m) {
            const nx = nextCap(); const quick = steps().filter((c) => !c.blockedBy.length && (c.suggestion.effort === '2 clicks'));
            const anyProblem = problems().length > 0;
            if (!S.data?.home?.show) return;
            if (!nx && !anyProblem) return;
            m.append(problemCallouts());
            if (!nx) return;
            const b = el('section', 'ft-banner'); b.setAttribute('aria-label', w('features-your-next', 'Your next step'));
            const mini = el('div', 'ft-mini'); mini.append(sheep('', 52, 'var(--panel)')); mini.insertAdjacentHTML('beforeend', miniHouse());
            const tx = el('div', 'ft-txt'); tx.append(el('b', '', `<span class="ft-star">✦</span> ${esc(labelOf(nx.suggestion))} · ${esc(effortOf(nx.suggestion.effort))}`));
            const sub = el('span', '', esc(benefitOf(nx))); tx.append(sub);
            const more = quick.filter((c) => c.id !== nx.id);
            if (more.length) { sub.append(' · '); const l = btn(esc(w('features-and-more', 'and {n} more', { n: Math.min(3, more.length) })), 'as-link', () => { S.bannerOpen = !S.bannerOpen; render(); }); l.setAttribute('aria-expanded', String(S.bannerOpen)); sub.append(l); }
            tx.append(el('div', 'ft-count', esc(litOf())));
            const ba = el('div', 'ft-bact'); const go = btn(esc(S.busy === nx.id ? w('features-testing', 'Testing…') : buttonOf(nx.suggestion)), 'ft-go', (e) => { void act(nx, nx.suggestion, e.currentTarget); }); go.disabled = Boolean(S.busy);
            ba.append(go, btn(ic('x'), 'icon-btn ft-x', () => { void send('dismiss', { id: 'home' }).then(() => toast(w('features-banner-hidden', 'Suggestions hidden until something new comes up.'))).catch(() => {}); }, w('features-not-for-me', 'Not for me')));
            b.append(mini, tx, ba); m.append(b);
            if (S.bannerOpen) {
                const box = el('div', 'ft-more');
                for (const c of more.slice(0, 3)) { const r = el('div', 'ft-more-row', `${ic(LOOK[c.id]?.[0] ?? 'sparkle')}<b>${esc(labelOf(c.suggestion))}</b><span class="chip">${esc(effortOf(c.suggestion.effort))}</span>`); const g = btn(esc(S.busy === c.id ? w('features-testing', 'Testing…') : buttonOf(c.suggestion)), '', (e) => { void act(c, c.suggestion, e.currentTarget); }); g.disabled = Boolean(S.busy); r.append(g); box.append(r); }
                m.append(box);
            }
        }
        function settings(m, enter) {
            m.append(problemCallouts(), goalChips());
            const holder = el('div'); m.append(holder); combo(holder, 's', enter);
        }

        /* ---- RENDER: each place mounted, again on each change ---- */
        function render() {
            for (const [host, mode] of S.places) {
                if (!host.isConnected) { S.places.delete(host); continue; }
                const key = `${mode}/${S.step}`; const enter = !S.entered.has(key) && !reduced(); S.entered.add(key);
                const m = el('div', `ft ft-${mode}`);
                if (!S.data) { host.replaceChildren(); continue; }
                if (mode === 'welcome') welcome(m, enter); else if (mode === 'home') banner(m); else settings(m, enter);
                host.replaceChildren(m);
                host.hidden = !m.childElementCount;
            }
            S.fx = null;
        }
        let rz; let lastW = innerWidth;
        addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 20) { lastW = innerWidth; render(); } }, 150); });
        return {
            /* Shown in `host` as `mode` ('welcome' | 'home' | 'settings'); read again from the server. */
            async mount(host, mode) { S.places.set(host, mode); try { await load(); } catch { S.data = null; } render(); return S.data; },
            /* Shown with what was last read (no request). */
            show(host, mode) { S.places.set(host, mode); render(); },
            unmount(host) { S.places.delete(host); },
            async refresh() { try { await load(); } catch { /* kept as it was */ } render(); return S.data; },
            data: () => S.data,
        };
    };
})();
