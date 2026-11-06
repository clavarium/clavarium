/* The page: a list of conversations, and the terminal of one of them.
   It draws what the tool prints and sends what the person types. It reads
   neither: no link is made clickable, no output becomes a card. */
(() => {
    const CLOSE_ENDED = 1000;
    const CLOSE_TAKEN = 4001;
    const CLOSE_FAILED = 1011;
    const RETRY_MS = 1500;
    const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
    /* What each key of the row sends, as a terminal expects it. */
    const KEYS = { esc: '\x1b', tab: '\t', enter: '\r', stop: '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', backspace: '\x7f' };
    /* Held down, these repeat as on a real keyboard: at once, then after a
       pause, then quickly, until the finger lifts or leaves the key. */
    const REPEATING = new Set(['up', 'down', 'left', 'right', 'tab', 'enter', 'backspace']);
    const REPEAT_AFTER_MS = 400;
    const REPEAT_EVERY_MS = 60;

    /* A paired device gets the same page with less in it, and asks its own
       door: see server/door.mjs. */
    const DEVICE = document.documentElement.dataset.door === 'device';
    /* THE KIT (kit.js): the pieces every screen shares -- the state's point, the conversation's card... */
    const KIT = window.clavariumKit;
    /* On a paired device, every request names the pairing it speaks for:
       the address is completed once the device has signed in. */
    let API = DEVICE ? '/c/api' : '/api';
    let pairing = '';
    let deviceShared = [];
    /* The parts of its conversation this device was given: its terminal, its
       chat ('write', 'read' or null). Only those are shown -- and the server
       refuses the others whatever this page does. Nothing until the server said (/me): a
       terminal button shown before that was a terminal the device had not been given. */
    let deviceParts = { terminal: false, chat: null };
    /* What Parley mounted for the chat screen, and for which conversation. */
    let thread = null;
    let threadOf = '';
    const noTerminal = () => DEVICE && !deviceParts.terminal;
    /* A phone: what needs a wide screen (the Machine chapter's sizes) is not offered there. */
    const narrow = () => matchMedia('(max-width: 700px)').matches;
    /* THE LIST'S WIDTH, on this device: between LIST_MIN and LIST_MAX (never more than half the window). */
    const LIST_WIDTH = 'clavarium-list-width'; const LIST_MIN = 200; const LIST_MAX = 560; const LIST_USUAL = 260;
    const listWidth = (px) => {
        const w = Math.round(Math.max(LIST_MIN, Math.min(LIST_MAX, innerWidth / 2, px)));
        document.getElementById('app')?.style.setProperty('--list-width', `${w}px`);
        const handle = document.getElementById('list-resize');
        if (!handle) return w;
        handle.setAttribute('aria-valuenow', String(w)); handle.setAttribute('aria-valuemin', String(LIST_MIN)); handle.setAttribute('aria-valuemax', String(LIST_MAX));
        return w;
    };
    const keepWidth = (w) => { try { if (w === LIST_USUAL) localStorage.removeItem(LIST_WIDTH); else localStorage.setItem(LIST_WIDTH, String(w)); } catch { /* this page only */ } };
    (() => {
        /* A page with no list of its own (a device's) has nothing to widen. */
        const handle = document.getElementById('list-resize');
        if (!handle) return;
        let kept = LIST_USUAL; try { kept = Number(localStorage.getItem(LIST_WIDTH)) || LIST_USUAL; } catch { /* none */ }
        /* What the person chose, kept apart from what the window allows: a narrower window (a tablet turned) narrows the list for a while, not for good. */
        let chosen = kept;
        listWidth(kept);
        let drag = null;
        handle.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { id: e.pointerId }; handle.setPointerCapture(e.pointerId); handle.dataset.dragging = 'true'; e.preventDefault(); });
        handle.addEventListener('pointermove', (e) => { if (!drag || e.pointerId !== drag.id) return; listWidth(e.clientX - document.getElementById('app').getBoundingClientRect().left); });
        const end = (e) => { if (!drag || e.pointerId !== drag.id) return; drag = null; delete handle.dataset.dragging; chosen = Number(handle.getAttribute('aria-valuenow')); keepWidth(chosen); };
        handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
        handle.addEventListener('dblclick', () => { chosen = listWidth(LIST_USUAL); keepWidth(chosen); });
        handle.addEventListener('keydown', (e) => {
            const now = Number(handle.getAttribute('aria-valuenow')) || LIST_USUAL;
            const to = e.key === 'ArrowLeft' ? now - 16 : e.key === 'ArrowRight' ? now + 16 : e.key === 'Home' ? LIST_MIN : e.key === 'End' ? LIST_MAX : e.key === 'Enter' ? LIST_USUAL : null;
            if (to === null) return;
            e.preventDefault(); chosen = listWidth(to); keepWidth(chosen);
        });
        addEventListener('resize', () => listWidth(chosen));
    })();
    /* On the device page some controls do not exist; what would have been
       done to them is done to a detached element instead, and is lost. */
    const $ = (id) => document.getElementById(id) ?? document.createElement('div');
    const app = $('app');
    const state = $('state');
    const notice = $('notice');
    let current = new URLSearchParams(location.search).get('c') || '';
    let home = false;            /* true when this server manages VMs */
    let conversations = [];
    let socket;
    let wanted = false;          /* false while we closed the socket on purpose */
    let pollTimer;
    /* AN UPDATE OR A RESTART (deploy/maintenance.html): the server says an update is about to stop
       it (server/updates.mjs, notice), or the front says it is down: the page gives way to the
       maintenance page, which comes back here by itself once the server answers again. And a page
       older than the server (it slept through an update) starts again on the new one. True when
       the page is leaving. */
    let serverVersion = '';
    const leaving = (r) => {
        const update = r.headers.get('x-clavarium-update') ?? '';
        if (update || r.headers.get('x-clavarium-down')) {
            const [kind, to] = update ? update.split(' ') : ['', ''];
            location.replace(`${DEVICE ? '/c' : ''}/maintenance.html?${new URLSearchParams({ kind, ...(to ? { to } : {}), back: location.pathname + location.search })}`);
            return true;
        }
        const version = r.headers.get('x-clavarium-version') ?? '';
        if (version && serverVersion && version !== serverVersion) { location.reload(); return true; }
        serverVersion ||= version;
        return false;
    };

    const say = (label, kind) => { state.textContent = label; state.dataset.state = kind; };
    /* THE MASCOT (02-11): a small animal drawn above the words while a conversation goes to sleep, sleeps,
       or wakes. All of it is HERE -- the drawing -- and in style.css under .mascot -- its poses: another
       animal, or other movements, is changed in one place. Poses: 'asleep' (lies, eyes shut, breathes, z's),
       'waking' (rises in one movement, an ear flick, a blink), '' (standing). A device asking for less
       motion sees still pictures. */
    const scallops = (cx, cy, rx, ry, n, depth) => {
        let d = '';
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2; const x = cx + rx * Math.cos(a); const y = cy + ry * Math.sin(a);
            if (i === 0) { d += `M${x.toFixed(1)} ${y.toFixed(1)}`; continue; }
            const m = ((i - 0.5) / n) * Math.PI * 2;
            d += ` Q${(cx + (rx + depth) * Math.cos(m)).toFixed(1)} ${(cy + (ry + depth) * Math.sin(m)).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }
        return `${d} Z`;
    };
    const MASCOTS = {
        sheep: () => `<svg viewBox="0 0 150 112" aria-hidden="true">
            <g class="m-legs"><path class="m-line m-leg" d="M46 82 l-1 16 h4"/><path class="m-line m-leg" d="M60 85 l0 14 h4"/><path class="m-line m-leg" d="M84 85 l0 14 h4"/><path class="m-line m-leg" d="M97 82 l1 16 h4"/></g>
            <g class="m-body">
              <path class="m-line m-fill" d="${scallops(72, 62, 42, 27, 14, 9)}"/>
              <path class="m-soft" d="M52 56 q4 -6 8 0"/><path class="m-soft" d="M70 48 q4 -6 8 0"/><path class="m-soft" d="M60 70 q4 -6 8 0"/><path class="m-soft" d="M80 66 q4 -6 8 0"/>
              <g class="m-head">
                <path class="m-line m-fill m-ear" d="M110 47 c-4 -6 -12 -8 -17 -5 c4 5 11 7 17 5 z"/>
                <path class="m-line m-fill" d="M106 44 c8 -6 20 -2 24 10 c3 9 2 18 -4 22 c-5 3 -12 1 -16 -4 c-5 -6 -8 -14 -6 -22 z"/>
                <path class="m-line m-fill" d="${scallops(114, 43, 9, 4.5, 6, 3.5)}"/>
                <ellipse class="m-eye" cx="120" cy="53" rx="2.1" ry="2.7"/>
                <path class="m-shut" d="M117 54 q3 2.4 6 0"/>
                <ellipse class="m-blush" cx="117" cy="62" rx="3.4" ry="2.1"/>
                <path class="m-line m-thin" d="M126 70 q-2 2 -4 1"/>
              </g>
            </g>
          </svg>`,
    };
    const MASCOT = 'sheep';
    const mascot = (pose) => {
        let m = document.getElementById('notice-mascot');   /* not $(): it gives a stand-in when there is none */
        if (pose === null) { if (m) m.hidden = true; return; }
        if (!m) {
            m = document.createElement('div'); m.id = 'notice-mascot'; m.className = 'mascot';
            m.innerHTML = `${MASCOTS[MASCOT]()}<span class="m-z">z</span><span class="m-z">z</span><span class="m-z">z</span>`;
            $('notice-text').before(m);
        }
        m.hidden = false;
        const was = m.dataset.pose ?? '';
        /* Trying to wake (03-11): it lifts its head, and lies back, again, until it is up (a restart, a build). */
        if (pose === 'trying') { m.classList.remove('waking', 'stirring', 'asleep'); m.classList.add('trying'); m.dataset.pose = 'trying'; return; }
        /* From trying to waking (03-11, no jolt): wait till its head lies down again -- the end of a try, the
           very pose it wakes from -- then rise. At most one try's length (with less motion: no try, no wait). */
        if (pose === 'waking' && was === 'trying') {
            if (m.dataset.rising) return;
            m.dataset.rising = 'yes';
            /* Where it is in its try (2.6 s: lying until 15 %, lying again from 80 %), read from the animation itself. */
            const tryNow = m.querySelector('.m-head')?.getAnimations?.().find((x) => x.animationName === 'm-try');
            const at = Number(tryNow?.currentTime ?? 0) % 2600;
            const rise = () => { delete m.dataset.rising; m.dataset.pose = 'tried'; mascot('waking'); };
            if (at <= 390 || at >= 2080) rise(); else setTimeout(rise, 2080 - at);
            return;
        }
        m.classList.remove('trying');
        if (pose === 'waking') {
            if (was === 'waking') return;
            /* From lying, in one movement: the breathing stops first, then it rises. */
            m.classList.add('asleep', 'stirring'); m.dataset.pose = 'waking';
            requestAnimationFrame(() => requestAnimationFrame(() => { m.classList.remove('asleep'); m.classList.add('waking'); }));
            return;
        }
        m.classList.remove('waking', 'stirring');
        m.classList.toggle('asleep', pose === 'asleep');
        m.dataset.pose = pose;
    };

    const show = (text, action, run, cancel) => {
        $('notice-text').textContent = text;
        $('notice-action').textContent = action ?? '';
        $('notice-action').hidden = !action;
        $('notice-action').onclick = run ?? null;
        $('notice-cancel').hidden = !cancel;
        $('notice-cancel').onclick = cancel ?? null;
        $('notice-health').hidden = true; $('notice-restart').hidden = true;
        notice.hidden = false;
        $('notice-spin').hidden = true; $('notice-steps').hidden = true;
        $('notice-head').hidden = true; delete notice.dataset.progress; delete notice.dataset.loading;
        mascot(null);
    };
    /* A terminal on its way: a neutral word and the wheel, nothing that sounds like a fault. It
       covers only when the terminal is what is on screen -- not the chat already there, which a tab
       resume (its channel reopened) used to blank behind "Loading the terminal..." (found 26-10). */
    const loading = () => { if (tabNow() !== 'terminal') return; show('Loading the terminal\u2026'); $('notice-spin').hidden = false; notice.dataset.loading = 'yes'; };
    /* A restart: when the page first saw it (when the server did not say), and the clock that tells it. */
    const restartSeen = new Map(); let restartTicking = 0;
    /* A START TOLD STEP BY STEP (a build, a restart, a wake: `progress`, see
       server/conversations.mjs): what it is, "Step 3 of 6" with the time so
       far, the step under way large with a wheel, those passed as one small
       line, those to come dimmed. The server gives each step a name; its
       words are here, three for each, so that a step never reads as done
       before it is: passed, a short past participle after a check mark
       ("Machine started"); under way, what is being done ("Starting the
       machine"); to come, the same words, grey, after an empty circle. The
       line of the list says what the panel says. `{tool}` is the tool's name. */
    const STEP_WORDS = {
        stopping: ['Machine stopped', 'Stopping the machine'],
        setting: ['Memory and disk set', 'Setting its memory and disk'],
        starting: ['Machine started', 'Starting the machine'],
        waking: ['Machine awake', 'Waking the machine'],
        preparing: ['Machine prepared', 'Preparing the machine'],
        installing: ['{tool} installed', 'Installing {tool}'],
        answering: ['Machine reached', 'Reaching the machine'],
        folders: ['Folders ready', 'Preparing its folders', 'Folders'],
        tool: ['{tool} started', 'Starting {tool}'],
        back: ['{tool} back as it was', 'Finding {tool} as it was'],
        resume: ['Last session resumed', 'Resuming its last session'],
        fresh: ['New session started', 'Starting a new session'],
        first: ['New session started', 'No earlier session: starting a new one', 'Starting a new session'],
    };
    const stepWords = (id, state, tool) => {
        const w = STEP_WORDS[id];
        const text = !w ? id : state === 'done' ? w[0] : state === 'later' ? (w[2] ?? w[1]) : w[1];
        return text.replaceAll('{tool}', tool || 'the tool');
    };
    /* The step under way, in the same words as the panel: for the line of the list. */
    const stepNow = (p, tool) => {
        if (!p || !Array.isArray(p.steps) || !p.steps.length) return '';
        const at = Math.min(Math.max(0, p.at ?? 0), p.steps.length - 1);
        const part = p.steps[at] === 'installing' ? /^(\d+)\/(\d+)$/.exec(p.detail ?? '') : null;
        return `${stepWords(p.steps[at], 'now', tool)}${part ? ` (${part[1]} of ${part[2]})` : ''}`;
    };
    const PROGRESS_TITLES = { build: 'Building its machine', restart: 'Restarting its machine', resize: 'Changing its machine', wake: 'Waking it up' };
    /* A build or a restart holds the page until its tool is there; a wake is the page's own opening. */
    const holds = (c) => Boolean(c?.progress) && (c.phase === 'building' || c.phase === 'restarting' || (c.phase === 'ready' && c.progress.kind !== 'wake'));
    const clockOf = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const usualFor = (kind, s) => {
        if (kind === 'build') return 'A new machine takes a few minutes. Nothing to do meanwhile: its terminal comes by itself.';
        if (kind === 'wake') return `${s < 180 ? 'A start usually takes a minute or two.' : 'This takes much longer than a start usually does.'} Its work, its files and its chat are kept.`;
        return `${s < 180 ? 'A restart usually takes one to two minutes.' : 'This is taking longer than usual: the machine may be slow to stop or to start. It goes on by itself.'} Its files and its chat are kept.`;
    };
    /* `source()`: the latest word of the server (its list, or the terminal opening). */
    const panel = { source: () => undefined, of: '', key: '', timer: 0, open: false };
    const paintProgress = () => {
        const p = panel.source();
        if (!p || !Array.isArray(p.steps) || notice.hidden || notice.dataset.progress === undefined) return false;
        const at = Math.min(Math.max(0, p.at ?? 0), p.steps.length - 1);
        const tool = conversations.find((x) => x.name === panel.of.split('/')[0])?.toolLabel ?? '';
        const key = `${p.kind}|${p.steps.join(',')}|${at}|${p.detail ?? ''}|${tool}`;
        if (key !== panel.key) {
            panel.key = key;
            const list = $('notice-steps'); list.replaceChildren(); list.hidden = false;
            p.steps.forEach((id, i) => {
                const li = document.createElement('li');
                const state = i < at ? 'done' : i === at ? 'now' : 'later';
                li.dataset.state = state;
                li.dataset.step = id;
                const words = stepWords(id, state, tool);
                if (i === at) {
                    const spin = document.createElement('span'); spin.className = 'spin'; spin.setAttribute('aria-hidden', 'true');
                    const label = document.createElement('span'); label.textContent = words;
                    li.append(spin, label);
                    /* Installing a tool: how far, as a small bar and "2 of 10", or that it came with the machine. */
                    if (id === 'installing' && p.detail) {
                        const part = /^(\d+)\/(\d+)$/.exec(p.detail);
                        const small = document.createElement('small');
                        if (part) {
                            const bar = document.createElement('progress'); bar.max = Number(part[2]); bar.value = Number(part[1]);
                            bar.setAttribute('aria-label', `${words}: ${part[1]} of ${part[2]}`);
                            small.append(bar, document.createTextNode(`${part[1]} of ${part[2]}`));
                        } else small.textContent = 'It came with the machine';
                        li.append(small);
                    }
                } else li.textContent = words;
                list.append(li);
            });
        }
        const s = Math.max(0, Math.floor((Date.now() - (Date.parse(p.since ?? '') || Date.now())) / 1000));
        $('notice-title').textContent = PROGRESS_TITLES[p.kind] ?? 'Starting';
        /* 03-11, less is more: the sheep trying to wake (a wake, a restart, a build), the step under way in one
           line; the list of the steps stays one tap away, and the usual time is said only when it is passed.
           It wakes for real at the last step only (03-11, his idea): until then, it tries. */
        mascot(at >= p.steps.length - 1 ? 'waking' : 'trying');
        $('notice-steps').hidden = !panel.open; $('notice-spin').hidden = true;
        $('notice-count').textContent = `${at + 1} / ${p.steps.length} \u00b7 ${clockOf(s)}`;
        $('notice-text').textContent = `${stepNow(p, tool)}${s >= 180 ? ` \u2014 ${usualFor(p.kind, s)}` : ''}`;
        return true;
    };
    /* Shown, or brought up to date when it is shown already (its wheel keeps turning). */
    $('notice-count').addEventListener('click', () => { panel.open = !panel.open; paintProgress(); });
    const progressPanel = (of, source) => {
        panel.source = source;
        if (notice.hidden || notice.dataset.progress === undefined || panel.of !== of) {
            show(''); panel.of = of; panel.key = '';
            notice.dataset.progress = 'on'; $('notice-head').hidden = false;
        }
        paintProgress();
        clearInterval(panel.timer);
        panel.timer = setInterval(() => { if (!paintProgress()) clearInterval(panel.timer); }, 1000);
    };
    const view = (which) => { app.dataset.view = which; };

    /* ---------- ONE WAY BACK ----------
       Everything that opens takes a step: a conversation picked in the list,
       a tab of it other than the one it opened on, an asset, a review, a
       place of the menu and what opens inside it, and what opens over the
       screen (one thing at a time). Back (the phone's, the browser's), Escape
       and the "<" links close the step on top, and nothing else. Each step is
       an entry of the history ({ nav: depth }); what closes it is kept here.
       A step the page closes itself (a link, another tab) is taken back from
       the history at once, and a step opened meanwhile waits for that. Steps
       this page did not make (a reload, an address from elsewhere) are
       walked by their address. `close({ quiet })`: quiet when what replaces
       it is drawn by whoever closed it; returning false keeps it open. */
    const nav = (() => {
        const steps = [];
        const depthOf = (state) => (Number.isInteger(state?.nav) && state.nav > 0 ? state.nav : 0);
        let base = depthOf(history.state);
        let waiting = 0; let later = []; let stuck;
        const write = (step) => { history.pushState({ nav: base + steps.indexOf(step) + 1 }, '', step.address ?? location.href); step.written = true; };
        const run = (job) => { if (waiting) later.push(job); else job(); };
        const flush = () => { clearTimeout(stuck); waiting = 0; const jobs = later; later = []; for (const job of jobs) job(); };
        const goBack = (n) => { if (n <= 0) return; waiting += 1; clearTimeout(stuck); stuck = setTimeout(flush, 1500); history.go(-n); };
        const shut = (step, how) => { try { return step.close(how); } catch (error) { console.error(error); return undefined; } };
        function push(kind, close, { address, name = '' } = {}) {
            const step = { kind, name, close, address, written: false };
            steps.push(step);
            run(() => { if (steps.includes(step)) write(step); });
            return step;
        }
        /* The steps from `at` up, closed by the page, and taken back from the
           history. `quiet`: what comes instead is drawn by the caller (another
           tab, another conversation); not quiet, each gives back what it covered. */
        function cut(at, { quiet = true, loud = false } = {}) {
            if (at < 0 || at >= steps.length) return;
            const bottom = steps[at];
            const gone = steps.splice(at).reverse();
            /* `loud`: only the step asked for gives back what it covered; those above it simply go. */
            for (const step of gone) shut(step, { quiet: loud ? step !== bottom : quiet });
            goBack(gone.filter((step) => step.written).length);
        }
        const last = (kinds) => steps.findLastIndex((step) => kinds.includes(step.kind));
        const first = (kinds) => steps.findIndex((step) => kinds.includes(step.kind));
        /* `outside`: Back or Forward to an entry this page did not make. */
        let outside = () => {};
        addEventListener('popstate', (event) => {
            if (waiting > 0) { waiting -= 1; if (waiting === 0) flush(); return; }
            const depth = depthOf(event.state) - base;
            if (depth < 0 || depth > steps.length) {
                for (const step of steps.splice(0).reverse()) shut(step, { quiet: true });
                base = depthOf(event.state);
                outside(event);
                return;
            }
            while (steps.length > depth) {
                const step = steps.pop();
                if (shut(step, { quiet: false, history: true }) === false) { steps.push(step); write(step); break; }
            }
        });
        return {
            push, cut, last, first,
            get size() { return steps.length; },
            top: () => steps.at(-1),
            has: (kind) => last([kind]) >= 0,
            step: (i) => steps[i],
            /* The address of what is shown, kept on the step it belongs to. */
            replace(address) { run(() => { const state = history.state ?? null; if ((location.search || location.pathname) !== address) history.replaceState(state, '', address); }); },
            /* The step on top, closed (Escape, a "<" link): false when there is none. */
            back() { if (steps.length === 0) return false; cut(steps.length - 1, { quiet: false }); return true; },
            /* Closes the step of that kind (and what is above it); false when there is none. */
            close(kind) { const i = last([kind]); if (i < 0) return false; cut(i, { loud: true }); return true; },
            /* OVER THE SCREEN: one thing at a time; `stack`: kept above another (a picture opened from the media of a chat). */
            over(name, close, { stack = false } = {}) {
                const there = steps.findIndex((step) => step.kind === 'over' && (!stack || step.name === name));
                if (there >= 0) cut(there);
                return push('over', close, { name });
            },
            drop(step) { const i = steps.indexOf(step); if (i >= 0) cut(i, { loud: true }); },
            dropOver(name) { const i = steps.findLastIndex((step) => step.kind === 'over' && step.name === name); if (i < 0) return false; cut(i, { loud: true }); return true; },
            set outside(f) { outside = f; },
        };
    })();
    /* Escape closes what is on top, as Back does -- never while typing (it
       leaves the field), never in the terminal (its tool needs Escape). */
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('#terminal')) return;
        if (target?.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]:not([contenteditable=false])')) { target.blur(); return; }
        if (nav.back()) event.preventDefault();
    });

    /* ---------- the terminal ---------- */
    const terminal = new Terminal({
        cursorBlink: true, scrollback: 5000,
        fontSize: innerWidth < 500 ? 11 : 14,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: { background: '#0f141a' },
        /* A link the tool sends as a link (OSC 8): a web address opens in a new
           tab, with no way back to this page; anything else is not followed. */
        linkHandler: { activate: (_event, uri) => openWeb(uri), allowNonHttpProtocols: false },
    });
    /* A web address on screen opens in a new tab, on its own: nothing of this
       page is handed to it. Only http and https. */
    function openWeb(uri) {
        let url;
        try { url = new URL(uri); } catch { return; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        window.open(url.href, '_blank', 'noopener,noreferrer');
    }
    /* ---------- the list of conversations, folded away or not ---------- */
    /* One click hides it and the terminal takes the room; one click brings
       it back. Kept on this device. */
    /* THE TOP BAR, ONE COMPONENT (03-11): every page has the conversation's bar -- the button that shows or hides the
       list on its left, a state's dot when there is one, its title, and on its right what that page offers (a
       conversation: Chat, Terminal, Assets, Binders, its settings; a room: its settings; the others: their own
       controls). Built once here from each page's top line: the same element, the same looks, the same place. */
    function topBar(top, { state = null } = {}) {
        const bar = document.createElement('header'); bar.className = ['topbar', ...[...top.classList].filter((c) => c !== 'panel-top')].join(' ');
        const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'fold-here'; fold.title = 'Hide or show the list of conversations';
        fold.addEventListener('click', () => $('fold').click());
        bar.append(fold);
        if (state) { const dot = document.createElement('span'); dot.className = 'bar-state'; dot.id = state; dot.setAttribute('aria-hidden', 'true'); bar.append(dot); }
        const title = top.querySelector(':scope > b'); if (title) bar.append(title);
        const right = document.createElement('div'); right.className = 'bar-right';
        right.append(...[...top.childNodes].filter((n) => n.nodeType === 1));
        bar.append(right);
        top.replaceWith(bar);
        return bar;
    }
    for (const top of [...document.querySelectorAll('#places .sheet > .panel-top')]) topBar(top, top.parentElement.id === 'salon' ? { state: 'salon-state' } : {});
    /* A SEARCH ATOP A SETTINGS PAGE (05-11): one field in its top bar; what is typed keeps only the chapters (or
       blocks) whose title or rows say it, opened; the headings left with nothing are hidden. Emptied, all comes back
       as it was. The server's Settings, a conversation's, and any sheet given the same shape. */
    const settingsSearch = (sheet) => {
        const bar = sheet?.querySelector(':scope > header.topbar .bar-right') ?? sheet?.querySelector(':scope > header.topbar') ?? sheet?.querySelector(':scope > .panel-top');
        if (!bar || sheet.querySelector('.settings-search')) return;
        const field = document.createElement('input'); field.type = 'search'; field.className = 'settings-search';
        field.placeholder = 'Search'; field.setAttribute('aria-label', 'Search these settings'); field.autocomplete = 'off';
        bar.prepend(field);
        const items = () => {
            const chapters = [...sheet.querySelectorAll('details.chapter')];
            return chapters.length ? chapters : [...sheet.querySelectorAll(':scope > :not(header.topbar):not(.panel-top)')].filter((e) => e.querySelector(':scope > .panel-top'));
        };
        const wasOpen = new Map(); const wasHidden = new Map();
        const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        field.addEventListener('input', () => {
            const q = norm(field.value.trim());
            sheet.dataset.searching = q ? 'on' : '';
            for (const it of items()) {
                if (!q) { it.hidden = wasHidden.get(it) ?? it.hidden; wasHidden.delete(it); for (const row of it.querySelectorAll('.search-out')) row.classList.remove('search-out'); if (it.tagName === 'DETAILS' && wasOpen.has(it)) { it.open = wasOpen.get(it); wasOpen.delete(it); } continue; }
                if (!wasHidden.has(it)) wasHidden.set(it, it.hidden);
                const hit = !wasHidden.get(it) && norm(it.textContent).includes(q);
                it.hidden = !hit;
                /* Within a chapter whose title does not say it: only its rows that do. */
                const head = it.querySelector(':scope > summary, :scope > .panel-top');
                const whole = !head || norm(head.textContent).includes(q);
                for (const row of it.querySelectorAll('.set-row')) row.classList.toggle('search-out', hit && !whole && !norm(row.textContent).includes(q));
                if (hit && it.tagName === 'DETAILS') { if (!wasOpen.has(it)) wasOpen.set(it, it.open); it.open = true; }
            }
            for (const group of sheet.querySelectorAll('.settings-group')) group.hidden = Boolean(q) && ![...group.querySelectorAll('details.chapter')].some((d) => !d.hidden);
        });
        field.addEventListener('keydown', (e) => { if (e.key === 'Escape' && field.value) { e.stopPropagation(); field.value = ''; field.dispatchEvent(new Event('input')); } });
    };
    for (const id of ['settings', 'panel']) settingsSearch($(id));
    /* A room's title: its name, and under it who speaks now (salonLive). */
    /* The device page (/c/) has no rooms sheet (05-11: it stopped app.js there, the page stuck on connecting). */
    if ($('salon')) { const t = $('salon-title'); const name = document.createElement('span'); name.id = 'salon-name'; name.textContent = t.textContent; const live = document.createElement('small'); live.id = 'salon-live'; live.className = 'salon-live'; live.hidden = true; t.replaceChildren(name, live); }
    /* A room's settings: on its bar's right, in the same group of views a conversation's settings sit in. */
    if ($('salon')) { const views = document.createElement('div'); views.className = 'views'; views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Room'); views.append($('salon-settings')); $('salon').querySelector('.topbar .bar-right')?.prepend(views); }
    const applyFold = (folded) => {
        app.dataset.list = folded ? 'folded' : 'open';
        for (const f of [$('fold'), ...document.querySelectorAll('.fold-here')]) {
            f.textContent = folded ? '\u00bb' : '\u00ab';
            f.setAttribute('aria-pressed', String(folded));
            f.setAttribute('aria-label', folded ? 'Show the list of conversations' : 'Hide the list of conversations');
        }
    };
    /* Folded by default: the list takes room few need all the time; the fold is remembered, so opening it
       keeps it open (a person who wants it open sets it once). Open only when that choice was remembered. */
    let listFolded = true;
    try { listFolded = localStorage.getItem('clavarium-list') !== 'open'; } catch { /* a private window */ }
    /* PINNED OPEN (the pin at the top of the list): it stays open, even when a conversation is opened.
       Folding it by hand takes the pin out. Kept on this device. */
    let listPinned = false;
    try { listPinned = localStorage.getItem('clavarium-list-pin') === 'on'; } catch { /* a private window */ }
    if (listPinned) listFolded = false;
    const paintPin = () => {
        $('list-pin').setAttribute('aria-pressed', String(listPinned));
        const label = listPinned ? 'The list stays open: click to let it fold when a conversation is opened' : 'Keep the list open: it no longer folds when a conversation is opened';
        $('list-pin').title = label; $('list-pin').setAttribute('aria-label', listPinned ? 'Unpin the list' : 'Keep the list open');
    };
    const pin = (on) => {
        listPinned = on;
        try { localStorage.setItem('clavarium-list-pin', on ? 'on' : 'off'); } catch { /* as above */ }
        paintPin();
    };
    paintPin();
    if (DEVICE) $('list-pin').hidden = true;
    $('list-pin').addEventListener('click', () => { pin(!listPinned); if (listPinned && listFolded) $('fold').click(); });
    /* THE LIST SLIDES, THE PAGE IS LAID OUT ONCE. Animating the grid's columns laid the whole page out (and
       redrew the terminal) at every frame: it stuttered. The columns change once, the room taking the whole
       width (its far side off the screen), and the list, the menu and the room slide -- transforms, which cost
       nothing -- so nothing is left blank, and nothing jumps at the end. */
    const sliders = () => ['list', 'nav'].map((id) => $(id)).filter(Boolean);
    const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || window.innerWidth <= 700;
    $('fold').addEventListener('click', async () => {
        listFolded = !listFolded;
        if (listFolded && listPinned) pin(false);
        try { localStorage.setItem('clavarium-list', listFolded ? 'folded' : 'open'); } catch { /* as above */ }
        const folded = listFolded;
        if (still()) { applyFold(folded); fit.fit(); focusTerminal(); return; }
        /* ONE layout, up front: the final columns and the terminal's new size are set first, while the panel is
           held over the room (.sliding). Only transforms animate then -- the room never changes width mid-slide,
           so nothing is recomputed at the end (the open no longer "catches up" to the panel). */
        app.classList.add('sliding');
        const width = $('list').getBoundingClientRect().width;
        applyFold(folded); fit.fit();
        const how = { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' };
        const listFrames = folded ? [{ transform: 'none' }, { transform: 'translateX(-100%)' }]
                                  : [{ transform: 'translateX(-100%)' }, { transform: 'none' }];
        const moving = sliders().map((e) => e.animate(listFrames, how));
        /* Opening: the room starts shifted left over the list's place, then slides right into its final column. */
        if (!folded) moving.push($('room').animate([{ transform: `translateX(${-width}px)` }, { transform: 'none' }], how));
        await Promise.all(moving.map((a) => a.finished.catch(() => {})));
        app.classList.remove('sliding');
        if (listFolded !== folded) return;
        focusTerminal();
    });

    /* ---------- light or dark ---------- */
    /* A choice of this screen, kept on this device. The TOOL has its own
       colours: one made for a dark screen should be told the screen is light
       (in Claude Code: /theme). */
    const DARK = { background: '#0f141a' };
    const LIGHT = {
        background: '#fbfbfa', foreground: '#17202b', cursor: '#17202b', cursorAccent: '#fbfbfa', selectionBackground: '#b9d2f5',
        black: '#17202b', red: '#b3261e', green: '#1f7a3d', yellow: '#8a6100', blue: '#1d4fbf', magenta: '#8b2fa8', cyan: '#0f6f7d', white: '#5d6876',
        brightBlack: '#6b7684', brightRed: '#c9372c', brightGreen: '#23863f', brightYellow: '#9a6c00', brightBlue: '#2f63d6', brightMagenta: '#a23fc0', brightCyan: '#138496', brightWhite: '#2c3642',
    };
    const applyTheme = (light) => {
        document.documentElement.dataset.theme = light ? 'light' : 'dark';
        /* The chat's colours of meaning (notes, warnings, code) follow the page's theme, not the device's. */
        $('simple-thread').dataset.theme = light ? 'light' : 'dark';
        /* A room's thread is the same chat (Parley), in the same colours (03-11). */
        $('salon-thread').dataset.theme = light ? 'light' : 'dark';
        for (const view of document.querySelectorAll('.md-view')) view.dataset.theme = light ? 'light' : 'dark';
        terminal.options.theme = light ? LIGHT : DARK;
        document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? LIGHT.background : DARK.background);
        /* What is chosen, said by the choice pressed: never a button that names the other one. */
        for (const b of $('theme').children) b.setAttribute('aria-pressed', String(b.dataset.theme === themeChoice));
    };
    /* light, dark, or system (as the device says, and as it changes). */
    const systemLight = window.matchMedia?.('(prefers-color-scheme: light)');
    let themeChoice = 'dark';
    try { const kept = localStorage.getItem('clavarium-theme'); if (['light', 'dark', 'system'].includes(kept)) themeChoice = kept; } catch { /* a private window: the choice lasts as long as the page */ }
    const themeNow = () => (themeChoice === 'system' ? Boolean(systemLight?.matches) : themeChoice === 'light');
    applyTheme(themeNow());
    systemLight?.addEventListener?.('change', () => { if (themeChoice === 'system') applyTheme(themeNow()); });
    for (const b of $('theme').children) b.addEventListener('click', () => {
        themeChoice = b.dataset.theme;
        try { localStorage.setItem('clavarium-theme', themeChoice); } catch { /* as above */ }
        applyTheme(themeNow());
    });
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open($('terminal'));
    if (!DEVICE) applyFold(listFolded);
    fit.fit();
    window.clavariumTerminal = terminal; /* for the end-to-end proof */

    /* ---------- the on-screen keyboard, on demand ---------- */
    /* On a phone or a tablet, a finger on the terminal used to call the
       on-screen keyboard every time -- to scroll, to tap a path, to look --
       and it took half the screen from someone who did not want to type
       (said by the owner). The terminal still takes the focus, so the key
       row, the shortcuts, dictation and a real keyboard go on working; but
       the browser is told NOT to raise its keyboard (inputmode "none", the
       standard way, nothing to do with which tool runs). "Keyboard" raises
       it, and puts it away again.
       THE LOCK MUST HOLD ON EVERY PATH. The owner saw the keyboard come back
       "after some commands": the page itself put the focus in places that
       raise it (a field of a sheet, focused for the person), and a keyboard
       closed with the system's own button left the page believing it was
       still wanted, so the next tap on a key or a shortcut raised it again.
       Hence: the terminal is only ever focused through focusTerminal(),
       which applies the lock first; a field is only focused for the person
       through focusField(), which leaves it alone while the lock is on (a
       finger on the field still opens the keyboard); and the lock is
       re-applied whenever anything touches the helper field. Nothing is
       stored: every page load starts locked, the safe state. */
    const coarse = matchMedia('(any-pointer: coarse)');
    /* "any-pointer", not "pointer": a tablet with a trackpad or a mouse
       attached reports a fine primary pointer, yet its on-screen keyboard
       still comes up when the screen is touched. */
    let touchScreen = coarse.matches;
    let keyboardWanted = false;
    const keyboardLocked = () => touchScreen && !keyboardWanted;
    const applyKeyboard = () => {
        if (!touchScreen) return;
        const field = terminal.textarea;
        const mode = keyboardWanted ? 'text' : 'none';
        /* Written only when it differs: the watcher below sees every write. */
        if (field && field.getAttribute('inputmode') !== mode) field.setAttribute('inputmode', mode);
        const label = keyboardWanted ? 'Hide keyboard' : 'Keyboard';
        if ($('kbd').textContent === label && !$('kbd').hidden) return;
        $('kbd').hidden = false;
        $('kbd').setAttribute('aria-pressed', String(keyboardWanted));
        $('kbd').textContent = label;
    };
    /* The one way the page gives the terminal its focus back. */
    /* Where the chat is shown, it is the chat's box that takes what is typed:
       never a terminal out of sight. */
    const focusTerminal = () => {
        applyKeyboard();
        let box = null;
        try { box = chatBox(); } catch { /* the page is still being set up */ }
        if (box) { if (!touchScreen) box.focus({ preventScroll: true }); return; }
        terminal.focus();
    };
    /* A FIELD THE PERSON IS WRITING IN IS LEFT ALONE by what the page does on its own (a connection opened
       again, a conversation opened): the focus is not taken from it -- on a touch screen that would put the
       keyboard away under the finger (a word being corrected, a name being typed). */
    const writingIn = () => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || field === terminal.textarea || field.getClientRects().length === 0) return false;
        return field.isContentEditable || field.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), textarea, select');
    };
    const focusTerminalUnasked = () => { if (writingIn()) applyKeyboard(); else focusTerminal(); };
    /* A field the page would like to put the cursor in for the person. With
       the lock on it is only brought into sight: focusing it would raise the
       keyboard the person asked to keep away. A read-only field raises no
       keyboard, and is focused to select its text. */
    const focusField = (field) => {
        if (keyboardLocked() && !field.readOnly) { field.scrollIntoView?.({ block: 'nearest' }); return; }
        field.focus();
    };
    /* Should the terminal's helper field ever be replaced or have its hint
       changed (by the terminal library, by a reset), the lock is put back. */
    /* Only its small container is watched, not the whole terminal, whose
       rows change at every line printed. */
    const helpers = terminal.textarea?.parentElement;
    if (helpers) {
        new MutationObserver(() => applyKeyboard())
            .observe(helpers, { subtree: true, childList: true, attributes: true, attributeFilter: ['inputmode'] });
    }
    terminal.textarea?.addEventListener('focus', applyKeyboard);
    coarse.addEventListener?.('change', () => { touchScreen = touchScreen || coarse.matches; applyKeyboard(); });
    /* A keyboard closed by the system (its own "hide" key, the back button)
       says nothing to the page. Seen from here, the visible height grows back
       to full: the keyboard is then no longer wanted, and the lock is on
       again -- otherwise the next key, shortcut or reconnection that gives
       the terminal its focus would raise it once more. */
    let fullHeight = 0;
    let fullWidth = 0;
    let keyboardSeen = false;
    const watchViewport = () => {
        const vv = window.visualViewport;
        if (!vv || !touchScreen || Math.abs(vv.scale - 1) > 0.01) return;   /* zoomed in: the height says nothing */
        if (innerWidth !== fullWidth) { fullWidth = innerWidth; fullHeight = vv.height; keyboardSeen = false; return; }  /* turned: measure again */
        fullHeight = Math.max(fullHeight, vv.height);
        const open = vv.height < fullHeight - 120;
        if (open) { if (keyboardWanted) keyboardSeen = true; return; }
        if (keyboardSeen && keyboardWanted) { keyboardSeen = false; keyboardWanted = false; applyKeyboard(); }
    };
    window.visualViewport?.addEventListener('resize', watchViewport);
    watchViewport();
    applyKeyboard();
    $('kbd').addEventListener('click', () => {
        keyboardWanted = !keyboardWanted;
        keyboardSeen = false;
        /* A browser reads the hint when the field takes the focus: it is
           let go and taken again, so that the change is seen at once. */
        terminal.blur();
        focusTerminal();
    });

    const encoder = new TextEncoder();
    /* A message dictated into an AI tool's terminal starts with a microphone, once: before its first piece since the last Enter. */
    let markedSinceEnter = false;
    const send = (text) => {
        if (socket?.readyState === 1) socket.send(encoder.encode(text));
        /* Something was sent: the tool has its answer. */
        if (String(text).includes('\r')) { $('room').removeAttribute('data-asking'); markedSinceEnter = false; }
    };
    const sendSize = () => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    /* WAITING FOR A TERMINAL. Some seconds without it: what is known of its
       machine is said (`look`), never with an offer to restart it while it
       merely starts. Still nothing though its machine runs (`repair`): the
       server repairs it by itself, and only if it still does not come is a
       restart offered, in plain words. A restart is offered too when the
       wait is far longer than a start takes (`offer`), or its machine is not
       well. A machine that is starting is tried again by itself (`retry`).
       The proof that the terminal is there is how much comes through it: tmux
       draws the whole screen as soon as a screen attaches -- far more than
       the few bytes a channel that hangs gives back (its own echo of what the
       page sends) or than the bridge's own word (FOCUS_REPORTS). Nothing of
       it is read. A terminal slower than a blink (`loading`) is said in a
       neutral word; a terminal that could not be opened is tried again in
       silence for some seconds (`quiet`) before anything like a fault is
       said. Times can be shortened by a test (window.clavariumTimes). */
    const PROOF_BYTES = 32;
    const FOCUS_REPORTS = '\x1b[?1004h';
    const times = () => ({ loading: 1500, quiet: 10_000, look: 12_000, repair: 30_000, offer: 180_000, retry: 3000, ...(window.clavariumTimes ?? {}) });
    let slowTimers = [];
    const clearSlow = () => { for (const timer of slowTimers) clearTimeout(timer); slowTimers = []; };
    /* When this wait began (kept across the tries made by the page itself), and whether the server repaired it meanwhile. */
    let waitingSince = 0;
    let repairedFor = '';
    const disconnect = () => { wanted = false; clearSlow(); socket?.close(); socket = undefined; stopVoice?.(); };

    /* `again`: a try made by the page itself, within the same wait. */
    function connect(options) {
        const again = options?.again === true;
        disconnect();
        if (!NAME.test(current)) return;
        const name = current;
        if (!again || !waitingSince) { waitingSince = Date.now(); repairedFor = ''; }
        wanted = true;
        if (!again) notice.hidden = true;
        say('connecting', 'connecting');
        fit.fit();
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const where = DEVICE ? `/c/terminal?d=${pairing}&c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}` : `/terminal?c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`;
        const mine = new WebSocket(`${scheme}://${location.host}${where}`);
        socket = mine;
        mine.binaryType = 'arraybuffer';
        let failure = ''; let machineGone = false; let retry = false;
        let output = false; let came = 0;
        const T = times();
        const waited = Date.now() - waitingSince;
        const later = (ms, run) => slowTimers.push(setTimeout(() => { if (socket === mine && !output && name === current) run(); }, Math.max(0, ms - waited)));
        /* Slower than a blink: said in a neutral word, unless something is said already. */
        later(T.loading, () => { if (notice.hidden && state.dataset.state !== 'live') loading(); });
        /* An opening that takes long: what is known of the machine is said under the wait. */
        later(T.look, () => void explainMachine(true));
        /* Repaired already in this wait, and still nothing: said plainly, with the restart. */
        if (repairedFor === name) slowTimers.push(setTimeout(() => { if (socket === mine && !output && name === current) stuck(name); }, T.repair));
        else later(T.repair, () => void repairTerminal(name));
        later(T.offer, () => void explainMachine(true, true));
        /* Open means the bridge answered, not that the machine is awake yet. */
        mine.onopen = () => { say('opening', 'connecting'); focusTerminalUnasked(); };
        mine.onmessage = (event) => {
            /* Binary is terminal output. Text is the bridge talking to the page. */
            if (typeof event.data !== 'string') {
                /* Output is the proof the terminal is there: "waking" is over, and so is the wait. */
                const bytes = new Uint8Array(event.data);
                if (!output && !(bytes.length === FOCUS_REPORTS.length && String.fromCharCode(...bytes) === FOCUS_REPORTS)) came += bytes.length;
                if (!output && came >= PROOF_BYTES) { output = true; clearSlow(); waitingSince = 0; repairedFor = ''; }
                if (state.dataset.state !== 'live') {
                    say('live', 'live');
                    notice.hidden = true;
                    /* Asking for the size again makes the tool redraw whole:
                       after a re-attach the first typed line was misplaced. */
                    setTimeout(() => { fit.fit(); sendSize(); }, 300);
                }
                terminal.write(bytes);
                return;
            }
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            /* The size is told at once too: the page may have changed size while
               it was connecting (the key row appears, a notice goes), and what
               it said then was lost -- nobody listened yet. The bridge listens
               from "ready" on. Until it hears, the tool draws for the old size
               and whatever is typed meanwhile lands in a garbled screen. */
            if (message.type === 'ready') { say('live', 'live'); notice.hidden = true; fit.fit(); sendSize(); setTimeout(() => { fit.fit(); sendSize(); }, 300); }
            /* A start told step by step: the same panel as a build or a restart. */
            if (message.type === 'status' && message.progress) {
                if (message.text) say(String(message.text), 'connecting');
                const told = message.progress;
                progressPanel(`${name}/open`, () => (socket === mine && !output ? told : undefined));
            } else if (message.type === 'status') {
                say(String(message.text), 'connecting');
                /* In the middle of the screen too: a small word in the header is
                   not enough for a wait that can last minutes (a tester waited
                   three, with nothing else to read). One sentence, with the time
                   it has taken so far, said again each second. */
                const said = String(message.text);
                const since = waitingSince || Date.now();
                const tell = () => {
                    const s = Math.floor((Date.now() - since) / 1000);
                    $('notice-text').textContent = `${said} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} so far; a start usually takes a minute or two. Its work, its files and its chat are kept.`;
                };
                show(''); tell();
                const ticking = setInterval(() => { if (socket !== mine || output || notice.hidden) { clearInterval(ticking); return; } tell(); }, 1000);
                slowTimers.push(ticking);
            }
            if (message.type === 'error') { failure = String(message.text); machineGone = message.gone === true; retry = message.retry === true; }
        };
        mine.onclose = (event) => {
            if (socket !== mine || !wanted) return;       /* we moved on, or closed it ourselves */
            if (event.code === CLOSE_TAKEN) {
                say('open elsewhere', 'waiting');
                show('This conversation is now open on another screen.', 'Use it here', connect);
            } else if (event.code === CLOSE_ENDED) {
                say('ended', 'ended');
                show(home ? 'The tool has exited. Its machine will stop in a minute.' : 'The tool has exited. The session is over.', 'Start it again', connect);
            } else if (event.code === CLOSE_FAILED) {
                say('not available', 'ended');
                /* Its machine is gone (a backup put back elsewhere, a machine
                   deleted by hand): the owner can have it built again. */
                if (machineGone && !DEVICE) show(`${failure} What was on its disk is lost; its folders are kept.`, 'Build its machine again', () => void rebuild());
                /* Its machine is starting: tried again by itself, for as long as a start may take. */
                else if (retry && Date.now() - waitingSince < T.offer) {
                    say('starting', 'connecting');
                    show(`${failure} The terminal opens by itself as soon as it is there.`, 'Try now', () => connect({ again: true }));
                    $('notice-spin').hidden = false;
                    slowTimers.push(setTimeout(() => { if (name === current && (!socket || socket === mine)) connect({ again: true }); }, T.retry));
                    socket = undefined; wanted = true;
                    return;
                /* Not opened, for a reason not told: often a blink (the phone waking, the server
                   starting again). Tried again in silence for some seconds, under a neutral word. */
                } else if (Date.now() - waitingSince < T.quiet) {
                    say('connecting', 'connecting');
                    if (notice.hidden || notice.dataset.loading) loading();
                    slowTimers.push(setTimeout(() => { if (name === current && (!socket || socket === mine)) connect({ again: true }); }, T.retry));
                    socket = undefined; wanted = true;
                    if (DEVICE) void refresh();
                    return;
                } else { show(failure || 'The terminal could not be opened.', 'Try again', connect); void explainMachine(false, Date.now() - waitingSince >= T.offer); }
                /* On a device this is often the owner closing the conversation:
                   asking again says so in plain words, instead of an error. */
                if (DEVICE) void refresh();
            } else {
                say('reconnecting', 'connecting');
                if (DEVICE) void refresh();       /* removed meanwhile? then say it, do not retry for ever */
                setTimeout(() => { if (socket === mine && wanted) connect(); }, RETRY_MS);
            }
        };
    }

    /* THE NETWORK CAME BACK (the browser says so, found 22-10: a short cut kept the pages away): what was open
       is opened again at once, rather than when a connection that died without a word is noticed. */
    addEventListener('online', () => {
        void refresh();
        if (!current || !socket || !wanted) return;
        const dead = socket; socket = undefined;
        try { dead.close(); } catch { /* gone */ }
        connect();
    });

    terminal.onData(send);
    terminal.onResize(sendSize);
    new ResizeObserver(() => fit.fit()).observe($('terminal'));
    /* A CLICK ON A KEY MUST NOT TAKE THE TERMINAL'S FOCUS. Found by a tester:
       the Esc button did nothing. Clicking it blurred the terminal, which
       tells the tool "focus lost", then came our Escape, then "focus back":
       the Escape arrived glued to the next sequence and was read as part of
       it. Keeping the focus where it is sends the Escape alone. */
    for (const zone of ['keys', 'shortcut-row']) {
        $(zone).addEventListener('pointerdown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
    }
    /* A KEY HELD DOWN REPEATS. Sent at once when the finger (or the mouse)
       goes down; for the keys that repeat, again after a pause, then
       quickly; never once it is lifted, cancelled, or has left the key.
       A click from the keyboard (Enter or Space on the focused button)
       sends once. */
    const stopRepeats = new Set();
    for (const button of document.querySelectorAll('#keys button[data-keys]')) {
        const key = button.dataset.keys;
        let delay = null; let every = null;
        const stop = () => { clearTimeout(delay); clearInterval(every); delay = null; every = null; };
        stopRepeats.add(stop);
        button.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            stop();
            send(KEYS[key]);
            if (REPEATING.has(key)) delay = setTimeout(() => { delay = null; every = setInterval(() => send(KEYS[key]), REPEAT_EVERY_MS); }, REPEAT_AFTER_MS);
        });
        for (const end of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) button.addEventListener(end, stop);
        /* A finger is held by the key it touched: whether it left is seen from where it is. */
        button.addEventListener('pointermove', (event) => {
            if (delay === null && every === null) return;
            const box = button.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) stop();
        });
        button.addEventListener('contextmenu', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
            /* detail 0: from the keyboard; otherwise the key was already sent on the way down. */
            if (event.detail === 0) send(KEYS[key]);
            focusTerminal();
        });
    }
    addEventListener('blur', () => { for (const stop of stopRepeats) stop(); });
    document.addEventListener('visibilitychange', () => { for (const stop of stopRepeats) stop(); });

    /* ---------- More keys, and ready-made answers when the tool asks (a phone) ---------- */
    $('keys-more').addEventListener('click', () => {
        const more = $('keys').dataset.more !== 'true';
        $('keys').dataset.more = String(more);
        $('keys-more').setAttribute('aria-expanded', String(more));
        $('keys-more').textContent = more ? 'Less' : 'More';
        focusTerminal();
    });
    /* A tool that waits for an answer rings (a terminal bell): its ready-made
       answers come up on a phone, and go once something is sent. */
    const asking = (on) => $('room').toggleAttribute('data-asking', on);
    terminal.onBell(() => asking(true));

    /* ---------- the bar on a phone: one line, the rest behind "..." ---------- */
    const header = document.querySelector('header');
    const closeMenu = () => { if (header) header.dataset.menu = 'closed'; $('menu').setAttribute('aria-expanded', 'false'); };
    $('menu').addEventListener('click', () => {
        const open = header?.dataset.menu !== 'open';
        if (header) header.dataset.menu = open ? 'open' : 'closed';
        $('menu').setAttribute('aria-expanded', String(open));
    });
    /* A choice made in it, or a touch anywhere else, folds it away. */
    $('menu-items').addEventListener('click', (event) => { if (event.target.closest('button') && !event.target.closest('.text-size')) closeMenu(); });
    document.addEventListener('pointerdown', (event) => { if (header?.dataset.menu === 'open' && !event.target.closest('header')) closeMenu(); });

    /* ---------- the size of the text: one setting of this device ---------- */
    /* Not a magnifier: every text of the page, the terminal's too, grows or
       shrinks and is laid out again; nothing has to be scrolled sideways.
       It is a share of the browser's own text size, so that setting counts
       too. Pinched with two fingers, Ctrl and the wheel, Ctrl + and Ctrl -,
       or the buttons in Settings (on a phone, behind "..."). */
    const TEXT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2, 2.25, 2.5];
    const SIZE_MIN = 0.7; const SIZE_MAX = 2.5;
    let textScale = 1;
    try { const kept = Number(localStorage.getItem('clavarium-text')); if (kept >= SIZE_MIN && kept <= SIZE_MAX) textScale = kept; } catch { /* a private window */ }
    const terminalBase = innerWidth < 500 ? 11 : 14;
    const applyTerminalText = () => {
        const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 * textScale;
        const size = Math.max(6, Math.round(terminalBase * (rootPx / 16) * 2) / 2);
        if (terminal.options.fontSize === size) return;
        terminal.options.fontSize = size;
        /* The terminal is laid out again; its new size goes to the machine (onResize). */
        fit.fit();
    };
    function applyText(scale, { save = true, terminalToo = true } = {}) {
        textScale = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(scale * 100) / 100));
        document.documentElement.style.fontSize = `${textScale * 100}%`;
        for (const b of document.querySelectorAll('.text-size .text-now')) b.textContent = `${Math.round(textScale * 100)}%`;
        if (terminalToo) applyTerminalText();
        if (save) { try { localStorage.setItem('clavarium-text', String(textScale)); } catch { /* as above */ } }
    }
    const stepText = (way) => {
        if (way === 0) return applyText(1);
        const next = way > 0 ? TEXT_STEPS.find((x) => x > textScale + 0.001) : [...TEXT_STEPS].reverse().find((x) => x < textScale - 0.001);
        applyText(next ?? textScale);
    };
    for (const b of document.querySelectorAll('.text-size button')) {
        b.addEventListener('click', () => stepText(b.dataset.text === 'larger' ? 1 : b.dataset.text === 'smaller' ? -1 : 0));
    }
    /* Ctrl + and Ctrl -, Ctrl 0: taken before the terminal sees them. */
    addEventListener('keydown', (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const way = event.key === '+' || event.key === '=' ? 1 : event.key === '-' || event.key === '_' ? -1 : event.key === '0' ? 0 : null;
        if (way === null) return;
        event.preventDefault(); event.stopPropagation();
        stepText(way);
    }, true);
    let wheelAt = 0;
    /* A picture large in the chat's viewer zooms itself, with a pinch or the wheel: the text is not grown under it.
       So does the map of Access (links.js). */
    const inViewer = (event) => event.target instanceof Element && Boolean(event.target.closest('.parley-zoom, .lk-scroller'));
    addEventListener('wheel', (event) => {
        if (!event.ctrlKey || inViewer(event)) return;
        event.preventDefault(); event.stopPropagation();
        if (Date.now() - wheelAt < 120 || event.deltaY === 0) return;
        wheelAt = Date.now();
        stepText(event.deltaY < 0 ? 1 : -1);
    }, { passive: false, capture: true });
    /* Two fingers pinched: the text follows them; the terminal is laid out
       once they lift (not at every move: each new size is sent to the machine). */
    let pinch = null;
    const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    document.addEventListener('touchstart', (event) => { if (event.touches.length === 2 && !inViewer(event)) pinch = { from: spread(event.touches), scale: textScale }; }, { passive: true, capture: true });
    document.addEventListener('touchmove', (event) => {
        if (!pinch || event.touches.length !== 2) return;
        event.preventDefault();
        const ratio = spread(event.touches) / Math.max(1, pinch.from);
        applyText(pinch.scale * ratio, { save: false, terminalToo: false });
    }, { passive: false, capture: true });
    const endPinch = (event) => { if (!pinch || event.touches.length >= 2) return; pinch = null; applyText(textScale); };
    document.addEventListener('touchend', endPinch, { capture: true });
    document.addEventListener('touchcancel', endPinch, { capture: true });
    window.clavariumText = () => ({ scale: textScale, terminal: terminal.options.fontSize });
    applyText(textScale, { save: false });

    /* ---------- one conversation ---------- */
    /* True while a first-time visitor is reading the welcome: the terminal is
       not opened behind it, or its first output would wipe the welcome away
       (seen on the live site: the "Start" button vanished before it could be
       pressed). */
    let welcoming = false;
    /* What can be done to the conversation shown, from what is known of it now. */
    function paintActions() {
        const c = conversations.find((x) => x.name === current);
        const usable = Boolean(c) && c.phase === 'ready' && !holds(c);
        $('archive').hidden = !c;
        $('reset-machine').hidden = $('erase-conversation').hidden = !c || DEVICE;
        $('files-open').hidden = $('share').hidden = !usable;
        /* Given its chat alone: the files of the chat open from the chat; Files holds only what was given to the device itself. */
        if (noTerminal()) $('files-open').hidden = deviceShared.length === 0;
        $('sleep').hidden = !usable || c.asleep === true;
        $('restart').hidden = DEVICE || !usable;
        /* At hand, on top of its settings: wake when asleep, else restart, sleep, its terminal. */
        $('quick-wake').hidden = !c || c.asleep !== true;
        $('hand-terminal').hidden = !usable || noTerminal();
        $('panel-actions').hidden = DEVICE || !c;
        /* Its own sheet is there as soon as it exists: archiving one that failed is done from it. */
        $('folders').hidden = DEVICE || !c;
    }
    /* `keepSheets`: the same conversation, looked at again (its state changed):
       a sheet the owner has open is not shut under their fingers. */
    function enter(keepSheets = false) {
        if (welcoming) return;
        const c = conversations.find((x) => x.name === current);
        $('name').textContent = (c ? shownName(c) : current) || 'No conversation';
        pageTitle = current ? (c ? shownName(c) : current) : ''; paintTitle();
        $('tool').hidden = !c; $('tool').textContent = c?.toolLabel ?? '';
        paintActions();
        $('copy-open').hidden = !current || (home && (!c || c.phase !== 'ready'));
        if (!keepSheets) resetTabs();
        paintChips();
        $('keys').hidden = !current;
        if (!current) { disconnect(); terminal.reset(); say('', 'ended'); show(home ? 'Choose a conversation, or create one.' : 'This address names no conversation.'); return; }
        if (home && !c) { disconnect(); say('unknown', 'ended'); show('No such conversation.'); return; }
        const usable = Boolean(c) && c.phase === 'ready' && !holds(c);
        $('shortcuts').hidden = $('keys').hidden = !current || (home && !usable);
        if (home && usable && !noTerminal()) void paintShortcuts();
        /* A build or a restart, told step by step until its tool is there: the terminal is opened only then. */
        if (holds(c)) {
            disconnect(); say(c.progress.kind === 'build' ? 'building' : 'restarting', 'connecting');
            progressPanel(c.name, () => conversations.find((x) => x.name === c.name)?.progress);
            return;
        }
        if (c && c.phase === 'building') {
            disconnect(); say('building', 'connecting');
            show(`${c.step ?? 'Building its machine'}... A new machine takes a few minutes.`); $('notice-spin').hidden = false;
            return;
        }
        if (c && c.phase === 'restarting') {
            disconnect(); say('restarting', 'connecting');
            /* The step the server is at, the time it has taken so far (said again each second), and what is usual. */
            const since = Date.parse(c.restartingSince ?? '') || restartSeen.get(c.name) || Date.now();
            restartSeen.set(c.name, since);
            const tell = () => {
                const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
                const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
                const now = conversations.find((x) => x.name === c.name);
                const usual = s < 180 ? 'A restart usually takes one to two minutes.' : 'This is taking longer than usual: the machine may be slow to stop or to start. It goes on by itself.';
                $('notice-text').textContent = `${now?.step ?? c.step ?? 'Restarting its machine'}... ${clock} so far. ${usual} The tool starts again by itself; its files and its chat are kept.`;
            };
            show(''); tell(); $('notice-spin').hidden = false;
            clearInterval(restartTicking);
            restartTicking = setInterval(() => { const now = conversations.find((x) => x.name === c.name); if (current !== c.name || now?.phase !== 'restarting' || notice.hidden) { clearInterval(restartTicking); return; } tell(); }, 1000);
            return;
        }
        if (c && c.phase === 'moving') { disconnect(); say('moving', 'connecting'); show(`Moving its work: ${c.step ?? 'working'}... The tool is stopped meanwhile and starts again by itself.`); $('notice-spin').hidden = false; return; }
        if (c && c.phase === 'failed') { disconnect(); say('failed', 'ended'); show(c.error ?? 'This conversation could not be built.', DEVICE ? undefined : 'Build it again', () => void rebuild()); return; }
        /* Given its chat and not its terminal: the chat is the whole page, and no terminal is ever opened. */
        if (noTerminal()) { chatAlone(); return; }
        /* Asleep because somebody asked: it stays asleep until somebody asks. */
        if (c && c.asleep === true && !socket) { say('asleep', 'waiting'); show(`Asleep. The tool is frozen as it was.${c.sizeAtWake ? ` When it wakes, its machine is restarted with its new size (${laterWords(c.sizeAtWake)}), and the tool takes up its session.` : ''}`, 'Wake it', connect); mascot('asleep'); return; }
        if (!socket) { terminal.reset(); connect(); }
        void watchSignIn();
    }
    /* A device given the chat alone: no terminal, no keys, no way to it. Its
       chat if it is on; if it is not, said plainly (only its owner can turn it on). */
    function chatAlone() {
        disconnect();
        say('chat', 'live');
        notice.hidden = true;
        for (const id of ['shortcuts', 'copy-open', 'copy', 'simple-toggle']) $(id).hidden = true;
        $('room').setAttribute('data-no-terminal', '');
        simple = true;
        paintSimple();
        void readTalk().then(paintThread);
    }
    /* `step`: picked in the list -- a step of its own, so that Back comes
       back to the list. Another one picked while one is open takes the
       place of the first (the list is still one Back away). */
    function select(name, { step = false } = {}) {
        if (name !== current) { disconnect(); terminal.reset(); }
        current = name;
        /* The strip over the terminal is the one of the conversation now open, at once -- never the last one's until the next look. */
        paintHealth();
        /* What was open over the one before -- its tab, an asset, a review,
           what was over it, a place of the menu (Access, Settings) -- gives way. */
        const room = nav.last(['room']);
        nav.cut(name && room >= 0 ? room + 1 : 0);
        if (place !== 'conversations') showPlace('conversations');
        resetTabs();
        const address = name ? `?c=${encodeURIComponent(name)}` : location.pathname;
        if (step && name && !DEVICE && nav.last(['room']) < 0) nav.push('room', ({ quiet }) => { if (!quiet) select(''); }, { address });
        else if (!DEVICE) nav.replace(address);
        view(name ? 'room' : 'list');
        paint();
        enter();
        void chatFirst();
        /* Opening a conversation gets the list out of the way, so its room has the room;
           the "»" button brings the list back. Only on a real pick by the owner, never on a
           device or when deselecting. */
        if (step && name && !DEVICE && !listFolded && !listPinned) {
            listFolded = true;
            try { localStorage.setItem('clavarium-list', 'folded'); } catch { /* a private window */ }
            applyFold(true); fit.fit?.();
        }
    }

    /* ---------- THE NAME OF THIS CLAVARIUM (server/instance.mjs) ----------
       Read from its manifest, the same for the owner's page and a device's:
       in the title of the tab and above the list. The name chosen on this
       device when installing goes in the address of the manifest (kept
       here, put back at each start), so that the app is installed under it. */
    let appName = 'Clavarium';
    let pageTitle = '';
    const INSTALL_NAME = 'clavarium-install-name';
    const MANIFEST = DEVICE ? '/c/manifest.webmanifest' : '/manifest.webmanifest';
    const manifestLink = document.querySelector('link[rel="manifest"]');
    const installName = () => { try { return localStorage.getItem(INSTALL_NAME) ?? ''; } catch { return ''; } };
    const pointManifest = (name) => { if (manifestLink) manifestLink.href = name ? `${MANIFEST}?name=${encodeURIComponent(name)}` : MANIFEST; };
    function paintTitle() { document.title = pageTitle ? `${pageTitle} - ${appName}` : appName; $('list-title').textContent = appName; }
    async function readAppName() {
        try { const m = await (await fetch(MANIFEST)).json(); if (typeof m.name === 'string' && m.name) appName = m.name; } catch { /* the usual name */ }
        paintTitle();
    }
    pointManifest(installName());

    /* ---------- the list ---------- */
    /* THE FRONT'S "NO ANSWER" (503, down): the server was busy a moment, or restarting -- it does
       not know which. Said as busy, never as an update (#220); a read is tried again by itself. */
    const BUSY = 'The server is busy just now: try again in a moment.';
    const post = async (path, body) => {
        const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok && r.status === 503 && j.down === true) throw Object.assign(new Error(BUSY), { retry: true });
        if (!r.ok) throw Object.assign(new Error(j.error || 'The request failed.'), { kind: j.kind, retry: j.retry === true });
        return j;
    };
    /* The name a person reads; a conversation made before free names is read by its identifier. */
    const shownName = (c) => (c && typeof c.title === 'string' && c.title ? c.title : c?.name ?? '');
    /* It needs its owner: it asks or waits, its answerer asks, it failed, its machine is unwell. Said even when it is hidden. */
    /* Its tool asks or waits for its owner, and the owner has not written since (talk.mjs, brief). */
    const talkNeeds = (c) => Boolean(c.talk && (c.talk.needs ?? (c.talk.waiting > 0 || c.talk.state === 'waiting')));
    /* Its machine calls its owner for what needs a hand -- it does not serve, its memory or disk is almost
       full -- not marked "Seen"; a program stopped for lack of memory (its files safe) is only said. */
    const healthNeeds = (c) => c.phase === 'ready' && !c.asleep && (c.health?.problems ?? []).some((p) => (p.level === 'bad' || (p.level === 'warn' && ['memory', 'disk'].includes(p.kind) && !String(p.key).startsWith('oom:'))) && !(c.health.seen ?? []).includes(p.key));
    /* Asleep, it is frozen and asks nothing until it wakes: it does not belong in "Needs you"
       (waking it is what answers it). Health already excludes asleep; this covers the rest. */
    const needsYou = (c) => !c.asleep && Boolean(talkNeeds(c) || c.answerer?.needs || c.phase === 'failed' || healthNeeds(c));
    /* ONE FLAT POINT per conversation, its colour the state -- the worst that applies: a machine problem (red),
       the agent waits for you (blue), the agent at work (gold, pulsing), the machine busy (amber, pulsing),
       fine (green), asleep (a hollow ring). The same point, same colours, sums a folded group below. */
    const machineState = (c) => (c.asleep ? 'off' : (c.phase === 'failed' || healthNeeds(c)) ? 'problem'
        : (holds(c) || ['building', 'restarting', 'moving'].includes(c.phase)) ? 'busy' : 'online');
    const agentState = (c) => (c.asleep ? 'sleep' : (talkNeeds(c) || c.answerer?.needs) ? 'wait'
        : c.talk?.state === 'working' ? 'work' : c.talk?.state === 'done' ? 'done' : 'idle');
    const STATE_WORDS = KIT.STATE_WORDS;
    const rollup = (c) => { const m = machineState(c); const a = agentState(c);
        return (m === 'off' ? 'sleep' : m === 'problem' ? 'problem' : a === 'wait' ? 'wait' : a === 'work' ? 'work' : m === 'busy' ? 'busy' : 'ok'); };
    const statePoint = (state) => KIT.StatusDot({ state });
    const STATE_ORDER = KIT.STATES;
    function stateSummary(list) {
        const count = Object.fromEntries(STATE_ORDER.map((k) => [k, 0]));
        for (const c of list) count[rollup(c)] += 1;
        const slots = Math.min(4, list.length);
        const present = STATE_ORDER.filter((k) => count[k] > 0);
        const got = Object.fromEntries(STATE_ORDER.map((k) => [k, 0]));
        for (const k of present.slice(0, slots)) got[k] = 1;
        for (let left = slots - Math.min(slots, present.length); left > 0; left -= 1) {
            const k = [...present].sort((a, b) => (count[b] / (got[b] + 1)) - (count[a] / (got[a] + 1)))[0]; got[k] += 1;
        }
        const box = document.createElement('span'); box.className = 'state-sum'; box.setAttribute('role', 'img');
        for (const k of STATE_ORDER) for (let i = 0; i < got[k]; i += 1) box.append(statePoint(k));
        const words = present.map((k) => `${count[k]} ${STATE_WORDS[k]}`).join(', ') || 'none';
        box.setAttribute('aria-label', words); box.title = words;
        return box;
    }
    /* Hidden conversations are shown on a click on "N hidden", for this page only. */
    let showHidden = false;
    /* Recent: a few, or all of them (for this page only). */
    let showAllRecent = false;
    /* A row held or dragged: the list is not painted again under the finger (the browser would cancel
       the touch on a row replaced); it is once the drag ends. */
    let listHeld = false; let paintLater = false;
    /* ---------- FOLDERS, ORDER, SEARCH ----------
       One level of folders: a word on each conversation, kept by the server
       with the order, so that every device shows the same list. Those in no
       folder first, then the folders, each folded or open on this device
       only. A search filters as it is typed, hidden ones too (marked), and
       opens the folders it finds something in. */
    const FOLDED = 'clavarium-folded';
    const folded = new Set((() => { try { const v = JSON.parse(localStorage.getItem(FOLDED) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } })());
    const keepFolded = () => { try { localStorage.setItem(FOLDED, JSON.stringify([...folded])); } catch { /* a private window: this page only */ } };
    let query = '';
    let chosenHit = 0;
    const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const matches = (c) => [shownName(c), c.name, c.group, c.toolLabel].some((x) => plain(x).includes(plain(query)));
    const byRank = (a, b) => (a.rank ?? 0) - (b.rank ?? 0);
    /* A GROUP FIELD (01-11): typed freely, or chosen from the groups there are -- a ▾ beside it opens them all
       (a datalist alone shows only what matches what is typed, and not on every browser). */
    function groupChooser(input, values) {
        if (!input || input.dataset.chooser) return;
        input.dataset.chooser = 'true';
        const wrap = document.createElement('span'); wrap.className = 'chooser';
        input.replaceWith(wrap); wrap.append(input);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'chooser-open'; open.textContent = '▾';
        open.setAttribute('aria-label', 'Existing groups'); open.setAttribute('aria-haspopup', 'listbox'); open.setAttribute('aria-expanded', 'false');
        const list = document.createElement('div'); list.className = 'chooser-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
        const close = () => { list.hidden = true; open.setAttribute('aria-expanded', 'false'); };
        open.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!list.hidden) { close(); return; }
            const all = values();
            list.replaceChildren(...(all.length ? all : [null]).map((v) => {
                if (v === null) { const none = document.createElement('div'); none.className = 'chooser-none'; none.textContent = 'No group yet: type a name.'; return none; }
                const o = document.createElement('button'); o.type = 'button'; o.className = 'chooser-option'; o.setAttribute('role', 'option'); o.textContent = v;
                if (v === input.value) o.setAttribute('aria-selected', 'true');
                o.addEventListener('click', () => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); close(); input.focus(); });
                return o;
            }));
            list.hidden = false; open.setAttribute('aria-expanded', 'true');
            list.querySelector('[aria-selected="true"], .chooser-option')?.focus();
        });
        list.addEventListener('keydown', (event) => {
            const opts = [...list.querySelectorAll('.chooser-option')]; const i = opts.indexOf(document.activeElement);
            if (event.key === 'Escape') { close(); open.focus(); event.preventDefault(); }
            if (event.key === 'ArrowDown' && i < opts.length - 1) { opts[i + 1].focus(); event.preventDefault(); }
            if (event.key === 'ArrowUp' && i > 0) { opts[i - 1].focus(); event.preventDefault(); }
            event.stopPropagation();
        });
        document.addEventListener('click', (event) => { if (!wrap.contains(event.target)) close(); });
        wrap.append(open, list);
    }
    const groupsInOrder = () => [...new Set(conversations.filter((c) => c.group).sort((a, b) => (a.groupRank ?? 0) - (b.groupRank ?? 0)).map((c) => c.group))];
    groupChooser($('group-name'), groupsInOrder); groupChooser($('newconv-group'), groupsInOrder);
    /* WHEN IT WAS LAST USED: what was said in its chat, and what its agent said it does (Parley) -- never what
       its terminal shows. A tool with no chat (a plain terminal): the keys typed in it by hand. */
    const activityOf = (c) => Math.max(...[c.talk?.lastAt, c.talk?.stepAt, c.talk ? null : c.lastActiveAt, c.createdAt].map((x) => (x ? new Date(x).getTime() : 0)));
    const whenWords = (t) => {
        if (!t) return '';
        const d = new Date(t); const now = new Date();
        /* Today: how long ago, not the clock -- the list is sorted by it, so "2 min" reads better than "15:05". */
        if (d.toDateString() === now.toDateString()) { const m = Math.max(0, Math.floor((now - d) / 60_000)); return m < 1 ? 'now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`; }
        const y = new Date(now); y.setDate(now.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'yesterday';
        return now - d < 6 * 86_400_000 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    };
    /* ONE CONVERSATION, as the kit draws it everywhere (kit.js ConvCard): what is known of it, said once --
       its name, its point, what it does now, its last words and when, its chips. `told`: its last words and
       when (a row of Needs you or Recent; a card). */
    const agentWho = (c) => [c.chatName, c.toolLabel ?? c.tool].filter(Boolean).join(' \u00b7 ');
    function convModel(c, told = false) {
        /* Under way: the step the panel shows, in its words (the tool named once). */
        const under = c.progress && ['building', 'restarting', 'ready'].includes(c.phase) ? stepNow(c.progress, c.toolLabel) : '';
        /* What it is doing, when it says something: its tool is not named on every row. */
        const now = under || (holds(c) && c.phase !== 'building' ? (c.progress.kind === 'build' ? 'starting' : 'restarting') : c.phase === 'ready' ? (c.asleep ? 'asleep, wakes when opened' : '') : c.phase === 'building' ? (c.step ?? 'building') : c.phase === 'moving' ? 'moving its work' : c.phase === 'restarting' ? 'restarting' : 'failed');
        /* The line of its tool only when it says something: under way, asleep, failed -- not "Claude Code" again and again. */
        const plain = c.phase === 'ready' && !c.asleep && !under && !holds(c);
        const chips = [];
        /* Found by a search while hidden: said. */
        if (c.hidden === true && query) chips.push({ text: 'hidden', cls: 'shared-mark', tone: 'note' });
        /* Several models answer its simple questions; or they stopped, and it waits for its owner. */
        const waking = (c.wakeups?.items ?? []).filter((w) => w.on).length;
        if (waking > 0) chips.push({ text: `${waking} wake-up${waking > 1 ? 's' : ''}`, cls: 'shared-mark', tone: 'note' });
        /* It talks through the app, and asks or waits for its owner there. */
        if (!c.asleep && talkNeeds(c)) chips.push({ text: c.talk.waiting > 0 ? 'asks you' : 'waits for you', cls: 'needs-mark', tone: 'need' });
        if (c.answerer?.on) { const needs = c.answerer.needs && !c.asleep; chips.push({ text: needs ? 'asks for you' : 'answered in your place', cls: needs ? 'needs-mark' : 'shared-mark', tone: needs ? 'need' : 'note' }); }
        /* Where else it speaks: its rooms, its voice boxes (said on a card). */
        for (const r of roomsNow()) if (r.members?.some((m) => m.kind === 'ai' && m.ref === c.name)) chips.push({ text: r.name, icon: 'room', wide: true });
        for (const b of boxesNow()) if (b.conversation === c.name) chips.push({ text: b.name, icon: 'box', wide: true });
        /* Its last message. The agent is the usual speaker, so its name is left off (just the words); only
           the person's own last word is marked "You:", which tells you it is your move. */
        const last = told && c.talk?.lastText ? (c.talk.lastFrom === 'person' ? `You: ${c.talk.lastText}` : c.talk.lastText) : '';
        const state = rollup(c);
        return { title: shownName(c), state, stateLabel: STATE_WORDS[state], avatar: { name: shownName(c) }, when: told ? whenWords(activityOf(c)) : '', last, now: plain ? '' : now, who: agentWho(c), chips };
    }
    /* `copy`: a row of Needs you or Recent, beside its place in its group: it is not moved by hand.
       `told`: it says what was said last, and when (a copy always; the one list when there is no group). */
    function itemButton(c, copy = false, told = copy) {
        const b = KIT.ConvCard(convModel(c, told), { size: 'row', cls: copy ? 'item copy' : 'item' });
        b.dataset.phase = c.phase; b.dataset.name = c.name;
        if (c.group) b.dataset.group = c.group;
        /* Ready, but its tool not there yet: it still reads as under way. */
        if (holds(c)) b.dataset.busy = 'true';
        if (c.name === current) b.setAttribute('aria-current', 'true');
        if (c.title) b.title = c.name;
        if (c.hidden === true) b.dataset.hidden = 'true';
        if (c.asleep) b.dataset.asleep = 'true';
        if (told) b.dataset.when = 'true';
        /* Who else holds it is said in its Access, not in the list (where it said the same on every row). */
        b.addEventListener('click', () => select(c.name, { step: true }));
        return b;
    }
    /* `label`: the name shown; the conversations in no group are one of their own ("Not filed", key NONE). */
    const NONE = '\u0000none';
    /* The two sections above the groups, folded or not like a group (never a group's name: those are plain words). */
    const NEEDS = '\u0001needs'; const RECENT = '\u0001recent'; const GROUPS = '\u0001groups'; const ROOMS = '\u0001rooms';
    /* A ROOM IN THE LIST (03-11): like a conversation's row -- its name, its last words, when -- a room's chips before it. */
    /* The rooms known, even before their part of this page has run (a list painted early). */
    const roomsNow = () => { try { return Array.isArray(rooms) ? rooms : []; } catch { return []; } };
    /* The voice boxes known (read with the deck and a room's settings): the chips of whom they speak for. */
    const boxesNow = () => { try { return Array.isArray(boxesKnown) ? boxesKnown : []; } catch { return []; } };
    const roomOpenNow = () => { try { return place === 'salon' ? salonId : ''; } catch { return ''; } };
    /* Words of the screen's language (Parley's texts, /api/talk/words) once read; English till then. */
    const uiSaid = (key, fallback, vars = {}) => {
        let words = null; try { words = chatWords; } catch { /* not read yet */ }
        return (typeof words?.[key] === 'string' ? words[key] : fallback).replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
    };
    /* Who of a room speaks now (#282, an AI given a message and not done): « Cuisine parle… ». */
    const speaking = (who) => (who.length > 1 ? uiSaid('room-speaking-many', '{names} are speaking\u2026', { names: who.join(', ') }) : uiSaid('room-speaking', '{name} is speaking\u2026', { name: who[0] }));
    const thinkingOf = (r) => (Array.isArray(r?.thinking) ? r.thinking.filter((x) => typeof x === 'string' && x) : []);
    /* ROOMS ONLY (a filter of the list): kept on this device. */
    let roomsOnly = false;
    try { roomsOnly = localStorage.getItem('clavarium-list-show') === 'rooms'; } catch { /* a private window */ }
    /* A ROOM, drawn as a conversation (kit.js ConvCard): its sign for an initial, its last words or who speaks,
       when; its point: new words waiting (the colour of what waits for you), else at work while one speaks, else fine. */
    function roomModel(r) {
        const who = thinkingOf(r);
        const sign = document.createElement('span'); sign.className = 'room-sign';
        const state = r.unread > 0 ? 'wait' : who.length ? 'work' : 'ok';
        const chips = [];
        if (r.unread > 0) chips.push({ text: r.unread > 99 ? '99+' : String(r.unread), tone: 'count', title: `${r.unread} new` });
        for (const b of boxesNow()) if (b.conversation === `room:${r.id}`) chips.push({ text: b.name, icon: 'box', wide: true });
        return {
            title: r.name, state, stateLabel: r.unread > 0 ? `${r.unread} new` : who.length ? speaking(who) : 'Room', avatar: { name: r.name, glyph: sign },
            last: who.length || r.last ? (who.length ? speaking(who) : `${r.last.by ? `${r.last.by}: ` : ''}${r.last.text}`) : '',
            when: r.last ? whenWords(Date.parse(r.last.at)) : '',
            now: r.last || who.length ? '' : `Room \u00b7 ${countOf(r.members ?? [])}`,
            chips,
        };
    }
    function roomItem(r) {
        /* The same row as a conversation's (03-11: « de même nature »), told apart by its room sign. */
        const b = KIT.ConvCard(roomModel(r), { size: 'row', cls: 'item room-item' }); b.dataset.room = r.id;
        /* One of its AIs speaking now: said instead of its last message (a conversation at work: its dot, gold). */
        if (thinkingOf(r).length) b.dataset.live = 'true';
        if (r.last) b.dataset.when = 'true';
        if (r.id === roomOpenNow()) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => { void openSalon(r.id); });
        return b;
    }
    /* What was just unfolded comes in gently, once (the next paints show it as it is). */
    let justOpened = null;
    const unfolding = (key, els) => { if (justOpened === key) { for (const e of els) e.classList.add('unfolding'); justOpened = null; } return els; };
    function groupBox(g, inside, all, open, label = g) {
        const box = document.createElement('div'); box.className = 'group'; box.dataset.group = g === NONE ? '' : g;
        const head = document.createElement('button'); head.type = 'button'; head.className = 'group-head'; head.dataset.group = g === NONE ? '' : g;
        if (g === NONE) head.dataset.fixed = 'true';
        head.setAttribute('aria-expanded', String(open));
        const caret = document.createElement('span'); caret.className = 'caret'; caret.setAttribute('aria-hidden', 'true'); caret.textContent = '›';
        const name = document.createElement('span'); name.className = 'group-name'; name.textContent = label;
        head.append(caret, name);
        /* Folded: how its conversations are, in points; open, each row says its own. */
        if (!open) head.append(stateSummary(all));
        if (all.some(needsYou)) head.dataset.needs = 'true';
        head.addEventListener('click', () => {
            if (query) return;
            if (folded.has(g)) { folded.delete(g); justOpened = g; } else folded.add(g);
            keepFolded(); paint();
        });
        box.append(head);
        /* A conversation added right here, in this group (01-11): the same form as anywhere, its group filled. */
        if (!DEVICE && !String(g).startsWith('\u0001')) {
            const add = document.createElement('button'); add.type = 'button'; add.className = 'group-add'; add.textContent = '+';
            const where = g === NONE ? '' : g;
            add.title = where ? `New conversation in ${label}` : 'New conversation';
            add.setAttribute('aria-label', add.title);
            add.addEventListener('click', (event) => { event.stopPropagation(); void openNew({ group: where }); });
            box.append(add);
        }
        if (open) { const body = document.createElement('div'); body.className = 'group-body'; body.append(...inside.map((c) => itemButton(c))); unfolding(g, [body]); box.append(body); }
        return box;
    }
    /* THE LIST'S FILTER (All | Rooms only): the same pressed buttons as the other views' (Files: List | Icons). */
    let wordsAsked = false;
    function paintListShow() {
        const box = $('list-show'); if (!box) return;
        box.hidden = DEVICE || roomsNow().length === 0;
        /* Its words (and a room's « … parle… ») in the screen's language: read once, then painted again. */
        if (!box.hidden && !wordsAsked) { wordsAsked = true; void readWords().then(() => paint(), () => { wordsAsked = false; }); }
        for (const b of box.querySelectorAll('button')) {
            b.textContent = b.dataset.show === 'rooms' ? uiSaid('list-rooms-only', 'Rooms only') : uiSaid('list-all', 'All');
            b.setAttribute('aria-pressed', String((b.dataset.show === 'rooms') === roomsOnly));
        }
        box.setAttribute('aria-label', uiSaid('list-show', 'Show'));
    }
    for (const b of $('list-show')?.querySelectorAll('button') ?? []) {
        b.addEventListener('click', () => {
            roomsOnly = b.dataset.show === 'rooms';
            try { localStorage.setItem('clavarium-list-show', roomsOnly ? 'rooms' : 'all'); } catch { /* a private window */ }
            paint();
        });
    }
    function paint() {
        if (listHeld) { paintLater = true; return; }
        /* The groups, folded as a whole or not (a search shows them all). */
        let groupsOpen = true;
        const items = $('items');
        items.replaceChildren();
        const top = $('recent'); top.replaceChildren();
        const hidden = conversations.filter((c) => c.hidden === true);
        /* The one open stays in sight, hidden or not; a search finds hidden ones too. */
        const shown = conversations.filter((c) => (query ? matches(c) : c.hidden !== true || showHidden || c.name === current)).sort(byRank);
        const heading = (text) => { const h = document.createElement('h3'); h.className = 'list-head'; h.textContent = text; return h; };
        const groups = groupsInOrder();
        /* ROOMS ONLY: the rooms alone (a search among them); offered once there is one. */
        const onlyRooms = roomsOnly && !DEVICE && roomsNow().length > 0;
        paintListShow();
        if (onlyRooms) groupsOpen = false;
        else if (query || DEVICE) {
            /* A search: everything found, in its place. */
            items.append(...shown.filter((c) => !c.group).map((c) => itemButton(c)));
        } else {
            /* A section that folds: open at first, folded or not on this device as its owner leaves it. */
            const section = (key, label, count) => {
                const open = !folded.has(key);
                const b = document.createElement('button'); b.type = 'button'; b.className = 'list-head list-fold'; b.dataset.section = key === NEEDS ? 'needs' : key === RECENT ? 'recent' : 'groups';
                b.setAttribute('aria-expanded', String(open));
                const chevron = document.createElement('span'); chevron.className = 'list-chevron'; chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = open ? '\u25BE' : '\u25B8';
                /* How many, only when folded: open, its rows (and "Show more") say it. */
                b.append(chevron, document.createTextNode(label));
                if (!open) b.append(stateSummary(count));
                b.addEventListener('click', () => { if (folded.has(key)) { folded.delete(key); justOpened = key; } else folded.add(key); keepFolded(); paint(); });
                top.append(b);
                return open;
            };
            /* NEEDS YOU: whatever its date, until its owner acts; hidden ones too (they said so). */
            const needs = conversations.filter(needsYou).sort((a, b) => activityOf(b) - activityOf(a));
            if (needs.length && section(NEEDS, 'Needs you', needs)) top.append(...unfolding(NEEDS, needs.map((c) => itemButton(c, true))));
            /* RECENT: by when it was last used; up to seven awake, then all. Never a hidden one. Only once there
               are groups: before, the one list below says the same, in the order chosen by hand. */
            /* One in Needs you just above is not said twice. */
            /* The last day only: what is older is found in its group. */
            const dayAgo = Date.now() - 24 * 3600_000;
            /* Asleep ones go to the bottom of Recent: they are frozen, not what you came back to. */
            const recent = conversations.filter((c) => (c.hidden !== true || c.name === current) && !needsYou(c) && activityOf(c) >= dayAgo)
                .sort((a, b) => (Number(a.asleep === true) - Number(b.asleep === true)) || (activityOf(b) - activityOf(a)));
            /* In sight (03-11, his rule): up to seven awake ones, and the one open even asleep (it never vanishes
               under the eyes); the rest -- asleep, or past seven -- under the arrow. */
            const inSight = recent.filter((c) => c.asleep !== true).slice(0, 7);
            const openOne = recent.find((c) => c.name === current);
            if (openOne && !inSight.includes(openOne)) inSight.push(openOne);
            const few = inSight.length;
            /* The rooms used in the last day, among them by when (03-11: « dans le récent, indifféremment »). */
            const recentRooms = roomsNow().filter((r) => r.last && Date.parse(r.last.at) >= dayAgo);
            const rowsOfRecent = (list) => [...list.map((c) => ({ at: activityOf(c), el: () => itemButton(c, true) })), ...recentRooms.map((r) => ({ at: Date.parse(r.last.at), el: () => roomItem(r) }))].sort((a, b) => b.at - a.at).map((x) => x.el());
            if ((recent.length || recentRooms.length) && groups.length && section(RECENT, 'Recent', recent)) {
                top.append(...unfolding(RECENT, rowsOfRecent(showAllRecent ? recent : recent.filter((c) => inSight.includes(c)))));
                if (recent.length > few) {
                    const more = document.createElement('button'); more.type = 'button'; more.className = 'inline more-recent';
                    /* A chevron, centred: the words for the pointer and for a screen reader. */
                    const words = showAllRecent ? 'Show fewer' : `Show ${recent.length - few} more`;
                    more.replaceChildren(Object.assign(document.createElement('span'), { className: 'more-chevron', textContent: showAllRecent ? '\u2303' : '\u2304' }));
                    more.title = words; more.setAttribute('aria-label', words); more.setAttribute('aria-expanded', String(showAllRecent));
                    more.addEventListener('click', () => { showAllRecent = !showAllRecent; paint(); });
                    top.append(more);
                }
            }
            /* GROUPS: the order chosen by hand, and those in no group as one of their own. */
            if (groups.length) {
                const loose = shown.filter((c) => !c.group);
                groupsOpen = section(GROUPS, 'Conversation groups', conversations.filter((c) => c.hidden !== true));
                if (loose.length && groupsOpen) items.append(groupBox(NONE, loose, conversations.filter((c) => !c.group).sort(byRank), !folded.has(NONE), 'Not filed'));
            } else {
                /* No group yet: one list, each with what was said last and when -- without those in Needs you
                   just above (said once), under a heading of its own when Needs you is there. */
                if (needs.length) top.append(heading('Conversations'));
                items.append(...shown.filter((c) => !needsYou(c)).map((c) => itemButton(c, false, true)));
                if (conversations.length > 1) {
                    const tip = document.createElement('p'); tip.className = 'hint list-tip'; tip.textContent = 'Put conversations in groups to find them by subject: open one, then Settings, Group.';
                    items.append(tip);
                }
            }
        }
        for (const g of groups) {
            if (!groupsOpen) break;
            const inside = shown.filter((c) => c.group === g);
            /* Nothing of it in sight (all hidden, or nothing found): not shown. */
            if (inside.length === 0) continue;
            items.append(groupBox(g, inside, conversations.filter((c) => c.group === g).sort(byRank), Boolean(query) || !folded.has(g)));
        }
        if (groupsOpen && !onlyRooms) unfolding(GROUPS, [...items.children]);
        /* ROOMS (03-11): their own list, after the groups of conversations; a search finds them by name. */
        const roomsShown = roomsNow().filter((r) => !query || r.name.toLowerCase().includes(String(query).toLowerCase()));
        if (!DEVICE && roomsShown.length) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'list-head list-fold'; b.dataset.section = 'rooms';
            const open = onlyRooms || !folded.has(ROOMS); b.setAttribute('aria-expanded', String(open));
            const chevron = document.createElement('span'); chevron.className = 'list-chevron'; chevron.setAttribute('aria-hidden', 'true'); chevron.textContent = open ? '\u25BE' : '\u25B8';
            b.append(chevron, document.createTextNode('Rooms'));
            b.addEventListener('click', () => { if (onlyRooms) return; if (folded.has(ROOMS)) folded.delete(ROOMS); else folded.add(ROOMS); keepFolded(); paint(); });
            items.append(b);
            if (open) items.append(...roomsShown.map((r) => roomItem(r)));
        }
        /* The folders there are, offered where one is chosen. */
        $('group-names').replaceChildren(...groupsInOrder().map((g) => { const o = document.createElement('option'); o.value = g; return o; }));
        const hits = [...items.querySelectorAll('.item')];
        chosenHit = Math.max(0, Math.min(chosenHit, hits.length - 1));
        if (query) hits.forEach((h, i) => { h.toggleAttribute('data-chosen', i === chosenHit); if (i === chosenHit) h.scrollIntoView?.({ block: 'nearest' }); });
        $('search-none').hidden = !query || hits.length > 0;
        const toggle = $('hidden-toggle');
        toggle.hidden = DEVICE || hidden.length === 0 || Boolean(query) || onlyRooms;
        toggle.textContent = showHidden ? `Hide ${hidden.length} hidden` : `${hidden.length} hidden`;
        toggle.setAttribute('aria-expanded', String(showHidden));
        const calling = hidden.some(needsYou);
        toggle.dataset.needs = String(calling);
        toggle.title = calling ? 'A hidden conversation needs you' : '';
        if (calling && !showHidden) { const dot = document.createElement('span'); dot.className = 'needs-dot'; dot.setAttribute('aria-label', 'one needs you'); toggle.append(' ', dot); }
        $('empty').hidden = conversations.length > 0;
        paintDeviceCount();
    }

    /* THE SEARCH: a step of its own (Back closes it); Escape empties it, then closes it. */
    function openSearch() {
        if (DEVICE) return;
        /* Asked for: the keyboard comes with it, lock or not. */
        if (!$('search').hidden) { $('search-field').focus(); return; }
        $('search').hidden = false; $('search-open').setAttribute('aria-expanded', 'true');
        nav.push('search', () => closeSearch());
        $('search-field').focus();
    }
    function closeSearch() {
        $('search').hidden = true; $('search-open').setAttribute('aria-expanded', 'false');
        $('search-field').value = ''; query = ''; chosenHit = 0;
        paint();
    }
    $('search-open').addEventListener('click', () => { if ($('search').hidden) openSearch(); else if (!nav.close('search')) closeSearch(); });
    $('search-field').addEventListener('input', () => { query = $('search-field').value.trim(); chosenHit = 0; paint(); });
    $('search-field').addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        const hits = [...$('items').querySelectorAll('.item')];
        if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if ($('search-field').value) { $('search-field').value = ''; query = ''; chosenHit = 0; paint(); return; }
            if (!nav.close('search')) closeSearch();
            $('search-open').focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            chosenHit += event.key === 'ArrowDown' ? 1 : -1;
            paint();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const hit = hits[chosenHit] ?? hits[0];
            if (hit) select(hit.dataset.name, { step: true });
        }
    });
    /* "/" or Ctrl+K, from anywhere but a field and the terminal (its tool needs its keys). */
    document.addEventListener('keydown', (event) => {
        if (DEVICE || event.defaultPrevented || event.isComposing || event.altKey) return;
        const slash = event.key === '/' && !event.ctrlKey && !event.metaKey;
        const k = (event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K');
        if (!slash && !k) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('#terminal') || target?.matches('input, textarea, select, [contenteditable]:not([contenteditable=false])')) return;
        if ($('list').hidden || (narrow() && app.dataset.view !== 'list')) return;
        event.preventDefault();
        openSearch();
    });

    /* MOVED BY HAND: dragged with a mouse; held, then dragged, with a finger;
       Alt and an arrow key from the keyboard. The server keeps the order. */
    let drag = null; let justDragged = false;
    const dropTarget = (d, x, y) => {
        const under = document.elementFromPoint(x, y);
        let el = under?.closest('#items .item, #items .group-head');
        if (!el || el === d.el) return null;
        if (d.kind === 'group') {
            if (el.classList.contains('item')) { if (!el.dataset.group) return null; el = el.closest('.group').querySelector('.group-head'); }
            if (el.dataset.fixed) return null;
            if (el === d.el) return null;
        }
        const box = el.getBoundingClientRect();
        const where = d.kind === 'item' && el.classList.contains('group-head') ? 'into' : y < box.top + box.height / 2 ? 'before' : 'after';
        return { el, where };
    };
    const unmark = () => { for (const x of $('items').querySelectorAll('[data-drop]')) x.removeAttribute('data-drop'); };
    function endDrag() {
        if (!drag) return;
        clearTimeout(drag.timer);
        drag.el.removeAttribute('data-dragging'); $('items').removeAttribute('data-dragging');
        unmark(); drag = null;
        listHeld = false;
        if (paintLater) { paintLater = false; paint(); }
    }
    function startDrag() {
        if (!drag) return;
        drag.on = true; drag.el.setAttribute('data-dragging', 'true'); $('items').setAttribute('data-dragging', 'true');
        if (drag.touch) navigator.vibrate?.(15);
    }
    async function dropped(d, target) {
        if (!target) return;
        try {
            if (d.kind === 'group') {
                const groups = groupsInOrder().filter((g) => g !== d.el.dataset.group);
                const at = groups.indexOf(target.el.dataset.group) + (target.where === 'after' ? 1 : 0);
                groups.splice(at, 0, d.el.dataset.group);
                await post(`${API}/order`, { groups });
            } else {
                const name = d.el.dataset.name;
                const was = conversations.find((c) => c.name === name)?.group ?? '';
                const group = target.where === 'into' ? target.el.dataset.group : target.el.dataset.group ?? '';
                const order = [...conversations].sort(byRank).map((c) => c.name).filter((n) => n !== name);
                const firstOf = order.findIndex((n) => (conversations.find((c) => c.name === n)?.group ?? '') === group);
                const at = target.where === 'into' ? (firstOf < 0 ? 0 : firstOf) : order.indexOf(target.el.dataset.name) + (target.where === 'after' ? 1 : 0);
                order.splice(at, 0, name);
                if (group !== was) await post(`${API}/conversations/${encodeURIComponent(name)}/group`, { group });
                await post(`${API}/order`, { order });
                if (target.where === 'into' && folded.has(group)) { folded.delete(group); keepFolded(); }
            }
        } catch (error) { show(error.message, 'Back', () => { notice.hidden = true; }); }
        await refresh();
    }
    $('items').addEventListener('pointerdown', (event) => {
        if (DEVICE || query || event.button !== 0) return;
        const el = event.target.closest('.item:not(.copy), .group-head:not([data-fixed])');
        if (!el) return;
        endDrag();
        drag = { el, kind: el.classList.contains('item') ? 'item' : 'group', x: event.clientX, y: event.clientY, id: event.pointerId, on: false, touch: event.pointerType !== 'mouse' };
        listHeld = true;
        if (drag.touch) drag.timer = setTimeout(startDrag, 450);
    });
    addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const far = Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 8;
        /* A finger that moves before it was held scrolls the list: no drag. */
        if (!drag.on) { if (drag.touch) { if (far) endDrag(); return; } if (!far) return; startDrag(); }
        event.preventDefault();
        unmark();
        const target = dropTarget(drag, event.clientX, event.clientY);
        if (target) target.el.dataset.drop = target.where;
    }, { passive: false });
    addEventListener('pointerup', (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const d = drag; const target = d.on ? dropTarget(d, event.clientX, event.clientY) : null;
        endDrag();
        if (!d.on) return;
        /* The click that ends a drag opens nothing. */
        justDragged = true; setTimeout(() => { justDragged = false; }, 0);
        void dropped(d, target);
    });
    addEventListener('pointercancel', () => endDrag());
    /* Held: the page neither scrolls nor offers its own menu under the finger. */
    document.addEventListener('touchmove', (event) => { if (drag?.on) event.preventDefault(); }, { passive: false });
    $('items').addEventListener('contextmenu', (event) => { if (drag) event.preventDefault(); });
    $('items').addEventListener('click', (event) => { if (justDragged) { event.stopPropagation(); event.preventDefault(); } }, true);
    $('items').addEventListener('keydown', async (event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        const el = event.target.closest('.item:not(.copy), .group-head:not([data-fixed])');
        if (!el) return;
        event.preventDefault();
        const to = event.key === 'ArrowUp' ? 'up' : 'down';
        try {
            if (el.classList.contains('item')) await post(`${API}/conversations/${encodeURIComponent(el.dataset.name)}/move`, { to });
            else await post(`${API}/groups/move`, { group: el.dataset.group, to });
        } catch { /* said by the list as it is */ }
        await refresh();
        const again = el.classList.contains('item') ? `.item[data-name="${CSS.escape(el.dataset.name)}"]` : `.group-head[data-group="${CSS.escape(el.dataset.group)}"]`;
        $('items').querySelector(again)?.focus();
    });

    async function refresh() {
        clearTimeout(pollTimer);
        try {
            const mark = (x) => (x ? `${x.phase}/${x.asleep === true}/${holds(x)}` : '');
            const before = mark(conversations.find((x) => x.name === current));
            if (DEVICE) {
                const mePath = () => `${API}/me?c=${encodeURIComponent(current)}`;
                let r = await fetch(mePath());
                if (leaving(r)) return;
                if (r.status === 401) {
                    /* The session ended: the device signs again, quietly. */
                    const door = await window.clavariumDoor();
                    if (!door.ok) { shut(door.message); return; }
                    /* The conversation shown was taken away, another one remains: it is shown instead. */
                    if (door.pairing !== pairing) { location.reload(); return; }
                    r = await fetch(mePath());
                }
                if (!r.ok) throw new Error('no api');
                const me = await r.json();
                /* What this device was given for itself, next to its conversations. */
                deviceShared = me.shared ?? [];
                if (me.name) deviceParts = { terminal: me.terminal === true, chat: me.chat ?? null };
                /* The conversation shown was taken back and another remains: the page starts over on it. */
                if (current && me.name !== current) { location.reload(); return; }
                conversations = me.name ? [me] : []; current = me.name ?? '';
            } else {
                const r = await fetch(`${API}/conversations`);
                if (leaving(r)) return;
                if (!r.ok) throw new Error('no api');
                conversations = await r.json();
                /* The rooms, for the list (their rows, Recent). */
                try { await loadRooms(); } catch { /* not set up yet */ }
                await readDevices();
                $('list').hidden = false; $('back').hidden = false; $('nav').hidden = false; $('list-resize').hidden = false;
            }
            home = true;
            if (conversations.find((x) => x.name === current)?.answerer?.needs) $('room').setAttribute('data-asking', '');
            paint();
            paintChips();
            paintHealth();
            if (!DEVICE) void paintGauge();
            const now = mark(conversations.find((x) => x.name === current));
            paintActions();
            if (before !== now || now.startsWith('building') || now.startsWith('restarting') || now.startsWith('moving')) enter(true);
        } catch { /* a server without VMs has no list: the page is one terminal */ }
        /* The panel is open: what the answerer did meanwhile is said there. */
        if (!DEVICE && panelShown) { void paintAnswerer(); paintWakeups(); paintMachine(conversations.find((x) => x.name === current)); }
        /* A start told step by step is asked about more often: its tool appears soon after its last step. */
        if (home) pollTimer = setTimeout(refresh, conversations.some(holds) ? 1500 : conversations.some((c) => c.phase === 'building' || c.phase === 'moving' || c.phase === 'restarting') ? 2500 : 10000);
    }

    /* ---------- A NEW CONVERSATION: a page of its own, as Settings ----------
       "+ New" opens it beside the list (the whole screen on a phone), with an
       address of its own (?open=new); Back, Escape, Cancel and its "<" link
       close it. From the map's "+" it is a step over the map, and goes back
       to it. Its tools are the server's (GET /api/tools). */
    let chosenTool = '';
    let newTools = [];
    const ID_SHAPE = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
    const NEW_FIELDS = ['name', 'group', 'id', 'memory'];
    function newError(field, text) {
        const at = field && NEW_FIELDS.includes(field) ? field : '';
        for (const f of NEW_FIELDS) {
            const said = $(`newconv-${f}-error`); const box = $(`newconv-${f}`);
            const mine = f === at && Boolean(text);
            said.textContent = mine ? text : ''; said.hidden = !mine;
            if (mine) box.setAttribute('aria-invalid', 'true'); else box.removeAttribute('aria-invalid');
        }
        const status = $('newconv-status');
        const general = !at && Boolean(text);
        status.textContent = general ? text : 'Ready in a few minutes';
        status.classList.toggle('error', general);
        if (at === 'id' || at === 'memory') $('newconv-more').open = true;
        if (at) $(`newconv-${at}`).focus();
    }
    /* Which field a refusal of the server is about (names.mjs, conversations.mjs, capacity.mjs). */
    function fieldOf(message) {
        if (/folder name/i.test(message)) return 'group';
        if (/already has this name|^A name is 1 to 32/.test(message)) return 'id';
        if (/memory/i.test(message)) return 'memory';
        if (/^(Give a name|A name )/.test(message)) return 'name';
        return '';
    }
    /* Memory: from what the chosen tool needs up to what a machine may have (MEMORY_CHOICES). */
    function paintNewMemory() {
        const tool = newTools.find((t) => t.id === chosenTool);
        const least = tool?.memoryMb ?? 512;
        const select = $('newconv-memory');
        const was = Number(select.value) || least;
        const mems = [...new Set([least, ...MEMORY_CHOICES.filter((m) => m > least)])];
        select.replaceChildren(...mems.map((m) => { const o = document.createElement('option'); o.value = String(m); o.textContent = sizeWords(m); return o; }));
        select.value = String(mems.includes(was) ? was : least);
        $('newconv-memory-least').textContent = tool ? `${tool.label} needs ${sizeWords(least)} at least` : '';
        /* Cores: 1 to what this server has (learnt from any machine we know), default 1. */
        const hostCpus = Math.max(1, ...conversations.map((c) => c.hostCpus ?? 1));
        const cpus = $('newconv-cpus'); const wasCpus = Number(cpus.value) || 1;
        cpus.replaceChildren(...Array.from({ length: hostCpus }, (_, i) => i + 1).map((n) => { const o = document.createElement('option'); o.value = String(n); o.textContent = `${n}${n === 1 ? ' (default)' : ''}${n === hostCpus && n > 1 ? ' (all of this server)' : ''}`; return o; }));
        cpus.value = String(wasCpus <= hostCpus ? wasCpus : 1);
        /* Disk: from the default up; it only grows afterwards. */
        const disk = $('newconv-disk'); const wasDisk = Number(disk.value) || 8;
        disk.replaceChildren(...DISK_CHOICES.map((d) => { const o = document.createElement('option'); o.value = String(d); o.textContent = `${d} GB${d === 8 ? ' (default)' : ''}`; return o; }));
        disk.value = String(DISK_CHOICES.includes(wasDisk) ? wasDisk : 8);
    }
    function paintNewTools() {
        const box = $('newconv-tools');
        if (!newTools.some((t) => t.id === chosenTool)) chosenTool = newTools[0]?.id ?? '';
        box.replaceChildren(...newTools.map((t) => {
            const b = el('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.tool = t.id;
            b.setAttribute('aria-checked', String(t.id === chosenTool));
            b.append(el('b', '', t.label), el('small', '', t.ai ? 'AI agent' : 'A terminal, no AI'));
            b.addEventListener('click', () => {
                chosenTool = t.id;
                for (const other of box.children) other.setAttribute('aria-checked', String(other === b));
                paintNewMemory(); void paintOpenCode();
            });
            return b;
        }));
        paintNewMemory(); void paintOpenCode();
    }
    /* OPENCODE SET UP HERE (03-11): a provider and one of its models from OpenCode's own catalogue (models.dev),
       its key one of the secrets (the one named as the provider reads it, when there is one) or a new one. */
    let ocProviders = null; let ocMode = 'set';
    const ocNew = '+';
    async function paintOpenCode() {
        const on = chosenTool === 'opencode';
        $('newconv-oc').hidden = !on;
        if (!on) return;
        if (!ocProviders) { try { ocProviders = (await (await fetch(`${API}/catalog/models`)).json()).providers ?? []; } catch { ocProviders = []; } }
        try { markSecrets(await (await fetch(`${API}/secrets`)).json()); } catch { /* the ones known */ }
        const prov = $('newconv-oc-provider');
        if (!prov.options.length) {
            prov.replaceChildren(...ocProviders.map((p) => { const o = el('option', '', p.name); o.value = p.id; return o; }));
            if (ocProviders.some((p) => p.id === 'mistral')) prov.value = 'mistral';
        }
        ocProvider();
    }
    function ocProvider() {
        const p = (ocProviders ?? []).find((x) => x.id === $('newconv-oc-provider').value);
        $('newconv-oc-model').replaceChildren(...(p?.models ?? []).map((m) => { const o = el('option', '', m.name); o.value = m.id; return o; }));
        const names = (secretsKnown ?? []).map((x) => x.name);
        const want = p?.env?.[0] ?? '';
        const key = $('newconv-oc-key');
        key.replaceChildren(...names.map((n) => { const o = el('option', '', `Secret: ${n}`); o.value = n; return o; }), Object.assign(el('option', '', want ? `+ New secret: ${want}` : '+ New secret'), { value: ocNew }));
        key.value = names.includes(want) ? want : ocNew;
        $('newconv-oc-new').hidden = key.value !== ocNew;
    }
    $('newconv-oc-provider').addEventListener('change', ocProvider);
    $('newconv-oc-key').addEventListener('change', () => { $('newconv-oc-new').hidden = $('newconv-oc-key').value !== ocNew; });
    for (const b of $('newconv-oc-mode').querySelectorAll('[data-m]')) b.addEventListener('click', () => {
        ocMode = b.dataset.m;
        for (const x of $('newconv-oc-mode').querySelectorAll('[data-m]')) x.setAttribute('aria-checked', String(x === b));
        $('newconv-oc-set').hidden = ocMode !== 'set'; $('newconv-oc-raw').hidden = ocMode === 'set';
    });
    /* -> { provider, model, secret } for the server, a new secret made first; null: nothing to set up. */
    async function openCodeChoice() {
        if (chosenTool !== 'opencode' || ocMode !== 'set') return null;
        const provider = $('newconv-oc-provider').value; const model = $('newconv-oc-model').value;
        if (!provider || !model) return null;
        let secret = $('newconv-oc-key').value;
        if (secret === ocNew) {
            const value = $('newconv-oc-value').value.trim();
            const p = (ocProviders ?? []).find((x) => x.id === provider);
            if (!value) throw new Error('Paste the API key, or choose « Install only ».');
            secret = p?.env?.[0] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
            await post(`${API}/secrets`, { name: secret, value });
            $('newconv-oc-value').value = '';
        }
        return { provider, model, secret };
    }
    for (const b of $('newconv-work').querySelectorAll('[data-work]')) {
        b.addEventListener('click', () => { for (const other of $('newconv-work').querySelectorAll('[data-work]')) other.setAttribute('aria-checked', String(other === b)); });
    }
    const newOnDisk = () => $('newconv-work').querySelector('[data-work="disk"]').getAttribute('aria-checked') === 'true';
    async function openNew({ push = true, group = null } = {}) {
        if (DEVICE) return;
        newError('', '');
        if (group !== null) $('newconv-group').value = group;
        if (place !== 'new') {
            /* From the map: a step over it, and back to it. Otherwise a place of its own. */
            if (place === 'access' && push) {
                showPlace('new');
                nav.push('create', ({ quiet }) => {
                    if (quiet || place !== 'new') return;
                    showPlace('access'); paintTabs(); remember();
                    void (mapMode === 'flows' ? links?.openFlows() : links?.open({ pin: accessFor ? `conversation:${accessFor}` : null }));
                }, { address: placeAddress() });
                $('newconv-close').textContent = '‹ Access';
            } else {
                enterPlace('new', push);
                $('newconv-close').textContent = '‹ Conversations';
            }
        }
        $('newconv').scrollTop = 0;
        focusField($('newconv-name'));
        try { const r = await fetch(`${API}/tools`); if (r.ok) newTools = await r.json(); } catch { /* kept as it was */ }
        paintNewTools();
    }
    /* Closed as any page is: the step on top (the place, or the step over the map). */
    function closeNew() {
        if (place !== 'new') return;
        if (!nav.close('create')) leavePlace();
    }
    $('hidden-toggle').addEventListener('click', () => { showHidden = !showHidden; paint(); });
    $('new').addEventListener('click', () => { void openNew(); });
    $('newconv-cancel').addEventListener('click', closeNew);
    $('newconv-close').addEventListener('click', closeNew);
    /* From the map's "+" of Conversations: the same page. */
    function createFromMap() { void openNew(); }
    /* The identifier drawn from the name, as the server draws it (names.mjs), shown before it is made; the server decides. */
    const identifierOf = (title) => String(title).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 32).replace(/-+$/, '') || 'conversation';
    $('newconv-name').addEventListener('input', () => { $('newconv-id').placeholder = identifierOf($('newconv-name').value.trim()); });
    for (const f of NEW_FIELDS) $(`newconv-${f}`).addEventListener(f === 'memory' ? 'change' : 'input', () => { if (!$(`newconv-${f}-error`).hidden) newError('', ''); });
    let creating = false;
    $('newconv').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (creating) return;
        const title = $('newconv-name').value.trim();
        const id = $('newconv-id').value.trim();
        const group = $('newconv-group').value.trim();
        if (!title) { newError('name', 'Give a name.'); return; }
        if (id && !ID_SHAPE.test(id)) { newError('id', 'Lower-case letters, digits, hyphens'); return; }
        const least = newTools.find((t) => t.id === chosenTool)?.memoryMb;
        const memoryMb = Number($('newconv-memory').value);
        const cpus = Number($('newconv-cpus').value); const diskGb = Number($('newconv-disk').value);
        newError('', '');
        creating = true; $('newconv-create').disabled = true;
        try {
            const opencode = await openCodeChoice();
            const made = await post(`${API}/conversations`, { ...(opencode ? { opencode } : {}), title, ...(id ? { name: id } : {}), ...(group ? { group } : {}), tool: chosenTool, workOnDisk: newOnDisk(), ...(document.getElementById('newconv-chat')?.checked === false ? { chat: false } : {}), ...(memoryMb && memoryMb !== least ? { memoryMb } : {}), ...(cpus && cpus !== 1 ? { cpus } : {}), ...(diskGb && diskGb !== 8 ? { diskGb } : {}) });
            $('newconv-name').value = ''; $('newconv-id').value = ''; $('newconv-id').placeholder = 'website-redesign'; $('newconv-group').value = '';
            $('newconv-work').querySelector('[data-work="kept"]').click(); $('newconv-more').open = false; { const ch = document.getElementById('newconv-chat'); if (ch) ch.checked = true; }
            await refresh();
            /* The new one is selected: the page gives way to it, with no step of it left behind. */
            select(made.name);
        } catch (error) {
            const field = fieldOf(error.message);
            newError(field, field === 'id' && /already has this name/.test(error.message) ? 'Already used by another conversation' : error.message);
        } finally { creating = false; $('newconv-create').disabled = false; }
    });

    /* ---------- shortcuts ---------- */
    /* A shortcut is keystrokes: its text, then Enter if it says so. The pause
       before Enter lets the tool take the text in first (measured: an Enter
       that follows too closely is read as part of a paste). */
    const ENTER_AFTER_MS = 300;
    let removing = false;
    async function paintShortcuts() {
        let all = [];
        try { const r = await fetch(`${API}/shortcuts`); if (r.ok) all = await r.json(); else return; } catch { return; }
        if (thread) thread.replies = asReplies(all);
        /* Shown only when the conversation can be typed into: painting it while a
           machine is built made it appear and vanish at each poll, a flicker. */
        const shown = conversations.find((x) => x.name === current);
        $('shortcuts').hidden = !current || (home && !(shown && shown.phase === 'ready'));
        const row = $('shortcut-row');
        row.replaceChildren();
        for (const shortcut of all) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = removing ? 'saved removing' : 'saved';
            b.dataset.enter = String(shortcut.enter);
            b.textContent = removing ? `Remove "${shortcut.label}"` : shortcut.label;
            b.title = shortcut.enter ? `Sends: ${shortcut.text}` : `Types, without sending: ${shortcut.text}`;
            b.addEventListener('click', async () => {
                if (removing) { await post(`${API}/shortcuts/${shortcut.id}/remove`).catch(() => {}); await paintShortcuts(); return; }
                send(shortcut.text);
                if (shortcut.enter) setTimeout(() => send('\r'), ENTER_AFTER_MS);
                focusTerminal();
            });
            row.append(b);
        }
        const quiet = (text, run) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = text; b.addEventListener('click', run); row.append(b); };
        if (DEVICE) return;
        if (removing) quiet('Done', () => { removing = false; void paintShortcuts(); });
        else {
            quiet('+ Shortcut', () => { $('shortcut-new').hidden = false; $('shortcut-error').hidden = true; $('shortcut-enter').checked = true; focusField($('shortcut-label')); });
            if (all.length > 0) quiet('Remove...', () => { removing = true; void paintShortcuts(); });
        }
    }
    /* In the chat, the same saved texts are its ready answers: one that
       presses Enter is sent, the other is put in its box to be completed.
       Only the owner's own: the first ones, as they came, say nothing of
       this conversation, and are not offered under a chat. */
    const asReplies = (all) => (Array.isArray(all) ? all : []).filter((x) => x.starter !== true).map((x) => ({ label: x.label, text: x.text, send: x.enter === true }));
    /* A device has them when it may type into its terminal, or write in its chat. */
    async function loadReplies() {
        if (DEVICE && !deviceParts.terminal && deviceParts.chat !== 'write') return [];
        try { const r = await fetch(`${API}/shortcuts`); return r.ok ? asReplies(await r.json()) : []; } catch { return []; }
    }
    $('shortcut-cancel').addEventListener('click', () => { $('shortcut-new').hidden = true; });
    $('shortcut-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            await post(`${API}/shortcuts`, { label: $('shortcut-label').value, text: $('shortcut-text').value, enter: $('shortcut-enter').checked });
            $('shortcut-label').value = ''; $('shortcut-text').value = ''; $('shortcut-new').hidden = true;
            await paintShortcuts();
        } catch (error) { $('shortcut-error').textContent = error.message; $('shortcut-error').hidden = false; }
    });

    /* ---------- voice ---------- */
    /* The microphone stays open; each phrase is typed into the terminal as it
       is understood, exactly as if typed. With "auto", Enter is pressed once
       the person has stopped: a new phrase beginning cancels the pending Enter.
       On the chat screen, dictation is the chat's own button, beside Send
       (Parley's slot, given this page's voice): what is said goes into its
       box, and nothing is typed into the terminal behind it. */
    const AUTO_ENTER_MS = 900;
    const WORDS = { calibrating: 'Listening to the room...', listening: 'Listening.', hearing: 'Hearing you...', transcribing: 'Writing what you said...' };
    let stopListening = null;
    let autoEnter = false;
    let enterTimer;
    const voiceLine = $('voice-line');
    const sayVoice = (text, kind) => { voiceLine.textContent = text; voiceLine.dataset.state = kind; voiceLine.hidden = text === ''; };
    function stopVoice() {
        stopListening?.(); stopListening = null; clearTimeout(enterTimer);
        $('mic').setAttribute('aria-pressed', 'false'); $('mic').textContent = 'Dictate';
        sayVoice('', '');
    }
    const chatBox = () => (simple && !$('simple-thread').hidden ? $('simple-thread').querySelector('.parley-box') : null);
    const backTo = () => { if (!chatBox()) focusTerminal(); };
    $('mic').addEventListener('click', async () => {
        if (stopListening) { stopVoice(); backTo(); return; }
        try {
            stopListening = await window.clavariumVoice.listen({
                state: (word) => sayVoice(WORDS[word] ?? word, word),
                speech: () => clearTimeout(enterTimer),
                phrase: (text) => {
                    /* The chat came up meanwhile, or there is no terminal: nothing is typed behind it. */
                    if (chatBox() || noTerminal()) return;
                    /* Its tool is told it was dictated (it may hold recognition mistakes): never in a shell, where it would break a command. */
                    const mark = conversations.find((x) => x.name === current)?.voiceMark === true && !markedSinceEnter ? '\u{1F3A4} ' : '';
                    send(`${mark}${text} `);
                    if (mark) markedSinceEnter = true;
                    sayVoice(`Typed: ${text}`, 'listening');
                    if (autoEnter) { clearTimeout(enterTimer); enterTimer = setTimeout(() => send('\r'), AUTO_ENTER_MS); }
                },
                error: (message) => sayVoice(message, 'calibrating'),
            });
            $('mic').setAttribute('aria-pressed', 'true'); $('mic').textContent = 'Stop';
        } catch {
            sayVoice('The microphone is not available. Allow it for this site, then try again.', 'calibrating');
            setTimeout(() => { if (!stopListening) sayVoice('', ''); }, 6000);
        }
        backTo();
    });
    $('auto').addEventListener('click', () => {
        autoEnter = !autoEnter;
        $('auto').setAttribute('aria-pressed', String(autoEnter));
        if (!autoEnter) clearTimeout(enterTimer);
        backTo();
    });
    /* The server says whether this page may dictate (a device: into a terminal or a chat it may write in). */
    let voiceOn = false;
    const chatVoice = () => (voiceOn && window.clavariumVoice ? window.clavariumVoice : null);
    async function offerVoice() {
        voiceOn = window.clavariumVoice ? await window.clavariumVoice.available() : false;
        $('mic').hidden = $('auto').hidden = !voiceOn;
        keysForChat();
        if (thread) thread.voice = chatVoice();
    }
    /* The chat alone: no row of keys at all; its dictation is the chat's own button. */
    function keysForChat() { if (noTerminal()) $('keys').hidden = true; }
    window.addEventListener('clavarium-voice-ready', () => { void offerVoice(); });
    /* The icons came after the files were drawn: drawn again with them. */
    window.addEventListener('clavarium-icons-ready', () => { if (document.querySelector('.icon:not([data-drawn])')) void paintFiles({ keep: true }).catch(() => {}); });
    void offerVoice();

    /* ---------- folders ---------- */
    const LEVELS = [['none', 'Off'], ['read', 'Read'], ['write', 'Write']];
    /* THE BAR (G): Chat | Terminal | Assets N, then its settings. What was
       given to it is counted on "Assets", and shown there. */
    let assetsShown = false; let roomPick = '';
    let listsShown = false; let listsOf = ''; let listsView = null;   /* its Lists tab: below */
    /* A secret near or past its expiry (secrets.mjs, WARN_DAYS): a dot on Assets, and on the
       Assets of a conversation that has it. Read with the list, at most once a minute. */
    let secretsKnown = []; let secretsReadAt = 0;
    const secretDue = (s) => s.expired === true || (typeof s.days === 'number' && s.days <= 7);
    function markSecrets(list) {
        secretsKnown = Array.isArray(list) ? list : []; secretsReadAt = Date.now();
        $('nav-assets').toggleAttribute('data-attention', secretsKnown.some(secretDue));
        $('view-assets').toggleAttribute('data-attention', secretsKnown.some((s) => secretDue(s) && s.conversations.includes(current)));
    }
    async function readSecretsNow() { if (!DEVICE) markSecrets(await (await fetch(`${API}/secrets`)).json().catch(() => [])); }
    function paintChips() {
        if (DEVICE) return;
        const c = conversations.find((x) => x.name === current);
        $('views').hidden = !c;
        const n = (c?.resources?.length ?? 0) + (c?.secrets?.length ?? 0) + (c?.work === 'kept' ? 1 : 0);
        $('assets-count').textContent = n ? String(n) : '';
        $('view-assets').toggleAttribute('data-attention', secretsKnown.some((s) => secretDue(s) && s.conversations.includes(current)));
        if (Date.now() - secretsReadAt > 60_000) { secretsReadAt = Date.now(); void readSecretsNow().catch(() => {}); }
        /* Its title names each of them, with what it may do. */
        $('view-assets').title = c ? [...(c.offline === true ? ['offline'] : []), ...(c.resources ?? []).map((r) => `${r.name} - ${r.access}`), ...(c.secrets ?? [])].join(', ') || 'Nothing given yet' : '';
        /* Lists: a tab once it was given one; counted, what waits for the owner's tick. */
        const given = c?.lists ?? null;
        $('view-lists').hidden = !given?.lists;
        $('lists-count').textContent = given?.waiting ? String(given.waiting) : '';
        $('view-lists').title = given?.waiting ? `${given.waiting} to approve` : LISTS_WORD.its;
        if (listsShown && !given?.lists) leaveLists();
        paintViews();
        /* Drawn again only when what it was given changed (not at each look at the list). */
        const sig = JSON.stringify([current, c?.resources, c?.secrets, c?.work]);
        if (assetsShown && sig !== roomSig) void paintRoomAssets();
    }
    let roomSig = '';
    function paintViews() {
        if (DEVICE) return;
        const now = tabNow();
        /* The "Loading the terminal..." veil belongs to the terminal: leaving it for the chat (or
           any other tab) takes the veil away, so a tab already there is not covered. */
        if (notice.dataset.loading && now !== 'terminal') notice.hidden = true;
        for (const [id, tab] of [['view-chat', 'chat'], ['view-terminal', 'terminal'], ['view-assets', 'assets'], ['view-lists', 'lists'], ['folders', 'settings']]) $(id).setAttribute('aria-pressed', String(now === tab));
    }
    /* THE FOUR TABS: Chat, Terminal, Assets, Settings. The one it opened on
       takes no step; any other is one step (one only, whichever other tab is
       shown), and Back comes back to the first. Changing tab closes what was
       open in the one before, and anything over the screen. */
    let panelShown = false;
    const tabNow = () => (assetsShown ? 'assets' : listsShown ? 'lists' : panelShown ? 'settings' : simple ? 'chat' : 'terminal');
    const TAB_WORD = { chat: 'Chat', terminal: 'Terminal', assets: 'Assets', get lists() { return LISTS_WORD.many; }, settings: 'Settings' };
    function openPanelZone() { closeRoomLists(); if (panelShown) return; panelShown = true; $('panel').hidden = false; paintViews(); }
    function closePanelZone() { if (!panelShown) return; panelShown = false; $('panel').hidden = true; $('attach-picker').hidden = true; paintViews(); }
    function showTab(which, pick) {
        if (which === 'assets') { closePanelZone(); void openRoomAssets(pick); return; }
        if (which === 'settings') { closeRoomAssets(); openPanelZone(); return; }
        if (which === 'lists') { closeRoomAssets(); closePanelZone(); void openRoomLists(pick); return; }
        closeRoomAssets(); closePanelZone(); closeRoomLists();
        if ((which === 'chat') !== simple) toggleSimple(); else { paintViews(); if (!simple) focusTerminal(); }
    }
    /* The tab it opened on: the one shown before any step of a tab, or the one a review came from. */
    function homeTab() {
        const t = nav.last(['tab']);
        if (t >= 0) return nav.step(t).home;
        const r = nav.first(['review']);
        return (r >= 0 && nav.step(r).home) || tabNow();
    }
    function goTab(which, { pick } = {}) {
        if (DEVICE || !current) { showTab(which, pick); return; }
        const home = homeTab();
        const t = nav.last(['tab']);
        if (which === home) nav.cut(nav.first(['tab', 'asset', 'review', 'over']));
        else if (t >= 0) nav.cut(t + 1);
        else {
            nav.cut(nav.first(['asset', 'review', 'over']));
            const step = nav.push('tab', ({ quiet }) => { if (!quiet) showTab(step.home); });
            step.home = home;
        }
        showTab(which, pick);
    }
    /* Another conversation, or the same one started again: its first tab, nothing open over it. */
    function resetTabs() {
        if (!DEVICE) nav.cut(nav.first(['tab', 'binder', 'asset', 'review', 'over']));
        else nav.cut(nav.first(['over']));
        closeRoomAssets(); closePanelZone(); closeRoomLists();
        $('files').hidden = $('copy').hidden = true;
    }
    /* Its settings closed for a question asked over its screen (a restart, a move). */
    function leavePanel() { if (panelShown && !nav.close('tab')) showTab(simple ? 'chat' : 'terminal'); }
    $('view-chat').addEventListener('click', () => goTab('chat'));
    $('view-terminal').addEventListener('click', () => goTab('terminal'));
    $('view-assets').addEventListener('click', () => goTab('assets'));
    $('view-lists').addEventListener('click', () => goTab('lists'));
    /* ITS LISTS: Binder's screen, cut to the lists given to it (read or write). Its binder and
       card are in the address (?c=coder&binder=batches&card=3): a reload finds them again. */
    const listsAddress = (p) => {
        if (DEVICE || !listsShown || place !== 'conversations' || !current) return;
        const q = new URLSearchParams({ c: current, ...(p?.list ? { binder: p.list } : {}), ...(p?.page === 'card' && p.card ? { card: p.card } : {}) });
        nav.replace(`?${q}`);
    };
    /* A card opened from the batches beside the chat: its way back is the step of the tab. */
    const tabFromChat = () => nav.top()?.kind === 'tab' && nav.top().home === 'chat';
    const listsSteps = binderSteps(() => listsView, { address: listsAddress, covered: tabFromChat, fromBack: () => nav.close('tab'), fromClose: () => showTab('chat') });
    async function openRoomLists(at = null) {
        if (DEVICE || !current) return;
        listsShown = true; $('clists').hidden = false; paintViews();
        if (listsView && listsOf === current) { if (at) await listsView.go(at); else void listsView.refresh(); listsAddress(listsView.place); return; }
        const name = current; listsOf = name;
        listsView = null;
        const view = await mountBinder($('clists-binder'), (l) => Boolean(l.grants?.[`conversation:${name}`]), { of: () => name, place: at, steps: listsSteps });
        if (listsOf === name) listsView = view;
    }
    function closeRoomLists() {
        if (!listsShown) return;
        listsShown = false; $('clists').hidden = true; paintViews();
        /* Left with a card open (the tab changed, Back to the chat): its binder, the next time. */
        if (listsView && listsView.place.page !== 'list') void listsView.go({ list: listsView.place.list });
        if (!DEVICE && place === 'conversations' && current) nav.replace(`?c=${encodeURIComponent(current)}`);
    }
    /* Its last list taken back: its first tab again. */
    function leaveLists() {
        /* Under a place (Assets, where it was taken back): changed in place, the place left open. */
        if (place !== 'conversations' || !nav.close('tab')) showTab(simple ? 'chat' : 'terminal');
    }
    /* ONE RULE: the left column is the platform, the bar is this conversation.
         Its Access chapter  what THIS conversation has: attached folders,
                   repositories and mailboxes, secrets handed to its tool,
                   its network. Nothing is created there; "Attach an asset"
                   opens the Access page on this conversation alone.
         Access > Assets  everything kept here, whatever the conversation:
                   made there, and attached to any conversation from there.
         Settings  this device, and the platform.
       (They used to be one sheet, "Folders & secrets", where what belonged to
       the platform and what belonged to one conversation were interleaved:
       the owner said he got lost in it.) */
    const kindOf = (resource) => (resource.type === 'mailbox' || resource.type === 'git' ? resource.type : 'folder');
    /* Giving a repository for writing next to a conversation that sends from
       it by itself: the server asks first (kind "confirm-shared"); the owner
       reads why, in words, and confirms with a button -- or does not. */
    const attachTo = async (conversation, name, access, errorId = 'panel-error', shared = false) => {
        $(errorId).hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(conversation)}/resources`, { resource: name, access, ...(shared ? { shared: true } : {}) }); }
        catch (error) {
            $(errorId).textContent = error.message; $(errorId).hidden = false;
            if (error.kind === 'confirm-shared') {
                const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'danger attach-shared'; yes.textContent = 'Confirm and attach';
                yes.addEventListener('click', async () => { yes.disabled = true; await attachTo(conversation, name, access, errorId, true); if (errorId === 'panel-error') await paintPanel(); else await paintAssets(); });
                $(errorId).append(' ', yes);
            }
        }
        await refresh();
    };
    const handTo = async (conversation, secret, attached, errorId = 'panel-error') => {
        $(errorId).hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(conversation)}/secrets`, { secret, attached }); }
        catch (error) { $(errorId).textContent = error.message; $(errorId).hidden = false; }
        await refresh();
    };
    /* A row of mode buttons; `chosen` is pressed; `pick(value)` on another. */
    function modes(options, chosen, pick, label) {
        const group = document.createElement('div'); group.className = 'levels'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
        for (const [value, text] of options) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.value = value;
            b.setAttribute('aria-pressed', String(value === chosen));
            b.addEventListener('click', async () => { if (value === chosen) return; for (const other of group.children) other.disabled = true; b.textContent = '...'; await pick(value); });
            group.append(b);
        }
        return group;
    }

    /* AUTOMATIC SENDING, FOR ONE CONVERSATION AND ONE REPOSITORY. Set where
       the conversation is given the repository for writing, because that is
       what it is about: what THIS agent may send by itself. Folded by
       default; the summary says whether it is on. "*" and the remote's
       default branch are refused by the server until the owner confirms
       them here, in words, under the form (not a browser dialog: the app
       also runs installed on a phone). */
    const autoOpen = new Set();
    function autoSending(conversation, name) {
        const where = `${API}/conversations/${encodeURIComponent(conversation)}/git/${name}/auto`;
        const box = document.createElement('details'); box.className = 'auto-send'; box.dataset.repository = name;
        box.open = autoOpen.has(`${conversation}/${name}`);
        box.addEventListener('toggle', () => { if (box.open) autoOpen.add(`${conversation}/${name}`); else autoOpen.delete(`${conversation}/${name}`); });
        const summary = document.createElement('summary'); summary.textContent = 'Automatic sending';
        const state = document.createElement('small'); state.className = 'hint auto-state'; summary.append(' ', state);
        const form = document.createElement('form'); form.autocomplete = 'off';
        const field = (text, input) => { const label = document.createElement('label'); label.textContent = text; label.append(input); return label; };
        const check = (text, input) => { const label = document.createElement('label'); label.className = 'check'; label.append(input, ` ${text}`); return label; };
        const branches = document.createElement('textarea'); branches.name = 'branches'; branches.rows = 2; branches.spellcheck = false; branches.setAttribute('autocapitalize', 'off'); branches.placeholder = 'test, staging, try/*';
        const number = (named, max) => { const i = document.createElement('input'); i.name = named; i.type = 'number'; i.min = '0'; i.max = String(max); i.step = '1'; i.inputMode = 'numeric'; return i; };
        const quiet = number('quietSeconds', 86400); const perHour = number('perHour', 1000);
        const create = document.createElement('input'); create.type = 'checkbox'; create.name = 'create';
        const checks = document.createElement('input'); checks.type = 'checkbox'; checks.name = 'checks';
        const hint = document.createElement('p'); hint.className = 'hint';
        hint.textContent = 'When one of its branches has commits the remote lacks, then nothing new for the quiet delay, and its name is in this list, it is sent to the branch of the same name, as Send would: never forced, only while this conversation\'s machine runs.';
        const asking = document.createElement('p'); asking.className = 'hint auto-confirm'; asking.hidden = true; asking.setAttribute('role', 'alert');
        /* Said plainly, whatever the list: what makes the server ask. */
        const unknown = document.createElement('p'); unknown.className = 'hint auto-unknown'; unknown.hidden = true;
        unknown.textContent = 'The remote\'s default branch is not known yet (it is learnt at a refresh): until it is, nothing is sent by itself unless you confirm each branch or pattern of the list.';
        const shared = document.createElement('p'); shared.className = 'hint auto-shared'; shared.hidden = true;
        const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger auto-sure'; sure.textContent = 'Confirm and save'; sure.hidden = true;
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = 'Save';
        const said = document.createElement('span'); said.className = 'hint auto-said'; said.setAttribute('role', 'status');
        const actions = document.createElement('div'); actions.className = 'row'; actions.append(save, sure, said);
        /* Closed until the settings there are have arrived: a list typed
           before would be overwritten by them. */
        const fields = document.createElement('fieldset'); fields.disabled = true;
        form.append(fields);
        fields.append(field('Branches it may send to by itself (one per line or comma, "try/*" allowed). Empty: never.', branches), hint,
            field('Quiet delay, in seconds', quiet), field('Sendings an hour, at most (0: no cap)', perHour),
            check('It may create a branch the remote does not have', create), check('Only after the checks passed in its machine', checks), unknown, shared, asking, actions);
        box.append(summary, form);
        const fill = (about) => {
            const s = about.settings;
            branches.value = s.branches.join('\n'); quiet.value = String(s.quietSeconds); perHour.value = String(s.perHour);
            create.checked = s.create; checks.checked = s.checks;
            state.textContent = s.branches.length ? `on: ${s.branches.join(', ')}` : 'off';
            unknown.hidden = Boolean(about.defaultBranch);
            const others = about.sharedWith ?? [];
            shared.hidden = others.length === 0;
            shared.textContent = `Other conversations write in this same folder (${others.join(', ')}): their commits can be sent by this setting, and the checks run on hooks they can write.`;
        };
        /* What the owner confirmed so far, for this form: each kind of
           confirmation is asked in turn, and sent again with the others. */
        const flags = {};
        const send = async (confirmed) => {
            said.textContent = ''; asking.hidden = true; sure.hidden = true;
            if (confirmed) Object.assign(flags, confirmed);
            const body = { branches: branches.value, quietSeconds: quiet.value === '' ? '' : Number(quiet.value), perHour: perHour.value === '' ? '' : Number(perHour.value), create: create.checked, checks: checks.checked, ...flags };
            const r = await fetch(where, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            const j = await r.json().catch(() => ({}));
            if (r.ok) { for (const k of Object.keys(flags)) delete flags[k]; fill(j); said.textContent = 'Saved.'; return; }
            /* Nothing was saved: the owner reads what it would allow, then confirms or changes the list. */
            if (j.kind === 'confirm-wide' || j.kind === 'confirm-shared') { asking.textContent = j.error; asking.hidden = false; sure.hidden = false; sure.dataset.kind = j.kind; return; }
            said.textContent = j.error || 'The request failed.';
        };
        form.addEventListener('submit', (event) => { event.preventDefault(); for (const k of Object.keys(flags)) delete flags[k]; void send(null); });
        sure.addEventListener('click', () => { void send(sure.dataset.kind === 'confirm-shared' ? { shared: true } : { sure: true }); });
        void fetch(where).then((r) => (r.ok ? r.json() : null)).then((about) => { if (about) { fill(about); fields.disabled = false; } }).catch(() => {});
        return box;
    }

    /* ---------- Access: this conversation ---------- */
    async function paintPanel() {
        const here = conversations.find((x) => x.name === current);
        $('panel-title').textContent = `This conversation - ${current}`;
        const all = await (await fetch(`${API}/resources`)).json();
        const mine = new Map((here?.resources ?? []).map((r) => [r.name, r.access]));
        const rows = $('panel-rows');
        rows.replaceChildren();
        for (const resource of all.filter((r) => mine.has(r.name))) {
            const kind = kindOf(resource);
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.name = resource.name;
            const label = document.createElement('b'); label.textContent = resource.name;
            const about = document.createElement('small'); about.className = 'hint'; about.textContent = ` ${KIND_WORD[kind]}`; label.append(about);
            const levels = kind === 'mailbox' ? fixedRight('mailbox')
                : modes([['read', 'Read'], ['write', 'Write']], mine.get(resource.name), async (access) => { await attachTo(current, resource.name, access); await paintPanel(); }, `Access of this conversation to ${resource.name}`);
            row.append(label, levels);
            if (kind === 'git') {
                const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Review & send';
                review.addEventListener('click', () => { void openGit(resource.name); });
                row.append(review);
            }
            /* Detached, not removed: it stays in Assets. */
            const detach = document.createElement('button'); detach.type = 'button'; detach.textContent = 'Detach'; detach.setAttribute('aria-label', `Detach ${resource.name} from this conversation`);
            detach.addEventListener('click', async () => { detach.disabled = true; detach.textContent = 'Detaching...'; await attachTo(current, resource.name, 'none'); await paintPanel(); });
            row.append(detach);
            /* Right under the access it depends on: read-only, the agent has nothing of its own to send. */
            if (kind === 'git' && mine.get(resource.name) === 'write' && !DEVICE) row.append(autoSending(current, resource.name));
            rows.append(row);
        }
        $('panel-empty').hidden = mine.size > 0;
        /* The secrets its tool is handed. */
        const secrets = DEVICE ? [] : await (await fetch(`${API}/secrets`)).json().catch(() => []);
        const handed = $('access-secrets'); handed.replaceChildren();
        for (const secret of secrets.filter((x) => x.conversations.includes(current))) {
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.name = secret.name;
            const label = document.createElement('b'); label.textContent = secret.name;
            const off = document.createElement('button'); off.type = 'button'; off.textContent = 'Detach'; off.setAttribute('aria-label', `Stop handing ${secret.name} to this conversation`);
            off.addEventListener('click', async () => {
                await handTo(current, secret.name, false); await paintPanel();
                $('secret-note').textContent = `${secret.name} will no longer be handed to the tool the next time it starts (leave the tool, then "Start it again").`;
            });
            row.append(label, fixedUse(), off); handed.append(row);
        }
        $('access-secrets-empty').hidden = handed.children.length > 0;
        paintConvStates(here);
        /* What can still be attached, for the picker. */
        const picker = $('attach-rows'); picker.replaceChildren();
        const offer = (name, kind, buttons) => {
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.name = name;
            const label = document.createElement('b'); label.textContent = name;
            const about = document.createElement('small'); about.className = 'hint'; about.textContent = ` ${kind}`; label.append(about);
            row.append(label, ...buttons); picker.append(row);
        };
        const act = (text, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', async () => { b.disabled = true; b.textContent = '...'; await run(); await paintPanel(); }); return b; };
        for (const resource of all.filter((r) => !mine.has(r.name))) {
            const kind = kindOf(resource);
            offer(resource.name, KIND_WORD[kind], kind === 'mailbox' ? [act('Read', () => attachTo(current, resource.name, 'read'))]
                : [act('Read', () => attachTo(current, resource.name, 'read')), act('Write', () => attachTo(current, resource.name, 'write'))]);
        }
        for (const secret of secrets.filter((x) => !x.conversations.includes(current))) {
            offer(secret.name, 'secret', [act('Use', async () => { await handTo(current, secret.name, true); $('secret-note').textContent = `${secret.name} will be handed to the tool the next time it starts (leave the tool, then "Start it again").`; })]);
        }
        $('attach-empty').hidden = picker.children.length > 0;
        /* Where the tool works, and the way to the other place. */
        const kept = here?.work === 'kept';
        $('work-box').hidden = DEVICE || !here;
        /* One short line; the why behind its ⓘ. */
        $('work-now-text').textContent = kept ? 'Kept here · shown in Files' : 'On the disk of its machine';
        $('work-now-why').textContent = kept
            ? 'Its files outlive the machine. It has a fixed size, and refuses symbolic links that point upwards or outside: a code project that installs packages belongs on the disk of its machine.'
            : 'Faster for a large code project, but its files are not shown in Files and go with the machine.';
        $('work-moved').textContent = here?.moved ?? ''; $('work-moved').hidden = !here?.moved;
        $('work-move').textContent = kept ? 'Move to its machine\'s disk...' : 'Keep it here...';
        $('work-move').onclick = () => {
            const to = kept ? 'disk' : 'kept';
            /* The question is asked over the terminal, not under this panel. */
            leavePanel();
            show(`Move the work of "${current}" ${kept ? 'to the disk of its machine' : 'into a folder kept here'}? THE TOOL IS STOPPED AND STARTED AGAIN: what it is doing now is interrupted, and a tool that keeps a conversation must be asked to resume it. Its files are copied; the move is refused if less than 1 GB would stay free${kept ? '' : ', or if the work holds symbolic links that a kept folder refuses'}.`,
                'Move it', async () => {
                    try { await post(`${API}/conversations/${encodeURIComponent(current)}/work`, { to }); await refresh(); enter(); }
                    catch (error) { show(error.message, 'Back to the terminal', enter); }
                }, () => { notice.hidden = true; focusTerminal(); });
        };
        void paintAnswerer(); paintWakeups(); void paintTalkBox(); void paintShareHere();
        paintMachine(here);
        void paintGuide(here);
        const offline = here?.offline === true;
        for (const b of $('network').children) b.setAttribute('aria-pressed', String((b.dataset.online === 'true') !== offline));
        await paintSignIn();
    }
    /* ---------- chapters (a conversation's settings, and Settings): folded or not ---------- */
    /* All folded when the app is opened: what the person opens stays open while this tab lives (a reload
       included), never from one day to the next -- a page that opens half-unfolded says nothing. What asks
       for them is said on the folded chapter instead (markAttention). */
    const OPEN_AT_FIRST = { 's-features': true };
    let chapters = {};
    try { chapters = JSON.parse(sessionStorage.getItem('clavarium-chapters') ?? '{}') ?? {}; } catch { /* a private window */ }
    try { localStorage.removeItem('clavarium-chapters'); } catch { /* as above */ }
    for (const chapter of document.querySelectorAll('details.chapter')) {
        const key = chapter.dataset.chapter;
        chapter.open = chapters[key] ?? OPEN_AT_FIRST[key] ?? false;
        chapter.addEventListener('toggle', () => {
            chapters[key] = chapter.open;
            try { sessionStorage.setItem('clavarium-chapters', JSON.stringify(chapters)); } catch { /* as above */ }
        });
    }
    /* A chapter that holds something asking for the person -- a callout, or a state said as a warning or a
       fault -- wears a dot on its title, folded or not: one look at Settings says where to go. */
    const asksForYou = (el2) => [...el2.querySelectorAll('.callout:not([data-tone="ok"]), .status-line[data-tone="warn"], .status-line[data-tone="bad"]')]
        .some((x) => !x.closest('[hidden]') && x.textContent.trim());
    let marking;
    const markAttention = () => { clearTimeout(marking); marking = setTimeout(() => {
        for (const chapter of document.querySelectorAll('details.chapter')) chapter.toggleAttribute('data-attention', asksForYou(chapter));
        /* And on its category, in the side list of Settings. */
        for (const b of document.querySelectorAll('.settings-tabs button[data-group]')) b.toggleAttribute('data-attention', Boolean(b.closest('.sheet')?.querySelector(`.settings-group[data-group="${b.dataset.group}"] details.chapter[data-attention]`)));
    }, 150); };
    new MutationObserver(markAttention).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'data-tone', 'class'] });
    /* Reached by a link (or a button that leads to it): opened, and said for a moment. */
    let reachedTimer;
    const openChapter = (key, { show = true } = {}) => {
        const chapter = document.querySelector(`details.chapter[data-chapter="${key}"]`);
        if (!chapter) return chapter;
        /* In a tab not shown: that tab first. */
        const group = chapter.closest('.settings-group.tab-off');
        if (group) group.closest('.sheet')?.showTab?.(group.dataset.group);
        chapter.open = true;
        if (show) {
            for (const other of document.querySelectorAll('details.chapter.reached')) other.classList.remove('reached');
            chapter.classList.add('reached');
            clearTimeout(reachedTimer); reachedTimer = setTimeout(() => chapter.classList.remove('reached'), 2000);
        }
        return chapter;
    };

    /* ---------- the machine: its health, its size, a restart ---------- */
    const sizeWords = (mb) => (mb >= 1024 ? `${Number.isInteger(mb / 1024) ? mb / 1024 : (mb / 1024).toFixed(1)} GB` : `${mb} MB`);
    /* The size kept for its wake, in the words the server uses for a size. */
    function laterWords(w) { return `${w.memoryMb} MB, ${w.cpus} core${w.cpus > 1 ? 's' : ''}, ${w.diskGb} GB`; }
    /* `brief`: over a wait, only what to know -- figures stay in the Machine chapter. */
    function healthLines(list, record, { all = true, brief = false } = {}) {
        list.replaceChildren();
        const problems = (record?.problems ?? []).filter((p) => all || p.level === 'warn' || p.level === 'bad');
        for (const p of problems) { const li = document.createElement('li'); li.dataset.level = p.level; li.textContent = p.text; list.append(li); }
        if (all && record && record.state === 'Running' && record.answering) {
            const li = document.createElement('li'); li.dataset.level = problems.length ? 'info' : 'ok';
            if (brief) { li.textContent = problems.length ? 'Its machine runs; see above what is wrong.' : 'Its machine runs and looks well: the terminal is being opened again.'; list.prepend(li); return problems.length; }
            const parts = [problems.length ? 'Running' : 'Running, and nothing wrong was seen'];
            if (record.memory) parts.push(`memory: ${record.memory.availableMb} MB free of ${record.memory.totalMb} MB`);
            if (record.disks?.['/']) parts.push(`disk: ${record.disks['/'].availableMb} MB left`);
            li.textContent = `${parts.join('; ')} (looked at ${new Date(record.at).toLocaleTimeString()}).`;
            list.prepend(li);
        }
        if (all && !record) { const li = document.createElement('li'); li.dataset.level = 'info'; li.textContent = 'Not looked at yet.'; list.append(li); }
        return problems.length;
    }
    /* Said over the terminal while something is wrong; dismissed until something else is. */
    let healthDismissed = '';
    function paintHealth() {
        const c = conversations.find((x) => x.name === current);
        const h = c?.health;
        /* What it says that was not marked "Seen" (health.mjs): the strip is for those only. */
        const shown = (h?.problems ?? []).filter((p) => (p.level === 'warn' || p.level === 'bad') && !(h.seen ?? []).includes(p.key));
        const serious = shown.length > 0 && c.phase === 'ready' && !c.asleep;
        const level = shown.some((p) => p.level === 'bad') ? 'bad' : 'warn';
        const key = serious ? `${current}:${shown.map((p) => p.text).join('|')}` : '';
        $('health-strip').hidden = !serious || key === healthDismissed;
        /* Running, but not well: the dot beside "live" says so too. */
        state.dataset.health = serious ? level : '';
        if (!serious) return;
        $('health-strip').dataset.level = level;
        $('health-text').textContent = shown.map((p) => p.text).join(' ');
        /* What can be done, from here: more memory where memory is short, a restart, its terminal when the chat is in front.
           A disk short of room: what takes it, in the terminal, and (on a wide screen) a larger disk -- a restart frees nothing. */
        const disk = shown.some((p) => p.kind === 'disk'); const diskOnly = shown.every((p) => p.kind === 'disk');
        $('health-memory').hidden = DEVICE || !shown.some((p) => p.kind === 'memory');
        $('health-room').hidden = !disk || noTerminal();
        $('health-disk').hidden = DEVICE || !disk || narrow();
        $('health-restart').hidden = DEVICE || diskOnly;
        $('health-terminal').hidden = !simple || noTerminal() || disk;
        /* "Seen", for every screen: it no longer calls its owner until something else comes (a device: only here). */
        $('health-dismiss').onclick = () => { healthDismissed = key; $('health-strip').hidden = true; if (!DEVICE) void markSeen(); };
    }
    /* "More memory...": its memory, ready to be chosen -- the next size up already picked, applied only once asked. */
    async function openMemory() {
        if (DEVICE || !current) return;
        await openAccess(false);
        openChapter('machine');
        const memory = $('machine-memory');
        const now = conversations.find((x) => x.name === current)?.memoryMb ?? 0;
        const bigger = [...memory.options].map((o) => Number(o.value)).find((mb) => mb > now);
        if (bigger) memory.value = String(bigger);
        memory.scrollIntoView({ block: 'center' });
        memory.focus({ preventScroll: true });
    }
    /* "Give it more disk...": its disk, ready to be chosen -- the next size up already picked, applied only once asked. */
    async function openDisk() {
        if (DEVICE || !current) return;
        await openAccess(false);
        openChapter('machine');
        const disk = $('machine-disk');
        const now = conversations.find((x) => x.name === current)?.diskGb ?? 8;
        const bigger = [...disk.options].map((o) => Number(o.value)).find((gb) => gb > now);
        if (bigger) disk.value = String(bigger);
        disk.scrollIntoView({ block: 'center' });
        disk.focus({ preventScroll: true });
    }
    /* Its terminal, asked for: never shown by itself in place of its chat. */
    /* "Seen": what its machine says now no longer puts it in Needs you (health.mjs). */
    async function markSeen() {
        if (!current || DEVICE) return;
        try { const record = await post(`${API}/conversations/${encodeURIComponent(current)}/health/seen`, {}); const c = conversations.find((x) => x.name === current); if (c) c.health = record; paint(); paintHealth(); if (thread && threadOf === current) void thread.refresh(); }
        catch (error) { show(error.message, 'Back', () => { notice.hidden = true; }); }
    }
    function seeTerminal() { if (DEVICE) { simple = false; paintSimple(); focusTerminal(); } else goTab('terminal'); paintHealth(); }
    $('health-memory').addEventListener('click', () => { void openMemory(); });
    $('health-terminal').addEventListener('click', seeTerminal);
    $('health-room').addEventListener('click', seeTerminal);
    $('health-disk').addEventListener('click', () => { void openDisk(); });
    /* The page has waited, or the terminal failed: the machine is looked at
       (never woken), and what is seen is said under the notice. A restart is
       offered only when its machine is not well, or when the wait is far
       longer than a start takes (`long`): never while it merely starts. */
    async function explainMachine(waiting, long = false) {
        if (DEVICE || !home || !current) return;
        const name = current;
        let record;
        try { record = await post(`${API}/conversations/${encodeURIComponent(name)}/health`, {}); } catch { return; }
        if (name !== current) return;
        const c = conversations.find((x) => x.name === name);
        if (c) c.health = record;
        /* The terminal may have come while the machine was being looked at: then the wait is over, nothing to say. */
        if (waiting && !waitingSince) return;
        /* Nothing over the screen to say it under: a long wait still says so. */
        /* The neutral word of a load is not a place to list troubles either, until the wait is long. */
        const quiet = notice.hidden || Boolean(notice.dataset.loading);
        /* The chat (or any tab but the terminal) in front: a terminal slow to come back -- often only this page
           reconnecting after an update -- is not put over it (03-11); it comes back by itself, behind. */
        if (tabNow() !== 'terminal' && !['warn', 'bad'].includes(record?.level)) { if (notice.dataset.loading || /terminal/i.test($('notice-text').textContent)) notice.hidden = true; return; }
        if (quiet && !long) return;
        if (quiet) show(record && record.level !== 'bad' && record.level !== 'warn' ? 'Reconnecting to its terminal\u2026' : 'Its terminal still does not come.');
        /* Waking it is what the page is doing: "it is asleep" would say the opposite. */
        const said = waiting && record ? { ...record, problems: (record.problems ?? []).filter((p) => p.kind !== 'state') } : record;
        const shown = healthLines($('notice-health'), said, { all: true, brief: true });
        $('notice-health').hidden = $('notice-health').childElementCount === 0;
        /* A restart is offered only when its machine is not well: a machine that runs and looks well is not restarted for a slow page (03-11). */
        $('notice-restart').hidden = !(record && (record.level === 'bad' || record.level === 'warn'));
        $('notice-restart').onclick = () => restartMachine(false);
        const text = $('notice-text').textContent.replace(/ This takes much longer than a start usually does\.$/, '');
        if (long) $('notice-text').textContent = `${text} This takes much longer than a start usually does.`;
        void shown;
    }
    /* ITS TERMINAL DOES NOT COME, THOUGH ITS MACHINE RUNS: the server is asked
       to repair it (its channel closed, its tmux looked at), then it is
       opened again. Its machine starting: nothing to repair, the wait goes on. */
    async function repairTerminal(name) {
        if (!home || name !== current) return;
        /* Repaired in silence: a repair that works is only a slower load. Said only if it does not help (stuck). */
        say('connecting', 'connecting');
        if (notice.hidden || notice.dataset.loading) loading();
        try { await post(DEVICE ? `${API}/terminal/repair?${new URLSearchParams({ c: name })}` : `${API}/conversations/${encodeURIComponent(name)}/terminal/repair`, {}); }
        catch (error) {
            if (name !== current) return;
            if (error.retry) { show('Its machine is starting: its terminal comes as soon as it is there.'); $('notice-spin').hidden = false; return; }
            stuck(name, error.message);
            return;
        }
        if (name !== current) return;
        repairedFor = name;
        connect({ again: true });
    }
    /* Repaired, and it still does not come: what to do, said plainly. */
    function stuck(name, why) {
        if (name !== current) return;
        say('no terminal', 'ended');
        show(`${why ? `${why} ` : ''}Its terminal does not come, though its machine runs, and repairing it did not help.${DEVICE ? ' Tell its owner: restarting its machine usually brings it back.' : ' Restarting its machine usually brings it back: the tool is stopped and started again; its files and its chat stay.'}`, 'Try again', connect);
        $('notice-restart').hidden = DEVICE;
        $('notice-restart').onclick = () => restartMachine(false);
    }
    /* RESTARTING ITS MACHINE: asked first, in words, over the terminal. */
    async function restartMachine(confirmed) {
        const name = current;
        if (!name) return;
        leavePanel();
        if (!confirmed) {
            const resume = socket && state.dataset.state === 'live' ? () => { notice.hidden = true; focusTerminal(); } : enter;
            show(`Restart the machine of "${name}"? It is stopped cleanly (by force if it does not stop), then started again. THE TOOL IS STOPPED AND STARTED AGAIN: what it is doing now is interrupted. Its work folder, its folders and its branches stay.`,
                'Restart', () => void restartMachine(true), resume);
            return;
        }
        disconnect();
        say('restarting', 'connecting'); show('Restarting its machine...'); $('notice-spin').hidden = false;
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/restart`, {}); healthDismissed = ''; await refresh(); enter(); }
        catch (error) { show(error.message, 'Back', enter); }
    }
    $('restart').addEventListener('click', () => { void restartMachine(false); });
    $('health-restart').addEventListener('click', () => { void restartMachine(false); });
    $('health-check').addEventListener('click', async () => {
        $('health-check').disabled = true; $('health-check').textContent = 'Looking...';
        try { const record = await post(`${API}/conversations/${encodeURIComponent(current)}/health`, {}); const c = conversations.find((x) => x.name === current); if (c) c.health = record; healthDismissed = ''; paintMachine(c); paintHealth(); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        finally { $('health-check').disabled = false; $('health-check').textContent = 'Look now'; }
    });
    const MEMORY_CHOICES = [768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384];
    const DISK_CHOICES = [8, 10, 16, 20, 32, 48, 64, 96, 128, 192, 256];
    /* WHEN ITS MACHINE IS SHORT: its agent told (a line you can change), or a command run when it has no agent. */
    async function paintReact(here) {
        if (!here || DEVICE) return;
        const s = await fetch(`${API}/conversations/${encodeURIComponent(here.name)}/health-react`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!s) return;
        $('react-on').checked = s.on;
        $('react-on-label').textContent = s.agent ? 'Also tell its agent' : 'Also run a command in its machine';
        $('react-message').hidden = !s.agent; $('react-command').hidden = s.agent;
        $('react-message').value = s.message; $('react-command').value = s.command;
        $('react-said').textContent = '';
    }
    $('react-box').addEventListener('submit', async (event) => {
        event.preventDefault();
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/health-react`, { on: $('react-on').checked, message: $('react-message').value, command: $('react-command').value }); $('react-said').textContent = 'Saved.'; }
        catch (error) { $('react-said').textContent = error.message; }
    });
    /* WHY ITS TOOL STOPPED, said plainly: cut for lack of memory (and what to do), else its log's
       last lines. `last` was kept when it ended; `now` is read in the machine when it runs. */
    function paintToolExit(r) {
        const body = $('tool-exit-body'); body.replaceChildren();
        const rep = r?.last ?? null; const now = r?.now ?? null;
        if (!rep && !now) { body.hidden = !r; if (r) body.append(el('p', 'hint', 'Nothing kept yet: its tool has not ended since this was added, and its machine is not running.')); return; }
        body.hidden = false;
        const show = (title, x) => {
            if (!x) return;
            const box = el('div', 'tool-exit-one');
            box.append(el('p', '', [title, x.at ? new Date(x.at).toLocaleString() : ''].filter(Boolean).join(' · ')));
            if (x.oom?.length) {
                box.append(el('p', 'error', `Stopped for lack of memory: the machine${x.memoryMb ? ` (${sizeWords(x.memoryMb)})` : ''} ran out. Give it more memory below, or start its tool fresh.`));
                const pre = el('pre', 'tool-exit-lines'); pre.textContent = x.oom.join('\n'); box.append(pre);
            } else box.append(el('p', 'hint', 'No program was stopped for lack of memory.'));
            if (x.log?.length) {
                const d = document.createElement('details'); const sm = document.createElement('summary'); sm.textContent = `Last lines of its own log${x.logFile ? ` (${x.logFile.split('/').pop()})` : ''}`;
                const pre = el('pre', 'tool-exit-lines'); pre.textContent = x.log.join('\n'); d.append(sm, pre); box.append(d);
            }
            body.append(box);
        };
        show('Now, in its machine', now);
        show('When its tool last ended', rep);
    }
    $('tool-exit-look').addEventListener('click', async () => {
        const b = $('tool-exit-look'); b.disabled = true; b.textContent = 'Looking…';
        try { paintToolExit(await post(`${API}/conversations/${encodeURIComponent(current)}/exit-report`, {})); }
        catch (error) { $('tool-exit-body').replaceChildren(el('p', 'error', error.message)); $('tool-exit-body').hidden = false; }
        b.disabled = false; b.textContent = 'Why did its tool stop?';
    });
    function paintMachine(here) {
        void paintReact(here);
        /* Its curves: asked again when it changes, or once in a while (paintCurves). */
        const curves = $('machine-curves');
        if (curves.dataset.of !== (here?.name ?? '')) { curves.dataset.of = here?.name ?? ''; curves.dataset.span = '1h'; for (const x of curves.querySelectorAll('.curves-span button')) x.setAttribute('aria-pressed', String(x.dataset.span === '1h')); }
        if (!DEVICE) void paintCurves(curves); else curves.hidden = true;
        /* General: what it is. */
        const facts = $('general-facts'); facts.replaceChildren();
        const fact = (term, value) => { const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; facts.append(dt, dd); };
        if (here) {
            fact('Identifier', here.name);
            fact('Tool', here.toolLabel ?? here.tool);
            if (here.createdAt) fact('Created', new Date(here.createdAt).toLocaleString());
            fact('Machine', `${sizeWords(here.memoryMb)} of memory, ${here.diskGb ? `${here.diskGb} GB` : 'an unknown size of'} disk`);
            fact('Works in', here.work === 'kept' ? 'a folder kept here (/work)' : 'the disk of its machine (/work)');
        }
        healthLines($('machine-health'), here?.health ?? null);
        if ($('tool-exit').dataset.of !== (here?.name ?? '')) { $('tool-exit').dataset.of = here?.name ?? ''; paintToolExit(here?.lastExit ? { last: here.lastExit } : null); }
        $('machine-restarted').textContent = here?.restarted ?? ''; $('machine-restarted').hidden = !here?.restarted;
        /* The choices are not painted over while somebody is choosing. */
        const memory = $('machine-memory'); const disk = $('machine-disk'); const cores = $('machine-cpus');
        const of = `${here?.name}/${here?.memoryMb}/${here?.diskGb}/${here?.memoryMinMb}/${here?.cpus}`;
        if (here && memory.dataset.of !== of && document.activeElement !== memory && document.activeElement !== disk && document.activeElement !== cores) {
            /* Cores: 1 to those of the server, which its machines share. */
            const most = Math.max(here.hostCpus ?? 1, here.cpus ?? 1);
            cores.replaceChildren(...Array.from({ length: most }, (_, i) => i + 1).map((n) => { const o = document.createElement('option'); o.value = String(n); o.textContent = `${n}${n === (here.cpus ?? 1) ? ' (now)' : ''}${n === most && n > 1 ? ' (all of this server)' : ''}`; return o; }));
            cores.value = String(here.cpus ?? 1);
            const least = here.memoryMinMb ?? 512;
            const mems = [...new Set([...MEMORY_CHOICES.filter((m) => m >= least), here.memoryMb])].sort((a, b) => a - b);
            memory.replaceChildren(...mems.map((m) => { const o = document.createElement('option'); o.value = String(m); o.textContent = `${sizeWords(m)}${m === here.memoryMb ? ' (now)' : ''}${m === least ? ' (least for its tool)' : ''}`; return o; }));
            memory.value = String(here.memoryMb);
            const now = here.diskGb ?? 8;
            const disks = [...new Set([now, ...DISK_CHOICES.filter((d) => d > now)])].sort((a, b) => a - b);
            disk.replaceChildren(...disks.map((d) => { const o = document.createElement('option'); o.value = String(d); o.textContent = `${d} GB${d === now ? ' (now)' : ''}`; return o; }));
            disk.value = String(now);
            memory.dataset.of = of;
        }
        /* Not ready (built, restarted, moved): its sizes are shown, and chosen once it is. */
        $('machine-size').hidden = DEVICE || !here || here.phase === 'failed';
        const waiting = here && (here.phase !== 'ready' || holds(here)) ? (here.phase === 'moving' ? 'Available once it has moved.' : here.phase === 'restarting' || (here.phase === 'ready' && here.progress?.kind !== 'build') ? 'Available once it has restarted.' : 'Available once its machine is built.') : '';
        for (const id of ['machine-memory', 'machine-cpus', 'machine-disk', 'machine-size-apply']) $(id).disabled = Boolean(waiting);
        $('machine-size').toggleAttribute('data-waiting', Boolean(waiting));
        $('machine-size-wait').textContent = waiting; $('machine-size-wait').hidden = !waiting;
        /* Asleep: chosen now, applied as it wakes -- it is not woken for it. */
        $('machine-size-hint').textContent = here?.asleep === true
            ? 'Asleep: applied when it wakes · a disk only grows'
            : 'Restarts it · a disk only grows';
        $('machine-later-text').textContent = here?.sizeAtWake ? `Will be applied when it wakes: ${laterWords(here.sizeAtWake)}` : '';
        $('machine-later').hidden = !here?.sizeAtWake;
        $('machine-size-apply').textContent = here?.asleep === true ? 'Keep for its wake' : 'Apply...';
        /* When its tool starts: its last session, or a new one -- for a tool that can take one up. */
        $('resume-box').hidden = DEVICE || !here?.resumes;
        for (const b of $('resume-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === (here?.resume !== false)));
        /* Whether its tool asks before acting -- for a tool that can be given every right in its machine. */
        $('rights-box').hidden = DEVICE || !here?.rights;
        for (const b of $('ask-first').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === (here?.askFirst === true)));
        void paintConvHand(here);
        paintConvStates(here);
    }
    /* A CONVERSATION'S AT HAND: its machine's three tiles, from its health (memory, disk) and its last hour
       (/api/history, read at most every 30 s). */
    const convHandAt = { of: '', at: 0, h: null };
    async function paintConvHand(here) {
        const box = $('panel-tiles');
        if (DEVICE || !here || here.asleep || here.phase !== 'ready') { box.hidden = true; return; }
        if (convHandAt.of !== here.name || Date.now() - convHandAt.at > 30_000) { convHandAt.of = here.name; convHandAt.at = Date.now(); convHandAt.h = await handHistory(here.name); }
        if (current !== here.name) return;
        const h = convHandAt.h; const health = here.health;
        const tiles = [];
        const mem = health?.memory;
        const memUsed = mem?.totalMb ? 100 - (mem.availableMb / mem.totalMb) * 100 : lastOf(h?.memory);
        if (memUsed !== null && memUsed !== undefined) tiles.push(handTile(uiSaid('set-memory', 'Memory'), memUsed, mem ? uiSaid('set-free-of', '{free} free of {total}', { free: GB(mem.availableMb), total: GB(mem.totalMb) }) : '', h?.memory, levelAt(memUsed)));
        const diskLeft = health?.disks?.['/']?.availableMb;
        const diskUsed = lastOf(h?.disk) ?? (diskLeft !== undefined && here.diskGb ? 100 - (diskLeft / (here.diskGb * 1024)) * 100 : null);
        if (diskUsed !== null) tiles.push(handTile(uiSaid('set-disk', 'Disk'), diskUsed, diskLeft !== undefined ? uiSaid('set-left-of', '{free} left of {total}', { free: GB(diskLeft), total: `${here.diskGb} GB` }) : `${here.diskGb} GB`, h?.disk, levelAt(diskUsed)));
        const cpu = lastOf(h?.cpu);
        if (h) tiles.push(handTile(uiSaid('set-cpu', 'CPU'), cpu, uiSaid(here.cpus === 1 ? 'set-core' : 'set-cores', here.cpus === 1 ? '1 core' : '{n} cores', { n: here.cpus ?? 1 }), h.cpu, levelAt(cpu ?? 0)));
        for (const t of tiles) t.addEventListener('click', () => { openChapter('machine')?.scrollIntoView({ block: 'start' }); });
        box.replaceChildren(...tiles); box.hidden = tiles.length === 0;
    }
    /* What each folded chapter of a conversation says: its state now. */
    function paintConvStates(here) {
        if (DEVICE || !here) return;
        const join = (...parts) => parts.filter(Boolean).join(' · ');
        chapterNow('general', join(here.title || here.name, here.group, here.toolLabel ?? here.tool));
        chapterNow('machine', join(sizeWords(here.memoryMb), uiSaid(here.cpus === 1 ? 'set-core' : 'set-cores', here.cpus === 1 ? '1 core' : '{n} cores', { n: here.cpus ?? 1 }), here.diskGb ? `${here.diskGb} GB` : ''));
        const attached = (here.resources ?? []).length; const secrets = $('access-secrets').children.length;
        chapterNow('access', join(uiSaid('set-attached', '{n} attached', { n: attached }), secrets ? uiSaid(secrets === 1 ? 'set-secret' : 'set-secrets', secrets === 1 ? '1 secret' : '{n} secrets', { n: secrets }) : '', here.offline ? uiSaid('set-offline', 'offline') : ''));
        const shared = $('share-here').children.length;
        chapterNow('sharing', shared ? uiSaid(shared === 1 ? 'set-device' : 'set-devices', shared === 1 ? '1 device' : '{n} devices', { n: shared }) : uiSaid('set-no-device', 'No device'));
        const chatOn = levelsWord('talk-on');
        chapterNow('chat', join(chatOn ? `${uiSaid('set-chat', 'Chat')} ${chatOn.toLowerCase()}` : '', here.chatName ? `“${here.chatName}”` : ''));
        const w = here.wakeups?.items ?? [];
        chapterNow('wakeups', w.length ? uiSaid('set-wakeups-on', '{on} of {n} on', { on: w.filter((x) => x.on).length, n: w.length }) : uiSaid('set-none', 'None'));
        chapterNow('answerer', here.answerer ? (here.answerer.on ? uiSaid('set-on', 'On') : uiSaid('set-off', 'Off')) : '');
        const hl = here.health;
        const wrong = (hl?.problems ?? []).filter((p) => p.level === 'warn' || p.level === 'bad');
        chapterNow('health', here.asleep ? uiSaid('set-asleep', 'Asleep') : !hl ? uiSaid('set-not-looked', 'Not looked at yet') : join(wrong.length ? wrong[0].text : hl.state === 'Running' ? uiSaid('set-running-well', 'Running · nothing wrong') : hl.state, hl.at ? agoSaid(hl.at) : ''));
        chapterNow('advanced', uiSaid('set-conv-advanced', 'Archive · reset · delete'));
    }
    for (const b of $('ask-first').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/ask-first`, { on: b.dataset.on === 'true' }); await refresh(); paintMachine(conversations.find((x) => x.name === current)); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    for (const b of $('resume-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/resume`, { on: b.dataset.on === 'true' }); await refresh(); paintMachine(conversations.find((x) => x.name === current)); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    $('machine-later-cancel').addEventListener('click', async () => {
        $('panel-error').hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/machine/cancel`, {}); await refresh(); paintMachine(conversations.find((x) => x.name === current)); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    $('machine-size').addEventListener('submit', (event) => {
        event.preventDefault();
        const name = current;
        const here = conversations.find((x) => x.name === name);
        if (!here) return;
        const memoryMb = Number($('machine-memory').value); const diskGb = Number($('machine-disk').value); const cpus = Number($('machine-cpus').value) || (here.cpus ?? 1);
        if (memoryMb === here.memoryMb && diskGb === (here.diskGb ?? 8) && cpus === (here.cpus ?? 1)) { $('panel-error').textContent = 'Nothing to change: choose another memory, cores or disk first.'; $('panel-error').hidden = false; return; }
        const changes = [memoryMb !== here.memoryMb ? `${sizeWords(memoryMb)} of memory (now ${sizeWords(here.memoryMb)})` : '', cpus !== (here.cpus ?? 1) ? `${cpus} core${cpus > 1 ? 's' : ''} (now ${here.cpus ?? 1})` : '', diskGb !== (here.diskGb ?? 8) ? `a disk of ${diskGb} GB (now ${here.diskGb ?? 8} GB; it can never shrink again)` : ''].filter(Boolean).join(' and ');
        /* Asleep: kept for its wake, from Settings, where it is then said; nothing is stopped or woken now. */
        if (here.asleep === true) {
            $('panel-error').hidden = true;
            void (async () => {
                try { await post(`${API}/conversations/${encodeURIComponent(name)}/machine`, { memoryMb, diskGb, cpus }); await refresh(); paintMachine(conversations.find((x) => x.name === name)); }
                catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
            })();
            return;
        }
        leavePanel();
        const resume = socket && state.dataset.state === 'live' ? () => { notice.hidden = true; focusTerminal(); } : enter;
        show(`Give "${name}" ${changes}? ITS MACHINE IS STOPPED CLEANLY, SET, AND STARTED AGAIN: what the tool is doing now is interrupted. Its work folder, its folders and its branches stay.`,
            'Change it', async () => {
                disconnect(); say('restarting', 'connecting'); show('Changing its machine...'); $('notice-spin').hidden = false;
                try { await post(`${API}/conversations/${encodeURIComponent(name)}/machine`, { memoryMb, diskGb, cpus }); await refresh(); enter(); }
                catch (error) { show(error.message, 'Back', enter); }
            }, resume);
    });

    /* ---------- what its tool is told about where it is (server/guide.mjs) ---------- */
    /* One quiet line; behind "see", the exact text its tool reads, made by
       the server from these settings, the owner's own lines, and "Tell it
       again", which types one line in its terminal -- only when clicked. */
    let guideOf = '';
    function guideOpen(open) {
        $('guide-shown').hidden = !open;
        $('guide-see').setAttribute('aria-expanded', String(open));
        $('guide-see').textContent = open ? 'hide' : 'see';
    }
    async function paintGuide(here) {
        $('guide-box').hidden = DEVICE || !here;
        if (DEVICE || !here) return;
        if (guideOf !== here.name) { guideOf = here.name; guideOpen(false); $('guide-said').textContent = ''; delete $('guide-lines').dataset.edited; }
        if (!$('guide-shown').hidden) await readGuide();
    }
    async function readGuide() {
        const name = current;
        let g;
        try { const r = await fetch(`${API}/conversations/${encodeURIComponent(name)}/guide`); g = r.ok ? await r.json() : null; } catch { g = null; }
        if (name !== current) return;
        if (!g) { $('guide-said').textContent = 'It could not be read just now.'; return; }
        paintGuideText(g);
    }
    function paintGuideText(g) {
        $('guide-where').textContent = g.pointer
            ? `Two files in its machine, read-only: ${g.paths.common}, the same for every machine, and ${g.paths.own}, for this conversation only. One line in ${g.pointer.file} tells its tool to read them.`
            : `Two files in its machine, read-only: ${g.paths.common}, the same for every machine, and ${g.paths.own}, for this conversation only.`;
        $('guide-text').textContent = `${g.common}\n${g.own}`;
        const field = $('guide-lines');
        if (document.activeElement !== field && !field.dataset.edited) field.value = g.lines.join('\n');
        const c = conversations.find((x) => x.name === current);
        const awake = c?.phase === 'ready' && !c?.asleep;
        $('guide-tell').disabled = !awake;
        $('guide-tell').title = awake ? `Types in its terminal: ${g.tellAgain}` : 'It is asleep: open it first.';
    }
    $('guide-see').addEventListener('click', () => {
        const open = $('guide-shown').hidden;
        guideOpen(open);
        if (open) void readGuide();
    });
    $('guide-lines').addEventListener('input', () => { $('guide-lines').dataset.edited = '1'; $('guide-said').textContent = ''; });
    $('guide-save').addEventListener('click', async () => {
        const name = current;
        $('guide-save').disabled = true;
        try {
            const g = await post(`${API}/conversations/${encodeURIComponent(name)}/guide`, { lines: $('guide-lines').value });
            if (name !== current) return;
            delete $('guide-lines').dataset.edited;
            $('guide-lines').value = g.lines.join('\n');
            paintGuideText(g);
            $('guide-said').textContent = 'Saved. A machine that runs has it now, one asleep at its next start; "Tell it again" asks its tool to read it.';
        } catch (error) { $('guide-said').textContent = error.message; }
        finally { $('guide-save').disabled = false; }
    });
    $('guide-tell').addEventListener('click', async () => {
        const name = current;
        $('guide-tell').disabled = true;
        try {
            const g = await post(`${API}/conversations/${encodeURIComponent(name)}/guide/tell`, {});
            if (name !== current) return;
            paintGuideText(g);
            $('guide-said').textContent = `Typed in its terminal: ${g.told}`;
        } catch (error) { $('guide-said').textContent = error.message; }
        finally { const c = conversations.find((x) => x.name === current); $('guide-tell').disabled = !(c?.phase === 'ready' && !c?.asleep); }
    });

    /* ---------- the simple screen: the same conversation, without its terminal ---------- */
    /* For whoever does not read a terminal. The terminal stays where it is,
       underneath, attached as always: what is written in the box is typed
       into it, and what it shows is read here BY THIS PAGE, from its own
       screen, as plain text. The server reads nothing more than before. */
    /* `simplePref`: this device's choice for a conversation without a chat;
       one that talks through the app opens on its chat, whatever it is. */
    let simplePref = false;
    /* (A device's page has no plain screen: only the terminal, or a chat.) */
    try { const kept = localStorage.getItem('clavarium-simple'); if (kept !== null) simplePref = kept === '1' && !DEVICE; } catch { /* a private window */ }
    let simple = simplePref;
    const saysNow = () => {
        const b = terminal.buffer.active; const lines = [];
        for (let i = Math.max(0, b.length - 200); i < b.length; i++) { const l = b.getLine(i)?.translateToString(true) ?? ''; if (l.trim()) lines.push(l); }
        return lines.slice(-16).join('\n');
    };
    let simpleFilesAt = 0;
    async function paintSimpleFiles() {
        simpleFilesAt = Date.now();
        const box = $('simple-files');
        const c = conversations.find((x) => x.name === current);
        let entries = [];
        if (c?.work === 'kept' || DEVICE) {
            const listing = await fetch(`${API}/files?${new URLSearchParams({ c: current, r: 'work', p: '' })}`).then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] }));
            entries = (listing.entries ?? []).filter((e) => !e.folder).sort((a, b) => String(b.modified).localeCompare(String(a.modified))).slice(0, 8);
        }
        if (!simple) return;
        box.replaceChildren(...entries.map((e) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'file';
            const name = document.createElement('span'); name.textContent = e.name;
            const when = document.createElement('span'); when.className = 'hint'; when.textContent = new Date(e.modified).toLocaleString();
            b.append(name, when);
            b.addEventListener('click', () => { void preview('work', e.name, e.name, e.size); });
            return b;
        }));
        $('simple-files-empty').hidden = entries.length > 0;
    }
    function paintSimple() {
        $('simple').hidden = !simple;
        $('health-terminal').hidden = !simple || noTerminal();
        $('room').toggleAttribute('data-simple', simple);
        if (!simple) $('room').removeAttribute('data-chat');
        $('simple-toggle').setAttribute('aria-pressed', String(simple));
        /* Where the tool talks through the app, the plain screen is its chat. */
        const chatting = talk.on && talkOf === current;
        $('simple-toggle').hidden = DEVICE && (!chatting || noTerminal());
        $('simple-toggle').textContent = simple ? (chatting ? 'Terminal' : 'Its screen') : chatting ? 'Chat' : 'Simple';
        paintViews();
        if (!simple) return;
        const c = conversations.find((x) => x.name === current);
        const state = $('state').textContent;
        $('simple-state').textContent = c?.answerer?.needs ? `It stopped and waits for you. ${c.answerer.needs.why}`
            : c?.asleep ? 'It is asleep.'
                : state === 'live' ? 'It is there. Below: what is ready, and what it says now.' : `Its screen: ${state}.`;
        $('simple-state').dataset.needs = String(Boolean(c?.answerer?.needs));
        $('simple-says').textContent = saysNow() || 'Nothing on its screen yet.';
        if (Date.now() - simpleFilesAt > 8000) void paintSimpleFiles();
    }
    $('simple-toggle').addEventListener('click', () => toggleSimple());
    function toggleSimple() {
        simple = !simple;
        /* Its terminal, one click from a chat, for now: the next opening is on the chat again. */
        if (!(talk.on && talkOf === current)) { simplePref = simple; try { localStorage.setItem('clavarium-simple', simple ? '1' : '0'); } catch { /* as above */ } }
        simpleFilesAt = 0; paintSimple();
        if (simple) void readTalk().then(paintThread);
        if (!simple) focusTerminal();
    }
    /* ---------- talk: a conversation with the tool, shown by Parley ---------- */
    /* The exchange is drawn by Parley's own library (a project of its own,
       served from /vendor): this page tells it where to load from, how to
       send, the words of this device's language, and how a file is opened. */
    let talk = { on: false, messages: [] };
    let talkOf = '';
    let chatView = 'simple';
    try { chatView = localStorage.getItem('clavarium-chat-view') === 'detailed' ? 'detailed' : 'simple'; } catch { /* a private window */ }
    /* "Send when I stop", for dictation in the chat: kept by this device. */
    let chatAuto = false;
    try { chatAuto = localStorage.getItem('clavarium-chat-auto') === '1'; } catch { /* as above */ }
    /* The silence before it sends by itself, chosen on this device (Parley's menu, under the switch). */
    let chatAutoMs;
    try { chatAutoMs = Number(localStorage.getItem('clavarium-chat-auto-ms')) || undefined; } catch { /* as above */ }
    const keepAutoMs = (ms) => { chatAutoMs = ms; try { localStorage.setItem('clavarium-chat-auto-ms', String(ms)); } catch { /* as above */ } };
    const deviceLang = () => (navigator.language || 'en');
    let chatWords = null;
    async function readWords() {
        if (!chatWords) chatWords = await fetch(`${API}/talk/words?${new URLSearchParams({ lang: deviceLang() })}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
        return chatWords;
    }
    /* The same on this server's own page and on a device's (which speaks for its own conversation). */
    const talkPath = (name, tail = '', params = {}) => {
        const q = new URLSearchParams({ ...(DEVICE ? { c: name } : {}), ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) });
        return `${API}/conversations/${encodeURIComponent(name)}/talk${tail}${String(q) ? `?${q}` : ''}`;
    };
    /* WHAT THE CHAT SHOWS AT FIRST, chosen on each device (Settings, Chat screen): the newest
       messages, or those of the last days; the rest on demand ("Earlier messages"). */
    const CHAT_WINDOWS = [['messages:100', 'Last 100 messages'], ['messages:200', 'Last 200 messages'], ['messages:500', 'Last 500 messages'], ['days:1', 'Last day'], ['days:3', 'Last 3 days'], ['days:7', 'Last 7 days']];
    let chatWindow = 'messages:200';
    try { const kept = localStorage.getItem('clavarium-chat-window'); if (CHAT_WINDOWS.some(([v]) => v === kept)) chatWindow = kept; } catch { /* a private window */ }
    const windowFor = (choice) => { const [kind, n] = choice.split(':'); return kind === 'days' ? { days: Number(n) } : { messages: Number(n) }; };
    async function readTalk() {
        /* A device not given the chat does not ask for it: the server would refuse. */
        if (!current || (DEVICE && deviceParts.chat === null)) { talk = { on: false, messages: [] }; talkOf = current; return talk; }
        /* Whether it is on, nothing of the thread: asked every few seconds. */
        /* No answer (the network cut for a moment, the server restarting): what was known is kept. Taken
           for "off", the chat would be taken down and drawn again -- its box with it, and a tablet's keyboard. */
        const known = talkOf === current ? talk : null;
        const off = { on: false, messages: [] };
        talk = await fetch(talkPath(current, '', { state: 1 })).then((r) => (r.ok ? r.json() : r.status >= 500 ? known ?? off : off)).catch(() => known ?? off);
        talkOf = current;
        return talk;
    }
    async function paintThread() {
        const box = $('simple-thread');
        const wanted = talk.on && talkOf === current;
        box.hidden = !wanted;
        /* Where the tool talks through the app, the chat is the whole screen: one box to write in. */
        /* Its chat off, on this server's own page: said, with the button that turns it on (a device's page keeps the plain screen). */
        const offer = !DEVICE && !wanted && !noTerminal();
        $('simple-plain').hidden = wanted || offer;
        $('chat-turn').hidden = !offer;
        if (offer) {
            const possible = !(talkOf === current && talk.possible === false);
            $('chat-turn-on').hidden = !possible;
            $('chat-turn-why').textContent = possible ? 'Turned on, its tool talks with you here, as in a messaging app. Its terminal stays one click away.' : 'This conversation works on the disk of its machine: its chat needs its work folder kept here.';
        }
        $('simple').toggleAttribute('data-chat', wanted);
        /* The ready-made answers type into the terminal: not under a chat. */
        $('room').toggleAttribute('data-chat', (wanted || offer) && simple);
        /* Its chat alone was given, and the owner has not turned it on: said, not left blank. */
        $('chat-off').hidden = !(noTerminal() && !wanted);
        if (noTerminal()) { $('room').setAttribute('data-chat', ''); keysForChat(); say(wanted ? 'chat' : 'chat off', wanted ? 'live' : 'waiting'); }
        /* The bar's dictation types into the terminal: not while the chat is in front, which has its own. */
        if ((wanted || offer) && simple && stopListening) stopVoice();
        paintSimple();
        if (!wanted) { thread?.destroy(); thread = null; threadOf = ''; return; }
        if (thread && threadOf === current) { void thread.refresh(); return; }
        thread?.destroy();
        /* From where this page is: a device's page lives under /c/, and nothing else is open to it. */
        const [{ mount }, words] = await Promise.all([import(new URL('vendor/parley-ui.js', new URL(DEVICE ? '/c/' : '/', location.href)).href), readWords()]);
        const name = current;
        if (name !== current || (thread && threadOf === current)) return;
        threadOf = name;
        /* The short-lived secrets live in this conversation now (secret-scan.mjs): the chat shows each as
           stars with its time left and a way to forget it. Kept current on each reload, read on each repaint. */
        const chatSecrets = {};
        const refreshSecrets = () => { for (const k of Object.keys(chatSecrets)) delete chatSecrets[k]; for (const s of conversations.find((x) => x.name === name)?.ephemeralSecrets ?? []) chatSecrets[s.name] = { expiresInMs: s.expiresInMs }; };
        refreshSecrets();
        /* The lines of its machine seen so far: what changed comes alone, and their buttons are worked out on all of them. */
        const lines = new Map();
        const withLines = (data, asked) => {
            if (!Array.isArray(data?.messages)) return data;
            if (data.since !== true && !asked?.before) lines.clear();
            for (const m of data.messages) if (m.from === 'system') lines.set(m.id, m);
            return data.since === true ? { ...data, messages: [...data.messages.filter((m) => m.from !== 'system'), ...lines.values()] } : data;
        };
        thread = mount(box, {
            words, view: chatView,
            onView: (v) => { chatView = v; try { localStorage.setItem('clavarium-chat-view', v); } catch { /* as above */ } },
            /* A part of the thread: its end at first, then what changed, the page before on demand (Parley's window). */
            window: windowFor(chatWindow),
            load: (asked = {}) => fetch(talkPath(name, '', asked)).then((r) => r.json()).then((data) => withLines(data, asked)).then(machineLines).then((data) => withMachine(data, name)).then((data) => (refreshSecrets(), data)),
            /* The whole thread searched, however little of it is shown. */
            search: (q) => fetch(talkPath(name, '/search', { q })).then((r) => (r.ok ? r.json() : { matches: [], count: 0 })),
            /* `via: 'voice'`: part of it was dictated, said to the tool. */
            send: (text, answers, files, extra) => post(talkPath(name), { text, answers, ...(files ? { files: files.map((f) => (f.note ? { path: f.path, note: f.note } : f.path)) } : {}), ...(extra?.via === 'voice' ? { via: 'voice' } : {}),
                /* The choices ticked, the answers of a group, the zone of a picture the answer is about. */
                ...(extra?.picked ? { picked: extra.picked } : {}), ...(extra?.replies ? { replies: extra.replies } : {}), ...(extra?.about ? { about: extra.about } : {}) }),
            /* Formulas: Parley's own KaTeX, served here. Zones and people may point to a file of a shared folder (file:/work/...). */
            math: { url: new URL('vendor/katex/katex.mjs', new URL(DEVICE ? '/c/' : '/', location.href)).href },
            refs: {
                label: (ref) => (/^file:\/(work|resources)\//.test(ref) ? 'Open' : null),
                open: (ref) => { const m = /^file:\/(work|resources\/[^/]+)\/(.+)$/.exec(ref); if (!m) return; const tab = m[1] === 'work' ? 'work' : m[1].slice('resources/'.length); void openFromChat(tab, m[2]); },
            },
            /* A reaction to one of its messages: wherever the chat may be written in. */
            ...(!DEVICE || deviceParts.chat === 'write' ? { react: (to, reaction) => post(talkPath(name, '/react'), { to, reaction }) } : {}),
            /* A message attached to a card (#180), from its menu: its id, as the card opens it again. */
            ...(!DEVICE ? { card: (m) => attachToCard({ kind: 'message', ref: m.id, title: String(m.short || m.text || '').replace(/\s+/g, ' ').trim().slice(0, 80) }) } : {}),
            /* The buttons of a line of the machine: what this screen may do. */
            act: (id) => { if (id === 'seen-done') return; if (id.startsWith('salon:')) { void openSalon(id.slice('salon:'.length)); return; } if (id === 'seen') void markSeen(); else if (id === 'memory') void openMemory(); else if (id === 'disk') void openDisk(); else if (id === 'room') seeTerminal(); else if (id === 'restart') void restartMachine(false); else if (id === 'terminal') seeTerminal(); else if (/^(allow|deny|always):/.test(id)) void decideTether(id.slice(id.indexOf(':') + 1), DECISION[id.slice(0, id.indexOf(':'))], () => thread?.refresh?.()); else if (id.startsWith('flash:')) void flashFromThread(id.slice('flash:'.length)); else if (id.startsWith('review:')) void openGit(id.slice('review:'.length)); else openCommits(id); },
            /* What it opens over the thread (a picture, its media, a search...) is a step of this page's: one Back closes it. */
            back: { open: (name, close) => nav.over(`chat-${name}`, () => close(), { stack: true }), closed: (step) => { if (step) nav.drop(step); } },
            /* Files attached to a message: wherever the chat may be written in. */
            ...(!DEVICE || deviceParts.chat === 'write' ? { attach: { upload: (file) => attachToChat(name, file) } } : {}),
            /* Its terminal, when this device was given it. */
            /* A file the tool showed opens in the window when it is in its work folder or an attached folder ("work:report.html"). */
            open: (file) => { if (!file.open) return; const at = file.open.indexOf(':'); const tab = file.open.slice(0, at); const inner = file.open.slice(at + 1); void openFromChat(tab, inner); },
            ...(noTerminal() ? {} : { terminal: () => seeTerminal() }),
            /* What the tool writes is rendered (Parley builds it element by element), and named by its tool. */
            /* Named as its owner chose, else by the neutral word of the dictionary; its tool, small, in the detailed view. */
            /* What is being written is kept per conversation: another one looked at, it is there again. */
            draft: name,
            markdown: true, agentName: conversations.find((x) => x.name === name)?.chatName ?? '', agentTool: conversations.find((x) => x.name === name)?.toolLabel ?? '',
            /* Its pictures, from the shared folders only, by the same route as the thumbnails of Files (type proved by the bytes, never SVG). */
            picture: (file) => { if (!file.open) return null; const at = file.open.indexOf(':'); return `${API}/files/thumb?${new URLSearchParams({ c: name, r: file.open.slice(0, at), p: file.open.slice(at + 1) })}`; },
            diagram: drawDiagram, highlight: colourCode,
            /* Short-lived secrets of this conversation: the stars say their time left and offer to forget them. */
            secrets: chatSecrets,
            forget: (secretName) => post(`${API}/conversations/${encodeURIComponent(name)}/secrets/${encodeURIComponent(secretName)}/forget`, {}).then(() => { delete chatSecrets[secretName]; if (thread && threadOf === name) void thread.refresh(); }).catch(() => {}),
            remind: () => post(talkPath(name, '/remind'), {}),
            /* The helpers of the terminal, in the chat: this page's voice, the owner's ready answers, the keyboard rule of this device. */
            voice: chatVoice(), autoSend: chatAuto, autoSendMs: chatAutoMs, onAutoSendMs: keepAutoMs,
            onAutoSend: (on) => { chatAuto = on; try { localStorage.setItem('clavarium-chat-auto', on ? '1' : '0'); } catch { /* as above */ } },
            touch: touchScreen,
        });
        const replies = await loadReplies();
        if (thread && threadOf === name) thread.replies = replies;
        if (!DEVICE) { tasksChanges = -1; void paintTasks(name); watchTasks(); }
    }
    /* ITS BATCHES, BESIDE ITS CHAT: Parley's panel, fed from the binder of batches given to
       this conversation (Binder's "batches" template). Its tool keeps them there (binder); the
       owner ticks those it may start (Binder's approval), and a click opens the card in its Binders
       tab. No such binder: no panel, no button. Folded or not: kept per conversation. */
    const TASKS_TEMPLATE = 'batches';
    const TASKS_TONE = { doing: 'active', yours: 'attention' };
    let tasksTimer = null; let tasksChanges = -1;
    const tasksFolded = (name) => { try { const v = JSON.parse(localStorage.getItem('clavarium-tasks-folded') ?? '{}')[name]; return typeof v === 'boolean' ? v : null; } catch { return null; } };
    const keepTasksFolded = (name, on) => { try { const all = JSON.parse(localStorage.getItem('clavarium-tasks-folded') ?? '{}'); all[name] = on; localStorage.setItem('clavarium-tasks-folded', JSON.stringify(all)); } catch { /* a private window */ } };
    /* Its binder beside the chat: the one chosen for it (its settings, the same on every
       device), else the first binder of batches it was given; '-' chosen: none. A chosen binder
       it no longer has, or archived, gives way to the automatic choice. */
    async function batchesOf(name) {
        const chosen = conversations.find((x) => x.name === name)?.tasksBinder ?? '';
        if (chosen === '-') return null;
        const lists = await binderCall('lists', {});
        if (!lists.ok || !Array.isArray(lists.data)) return undefined;
        const given = lists.data.filter((l) => !l.archived && l.grants?.[`conversation:${name}`]);
        return (chosen && given.find((l) => l.id === chosen)) || given.find((l) => l.template === TASKS_TEMPLATE) || null;
    }
    /* A card's description, as the panel shows it: plain words, no Markdown signs. */
    const plainText = (md) => String(md ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
    async function paintTasks(name) {
        if (DEVICE || !thread || threadOf !== name) return;
        const list = await batchesOf(name);
        if (list === undefined || !thread || threadOf !== name) return;
        if (!list) { thread.side = null; return; }
        const shown = await binderCall('show', { list: list.id });
        if (!shown.ok || !thread || threadOf !== name) return;
        const states = new Map(shown.data.list.states.map((st) => [st.id, st]));
        const nameOf = (id) => binderPeople.find((p) => p.id === id)?.name ?? id.replace(/^[a-z]+:/, '');
        const items = shown.data.records.map((r) => ({
            id: r.id, title: r.title, text: plainText(r.description), state: states.get(r.state)?.name ?? '', done: Boolean(states.get(r.state)?.done), checked: r.approved === true,
            /* Its own conversation owning it goes without saying. */
            owner: r.owners.filter((o) => o !== `conversation:${name}`).map(nameOf).join(', '), tone: TASKS_TONE[r.state] ?? '' }));
        thread.side = { onFold: (on) => keepTasksFolded(name, on), title: list.title, items, folded: tasksFolded(name) ?? false,
            /* What waits for the owner's tick: counted on the bar's button, as on the Binders tab. */
            count: items.filter((x) => !x.done && !x.checked).length,
            tick: async (id, yes) => { const r = await binderCall('approve', { id, yes }); if (!r.ok) throw new Error(r.text); void paintTasks(name); },
            open: (id) => void openTaskCard(name, id) };
    }
    /* A card opened in its Binders tab, once that tab drew its binder. */
    async function openTaskCard(name, id) {
        if (current !== name) return;
        goTab('lists');
        for (let i = 0; i < 50 && !(listsView && listsOf === name); i++) await new Promise((r) => setTimeout(r, 100));
        if (listsView && listsOf === name) await listsView.open?.(id, { from: TAB_WORD.chat });
    }
    /* Read again when the binders changed (a number that moves with each change), and only then. */
    function watchTasks() {
        if (tasksTimer) return;
        tasksTimer = setInterval(async () => {
            if (!thread) { clearInterval(tasksTimer); tasksTimer = null; return; }
            if (document.hidden) return;
            const now = await getJson('/binder/people', null);
            if (!now || now.changes === tasksChanges) return;
            tasksChanges = now.changes; binderPeople = now.people;
            void paintTasks(threadOf);
        }, 4000);
    }
    /* DRAWINGS AND CODE IN THE CHAT, by libraries served here at fixed
       versions (package.json), loaded only when one is shown. A drawing is
       made by Mermaid in its strict mode (no script, no click, no HTML in its
       labels) and handed to the chat as SVG text, which shows it as a picture:
       a picture runs nothing and loads nothing. Code is coloured from Prism's
       token tree, never from its HTML. */
    const loaded = new Map();
    const script = (path) => {
        if (!loaded.has(path)) loaded.set(path, new Promise((done, fail) => { const s2 = document.createElement('script'); s2.src = new URL(path, new URL(DEVICE ? '/c/' : '/', location.href)).href; s2.onload = done; s2.onerror = () => { loaded.delete(path); fail(new Error('not loaded')); }; document.head.append(s2); }));
        return loaded.get(path);
    };
    let drawn = 0;
    let drawing = Promise.resolve();
    function drawDiagram(code) {
        /* One at a time: Mermaid draws in the page, and its settings are global. */
        const run = drawing.then(async () => {
            await script('vendor/mermaid.js');
            /* Drawn on a light ground in both themes: the chat shows it as a picture on white. */
            window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'system-ui, sans-serif', suppressErrorRendering: true });
            const { svg } = await window.mermaid.render(`clv-diagram-${drawn += 1}`, String(code));
            return svg;
        });
        drawing = run.catch(() => {});
        return run;
    }
    const LANGS = { js: 'javascript', javascript: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', typescript: 'typescript', tsx: 'typescript', json: 'json', python: 'python', py: 'python', bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
        php: 'php', sql: 'sql', html: 'markup', xml: 'markup', svg: 'markup', markup: 'markup', css: 'css', yaml: 'yaml', yml: 'yaml', diff: 'diff', patch: 'diff', markdown: 'markdown', md: 'markdown', ini: 'ini', conf: 'apacheconf', apache: 'apacheconf', apacheconf: 'apacheconf', htaccess: 'apacheconf' };
    async function colourCode(code, lang) {
        const known = LANGS[String(lang).toLowerCase()];
        if (!known) return null;
        await script('vendor/prism.js');
        const grammar = window.Prism?.languages?.[known];
        if (!grammar) return null;
        /* Plain data, as Parley takes it: strings, and {type, alias, content}. */
        const plain = (list) => list.map((t) => (typeof t === 'string' ? t : { type: t.type, alias: t.alias, content: Array.isArray(t.content) ? plain(t.content) : typeof t.content === 'string' ? t.content : plain([t.content]) }));
        return plain(window.Prism.tokenize(String(code), grammar));
    }
    /* THE LINES OF ITS MACHINE in the chat: their buttons, as this screen may
       use them -- its memory and a restart are the owner's; its terminal, a
       screen's that was given it. */
    /* "review:<repository>": the git review of a repository the line is about (the owner's). */
    /* "commits:<repository>.<to>.<from>.<n>": those commits, in the review ("See the 3 commits"). A commit a
       line names (7 to 40 hexadecimal characters, a digit among them) is a link to its review, on a line about
       a repository; the agent's own messages are never read for this. */
    const ACTIONS = { memory: 'More memory...', disk: 'Give it more disk...', room: 'See what takes room', restart: 'Restart...', terminal: 'See the terminal', review: 'Open the review', seen: '\u2713 Seen', allow: 'Accept', deny: 'Refuse', flash: 'Plug it in and start' };
    const COMMITS = /^commits:([a-z0-9][a-z0-9-]*)\.([0-9a-f]{7,40})\.([0-9a-f]{7,40})\.(\d{1,4})$/;
    /* A Tether call an agent asked the owner to allow, offered right in the thread: allow:<id> / deny:<id>. */
    const DEMANDE = /^(allow|deny|always|flash):[0-9a-f-]{36}$/;
    const DECISION = { allow: 'yes', deny: 'no', always: 'always' };
    const COMMIT = /^commit:([a-z0-9][a-z0-9-]*)\.([0-9a-f]{7,40})$/;
    function openCommits(id) {
        if (DEVICE) return;
        const many = COMMITS.exec(id); const one = COMMIT.exec(id);
        if (many) void openGit(many[1], { commit: many[2], base: many[3], tab: Number(many[4]) > 1 ? 'commits' : 'changes' });
        else if (one) void openGit(one[1], { commit: one[2] });
    }
    function machineLines(data) {
        if (!Array.isArray(data?.messages)) return data;
        const kindOf = (id) => String(id).split(':')[0];
        const may = (id) => (id === 'terminal' || id === 'room' ? !noTerminal() : id === 'disk' ? !DEVICE && !narrow() : (id === 'memory' || id === 'restart' || id === 'seen' || id === 'seen-done' || DEMANDE.test(id) || /^review:[a-z0-9][a-z0-9._-]*$/.test(id) || COMMITS.test(id)) && !DEVICE);
        const label = (id) => { const n = Number(COMMITS.exec(id)?.[4] ?? 0); return n ? (n === 1 ? 'See the commit' : `See the ${n} commits`) : ACTIONS[kindOf(id)]; };
        const linksOf = (m) => {
            const repo = DEVICE ? null : (m.actions ?? []).map((id) => /^review:([a-z0-9][a-z0-9-]*)$/.exec(id)?.[1]).find(Boolean);
            if (!repo) return [];
            return [...new Set(String(m.text ?? '').match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter((x) => /\d/.test(x)).slice(0, 8).map((x) => ({ text: x, id: `commit:${repo}.${x}` }));
        };
        /* ONE "Seen" for its machine: marked on the strip or here, every line it covers says so, and offers it no more. */
        const seenAt = conversations.find((x) => x.name === current)?.health?.seenAt ?? '';
        const seenWords = seenAt ? `\u2713 Seen ${new Date(seenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        /* Restart, offered by a line, is offered no more once its machine was restarted after it. */
        const restartedAt = data.messages.filter((m) => m.from === 'system' && m.event === 'restarted').map((m) => String(m.at ?? '')).sort().pop() ?? '';
        /* A problem of its machine that went away since (machine-ok): nothing left to see or to do on its line. */
        const fixedAt = data.messages.filter((m) => m.from === 'system' && m.event === 'machine-ok').map((m) => String(m.at ?? '')).sort().pop() ?? '';
        const FIXED_GOES = new Set(['seen', 'room', 'disk', 'memory']);
        /* A Tether demande decided (here, from Assets, or by the agent) is marked done in the thread,
           carrying its id: Accept / Refuse are then offered no more on the line that asked. */
        const settled = new Map(data.messages.filter((m) => m.from === 'system' && m.event === 'tether-done' && m.brief).map((m) => [String(m.brief), m]));
        /* Its card (Parley's request, demandes.mjs): decided, it folds to one line -- accepted, refused, or no longer
           waiting (timed out, taken back by the agent, stopped); where this screen may not decide, no buttons. */
        const requestOf = (m) => {
            const r = m.request;
            const id = /^allow:(.+)$/.exec(String(r.yes?.id ?? ''))?.[1] ?? '';
            const done = id ? settled.get(id) : null;
            if (done) { const o = String(done.outcome ?? ''); return { ...r, state: { decision: o === 'yes' || o === 'always' ? 'yes' : o === 'no' ? 'no' : 'ended', at: String(done.at ?? '') } }; }
            if (!may(String(r.yes?.id ?? ''))) { const { yes: _y, no: _n, others: _o, ...shown } = r; return shown; }
            return r;
        };
        const actionsOf = (m) => (m.actions ?? []).filter(may).filter((id) => !(id === 'restart' && restartedAt && String(m.at ?? '') < restartedAt)).filter((id) => !(FIXED_GOES.has(id) && fixedAt && String(m.at ?? '') < fixedAt)).filter((id) => !(DEMANDE.test(id) && settled.has(id.slice(id.indexOf(':') + 1))))
            .map((id) => (id === 'seen' && seenAt && String(m.at ?? '') <= seenAt ? { id: 'seen-done', label: seenWords } : { id, label: label(id) }));
        return { ...data, messages: data.messages.map((m) => (m.from === 'system' ? { ...m, actions: actionsOf(m), links: linksOf(m), ...(m.request && typeof m.request === 'object' ? { request: requestOf(m) } : {}) } : m)) };
    }
    /* ITS MACHINE, on the side of the detailed chat: as this page last knew it. */
    function withMachine(data, name) {
        const c = conversations.find((x) => x.name === name);
        if (!c || !data || typeof data !== 'object') return data;
        const h = c.health ?? null;
        const state = c.asleep === true ? ['Asleep', ''] : h?.state === 'Running' ? (h.answering === false ? ['Not answering', 'bad'] : ['Running', 'ok']) : h?.state ? [h.state, 'warn'] : c.phase ? [String(c.phase), ''] : null;
        const about = [...(state ? [{ label: 'State', text: state[0], tone: state[1] }] : []),
            ...(c.memoryMb ? [{ label: 'Memory', text: sizeWords(c.memoryMb) }] : []), ...(c.diskGb ? [{ label: 'Disk', text: `${c.diskGb} GB` }] : []),
            ...(h?.problems ?? []).filter((x) => x && (x.level === 'warn' || x.level === 'bad')).slice(0, 3).map((x) => ({ label: 'Problem', text: String(x.text ?? ''), tone: x.level }))];
        return { ...data, about };
    }
    /* A file the person attaches: sent first, put where the tool finds it; the message then carries its path. */
    async function attachToChat(name, file) {
        const r = await fetch(`${API}/conversations/${encodeURIComponent(name)}/talk/file?${new URLSearchParams({ name: file.name, ...(DEVICE ? { c: name } : {}) })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The file could not be sent.');
        return j;
    }
    /* Opening a conversation that talks through the app shows its chat first;
       its terminal is one click away. Any other opens as this device chose. */
    let opening = 0;
    async function chatFirst() {
        if (!current) return;
        const name = current;
        const mine = ++opening;
        await readTalk();
        if (mine !== opening || name !== current) return;
        const want = talk.on || noTerminal() ? true : simplePref;
        if (want !== simple) { simple = want; simpleFilesAt = 0; }
        if (!simple) { paintSimple(); return; }
        await paintThread();
        if (talk.on && name === current) focusTerminalUnasked();
    }
    function languageName(tag) { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag.split('-')[0]) ?? tag; } catch { return tag; } }
    async function paintTalkBox() {
        if (DEVICE) { $('talk-box').hidden = true; $('voice-mark-box').hidden = true; return; }
        const here = conversations.find((x) => x.name === current);
        if (document.activeElement !== $('chat-name')) $('chat-name').value = here?.chatName ?? '';
        void paintTasksBinder(here);
        if (document.activeElement !== $('title-name')) $('title-name').value = shownName(here);
        $('title-box').hidden = $('hide-box').hidden = $('group-box').hidden = DEVICE || !here;
        if (document.activeElement !== $('group-name')) $('group-name').value = here?.group ?? '';
        $('group-rename-form').hidden = !here?.group;
        if (document.activeElement !== $('group-rename')) $('group-rename').value = here?.group ?? '';
        $('group-up').hidden = $('group-down').hidden = !here?.group;
        for (const b of $('hide-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === (here?.hidden === true)));
        $('voice-mark-box').hidden = !here?.ai;
        for (const b of $('voice-mark').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === (here?.voiceMark === true)));
        await readTalk();
        for (const b of $('talk-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === talk.on));
        $('talk-invite').hidden = !talk.on;
        $('talk-declare').hidden = !talk.on;
        if (talk.on) $('talk-declare').textContent = talk.tools
            ? `Then "Ask the tool to use it": it is told to talk to you here, in ${languageName(deviceLang())}.`
            : 'The tools folder (/tools) is not in place yet: the tool cannot be asked.';
        if (!talk.on && talk.possible === false) { $('talk-about').textContent = 'Needs its work folder kept here (it works on its machine\'s disk)'; $('talk-about').hidden = false; }
    }
    for (const b of $('talk-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/talk`, { on: b.dataset.on === 'true' }); await paintTalkBox(); void paintThread(); void paintGuide(conversations.find((x) => x.name === current)); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    const panelTry = async (job) => {
        $('panel-error').hidden = true;
        try { await job(); await refresh(); await paintTalkBox(); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    };
    $('group-form').addEventListener('submit', (event) => {
        event.preventDefault();
        void panelTry(async () => { await post(`${API}/conversations/${encodeURIComponent(current)}/group`, { group: $('group-name').value.trim() }); $('group-name').blur(); });
    });
    $('group-rename-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const from = conversations.find((x) => x.name === current)?.group;
        void panelTry(async () => {
            const to = $('group-rename').value.trim();
            await post(`${API}/groups/rename`, { from, to }); $('group-rename').blur();
            if (folded.delete(from)) { folded.add(to); keepFolded(); }
        });
    });
    for (const [id, to] of [['move-up', 'up'], ['move-down', 'down']]) $(id).addEventListener('click', () => void panelTry(() => post(`${API}/conversations/${encodeURIComponent(current)}/move`, { to })));
    for (const [id, to] of [['group-up', 'up'], ['group-down', 'down']]) $(id).addEventListener('click', () => void panelTry(() => post(`${API}/groups/move`, { group: conversations.find((x) => x.name === current)?.group, to })));
    $('title-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/title`, { title: $('title-name').value.trim() }); $('title-name').blur(); await refresh(); enter(true); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    for (const b of $('hide-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/hidden`, { on: b.dataset.on === 'true' }); await refresh(); for (const x of $('hide-on').children) x.setAttribute('aria-pressed', String(x === b)); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    /* WHICH BINDER BESIDE ITS CHAT (#48): automatic, one of the binders it was given, or none.
       Shown only once it was given a binder. */
    async function paintTasksBinder(here) {
        const row = $('tasks-binder-row'); const pick = $('tasks-binder');
        if (DEVICE || !here) { row.hidden = true; return; }
        const lists = await binderCall('lists', {});
        const given = lists.ok && Array.isArray(lists.data) ? lists.data.filter((l) => !l.archived && l.grants?.[`conversation:${here.name}`]) : [];
        row.hidden = given.length === 0;
        if (row.hidden || document.activeElement === pick) return;
        const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
        pick.replaceChildren(option('', 'Automatic'), ...given.map((l) => option(l.id, l.title)), option('-', 'None'));
        const chosen = here.tasksBinder ?? '';
        pick.value = chosen === '-' || given.some((l) => l.id === chosen) ? chosen : '';
    }
    $('tasks-binder').addEventListener('change', async () => {
        $('panel-error').hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/tasks-binder`, { binder: $('tasks-binder').value }); await refresh(); void paintTasks(current); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    $('chat-name-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/chat-name`, { name: $('chat-name').value }); await refresh(); thread?.destroy(); thread = null; threadOf = ''; void paintThread(); $('chat-name').blur(); await paintTalkBox(); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    for (const b of $('voice-mark').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/voice-mark`, { on: b.dataset.on === 'true' }); await refresh(); await paintTalkBox(); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    /* From the Chat tab: on, then its tool is asked to use it -- the same two steps as in its settings. */
    $('chat-turn-on').addEventListener('click', async () => {
        const name = current; const button = $('chat-turn-on');
        if (button.dataset.open) { delete button.dataset.open; button.textContent = 'Turn the chat on'; $('chat-turn-said').textContent = ''; await readTalk(); await paintThread(); return; }
        button.disabled = true; $('chat-turn-said').textContent = '';
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/talk`, { on: true }); }
        catch (error) { $('chat-turn-said').textContent = error.message; button.disabled = false; return; }
        let asked = '';
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/talk/invite`, { lang: deviceLang() }); }
        catch (error) { asked = error.message; }
        button.disabled = false;
        if (name !== current) return;
        void paintGuide(conversations.find((x) => x.name === name));
        /* Its tool could not be asked: the chat is on all the same; said here, the chat one click away. */
        if (asked) { $('chat-turn-said').textContent = `The chat is on, but its tool could not be asked to use it: ${asked}`; button.textContent = 'Open the chat'; button.dataset.open = 'yes'; return; }
        await readTalk(); await paintThread();
    });
    $('talk-invite').addEventListener('click', async () => {
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/talk/invite`, { lang: deviceLang() }); $('talk-invite').textContent = 'Asked'; setTimeout(() => { $('talk-invite').textContent = 'Ask the tool to use it'; }, 2500); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    /* Settings: the language of the chat screen, and the owner's own words. */
    let wordsSettings = null;
    async function paintWords() {
        if (DEVICE) return;
        wordsSettings = await fetch(`${API}/talk/settings`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!wordsSettings) return;
        const select = $('words-lang');
        select.replaceChildren(...[['device', `Each device's (${languageName(deviceLang())})`], ...wordsSettings.languages.map((l) => [l, languageName(l)])].map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }));
        select.value = wordsSettings.lang;
        if (document.activeElement !== $('words-own')) $('words-own').value = Object.keys(wordsSettings.own).length ? JSON.stringify(wordsSettings.own, null, 2) : '';
    }
    async function saveWords() {
        $('words-error').hidden = true;
        let own = {};
        const text = $('words-own').value.trim();
        if (text) { try { own = JSON.parse(text); } catch { $('words-error').textContent = 'This is not JSON. Write it like: {"send": "Go"}'; $('words-error').hidden = false; return; } }
        try {
            await post(`${API}/talk/settings`, { lang: $('words-lang').value, own });
            $('words-saved').textContent = 'Saved.'; setTimeout(() => { $('words-saved').textContent = ''; }, 2500);
            /* The chat screen is drawn again with them. */
            chatWords = null; thread?.destroy(); thread = null; threadOf = ''; void paintThread();
            await paintWords();
        } catch (error) { $('words-error').textContent = error.message; $('words-error').hidden = false; }
    }
    /* Settings: what the chat shows at first, on this device; what its tool reads again after a restart, on this server. */
    async function paintChatWindow() {
        const option = ([value, text], chosen) => { const o = document.createElement('option'); o.value = value; o.textContent = text; o.selected = value === chosen; return o; };
        $('chat-window').replaceChildren(...CHAT_WINDOWS.map((c) => option(c, chatWindow)));
        if (DEVICE) return;
        const now = await fetch(`${API}/talk/window`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (now) $('chat-window-ai').replaceChildren(...CHAT_WINDOWS.filter(([v]) => now.choices.includes(v)).map((c) => option(c, now.ai)));
    }
    $('chat-window').addEventListener('change', () => {
        chatWindow = $('chat-window').value;
        try { localStorage.setItem('clavarium-chat-window', chatWindow); } catch { /* a private window */ }
        /* Drawn again with it. */
        thread?.destroy(); thread = null; threadOf = ''; void paintThread();
    });
    $('chat-window-ai').addEventListener('change', async () => {
        try { await post(`${API}/talk/window`, { ai: $('chat-window-ai').value }); } catch (error) { $('words-error').textContent = error.message; $('words-error').hidden = false; }
        await paintChatWindow();
    });
    /* Settings: what the chat's thread shows of each kind of event (server/talk.mjs EVENT_LEVELS). */
    const THREAD_KINDS = [
        ['sent', 'Sent automatically', 'A branch went to the remote by itself'],
        ['sent-by-hand', 'Sent by hand', 'Sent from the review'],
        ['refused', 'Not sent', 'An automatic sending was refused: what to do'],
        ['origin', 'Origin updated', 'The remote brought commits'],
        ['wakeup', 'Wake-up', 'A wake-up was typed, or posted to its docket'],
        ['docket-done', 'Handled', 'What woke it, said done by the tool'],
        ['docket-failed', 'Could not be handled', 'Said failed by the tool, with why'],
        ['docket-unhandled', 'Not handled', 'Told three times, never said done'],
        ['docket-reminder', 'Reminder set', 'A reminder the tool set itself'],
        ['tether-notice', 'Later news', 'A mail came back, an invitation was declined'],
        ['machine-problem', 'Machine in trouble', 'Memory, disk, no answer, a failed restart'],
        ['machine-ok', 'Machine well again', 'What was wrong with it went away'],
        ['restarted', 'Machine restarted', 'Restarted or built again'],
        ['tools-updated', 'New tools', 'After an update: a restart gives its tool all of them'],
    ];
    const THREAD_LEVELS = [['needs-you', 'Needs you'], ['news', 'News'], ['trace', 'Trace']];
    async function paintThreadLevels() {
        if (DEVICE) return;
        const now = await fetch(`${API}/talk/thread`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!now) return;
        const box = $('thread-levels');
        box.replaceChildren(...THREAD_KINDS.flatMap(([kind, name, about]) => {
            const label = document.createElement('label'); label.htmlFor = `thread-level-${kind}`; label.textContent = name;
            const small = document.createElement('small'); small.textContent = about; label.append(small);
            const select = document.createElement('select'); select.id = `thread-level-${kind}`; select.dataset.kind = kind;
            select.append(...THREAD_LEVELS.map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = value === now.defaults?.[kind] ? `${text} (default)` : text; return o; }));
            select.value = now.levels?.[kind] ?? now.defaults?.[kind];
            select.addEventListener('change', () => void saveThreadLevel(kind, select.value));
            return [label, select];
        }));
    }
    /* BINDERS (#49): Binder's own settings -- how many binders an agent may make, whether
       agents may add columns, fields or change a binder's type -- read and set through it. */
    async function paintBinderSettings() {
        if (DEVICE) return;
        const got = await binderCall('settings', {});
        if (!got.ok) return;
        const s = got.data;
        if (document.activeElement !== $('binders-agent-lists')) $('binders-agent-lists').value = String(s.agentLists ?? '');
        for (const [id, on] of [['binders-agent-columns', s.agentColumns === true], ['binders-agent-fields', s.agentFields === true]]) {
            for (const b of $(id).children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === on));
        }
    }
    async function saveBinderSetting(change) {
        $('binders-error').hidden = true;
        const done = await binderCall('edit-settings', change);
        if (done.ok) { $('binders-saved').textContent = 'Saved.'; setTimeout(() => { $('binders-saved').textContent = ''; }, 2500); }
        else { $('binders-error').textContent = done.text; $('binders-error').hidden = false; }
        await paintBinderSettings();
    }
    $('binders-agent-lists').addEventListener('change', () => void saveBinderSetting({ agentLists: $('binders-agent-lists').value }));
    for (const [id, key] of [['binders-agent-columns', 'agentColumns'], ['binders-agent-fields', 'agentFields']]) {
        for (const b of $(id).children) b.addEventListener('click', () => void saveBinderSetting({ [key]: b.dataset.on === 'true' }));
    }
    async function saveThreadLevel(kind, level) {
        $('thread-error').hidden = true;
        try {
            await post(`${API}/talk/thread`, { levels: { [kind]: level } });
            $('thread-saved').textContent = 'Saved: what happens from now on.'; setTimeout(() => { $('thread-saved').textContent = ''; }, 2500);
        } catch (error) { $('thread-error').textContent = error.message; $('thread-error').hidden = false; }
        await paintThreadLevels();
    }
    $('words-save').addEventListener('click', () => void saveWords());
    $('words-lang').addEventListener('change', () => void saveWords());
    $('words-show').addEventListener('click', () => {
        const all = $('words-all');
        all.hidden = !all.hidden;
        if (!all.hidden && wordsSettings) all.textContent = JSON.stringify(Object.fromEntries(Object.entries(wordsSettings.english).filter(([key]) => key !== 'lang')), null, 2);
    });
    setInterval(() => { if (!document.hidden && current) void readTalk().then(() => { if (simple) void paintThread(); paintSimple(); }); }, 5000);

    $('simple-say').addEventListener('submit', (event) => {
        event.preventDefault();
        /* One plain line, then Enter: what a person would have typed. */
        // eslint-disable-next-line no-control-regex
        const text = $('simple-text').value.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
        if (!text) return;
        send(text); setTimeout(() => send('\r'), 120);
        $('simple-text').value = '';
        $('simple-sent').textContent = 'Sent.'; setTimeout(() => { $('simple-sent').textContent = ''; }, 2500);
    });
    setInterval(() => { if (simple && !document.hidden) paintSimple(); }, 1500);
    paintSimple();
    void chatFirst();

    /* ---------- alerts: this device is told when a tool waits ---------- */
    const pushKey = (text) => { const b = atob((text + '='.repeat((4 - (text.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
    const pushable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    async function paintAlerts(said) {
        const state = $('alerts-state');
        if (!pushable()) {
            $('alerts-on').hidden = true;
            state.textContent = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'Install the app first (Share, then "Add to Home Screen")' : 'Not possible in this browser';
            return;
        }
        const registration = await navigator.serviceWorker.ready;
        const mine = await registration.pushManager.getSubscription();
        const about = await fetch(`${API}/alerts`).then((r) => r.json()).catch(() => ({ devices: [] }));
        $('alerts-on').hidden = Boolean(mine); $('alerts-off').hidden = $('alerts-test').hidden = !mine;
        state.textContent = said ?? (mine ? `On · ${about.devices.length} device${about.devices.length === 1 ? '' : 's'} in all` : `Off${about.devices.length > 0 ? ` · ${about.devices.length} other device${about.devices.length === 1 ? '' : 's'} on` : ''}`);
    }
    /* Turned on for this device: asked by its button, and by the next step of Features (features.js). */
    async function alertsOn() {
        try {
            if ((await Notification.requestPermission()) !== 'granted') { await paintAlerts('Refused in this browser\'s settings'); return; }
            const { key } = await fetch(`${API}/alerts`).then((r) => r.json());
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey(key) });
            await post(`${API}/alerts`, { subscription: subscription.toJSON(), label: /Android/.test(navigator.userAgent) ? 'Android' : /iPad|iPhone/.test(navigator.userAgent) ? 'iPhone or iPad' : 'Computer' });
            await paintAlerts();
        } catch (error) { await paintAlerts(`Could not be set up: ${error.message}`); }
    }
    $('alerts-on').addEventListener('click', () => { void alertsOn(); });
    $('alerts-off').addEventListener('click', async () => {
        const registration = await navigator.serviceWorker.ready;
        const mine = await registration.pushManager.getSubscription();
        if (mine) { await post(`${API}/alerts/remove`, { endpoint: mine.endpoint }).catch(() => {}); await mine.unsubscribe().catch(() => {}); }
        await paintAlerts();
    });
    $('alerts-test').addEventListener('click', async () => {
        const r = await post(`${API}/alerts/test`, {}).catch(() => ({ reached: 0 }));
        await paintAlerts(r.reached > 0 ? `Sent to ${r.reached} device(s). It should show in a moment.` : 'No device could be reached.');
    });

    /* ---------- wake-ups: an arrival, or the clock ---------- */
    const wakeupSays = (w) => (w.kind === 'arrival' ? `When something ${w.onlyNew ? 'new arrives' : 'arrives or changes'} in ${w.resource}${w.quiet > 0 ? `, still for ${w.quiet} s` : ''}` : w.kind === 'every' ? `Every ${w.minutes} minute${w.minutes > 1 ? 's' : ''}` : w.kind === 'cron' ? `By the clock: ${w.line}` : w.kind === 'call' ? 'When its address is called from outside' : `Every day at ${w.at}`);
    function paintWakeups() {
        if (DEVICE) { $('wakeups-box').hidden = true; return; }
        const here = conversations.find((x) => x.name === current);
        const mine = here?.wakeups;
        $('wakeups-box').hidden = !mine;
        if (!mine) return;
        const rows = $('wakeups-rows');
        rows.replaceChildren();
        for (const w of mine.items) {
            const row = document.createElement('div'); row.className = 'wakeup'; row.dataset.kind = w.kind;
            const what = document.createElement('b'); what.textContent = wakeupSays(w);
            const said = document.createElement('p'); said.className = 'hint'; said.textContent = `Typed: ${w.message}`;
            const last = document.createElement('p'); last.className = 'hint wakeup-last'; last.textContent = w.last ? `Last: ${agoSaid(w.last.at)} · ${w.last.what}` : 'Not yet.'; last.title = w.last ? new Date(w.last.at).toLocaleString() : '';
            const acts = document.createElement('div'); acts.className = 'row';
            acts.append(modes([['on', 'On'], ['off', 'Off']], w.on ? 'on' : 'off', async (value) => { await post(`${API}/conversations/${encodeURIComponent(current)}/wakeups/${w.id}`, { on: value === 'on' }); await refresh(); paintWakeups(); }, `This wake-up: ${wakeupSays(w)}`));
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
            remove.addEventListener('click', async () => { await post(`${API}/conversations/${encodeURIComponent(current)}/wakeups/${w.id}/remove`, {}); await refresh(); paintWakeups(); });
            acts.append(remove);
            row.append(what, said, last, acts);
            rows.append(row);
        }
        /* The form is not painted over while somebody fills it. */
        const select = $('wakeup-resource');
        const wanted = (here?.resources ?? []).map((r) => r.name).join('/');
        if (select.dataset.of !== `${current}:${wanted}`) {
            select.replaceChildren(...(here?.resources ?? []).map((r) => { const o = document.createElement('option'); o.value = r.name; o.textContent = r.name; return o; }));
            select.dataset.of = `${current}:${wanted}`;
        }
        if (document.activeElement?.id !== 'wakeups-limit') $('wakeups-limit').value = String(mine.perHour);
        $('wakeups-sent').textContent = `0: no cap · ${mine.sentThisHour} this hour`;
        void paintDocket();
    }
    /* Its docket (server/dockets.mjs): the reminders its tool set, which its owner may take back; the newest events. */
    const DOCKET_STATES = { waiting: 'waits', done: 'done', failed: 'could not be done' };
    async function paintDocket() {
        const of = current;
        const d = DEVICE || !of ? null : await fetch(`${API}/conversations/${encodeURIComponent(of)}/docket`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (of !== current) return;
        $('docket-box').hidden = !d?.on;
        if (!d?.on) return;
        const plans = $('docket-plans');
        plans.replaceChildren();
        for (const p of d.plans) {
            const row = document.createElement('div'); row.className = 'wakeup'; row.dataset.kind = 'reminder';
            const what = document.createElement('b'); what.textContent = p.text;
            const when = document.createElement('p'); when.className = 'hint'; when.textContent = `${p.cron ? `By the clock (${p.cron}), next` : 'Once,'} ${new Date(p.next).toLocaleString()}`;
            const off = document.createElement('button'); off.type = 'button'; off.textContent = 'Take it back';
            off.addEventListener('click', async () => { try { await post(`${API}/conversations/${encodeURIComponent(of)}/docket/cancel`, { plan: p.id }); } catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; } void paintDocket(); });
            const acts = document.createElement('div'); acts.className = 'row'; acts.append(off);
            row.append(what, when, acts);
            plans.append(row);
        }
        if (d.plans.length === 0) { const none = document.createElement('p'); none.className = 'hint'; none.textContent = 'No reminder set by the tool.'; plans.append(none); }
        const events = $('docket-events');
        events.replaceChildren();
        for (const e of d.events.slice(0, 8)) {
            const line = document.createElement('p'); line.className = 'hint docket-event'; line.dataset.state = e.state;
            line.textContent = `${new Date(e.at).toLocaleString()}: ${e.text} -- ${DOCKET_STATES[e.state] ?? e.state}${e.note ? ` (${e.note})` : ''}${e.state === 'waiting' && e.told ? `, told ${e.told} time${e.told > 1 ? 's' : ''}` : ''}`;
            events.append(line);
        }
    }
    /* BY THE CLOCK IS ALWAYS A CRON LINE. The few usual choices write it, and
       it stays in sight: what is set is what is shown, and it can be changed. */
    const clockLine = () => {
        const often = $('wakeup-often').value;
        const timed = often === 'daily' || often === 'weekdays';
        $('wakeup-at-box').hidden = !timed;
        if (often === 'custom') { focusField($('wakeup-line')); return; }
        const [h, m] = ($('wakeup-at').value || '07:30').split(':').map(Number);
        $('wakeup-line').value = timed ? `${m} ${h} * * ${often === 'weekdays' ? '1-5' : '*'}` : often;
    };
    $('wakeup-often').addEventListener('change', clockLine);
    $('wakeup-at').addEventListener('input', clockLine);
    $('wakeup-line').addEventListener('input', () => { $('wakeup-often').value = 'custom'; $('wakeup-at-box').hidden = true; });
    $('wakeup-kind').addEventListener('change', () => { for (const part of $('wakeups-new').querySelectorAll('[data-for]')) part.hidden = part.dataset.for !== $('wakeup-kind').value; });
    $('wakeups-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try {
            const made = await post(`${API}/conversations/${encodeURIComponent(current)}/wakeups`, { kind: $('wakeup-kind').value, resource: $('wakeup-resource').value, onlyNew: !$('wakeup-changed').checked, quiet: Number($('wakeup-quiet').value || 0), line: $('wakeup-line').value, message: $('wakeup-message').value });
            $('wakeup-message').value = ''; $('wakeups-new-box').open = false;
            if (made.address) { $('wakeup-address').value = `${location.origin}${made.address}`; $('wakeup-address-box').hidden = false; }
            await refresh(); paintWakeups();
        } catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; $('panel-error').scrollIntoView({ block: 'nearest' }); }
    });
    $('wakeup-address-copy').addEventListener('click', async () => { $('wakeup-address').select(); await navigator.clipboard?.writeText($('wakeup-address').value).catch(() => {}); $('wakeup-address-copy').textContent = 'Copied'; });
    $('wakeup-address-done').addEventListener('click', () => { $('wakeup-address').value = ''; $('wakeup-address-box').hidden = true; $('wakeup-address-copy').textContent = 'Copy'; });
    $('wakeups-limit-save').addEventListener('click', async () => {
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/wakeups`, { perHour: Number($('wakeups-limit').value || 0) }); await refresh(); paintWakeups(); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });

    /* ---------- answers in the owner's place ---------- */
    let platformSaid;
    async function paintAnswerer() {
        if (DEVICE) { $('answerer-box').hidden = true; return; }
        platformSaid ??= await fetch(`${API}/platform`).then((r) => r.json()).catch(() => ({}));
        const about = platformSaid.answerer;
        const mine = conversations.find((x) => x.name === current)?.answerer;
        $('answerer-fields').hidden = !about || !mine;
        /* None set on this installation: its chapter hidden (an empty section is hidden). */
        $('chapter-answerer').hidden = !about;
        if (!about || !mine) { $('answerer-about').textContent = 'While you are away, several models can answer the simple questions of the tool. None is set on this installation (CLAVARIUM_ANSWERER_URL, CLAVARIUM_ANSWERER_MODELS).'; return; }
        $('answerer-about').textContent = `While you are away, ${about.models.length > 1 ? `${about.models.length} models answer the simple questions of the tool, when they ALL give the same answer` : 'one model answers the simple questions of the tool'}; otherwise you are asked. Turned on, THE SCREEN OF THIS CONVERSATION IS SENT to: ${about.models.join(', ')}.`;
        /* What is being written is not painted over by a refresh. */
        const editing = ['answerer-objectives', 'answerer-charter', 'answerer-limit'].includes(document.activeElement?.id);
        if (!editing && $('answerer-box').dataset.of !== `${current}/${mine.objectives}/${mine.charter}/${mine.limit}`) {
            $('answerer-objectives').value = mine.objectives; $('answerer-charter').value = mine.charter; $('answerer-limit').value = String(mine.limit);
            $('answerer-box').dataset.of = `${current}/${mine.objectives}/${mine.charter}/${mine.limit}`;
        }
        for (const b of $('answerer-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === mine.on));
        $('answerer-on').children[0].textContent = mine.on ? 'On (save)' : 'On';
        $('answerer-resume').hidden = !mine.needs;
        $('answerer-state').textContent = !mine.on ? 'Off: nobody answers but you.'
            : mine.needs ? `It stopped and waits for you. ${mine.needs.why}`
                : `${mine.row} answer(s) in a row${mine.limit > 0 ? ` of ${mine.limit}` : ', no limit'}.${mine.last ? ` Last: ${mine.last.answer}, ${new Date(mine.last.at).toLocaleString()}.` : ''}`;
        if ($('answerer-log-box').open) void paintAnswererLog();
    }
    async function paintAnswererLog() {
        const box = $('answerer-log');
        const entries = await fetch(`${API}/conversations/${encodeURIComponent(current)}/answerer/log`).then((r) => r.json()).catch(() => []);
        box.replaceChildren();
        if (!Array.isArray(entries) || entries.length === 0) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Nothing yet.'; box.append(p); return; }
        for (const e of entries) {
            const item = document.createElement('details'); item.className = 'answered'; item.dataset.outcome = e.outcome;
            const head = document.createElement('summary');
            head.textContent = `${new Date(e.at).toLocaleString()} - ${e.outcome === 'answered' ? `answered ${e.answer}` : e.outcome === 'human' ? 'left to you' : 'failed'}${e.why ? `: ${e.why}` : ''}`;
            item.append(head);
            for (const s of e.said ?? []) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = `${s.model}: ${s.says}${s.why ? ` (${s.why})` : ''}`; item.append(p); }
            /* What the tool had printed: text, never built. */
            const pre = document.createElement('pre'); pre.textContent = e.screen ?? ''; item.append(pre);
            box.append(item);
        }
    }
    $('answerer-log-box').addEventListener('toggle', () => { if ($('answerer-log-box').open) void paintAnswererLog(); });
    for (const b of $('answerer-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try {
                await post(`${API}/conversations/${encodeURIComponent(current)}/answerer`, { on: b.dataset.on === 'true', objectives: $('answerer-objectives').value, charter: $('answerer-charter').value, limit: Number($('answerer-limit').value || 0) });
                $('answerer-box').dataset.of = '';
                await refresh(); await paintAnswerer();
            } catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    $('answerer-resume').addEventListener('click', async () => {
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/answerer/resume`, {}); await refresh(); await paintAnswerer(); }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
    });
    const fixedUse = () => { const s = document.createElement('span'); s.className = 'hint'; s.textContent = 'Use'; return s; };
    for (const b of $('network').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/network`, { online: b.dataset.online === 'true' }); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
            await refresh();
            await paintPanel();
        });
    }
    /* `picking`: open on what can be attached (the "+ Attach" of the bar). */
    async function openAccess(picking = false) {
        if (DEVICE || !current) return;
        if (place !== 'conversations') leavePlace();
        goTab('settings');
        /* What is attached may have changed from another screen: asked again before it is shown. */
        await refresh();
        await paintPanel();
        $('attach-picker').hidden = !picking;
        if (picking) openAttach();
        /* The folders button shows the folders: their chapter opened, in its tab. */
        openChapter('access', { show: !picking });
        if (picking) $('attach-picker').scrollIntoView({ block: 'nearest' });
    }
    $('folders').addEventListener('click', () => { void openAccess(false); });
    /* ATTACH: ONE BUTTON (05-11). What is there already, to tick, or a new one -- the New asset box, with this
       conversation as its context: what is made there is attached to it at the end. */
    let attachNew = { kind: '', level: 'write' };
    function openAttach() {
        attachNew = { kind: '', level: 'write' };
        if (justMade?.to) justMade = null;
        $('attach-error').hidden = true;
        paintAttach();
    }
    function closeAttach() {
        $('attach-picker').hidden = true; $('attach-close').hidden = false;
        attachNew.kind = ''; if (justMade?.to) justMade = null;
        for (const f of $('attach-box').querySelectorAll('.as-form')) $('assets-forms').append(f);
    }
    function paintAttach() {
        const box = $('attach-box');
        for (const f of box.querySelectorAll('.as-form')) $('assets-forms').append(f);
        $('attach-park').append($('attach-there'));
        const who = shownName(conversations.find((c) => c.name === current)) || current;
        const made = justMade?.to === current ? justMade : null;
        const kind = made ? '' : attachNew.kind;
        /* At its ending, one Done: the box's own. */
        $('attach-close').hidden = Boolean(made) || (kind === 'box' && Boolean(boxFlow?.made));
        /* A secret is used or not, a voice box speaks there: no level to choose. */
        const level = kind && !['secret', 'box'].includes(kind) ? { options: [{ value: 'read', label: uiSaid('set-na-read', 'Read') }, { value: 'write', label: uiSaid('set-na-write', 'Write') }], value: attachNew.level, label: uiSaid('set-na-level', 'What it may do'), onChange: (v) => { attachNew.level = v; } } : null;
        box.replaceChildren(newAssetBox({
            kind, existing: $('attach-there'), title: '',
            context: made ? null : { line: uiSaid('set-na-will', 'Will be attached to {name}', { name: who }), level },
            made: made ? { said: uiSaid('set-na-made-to', '{name} created and attached to {to}', { name: made.name, to: who }), note: made.note } : null,
            onKind: (k) => {
                attachNew.kind = k; justMade = null; $('attach-error').hidden = true; paintAttach(); focusFirst(box);
                /* Its keys, read here too: Assets may not have been opened yet. */
                if (k === 'git') void getJson('/git-keys', []).then((keys) => paintKeys(keys));
            },
            onBack: () => { attachNew.kind = ''; $('attach-error').hidden = true; paintAttach(); },
            onAnother: () => { attachNew.kind = made.kind; justMade = null; paintAttach(); focusFirst(box); },
            onDone: () => { closeAttach(); },
            boxHost: { where: current, repaint: () => paintAttach(), close: () => closeAttach() },
        }));
    }
    $('attach-open').addEventListener('click', () => { openChapter('access'); $('attach-picker').hidden = false; openAttach(); $('attach-picker').scrollIntoView({ block: 'nearest' }); });
    $('attach-close').addEventListener('click', () => { closeAttach(); });
    $('attach-manage').addEventListener('click', () => { void openAssets(); });

    /* ---------- ASSETS: one design, two pages (G and H) ----------
       The server's (a place, beside Access and Settings): everything kept
       here, by kind, with a search and a small "+" per kind; one opened on
       the right says who uses it, its state, its settings. A conversation's
       own (the bar's "Assets N"): what it was given, the same rows; a folder
       opened shows its files (the Files sheet, moved in), a repository its
       branches. On a phone, the list, then one asset with "All assets". */
    /* BINDER'S LISTS, AS THIS PAGE NAMES THEM: the one place for the word (Assets, a conversation's tab). */
    const LISTS_WORD = { many: 'Binders', one: 'Binder', a: 'a binder', its: 'Its binders' };
    $('view-lists-word').textContent = LISTS_WORD.many; $('listnew-head').textContent = `New ${LISTS_WORD.one.toLowerCase()}`;
    const ASSET_KINDS = [['git', 'Git repositories', 'git-branch'], ['folder', 'Folders', 'folder'], ['mailbox', 'Mailboxes', 'mail'], ['agenda', 'Calendars', 'calendar'], ['contacts', 'Contacts', 'users'], ['secret', 'Secrets', 'key-round'], ['list', LISTS_WORD.many, '']];
    /* A live Tether target shows in the category of its kind (a mailbox among the
       mailboxes), not apart. Its connecting account is the rest of its id. */
    const TETHER_CAT = { mail: 'mailbox', calendar: 'agenda', contacts: 'contacts' };
    const tetherCat = (k) => TETHER_CAT[k] ?? 'acces';
    const tetherAccount = (id) => String(id).replace(/^(mail|calendar|contacts|files|ssh|browser|screen|computer)-/, '');
    /* Adding to a type category of live links (a calendar, an address book, an
       access) is connecting an account: they all open the connect-account form. */
    const addForm = (k) => (['agenda', 'contacts', 'acces'].includes(k) ? 'connexion' : k);
    /* Its answer, or { state: 'error', message }: the server's own words, or busy (asked again first). */
    const readOrSay = async (path) => {
        for (let i = 0; i < 3; i++) {
            try {
                const r = await fetch(`${API}${path}`);
                const j = await r.json().catch(() => ({}));
                if (r.ok) return j;
                /* Down for a moment, or its repository busy (another read holds it): asked again. */
                if (!(r.status === 503 && (j.down === true || j.kind === 'busy'))) return { state: 'error', message: j.error || 'It could not be read.' };
            } catch { return { state: 'error', message: 'It could not be read.' }; }
            await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
        }
        return { state: 'error', message: BUSY };
    };
    const getJson = async (path, fallback) => {
        for (let i = 0; i < 3; i++) {
            try {
                const r = await fetch(`${API}${path}`);
                if (r.ok) return await r.json();
                if (r.status !== 503) return fallback;
            } catch { return fallback; }
            await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));   /* busy a moment: asked again */
        }
        return fallback;
    };
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    /* A commit: its line, and the rest of its message under it, opened by a click. */
    function commitRow(c) {
        const rest = (c.message ?? '').split('\n').slice(1).join('\n').trim();
        const head = [el('code', '', c.id.slice(0, 8)), el('b', '', c.subject), el('small', '', `${c.author}, ${new Date(c.date).toLocaleString()}`)];
        if (!rest) { const line = el('div', 'commit'); line.append(...head); return line; }
        const line = el('details', 'commit'); const summary = el('summary'); summary.append(...head);
        line.append(summary, el('pre', '', rest));
        return line;
    }
    const kindIcon = (kind) => { const name = kind === 'send' || kind === 'demandes' ? 'arrow-up' : kind === 'box' ? 'mic' : kind === 'device' ? 'smartphone' : ASSET_KINDS.find((k) => k[0] === kind)?.[2]; const holder = el('span', 'as-ic'); holder.dataset.kind = kind; const svg = kind === 'list' ? listIcon() : name ? window.clavariumIcons?.icon(name) : null; if (svg) holder.append(svg); return holder; };
    /* A list (Binder's): the set has no such sign, so it is drawn here, in its style. */
    function listIcon() {
        const SVG = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        for (const d of ['m3 17 2 2 4-4', 'm3 7 2 2 4-4', 'M13 6h8', 'M13 12h8', 'M13 18h8']) { const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', d); svg.append(path); }
        return svg;
    }
    const roundPlus = (label, onclick) => { const b = el('button', 'as-add', '+'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', onclick); return b; };
    /* One row, used by both the by-type and the by-group views. The icon
       follows the item's own kind (a group mixes kinds). */
    function assetRow(item, { chosen, choose }) {
        const row = el('button', 'as-row'); row.type = 'button'; row.dataset.asset = item.key; row.dataset.name = item.name;
        if (item.key === chosen) row.setAttribute('aria-current', 'true');
        const name = el('b', '', item.name);
        if (item.badge) { const badge = el('span', `as-badge${item.badgeTone ? ` ${item.badgeTone}` : ''}`, item.badge); if (item.badgeTitle) badge.title = item.badgeTitle; name.append(badge); }
        const sub = el('small', item.tone ? `as-sub ${item.tone}` : 'as-sub', item.sub ?? '');
        if (item.dot) { sub.classList.add('status-line'); sub.dataset.tone = item.dot; }
        const words = el('span', 'as-words'); words.append(name, sub);
        row.append(kindIcon(item.kind), words);
        row.addEventListener('click', () => choose(item.key));
        return row;
    }
    /* The rows, by kind. items: [{key, kind, name, sub, badge, badgeTitle, tone}]. */
    function paintAsList(holder, items, { chosen, choose, add, empty }) {
        holder.replaceChildren();
        for (const [kind, title] of ASSET_KINDS) {
            const mine = items.filter((i) => i.kind === kind);
            if (mine.length === 0 && !add) continue;
            const section = el('section', 'as-kind'); section.dataset.kind = kind;
            const head = el('div', 'as-kind-head'); head.append(el('h3', '', title));
            if (add) head.append(roundPlus(`Add ${{ git: 'a repository', folder: 'a folder', mailbox: 'a mailbox', agenda: 'a calendar', contacts: 'an address book', acces: 'an access', secret: 'a secret', list: LISTS_WORD.a }[kind]}`, () => add(kind)));
            section.append(head);
            if (mine.length === 0) section.append(el('p', 'hint as-none', 'None yet'));
            for (const item of mine) section.append(assetRow(item, { chosen, choose }));
            holder.append(section);
        }
        if (items.length === 0 && empty) holder.append(el('p', 'hint', empty));
    }
    /* The group an asset is in, or '' for none. */
    const groupOf = (key, groups) => groups.find((g) => (g.members ?? []).includes(key))?.id ?? '';
    /* Groups the owner has folded shut in the by-group view (a convenience). */
    const groupsFolded = (() => { try { const v = JSON.parse(localStorage.getItem('clavarium-groups-folded') ?? '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); } })();
    const keepGroupsFolded = () => { try { localStorage.setItem('clavarium-groups-folded', JSON.stringify([...groupsFolded])); } catch { /* a private window */ } };
    /* The rows, by the owner's groups: a foldable section per group, then the
       loose ones. A group's name opens its own detail (rename, remove, give the
       whole group); the chevron folds it; "+" makes a new one. An asset is put
       into a group from the asset's own detail. */
    function paintAsGroups(holder, items, groups, { chosen, choose, empty }) {
        holder.replaceChildren();
        const byKey = new Map(items.map((i) => [i.key, i]));
        const addBar = el('div', 'as-group-new');
        if (groupAdding) {
            const form = el('form', 'as-group-form'); form.autocomplete = 'off';
            const input = el('input'); input.placeholder = 'Group name'; input.maxLength = 40; input.setAttribute('aria-label', 'New group name');
            const make = el('button', 'primary', 'Add'); make.type = 'submit';
            const cancel = el('button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => { groupAdding = false; void paintAssets(); });
            form.append(input, make, cancel);
            form.addEventListener('submit', async (event) => {
                event.preventDefault(); $('assets-error').hidden = true;
                try { const made = await post(`${API}/asset-groups`, { label: input.value.trim() }); groupAdding = false; assetOpen = `group:${made.id}`; remember(); }
                catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
                void paintAssets();
            });
            addBar.append(form);
            holder.append(addBar);
            queueMicrotask(() => input.focus());
        } else {
            addBar.append(roundPlus('New group', () => { groupAdding = true; void paintAssets(); }), el('span', 'hint', 'New group'));
            holder.append(addBar);
        }
        const section = (head, rows, none, { foldable, drop } = {}) => {
            const s = el('section', 'as-kind as-group'); s.append(head); s.dataset.drop = drop;
            if (!foldable || !head.dataset.folded) {
                if (rows.length === 0) s.append(el('p', 'hint as-none', none));
                for (const item of rows) s.append(assetRow(item, { chosen, choose }));
            }
            holder.append(s);
        };
        for (const g of groups) {
            const members = (g.members ?? []).map((k) => byKey.get(k)).filter(Boolean);
            const folded = groupsFolded.has(g.id);
            const head = el('div', 'as-kind-head as-group-head'); if (folded) head.dataset.folded = 'true';
            /* The whole header folds/unfolds the group; a gear opens its settings. */
            const toggle = el('button', 'as-group-name'); toggle.type = 'button';
            if (`group:${g.id}` === chosen) toggle.setAttribute('aria-current', 'true');
            toggle.setAttribute('aria-expanded', String(!folded));
            toggle.append(el('span', 'as-chev', folded ? '▸' : '▾'), el('h3', '', g.label), el('span', 'as-badge count', String(members.length)));
            toggle.title = folded ? 'Unfold' : 'Fold';
            toggle.addEventListener('click', () => { if (folded) groupsFolded.delete(g.id); else groupsFolded.add(g.id); keepGroupsFolded(); void paintAssets(); });
            const gear = el('button', 'as-gear', '⚙'); gear.type = 'button'; gear.setAttribute('aria-label', `Settings for ${g.label}`); gear.title = 'Give, rename, remove';
            gear.addEventListener('click', (e) => { e.stopPropagation(); choose(`group:${g.id}`); });
            head.append(toggle, gear);
            section(head, members, 'Empty. Drag an asset here, or open one to put it here.', { foldable: true, drop: g.id });
        }
        const grouped = new Set(groups.flatMap((g) => g.members ?? []));
        const loose = items.filter((i) => !grouped.has(i.key));
        const looseHead = el('div', 'as-kind-head'); looseHead.append(el('h3', '', 'No group'));
        section(looseHead, loose, groups.length ? 'Every asset is in a group.' : 'Make a group above, then open an asset to put it in it.', { drop: '' });
        if (items.length === 0 && empty) holder.append(el('p', 'hint', empty));
        if (groups.length) dragToGroups(holder);
    }
    /* DRAGGING AN ASSET ONTO A GROUP (#111), like a binder's Kanban: a mouse drags once it
       has moved a little; a finger after a short hold (so a swipe still scrolls). The row
       follows the pointer as a light copy; the group under it lights up; let go on it, and
       the asset is placed there ("No group" takes it out). A tap still opens the asset. */
    function dragToGroups(holder) {
        let drag = null;
        const sectionAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.as-group[data-drop]') ?? null;
        const end = () => { if (!drag) return; clearTimeout(drag.hold); drag.ghost?.remove(); drag.over?.classList.remove('as-drop-over'); document.body.classList.remove('as-dragging'); drag = null; };
        const start = (d) => {
            d.on = true;
            const r = d.row.getBoundingClientRect();
            d.ghost = d.row.cloneNode(true); d.ghost.classList.add('as-drag-ghost');
            Object.assign(d.ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
            d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
            document.body.append(d.ghost); document.body.classList.add('as-dragging');
        };
        holder.addEventListener('pointerdown', (e) => {
            const row = e.target.closest('.as-row[data-asset]');
            if (!row || !holder.contains(row) || e.button > 0) return;
            drag = { row, id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, touch: e.pointerType !== 'mouse', from: row.closest('.as-group')?.dataset.drop };
            if (drag.touch) { const d = drag; d.hold = setTimeout(() => { if (drag === d) { start(d); try { row.setPointerCapture(d.id); } catch { /* still heard */ } } }, 350); }
        });
        holder.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const far = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6;
            if (!drag.on) { if (drag.touch) { if (far) end(); return; } if (!far) return; start(drag); try { drag.row.setPointerCapture(drag.id); } catch { /* still heard */ } }
            e.preventDefault();
            drag.ghost.style.left = `${e.clientX - drag.dx}px`; drag.ghost.style.top = `${e.clientY - drag.dy}px`;
            const over = sectionAt(e.clientX, e.clientY);
            if (over !== drag.over) { drag.over?.classList.remove('as-drop-over'); drag.over = over; over?.classList.add('as-drop-over'); }
        });
        holder.addEventListener('pointerup', async (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const d = drag; const target = d.on ? sectionAt(e.clientX, e.clientY) : null;
            const was = d.on; end();
            if (!was) return;
            /* A drag is not a tap: the click that follows does not open the asset. */
            d.row.addEventListener('click', (c) => { c.stopImmediatePropagation(); c.preventDefault(); }, { capture: true, once: true });
            if (!target || target.dataset.drop === d.from) return;
            $('assets-error').hidden = true;
            try { await post(`${API}/asset-groups/place`, { asset: d.row.dataset.asset, group: target.dataset.drop || null }); }
            catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
            void paintAssets();
        });
        holder.addEventListener('pointercancel', end);
        /* Once a finger's drag has begun, the page must not scroll under it. */
        holder.addEventListener('touchmove', (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
    }
    /* The level buttons an asset takes, by its type (same sets as its own detail). */
    const levelOptionsFor = (item) => (item.target ? [['none', 'Off'], ['watch', 'Watch'], ['propose', 'Propose'], ['frame', 'Frame'], ['free', 'Free']]
        : item.kind === 'secret' ? [['off', 'Off'], ['use', 'Use']]
        : item.kind === 'mailbox' ? [['none', 'Off'], ['read', 'Read']]
        : [['none', 'Off'], ['read', 'Read'], ['write', 'Write']]);
    /* The shortcut "give all": each member at the lightest real level for its type. */
    const giveValue = (item, on) => (!on ? (item.target || item.kind !== 'secret' ? 'none' : 'off')
        : item.target ? 'watch' : item.kind === 'secret' ? 'use' : 'read');
    async function applyMemberGrant(item, conversationName, value) {
        if (item.target) return grantTarget(item.target.id, conversationName, value);
        if (item.kind === 'secret') return handTo(conversationName, item.name, value === 'use', 'assets-error');
        if (item.kind === 'list') return grantList(item.list.id, conversationName, value);
        return attachTo(conversationName, item.name, value, 'assets-error');
    }
    function memberCurrent(item, conversationName) {
        const id = `conversation:${conversationName}`;
        if (item.target) return item.target.grants?.[id]?.level ?? 'none';
        if (item.kind === 'secret') return item.secret.conversations.includes(conversationName) ? 'use' : 'off';
        if (item.kind === 'list') return item.list.grants?.[id] ?? 'none';
        return item.resource?.attachments?.[conversationName] ?? 'none';
    }
    /* The toggle above the rows: by type (default) or by the owner's groups. */
    function paintAssetsView() {
        const bar = $('assets-view'); if (!bar) return;
        bar.replaceChildren();
        for (const [by, label] of [['type', 'By type'], ['group', 'By group']]) {
            const b = el('button', '', label); b.type = 'button'; b.dataset.by = by;
            b.setAttribute('aria-pressed', String(assetsBy === by));
            b.addEventListener('click', () => { if (assetsBy === by) return; assetsBy = by; keepAssetsBy(); groupAdding = false; void paintAssets(); });
            bar.append(b);
        }
    }
    /* In an asset's detail: which group it is in. Moving it is a folder move
       (it leaves any other group). New groups are made in the by-group view. */
    function groupPicker(chosen, groups) {
        const wrap = el('div', 'as-group-of'); wrap.append(el('span', 'as-group-of-label', 'Group'));
        if (!groups.length) { wrap.append(el('small', 'hint', 'Make one in “By group”.')); return wrap; }
        const sel = el('select'); sel.setAttribute('aria-label', `Group for ${chosen.name}`);
        const none = el('option', '', 'No group'); none.value = ''; sel.append(none);
        const inId = groupOf(chosen.key, groups);
        for (const g of groups) { const o = el('option', '', g.label); o.value = g.id; if (g.id === inId) o.selected = true; sel.append(o); }
        if (!inId) none.selected = true;
        sel.addEventListener('change', async () => {
            $('assets-error').hidden = true;
            try { await post(`${API}/asset-groups/place`, { asset: chosen.key, group: sel.value || null }); }
            catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
            void paintAssets();
        });
        wrap.append(sel);
        return wrap;
    }
    /* A group's own detail: rename it, remove it (the assets stay), give the
       whole group to a conversation at a level, and its members (each opens). */
    function groupDetail(detail, group, items, back) {
        const members = (group.members ?? []).map((k) => items.find((i) => i.key === k)).filter(Boolean);
        const top = el('div', 'as-title');
        const all = el('button', 'as-link as-back', '‹ Assets'); all.type = 'button'; all.addEventListener('click', () => { if (!nav.close('asset')) back(); });
        const h = el('h2'); h.append(el('span', '', group.label), el('span', 'as-badge count', String(members.length)));
        top.append(all, h);
        detail.append(top);
        const repaint = () => void paintAssets();
        const openAsset = (key) => { placeAssetStep(); if (key !== assetOpen) groupGiveShow.clear(); assetOpen = key; remember(); void paintAssets(); };

        /* GIVE THE GROUP: a block per conversation, a row per asset AT ITS OWN
           level. Two shortcuts set or clear all at once (not a sticky state).
           Rights stay stored per asset -- this is just a handy place to set them. */
        const ready = conversations.filter((c) => c.phase === 'ready');
        const isGiven = (c) => members.some((m) => !['none', 'off'].includes(memberCurrent(m, c.name)));
        const shownConvs = ready.filter((c) => isGiven(c) || groupGiveShow.has(c.name));
        const setAll = async (c, on) => { for (const m of members) { try { await applyMemberGrant(m, c.name, giveValue(m, on)); } catch { /* shown by the grant */ } } repaint(); };
        const convBlock = (c) => {
            const block = el('div', 'as-give-conv');
            const head = el('div', 'as-give-head');
            const giveAll = el('button', 'as-mini', 'Give all'); giveAll.type = 'button'; giveAll.addEventListener('click', () => setAll(c, true));
            const clearAll = el('button', 'as-mini', 'Remove all'); clearAll.type = 'button'; clearAll.addEventListener('click', () => setAll(c, false));
            head.append(el('b', '', shownName(c)), el('span', 'as-give-acts', ''));
            head.lastChild.append(giveAll, clearAll);
            block.append(head);
            for (const m of members) {
                const line = el('div', 'as-give-row');
                const nm = el('span', 'as-give-name'); nm.append(kindIcon(m.kind), el('span', '', m.name));
                line.append(nm, modes(levelOptionsFor(m), memberCurrent(m, c.name), async (v) => { await applyMemberGrant(m, c.name, v); repaint(); }, `${m.name} for ${shownName(c)}`));
                block.append(line);
            }
            if (members.length === 0) block.append(el('p', 'hint', 'The group is empty.'));
            return block;
        };
        detail.append(chapter('Give the group to a conversation'));
        const giveBox = el('div', 'as-give');
        for (const c of shownConvs) giveBox.append(convBlock(c));
        if (shownConvs.length === 0) giveBox.append(el('p', 'hint', members.length ? 'Not given to any conversation yet.' : 'Add assets to the group first (open an asset, pick this group).'));
        detail.append(giveBox);
        /* Add a conversation to set up, even before any asset is given to it. */
        const others = ready.filter((c) => !shownConvs.includes(c));
        const addConv = el('button', 'as-link as-add-conv', '+ a conversation'); addConv.type = 'button';
        const picker = el('div', 'as-pick'); picker.hidden = true;
        for (const c of others) { const b = el('button', 'as-pick-conv', shownName(c)); b.type = 'button'; b.addEventListener('click', () => { groupGiveShow.add(c.name); repaint(); }); picker.append(b); }
        if (others.length === 0) picker.append(el('p', 'hint', ready.length ? 'Every conversation is shown.' : 'No conversation is ready.'));
        addConv.addEventListener('click', () => { picker.hidden = !picker.hidden; });
        if (members.length) detail.append(addConv, picker);
        const note = el('p', 'as-assoc hint');
        note.append(el('b', '', 'Per asset'), document.createTextNode(': each keeps the levels of its own type (a mailbox reads, a secret is used, a connexion watches…). The two shortcuts just set or clear all at once; each row stays editable, and the right is stored per asset.'));
        detail.append(note);

        /* The assets in the group, each opens its own detail. */
        detail.append(chapter('Assets in the group'));
        const rowsBox = el('div', 'as-group-members');
        for (const m of members) rowsBox.append(assetRow(m, { chosen: '', choose: openAsset }));
        if (members.length === 0) rowsBox.append(el('p', 'hint', 'Open an asset and pick this group to put it here.'));
        detail.append(rowsBox);

        /* Rename, then remove (a plain link -- it only drops the grouping). */
        detail.append(chapter('Name'));
        const form = el('form', 'as-group-rename'); form.autocomplete = 'off';
        const name = el('input'); name.value = group.label; name.maxLength = 40; name.setAttribute('aria-label', 'Group name');
        const go = el('button', 'btn', 'Rename'); go.type = 'submit';
        form.append(name, go);
        form.addEventListener('submit', async (event) => {
            event.preventDefault(); $('assets-error').hidden = true;
            try { await post(`${API}/asset-groups/${group.id}/rename`, { label: name.value.trim() }); } catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
            repaint();
        });
        detail.append(form);
        const remove = el('div', 'as-group-remove');
        const del = el('button', 'as-remove-link', 'Remove the group'); del.type = 'button';
        del.addEventListener('click', async () => {
            $('assets-error').hidden = true;
            try { await post(`${API}/asset-groups/${group.id}/remove`, {}); groupGiveShow.clear(); assetOpen = ''; remember(); } catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
            repaint();
        });
        remove.append(del, el('p', 'hint', 'The assets stay; only the group is removed.'));
        detail.append(remove);
    }
    /* The top of a detail: "All assets" (a phone), the icon, the name, a badge. */
    function asTitle(item, back) {
        const top = el('div', 'as-title');
        const all = el('button', 'as-link as-back', '‹ Assets'); all.type = 'button'; all.addEventListener('click', () => { if (!nav.close('asset')) back(); });
        const h = el('h2'); h.append(kindIcon(item.kind), el('span', '', item.name));
        if (item.badge) h.append(el('span', `as-badge${item.badgeTone ? ` ${item.badgeTone}` : ''}`, item.badgeLong ?? item.badge));
        top.append(all, h);
        return top;
    }
    const chapter = (title, ...extra) => { const head = el('div', 'as-chapter'); head.append(el('h3', '', title), ...extra); return head; };
    const boxSub = (box) => (!box ? 'mailbox' : box.failure ? box.failure : `${box.messages} message${box.messages === 1 ? '' : 's'}`);
    const gitSub = (r) => (r.from ? `from ${hostOf(r.from)}` : 'repository');
    /* A secret's expiry, as said: `due` when it asks for the person (near, or past). */
    const secretState = (s) => {
        /* Short-lived, lifted from a message (secrets.mjs): minutes, not days -- shown so it can be seen and let go. */
        if (s.ephemeral) { const mins = Math.max(0, Math.round((s.expiresInMs ?? 0) / 60_000)); return s.expired || mins <= 0 ? { text: 'Expired', tone: 'bad', due: true } : { text: `Short-lived, ${mins} min left`, tone: 'warn', due: true }; }
        if (s.expired) return { text: 'Expired', tone: 'bad', due: true };
        if (s.days === null || s.days === undefined) return { text: 'No expiry', tone: '', due: false };
        if (secretDue(s)) return { text: s.days === 1 ? 'Expires tomorrow' : `Expires in ${s.days} days`, tone: 'warn', due: true };
        return { text: `Expires ${s.expires}`, tone: 'ok', due: false };
    };
    const secretItem = (s, sub) => { const st = secretState(s); return st.due ? { sub: st.text, dot: st.tone, tone: st.tone === 'bad' ? 'bad' : '' } : { sub }; };
    /* Its line on a sheet: the state and the day. */
    const secretLine = (s, expiredWords) => {
        const st = secretState(s);
        const line = el('p', 'status-line secret-expiry-state', st.tone === 'bad' ? `Expired · ${expiredWords}` : st.due ? `${st.text} · ${s.expires}` : st.text);
        if (st.tone) line.dataset.tone = st.tone;
        return line;
    };

    /* A repository, on the right: its branch, what would go, the diagram. */
    async function gitDetail(holder, name, { place = false, others = false } = {}) {
        const facts = el('div', 'as-facts'); facts.append(el('p', 'hint busy', 'Looking at its branches...'));
        const acts = el('div', 'as-acts');
        const review = el('button', '', 'Open the review'); review.type = 'button'; review.dataset.act = 'review';
        const send = el('button', 'primary', 'Send...'); send.type = 'button'; send.dataset.act = 'send'; send.hidden = true;
        acts.append(review, send);
        /* In a conversation, its files too, below. */
        if (!place) { const files = el('button', '', 'Files'); files.type = 'button'; files.dataset.act = 'files'; files.addEventListener('click', () => { embedFiles(holder, name); files.disabled = true; }); acts.prepend(files); }
        const diagram = el('div', 'as-graph'); diagram.append(el('p', 'hint busy', 'Drawing the branches...'));
        holder.append(facts, chapter('Branches', acts), diagram);
        const back = place ? { label: name, go: () => { void paintAssets(); } } : { label: name, go: () => { void paintRoomAssets(); } };
        review.addEventListener('click', () => { void openGit(name, { back }); });
        const [out, graph, keep] = await Promise.all([getJson(`/git/${name}/outgoing`, null), getJson(`/git/${name}/graph`, null), getJson(`/git/${name}/keep`, null)]);
        facts.replaceChildren();
        if (out) {
            const line = el('p', 'as-line');
            if (out.branch) { line.append('Its agent works on '); line.append(el('b', '', out.branch)); if (out.target) { line.append('; you send to '); line.append(el('b', '', out.target)); } line.append('.'); }
            else line.textContent = out.message ?? '';
            const cards = el('div', 'as-cards');
            const card = (label, value, tone) => { const c = el('div', 'as-card'); c.append(el('small', '', label), el('b', tone ?? '', value)); return c; };
            const n = out.count;
            cards.append(card('To send', out.state === 'ahead' ? (n === null ? 'some commits' : `${n} commit${n === 1 ? '' : 's'}`) : out.state === 'up-to-date' ? 'nothing' : '-', out.state === 'ahead' ? 'warn' : 'ok'),
                card('State', { ahead: 'ahead', 'up-to-date': 'up to date', diverged: 'behind: pull first', 'no-remote': 'no remote', unreachable: 'remote not answering', empty: 'empty' }[out.state] ?? out.state, out.state === 'diverged' || out.state === 'unreachable' ? 'bad' : ''),
                card('Remote', out.remote ? hostOf(out.remote) : 'none'));
            facts.append(line, cards);
            const last = lastFor(keep?.last, out);
            if (last) facts.append(lastChecksCard(name, { ...last, outdated: moved(last, out) }, back));
            if (out.state === 'ahead' && out.target) { send.hidden = false; send.textContent = `Send to ${out.target}...`; send.addEventListener('click', () => { if (others) pickRoomAsset('send:all'); else void openGit(name, { back, target: out.target, branch: out.branch ?? '' }); }); }
        }
        diagram.replaceChildren(graph ? window.clavariumGraph.draw(graph, { pick: (c) => { void openGit(name, { commit: c.id, back }); } }) : el('p', 'hint', 'The branches could not be read.'));
    }
    /* THE LAST CHECKS of a repository (gitkeeper.mjs keeps them): those for the
       branch and target shown, else the newest. Their output is text, always. */
    const CHECK_WORDS = { passed: ['Passed', 'ok'], failed: ['Failed', 'bad'], none: ['Nothing to check', ''], unavailable: ['Could not run', 'warn'] };
    function lastFor(list, out) {
        if (!Array.isArray(list) || list.length === 0) return null;
        return list.find((x) => x.target === out?.target && x.branch === out?.branch) ?? list.find((x) => x.target === out?.target) ?? list[0];
    }
    /* Outdated: the branch they ran on has another tip now, as the server last read it or as just seen. */
    const moved = (last, out) => {
        const tip = (out?.agentBranches ?? []).find((x) => x.name === last.branch)?.id;
        return Boolean(last.outdated || (tip && last.head && tip !== last.head));
    };
    function lastChecksCard(name, last, back) {
        const box = el('div', 'as-lastchecks'); box.dataset.status = String(last.status ?? '');
        const head = el('div', 'as-lastchecks-head');
        const [word, tone] = CHECK_WORDS[last.status] ?? [String(last.status ?? ''), ''];
        head.append(el('small', '', 'Last checks'), el('span', `as-badge check${tone ? ` ${tone}` : ''}`, word));
        if (last.outdated) { const old = el('span', 'as-badge outdated', 'outdated'); old.title = `${last.branch ?? 'The branch'} has moved since they ran.`; head.append(old); }
        const shortId = typeof last.head === 'string' ? last.head.slice(0, 7) : '';
        const line = el('p', 'as-line', `${shortId ? `on ${shortId}` : 'on no commit'} \u00b7 ${last.at ? sinceWords(last.at) : ''}${last.target ? ` \u00b7 to ${last.target}` : ''}`);
        if (last.at) line.title = when(last.at);
        const acts = el('div', 'as-acts');
        const again = el('button', '', 'Run again'); again.type = 'button'; again.dataset.act = 'checks-again';
        const see = el('button', 'as-link', 'See the output'); see.type = 'button'; see.dataset.act = 'checks-output';
        see.addEventListener('click', () => { void openGit(name, { back, target: last.target ?? '', branch: last.branch ?? '', tab: 'checks' }); });
        again.addEventListener('click', async () => {
            again.disabled = true; again.textContent = 'Running...';
            let result;
            try { result = await post(`${API}/git/${name}/check`, { again: true, target: last.target ?? '', branch: last.branch ?? '' }); }
            catch (error) { result = { ...last, status: 'unavailable', output: error.message, at: new Date().toISOString(), outdated: false }; }
            box.replaceWith(lastChecksCard(name, { ...result, outdated: false }, back));
        });
        acts.append(again, see);
        box.append(head, line, acts);
        return box;
    }
    /* TO SEND: every repository of a conversation on one screen. What its
       agent committed, read branch by branch and said as it goes; filtered
       (by default, the branches the remote has and that can be brought up to
       date) and ticked; the checks of what is ticked on a click; one review
       of them all; one button sends them one after the other, each by the same route as its own review (the same commit,
       the same target, the same guards). One refused does not hold the
       others back: each says what became of it. */
    const STATE_SAID = { unknown: 'changed: reading…', 'up-to-date': 'up to date', diverged: 'behind: its agent must pull first', 'no-remote': 'no remote', unreachable: 'remote not answering', empty: 'empty' };
    /* How many repositories are brought up to date with their remote at once, in the background. */
    const TS_PARALLEL = 3;
    /* `work(item)` for each, `n` at a time. */
    const inTurns = async (items, n, work) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await work(items[i++]); })); };
    /* When a known row was true: the time today, else the day. */
    const asOfText = (at) => { const d = new Date(at); if (!at || Number.isNaN(d.getTime())) return 'not read yet'; return `as of ${d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()}`; };
    /* What a row is, for the filter: a branch the remote has and that is ahead of it, a branch it does not have, nothing to send. */
    const kindOfRow = (out) => (out?.state !== 'ahead' ? 'none' : out.targetExists === false ? 'new' : 'update');
    /* A branch that could not be read is not "nothing to send": it stays listed, under every filter, with why. */
    const unread = (out) => out?.state === 'error' || out?.state === 'unreachable';
    const TS_FILTERS = [['update', 'To update'], ['new', 'New branches'], ['all', 'All']];
    /* Three steps: every branch read (said as it goes, nothing checked yet); filtered and ticked; the checks of what is
       ticked, on a click; then Send. */
    async function sendDetail(holder, names) {
        const progress = el('p', 'status-line ts-progress'); progress.setAttribute('role', 'status');
        const meter = el('div', 'ts-meter'); const meterFill = el('i'); meter.append(meterFill); meter.setAttribute('aria-hidden', 'true');
        const filters = el('div', 'levels ts-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Show');
        const list = el('div', 'ts-rows');
        const bar = el('div', 'action-row ts-bar');
        const together = el('button', '', 'Review together'); together.type = 'button'; together.dataset.act = 'send-review';
        const go = el('button', 'primary', 'Check'); go.type = 'button'; go.dataset.act = 'send-all';
        const why = el('span', 'hint ts-why'); why.setAttribute('role', 'status');
        bar.append(why, together, go);
        const said = el('p', 'ts-said'); said.hidden = true; said.setAttribute('role', 'status');
        const review = el('div', 'ts-review'); review.hidden = true;
        holder.append(progress, meter, said, filters, list, bar, review);
        const rows = [];
        let filter = 'update';
        let sending = false; let checking = false;
        let sure = '';
        let reposDone = 0; let reading = true; const notLookedBy = new Map();
        /* Known rows not read yet, or whose branch moved since, stay in sight until their read says. */
        const shownRow = (r) => filter === 'all' || kindOfRow(r.out) === filter || unread(r.out) || (r.known && (!r.out || r.out.state === 'unknown'));
        const picked = () => rows.filter((r) => r.picked && !r.known && r.out?.state === 'ahead' && shownRow(r));
        const label = (r) => (rows.filter((x) => x.name === r.name).length > 1 ? `${r.name} (${r.branch})` : r.name);
        async function look(r) {
            const query = new URLSearchParams();
            if (r.branch) query.set('branch', r.branch);
            if (r.target) query.set('target', r.target);
            const [out, keep] = await Promise.all([readOrSay(`/git/${r.name}/outgoing${query.size ? `?${query}` : ''}`), r.keep ? r.keep : getJson(`/git/${r.name}/keep`, null)]);
            apply(r, out, keep);
        }
        /* A row's fresh review: what the server knows of its checks comes with it. */
        function apply(r, out, keep) {
            r.out = out; r.keep = keep; r.known = false; r.branch = out.branch ?? r.branch; r.target = out.target ?? r.target; r.check = null;
            /* What the server knows of this very commit and target: a check still running is followed again; the last
               one that ran is shown with its age (left and come back, even the next day: nothing run again for nothing). */
            if (out.state === 'ahead' && out.head) {
                const going = (keep?.running ?? []).find((x) => x.head === out.head && x.target === out.target);
                const ran = (keep?.last ?? []).find((x) => x.head === out.head && x.target === out.target && x.status !== 'unavailable');
                if (going) setTimeout(() => { void checkRow(r, { since: Date.parse(going.since) || Date.now(), resume: true }); }, 0);
                else if (ran) r.check = { ...ran, earlier: true };
            }
            if (out.state !== 'ahead') r.picked = false;
        }
        /* The server keeps the run: a request hears "running" after a while, and asks again until it ends. */
        async function checkRow(r, { since = Date.now(), resume = false } = {}) {
            const { head, target } = r.out;
            r.check = { status: 'running', since }; r.open = false; paint();
            /* While it runs, its line moves every second: how long so far, and about how long the last one took. */
            const ticking = setInterval(() => { if (r.check?.status === 'running') paint(); }, 1000);
            let result;
            for (let first = true; ; first = false) {
                try { result = await post(`${API}/git/${r.name}/check`, { head, target, ...(first && !resume ? {} : { join: true }) }); }
                catch (error) { result = { status: 'unavailable', output: `The page could not reach the server: ${error.message}` }; }
                if (result?.status !== 'running' || r.out?.head !== head || r.out?.target !== target) break;
            }
            clearInterval(ticking);
            if (r.out?.head !== head || r.out?.target !== target) return;
            r.check = result; paint();
        }
        const checkedAgo = (at) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
        /* What its agent is told when checks did not pass: where, and the end of what they said. */
        const forAgent = (r) => `The checks of ${r.name} (${r.out.branch} → ${r.out.target}) did not pass before sending. Please fix it, commit, and tell me.\n\n\`\`\`\n${String(r.check?.output ?? '').slice(-3000)}\n\`\`\``;
        const stopped = (r) => Boolean(r.keep?.settings?.requireForSend) && r.check?.status !== 'passed';
        function paintProgress() {
            const count = (k) => rows.filter((r) => kindOfRow(r.out) === k).length;
            /* By repositories: how many there are is known from the start, how many branches each has is not. */
            meter.hidden = !reading; meterFill.style.width = `${names.length ? Math.round((reposDone / names.length) * 100) : 100}%`;
            progress.toggleAttribute('data-busy', reading);
            if (reading) { progress.dataset.tone = 'warn'; progress.textContent = `Checking with the remotes: ${reposDone} of ${names.length}`; }
            else {
                const failed = rows.filter((r) => unread(r.out)).length;
                const notLooked = [...notLookedBy.values()].reduce((n, x) => n + x, 0);
                const tail = `${failed ? ` · ${failed} not read` : ' · all read'}${notLooked ? ` · ${notLooked} older branch${notLooked === 1 ? '' : 'es'} not looked at` : ''}`;
                progress.dataset.tone = failed ? 'warn' : count('update') + count('new') ? 'ok' : '';
                progress.textContent = count('update') + count('new') ? `${count('update')} to update · ${count('new')} new${tail}` : `Nothing to send${tail}`;
            }
            filters.replaceChildren(...TS_FILTERS.map(([key, word]) => {
                const n = key === 'all' ? rows.length : count(key);
                const b = el('button', '', `${word} ${n}`); b.type = 'button'; b.dataset.filter = key; b.setAttribute('aria-pressed', String(filter === key));
                b.addEventListener('click', () => { filter = key; sure = ''; paint(); if (!review.hidden) paintReview(); });
                return b;
            }));
        }
        function paintButtons() {
            const p = picked();
            const unchecked = p.filter((r) => !r.check);
            const running = p.filter((r) => r.check?.status === 'running');
            const held = p.filter((r) => r.check && r.check.status !== 'running' && stopped(r));
            const failed = p.filter((r) => r.check?.status === 'failed' || r.check?.status === 'unavailable');
            const word = p.length > 1 ? `the ${p.length}` : 'it';
            const targets = [...new Set(p.map((r) => r.target))];
            const where = targets.length === 1 ? ` to ${targets[0]}` : '';
            together.disabled = p.length === 0;
            together.textContent = p.length > 1 ? `Review the ${p.length} together` : 'Review';
            go.disabled = sending || checking || p.length === 0 || running.length > 0 || (!unchecked.length && held.length > 0);
            why.textContent = p.length === 0 ? 'Nothing ticked.' : running.length ? 'Checking...' : unchecked.length ? '' : held.length ? `Passing checks are required: ${held.map(label).join(', ')}.` : failed.length ? `Checks did not pass: ${failed.map(label).join(', ')}.` : '';
            /* Once something went and nothing is left ticked, no button that would seem to say nothing went. */
            go.hidden = !sending && p.length === 0 && rows.some((r) => r.sent?.ok);
            if (sending) { go.textContent = 'Sending…'; return; }
            /* First the checks of what is ticked; then Send. */
            if (unchecked.length || running.length) { go.dataset.step = 'check'; go.textContent = `Check ${word}`; return; }
            go.dataset.step = 'send';
            const all = p.some((r) => r.out?.guards?.confirm);
            go.textContent = sure === 'yes' ? (all ? `Not all of it could be shown here: send ${word}${where} anyway` : `Yes, send ${word}${where}: this cannot be undone`) : sure === 'all' ? `Yes, send ${word}${where}: this cannot be undone` : `Send ${word}${where}${failed.length ? ' anyway' : ''}`;
        }
        function paint() {
            paintProgress();
            list.replaceChildren();
            for (const r of rows) {
                if (!shownRow(r)) continue;
                const row = el('div', 'ts-row'); row.dataset.repo = r.name; if (r.branch) row.dataset.branch = r.branch;
                const out = r.out;
                const ahead = out?.state === 'ahead';
                row.classList.toggle('off', !ahead);
                const tick = el('input'); tick.type = 'checkbox'; tick.checked = r.picked; tick.disabled = !ahead || r.known || sending || checking; tick.setAttribute('aria-label', `Send ${label(r)}`);
                tick.addEventListener('change', () => { r.picked = tick.checked; sure = ''; paint(); if (!review.hidden) paintReview(); });
                const who = el('div', 'ts-who'); who.append(el('b', '', r.name), el('small', 'hint', `${out?.remote ? hostOf(out.remote) : out ? 'no remote' : ''}${r.known ? ` · ${asOfText(r.asOf)}` : ''}`));
                const way = el('div', 'ts-way');
                /* Its own name even when it could not be read: which branch is missing is said. */
                const named = out?.branch ?? (unread(out) ? r.branch : '');
                if (named) {
                    const code = el('code', 'ts-branch', named); code.title = named; way.append(code);
                    /* Known only: where it goes is said; it is chosen once the row is read. */
                    if (r.known && out.target) way.append(el('span', 'ts-arrow', '→'), el('code', 'ts-branch', out.target));
                    else if (['ahead', 'up-to-date', 'diverged'].includes(out.state) && out.target) {
                        way.append(el('span', 'ts-arrow', '→'));
                        const to = el('select'); to.setAttribute('aria-label', `Where ${label(r)} goes`); to.disabled = sending || checking;
                        const names2 = [...(out.branches ?? [])]; if (!names2.includes(out.target)) names2.unshift(out.target);
                        for (const b of names2) { const o = el('option', '', b === out.target && !out.targetExists ? `${b} (new branch)` : b); o.value = b; to.append(o); }
                        to.value = out.target;
                        to.addEventListener('change', async () => { r.target = to.value; sure = ''; await look(r); paint(); });
                        way.append(to);
                    }
                }
                const size = el('div', 'ts-size');
                if (!out) size.append(el('span', 'hint busy', 'Reading...'));
                else if (ahead && r.known) size.append(el('span', '', out.targetExists === false ? 'new branch' : out.count === null || out.count === undefined ? 'some commits' : `${out.count} commit${out.count === 1 ? '' : 's'}`));
                else if (ahead) {
                    const files = diffFiles(out.diff);
                    /* A branch the remote does not have: "new", not a count against a branch that is not there. */
                    const what = out.targetExists === false ? 'new branch' : out.count === null || out.count === undefined ? 'some commits' : `${out.count} commit${out.count === 1 ? '' : 's'}`;
                    size.append(el('span', '', what), el('br'), el('span', 'plus', `+${files.reduce((n, f) => n + f.added, 0)}`), ' ', el('span', 'minus', `−${files.reduce((n, f) => n + f.removed, 0)}`));
                } else size.append(el('span', 'hint', out.state === 'up-to-date' ? 'nothing' : '-'));
                const state = el('div', 'ts-state');
                if (r.sending) { const s2 = el('span', 'ts-running'); s2.append(el('span', 'warn', 'Sending…')); state.append(s2); }
                else if (r.sent) state.append(el('b', r.sent.ok ? 'ok' : 'bad', r.sent.ok ? r.sent.text : '✗ Not sent'));
                else if (!out) state.append('');
                else if (r.known && out.state !== 'unknown') state.append(el('span', 'hint busy', ahead ? 'checking…' : `${STATE_SAID[out.state] ?? out.state} · checking…`));
                else if (!ahead) state.append(el('span', out.state === 'diverged' || out.state === 'unreachable' || out.state === 'error' ? 'bad' : 'hint', STATE_SAID[out.state] ?? out.message ?? out.state));
                else if (!r.check) state.append(el('span', 'hint', r.picked ? 'to check' : ''));
                else if (r.check.status === 'running') {
                    const took = (r.keep?.last ?? []).find((x) => x.target === r.out.target && Number.isFinite(x.ms))?.ms ?? (r.keep?.last ?? []).find((x) => Number.isFinite(x.ms))?.ms;
                    const so = Date.now() - (r.check.since ?? Date.now());
                    const clock = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
                    const box = el('span', 'ts-running');
                    box.append(el('span', 'warn', `Checking ${clock(so)}`), el('small', 'hint', took ? `last time ${clock(took)}` : 'may take minutes'));
                    const bar = el('span', 'ts-meter ts-meter-row'); const fill = el('i'); bar.append(fill);
                    /* Measured against the last run: never full until it ends; without one, a slow sweep. */
                    fill.style.width = took ? `${Math.min(95, Math.round((so / took) * 100))}%` : '';
                    if (!took) bar.classList.add('ts-sweep');
                    box.append(bar);
                    state.append(box);
                }
                else {
                    const [word, tone] = CHECK_WORDS[r.check.status] ?? [String(r.check.status), ''];
                    const age = r.check.earlier && r.check.at ? ` · ${checkedAgo(r.check.at)}` : '';
                    const text = `${r.check.status === 'passed' ? '✓ Checks passed' : r.check.status === 'failed' ? '✗ Checks failed' : word}${age}`;
                    /* What did not pass says why, one tap away: the reason, what they printed, and what to do. */
                    if (r.check.status === 'failed' || r.check.status === 'unavailable') {
                        const open = el('button', `ts-why-open ${tone}`, `${text} ${r.open ? '▴' : '▾'}`); open.type = 'button'; open.setAttribute('aria-expanded', String(Boolean(r.open)));
                        open.addEventListener('click', () => { r.open = !r.open; paint(); });
                        state.append(open);
                    } else state.append(el('b', tone || 'quiet', text));
                }
                row.append(tick, who, way, size, state);
                if (!r.seen) { r.seen = true; if (reading) row.classList.add('ts-new'); }
                if (r.open && r.check && !r.sent) {
                    const lines = String(r.check.output ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
                    const box = el('div', 'ts-why-box');
                    box.append(el('p', '', lines[0] ?? 'Nothing was said.'));
                    if (lines.length > 1) box.append(el('pre', 'ts-output', String(r.check.output).slice(-4000)));
                    const acts = el('div', 'action-row');
                    const again = el('button', '', 'Check again'); again.type = 'button'; again.dataset.act = 'check-again';
                    again.disabled = checking || sending;
                    again.addEventListener('click', async () => { checking = true; await checkRow(r); checking = false; paint(); });
                    const tell = el('button', '', talk.on && talkOf === current ? 'Ask its agent to fix it' : 'Copy for its agent'); tell.type = 'button'; tell.dataset.act = 'tell-agent';
                    tell.addEventListener('click', async () => {
                        try {
                            if (talk.on && talkOf === current) { await post(talkPath(current), { text: forAgent(r) }); tell.textContent = '✓ Sent to its chat'; }
                            else { await navigator.clipboard.writeText(forAgent(r)); tell.textContent = '✓ Copied'; }
                            tell.disabled = true;
                        } catch (error) { tell.textContent = `Not done: ${error.message}`; }
                    });
                    acts.append(again, tell); box.append(acts);
                    row.append(box);
                }
                if (r.sent && !r.sent.ok) row.append(el('p', 'ts-note bad', r.sent.text));
                list.append(row);
            }
            if (!reading && rows.length === 0) list.append(el('p', 'hint', 'No repository is given to it.'));
            else if (!reading && !rows.some(shownRow)) list.append(el('p', 'hint', filter === 'update' ? 'No branch of the remote to update.' : 'None.'));
            paintButtons();
        }
        /* ONE REVIEW of them all: the files of each under its name, then each one's changes, commits and checks. */
        let tab = 'changes';
        function paintReview() {
            review.replaceChildren();
            const p = picked();
            if (p.length === 0) { review.hidden = true; return; }
            const all = p.map((r) => ({ r, files: diffFiles(r.out.diff) }));
            const nFiles = all.reduce((n, x) => n + x.files.length, 0);
            const added = all.reduce((n, x) => n + x.files.reduce((m, f) => m + f.added, 0), 0);
            const removed = all.reduce((n, x) => n + x.files.reduce((m, f) => m + f.removed, 0), 0);
            const commits = p.reduce((n, r) => n + (r.out.count ?? r.out.commits.length), 0);
            const head = el('div', 'ts-review-head');
            head.append(el('h3', '', `${p.length} branch${p.length === 1 ? '' : 'es'}`), el('p', 'as-line', `${commits} commit${commits === 1 ? '' : 's'} · ${nFiles} file${nFiles === 1 ? '' : 's'} · `));
            head.lastChild.append(el('span', 'plus', `+${added}`), ' ', el('span', 'minus', `−${removed}`));
            const tabs = el('div', 'rv-tabs ts-tabs'); tabs.setAttribute('role', 'tablist');
            const passed = p.filter((r) => r.check?.status === 'passed').length;
            for (const [key, word] of [['changes', `Changes ${nFiles}`], ['commits', `Commits ${commits}`], ['checks', `Checks ${passed}/${p.length}`]]) {
                const b = el('button', '', word); b.type = 'button'; b.dataset.tab = key; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(key === tab));
                b.addEventListener('click', () => { tab = key; paintReview(); });
                tabs.append(b);
            }
            const body = el('div', 'ts-review-body');
            review.append(head, tabs, body);
            if (tab === 'changes') {
                const tree = el('div', 'rv-tree ts-tree'); const diffs = el('div', 'rv-diff ts-diffs');
                for (const { r, files } of all) {
                    /* Each repository its own group: a header that says which, where to, how much; its files under it, folding with it. */
                    const group = el('section', 'ts-tree-group');
                    const head = el('button', 'ts-tree-repo'); head.type = 'button'; head.setAttribute('aria-expanded', 'true');
                    head.append(el('b', '', label(r)), el('code', '', `${r.out.branch} → ${r.out.target}`),
                        el('small', 'hint', `${files.length} file${files.length === 1 ? '' : 's'}`), el('small', 'plus', `+${files.reduce((n, f) => n + f.added, 0)}`), el('small', 'minus', `−${files.reduce((n, f) => n + f.removed, 0)}`));
                    const list2 = el('div', 'ts-tree-files');
                    head.addEventListener('click', () => { const open = list2.hidden; list2.hidden = !open; head.setAttribute('aria-expanded', String(open)); });
                    group.append(head, list2); tree.append(group);
                    const box = el('div', 'ts-diff'); box.dataset.repo = r.name;
                    box.append(el('h4', '', `${r.name}: ${r.out.branch} → ${r.out.target}`));
                    const inner = el('div'); box.append(inner);
                    files.forEach((f, i) => {
                        const b = el('button'); b.type = 'button'; b.dataset.how = f.how;
                        b.append(el('span', 'rv-path', f.path), el('small', 'plus', `+${f.added}`), el('small', 'minus', `−${f.removed}`));
                        b.addEventListener('click', () => { inner.querySelectorAll('.d2h-file-wrapper')[i]?.scrollIntoView({ block: 'start' }); });
                        list2.append(b);
                    });
                    const Ui = window.Diff2HtmlUI;
                    if (!r.out.diff) inner.append(el('p', 'hint', 'No change to show.'));
                    else if (!Ui) inner.append(el('pre', '', r.out.diff));
                    else {
                        const ui = new Ui(inner, r.out.diff, { outputFormat: 'line-by-line', drawFileList: false, matching: 'lines', diffStyle: 'word', fileContentToggle: false, stickyFileHeaders: false, highlight: true, colorScheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' });
                        ui.draw();
                        try { ui.highlightCode(); } catch { /* the plain diff stays */ }
                    }
                    if (r.out.cut) inner.append(el('p', 'hint', '... (the rest is not shown here: too long)'));
                    diffs.append(box);
                }
                body.append(tree, diffs);
            } else if (tab === 'commits') {
                for (const r of p) {
                    body.append(el('h4', '', `${r.name}: ${r.out.branch} → ${r.out.target}`));
                    for (const c of r.out.commits) body.append(commitRow(c));
                    if ((r.out.count ?? 0) > r.out.commits.length) body.append(el('p', 'hint', `Only the last ${r.out.commits.length} of ${r.out.count} are listed.`));
                }
            } else {
                for (const r of p) {
                    const [word] = CHECK_WORDS[r.check?.status] ?? [r.check?.status === 'running' ? 'Running...' : 'Not run yet'];
                    body.append(el('h4', '', `${label(r)}: ${word}`));
                    if (r.check?.output) body.append(el('pre', 'ts-output', r.check.output));
                }
            }
        }
        let reviewStep = null;
        together.addEventListener('click', () => {
            if (!review.hidden) { review.scrollIntoView({ block: 'start' }); return; }
            review.hidden = false; tab = 'changes'; paintReview();
            reviewStep = nav.over('send-review', () => { review.hidden = true; reviewStep = null; });
            review.scrollIntoView({ block: 'start' });
        });
        go.addEventListener('click', async () => {
            const p = picked();
            if (p.length === 0 || go.disabled) return;
            /* The checks first, of what is ticked only, one after the other: each takes the machine of its agent. */
            if (go.dataset.step === 'check') {
                checking = true; paint();
                for (const r of p.filter((x) => !x.check)) await checkRow(r);
                checking = false; paint();
                if (!review.hidden) paintReview();
                return;
            }
            /* Two clicks: what leaves cannot be called back. Three when a review could not show it all. */
            const all = p.some((r) => r.out?.guards?.confirm);
            if (!sure) { sure = 'yes'; paintButtons(); return; }
            if (all && sure === 'yes') { sure = 'all'; paintButtons(); return; }
            sending = true; sure = ''; said.hidden = true;
            for (const r of rows) r.sent = null;
            paint();
            for (const r of p) {
                r.sending = true; paint();
                try {
                    /* The push runs in the background: the first request starts it, and
                       while it says "sending" the page asks again (join) until it ends --
                       a long push never looks like a failure or a restart. */
                    let sent;
                    for (let first = true; ; first = false) {
                        sent = await post(`${API}/git/${r.name}/push`, first
                            ? { head: r.out.head, target: r.out.target, ...(r.out.guards?.confirm ? { sure: true } : {}) }
                            : { head: r.out.head, target: r.out.target, join: true });
                        if (sent?.status !== 'sending') break;
                    }
                    r.sent = { ok: true, text: sent.already ? `✓ Already in ${sent.branch}` : sent.commits > 0 ? `✓ Sent to ${sent.branch}` : `✓ Made ${sent.branch}` };
                } catch (error) { r.sent = { ok: false, text: /^Not sent/.test(error.message) ? error.message : `Not sent: ${error.message}` }; }
                r.sending = false; paint();
            }
            sending = false; paint();
            const ok = p.filter((r) => r.sent?.ok).length;
            said.textContent = ok === p.length ? `Sent: ${ok === 1 ? 'it went' : `all ${ok} went`}.` : `${ok} of ${p.length} sent; the others say why.`;
            said.className = `status-line ts-said ${ok === p.length ? 'ok' : 'bad'}`; said.dataset.tone = ok === p.length ? 'ok' : 'bad'; said.hidden = false;
            if (reviewStep) nav.drop(reviewStep);
            /* What is left to send, read again; what became of each stays said. */
            await inTurns([...new Set(p.map((r) => r.name))], TS_PARALLEL, (name) => readRepo(name));
            /* What went is unticked: nothing is offered again for what is done. */
            for (const r of rows) if (r.sent?.ok) r.picked = false;
            paint();
            said.scrollIntoView({ block: 'nearest' });
        });
        /* ONE REPOSITORY READ AFRESH (one fetch, one read, its branches that moved last reviewed): its rows replaced
           where they were, each keeping what was said or ticked of the same commit. A branch with nothing to send is
           listed only when it is the one that moved last (or what became of its sending is said); one that could not be
           read always, with why. */
        async function readRepo(name) {
            const [all, keep] = await Promise.all([readOrSay(`/git/${name}/outgoing-all`), getJson(`/git/${name}/keep`, null)]);
            const before = rows.filter((x) => x.name === name);
            const at = rows.findIndex((x) => x.name === name);
            let fresh;
            if (Array.isArray(all.rows) && all.rows.length) {
                fresh = all.rows.filter((out, i) => i === 0 || out.state === 'ahead' || unread(out) || before.some((x) => x.branch === out.branch && x.sent)).map((out) => {
                    const was = before.find((x) => x.branch === out.branch);
                    const r = { name, out: null, keep, branch: out.branch, target: '', picked: false, check: null, sent: was?.sent ?? null, movedAt: (all.agentBranches ?? []).find((b) => b.name === out.branch)?.movedAt ?? null };
                    apply(r, out, keep);
                    /* Ticked by one rule for every row: a branch of the remote to update is ticked; a new one is not. */
                    r.picked = was && !was.known && was.out?.head === out.head ? was.picked && out.state === 'ahead' : kindOfRow(out) === 'update';
                    if (was?.check && was.out?.head === out.head && !r.check) r.check = was.check;
                    return r;
                });
                notLookedBy.set(name, all.more ?? 0);
            } else {
                /* Not read (the remote did not answer, the read failed) or nothing in it: each known branch says so. */
                const out = { state: all.state ?? 'error', message: all.message, remote: all.remote ?? before[0]?.out?.remote ?? null };
                const known = before.filter((x) => x.branch);
                fresh = (known.length && unread(out) ? known : [{ name, branch: '' }]).map((x) => ({ name, out: { ...out, branch: x.branch || null }, keep, branch: x.branch, target: '', picked: false, check: null, sent: x.sent ?? null, known: false }));
            }
            rows.splice(at < 0 ? rows.length : at, before.length, ...fresh);
            paint();
        }
        /* AT ONCE: what is known here (the agent's branches as last read, the remote's as last fetched, the last review
           of each), no remote asked, no repository read; each row says as of when. Not sendable as it is. */
        paint();
        const known = await Promise.all(names.map(async (name) => [name, await getJson(`/git/${name}/known`, null)]));
        for (const [name, k] of known) {
            const list = k?.rows ?? [];
            if (list.length === 0) rows.push({ name, out: null, keep: null, branch: '', target: '', picked: false, check: null, sent: null, known: true });
            for (const x of list) {
                const out = { state: x.state, branch: x.branch, target: x.target, targetExists: x.targetExists, count: x.count, head: x.head, remote: k.remote, branches: k.branches };
                /* As the full read lists them: the one that moved last, then those with something to send. */
                if (x !== list[0] && x.state !== 'ahead' && x.state !== 'unknown') continue;
                rows.push({ name, out, keep: null, branch: x.branch, target: x.target, picked: false, check: null, sent: null, movedAt: x.movedAt, known: true, asOf: x.state === 'unknown' ? k.readAt : (k.fetchedAt ?? x.lookedAt) });
            }
        }
        paint();
        /* THEN, IN THE BACKGROUND: each repository brought up to date with its remote and read, a few at a time; its rows replaced as it comes. */
        await inTurns(names, TS_PARALLEL, async (name) => {
            try { await readRepo(name); } catch { /* said by its rows */ }
            reposDone++; paint();
        });
        reading = false;
        paint();
    }
    /* The files of a folder or a mailbox, in a conversation: the Files sheet, moved into the detail. */
    let filesHome = null;
    function embedFiles(holder, name) {
        const f = $('files');
        if (!filesHome) filesHome = { parent: f.parentNode, next: f.nextSibling };
        holder.append(f); f.classList.add('embedded');
        if (filesOf !== name) { filesOf = name; filesAt = ''; }
        f.hidden = false;
        void paintFiles();
    }
    function unembedFiles() {
        const f = $('files');
        if (!f.classList.contains('embedded') || !filesHome) return;
        f.classList.remove('embedded'); f.hidden = true;
        filesHome.parent.insertBefore(f, filesHome.next);
    }

    /* Nothing is opened by itself: the wide detail says what it is for. */
    const noAssetChosen = () => el('p', 'hint as-none', 'Select an asset to see its detail.');

    /* ---- a conversation's own ---- */
    async function paintRoomAssets() {
        if (!assetsShown) return;
        watchTether();
        const c = conversations.find((x) => x.name === current);
        roomSig = JSON.stringify([current, c?.resources, c?.secrets, c?.work]);
        const [all, secrets, boxes, tether] = await Promise.all([getJson('/resources', []), getJson('/secrets', []), getJson('/mailboxes', []), getJson('/tether', {})]);
        /* The calls this conversation's agent asked the owner to allow: validated here,
           in the parloir, without leaving for the Assets page. */
        const mineDemandes = (Array.isArray(tether.approvals) ? tether.approvals : []).filter((q) => (q.agent?.id ?? '') === `conversation:${current}`);
        /* Approved calls only this browser can do (a device to flash over USB): Tether's jobs. */
        const mineJobs = (Array.isArray(tether.jobs) ? tether.jobs : []).filter((j) => j.agent === `conversation:${current}`);
        const mine = new Map((c?.resources ?? []).map((r) => [r.name, r.access]));
        const items = [];
        if (c?.work === 'kept') items.push({ key: 'folder:work', kind: 'folder', name: 'work', own: true, sub: 'where its tool works', badge: 'write', badgeTone: 'write' });
        for (const r of all.filter((x) => mine.has(x.name))) {
            const kind = kindOf(r); const access = mine.get(r.name);
            const box = kind === 'mailbox' ? boxes.find((m) => m.name === r.name) : undefined;
            items.push({ key: `${kind}:${r.name}`, kind, name: r.name, resource: r, box, badge: access, badgeTone: access, badgeLong: access === 'write' ? 'read and write' : 'read only',
                sub: kind === 'git' ? gitSub(r) : kind === 'mailbox' ? boxSub(box) : 'folder', tone: box?.failure ? 'bad' : '' });
        }
        markSecrets(secrets);
        for (const s2 of secrets.filter((x) => x.conversations.includes(current))) items.push({ key: `secret:${s2.name}`, kind: 'secret', name: s2.name, secret: s2, ...secretItem(s2, 'name only · used by its agent') });
        /* TO SEND, above them all, once it has a repository: every one of them on one screen. */
        const gits = items.filter((i) => i.kind === 'git').map((i) => i.name);
        const outbox = gits.length ? { key: 'send:all', kind: 'send', name: 'To send', sub: 'every repository, reviewed and sent at once' } : null;
        const waitingCount = mineDemandes.length + mineJobs.length;
        const demandes = waitingCount ? { key: 'demandes:mine', kind: 'demandes', name: 'Demandes', sub: `${waitingCount} waiting for you` } : null;
        const chosen = (outbox && roomPick === outbox.key ? outbox : null) ?? (demandes && roomPick === demandes.key ? demandes : null) ?? items.find((i) => i.key === roomPick) ?? null;
        const as = $('cassets-as');
        as.dataset.open = chosen ? 'detail' : 'list';
        paintAsList($('cassets-rows'), items, { chosen: chosen?.key, choose: (key) => pickRoomAsset(key), empty: 'Nothing is given to it yet.' });
        const top = el('div', 'as-kind-head as-list-top'); top.append(el('h3', '', 'This conversation'), roundPlus(uiSaid('set-na-attach', 'Attach'), () => { void openAccess(true); }));
        const pinnedRow = (entry, extra) => {
            const row = el('button', `as-row ts-entry${extra ? ` ${extra}` : ''}`); row.type = 'button'; row.dataset.asset = entry.key;
            if (chosen === entry) row.setAttribute('aria-current', 'true');
            const words = el('span', 'as-words'); words.append(el('b', '', entry.name), el('small', 'as-sub', entry.sub));
            row.append(kindIcon('send'), words);
            if (entry.key === 'demandes:mine') row.append(el('b', 'count', String(waitingCount)));
            row.addEventListener('click', () => pickRoomAsset(entry.key));
            return row;
        };
        if (outbox) $('cassets-rows').prepend(pinnedRow(outbox));
        if (demandes) $('cassets-rows').prepend(pinnedRow(demandes, 'demande-entry'));
        $('cassets-rows').prepend(top);
        if (c?.work === 'disk') $('cassets-rows').append(el('p', 'hint as-disk', 'Its work is on the disk of its machine: nothing of it is kept here.'));
        const detail = $('cassets-detail');
        if (!chosen) { unembedFiles(); detail.replaceChildren(); if (items.length) detail.append(noAssetChosen()); return; }
        const keepFiles = (chosen.kind === 'folder' || chosen.kind === 'mailbox') && $('files').classList.contains('embedded') && detail.contains($('files')) && detail.dataset.asset === chosen.key;
        if (!keepFiles) { unembedFiles(); detail.replaceChildren(); }
        detail.dataset.asset = chosen.key;
        const back = () => { roomPick = ''; void paintRoomAssets(); };
        if (keepFiles) { void paintFiles(); return; }
        detail.append(asTitle(chosen, back));
        if (chosen.kind === 'demandes') {
            for (const j of mineJobs) detail.append(jobCard(j, () => paintRoomAssets()));
            if (mineDemandes.length) {
                detail.append(el('p', 'hint', 'Its agent asked you to allow these Tether calls. Accept, and it runs; refuse, and it is told so.'));
                detail.append(demandesList(mineDemandes, { withWho: false, after: () => paintRoomAssets() }));
            }
        } else if (chosen.kind === 'folder' || chosen.kind === 'mailbox') {
            if (chosen.kind === 'mailbox' && !chosen.target) detail.append(el('p', chosen.box?.failure ? 'error' : 'hint', boxSub(chosen.box)));
            embedFiles(detail, chosen.name);
        } else if (chosen.kind === 'send') await sendDetail(detail, gits);
        else if (chosen.kind === 'git') await gitDetail(detail, chosen.name, { others: gits.length > 1 });
        else {
            if (chosen.secret.expires) detail.append(secretLine(chosen.secret, 'not given to its tool'));
            detail.append(el('p', 'hint', 'Handed to its tool as a variable and a file, the next time it starts. Its value is never shown.'), chapter('Used by'));
            const list = el('div', 'as-chips');
            for (const who of chosen.secret.conversations) list.append(el('span', 'as-chip', shownName(conversations.find((x) => x.name === who)) || who));
            detail.append(list);
        }
    }
    /* One asset opened: a step (another one opened takes its place); Back, the list. */
    const assetStep = () => { if (nav.last(['asset']) < 0) nav.push('asset', ({ quiet }) => { roomPick = ''; if (!quiet && assetsShown) void paintRoomAssets(); }); };
    function pickRoomAsset(key) {
        const a = nav.last(['asset']);
        if (a >= 0) nav.cut(a + 1); else assetStep();
        roomPick = key; void paintRoomAssets();
    }
    /* A folder or a file of it, asked for from the terminal or the viewer: its folder, in the Assets tab, on that path. */
    function showInAssets(tab, inner) {
        const c = conversations.find((x) => x.name === current);
        const r = (c?.resources ?? []).find((x) => x.name === tab);
        filesOf = tab; filesAt = inner;
        goTab('assets', { pick: `${r ? kindOf(r) : 'folder'}:${tab}` });
        assetStep();
    }
    async function openRoomAssets(pick) {
        if (DEVICE || !current) return;
        $('copy').hidden = true;
        if (!$('files').classList.contains('embedded')) $('files').hidden = true;
        if (pick !== undefined) roomPick = pick;
        closeRoomLists();
        assetsShown = true; $('cassets').hidden = false; paintViews();
        await paintRoomAssets();
    }
    function closeRoomAssets() {
        if (!assetsShown) return;
        assetsShown = false; $('cassets').hidden = true; unembedFiles(); paintViews();
        if ($('cassets').contains($('gitview'))) shutGit();
    }

    /* REPLACE THE VALUE, without seeing it: a new one typed (never shown, the old one
       never sent here) and/or its expiry; its name and who has it stay. */
    let secretReplacing = ''; let secretSaid = null;
    function secretReplace(chosen) {
        const said = el(secretReplacing === chosen.name ? 'span' : 'p', 'hint secret-replace-said', secretSaid?.name === chosen.name ? secretSaid.text : ''); said.setAttribute('role', 'status');
        if (secretReplacing !== chosen.name) {
            const open = el('button', '', 'Replace the value...'); open.type = 'button'; open.id = 'secret-replace-open';
            open.addEventListener('click', () => { secretReplacing = chosen.name; secretSaid = null; void paintAssets(); });
            const what = el('div', 'set-what'); what.append(el('span', '', 'Value'), el('small', '', 'Never shown'));
            const control = el('div', 'set-control'); control.append(open);
            const row = el('div', 'set-row'); row.append(what, control);
            return { rows: said.textContent ? [row, said] : [row], card: [] };
        }
        const form = el('form', 'set-rows as-block secret-replace'); form.id = 'secret-replace'; form.autocomplete = 'off';
        const value = el('input'); value.id = 'secret-replace-value'; value.type = 'password'; value.autocomplete = 'new-password'; value.setAttribute('aria-label', 'New value');
        const lines = el('textarea', 'secret-lines'); lines.id = 'secret-replace-lines'; lines.rows = 5; lines.spellcheck = false; lines.hidden = true; lines.setAttribute('aria-label', 'New value, several lines');
        /* A key pasted: its lines kept, in a box of several lines, masked too. */
        value.addEventListener('paste', (event) => {
            const text = event.clipboardData?.getData('text') ?? '';
            if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return;
            event.preventDefault();
            lines.value = text.replace(/\r\n?/g, '\n'); lines.hidden = false; value.hidden = true; value.value = ''; lines.focus();
        });
        const day = el('input'); day.id = 'secret-replace-expires'; day.type = 'date'; day.value = chosen.secret.expires ?? ''; day.setAttribute('aria-label', 'Expires');
        const field = (label, small, ...control) => {
            const what = el('div', 'set-what'); what.append(el('span', '', label), el('small', '', small));
            const c = el('div', 'set-control'); c.append(...control);
            const row = el('div', 'set-row'); row.append(what, c); return row;
        };
        const cancel = el('button', '', 'Cancel'); cancel.type = 'button';
        cancel.addEventListener('click', () => { secretReplacing = ''; void paintAssets(); });
        const go = el('button', 'primary', 'Replace'); go.type = 'submit';
        const actions = el('div', 'action-row'); actions.append(said, cancel, go);
        form.append(field('New value', 'Never shown · empty keeps it', value, lines), field('Expires', 'Optional', day), actions);
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            $('assets-error').hidden = true;
            const typed = lines.hidden ? value.value : lines.value.replace(/\r\n?/g, '\n');
            const body = { expires: day.value };
            if (typed) body.value = typed;
            /* Not kept in the page a moment longer. */
            value.value = ''; lines.value = '';
            try { await post(`${API}/secrets/${chosen.name}/replace`, body); secretReplacing = ''; secretSaid = { name: chosen.name, text: 'Machines get it at their next start' }; }
            catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
            await paintAssets();
        });
        setTimeout(() => value.focus(), 0);
        return { rows: [], card: [form] };
    }

    /* ---- the server's ---- */
    let assetOpen = ''; let assetsAdding = ''; let assetsQuery = ''; let remoteShown = ''; let remoteEditing = false; let listOpen = ''; let listsSig = '';
    /* How the Assets list is arranged: by type (the categories, the default) or
       by the owner's groups. A per-viewer convenience, kept in the browser. */
    let assetsBy = 'type';
    try { if (localStorage.getItem('clavarium-assets-by') === 'group') assetsBy = 'group'; } catch { /* a private window */ }
    const keepAssetsBy = () => { try { localStorage.setItem('clavarium-assets-by', assetsBy); } catch { /* as above */ } };
    /* The "+ New group" inline form being shown in the by-group view. */
    let groupAdding = false;
    /* Conversations shown in a group's "give" settings although none of its
       assets is given to them yet (the owner just added them to set levels).
       Cleared when the open group changes. */
    const groupGiveShow = new Set();
    /* A binder opened in Assets: its screen, the card of the address (a reload); a card, a step (binderSteps). */
    let assetsView = null; let assetsAt = null;
    const assetsSteps = binderSteps(() => assetsView, { address: () => remember() });
    /* A list given to a conversation, or taken back: a grant of Binder's. */
    const givenTo = (l) => Object.keys(l.grants ?? {}).filter((id) => id.startsWith('conversation:'));
    async function grantList(list, name, value) {
        $('assets-error').hidden = true;
        const done = await binderCall('grant', { list, to: `conversation:${name}`, access: value === 'none' ? null : value });
        if (!done.ok) { $('assets-error').textContent = done.text; $('assets-error').hidden = false; }
        await refresh();
    }
    /* The plain word for a Tether target's kind, in a Connexion's sub-line. */
    const CONNEXION_SUB = { mail: 'mailbox', calendar: 'calendar', contacts: 'address book', files: 'online folder', ssh: 'machine', computer: 'computer', browser: 'browser', screen: 'screen' };
    const connexionSub = (kind) => CONNEXION_SUB[kind] ?? kind;
    /* Give a Tether target to a conversation at a level, or take it back (none). */
    async function grantTarget(id, name, level) {
        $('assets-error').hidden = true;
        try { await post(`${API}/tether/level`, { target: id, agent: `conversation:${name}`, level }); }
        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
        await refresh();
    }
    /* Accept or refuse a Tether call that is waiting for a person. `after` repaints the
       surface the row sits in (the Assets page by default; the room passes its own). */
    async function decideTether(id, decision, after) {
        $('assets-error').hidden = true;
        try { await post(`${API}/tether/decide`, { id, decision }); }
        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
        if (after) await after(); else await paintAssets();
    }
    /* Every call waiting for the owner, on one surface. `withWho`: name who asks. */
    /* A JOB: a call the owner approved that only this browser can do -- a device to flash
       over USB. The browser lets only a click reach a USB device, so it waits for one; then
       Tether's own module runs here (/vendor/tether/jobs.js) and its end is the agent's answer.
       Its element is kept from one paint to the next: the module draws in it while it runs. */
    const jobPlaces = new Map();
    /* The same, from its button in the thread: the module draws in a panel over the page, closed once done. */
    async function flashFromThread(id) {
        const tether = await getJson('/tether', {});
        const job = (Array.isArray(tether.jobs) ? tether.jobs : []).find((j) => j.id === id);
        let panel = $('job-panel');
        if (!panel) { panel = el('div', 'card job-panel'); panel.id = 'job-panel'; panel.setAttribute('role', 'dialog'); document.body.append(panel); }
        panel.hidden = false;
        if (!job) { panel.replaceChildren(el('p', '', 'This flash ended already, or was cancelled.')); setTimeout(() => { panel.hidden = true; }, 3000); return; }
        const close = el('button', '', 'Close'); close.type = 'button'; close.addEventListener('click', () => { panel.hidden = true; });
        const card = jobCard(job, () => { void paintRoomAssets(); });
        panel.replaceChildren(card, close);
        card.querySelector('.action-row button.primary')?.click();
    }
    function jobCard(job, after) {
        if (!jobPlaces.has(job.id)) {
            const card = el('div', 'card job-card'); card.dataset.job = job.id;
            const what = job.args?.name ? `Flash ${job.args.name}` : 'Flash a device';
            card.append(el('b', '', `${what} from this browser`), el('p', 'hint', 'Plug it into this computer (or this Android phone) by USB, then start. Chrome or Edge.'));
            const place = el('div', 'job-place');
            const start = el('button', 'primary', 'Plug it in and start'); start.type = 'button';
            const cancel = el('button', '', 'Cancel'); cancel.type = 'button';
            const row = el('div', 'action-row'); row.append(start, cancel);
            start.addEventListener('click', async () => {
                row.hidden = true;
                const call = async (op, args) => { try { return { ok: true, data: await post(`${API}/tether/${op}`, args) }; } catch (error) { return { ok: false, text: error.message }; } };
                /* A device that pairs (a voice box): a one-use code for the conversation that asked, made here. */
                const pair = async (room) => { const r = await pairCode({ conversation: String(job.agent).replace(/^conversation:/, ''), name: room }); return { url: location.origin, code: r.code }; };
                try { const { runJob } = await import('/vendor/tether/jobs.js'); await runJob(job, { call, root: place, pair }); }
                catch (error) { place.textContent = `It could not start: ${error.message}`; }
                setTimeout(() => { jobPlaces.delete(job.id); after?.(); }, 4000);
            });
            cancel.addEventListener('click', async () => { await post(`${API}/tether/job-done`, { id: job.id, ok: false, text: 'cancelled by the owner' }).catch(() => {}); jobPlaces.delete(job.id); after?.(); });
            card.append(row, place);
            jobPlaces.set(job.id, card);
        }
        return jobPlaces.get(job.id);
    }
    /* EVERY CALL WAITING FOR THE OWNER, AS CARDS: Parley's own request card (requestCard), the very one
       the thread shows, from the same data (`q.view`, server/demandes.mjs) -- one gesture, one
       implementation. Accept waits a few seconds with Undo (Parley holds it), then goes to Tether.
       `withWho`: name the conversation that asks. `after` repaints the surface it sits in. */
    let cardSteps = null;
    function demandesList(approvals, { withWho = false, after } = {}) {
        const box = el('div', 'demandes-box');
        const act = (id) => { const m = /^(allow|deny|always):(.+)$/.exec(id); if (m) void decideTether(m[2], DECISION[m[1]], after); };
        void Promise.all([import(new URL('vendor/parley-ui.js', new URL('/', location.href)).href), readWords()]).then(([P, words]) => {
            if (typeof P.requestCard !== 'function') return;
            cardSteps ??= P.stepper({ open: (name, close) => nav.over(`demande-${name}`, () => close(), { stack: true }), closed: (step) => { if (step) nav.drop(step); } });
            for (const q of approvals) {
                if (!q.view) continue;
                const view = withWho && q.agent?.name ? { ...q.view, sub: [q.agent.name, ...(Array.isArray(q.view.sub) ? q.view.sub : [q.view.sub])].filter(Boolean) } : q.view;
                box.append(P.requestCard(view, { act, words, steps: cardSteps, host: document.body }));
            }
        });
        return box;
    }
    /* While the owner is on Assets or a room, the calls waiting for them appear and update
       on their own: nothing on this page is polled for Tether otherwise, so a new call or
       a decided one would wait for the next click. A light watch of the one number that
       moves with every change (tethers.changes) repaints the open surface when it moves. */
    let tetherSeen = null; let tetherTimer = 0;
    const tetherViewOpen = () => !DEVICE && (place === 'assets' || assetsShown);
    function watchTether() {
        if (tetherTimer || !tetherViewOpen()) return;
        const tick = async () => {
            if (!tetherViewOpen()) { tetherTimer = 0; tetherSeen = null; return; }
            const t = await getJson('/tether', null);
            if (t && typeof t.changes === 'number') {
                if (tetherSeen !== null && t.changes !== tetherSeen) {
                    if (place === 'assets') void paintAssets();
                    else if (assetsShown) void paintRoomAssets();
                }
                tetherSeen = t.changes;
            }
            tetherTimer = setTimeout(tick, 2500);
        };
        tetherTimer = setTimeout(tick, 0);
    }
    /* A new list: Binder's templates, read once. */
    async function fillTemplates() {
        const pick = $('listnew-template');
        if (pick.options.length) return;
        const names = await binderCall('templates', {});
        if (!names.ok || pick.options.length) return;
        for (const [key, name] of Object.entries(names.data)) { const o = document.createElement('option'); o.value = key; o.textContent = name[binderLang()] ?? name.en; pick.append(o); }
    }
    /* NEW ASSET (05-11, step 3): ONE BOX (kit.js NewAsset) wherever an asset is made -- Assets (the "+" of a
       kind, the map's "+"), a conversation's Attach: the same kinds, the same forms (#assets-forms, moved in
       when asked for), one ending. The words, once each. */
    const newKinds = () => [['folder', uiSaid('set-na-k-folder', 'Folder')], ['git', uiSaid('set-na-k-git', 'Git repository')], ['mailbox', uiSaid('set-na-k-mailbox', 'Mailbox')],
        ['agenda', uiSaid('set-na-k-agenda', 'Calendar')], ['contacts', uiSaid('set-na-k-contacts', 'Contacts')], ['secret', uiSaid('set-na-k-secret', 'Secret')], ['list', uiSaid('set-na-k-list', LISTS_WORD.one)],
        /* Step 4: a voice box (paired with a code) and a device (the share sheet, its code) are two kinds of it too. */
        ['box', uiSaid('set-na-k-box', 'Voice box')], ['device', uiSaid('set-na-k-device', 'Device')]]
        .map(([kind, label]) => ({ kind, label, icon: kindIcon(kind) }));
    /* A voice box's steps after its kind (the flow: "A NEW VOICE BOX", with the boxes), and the one under way. */
    const BOX_STEPS = ['where', 'plug', 'pair'];
    let boxFlow = null;
    /* `boxHost` { where, repaint, close }: the frame a voice box is added in -- where it speaks (preselected),
       how that frame draws itself again, and closes. A device is the share sheet itself, opened on `where`. */
    function newAssetBox(opts) {
        const host = opts.boxHost ?? { where: '', repaint: () => {}, close: () => {} };
        const box = opts.kind === 'box' && !opts.made;
        const boxMade = box && boxFlow?.made ? boxFlow.made : null;
        const speaks = box && host.where ? { line: speaksLine(host.where) } : null;
        return KIT.NewAsset({
            kinds: newKinds(), ...opts,
            ...(box ? { context: boxMade ? null : speaks, at: boxFlow ? 1 + BOX_STEPS.indexOf(boxFlow.step) : 1,
                made: boxMade ? { said: uiSaid('set-na-box-made', '{name} answers in {where}', { name: boxMade.name, where: whereName(boxMade.where) }) } : null,
                onAnother: () => { startBoxFlow(host); host.repaint(); }, onDone: () => { stopBoxWait(); boxFlow = null; host.close(); } } : {}),
            onKind: (k) => {
                if (k === 'device') { newDevice(host.where); return; }
                if (k === 'box') startBoxFlow(host);
                opts.onKind?.(k);
            },
            words: { title: opts.title ?? uiSaid('set-na-new', 'New asset'), there: uiSaid('set-na-there', 'Already there'), orNew: uiSaid('set-na-or-new', 'or a new one'),
                steps: box ? [uiSaid('set-na-step-kind', 'Kind'), uiSaid('set-na-step-where', 'Where'), uiSaid('set-na-step-plug', 'Plug it'), uiSaid('set-na-step-pair', 'Pair it'), uiSaid('set-na-step-answers', 'It answers')]
                    : [uiSaid('set-na-step-kind', 'Kind'), uiSaid('set-na-step-set', 'Set up'), uiSaid('set-na-step-made', 'Created')],
                back: uiSaid('set-na-back', 'Back'), another: uiSaid('set-na-another', 'Create another'), done: uiSaid('set-na-done', 'Done') },
            form: (kind) => {
                if (kind === 'box') return paintBoxFlow();
                const form = $(`${addForm(kind)}-box`); form.hidden = false;
                if (kind === 'git') { fillKeyChoice(); showVia(); }
                if (kind === 'list') void fillTemplates();
                return form;
            },
        });
    }
    /* The first field of the form shown in `holder`, focused. */
    const focusFirst = (holder) => { const f = holder.querySelector('.as-form input:not([type=radio])'); if (f) focusField(f); };
    /* What was just made: the box's ending ("✓ <name> created"), until Done. `to`: the conversation it was attached to. */
    let justMade = null;
    /* A form is in the conversation's Attach (its context), or in Assets. */
    const inAttach = (form) => $('attach-box').contains(form);
    const newAssetError = (form, message) => { const e = inAttach(form) ? $('attach-error') : $('assets-error'); e.textContent = message; e.hidden = false; };
    /* THE ONE ENDING. `give(conversation, level)` attaches it, when the box was opened from a conversation; in
       Assets it is opened, the ending above it. */
    async function assetMade(form, { key, name, give = null, note = '' }) {
        if (inAttach(form) && current) {
            const kind = attachNew.kind;
            if (give) await give(current, attachNew.level);
            justMade = { kind, key, name, note, to: current };
            attachNew.kind = '';
            await paintPanel();
            paintAttach();
            return;
        }
        justMade = { kind: assetsAdding, key, name, note };
        assetOpen = key; assetsAdding = '';
    }
    /* Another kind asked from inside a form (New mailbox's Google, Microsoft: the account's form). */
    async function newAssetKind(form, kind) {
        if (inAttach(form)) { attachNew.kind = kind; paintAttach(); return; }
        assetsAdding = kind; await paintAssets();
    }
    /* A Tether target given from Attach: Read watches, Write proposes (asks before each action). */
    const targetLevel = (level) => (level === 'write' ? 'propose' : 'watch');
    async function paintAssets() {
        if (place !== 'assets' || DEVICE) return;
        watchTether();
        const [all, boxes, secrets, keys, lists, tether, assetGroups] = await Promise.all([getJson('/resources', []), getJson('/mailboxes', []), getJson('/secrets', []), getJson('/git-keys', []), binderCall('lists', {}), getJson('/tether', {}), getJson('/asset-groups', []), readDevices()]);
        if (place !== 'assets') return;
        paintKeys(keys);
        markSecrets(secrets);
        const items = [];
        for (const r of all) {
            const kind = kindOf(r); const users = Object.keys(r.attachments ?? {}).length;
            const box = kind === 'mailbox' ? boxes.find((m) => m.name === r.name) : undefined;
            items.push({ key: `${kind}:${r.name}`, kind, name: r.name, resource: r, box, badge: String(users), badgeTitle: `Used by ${users} conversation${users === 1 ? '' : 's'}`, badgeTone: 'count',
                sub: kind === 'git' ? `${gitSub(r)}${viaText(r.via)}` : kind === 'mailbox' ? boxSub(box) : 'folder', tone: box?.failure ? 'bad' : '' });
        }
        for (const s2 of secrets) items.push({ key: `secret:${s2.name}`, kind: 'secret', name: s2.name, secret: s2, badge: String(s2.conversations.length), badgeTitle: `Used by ${s2.conversations.length} conversation${s2.conversations.length === 1 ? '' : 's'}`, badgeTone: 'count', ...secretItem(s2, 'name only') });
        /* Tether targets ("Connexions"): a mailbox, calendar or address book connected
           by token, given to a conversation at a level. The token lives on the server. */
        const allTargets = Array.isArray(tether.targets) ? tether.targets : [];
        for (const tgt of allTargets) {
            const users = Object.keys(tgt.grants ?? {}).filter((id) => id.startsWith('conversation:')).length;
            const acct = tetherAccount(tgt.id);
            const siblings = allTargets.filter((o) => o.id !== tgt.id && tetherAccount(o.id) === acct).map((o) => connexionSub(o.kind));
            items.push({ key: `connexion:${tgt.id}`, kind: tetherCat(tgt.kind), name: tgt.title, target: tgt, siblings, live: true,
                badge: String(users), badgeTitle: `Used by ${users} conversation${users === 1 ? '' : 's'}`, badgeTone: 'count',
                sub: siblings.length ? `linked: ${siblings.join(', ')}` : connexionSub(tgt.kind) });
        }
        /* Binder's lists: given to a conversation (read, write) in Binder itself. */
        const shownLists = lists.ok && Array.isArray(lists.data) ? lists.data.filter((l) => !l.archived) : [];
        listsSig = binderSig(lists.data);
        for (const l of shownLists) {
            const users = givenTo(l).length;
            items.push({ key: `list:${l.id}`, kind: 'list', name: l.title, list: l, badge: String(users), badgeTitle: `Used by ${users} conversation${users === 1 ? '' : 's'}`, badgeTone: 'count', sub: `${l.count} card${l.count === 1 ? '' : 's'}` });
        }
        const shown = assetsQuery ? items.filter((i) => i.name.includes(assetsQuery.toLowerCase()) || i.name.toLowerCase().includes(assetsQuery.toLowerCase())) : items;
        const chosen = assetsAdding ? null : items.find((i) => i.key === assetOpen) ?? null;
        if (justMade && !justMade.to && justMade.key !== chosen?.key) justMade = null;
        /* A group can be the open thing too (its own detail: give it, rename it). */
        const chosenGroup = !assetsAdding && !chosen && assetOpen.startsWith('group:') ? assetGroups.find((g) => `group:${g.id}` === assetOpen) ?? null : null;
        /* Every call waiting for the owner, across all the connexions, gathered in one place
           (in a connexion's own detail they still show, but only that one's). */
        const allApprovals = Array.isArray(tether.approvals) ? tether.approvals : [];
        const onDemandes = !assetsAdding && !chosen && !chosenGroup && assetOpen === 'demandes:all';
        $('assets-as').dataset.open = chosen || chosenGroup || assetsAdding || onDemandes ? 'detail' : 'list';
        /* The "by type / by group" toggle sits above the rows (built once, kept). */
        paintAssetsView();
        const choose = (key) => { placeAssetStep(); if (key !== assetOpen) groupGiveShow.clear(); assetOpen = key; assetsAdding = ''; remoteEditing = false; remember(); void paintAssets(); };
        if (assetsBy === 'group') {
            paintAsGroups($('assets-rows'), shown, assetGroups, { chosen: chosen?.key ?? (chosenGroup ? `group:${chosenGroup.id}` : ''), choose, empty: assetsQuery ? 'Nothing by that name.' : '' });
        } else {
            paintAsList($('assets-rows'), shown, { chosen: chosen?.key, choose, add: (kind) => { placeAssetStep(); assetsAdding = kind; void paintAssets(); }, empty: assetsQuery ? 'Nothing by that name.' : '' });
        }
        /* Above them all, once something waits: the owner reaches every call from here,
           not only by opening the right connexion. */
        if (allApprovals.length && !assetsQuery) {
            const row = el('button', 'as-row ts-entry demande-entry'); row.type = 'button'; row.dataset.asset = 'demandes:all';
            if (onDemandes) row.setAttribute('aria-current', 'true');
            const words = el('span', 'as-words'); words.append(el('b', '', 'Demandes'), el('small', 'as-sub', `${allApprovals.length} waiting for you`));
            row.append(kindIcon('send'), words, el('b', 'count', String(allApprovals.length)));
            row.addEventListener('click', () => choose('demandes:all'));
            $('assets-rows').prepend(row);
        }
        const detail = $('assets-detail');
        /* The forms go back to where they wait before the detail is drawn again. */
        for (const form of detail.querySelectorAll('.as-form, #gitview-remote-box')) $('assets-forms').append(form);
        detail.replaceChildren();
        const back = () => { assetOpen = ''; assetsAdding = ''; remember(); void paintAssets(); };
        if (assetsAdding) {
            /* The New asset box: from the map's "+" of Assets, which kind first ("<" goes back to the map);
               from the "+" of a kind, its form ("<" Assets). */
            const out = assetsFromMap || assetsAdding === 'choose' ? el('button', 'as-link', '‹ Access') : el('button', 'as-link as-back', '‹ Assets'); out.type = 'button';
            out.addEventListener('click', () => { if (!nav.close(assetsFromMap || assetsAdding === 'choose' ? 'compose' : 'asset')) back(); });
            const kind = assetsAdding === 'choose' ? '' : assetsAdding;
            detail.append(out, newAssetBox({ kind, onKind: (k) => { assetsAdding = k; void paintAssets(); }, boxHost: { where: '', repaint: () => { void paintAssets(); }, close: back } }));
            if (kind) focusFirst(detail);
            return;
        }
        if (chosenGroup) { groupDetail(detail, chosenGroup, items, back); return; }
        if (onDemandes) {
            detail.append(asTitle({ kind: 'send', name: 'Demandes', badge: String(allApprovals.length), badgeTone: 'count' }, back));
            detail.append(el('p', 'hint', 'Each is a Tether call its agent asked you to allow. Accept, and it runs; refuse, and it is told so.'));
            if (allApprovals.length) detail.append(demandesList(allApprovals, { withWho: true, after: () => paintAssets() }));
            else detail.append(el('p', 'hint', 'Nothing is waiting now.'));
            return;
        }
        if (!chosen) { if (items.length) detail.append(noAssetChosen()); return; }
        /* Just made here: the box's ending above it -- Create another, or Done. */
        if (justMade && !justMade.to && justMade.key === chosen.key) {
            const made = justMade;
            detail.append(newAssetBox({ kind: made.kind, made: { said: uiSaid('set-na-made', '{name} created', { name: made.name }), note: made.note },
                onAnother: () => { justMade = null; placeAssetStep(); assetsAdding = made.kind || 'choose'; void paintAssets(); },
                onDone: () => { justMade = null; void paintAssets(); } }));
        }
        detail.append(asTitle(chosen, back));
        detail.append(groupPicker(chosen, assetGroups));
        const ready = conversations.filter((c) => c.phase === 'ready');
        const r = chosen.resource;
        /* State, in a line. */
        if (chosen.kind === 'mailbox' && !chosen.target) detail.append(el('p', chosen.box?.failure ? 'error' : 'hint', boxSub(chosen.box)));
        /* ACTIONS TOO (02-11): a mailbox copied as files is read only; the same mailbox, connected live, can
           send, reply, move, flag -- within the rights given. Made here with its address and password (they
           stay on the server); only its sending server is asked, found from the address when known. */
        if (chosen.kind === 'mailbox' && !chosen.target && chosen.box && !chosen.box.provider) {
            const live = el('div', 'as-live');
            const go = el('button', '', 'Also allow actions (send, move…)'); go.type = 'button';
            live.append(el('p', 'hint', 'Read only here. Connected live too, an agent can send, reply, move or flag its mail, each within the rights you give.'), go);
            go.addEventListener('click', async () => {
                go.hidden = true;
                const box = chosen.box; const emailLike = String(box.user ?? '').includes('@');
                const email = el('input'); email.type = 'email'; email.value = emailLike ? box.user : ''; email.placeholder = 'its email address'; email.setAttribute('aria-label', 'Email address');
                const smtp = el('input'); smtp.placeholder = 'smtp.example.com'; smtp.spellcheck = false; smtp.setAttribute('aria-label', 'Sending server (SMTP)');
                const make = el('button', 'primary', 'Connect'); make.type = 'button';
                const said = el('p', 'error'); said.hidden = true;
                const form = el('div', 'as-live-form');
                form.append(el('label', '', 'Email address'), email, el('label', '', 'Sending server (SMTP)'), smtp, make, said);
                live.append(form);
                const guess = async () => { try { const found = await post(`${API}/accounts/lookup`, { user: email.value.trim() }); if (found?.smtp && !smtp.value.trim()) smtp.value = found.smtp; } catch { /* typed by hand */ } if (!smtp.value.trim() && box.host) smtp.value = String(box.host).replace(/^imap\./, 'smtp.'); };
                if (email.value) void guess();
                email.addEventListener('change', () => void guess());
                make.addEventListener('click', async () => {
                    make.disabled = true; make.textContent = 'Trying it…'; said.hidden = true;
                    try { await post(`${API}/mailboxes/${encodeURIComponent(box.name)}/live`, { email: email.value.trim(), smtp: smtp.value.trim() }); void paintAssets(); }
                    catch (error) { said.textContent = error.message; said.hidden = false; make.disabled = false; make.textContent = 'Connect'; }
                });
                focusField(smtp.value ? make : smtp);
            });
            detail.append(live);
        }
        /* A live link: what it is, and that it is associated with the same account's others. */
        if (chosen.target) {
            const t = chosen.target;
            detail.append(el('p', 'hint', ['live', connexionSub(t.kind), t.config?.user].filter(Boolean).join(' · ')));
            /* The account's real permissions, read from the token (server-side) --
               shown here so they can be checked at any time, not only at connection.
               "Re-check" reads them live, to catch a permission removed since. */
            if (['google', 'microsoft'].includes(t.config?.provider)) {
                const KINDS3 = ['mail', 'calendar', 'contacts'];
                const perms = el('div', 'as-perms');
                detail.append(perms);
                const draw = (authorized) => {
                    perms.replaceChildren();
                    if (Array.isArray(authorized)) {
                        const line = el('p', 'hint');
                        line.append(el('b', '', 'Permissions: '));
                        line.append(document.createTextNode(KINDS3.map((k) => `${k} ${authorized.includes(k) ? '✓' : '✗'}`).join('   ')));
                        perms.append(line);
                    } else { perms.append(el('p', 'hint', 'Permissions not checked yet.')); }
                    const btn = el('button', '', Array.isArray(authorized) ? 'Re-check' : 'Check permissions');
                    btn.type = 'button';
                    btn.addEventListener('click', async () => {
                        btn.disabled = true; btn.textContent = 'Checking…';
                        try { const r = await post(`${API}/accounts/verify`, { id: t.id }); draw(r.authorized); }
                        catch (e) { perms.append(el('p', 'error', e.message)); btn.disabled = false; btn.textContent = 'Re-check'; }
                    });
                    perms.append(btn);
                };
                draw(Array.isArray(t.config?.authorizedKinds) ? t.config.authorizedKinds : null);
            }
            /* A mailbox: its signature, in Markdown, added under what the agent sends. */
            if (t.kind === 'mail') {
                const box = el('div', 'as-signature');
                const lab = el('label', '', 'Signature'); lab.htmlFor = `sig-${t.id}`;
                const ta = document.createElement('textarea'); ta.id = `sig-${t.id}`; ta.rows = 3; ta.value = t.config?.signature ?? ''; ta.placeholder = 'Added under every mail the agent sends from this mailbox (Markdown: **bold**, links…)';
                const save = el('button', '', 'Save'); save.type = 'button';
                const said = el('small', 'hint', '');
                save.addEventListener('click', async () => {
                    save.disabled = true;
                    try { await post(`${API}/tether/signature`, { target: t.id, signature: ta.value }); said.textContent = ta.value.trim() ? 'Saved.' : 'Removed.'; t.config = { ...(t.config ?? {}), signature: ta.value.trim() }; }
                    catch (e) { said.textContent = e.message; }
                    save.disabled = false;
                });
                const row = el('div', 'row'); row.append(save, said);
                box.append(lab, ta, row);
                detail.append(box);
            }
            if (chosen.siblings?.length) {
                const a = el('p', 'as-assoc hint');
                a.append(el('b', '', 'Linked'), document.createTextNode(` to the same account: ${chosen.siblings.join(', ')}. They share the account's sign-in (kept on the server); rights are given separately.`));
                detail.append(a);
            }
        }
        if (chosen.kind === 'secret') {
            /* Renamed: its value and the conversations it is handed to go with it. */
            const form = el('form', 'set-row secret-rename'); form.autocomplete = 'off';
            const name = el('input'); name.id = 'secret-rename-name'; name.value = chosen.name; name.maxLength = 40; name.pattern = '[A-Z][A-Z0-9_]*'; name.spellcheck = false; name.autocapitalize = 'characters'; name.setAttribute('aria-label', 'New name');
            const go = el('button', '', 'Rename'); go.type = 'submit';
            const what = el('div', 'set-what'); what.append(el('span', '', 'Name'), el('small', '', 'Applies at next start'));
            const control = el('div', 'set-control'); control.append(name, go);
            form.append(what, control);
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                $('assets-error').hidden = true;
                try { const done = await post(`${API}/secrets/${chosen.name}/rename`, { name: name.value.trim() }); assetOpen = `secret:${done.name}`; }
                catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
                await paintAssets();
            });
            detail.append(secretLine(chosen.secret, 'not given to machines'));
            const replace = secretReplace(chosen);
            const box = el('div', 'set-rows as-block'); box.append(form, ...replace.rows);
            detail.append(box, ...replace.card);
        }
        /* Used by: each conversation that has it, what it may do; "+" offers the others. */
        const options = chosen.target ? [['none', 'Off'], ['watch', 'Watch'], ['propose', 'Propose'], ['frame', 'Frame'], ['free', 'Free']]
            : chosen.kind === 'secret' ? [['off', 'Off'], ['use', 'Use']] : chosen.kind === 'mailbox' ? [['none', 'Off'], ['read', 'Read']]
            : [['none', 'Off'], ['read', 'Read'], ['write', 'Write']];
        const has = (c) => (chosen.target ? chosen.target.grants?.[`conversation:${c.name}`]?.level ?? 'none'
            : chosen.kind === 'secret' ? (chosen.secret.conversations.includes(c.name) ? 'use' : 'off') : chosen.kind === 'list' ? chosen.list.grants?.[`conversation:${c.name}`] ?? 'none'
            : r.attachments?.[c.name] ?? 'none');
        const using = ready.filter((c) => !['none', 'off'].includes(has(c)));
        const others = ready.filter((c) => ['none', 'off'].includes(has(c)));
        const users = el('div', 'as-users');
        const picker = el('div', 'as-users as-picker'); picker.hidden = true;
        const row = (c) => {
            const line = el('div', 'given-row'); line.dataset.conversation = c.name;
            line.append(el('span', '', shownName(c)), modes(options, has(c), async (value) => {
                if (chosen.target) await grantTarget(chosen.target.id, c.name, value);
                else if (chosen.kind === 'secret') await handTo(c.name, chosen.name, value === 'use', 'assets-error');
                else if (chosen.kind === 'list') await grantList(chosen.list.id, c.name, value);
                else await attachTo(c.name, chosen.name, value, 'assets-error');
                await paintAssets();
            }, `What ${c.name} may do with ${chosen.name}`));
            return line;
        };
        for (const c of using) users.append(row(c));
        if (using.length === 0) users.append(el('p', 'hint', 'No conversation uses it.'));
        for (const c of others) picker.append(row(c));
        if (others.length === 0) picker.append(el('p', 'hint', ready.length ? 'Every conversation has it.' : 'No conversation is ready.'));
        detail.append(chapter('Used by', roundPlus('Give it to a conversation', () => { picker.hidden = !picker.hidden; })), users, picker);
        if (chosen.kind === 'list') {
            /* The list itself, Binder's screen, here: that list alone. */
            const open = el('button', '', listOpen === chosen.key ? 'Close' : 'Open'); open.type = 'button'; open.dataset.act = 'open-list';
            const holder = el('div', 'binder-holder as-binder');
            open.addEventListener('click', () => { listOpen = listOpen === chosen.key ? '' : chosen.key; void paintAssets(); });
            detail.append(chapter('Cards', open), holder);
            const id = chosen.list.id;
            if (listOpen === chosen.key) {
                /* Drawn again (the lists changed): on the card it showed, if it showed one; after a reload, the card of the address. */
                const was = assetsView?.place;
                const at = assetsAt?.list === id ? assetsAt : was?.list === id && was.page === 'card' ? { list: id, card: was.card } : null;
                assetsAt = null;
                void mountBinder(holder, (l) => l.id === id, { place: at, steps: assetsSteps, onLists: (data) => { if (place === 'assets' && binderSig(data) !== listsSig) void paintAssets(); } })
                    .then((view) => { if (view) assetsView = view; });
            }
        }
        if (chosen.kind === 'git') {
            const holder = el('div', 'as-git'); detail.append(holder);
            /* Settings: where it is sent, with what. */
            const settings = await getJson(`/git/${chosen.name}`, {});
            const edit = el('button', 'as-edit', '✎ Edit'); edit.type = 'button';
            const table = el('dl', 'as-settings');
            const fact = (k, v) => { table.append(el('dt', '', k), el('dd', '', v)); };
            fact('Remote', settings.remote ?? 'none');
            fact('Sent with', settings.hasKey ? 'a key kept for it' : settings.sshKey ? `SSH key ${settings.sshKey}` : r.via?.method && r.via.method !== 'none' ? viaText(r.via).replace(/^, with /, '') : 'what it was cloned with');
            if (r.from && r.via?.hostKey) fact('Host key', `${hostOf(r.from)}: ${r.via.hostKey}`);
            detail.append(chapter('Settings', edit), table);
            const box = $('gitview-remote-box');
            remoteShown = chosen.name;
            await fillRemote(chosen.name, settings);
            box.hidden = !remoteEditing; box.open = true;
            detail.append(box);
            edit.addEventListener('click', () => { remoteEditing = !remoteEditing; box.hidden = !remoteEditing; if (remoteEditing) focusField($('gitview-url')); });
            void gitDetail(holder, chosen.name, { place: true });
        }
        if (chosen.target) {
            const t = chosen.target;
            detail.append(el('p', 'hint', 'A level is: watch (read only), propose (asks before each action), frame (acts within its rules, asks for the rest), free (acts, kept in the journal).'));
            /* Calls waiting for a person (propose/frame). Accept or refuse each. */
            const waiting = (Array.isArray(tether.approvals) ? tether.approvals : []).filter((q) => (q.target?.id ?? q.target) === t.id);
            if (waiting.length) {
                const box = el('div', 'as-users');
                for (const q of waiting) {
                    const line = el('div', 'given-row');
                    const what = el('span', ''); what.append(el('b', '', q.verb ?? 'action'), document.createTextNode(` ${q.detail ?? ''}`.trimEnd()));
                    if (q.why) what.append(el('small', 'hint', ` — ${q.why}`));
                    const yes = el('button', 'primary', 'Accept'); yes.type = 'button'; yes.addEventListener('click', () => { yes.disabled = true; void decideTether(q.id, 'yes'); });
                    const no = el('button', 'danger', 'Refuse'); no.type = 'button'; no.addEventListener('click', () => { no.disabled = true; void decideTether(q.id, 'no'); });
                    const acts = el('div', 'levels'); acts.append(yes, no);
                    line.append(what, acts); box.append(line);
                }
                detail.append(chapter('Waiting for you'), box);
            }
        }
        /* Delete, out of the way; refused while it is used, and why. */
        const remove = el('button', 'as-link danger-link', 'Delete...'); remove.type = 'button';
        const why = el('small', 'hint');
        const inUse = chosen.kind !== 'secret' && using.length > 0;
        const lost = chosen.target ? 'The connection is removed; the account token stays on the server.' : ({ secret: 'Its value is lost for good.', list: 'Its cards are lost for good.' }[chosen.kind] ?? 'Its files are kept aside on the server.');
        if (inUse) { remove.disabled = true; why.textContent = ` used by ${using.length} conversation${using.length > 1 ? 's' : ''}: set ${using.length > 1 ? 'them' : 'it'} to Off first`; }
        remove.addEventListener('click', () => {
            const sure = el('button', 'danger', chosen.kind === 'secret' || chosen.kind === 'list' ? `Yes, delete ${chosen.name}` : `Yes, remove ${chosen.name}`); sure.type = 'button';
            const keep = el('button', '', 'Keep'); keep.type = 'button';
            keep.addEventListener('click', () => { void paintAssets(); });
            const ask = el('div', 'callout bad confirm'); ask.setAttribute('role', 'alertdialog');
            ask.append(el('span', '', lost), keep, sure);
            sure.addEventListener('click', async () => {
                try {
                    if (chosen.kind === 'list') { const done = await binderCall('delete-list', { list: chosen.list.id }); if (!done.ok) throw new Error(done.text); }
                    else if (chosen.target) await post(`${API}/tether/remove-target`, { target: chosen.target.id });
                    else await post(chosen.kind === 'secret' ? `${API}/secrets/${chosen.name}/remove` : `${API}/resources/${chosen.name}/remove`);
                    assetOpen = '';
                }
                catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
                await paintAssets();
            });
            remove.replaceWith(ask); why.remove();
            sure.focus();
        });
        /* Given to a device: from here too (the map shows who has it). */
        const share = el('button', 'as-link', 'Share with a device...'); share.type = 'button';
        share.addEventListener('click', () => { void openCompose([[chosen.key, 'r']]); });
        const foot = el('div', 'as-foot'); foot.append(...(['secret', 'list'].includes(chosen.kind) || chosen.target ? [] : [share, el('br')]), remove, why);
        detail.append(foot);
    }
    /* From the map's "+" of Assets: the Assets page over the map, on "which kind"; Back, the map. */
    let assetsFromMap = false;
    function newAssetFromMap() {
        if (place !== 'access') { void openAssetsPlace(); return; }
        assetOpen = ''; assetsAdding = 'choose'; assetsFromMap = true; remoteEditing = false;
        showPlace('assets');
        nav.push('compose', ({ quiet }) => {
            assetsAdding = ''; assetsFromMap = false;
            if (quiet) return;
            showPlace('access'); accessTab = 'map'; paintTabs(); void links?.open({ pin: accessFor ? `conversation:${accessFor}` : null });
        });
        $('assets-error').hidden = true;
        void paintAssets();
    }
    /* One asset of the place opened (or a form to make one): a step; another one takes its place. */
    function placeAssetStep() {
        const a = nav.last(['asset']);
        if (a >= 0 && a > nav.last(['place'])) { nav.cut(a + 1); return; }
        nav.push('asset', ({ quiet }) => { assetOpen = ''; assetsAdding = ''; remoteEditing = false; if (!quiet && place === 'assets') { remember(); void paintAssets(); } });
    }
    /* The remote form of a repository, filled for it. */
    async function fillRemote(name, settings) {
        $('gitview-url').value = settings.remote ?? ''; $('gitview-user').value = settings.user ?? ''; $('gitview-key').value = '';
        const pick = $('gitview-sshkey'); pick.replaceChildren();
        for (const [value, text] of [['', '(none)'], ...gitKeys.map((k) => [k.name, k.name])]) { const o = document.createElement('option'); o.value = value; o.textContent = text; pick.append(o); }
        pick.value = settings.sshKey ?? '';
        $('gitview-key-state').textContent = settings.hasKey ? 'Push key: kept here'
            : settings.sshKey ? `Push key: SSH key ${settings.sshKey}` : 'Push key: none · the clone\'s access, same server only';
    }
    $('assets-search').addEventListener('input', () => { assetsQuery = $('assets-search').value.trim(); void paintAssets(); });
    $('assets-close').addEventListener('click', () => leavePlace());
    /* The Assets place, on one asset (`key`), its remote form open (`remote`). */
    async function openAssetsPlace(key, { remote = false, push = true } = {}) {
        if (DEVICE) return;
        if (key !== undefined) { assetOpen = key; assetsAdding = ''; }
        remoteEditing = remote;
        enterPlace('assets', push);
        $('assets-error').hidden = true;
        await paintAssets();
    }
    async function openAssets() { await openAssetsPlace(); }
    /* ---------- the conversations as cards (02-11) ---------- */
    /* ONE CONVERSATION AS A CARD (the home deck): the kit's card, its last words and when, its rooms and boxes. `onOpen(c)`. */
    function convCard(c, onOpen) {
        const card = KIT.ConvCard(convModel(c, true), { size: 'card', cls: 'conv-card', onOpen: () => onOpen(c) });
        card.dataset.name = c.name;
        return card;
    }
    /* ---------- ROOMS (#268): one thread for several AIs, the person and boxes ---------- */
    let rooms = [];
    let boxesKnown = [];
    const loadBoxes = async () => { if (DEVICE) return boxesKnown; try { const r = await fetch(`${API}/boxes`); if (r.ok) { const got = await r.json(); boxesKnown = Array.isArray(got) ? got : []; } } catch { /* kept as known */ } return boxesKnown; };
    const loadRooms = async () => { try { const r = await fetch(`${API}/rooms`); rooms = r.ok ? await r.json() : []; } catch { rooms = []; } return rooms; };
    const huePick = KIT.hueOf;
    /* Its members as small chips, each by its shape: a person round, an AI a rounded square, a box an outline. */
    const memberChips = (members, max = 7) => {
        const stack = el('span', 'salon-stack');
        for (const m of members.slice(0, max)) { const i = el('i', `salon-chip salon-chip-${m.kind}`, m.kind === 'box' ? '' : KIT.initialOf(m.name)); if (m.kind !== 'box') i.style.setProperty('--h', String(huePick(m.name))); i.title = m.name; stack.append(i); }
        return stack;
    };
    const countOf = (members) => { const n = (k) => members.filter((m) => m.kind === k).length; const say = (k, one, many) => (n(k) ? `${n(k)} ${n(k) > 1 ? many : one}` : ''); return [say('person', 'person', 'people'), say('ai', 'AI', 'AIs'), say('box', 'box', 'boxes')].filter(Boolean).join(' \u00b7 '); };
    /* A ROOM AS A CARD: the kit's card, as a conversation's (a card behind it says it holds several). */
    function roomCard(r) {
        const card = KIT.ConvCard(roomModel(r), { size: 'card', cls: 'conv-card conv-card-room', onOpen: () => { void openSalon(r.id); } });
        card.dataset.room = r.id;
        return card;
    }
    let salonThread = null; let salonId = ''; let salonTimer = null;
    /* A room's bar while one of its AIs speaks: its dot at work (gold, breathing), the words under its name. */
    function salonLive(who) {
        const dot = $('salon-state'); const line = $('salon-live');
        if (dot) { dot.dataset.state = who.length ? 'work' : 'ok'; dot.title = who.length ? speaking(who) : ''; }
        if (line) { line.hidden = who.length === 0; line.textContent = who.length ? speaking(who) : ''; }
    }
    function salonLeft() { clearInterval(salonTimer); salonTimer = null; salonThread?.destroy(); salonThread = null; salonId = ''; }
    async function openSalon(id, push = true) {
        if (DEVICE) return;
        await loadRooms();
        const r = rooms.find((x) => x.id === id); if (!r) return;
        enterPlace('salon', push);
        salonLeft(); salonId = id;
        $('salon-name').textContent = r.name;
        salonLive(thinkingOf(r));
        $('salon-who').replaceChildren(memberChips(r.members), el('span', 'hint', `${countOf(r.members)} \u25BE`));
        $('salon-who').setAttribute('aria-expanded', 'false'); $('salon-members').hidden = true;
        const rows = ['person', 'ai', 'box'].map((k) => { const of = r.members.filter((m) => m.kind === k); if (!of.length) return null; const row = el('div', 'salon-members-row'); row.append(el('span', 'hint', k === 'person' ? 'People' : k === 'ai' ? 'AIs' : 'Boxes'), ...of.map((m) => { const x = el('span', 'salon-member'); x.append(memberChips([m], 1), document.createTextNode(m.name)); if (m.host) x.append(el('span', 'salon-host', 'host')); return x; })); return row; }).filter(Boolean);
        $('salon-members').replaceChildren(...rows);
        const [{ mount }, words] = await Promise.all([import(new URL('vendor/parley-ui.js', new URL('/', location.href)).href), readWords()]);
        if (salonId !== id) return;
        $('salon-thread').dataset.theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
        salonThread = mount($('salon-thread'), {
            words, markdown: true, agentName: '',
            load: (asked = {}) => fetch(`${API}/rooms/${id}/talk${asked.last ? `?last=${asked.last}` : ''}`).then((x) => x.json()).then((d) => {
                /* Who was given a message and has not answered yet (#282): « Hugo réfléchit… ». */
                const who = thinkingOf(d);
                $('salon-thinking').hidden = who.length === 0;
                $('salon-thinking').replaceChildren(KIT.StatusDot({ state: 'work' }), document.createTextNode(who.length > 1 ? uiSaid('room-thinking-many', '{names} are thinking\u2026', { names: who.join(', ') }) : uiSaid('room-thinking', '{name} is thinking\u2026', { name: who[0] ?? '' })));
                /* Its bar says it too, as its row in the list: its dot at work, « Cuisine parle… » under its name. */
                salonLive(who);
                const known = rooms.find((x) => x.id === id);
                if (known && JSON.stringify(thinkingOf(known)) !== JSON.stringify(who)) { known.thinking = who; paint(); }
                return d;
            }),
            send: (text) => post(`${API}/rooms/${id}/talk`, { text }),
            /* The same chat as a conversation's (03-11): its view, its formulas, its dictation, its keyboard rule. */
            view: chatView, onView: (v) => { chatView = v; try { localStorage.setItem('clavarium-chat-view', v); } catch { /* as above */ } },
            math: { url: new URL('vendor/katex/katex.mjs', new URL('/', location.href)).href },
            diagram: drawDiagram, highlight: colourCode, touch: touchScreen,
            voice: chatVoice(), autoSend: chatAuto, autoSendMs: chatAutoMs, onAutoSendMs: keepAutoMs, onAutoSend: (on) => { chatAuto = on; try { localStorage.setItem('clavarium-chat-auto', on ? '1' : '0'); } catch { /* as above */ } },
            draft: `room:${id}`,
        });
        salonTimer = setInterval(() => { if (salonThread && salonId === id) void salonThread.refresh(); }, 3000);
    }
    $('salon-close').addEventListener('click', () => leavePlace());
    $('salon-who').addEventListener('click', () => { const open = $('salon-members').hidden; $('salon-members').hidden = !open; $('salon-who').setAttribute('aria-expanded', String(open)); });
    /* A NEW ROOM, or a room set up again (03-11): the one that welcomes in a box of its own at the top; below, every
       conversation on one row -- its name, the name its assistant has in its chat, its tool -- with a switch (in the
       room or not) and « Welcomes »; a search; a row dragged into the box above welcomes too. Boxes: the same rows,
       with a switch only. `editing`: the room, or null for a new one. */
    let salonIn = new Set(); let salonHost = ''; let salonBoxes = new Set(); let salonEditing = null; let salonBoxList = [];
    /* Every conversation as a member: the kit's card, its size `member`, its gestures (Welcomes, in the room) at its end. */
    function paintSalonMembers() {
        const hostC = conversations.find((c) => c.name === salonHost);
        const box = $('salon-new-host'); box.replaceChildren();
        if (hostC) box.append(KIT.ConvCard({ ...convModel(hostC), now: 'answers, or hands the message on' }, { size: 'member', cls: 'salon-host-what' }));
        else box.append(el('small', 'hint', 'Pick one below: « Welcomes »'));
        const q = $('salon-new-search').value.trim().toLowerCase();
        const rows = conversations.filter((c) => !q || `${shownName(c)} ${c.chatName ?? ''}`.toLowerCase().includes(q)).sort((a, b) => Number(salonIn.has(b.name)) - Number(salonIn.has(a.name)));
        $('salon-new-ais').replaceChildren(...rows.map((c) => {
            const welcome = el('button', 'salon-welcome-btn', 'Welcomes'); welcome.type = 'button'; welcome.setAttribute('aria-pressed', String(c.name === salonHost)); welcome.setAttribute('aria-label', `${shownName(c)} welcomes the room`);
            welcome.addEventListener('click', () => { salonIn.add(c.name); salonHost = c.name; paintSalonMembers(); });
            const sw = KIT.Switch({ on: salonIn.has(c.name), label: `${shownName(c)} in the room`, onChange: (on) => { if (!on) { salonIn.delete(c.name); if (salonHost === c.name) salonHost = [...salonIn][0] ?? ''; } else { salonIn.add(c.name); if (!salonHost) salonHost = c.name; } paintSalonMembers(); } });
            const row = KIT.ConvCard(convModel(c), { size: 'member', cls: 'salon-member-row', actions: [welcome, sw] });
            row.setAttribute('role', 'listitem'); row.draggable = true; row.dataset.name = c.name;
            return row;
        }));
        $('salon-new-count').textContent = `\u00b7 ${salonIn.size} in the room`;
        $('salon-new-boxes').replaceChildren(...salonBoxList.map((b) => {
            const row = el('div', 'salon-member-row'); row.setAttribute('role', 'listitem');
            const what = el('span', 'salon-member-what'); what.append(el('b', '', b.name), el('small', '', b.place || 'Voice box'));
            const sw = KIT.Switch({ on: salonBoxes.has(b.id), label: `${b.name} in the room`, onChange: (on) => { if (on) salonBoxes.add(b.id); else salonBoxes.delete(b.id); paintSalonMembers(); } });
            row.append(what, sw);
            return row;
        }));
    }
    $('salon-new-search').addEventListener('input', paintSalonMembers);
    /* A ROOM'S "+ Voice box": the New asset box, its kind a voice box, speaking in this room; once it answers, it is
       among the room's boxes, switched on (kept with Save). */
    function paintSalonBoxNew() {
        const holder = $('salon-box-newasset');
        if (holder.contains($('box-add'))) $('assets-forms').append($('box-add'));
        holder.hidden = false;
        holder.replaceChildren(newAssetBox({ kind: 'box', boxHost: boxFlow.host }));
    }
    function closeSalonBoxNew() { const holder = $('salon-box-newasset'); if (holder.contains($('box-add'))) $('assets-forms').append($('box-add')); holder.replaceChildren(); holder.hidden = true; }
    $('salon-new-box-add').addEventListener('click', () => {
        if (!salonEditing) return;
        if (!$('salon-box-newasset').hidden) { stopBoxWait(); boxFlow = null; closeSalonBoxNew(); return; }
        startBoxFlow({ where: `room:${salonEditing.id}`, close: closeSalonBoxNew, repaint: () => {
            paintSalonBoxNew();
            if (!boxFlow?.made) return;
            void getJson('/boxes', null).then((list) => {
                if (!Array.isArray(list)) return;
                salonBoxList = list; boxesKnown = list;
                if (list.some((b) => b.id === boxFlow?.made?.id)) salonBoxes.add(boxFlow.made.id);
                paintSalonMembers();
            });
        } });
        paintSalonBoxNew();
        focusFirst($('salon-box-newasset'));
    });
    let salonDragged = '';
    $('salon-new-ais').addEventListener('dragstart', (e) => { salonDragged = e.target.closest?.('.salon-member-row')?.dataset.name ?? ''; });
    $('salon-new-host').addEventListener('dragover', (e) => { e.preventDefault(); $('salon-new-host').classList.add('over'); });
    $('salon-new-host').addEventListener('dragleave', () => $('salon-new-host').classList.remove('over'));
    $('salon-new-host').addEventListener('drop', (e) => { e.preventDefault(); $('salon-new-host').classList.remove('over'); if (salonDragged) { salonIn.add(salonDragged); salonHost = salonDragged; paintSalonMembers(); } });
    async function openSalonNew(push = true, editing = null) {
        if (DEVICE) return;
        salonEditing = editing;
        enterPlace('salon-new', push);
        $('salon-new-title').textContent = editing ? editing.name : 'New room';
        $('salon-new-create').textContent = editing ? 'Save' : 'Create';
        $('salon-new-remove-card').hidden = $('salon-new-advanced-head').hidden = !editing;
        $('salon-new-remove').hidden = false; $('salon-new-remove-card').querySelector('.confirm')?.remove();
        $('salon-new-error').hidden = true; $('salon-new-name').value = editing?.name ?? ''; $('salon-new-search').value = '';
        salonIn = new Set(editing ? editing.members.filter((m) => m.kind === 'ai').map((m) => m.ref) : []);
        salonHost = editing?.members.find((m) => m.host)?.ref ?? '';
        salonBoxes = new Set(editing ? editing.members.filter((m) => m.kind === 'box').map((m) => m.ref) : []);
        try { const x = await fetch(`${API}/boxes`); salonBoxList = x.ok ? await x.json() : []; } catch { salonBoxList = []; }
        if (Array.isArray(salonBoxList)) boxesKnown = salonBoxList; else salonBoxList = [];
        /* A room that is there already adds a voice box of its own: "+ Voice box". */
        $('salon-new-boxes-card').hidden = $('salon-new-voice-head').hidden = salonBoxList.length === 0 && !editing;
        $('salon-new-box-add').hidden = !editing; closeSalonBoxNew();
        paintSalonMembers();
        $('salon-new-name').focus();
    }
    $('salon-settings').addEventListener('click', async () => { await loadRooms(); const r = rooms.find((x) => x.id === salonId); if (r) await openSalonNew(true, r); });
    $('salon-new-remove').addEventListener('click', () => {
        const r = salonEditing; if (!r) return;
        const keep = el('button', '', 'Keep'); keep.type = 'button';
        const sure = el('button', 'danger', `Remove ${r.name}`); sure.type = 'button';
        const ask = el('span', 'callout bad confirm'); ask.setAttribute('role', 'alertdialog'); ask.append(keep, sure);
        keep.addEventListener('click', () => { ask.remove(); $('salon-new-remove').hidden = false; });
        sure.addEventListener('click', async () => { try { await post(`${API}/rooms/${r.id}/remove`, {}); salonEditing = null; await loadRooms(); paint(); openDeck(false); } catch (error) { $('salon-new-error').textContent = error.message; $('salon-new-error').hidden = false; } });
        $('salon-new-remove').hidden = true; $('salon-new-remove').after(ask); sure.focus();
    });
    /* Back from a room's settings: to the room; from a new one: where it was opened from. */
    const salonNewBack = () => { const r = salonEditing; salonEditing = null; if (r) void openSalon(r.id, false); else leavePlace(); };
    $('salon-new-close').addEventListener('click', salonNewBack);
    $('salon-new-cancel').addEventListener('click', salonNewBack);
    $('salon-new-create').addEventListener('click', async () => {
        const picked = [salonHost, ...[...salonIn].filter((c) => c !== salonHost)].filter(Boolean);
        const boxes = [...salonBoxes];
        try {
            /* Set up again: what is switched on now -- members added, those switched off taken out, the one that welcomes. */
            if (salonEditing) {
                const r = salonEditing;
                const ais = r.members.filter((m) => m.kind === 'ai'); const had = r.members.filter((m) => m.kind === 'box');
                const add = { conversations: picked.filter((c) => !ais.some((m) => m.ref === c)), boxes: boxes.filter((b) => !had.some((m) => m.ref === b)) };
                const remove = [...ais.filter((m) => !salonIn.has(m.ref)), ...had.filter((m) => !salonBoxes.has(m.ref))].map((m) => m.id);
                let now = await post(`${API}/rooms/${r.id}`, { name: $('salon-new-name').value, add, remove });
                const host = now.members.find((m) => m.kind === 'ai' && m.ref === salonHost);
                if (host && !host.host) now = await post(`${API}/rooms/${r.id}`, { host: host.id });
                salonEditing = null; await openSalon(r.id, false); return;
            }
            const made = await post(`${API}/rooms`, { name: $('salon-new-name').value, conversations: picked, boxes, host: salonHost });
            await openSalon(made.id, false);
        } catch (error) { $('salon-new-error').textContent = error.message; $('salon-new-error').hidden = false; }
    });
    /* ---------- FEATURES (features.js): what this Clavarium can do, and its next step ---------- */
    /* Each gesture is done where it is done already: its own request, or its own place open on it. */
    async function openFeature(what, s = {}) {
        const chapter = String(s.chapter ?? '');
        if (what === 'new' || (chapter === 'new' && what === 'settings')) { await openNew(); return; }
        if (what === 'boxes' || chapter === 'boxes') {
            await openAccessPage('devices');
            /* "Add a voice box": the New asset box, on its kind, where the boxes are. */
            if (s.id === 'boxes:add') openBoxNew();
            $('boxes')?.scrollIntoView({ block: 'start' });
            return;
        }
        if (what === 'mail' || chapter === 'access') { await openAssetsPlace(); return; }
        if (what === 'import') { await openAccessPage('map', { mode: 'flows' }); document.getElementById('flows-import')?.click(); return; }
        if (what === 'opencode') {
            await openNew();
            $('newconv-tools').querySelector('[data-tool="opencode"]')?.click();
            await paintOpenCode();
            const prov = $('newconv-oc-provider');
            if (s.provider && [...prov.options].some((o) => o.value === s.provider)) { prov.value = s.provider; ocProvider(); }
            const model = $('newconv-oc-model'); if (s.model && [...model.options].some((o) => o.value === s.model)) model.value = s.model;
            const key = $('newconv-oc-key'); if (s.secret && [...key.options].some((o) => o.value === s.secret)) { key.value = s.secret; $('newconv-oc-new').hidden = true; }
            return;
        }
        await openSettings();
        if (/^s-[a-z-]{1,30}$/.test(chapter)) openChapter(chapter)?.scrollIntoView({ block: 'start' });
    }
    const features = DEVICE ? undefined : window.clavariumFeatures?.({
        API, post, word: (key, en, vars) => uiSaid(key, en, vars), loadWords: () => readWords(),
        lang: () => { try { return chatWords?.lang ?? 'en'; } catch { return 'en'; } },
        mascot: () => `${MASCOTS[MASCOT]()}<span class="m-z">z</span><span class="m-z">z</span><span class="m-z">z</span>`,
        alerts: () => alertsOn(),
        /* The export of Settings, Backup (links.js): the server keeps its day as the backup's. */
        backup: async () => { $('flows-export').click(); },
        open: (what, s) => openFeature(what, s),
        welcomed: () => { if (place === 'deck') void paintDeckFeatures(conversations.length); },
    });
    async function paintSettingsFeatures() {
        if (!features) return;
        const data = await features.mount($('settings-features'), 'settings');
        $('features-title').textContent = uiSaid('features-title', 'Features');
        $('features-about').textContent = data ? uiSaid('features-lit-of', '{n} of {t} rooms lit', { n: data.counts.ready, t: data.counts.total }) : '';
    }
    async function paintDeck() {
        $('deck-title').textContent = appName;
        const list = [...conversations];
        const add = el('button', 'conv-card conv-card-new'); add.type = 'button';
        add.append(el('span', 'conv-card-plus', '+'), el('small', '', 'New conversation'));
        add.addEventListener('click', () => { void openNew(); });
        const addRoom = el('button', 'conv-card conv-card-new conv-card-new-room'); addRoom.type = 'button';
        addRoom.append(el('span', 'conv-card-plus', '+'), el('small', '', 'New room'));
        addRoom.addEventListener('click', () => { void openSalonNew(); });
        const paint = () => $('deck-cards').replaceChildren(...rooms.map((r) => roomCard(r)), ...list.map((c) => convCard(c, (x) => { leavePlace(); select(x.name); })), add, ...(list.length ? [addRoom] : []));
        paint();
        $('deck-cards').hidden = list.length === 0; $('deck-empty').hidden = list.length > 0;
        void paintDeckFeatures(list.length);
        await Promise.all([loadRooms(), loadBoxes()]); paint();
    }
    /* FEATURES (features.js): the welcome in place of "No conversation yet" until it is passed; then the
       next step over the cards. */
    async function paintDeckFeatures(count) {
        if (!features) return;
        const data = await features.refresh();
        const welcoming = count === 0 && data?.welcome === true;
        $('deck-empty').hidden = count > 0 || welcoming;
        const [on, off] = welcoming ? ['deck-welcome', 'deck-features'] : ['deck-features', 'deck-welcome'];
        features.unmount($(off)); $(off).hidden = true;
        features.show($(on), welcoming ? 'welcome' : 'home');
    }
    function openDeck(push = true) { if (DEVICE) return; enterPlace('deck', push); void paintDeck(); }
    $('deck-close').addEventListener('click', () => leavePlace());
    $('deck-empty-new').addEventListener('click', () => { void openNew(); });
    /* Import a configuration: the import of the map (Access, Flows), a file chosen at once. */
    $('deck-empty-import').addEventListener('click', () => { void openAccessPage('map', { mode: 'flows' }).then(() => document.getElementById('flows-import')?.click()).catch(() => {}); });
    $('list-title').addEventListener('click', () => openDeck());
    $('list-title').setAttribute('role', 'button'); $('list-title').tabIndex = 0;
    $('list-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') openDeck(); });
    /* ---------- private repositories: how this server gets in ---------- */
    /* The host of an address, whatever its form (user@host:path has no URL form). */
    const hostOf = (from) => { try { return new URL(from).hostname; } catch { return /@([^:/]+):/.exec(String(from))?.[1] ?? String(from); } };
    const looksSsh = (from) => /^ssh:\/\//i.test(from) || /^[^@/:\s]+@[^:/\s]+:/.test(from);
    const viaText = (via) => (!via || via.method === 'none' ? '' : via.method === 'ssh-key' ? `, with the SSH key ${via.key}` : via.method === 'token' ? ', with a token' : ', with a password (not recommended)');
    let gitKeys = [];
    /* Copies, or, without the clipboard, selects for the person to copy. */
    async function copyField(field, button) {
        try { await navigator.clipboard.writeText(field.value); button.textContent = 'Copied'; }
        catch { focusField(field); field.select(); button.textContent = 'Selected: copy it'; }
        setTimeout(() => { button.textContent = 'Copy'; }, 2500);
    }
    function paintKeys(keys) {
        gitKeys = keys;
        const rows = $('git-keys'); rows.replaceChildren();
        $('git-keys-empty').hidden = keys.length > 0;
        $('git-keys-title').textContent = `SSH keys made here (${keys.length})`;
        for (const key of keys) {
            const row = document.createElement('div'); row.className = 'asset git-key'; row.dataset.name = key.name;
            const head = document.createElement('div'); head.className = 'row';
            const name = document.createElement('b'); name.textContent = key.name;
            const used = document.createElement('span'); used.className = key.usedBy.length ? 'key-used' : 'key-used hint';
            used.textContent = key.usedBy.length ? `used by ${key.usedBy.join(', ')}` : 'not used';
            const print = document.createElement('code'); print.className = 'hint'; print.textContent = key.fingerprint;
            head.append(name, used, print);
            const shown = document.createElement('div'); shown.className = 'row';
            const field = document.createElement('textarea'); field.className = 'public-key'; field.readOnly = true; field.rows = 2; field.value = key.publicKey; field.setAttribute('aria-label', `Public key ${key.name}`);
            const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; copy.className = 'key-copy';
            copy.addEventListener('click', () => { void copyField(field, copy); });
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
            const why = document.createElement('span'); why.className = 'hint';
            if (key.usedBy.length) { remove.disabled = true; why.textContent = `removing it would cut ${key.usedBy.join(', ')} off: remove ${key.usedBy.length > 1 ? 'those repositories' : 'that repository'} first`; }
            remove.addEventListener('click', () => {
                const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Yes, remove the key ${key.name} (it cannot be made again)`;
                sure.addEventListener('click', async () => {
                    $('assets-error').hidden = true;
                    try { await post(`${API}/git-keys/${key.name}/remove`); } catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
                    await paintAssets();
                });
                remove.replaceWith(sure);
            });
            shown.append(field, copy, remove, why);
            row.append(head, shown);
            rows.append(row);
        }
        fillKeyChoice();
    }
    /* The key of "New repository": the kit's SecretPicker -- its keys, "+ New key…" made in place, and
       the new one chosen (its public half shown under it, to give the hosting service). */
    const gitKeyPick = KIT.SecretPicker({
        ids: { select: 'git-key', add: 'git-key-new', row: 'git-key-make', name: 'git-key-name', go: 'git-key-make-go' },
        none: 'No key yet: make one', addLabel: uiSaid('set-na-new-key', '+ New key…'), makeLabel: uiSaid('set-na-create', 'Create'), nameLabel: 'Name of the new key',
        nameAttrs: { maxlength: '32', pattern: '[a-z]([a-z0-9-]{0,30}[a-z0-9])?', placeholder: 'deploy-key', spellcheck: 'false', autocapitalize: 'off' },
        suggest: () => {
            const taken = new Set(gitKeys.map((k) => k.name));
            const wanted = $('git-name').value.trim();
            let suggestion = wanted && !taken.has(wanted) ? wanted : '';
            for (let n = 1; !suggestion; n += 1) if (!taken.has(`key-${n}`)) suggestion = `key-${n}`;
            return suggestion;
        },
        onMake: async (name) => {
            $('git-error').hidden = true;
            try {
                const made = await post(`${API}/git-keys`, { name });
                paintKeys(await fetch(`${API}/git-keys`).then((r) => r.json()));
                fillKeyChoice(made.name);
                return true;
            } catch (error) { $('git-error').textContent = error.message; $('git-error').hidden = false; return false; }
        },
        onChange: () => showChosenKey(),
    });
    $('git-key-pick').append(gitKeyPick);
    for (const [id, key] of [['git-key-new', 'set-na-new-key'], ['git-key-make-go', 'set-na-create']]) { const b = gitKeyPick.querySelector?.(`#${id}`); if (b) b.dataset.said = key; }
    /* The key offered in "New repository": the one chosen stays chosen. */
    function fillKeyChoice(chosen = $('git-key').value) {
        gitKeyPick.set(gitKeys.map((key) => ({ value: key.name, label: key.usedBy.length ? `${key.name} (used by ${key.usedBy.join(', ')})` : key.name })), chosen);
        showChosenKey();
    }
    function showChosenKey() {
        const key = gitKeys.find((k) => k.name === $('git-key').value);
        $('git-key-shown').hidden = !key;
        $('git-key-public').value = key?.publicKey ?? '';
    }
    const viaChosen = () => $('git-new').querySelector('input[name="git-via"]:checked')?.value ?? 'ssh-key';
    let viaTouched = false;
    function showVia() {
        for (const part of $('git-new').querySelectorAll('.git-via-part')) part.hidden = part.id !== `git-via-${viaChosen()}`;
    }
    for (const radio of $('git-new').querySelectorAll('input[name="git-via"]')) radio.addEventListener('change', () => { viaTouched = true; showVia(); });
    /* Until the person picks a way in, it follows the address: ssh wants a key, https is often public. */
    $('git-from').addEventListener('input', () => {
        if (viaTouched) return;
        const from = $('git-from').value.trim();
        const pick = looksSsh(from) ? 'ssh-key' : /^https:\/\//i.test(from) ? 'none' : '';
        if (pick) { $('git-new').querySelector(`input[name="git-via"][value="${pick}"]`).checked = true; showVia(); }
    });
    $('git-key-copy').addEventListener('click', () => { void copyField($('git-key-public'), $('git-key-copy')); });
    /* Secrets: a name, and which conversations' tools are handed it. A value goes in and never comes back. */
    /* A VALUE OF SEVERAL LINES (a PEM or SSH key, a certificate): a box of its own, masked like the
       line. Pasted into the line, whose input keeps one line only, it comes there whole by itself. */
    const secretLines = (on, text) => {
        $('secret-lines').hidden = !on; $('secret-value').hidden = on;
        $('secret-value').required = !on; $('secret-lines').required = on;
        $('secret-lines-switch').textContent = on ? 'One line' : 'Several lines (a key, a certificate)';
        if (on) { $('secret-lines').value = text ?? $('secret-value').value; $('secret-value').value = ''; $('secret-lines').focus(); }
        else { $('secret-value').value = (text ?? $('secret-lines').value).split('\n')[0]; $('secret-lines').value = ''; }
    };
    $('secret-lines-switch').addEventListener('click', () => secretLines($('secret-lines').hidden));
    $('secret-value').addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') ?? '';
        if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return;
        event.preventDefault();
        secretLines(true, text.replace(/\r\n?/g, '\n'));
    });
    $('secret-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true; $('attach-error').hidden = true;
        const lines = !$('secret-lines').hidden;
        /* A key's last line ends with a line break: kept as it was pasted. */
        const value = lines ? $('secret-lines').value.replace(/\r\n?/g, '\n') : $('secret-value').value;
        const expires = $('secret-expires').value;
        const name = $('secret-name').value.trim();
        try {
            await post(`${API}/secrets`, { name, value, ...(expires ? { expires } : {}) });
            $('secret-name').value = ''; $('secret-expires').value = ''; secretLines(false, '');
            await assetMade($('secret-box'), { key: `secret:${name}`, name, give: async (to) => {
                await handTo(to, name, true, 'attach-error');
                $('secret-note').textContent = `${name} will be handed to the tool the next time it starts (leave the tool, then "Start it again").`;
            } });
        } catch (error) { newAssetError($('secret-box'), error.message); }
        await paintAssets();
    });

    /* ---------- who gets what, and flows: see links.js ---------- */
    /* What those sheets share with the rest of the page: the requests, the
       automatic sending form of Access, the share sheet for a device to pair. */
    const links = DEVICE ? undefined : window.clavariumLinks?.({
        API: () => API, refresh, focusTerminal, openAssets: () => { void openAssets(); }, newDevice: () => newDevice(''), newConversation: () => createFromMap(),
        newAsset: () => newAssetFromMap(),
        autoSending: (conversation, name) => autoSending(conversation, name),
        partsFor: (name) => partsFor(name),
        deviceCard: (id) => { const d = sharedDevices.find((x) => x.id === id); return d ? deviceCard(d, '', true) : null; },
        /* The map says when it turns to its flows by itself (a box's "Trace it"). */
        modeIs: (mode) => { if (mode !== mapMode) { mapMode = mode; paintTabs(); subStep(); } },
        /* Its box rising from the bottom on a phone: over the screen, closed by Back. */
        sheetOpened: (close) => { nav.over('map-sheet', () => close()); },
        sheetClosed: () => { nav.dropOver('map-sheet'); },
        toFlows: () => openAccessPage('map', { mode: 'flows' }),
        leave: () => leavePlace(),
        pairNew: async (grants, label) => { await openCompose(grants.map((g) => [g.asset, g.rights])); $('sharing-label').value = label; sayChoice(); },
    });

    /* ---------- THE PLACES OF THE MENU: Assets, Access, Settings ---------- */
    /* Each fills the screen beside the list (the whole screen on a phone),
       with an address of its own (?open=access&tab=flows&for=garden): a
       reload, a link and Back find it again, and the names of the screens
       that came before (links, flows, devices, sharing) lead to it. Opened
       from the conversations, a place is one step; another place of the menu
       takes the place of the first, so that the conversations stay one Back
       away. Inside Access, its flows and the list of all devices are a step
       over the map; inside Assets, one asset opened. */
    const TABS = ['map', 'devices'];
    const FORMER = { access: ['map', 'map'], map: ['map', 'map'], links: ['map', 'map'], 'who-gets-what': ['map', 'map'], flows: ['map', 'flows'], devices: ['map', 'map'], sharing: ['map', 'map'] };
    let place = 'conversations';
    let accessTab = 'map'; let mapMode = 'map'; let accessFor = '';
    let placeFrom = 'list';      /* the screen (list or room) a place goes back to */
    let composing = false;       /* what a device gets, being chosen (a step of its own, or the place itself) */
    function showPlace(which) {
        place = which;
        app.dataset.place = which;
        app.dataset.current = current ? 'yes' : '';
        /* A new conversation is made among the conversations: "+ New" stays marked while its page is open. */
        const marked = which === 'new' ? 'conversations' : which;
        for (const b of $('nav').querySelectorAll('button[data-place]')) { if (b.dataset.place === marked) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
        $('new').setAttribute('aria-pressed', String(which === 'new'));
        $('access').hidden = which !== 'access';
        $('settings').hidden = which !== 'settings';
        $('assets').hidden = which !== 'assets';
        $('deck').hidden = which !== 'deck';
        $('salon').hidden = which !== 'salon'; $('salon-new').hidden = which !== 'salon-new';
        /* The places of the whole have a part of the page of their own, over the conversation (03-11). */
        $('places').hidden = !['access', 'settings', 'assets', 'deck', 'new', 'salon', 'salon-new'].includes(which);
        if (which !== 'salon') { try { salonLeft(); } catch { /* not yet set up */ } }
        $('newconv').hidden = which !== 'new';
        if (which !== 'access') composing = false;
        /* What the conversation had open (its tab) waits under the place, as it was. */
        if (which !== 'conversations') { for (const id of ['files', 'copy']) $(id).hidden = true; view('room'); }
        if (which !== 'assets' || !$('assets').contains($('gitview'))) shutGit();
    }
    function placeAddress() {
        const q = new URLSearchParams();
        if (current) q.set('c', current);
        if (place !== 'conversations') q.set('open', place);
        if (place === 'assets' && assetOpen) q.set('a', assetOpen);
        if (place === 'assets' && assetOpen && assetOpen === listOpen && assetsView?.place.page === 'card') q.set('card', assetsView.place.card);
        if (place === 'access') { q.set('tab', accessTab === 'map' && mapMode === 'flows' ? 'flows' : accessTab); if (accessFor) q.set('for', accessFor); }
        const query = q.toString();
        return query ? `?${query}` : location.pathname;
    }
    const remember = () => { if (!DEVICE) nav.replace(placeAddress()); };
    /* `push`: false when the address itself asked for it (a reload, Back to an entry of before). */
    function enterPlace(which, push = true) {
        if (place === 'conversations') {
            placeFrom = app.dataset.view === 'room' ? 'room' : 'list';
            nav.cut(nav.first(['review', 'over', 'create']));
            showPlace(which);
            if (push && !DEVICE) { nav.push('place', ({ quiet }) => leftPlace(quiet), { address: placeAddress() }); return; }
        } else {
            /* Another place of the menu: what was open in the one before goes. */
            const p = nav.last(['place']);
            nav.cut(p >= 0 ? p + 1 : nav.first(['sub', 'asset', 'compose', 'create', 'review', 'over']));
            showPlace(which);
        }
        remember();
    }
    /* The place closed: what it covered is there again. */
    function leftPlace(quiet) {
        if (place === 'conversations') return;
        showPlace('conversations');
        if (quiet) return;
        view(placeFrom === 'list' || !current ? 'list' : 'room');
        focusTerminal();
    }
    /* "< Conversations", Escape, the item Conversations of the menu (`list`: the list itself). */
    function leavePlace({ list = false } = {}) {
        if (place !== 'conversations') {
            const p = nav.last(['place']);
            if (p >= 0) nav.cut(p, { loud: true });
            else { nav.cut(nav.first(['sub', 'asset', 'compose', 'create', 'review', 'over'])); leftPlace(false); remember(); }
        }
        if (list && !nav.close('room')) view('list');
    }
    /* How many devices were given something: said on the link of the map that lists them. */
    function paintDeviceCount() { $('map-all-devices').textContent = sharedDevices.length > 0 ? `All devices (${sharedDevices.length})` : 'All devices'; }
    function paintTabs() {
        $('access-map').hidden = accessTab !== 'map';
        $('sharing').hidden = accessTab !== 'devices';
        for (const b of $('map-mode').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mapMode));
        if (accessFor && !conversations.some((c) => c.name === accessFor)) accessFor = '';
        $('access-for').hidden = !accessFor;
        $('access-for-name').textContent = accessFor;
    }
    /* Inside Access: the flows, or all the devices, are a step over the map; the map again closes it. */
    const deeper = () => accessTab === 'devices' || mapMode === 'flows';
    function subStep() {
        const sub = nav.last(['sub']);
        if (deeper()) {
            if (sub >= 0) nav.cut(sub + 1);
            else nav.push('sub', ({ quiet }) => {
                accessTab = 'map'; mapMode = 'map'; face('manage');
                if (!quiet && place === 'access') { paintTabs(); remember(); void links?.open({ pin: accessFor ? `conversation:${accessFor}` : null }); }
            }, { address: placeAddress() });
        } else if (sub >= 0) nav.cut(sub);
        remember();
    }
    /* `of`: the conversation it is filtered on ('' for none; left as it is when not given).
       `face`: on the devices tab, 'compose' keeps what openCompose prepared. */
    /* BINDER'S SCREEN (clavarium-binder), where a list is seen: one list of Assets opened, a
       conversation's Lists tab. Binder has no filter: the lists it is answered are cut here to
       those `keep` says. Every screen shown is read again when the lists changed. */
    let binderPeople = []; let binderChanges = -1; let binderTimer = null; let binderParts = null;
    const binderViews = new Set();
    function binderLang() { return /^fr\b/i.test(navigator.language ?? '') ? 'fr' : 'en'; }
    function binderCall(op, args) {
        return fetch(`${API}/binder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, args }) })
            .then((r) => r.json()).catch(() => ({ ok: false, text: 'The server could not be reached.' }));
    }
    /* What a page drew from the lists, to know when they changed. */
    function binderSig(lists) { return JSON.stringify((Array.isArray(lists) ? lists : []).map((l) => [l.id, l.title, l.archived, l.count, l.grants])); }
    /* `of`: the conversation its cards are of (its Binders tab); else the one the list was given to. */
    async function mountBinder(holder, keep, { onLists, of, place: at = null, steps = null } = {}) {
        binderParts ??= Promise.all([import(new URL('vendor/binder-ui.js', new URL('/', location.href)).href), fetch(`/vendor/binder-${binderLang()}.json`).then((r) => r.json()).catch(() => ({}))]);
        const [[{ mount }, words], seen] = await Promise.all([binderParts, getJson('/binder/people', null)]);
        if (seen) { binderPeople = seen.people; binderChanges = seen.changes; }
        if (!holder.isConnected) return null;
        let shown = [];
        const whose = () => {
            if (of) return of();
            const given = [...new Set(shown.flatMap((l) => Object.keys(l.grants ?? {})).filter((k) => k.startsWith('conversation:')).map((k) => k.slice('conversation:'.length)))];
            return given.includes(current) ? current : given[0] ?? '';
        };
        const view = mount(holder, {
            words, lang: binderLang(), people: () => binderPeople,
            call: async (op, args) => {
                const r = await binderCall(op, args);
                if (op === 'lists' && r.ok && Array.isArray(r.data)) { onLists?.(r.data); r.data = r.data.filter(keep); shown = r.data; }
                return r;
            },
            /* A thing attached opens where this page opens it. */
            openAttached: (a) => {
                if (a.kind === 'asset') void openAssetsPlace(a.ref);
                else if (a.kind === 'message') void openCardMessage(whose(), a.ref);
                else if (a.kind === 'file') void openCardFile(whose(), a.ref);
                else if (a.kind === 'mail') openCardMail(whose(), a);
                else if (a.kind === 'commit' || a.kind === 'branch') void openCardGit(whose(), a.ref, a.kind);
                else if (a.kind === 'link' && /^https?:\/\//i.test(a.ref)) window.open(a.ref, '_blank', 'noopener');
            },
            /* Where it is: a step of this page's Back (below). */
            place: at, onPlace: steps?.onPlace, onBack: steps?.onBack,
            /* ACT (02-11): quick actions suggested for a card (server/suggest.mjs); done here. */
            ...(DEVICE ? {} : { actions: (r, l) => cardActions(r, l, whose), discuss: (r, l) => discussCard(r, l, whose), endings: (r, l, kind) => endCard(r, l, kind) }),
        });
        binderViews.add({ box: holder.firstElementChild, view });
        watchBinders();
        return view;
    }
    /* The conversation that carries a card: an assistant among its owners, else the one the binder is given to. */
    const carrierOf = (r, whose) => (r.owners ?? []).find((o) => o.startsWith('conversation:'))?.slice('conversation:'.length) || whose();
    const dayAfter = (days) => { const d = new Date(Date.now() + days * 86_400_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
    /* A card's two endings, archived either way: done (to its done state), or dropped (a note says so). */
    async function endCard(r, l, kind, why = '') {
        if (kind === 'done') { const end = (l.states ?? []).find((x) => x.done); if (end) await binderCall('move', { id: r.id, state: end.id }); }
        else await binderCall('note', { id: r.id, text: `Dropped: no longer relevant${why ? ` (${why})` : ''}.` });
        await binderCall('archive', { id: r.id });
    }
    async function cardActions(r, l, whose) {
        const got = await post(`${API}/binder/suggest`, { id: r.id }).catch(() => null);
        return (got?.actions ?? []).map((a) => ({ label: a.label, why: a.why, run: async () => {
            if (a.key === 'done') { const end = (l.states ?? []).find((x) => x.done); if (end) await binderCall('move', { id: r.id, state: end.id }); return; }
            if (a.key === 'done-archive') { await endCard(r, l, 'done'); return; }
            if (a.key === 'drop') { await endCard(r, l, 'drop', a.why); return; }
            if (a.key === 'postpone-day' || a.key === 'postpone-week') { await binderCall('edit', { id: r.id, due: dayAfter(a.key === 'postpone-day' ? 1 : 7) }); return; }
            if (a.key === 'urgency-up' || a.key === 'urgency-down') { const u = Number(r.fields?.urgence ?? 50); await binderCall('edit', { id: r.id, fields: { urgence: Math.max(0, Math.min(100, u + (a.key === 'urgency-up' ? 20 : -20))) } }); return; }
            /* Work for an assistant: asked in its chat, where the person follows and approves. */
            const name = carrierOf(r, whose);
            if (!name) return;
            await post(talkPath(name), { text: `Card #${r.id} « ${r.title} » (${l.title}): ${a.ask}` });
            if (toConversation(name)) goTab('chat');
        } }));
    }
    /* Discuss a card: its assistant's chat, the card named in what is being written -- the person finishes it. */
    function discussCard(r, l, whose) {
        const name = carrierOf(r, whose);
        if (!name || !toConversation(name)) return;
        goTab('chat');
        setTimeout(() => {
            const box = document.querySelector('#chat textarea.parley-box, textarea.parley-box');
            if (!box) return;
            box.value = `About card #${r.id} « ${r.title} » (${l.title}): `;
            box.dispatchEvent(new Event('input', { bubbles: true })); box.focus();
        }, 400);
    }
    /* A card's thing attached, of its conversation: that conversation shown first (from a place, or another one). */
    function toConversation(name) {
        if (!name || !conversations.some((c) => c.name === name)) return false;
        if (place !== 'conversations') leavePlace();
        if (current !== name) select(name);
        return true;
    }
    /* A message of its chat: the Chat tab, at that message (Parley's reveal, by its id as read shows it). */
    async function openCardMessage(name, ref) {
        if (DEVICE || !toConversation(name)) return;
        goTab('chat');
        for (let i = 0; i < 50 && !(thread && threadOf === name); i++) await new Promise((r) => setTimeout(r, 100));
        if (thread && threadOf === name && current === name && typeof thread.reveal === 'function') await thread.reveal(String(ref ?? '').trim());
    }
    /* A file of its shared folders (/work/..., /resources/NAME/...; a path without a folder is of /work): the viewer, as from the chat. */
    function openCardFile(name, ref) {
        const path = String(ref ?? '').trim().replace(/^file:/, '');
        const m = /^\/(work|resources\/[^/]+)\/(.+)$/.exec(path.startsWith('/') ? path : `/work/${path}`);
        if (DEVICE || !m || m[2].split('/').includes('..') || !toConversation(name)) return;
        const tab = m[1] === 'work' ? 'work' : m[1].slice('resources/'.length);
        void preview(tab, m[2], m[2].split('/').pop(), 0);
    }
    /* A mail of a card (06-11): its reference (mail:...) opens the mail viewer; a mail file (.eml), as a file;
       an old bare id, where the server can still read it (else it says so, in the viewer). */
    function openCardMail(name, a) {
        const ref = String(a.ref ?? '').trim();
        if (!ref.startsWith('mail:') && /\.eml$/i.test(ref)) { openCardFile(name, ref); return; }
        void openMailRef(ref, { label: a.title, of: name });
    }
    /* A MAIL CITED BY ITS REFERENCE (mail:TARGET/MESSAGE-ID, 06-11): the viewer of the .eml files, over the
       page, its bytes read by the server through Tether when it is opened -- never before, kept nowhere --
       and only by whoever may read that mailbox. `of`: the conversation it was cited in, whose chat Reply
       writes in. */
    function openMailRef(ref, { label = '', of = current } = {}) {
        const q = new URLSearchParams({ ref, ...(of ? { c: of } : {}) });
        const name = `${String(label || '').trim() || uiSaid('set-mail-mail', 'Mail')}.eml`;
        return preview('', '', name, 0, `${API}/mail/open?${q}`, { mailRef: { ref, of, label } });
    }
    /* Reply, from the viewer: nothing is sent -- the chat of its conversation is given the start of a request
       to its AI (« Reply to this mail: » and the reference), for the person to finish and send. */
    async function replyToMail({ ref, of }) {
        closePreview();
        if (!DEVICE && of && of !== current && !toConversation(of)) return;
        goTab('chat');
        for (let i = 0; i < 40; i++) {
            const box = document.querySelector('#chat textarea.parley-box, #simple-thread textarea.parley-box, textarea.parley-box');
            if (box && box.offsetParent !== null) {
                box.value = `${uiSaid('set-mail-reply-ask', 'Reply to this mail:')} ${ref}\n`;
                box.dispatchEvent(new Event('input', { bubbles: true })); box.focus();
                box.setSelectionRange?.(box.value.length, box.value.length);
                return;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    /* A commit or a branch of a repository of its conversation (ref "repository:sha" / "repository:branch"): the git review, at it. */
    function openCardGit(name, ref, kind) {
        const raw = String(ref ?? '').trim(); const at = raw.indexOf(':');
        if (at < 1 || DEVICE || !toConversation(name)) return;
        const repo = raw.slice(0, at); const rest = raw.slice(at + 1).trim();
        if (!repo || !rest) return;
        void openGit(repo, kind === 'commit' ? { commit: rest } : { branch: rest });
    }
    /* ATTACH TO A CARD (#180): from where a thing is (a file shown, a message of the chat), a card
       picked among the binders this page may write in -- by its title, typed or scrolled -- and
       the thing attached to it, as the agent attaches with `binder attach`. */
    async function attachToCard({ kind, ref, title }) {
        document.getElementById('attach-pick')?.remove();
        const box = document.createElement('div'); box.id = 'attach-pick'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Attach to a card');
        const card = document.createElement('div'); card.className = 'attach-card';
        const head = document.createElement('div'); head.className = 'row';
        const h = document.createElement('b'); h.textContent = 'Attach to a card';
        const sp = document.createElement('span'); sp.className = 'sp';
        const x = document.createElement('button'); x.type = 'button'; x.textContent = '\u00d7'; x.setAttribute('aria-label', 'Close');
        head.append(h, sp, x);
        const what = document.createElement('p'); what.className = 'dim attach-what'; what.textContent = title || ref;
        const find = document.createElement('input'); find.type = 'search'; find.placeholder = 'Find a card'; find.setAttribute('aria-label', 'Find a card');
        const list = document.createElement('div'); list.className = 'attach-list';
        const said = document.createElement('p'); said.className = 'attach-said'; said.hidden = true;
        card.append(head, what, find, list, said); box.append(card); document.body.append(box);
        const close = () => { box.remove(); document.removeEventListener('keydown', esc, true); };
        const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        document.addEventListener('keydown', esc, true);
        x.onclick = close; box.addEventListener('pointerdown', (e) => { if (e.target === box) close(); });
        list.textContent = 'Loading...';
        /* The cards of every binder this page may change, the conversation's own binder first. */
        const lists = ((await binderCall('lists', {})).data ?? []).filter((l) => !l.archived && l.access === 'write');
        const own = (l) => Object.keys(l.grants ?? {}).includes(`conversation:${current}`);
        lists.sort((a, b) => Number(own(b)) - Number(own(a)));
        const cards = [];
        for (const l of lists.slice(0, 12)) { const r = await binderCall('show', { list: l.id }); for (const rec of r.data?.records ?? []) cards.push({ list: l, rec }); }
        const draw = () => {
            const q = find.value.trim().toLowerCase();
            const shown = cards.filter(({ rec, list: l }) => !q || `#${rec.n} ${rec.title} ${l.title}`.toLowerCase().includes(q)).slice(0, 80);
            list.replaceChildren(...(shown.length ? shown.map(({ rec, list: l }) => {
                const b = document.createElement('button'); b.type = 'button'; b.className = 'attach-item';
                const t = document.createElement('span'); t.textContent = `#${rec.n} ${rec.title}`;
                const w = document.createElement('small'); w.textContent = l.title;
                b.append(t, w);
                b.onclick = async () => {
                    for (const o of list.querySelectorAll('button')) o.disabled = true;
                    const r = await binderCall('attach', { id: rec.id, kind, ref, ...(title ? { title } : {}) });
                    said.hidden = false; said.textContent = r.ok ? `Attached to #${rec.n} ${rec.title}.` : (r.text || 'Not attached.');
                    said.classList.toggle('bad', !r.ok);
                    if (r.ok) setTimeout(close, 1400); else for (const o of list.querySelectorAll('button')) o.disabled = false;
                };
                return b;
            }) : [Object.assign(document.createElement('p'), { className: 'dim', textContent: cards.length ? 'No card by that name.' : 'No binder you can write in.' })]));
        };
        find.addEventListener('input', draw);
        draw();
        find.focus();
    }
    /* Read again every screen of a binder when the binders changed. Taken as seen only once every
       screen read it again: one that failed (the server restarting) is read again at the next turn. */
    async function catchUpBinders() {
        const now = await getJson('/binder/people', null);
        if (!now) return;
        binderPeople = now.people;
        if (now.changes === binderChanges) return;
        const read = await Promise.all([...binderViews].map((one) => Promise.resolve(one.view.refresh()).then((ok) => ok !== false, () => false)));
        if (read.every(Boolean)) binderChanges = now.changes;
    }
    function watchBinders() {
        if (binderTimer) return;
        binderTimer = setInterval(() => {
            for (const one of binderViews) if (!one.box?.isConnected) { one.view.destroy(); binderViews.delete(one); }
            if (binderViews.size === 0) { clearInterval(binderTimer); binderTimer = null; return; }
            if (!document.hidden) void catchUpBinders();
        }, 4000);
    }
    /* Back on the page (a tablet woken, a tab shown again): looked at at once, not 4 s later. */
    document.addEventListener('visibilitychange', () => { if (!document.hidden && binderViews.size) void catchUpBinders(); });
    /* WHERE A BINDER IS, IN THIS PAGE'S BACK: a card (or a binder's settings) is one step over
       its list; Back, Escape and its "‹" close it, and the list is there again. Another binder
       picked takes no step. `viewOf()`: the screen shown now (it may be drawn again).
       `address(place)`: the address of what is shown. `covered()`: a card opened from
       elsewhere (`from`) whose way back is already a step of this page (the tab it opened);
       `fromBack()` takes it. `fromClose()`: the step of such a card closed, where it came from shown. */
    function binderSteps(viewOf, { address = () => {}, covered = () => false, fromBack = () => false, fromClose = () => {} } = {}) {
        let step = null;
        return {
            onPlace(p) {
                if (p.page === 'list') { if (step) { const s = step; step = null; s.gone = true; nav.drop(s); } }
                else if (!step && !(p.from && covered())) {
                    const from = p.from;
                    const s = nav.push('binder', ({ quiet }) => {
                        if (s.gone) return;
                        if (step === s) step = null;
                        const view = viewOf();
                        void view?.go({ list: view.place.list }).then(() => { if (!quiet) address(view.place); });
                        if (!quiet && from) fromClose();
                    });
                    step = s;
                }
                address(p);
            },
            onBack(p) {
                if (step) { nav.drop(step); return true; }
                return p.from && covered() ? fromBack() : false;
            },
        };
    }
    async function openAccessPage(tab = accessTab, { mode, of, face: shown = 'manage', push = true, pin } = {}) {
        if (DEVICE) return;
        /* Assets left Access: a conversation's own, or the server's. */
        if (tab === 'assets') { if (of) { leavePlace(); goTab('assets'); } else await openAssetsPlace(undefined, { push }); return; }
        if (of !== undefined) accessFor = of;
        const arriving = place !== 'access';
        accessTab = TABS.includes(tab) ? tab : 'map';
        if (mode) mapMode = mode;
        else if (accessTab === 'devices') mapMode = 'map';
        if (arriving) enterPlace('access', push);
        else if (shown !== 'compose') { nav.cut(nav.first(['compose'])); composing = false; if (push) subStep(); else remember(); }
        paintTabs();
        /* A device may have been paired meanwhile: counted again on the way in. */
        if (arriving) void readDevices().then(paintDeviceCount);
        if (accessTab === 'map') {
            if (mapMode === 'flows') await links?.openFlows();
            else await links?.open({ pin: pin ?? (accessFor ? `conversation:${accessFor}` : null) });
        } else if (shown === 'compose') { paintCompose(); face('compose'); }
        else { face('manage'); await paintManage(); }
    }
    /* Back and forward to an entry this page did not make: walked by its address. */
    async function followAddress() {
        const q = new URLSearchParams(location.search);
        const wanted = q.get('c') ?? '';
        if (home && wanted !== current && conversations.some((c) => c.name === wanted)) select(wanted);
        const open = q.get('open') ?? '';
        if (open === 'new') { await openNew({ push: false }); return; }
        if (open === 'deck') { openDeck(false); return; }
        if (open === 'settings') {
            await openSettings({ push: false });
            /* A link to one chapter of Settings (?open=settings&at=resources): that one opened, and shown. */
            const at = q.get('at') ?? '';
            if (/^[a-z]{1,20}$/.test(at)) openChapter(`s-${at}`)?.scrollIntoView({ block: 'start' });
            return;
        }
        /* Assets, a place of its own now (it was a tab of Access); Lists, a kind of asset now. */
        /* A card of a binder of Assets (?open=assets&a=list:batches&card=3): that binder opened, on it. */
        const a = q.get('a') ?? ''; const card = q.get('card') ?? '';
        if (open === 'assets' && a.startsWith('list:') && /^\d{1,9}$/.test(card)) { listOpen = a; assetsAt = { list: a.slice(5), card }; }
        if (open === 'assets' || open === 'lists' || (open === 'access' && q.get('tab') === 'assets')) { await openAssetsPlace(q.get('a') ?? undefined, { push: false }); return; }
        const former = FORMER[open === 'access' ? (q.get('tab') ?? 'map') : open];
        if (former) { await openAccessPage(former[0], { mode: former[1], of: q.get('for') ?? '', push: false }); return; }
        leftPlace(false);
    }
    nav.outside = () => { if (!DEVICE) void followAddress(); };
    $('nav-conversations').addEventListener('click', () => { leavePlace({ list: true }); });
    $('nav-access').addEventListener('click', () => { if (place !== 'access' || accessTab !== 'map' || mapMode !== 'map') void openAccessPage('map', { mode: 'map' }); });
    $('nav-assets').addEventListener('click', () => { if (place !== 'assets') void openAssetsPlace(); });
    $('map-new-device').addEventListener('click', () => newDevice(accessFor));
    /* Every device and what each was given, by device or by thing: a step over the map. */
    $('map-all-devices').addEventListener('click', () => { void openAccessPage('devices'); });
    /* Voice boxes are on the page of all devices: opened there, at them. */
    $('map-voice-boxes').addEventListener('click', async () => { await openAccessPage('devices'); $('boxes')?.scrollIntoView({ block: 'start' }); });
    $('share-manage-close').addEventListener('click', () => { if (!nav.close('sub')) void openAccessPage('map', { push: false }); });
    $('nav-settings').addEventListener('click', () => { if (place !== 'settings') void openSettings(); });
    $('access-close').addEventListener('click', () => leavePlace());
    $('access-for-clear').addEventListener('click', () => { accessFor = ''; void openAccessPage(accessTab, { push: false }); });
    for (const b of $('map-mode').querySelectorAll('[data-mode]')) b.addEventListener('click', () => { if (b.dataset.mode !== mapMode || accessTab !== 'map') void openAccessPage('map', { mode: b.dataset.mode }); });
    /* From a conversation's own sheet: Access, on that conversation alone. */
    $('access-devices-here').addEventListener('click', () => { void openAccessPage('map', { of: current }); });

    /* ---------- Settings: this device, and the platform ---------- */
    /* ADMINISTRATORS: who may sign in (server/operators.mjs); a password is shown once, then never again. */
    async function paintOperators() {
        const got = await fetch(`${API}/operators`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        $('settings-ch-operators').hidden = !got || got.local === true;
        if (!got || got.local) return;
        const rows = $('operators-rows'); rows.replaceChildren();
        const act = async (path) => {
            $('operators-error').hidden = true;
            try { const r = await post(`${API}/operators/${encodeURIComponent(path[0])}/${path[1]}`, {}); if (r?.password) showPassword(r.email, r.password); }
            catch (error) { $('operators-error').textContent = error.message; $('operators-error').hidden = false; }
            await paintOperators();
        };
        for (const o of got.operators) {
            const row = el('div', 'list-item folder'); row.dataset.email = o.email;
            const name = el('div', 'set-what'); name.append(el('b', '', o.email));
            const word = o.locked ? `Locked until ${new Date(o.locked).toLocaleTimeString([], { timeStyle: 'short' })}` : o.enabled ? (o.email === got.me ? 'You' : '') : 'Disabled';
            if (word) name.append(el('small', '', word));
            const buttons = [['password', 'New password']];
            if (o.email !== got.me) buttons.push(o.enabled ? ['disable', 'Disable'] : ['enable', 'Enable'], ['remove', 'Remove']);
            const acts = el('div', 'set-control');
            acts.append(...buttons.map(([verb, label]) => { const b = el('button', verb === 'remove' ? 'danger' : '', label); b.type = 'button'; b.dataset.act = verb; b.addEventListener('click', () => void act([o.email, verb])); return b; }));
            row.append(name, acts);
            rows.append(row);
        }
    }
    function showPassword(email, password) {
        $('operators-password-for').textContent = email; $('operators-password-value').value = password; $('operators-password').hidden = false;
    }
    $('operators-password-copy').addEventListener('click', () => { void copyField($('operators-password-value'), $('operators-password-copy')); });
    $('operators-password-done').addEventListener('click', () => { $('operators-password-value').value = ''; $('operators-password').hidden = true; });
    $('operators-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('operators-error').hidden = true;
        try { const r = await post(`${API}/operators`, { email: $('operators-email').value.trim() }); showPassword(r.email, r.password); $('operators-email').value = ''; }
        catch (error) { $('operators-error').textContent = error.message; $('operators-error').hidden = false; }
        await paintOperators();
    });
    /* THE TABS OF A SETTINGS PAGE (settings redesign, 05-11): its groups -- General, (This device,) Resources, Access,
       Chat & voice, Automatic, Diagnostics, Advanced: the same names in the same order on every settings page -- one
       shown at a time. The one last shown is kept on this device. A tab whose group has nothing to show is hidden,
       the order of the others unchanged. While a search is typed, every group is searched and shown (CSS). */
    function settingsTabs(sheet) {
        const nav = sheet?.querySelector('.settings-tabs'); if (!nav) return;
        const buttons = [...nav.querySelectorAll('button[data-group]')];
        const groupOf = (key) => sheet.querySelector(`.settings-group[data-group="${key}"]`);
        const kept = `clavarium-tab-${sheet.id}`;
        const show = (key, { keep = true } = {}) => {
            for (const b of buttons) { const on = b.dataset.group === key; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
            for (const g of sheet.querySelectorAll('.settings-group[data-group]')) g.classList.toggle('tab-off', g.dataset.group !== key);
            sheet.dataset.tab = key;
            if (keep) try { localStorage.setItem(kept, key); } catch { /* a private window */ }
            const b = buttons.find((x) => x.dataset.group === key);
            if (b && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2);
        };
        /* Hidden: a tab whose chapters are all hidden (Usage, Administrators on this machine alone...). */
        const refresh = () => {
            if (sheet.dataset.searching === 'on') return;
            for (const b of buttons) { const g = groupOf(b.dataset.group); b.hidden = !g || ![...g.querySelectorAll('details.chapter')].some((d) => !d.hidden); }
            if (buttons.find((b) => b.dataset.group === sheet.dataset.tab)?.hidden) show(buttons.find((b) => !b.hidden)?.dataset.group ?? buttons[0].dataset.group, { keep: false });
        };
        for (const b of buttons) b.addEventListener('click', () => { show(b.dataset.group); b.focus(); });
        nav.addEventListener('keydown', (event) => {
            const shown = buttons.filter((b) => !b.hidden); const at = shown.findIndex((b) => b.dataset.group === sheet.dataset.tab);
            const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: shown.length - 1 }[event.key];
            if (to === undefined || !shown.length) return;
            event.preventDefault(); const b = shown[(to + shown.length) % shown.length]; show(b.dataset.group); b.focus();
        });
        let first = buttons[0].dataset.group;
        try { const k = localStorage.getItem(kept); if (buttons.some((b) => b.dataset.group === k)) first = k; } catch { /* as above */ }
        show(first, { keep: false });
        sheet.showTab = show; sheet.refreshTabs = refresh;
        new MutationObserver(() => refresh()).observe(sheet, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
        refresh();
    }
    for (const id of ['settings', 'panel']) settingsTabs($(id));

    /* THE WORDS OF THE SETTINGS PAGES in the screen's language (server/settingswords.mjs, served with the chat's,
       uiSaid): an element marked data-said="key" keeps its English as the fallback. */
    function saySettings() {
        for (const e of document.querySelectorAll('[data-said]')) { e.dataset.en ??= e.textContent; e.textContent = uiSaid(e.dataset.said, e.dataset.en); }
        for (const b of document.querySelectorAll('button.tip-btn')) b.setAttribute('aria-label', uiSaid('set-why', 'Why'));
        const s = document.querySelector('#settings .settings-search'); if (s) s.placeholder = uiSaid('set-search', 'Search');
        const p = document.querySelector('#panel .settings-search'); if (p) p.placeholder = uiSaid('set-search', 'Search');
    }
    void readWords().then(saySettings).catch(() => {});

    /* "WHY", BEHIND AN ⓘ (settings redesign, step 3): a row says what it is in one short line; the why behind
       the ⓘ beside its name, one click away. Any element .tip (hidden) gets its button. */
    function wireTips(root = document) {
        for (const tip of root.querySelectorAll('.tip')) {
            if (tip.dataset.wired) continue; tip.dataset.wired = '1'; tip.hidden = true;
            const b = document.createElement('button'); b.type = 'button'; b.className = 'tip-btn'; b.textContent = 'ⓘ';
            b.setAttribute('aria-label', uiSaid('set-why', 'Why')); b.setAttribute('aria-expanded', 'false');
            b.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); tip.hidden = !tip.hidden; b.setAttribute('aria-expanded', String(!tip.hidden)); });
            /* Beside the row's name, on its line. */
            const name = tip.closest('.set-what')?.querySelector(':scope > :is(b, span, label)');
            if (name) { const line = document.createElement('span'); line.className = 'with-tip'; name.before(line); line.append(name, b); continue; }
            /* A paragraph of its own: beside the heading or the line above it, else on a line of its own. */
            let above = tip.previousElementSibling; while (above?.hidden) above = above.previousElementSibling;
            if (above) { const head = above.querySelector(':scope > b'); if (head) head.after(b); else above.append(b); }
            else { const line = document.createElement('div'); line.className = 'tip-head'; line.append(b); tip.before(line); }
        }
    }
    wireTips();

    /* WHAT A FOLDED CHAPTER SAYS (settings redesign, step 1): its state now, in a few words, where a description
       was -- often enough not to open it. */
    function chapterNow(key, text) {
        const about = document.querySelector(`details.chapter[data-chapter="${key}"] > summary .chapter-about`);
        if (about && text !== undefined && text !== null) about.textContent = text;
    }
    const agoSaid = (t) => { const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60_000)); return m < 1 ? uiSaid('set-just-now', 'just now') : m < 60 ? uiSaid('set-min-ago', '{n} min ago', { n: m }) : m < 48 * 60 ? uiSaid('set-h-ago', '{n} h ago', { n: Math.round(m / 60) }) : uiSaid('set-days-ago', '{n} days ago', { n: Math.round(m / 1440) }); };

    /* AT HAND: three tiles -- memory, disk, CPU -- each its share now, a bar, the last hour in a small line, and
       what is left in words; a click opens Resources. From what is read already (/api/server, a machine's health,
       /api/history): no new call to the server. */
    const levelAt = (p, high = false) => (p >= 95 ? 'bad' : p >= 85 || high ? 'warn' : 'ok');
    function handTile(label, percent, sub, values, level, reservePercent) {
        const t = el('button', 'tile'); t.type = 'button'; t.dataset.level = level;
        const k = el('span', 'tile-k'); k.append(el('b', '', label), el('span', 'tile-n', percent === null ? '—' : `${Math.round(percent)} %`));
        const bar = el('span', 'tile-bar'); const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`; bar.append(fill);
        if (Number.isFinite(reservePercent) && reservePercent > 0 && reservePercent < 100) { const u = el('u'); u.style.width = `${reservePercent}%`; bar.append(u); }
        t.append(k, bar);
        const known = (values ?? []).map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
        if (known.length > 1) {
            const n = values.length - 1; let d = '';
            for (const [i, v] of known) d += `${d ? 'L' : 'M'}${((i / n) * 100).toFixed(1)},${(22 - (v / 100) * 20).toFixed(1)}`;
            const svg = svgEl('svg', { viewBox: '0 0 100 22', preserveAspectRatio: 'none', class: 'tile-spark', 'aria-hidden': 'true' });
            svg.append(svgEl('path', { d, 'vector-effect': 'non-scaling-stroke' })); t.append(svg);
        }
        t.append(el('span', 'tile-sub', sub));
        t.setAttribute('aria-label', `${label}: ${percent === null ? '—' : `${Math.round(percent)} %`}, ${sub}`);
        return t;
    }
    const lastOf = (values) => { for (let i = (values?.length ?? 0) - 1; i >= 0; i -= 1) if (values[i] !== null && values[i] !== undefined) return values[i]; return null; };
    const handHistory = async (of) => (of ? fetch(`${API}/history?of=${encodeURIComponent(of)}&span=1h`).then((x) => (x.ok ? x.json() : null)).catch(() => null) : null);
    /* A chip: a dot of its state and a word -- only when it says something. */
    const handChip = (tone, text, go) => { const c = el(go ? 'button' : 'span', 'hand-chip', text); c.dataset.tone = tone; if (go) { c.type = 'button'; c.addEventListener('click', go); } return c; };

    /* The server's: under the top bar of Settings. */
    let lastServer = null;
    async function paintSettingsHand(r = lastServer) {
        if (DEVICE) return;
        lastServer = r;
        $('settings-hand').hidden = false;
        const h = await handHistory('server');
        const tiles = [];
        const go = () => { openChapter('s-resources')?.scrollIntoView({ block: 'start' }); };
        if (r?.memory) { const m = r.memory; tiles.push(handTile(uiSaid('set-memory', 'Memory'), m.usedPercent, uiSaid('set-free-of', '{free} free of {total}', { free: GB(m.freeMb), total: GB(m.totalMb) }), h?.memory, levelAt(m.usedPercent, r.high?.memory), r.reserve?.memoryMb && m.totalMb ? (r.reserve.memoryMb / m.totalMb) * 100 : null)); }
        const disk = r?.disk?.disks?.find((d) => d.holds?.includes('machines')) ?? r?.disk?.disks?.[0];
        if (disk) tiles.push(handTile(uiSaid('set-disk', 'Disk'), disk.usedPercent, uiSaid('set-free-of', '{free} free of {total}', { free: GB(disk.freeMb), total: GB(disk.sizeMb) }), h?.disk, levelAt(disk.usedPercent, r.high?.disk), r.reserve?.diskMb && disk.sizeMb ? (r.reserve.diskMb / disk.sizeMb) * 100 : null));
        const cpu = lastOf(h?.cpu);
        if (h) { const most = Math.max(0, ...(h.cpu ?? []).filter((v) => v !== null)); tiles.push(handTile(uiSaid('set-cpu', 'CPU'), cpu, uiSaid('set-highest', 'highest {n} % in 1 h', { n: Math.round(most) }), h.cpu, levelAt(cpu ?? 0))); }
        for (const t of tiles) t.addEventListener('click', go);
        $('settings-tiles').replaceChildren(...tiles); $('settings-tiles').hidden = tiles.length === 0;
        paintSettingsFacts();
    }
    /* Its chips: the version, a conversation that is not well, a voice box away. */
    let handWifi = null;
    function paintSettingsFacts() {
        const chips = [];
        const u = lastUpdates;
        if (u?.installed) {
            if (u.available) chips.push(handChip('warn', uiSaid('set-update-out', '{v} is out', { v: u.available.version ?? u.available }), () => { openChapter('s-updates')?.scrollIntoView({ block: 'start' }); }));
            else if (u.version) chips.push(handChip('ok', uiSaid('set-up-to-date', 'Up to date · {v}', { v: u.version })));
        }
        if (handWifi?.using?.ssid) chips.push(handChip('ok', uiSaid('set-wifi-on', 'Wi-Fi · {name}', { name: handWifi.using.ssid })));
        for (const c of conversations.filter((x) => (x.health?.problems ?? []).some((p) => p.level === 'warn' || p.level === 'bad'))) {
            const bad = c.health.problems.some((p) => p.level === 'bad');
            chips.push(handChip(bad ? 'bad' : 'warn', `${c.title || c.name} · ${uiSaid('set-not-well', 'not well')}`, () => select(c.name, { step: true })));
        }
        for (const b of (handBoxes ?? []).filter((x) => x.online === false)) chips.push(handChip('off', uiSaid('set-box-away', '{name} offline', { name: b.name })));
        $('settings-facts').replaceChildren(...chips); $('settings-facts').hidden = chips.length === 0;
    }
    let handBoxes = null;
    $('hand-check').addEventListener('click', () => { const sheet = $('settings'); sheet.showTab?.('automatic'); openChapter('s-updates'); $('updates-check').click(); $('settings-updates-top').scrollIntoView({ block: 'start' }); });
    $('hand-activity').addEventListener('click', () => { openChapter('s-events')?.scrollIntoView({ block: 'start' }); });
    $('hand-restart').addEventListener('click', () => { openChapter('s-advanced'); $('server-restarts').scrollIntoView({ block: 'center' }); });
    /* THE STATE OF EACH FOLDED CHAPTER OF SETTINGS, read from what its own painting left (and three small looks:
       network, remote screen, the last thing that happened). Painted again when a chapter is folded. */
    const optionText = (id) => { const s = $(id); return s?.selectedOptions?.[0]?.textContent?.replace(/\s*\(.*\)$/, '') ?? ''; };
    const levelsWord = (id) => [...($(id)?.children ?? [])].find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent ?? '';
    async function paintSettingsStates() {
        if (DEVICE) return;
        const join = (...parts) => parts.filter(Boolean).join(' · ');
        chapterNow('s-screen', join(levelsWord('theme'), document.querySelector('#settings-text .text-now')?.textContent));
        const alerts = $('alerts-state').textContent.trim();
        chapterNow('s-alerts', alerts.length <= 30 ? alerts : alerts.split(/[.,:;]/)[0]);
        chapterNow('s-words', join(optionText('words-lang') === 'The language of each device' ? uiSaid('set-lang-device', 'Each device\'s language') : optionText('words-lang'), optionText('chat-window')));
        const levels = [...document.querySelectorAll('#thread-levels select')].filter((x) => [...x.options].some((o) => /\(default\)/.test(o.textContent)));
        const changed = levels.filter((x) => !/\(default\)/.test(x.selectedOptions[0]?.textContent ?? '')).length;
        chapterNow('s-thread', changed ? uiSaid('set-changed', '{n} changed', { n: changed }) : uiSaid('set-as-given', 'As given'));
        const shortcuts = [...document.querySelectorAll('#settings-shortcuts .list-item b')].map((b) => b.textContent);
        chapterNow('s-shortcuts', shortcuts.length ? shortcuts.slice(0, 3).join(' · ') + (shortcuts.length > 3 ? ` +${shortcuts.length - 3}` : '') : uiSaid('set-none', 'None'));
        if ($('binders-agent-lists').value !== '') chapterNow('s-binders', uiSaid('set-binders-max', 'Agents make up to {n}', { n: $('binders-agent-lists').value }));
        const admins = $('operators-rows').children.length;
        chapterNow('s-operators', admins ? uiSaid(admins === 1 ? 'set-admin-1' : 'set-admins', admins === 1 ? '1 administrator' : '{n} administrators', { n: admins }) : '');
        chapterNow('s-backup', uiSaid('set-backup-now', 'Export · import'));
        const shelf = $('shelf-state').textContent.split(' · ')[0];
        const keys = $('git-hosts').children.length;
        chapterNow('s-advanced', join(shelf, uiSaid(keys === 1 ? 'set-git-key' : 'set-git-keys', keys === 1 ? '1 git key' : '{n} git keys', { n: keys }), uiSaid('set-restart', 'restart')));
        chapterNow('s-about', $('settings-about').textContent);
        chapterNow('s-logs', uiSaid('set-logs-now', 'Clavarium, machines, system'));
        const u = lastUpdates;
        if (u?.installed) chapterNow('s-updates', join(u.available ? uiSaid('set-update-out', '{v} is out', { v: u.available.version ?? u.available }) : uiSaid('set-up-to-date', 'Up to date · {v}', { v: u.version }), optionText('updates-channel').split(' ')[0], optionText('updates-mode').split(',')[0]));
        else if (u) chapterNow('s-updates', u.version ? `Clavarium ${u.version}` : '');
        const [wifi, mesh, events] = await Promise.all([
            fetch(`${API}/wifi`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`${API}/meshcentral`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`${API}/events?limit=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        handWifi = wifi;
        if (wifi) chapterNow('s-network', wifi.using?.ssid ? uiSaid('set-wifi-on', 'Wi-Fi · {name}', { name: wifi.using.ssid }) : (wifi.links ?? []).some((l) => l.kind === 'cable' && l.address) ? uiSaid('set-cable', 'Cable') : uiSaid('set-wifi-off', 'Wi-Fi not in use'));
        if (mesh) chapterNow('s-remote-screen', mesh.running ? uiSaid('set-on', 'On') : uiSaid('set-off', 'Off'));
        const last = Array.isArray(events) ? events[0] : null;
        if (last) chapterNow('s-events', `${agoSaid(last.at)} · ${String(last.text).slice(0, 60)}`);
        handBoxes = await fetch(`${API}/boxes`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        paintSettingsFacts();
    }
    for (const d of document.querySelectorAll('#settings details.chapter')) d.addEventListener('toggle', () => { if (!d.open) void paintSettingsStates(); });
    async function openSettings({ push = true } = {}) {
        enterPlace('settings', push);
        void paintSettingsFeatures().catch(() => {});
        void paintAlerts().catch(() => {});
        void paintWords().catch(() => {});
        void paintThreadLevels().catch(() => {});
        void paintBinderSettings().catch(() => {});
        void paintChatWindow().catch(() => {});
        const [platform, saved] = await Promise.all([fetch(`${API}/platform`).then((r) => r.json()).catch(() => ({})), fetch(`${API}/shortcuts`).then((r) => r.json()).catch(() => [])]);
        const list = $('settings-shortcuts'); list.replaceChildren();
        for (const shortcut of saved) {
            const row = document.createElement('div'); row.className = 'list-item';
            const label = document.createElement('div'); label.className = 'set-what';
            const name = document.createElement('b'); name.textContent = shortcut.label;
            const what = document.createElement('small'); what.textContent = shortcut.enter ? 'Sends Enter' : 'Typed, not sent'; label.append(name, what);
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
            remove.addEventListener('click', async () => { await post(`${API}/shortcuts/${shortcut.id}/remove`).catch(() => {}); await openSettings(); void paintShortcuts(); });
            row.append(label, remove); list.append(row);
        }
        void paintDictation();
        void paintOperators();
        /* With no shortcut, one line: how to add one (this is the only place to remove them). */
        $('settings-shortcuts-hint').textContent = saved.length ? 'Added under the terminal, with "+ Shortcut".' : 'No shortcut yet · add one under the terminal, with "+ Shortcut".';
        $('settings-people').textContent = (platform.operators ?? []).length
            ? `Administrators: ${platform.operators.join(', ')}`
            : 'Development mode: anyone on this machine is the operator';
        $('settings-address').textContent = `Address: ${platform.address ?? 'not declared'}`;
        $('settings-about').textContent = `Clavarium ${platform.version ?? ''}`;
        void paintInstance();
        if ($('settings-wifi-top').open) void paintWifi();
        if ($('settings-mesh-top').open) void paintScreen();
        if ($('settings-usage-top').open) void paintUsage();
        await Promise.all([paintHosts(), paintShelf(), paintServer(), paintUpdates()]);
        await paintSettingsStates();
    }

    /* ---------- Dictation, in Settings: two engines, main and backup (server/voice.mjs, dictation-engines.mjs) ---------- */
    let dictationProviders = [];
    const DICT_SLOTS = { main: 'dictation', backup: 'dictation-backup' };
    const NEW_KEY = '__new';
    const dq = (slot, what) => $(`${DICT_SLOTS[slot]}-${what}`);
    const engineChoice = (slot) => ({ provider: dq(slot, 'provider').value, url: dq(slot, 'url').value.trim(), model: dq(slot, 'model').value.trim(),
        secret: dq(slot, 'secret').value === NEW_KEY ? '' : dq(slot, 'secret').value });
    const dictationLanguage = () => { const lang = $('dictation-language').value; return lang === 'other' ? $('dictation-language-code').value.trim() : lang; };
    const dictationChoice = () => ({ language: dictationLanguage(), main: engineChoice('main'), backup: engineChoice('backup') });
    const dictationSay = (error, saved = '') => {
        $('dictation-error').textContent = error ?? ''; $('dictation-error').hidden = !error;
        $('dictation-saved').textContent = saved;
    };
    const showLanguage = (code) => {
        const known = [...$('dictation-language').options].some((o) => o.value === code && code !== 'other');
        $('dictation-language').value = known ? code : 'other';
        $('dictation-language-code').value = known ? '' : code;
        $('dictation-language-code').hidden = known;
    };
    /* The name offered for a new key (dictation-engines.mjs, newKeyName). */
    const newKeyName = (provider, names) => {
        const base = `${provider === 'ovh' ? 'OVH_AI_ENDPOINTS' : String(provider).toUpperCase()}_DICTATION_KEY`;
        if (!names.includes(base)) return base;
        for (let i = 2; ; i++) if (!names.includes(`${base}_${i}`)) return `${base}_${i}`;
    };
    const fillSecrets = (slot, names, keep) => {
        const select = dq(slot, 'secret');
        const options = [['', 'No key'], ...names.map((n) => [n, n]), [NEW_KEY, '+ New key...']];
        select.replaceChildren(...options.map(([value, text]) => Object.assign(document.createElement('option'), { value, textContent: text })));
        select.value = names.includes(keep) ? keep : '';
    };
    /* Its models: the provider's own list, read with the key chosen (kept a day on the server), else the known ones. */
    const modelAsked = { main: 0, backup: 0 };
    async function paintModels(slot, wanted = dq(slot, 'model').value) {
        const provider = dq(slot, 'provider').value;
        const pick = dq(slot, 'model-pick'); const typed = dq(slot, 'model');
        const free = provider === 'other';
        pick.hidden = free; typed.hidden = !free;
        if (free || provider === 'none') return;
        const asked = ++modelAsked[slot];
        const secret = engineChoice(slot).secret;
        const models = await getJson(`/dictation/models?${new URLSearchParams({ provider, secret })}`, null)
            ?? dictationProviders.find((p) => p.id === provider)?.models ?? [];
        if (asked !== modelAsked[slot]) return;
        const list = wanted && !models.some((m) => m.id === wanted) ? [{ id: wanted, label: '' }, ...models] : models;
        pick.replaceChildren(...list.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: m.label ? `${m.id} · ${m.label}` : m.id })));
        pick.value = list.some((m) => m.id === wanted) ? wanted : list[0]?.id ?? '';
        typed.value = pick.value;
    }
    /* What a provider shows: the address only for "Other"; nothing but "None" for no backup. */
    const showProvider = (slot) => {
        const provider = dq(slot, 'provider').value;
        const none = provider === 'none';
        dq(slot, 'url-row').hidden = provider !== 'other';
        dq(slot, 'other-hint').hidden = provider !== 'other';
        for (const what of ['model-row', 'secret-row', 'try']) dq(slot, what).hidden = none;
        if (none) { dq(slot, 'newkey').hidden = true; dq(slot, 'heard').hidden = true; }
        if (none) dq(slot, 'dot').dataset.off = ''; else delete dq(slot, 'dot').dataset.off;
    };
    async function paintDictation() {
        const [about, secrets] = await Promise.all([getJson('/dictation', null), getJson('/secrets', [])]);
        if (!about) { $('settings-dictation').textContent = 'Not set from here'; $('dictation-form').hidden = true; return; }
        const main = about.main; const backup = about.backup;
        const short = (id) => about.providers.find((p) => p.id === id)?.short || about.providers.find((p) => p.id === id)?.label || id;
        $('settings-dictation').textContent = about.source === 'settings' ? `On · "${about.model}" · chosen here${backup ? ` · backup: ${short(backup.provider)}` : ''}`
            : about.source === 'env' ? `On · "${about.env.model}" · set on the server` : 'Off · choose a provider';
        $('settings-dictation').dataset.tone = about.source ? 'ok' : '';
        if (about.source === 'settings' && about.down) { $('settings-dictation').textContent = `${about.down} down · backup in use`; $('settings-dictation').dataset.tone = 'warn'; }
        /* Its key past its expiry day: not used (voice.mjs); said in red, a dot on the chapter. */
        if (about.source === 'settings' && about.secretExpired) { $('settings-dictation').textContent = 'Key expired: replace it in Assets > Secrets'; $('settings-dictation').dataset.tone = 'bad'; }
        chapterNow('s-dictation', about.source === 'settings' ? (about.down ? uiSaid('set-dict-backup', 'Backup in use') : about.secretExpired ? uiSaid('set-dict-expired', 'Key expired') : `${uiSaid('set-on', 'On')}${main?.provider ? ` · ${short(main.provider)}` : ''}${backup ? ` · ${uiSaid('set-dict-with-backup', 'with backup')}` : ''}`)
            : about.source === 'env' ? `${uiSaid('set-on', 'On')} · ${uiSaid('set-dict-server', 'set on the server')}` : uiSaid('set-off', 'Off'));
        if (about.secretMissing) dictationSay(`The secret "${about.secret}" is gone: choose another key.`);
        else if (backup?.secretMissing) dictationSay(`Backup: the secret "${backup.secret}" is gone: choose another key.`);
        if (about.down) dq('main', 'dot').dataset.down = ''; else delete dq('main', 'dot').dataset.down;
        dictationProviders = about.providers;
        const names = secrets.map((s2) => s2.name);
        for (const slot of ['main', 'backup']) {
            const provider = dq(slot, 'provider');
            if (provider.options.length === 0) {
                for (const p of about.providers) provider.append(Object.assign(document.createElement('option'), { value: p.id, textContent: p.label }));
                if (slot === 'backup') provider.append(Object.assign(document.createElement('option'), { value: 'none', textContent: 'None' }));
            }
        }
        if ($('dictation-form').contains(document.activeElement)) { for (const slot of ['main', 'backup']) fillSecrets(slot, names, dq(slot, 'secret').value); return; }
        for (const [slot, saved] of [['main', main], ['backup', backup]]) {
            const first = dictationProviders.find((p) => p.id === (saved?.provider ?? 'ovh'));
            dq(slot, 'provider').value = saved?.provider ?? (slot === 'main' ? 'ovh' : 'none');
            dq(slot, 'url').value = saved ? saved.url : first?.url ?? '';
            dq(slot, 'model').value = saved ? saved.model : first?.model ?? '';
            fillSecrets(slot, names, saved?.secret ?? '');
            dq(slot, 'newkey').hidden = true;
            showProvider(slot);
            void paintModels(slot, dq(slot, 'model').value);
        }
        showLanguage(about.language ?? '');
        $('dictation-off').hidden = about.source !== 'settings';
    }
    for (const slot of ['main', 'backup']) {
        dq(slot, 'provider').addEventListener('change', () => {
            const p = dictationProviders.find((x) => x.id === dq(slot, 'provider').value);
            if (p) { dq(slot, 'url').value = p.url; dq(slot, 'model').value = p.model; }
            /* A key whose name reads as this provider's, when the one chosen does not. */
            const keys = [...dq(slot, 'secret').options].map((o) => o.value).filter((v) => v && v !== NEW_KEY);
            const looks = { ovh: /^OVH_AI_ENDPOINTS/, mistral: /^MISTRAL/, groq: /^GROQ/, openai: /^OPENAI/ }[p?.id];
            if (looks && !looks.test(dq(slot, 'secret').value)) { const k = keys.find((n) => looks.test(n)); if (k) dq(slot, 'secret').value = k; }
            dq(slot, 'newkey').hidden = true;
            showProvider(slot);
            void paintModels(slot, p?.model ?? '');
        });
        dq(slot, 'model-pick').addEventListener('change', () => { dq(slot, 'model').value = dq(slot, 'model-pick').value; });
        dq(slot, 'secret').addEventListener('change', () => {
            const adding = dq(slot, 'secret').value === NEW_KEY;
            dq(slot, 'newkey').hidden = !adding;
            if (adding) {
                const names = [...dq(slot, 'secret').options].map((o) => o.value);
                const p = dictationProviders.find((x) => x.id === dq(slot, 'provider').value);
                dq(slot, 'newkey-name').textContent = `Kept as ${newKeyName(p?.id ?? 'other', names)}`;
                dq(slot, 'newkey-value').placeholder = `Paste the ${p?.short || p?.label || ''} key`.replace('  ', ' ');
                dq(slot, 'newkey-value').focus();
            } else void paintModels(slot);
        });
        /* "+ New key": kept in the secrets, never shown again, then chosen. */
        dq(slot, 'newkey-keep').addEventListener('click', async () => {
            const value = dq(slot, 'newkey-value').value.trim();
            if (!value) { dictationSay('Paste the key first.'); return; }
            const names = [...dq(slot, 'secret').options].map((o) => o.value);
            const name = newKeyName(dq(slot, 'provider').value, names);
            try {
                await post(`${API}/secrets`, { name, value });
                dq(slot, 'newkey-value').value = ''; dq(slot, 'newkey').hidden = true; dictationSay(null, `Key kept: ${name}.`);
                const secrets = await getJson('/secrets', []);
                for (const s2 of ['main', 'backup']) fillSecrets(s2, secrets.map((x) => x.name), s2 === slot ? name : dq(s2, 'secret').value);
                void paintModels(slot);
            } catch (error) { dictationSay(error.message); }
        });
    }
    $('dictation-language').addEventListener('change', () => { $('dictation-language-code').hidden = $('dictation-language').value !== 'other'; });
    $('dictation-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        try { await post(`${API}/dictation`, dictationChoice()); document.activeElement?.blur(); dictationSay(null, 'Saved: in use now.'); void paintDictation(); }
        catch (error) { dictationSay(error.message); }
    });
    $('dictation-off').addEventListener('click', async () => {
        try { await post(`${API}/dictation/off`); dictationSay(null, 'Turned off.'); void paintDictation(); } catch (error) { dictationSay(error.message); }
    });
    /* "Try it", per engine: a few seconds from this microphone, sent to the engine in its card (nothing saved). */
    let stopTrying = null;
    /* How loud the microphone is, in five thin bars beside what it says (voice.js: on.level): drawn once a
       frame; it rises at once and falls slowly. Decorative: the words say the state. */
    let tryLevels = []; let tryFrame = null;
    const tryLevel = (slot, n) => {
        if (!stopTrying || !window.clavariumVoice?.levelBars) return;
        tryLevels = [Math.max(n, (tryLevels[0] ?? 0) * 0.8), ...tryLevels].slice(0, 3);
        dq(slot, 'level').hidden = false;
        tryFrame ??= requestAnimationFrame(() => {
            tryFrame = null;
            if (!stopTrying) return;
            const bars = dq(slot, 'level').children;
            window.clavariumVoice.levelBars(tryLevels).forEach((h, i) => { if (bars[i]) bars[i].style.transform = `scaleY(${h})`; });
        });
    };
    const endTry = () => {
        stopTrying?.(); stopTrying = null; tryLevels = [];
        for (const slot of ['main', 'backup']) { dq(slot, 'try').textContent = 'Try it'; dq(slot, 'level').hidden = true; for (const bar of dq(slot, 'level').children) bar.style.transform = ''; }
    };
    for (const slot of ['main', 'backup']) dq(slot, 'try').addEventListener('click', async () => {
        if (stopTrying) { endTry(); return; }
        dictationSay(null);
        const heard = dq(slot, 'heard');
        for (const other of ['main', 'backup']) if (other !== slot) dq(other, 'heard').hidden = true;
        if (!window.clavariumVoice) { dictationSay('The microphone cannot be used on this page.'); return; }
        const to = `${API}/dictation/try?${new URLSearchParams({ ...engineChoice(slot), language: dictationLanguage() })}`;
        const words = { calibrating: 'Listening to the room...', listening: 'Speak now: a short sentence.', hearing: 'Hearing...', transcribing: 'Writing...' };
        const began = Date.now();
        try {
            heard.hidden = false; heard.dataset.tone = ''; heard.textContent = 'Opening the microphone...';
            let spoke = began;
            const stop = await window.clavariumVoice.listen({
                state: (w) => { if (w === 'transcribing') spoke = Date.now(); if (stopTrying) heard.textContent = words[w] ?? w; },
                level: (n) => tryLevel(slot, n),
                phrase: (text) => { endTry(); heard.textContent = `Heard: ${text}`; heard.title = `${((Date.now() - spoke) / 1000).toFixed(1)} s`; },
                error: (message) => { endTry(); heard.hidden = true; dictationSay(message); },
            }, { to });
            stopTrying = stop; dq(slot, 'try').textContent = 'Stop';
            setTimeout(() => { if (stopTrying === stop) { endTry(); if (!heard.textContent.startsWith('Heard')) heard.textContent = 'Nothing was heard.'; } }, 15_000);
        } catch { heard.hidden = true; dictationSay('The microphone could not be opened.'); }
    });

    /* ---------- the name of this Clavarium, in Settings ---------- */
    async function paintInstance() {
        const about = await fetch(`${API}/instance`).then((r) => r.json()).catch(() => null);
        if (!about) return;
        $('instance-name').placeholder = about.defaultName;
        if (document.activeElement !== $('instance-name')) $('instance-name').value = about.given ? about.name : '';
        chapterNow('s-general', about.name);
    }
    $('instance-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('instance-error').hidden = true;
        try {
            const about = await post(`${API}/instance`, { name: $('instance-name').value.trim() });
            appName = about.name; paintTitle(); $('instance-name').blur(); await paintInstance();
            if (!installName()) pointManifest('');
        } catch (error) { $('instance-error').textContent = error.message; $('instance-error').hidden = false; }
    });

    /* ---------- Updates: what runs, what is out, how it updates itself (server/updates.mjs) ---------- */
    let updatesTimer; let updatesBusy = false;
    const RESULT_WORDS = { done: 'Done', 'rolled-back': 'Did not work: went back', failed: 'Failed' };
    const sinceWords = (iso) => {
        const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
    };
    const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    function updatesError(text) { $('updates-error').textContent = text ?? ''; $('updates-error').hidden = !text; }
    let lastUpdates = null;
    /* THE CERTIFICATE browsers are given (none in local mode): its end, its issuer; a warning when they would not trust it, or it ends soon. */
    async function paintCertificate() {
        const c = await fetch(`${API}/certificate`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const line = $('updates-certificate');
        if (!c || c.local) { $('updates-certificate-row').hidden = true; return; }
        const day = (iso) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
        const bad = c.none || !c.trusted || c.daysLeft < 10;
        line.className = bad ? 'error' : '';
        line.textContent = c.none ? `None served (${c.why})`
            : !c.trusted ? `Not trusted by browsers (${c.why})${c.local ? ' · sudo clavarium doctor --certificate' : ''}`
            : `${c.issuer} · until ${day(c.validTo)} · renews by itself${c.daysLeft < 10 ? ' · late: sudo clavarium doctor --certificate' : ''}`;
        line.title = c.domain;
        $('updates-certificate-row').hidden = false;
    }
    /* WHEN IT HAPPENS, in words: the next look of the updater, and when a version that is out gets installed. */
    function paintUpdatesWhen(u) {
        const box = $('updates-when'); const w = u.when;
        box.hidden = !u.installed || !w; if (box.hidden) return;
        const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const inWords = (ms) => { const m = Math.max(1, Math.round((ms - Date.now()) / 60_000)); return m < 60 ? `in ${m} min` : m < 36 * 60 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`; };
        const look = w.nextLookAt ? `next check ${inWords(w.nextLookAt)} (${clock(w.nextLookAt)})` : 'next check in a few minutes';
        const out = u.available ? `${u.available} is out · ` : '';
        const lines = {
            auto: w.inWindow ? `${out}In the window now · ${look} · closes at ${clock(w.windowClosesAt)}`
                : `${out}Installed in the window only · it opens ${inWords(w.windowOpensAt)} (${clock(w.windowOpensAt)} to ${clock(w.windowClosesAt)})`,
            asap: `${out}Installed as soon as out · ${look}`,
            ask: `${out}Checked every 6 h${w.askNextAt ? ` · next ${inWords(w.askNextAt)}` : ''} · installed when you choose`,
            off: 'Off · Check now, then Update',
        };
        box.textContent = lines[w.mode] ?? '';
    }
    async function paintUpdates() {
        clearTimeout(updatesTimer);
        const u = await fetch(`${API}/updates`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        /* The server restarts during an update: asked again until it answers. */
        if (!u) { if (updatesBusy && !$('settings').hidden) updatesTimer = setTimeout(() => { void paintUpdates(); }, 3000); return; }
        lastUpdates = u;
        $('updates-version').textContent = `Clavarium ${u.version ?? ''}`;
        /* Its relay, kept at the version of each release by the updater -- or why not, and what to do once. */
        const relay = u.relay;
        /* [what is said, what to do once (behind a small "i"), whether it asks for something]. */
        const RELAY_SAID = {
            brought: (r) => [`Relay updated to ${r.version}`],
            current: (r) => [`Relay up to date (${r.version})`],
            refused: () => ['Relay not kept up to date: it refuses this server\'s key', 'Once: sudo clavarium key on this server, then relay.sh again on the relay, with --key and --keeper-key.', true],
            'no-key': () => ['Relay not kept up to date: no maintenance key', 'sudo clavarium online --relay HOST sets one up.', true],
            failed: (r) => [`Relay update failed: ${r.why ?? 'unknown'} · tried again later`, '', true],
        };
        const relayBox = $('updates-relay');
        relayBox.hidden = !relay || !RELAY_SAID[relay.state];
        if (relay && RELAY_SAID[relay.state]) {
            const [said, todo, asks] = RELAY_SAID[relay.state](relay);
            relayBox.replaceChildren(el('span', '', said));
            if (todo) { const more = el('details', 'more'); more.append(el('summary', '', 'How'), el('span', '', todo)); relayBox.append(' ', more); }
            relayBox.className = asks ? 'callout' : 'hint';
            relayBox.dataset.state = relay.state;
        }
        paintUpdatesWhen(u);
        void paintCertificate();
        for (const id of ['updates-check', 'updates-settings', 'updates-back']) $(id).hidden = !u.installed;
        if (!u.installed) {
            $('updates-state').textContent = 'Not installed with install.sh: no updates here.';
            $('updates-offer').hidden = true; $('updates-news').hidden = true; $('updates-history-box').hidden = true;
            return;
        }
        const running = u.running;
        updatesBusy = Boolean(running);
        $('updates-line').dataset.tone = running ? 'warn' : u.checkError ? 'bad' : u.available ? 'warn' : 'ok';
        $('updates-state').textContent = running ? `${running.action === 'back' ? 'Going back to' : 'Updating to'} ${running.version}: ${running.step.toLowerCase()}...`
            : u.checkError ? 'Could not check just now.'
            : u.available ? `${u.available} is out.`
            : u.checkedAt ? `Nothing newer to install · checked ${sinceWords(u.checkedAt)}` : 'Nothing newer to install';
        $('updates-check').disabled = Boolean(running);
        $('updates-offer').hidden = !u.available || Boolean(running);
        /* A version that already failed here is not offered as usual: tried again only on purpose, warned. */
        const failedHere = Boolean(u.available) && u.history.some((h) => h.action === 'update' && h.to === u.available && h.result !== 'done');
        const apply = $('updates-apply');
        apply.dataset.version = u.available ?? '';
        apply.dataset.retry = String(failedHere);
        apply.className = failedHere ? '' : 'primary';
        apply.textContent = failedHere ? `Try ${u.available} again\u2026` : `Update to ${u.available ?? ''}`;
        $('updates-retry-note').textContent = failedHere ? `It did not start here before. If it fails again, ${u.version} is put back.` : '';
        $('updates-retry-note').hidden = !failedHere;
        $('updates-retry-yes').hidden = true; $('updates-retry-no').hidden = true; apply.hidden = false;
        /* The last thing that went wrong, said once at the top, in words: a version put
           back runs normally -- only the new one did not start, here. */
        const last = u.history[0];
        const backFailed = /did not come back either/.test(last?.why ?? '');
        const news = !running && last && last.result !== 'done' ? (last.result === 'rolled-back' ? (backFailed ? `${last.to} did not start on this server, and putting ${last.from} back did not work either: ${last.why}` : `${last.to} did not start on this server, so ${last.from} was put back. ${last.from} runs normally.`) : `${last.action === 'back' ? 'Going back to' : 'The update to'} ${last.to} failed: ${last.why ?? ''}`)
            : !running && u.refused && (!last || u.refused.at > last.at) && !/is not newer than/.test(u.refused.why ?? '') ? `Not done: ${u.refused.why}` : '';
        $('updates-news').textContent = news.trim(); $('updates-news').hidden = !news; $('updates-news').dataset.tone = news ? 'warn' : 'ok';
        if (![$('updates-mode'), $('updates-from'), $('updates-to'), $('updates-channel')].includes(document.activeElement)) {
            $('updates-mode').value = u.mode; $('updates-channel').value = u.channel;
            [$('updates-from').value, $('updates-to').value] = u.window.split('-');
        }
        const auto = u.mode === 'auto';
        $('updates-window').hidden = !auto; $('updates-window-label').hidden = !auto; $('updates-window-row').hidden = !auto;
        const back = $('updates-back'); back.replaceChildren();
        for (const r of running ? [] : u.back) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = `Go back to ${r.version}`;
            b.addEventListener('click', () => {
                /* Asked once more, in place: it restarts the server. */
                const sure = document.createElement('span'); sure.className = 'hint'; sure.textContent = `The server restarts on ${r.version}.`;
                const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'primary'; yes.textContent = 'Go back';
                const no = document.createElement('button'); no.type = 'button'; no.textContent = 'Cancel';
                no.addEventListener('click', () => { void paintUpdates(); });
                yes.addEventListener('click', async () => {
                    updatesError(); yes.disabled = true;
                    try { await post(`${API}/updates/back`, { version: r.id }); updatesBusy = true; } catch (error) { updatesError(error.message); }
                    await paintUpdates();
                });
                back.replaceChildren(sure, yes, no); yes.focus();
            });
            back.append(b);
        }
        const list = $('updates-history'); list.replaceChildren();
        for (const h of u.history) {
            const li = document.createElement('li'); li.dataset.result = h.result;
            const t = document.createElement('time'); t.dateTime = h.at; t.textContent = when(h.at);
            const what = document.createElement('span'); what.textContent = `${h.from ?? '?'} → ${h.to} · ${h.action === 'back' && h.result === 'done' ? 'Went back' : h.action === 'restart' ? (h.result === 'done' ? 'Restarted by itself' : 'Restart by itself failed') : RESULT_WORDS[h.result] ?? h.result}`;
            li.append(t, what);
            if (h.why) { const why = document.createElement('small'); why.textContent = h.why; li.append(why); }
            /* What the updater saw when it went wrong: the journal, the unit, who held the port. */
            if (h.log) { const d = document.createElement('details'); d.className = 'update-log'; const sum = document.createElement('summary'); sum.textContent = 'See the log'; const pre = document.createElement('pre'); pre.textContent = h.log; d.append(sum, pre); li.append(d); }
            list.append(li);
        }
        $('updates-history-box').hidden = u.history.length === 0;
        if (running && !$('settings').hidden) updatesTimer = setTimeout(() => { void paintUpdates(); }, 3000);
    }
    $('updates-check').addEventListener('click', async () => {
        updatesError(); $('updates-check').disabled = true; $('updates-check').textContent = 'Checking...'; $('updates-state').textContent = 'Checking...';
        let failed = false;
        try { await post(`${API}/updates/check`); } catch (error) { failed = true; updatesError(`Could not ask npm: ${error.message}. Try again later.`); }
        $('updates-check').disabled = false; $('updates-check').textContent = 'Check now';
        await paintUpdates();
        /* The answer to the click, said next to it. */
        const u = lastUpdates;
        if (!failed && u && !u.checkError) { $('updates-news').textContent = u.available ? `${u.available} is out.` : `No new version: ${u.version} is the latest.`; $('updates-news').hidden = false; $('updates-news').dataset.tone = u.available ? 'warn' : 'ok'; }
    });
    async function applyUpdate() {
        updatesError();
        const version = $('updates-apply').dataset.version;
        try { await post(`${API}/updates/apply`, { version }); updatesBusy = true; } catch (error) { updatesError(error.message); }
        await paintUpdates();
    }
    $('updates-apply').addEventListener('click', () => {
        if ($('updates-apply').dataset.retry !== 'true') { void applyUpdate(); return; }
        /* Tried again: asked once more, in place. */
        $('updates-apply').hidden = true;
        $('updates-retry-note').textContent = `The server restarts to try ${$('updates-apply').dataset.version} again.`;
        $('updates-retry-yes').hidden = false; $('updates-retry-no').hidden = false; $('updates-retry-yes').focus();
    });
    $('updates-retry-yes').addEventListener('click', () => { void applyUpdate(); });
    $('updates-retry-no').addEventListener('click', () => { void paintUpdates(); });
    async function saveUpdates(change) {
        updatesError(); $('updates-saved').textContent = '';
        try { await post(`${API}/updates/settings`, change); $('updates-saved').textContent = 'Saved.'; } catch (error) { updatesError(error.message); }
        await paintUpdates();
    }
    $('updates-mode').addEventListener('change', () => { void saveUpdates({ mode: $('updates-mode').value }); });
    $('updates-channel').addEventListener('change', () => { void saveUpdates({ channel: $('updates-channel').value }); });
    for (const id of ['updates-from', 'updates-to']) $(id).addEventListener('change', () => {
        if ($('updates-from').value && $('updates-to').value) void saveUpdates({ window: `${$('updates-from').value}-${$('updates-to').value}` });
    });

    /* ---------- This server: its disk and memory, and the reserve ---------- */
    const GB = (mb) => `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB`;
    const PLACE_WORDS = { machines: "the machines' disks", data: "this server's data", folders: 'the folders given to machines' };
    let serverTimer;
    /* A meter: what is taken, and the reserve as a striped end (a machine
       that would reach into it is refused). `level`: ok, warn, bad. */
    function meter(m, usedPercent, reserveMb, sizeMb, level) {
        m.setAttribute('aria-valuenow', String(usedPercent));
        m.setAttribute('aria-valuetext', `${usedPercent}% taken`);
        m.dataset.level = level;
        m.querySelector('.fill').style.width = `${Math.min(100, usedPercent)}%`;
        const shown = reserveMb !== null && sizeMb > 0;
        const at = shown ? Math.max(0, Math.min(100, 100 - (reserveMb / sizeMb) * 100)) : 100;
        m.querySelector('.mark').hidden = !shown; m.querySelector('.zone').hidden = !shown;
        m.querySelector('.mark').style.left = `${at}%`;
        m.querySelector('.zone').style.left = `${at}%`;
    }
    const levelOf = (high, usedPercent, aboveMb, reserveMb) => (!high ? 'ok' : usedPercent > 95 || aboveMb < reserveMb / 2 ? 'bad' : 'warn');
    /* How far from the reserve, in words: why "Short" is said. */
    const aboveWords = (aboveMb, reserveMb) => (aboveMb >= 0 ? `${GB(aboveMb)} above the ${GB(reserveMb)} reserve` : `${GB(-aboveMb)} into the ${GB(reserveMb)} reserve: new machines are refused`);
    function parts(dl, rows) {
        dl.replaceChildren();
        for (const [label, value, sub, slot] of rows) {
            if (value === null || value === undefined) continue;
            const dt = document.createElement('dt'); dt.textContent = label; if (sub) dt.className = 'sub';
            if (slot !== undefined) dt.prepend(KIT.ShareKey(slot));
            const dd = document.createElement('dd'); dd.textContent = typeof value === 'number' ? GB(value) : value; dd.className = [sub ? 'sub' : '', typeof value === 'number' ? '' : 'words'].filter(Boolean).join(' ');
            dl.append(dt, dd);
        }
    }
    /* WHO TAKES IT, AT A GLANCE (06-11): a small donut by machine beside each list, the list its legend.
       A machine keeps its colour on both bars while the page lives. */
    const shareSlots = new Map();
    const shareWords = () => ({ others: uiSaid('set-share-others', 'Others'), rest: uiSaid('set-share-rest', 'System and others'), free: uiSaid('set-share-free', 'Free') });
    const machineTitle = (name) => conversations.find((x) => x.name === name)?.title || name;
    /* The slices, and each machine's slot for its row (a machine folded into "Others" takes its colour). */
    function shareOf(machines, restMb, freeMb, rest) {
        const slices = KIT.shareSlices(machines, { restMb, freeMb, slots: shareSlots, words: { ...shareWords(), ...(rest ? { rest } : {}) } });
        const slot = new Map(slices.flatMap((x) => (x.keys ? x.keys.map((k) => [k, 0]) : [[x.key, x.slot]])));
        return { slices, slot };
    }
    /* The donut, its middle the main figure: what is used, of how much. */
    const shareDonut = (slices, label, usedMb, totalMb) => KIT.ShareDonut({ slices, label, fmt: GB, center: { top: uiSaid('set-share-used', 'Used'), main: GB(usedMb), sub: uiSaid('set-share-of', 'of {total}', { total: GB(totalMb) }) } });
    const TITLES = { machines: "Disk of the machines", data: "Disk of this server's data", folders: 'Disk of the shared folders' };
    /* One block per disk of the server, with what it holds. */
    function paintDisks(r) {
        const box = $('server-disks'); box.replaceChildren();
        const u = r.usage; const c = u?.clavarium; const m = u?.machines;
        const sum = (rows) => rows.reduce((a, [, v]) => a + (typeof v === 'number' ? v : 0), 0);
        for (const d of r.disk.disks) {
            const block = document.createElement('div'); block.className = 'server-block';
            const head = document.createElement('div'); head.className = 'server-head';
            const title = document.createElement('b'); title.textContent = r.disk.disks.length > 1 ? TITLES[['machines', 'data', 'folders'].find((h) => d.holds.includes(h))] : 'Disk';
            const machines = d.holds.includes('machines');
            const reserve = machines ? r.reserve.diskMb : null;
            /* As the server judges it (capacity.mjs): fuller than 85 %, or less free than 1.5 times the reserve. */
            const high = d.usedPercent > 85 || d.freeMb < 1.5 * r.reserve.diskMb;
            const state = document.createElement('span'); state.className = 'server-state'; state.textContent = 'Short'; state.hidden = !high;
            const figures = document.createElement('span'); figures.className = 'server-figures'; figures.textContent = `${GB(d.freeMb)} free of ${GB(d.sizeMb)}`;
            head.append(title, state, figures);
            const bar = document.createElement('div'); bar.className = 'server-meter'; bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', `${title.textContent}: taken`); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
            for (const k of ['fill', 'zone', 'mark']) { const x = document.createElement('span'); x.className = k; bar.append(x); }
            meter(bar, d.usedPercent, reserve, d.sizeMb, levelOf(high, d.usedPercent, d.freeMb - (reserve ?? 0), reserve ?? Infinity));
            const note = document.createElement('p'); note.className = 'server-note';
            note.textContent = machines ? aboveWords(d.freeMb - r.reserve.diskMb, r.reserve.diskMb) : 'No reserve here: the machines are not on this disk.';
            const dl = document.createElement('dl'); dl.className = 'server-parts';
            const rows = [];
            let share = null;
            if (u) {
                if (d.holds.includes('data')) rows.push(["This server's data", c.dataMb]);
                if (d.holds.includes('folders')) {
                    const shared = [['folders given to machines', c.foldersMb, true], ['work folders', c.workMb, true], ...(c.removedMb ? [['put aside (archived)', c.removedMb, true]] : []), ...(c.toolsMb >= 100 ? [['tools given to machines', c.toolsMb, true]] : [])];
                    rows.push(['Shared folders', sum(shared)], ...shared);
                }
                if (machines) {
                    const rest = Math.max(0, d.sizeMb - d.freeMb - m.each.reduce((a, x) => a + x.mb, 0));
                    share = shareOf(m.each.map((x) => ({ key: x.name, label: machineTitle(x.name), mb: x.mb })), rest, d.freeMb, uiSaid('set-share-else', 'Everything else'));
                    const each = [...m.each.slice(0, 8).map((x) => [machineTitle(x.name), x.mb, true, share.slot.get(x.name)]), ...(m.each.length > 8 ? [[`${m.each.length - 8} more`, m.each.slice(8).reduce((a, x) => a + x.mb, 0), true]] : []), ...(m.shelfMb ? [['ready-made machine', m.shelfMb, true]] : []), ['images', m.imagesMb, true]];
                    rows.push(['Machines', sum(each)], ...each);
                    if (m.othersMb) rows.push(['Other machines', m.othersMb]);
                }
                /* WHERE EACH WORK FOLDER IS: kept with the shared folders, or on its machine's own disk. */
                const here = conversations.filter((x) => (x.work === 'disk' ? machines : d.holds.includes('folders'))).map((x) => x.title || x.name);
                if (here.length) rows.push(['Work folders on this disk', here.length > 6 ? `${here.slice(0, 6).join(', ')} and ${here.length - 6} more` : here.join(', ')]);
                const known = sum(rows.filter(([, , sub]) => !sub));
                const rest = d.sizeMb - d.freeMb - known;
                if (rest > 50) rows.push(['The system and other programs', rest]);
            } else rows.push(['What takes it', r.measuring ? 'measuring...' : 'not measured yet']);
            parts(dl, rows);
            const row = document.createElement('div'); row.className = 'share-row';
            if (share?.slices.some((x) => x.key !== 'free')) row.append(shareDonut(share.slices, uiSaid('set-share-disk', 'Disk by machine'), d.sizeMb - d.freeMb, d.sizeMb));
            row.append(dl);
            block.append(head, bar, note, row);
            box.append(block);
        }
    }
    /* ALL THE MACHINES TO ANOTHER DISK: every disk of this server, whole, formatted or not; for each,
       what can be done -- move the machines to it, mount it, prepare (erase) it -- or why not. */
    async function paintMoveMachines() {
        const size = (mb) => (mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(1)} TB` : GB(mb));
        const [p, m] = await Promise.all([fetch(`${API}/machines/disks`).then((r) => (r.ok ? r.json() : null)).catch(() => null), fetch(`${API}/machines/moving`).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
        const old = await fetch(`${API}/machines/places`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const rows = $('move-machines-rows'); rows.replaceChildren();
        const said = (text) => { $('move-machines-said').textContent = text; };
        if (m?.said?.length) said(m.done ? `The last move: ${m.said.find((l) => l.startsWith('Done:'))}` : m.failed ? `The last move did not happen: ${m.said.filter(Boolean).at(-1)}` : m.state === 'active' ? `Moving: ${m.said.at(-1)}` : '');
        /* A move copies, never moves: the copy left behind takes its room until it is removed. */
        if (old?.oldMb) {
            const row = el('div', 'folder'); row.id = 'move-machines-old';
            row.append(el('b', '', 'The old copy'), el('small', 'hint', ` ${GB(old.oldMb)} left on the first disk by the move; the machines run from ${old.now?.place ?? 'the new place'}`));
            const forget = el('button', 'danger', 'Remove the old copy...'); forget.type = 'button';
            forget.addEventListener('click', () => {
                if (forget.dataset.sure !== 'yes') { forget.dataset.sure = 'yes'; forget.textContent = `Yes: remove ${GB(old.oldMb)} for good`; return; }
                forget.disabled = true;
                void post(`${API}/machines/forget-old`, {}).then(() => { said(`The old copy was removed: ${GB(old.oldMb)} free again.`); void paintMoveMachines(); }).catch((error) => { said(error.message); forget.disabled = false; });
            });
            row.append(forget); rows.append(row);
        }
        if (!p) { rows.append(el('p', 'hint', 'The disks cannot be listed just now.')); return; }
        for (const d of p.disks) {
            const card = el('div', 'disk-card'); card.dataset.disk = d.name;
            const head = el('div', 'disk-head');
            head.append(el('b', '', d.model ? `${d.model}` : d.loop ? 'A disk image' : 'A disk'), el('span', 'disk-size', size(d.sizeMb)), el('code', 'disk-name', d.name));
            card.append(head);
            const notes = [];
            if (d.system) notes.push("The system's disk.");
            if (d.parts.some((x) => x.machines)) notes.push('The machines are here now.');
            if (d.removable) notes.push('Removable: the machines would stop if it were unplugged.');
            if (notes.length) card.append(el('p', 'hint', notes.join(' ')));
            /* What is on it, without the little partitions a system keeps for starting. */
            for (const x of d.parts.filter((q) => q.sizeMb >= 256 || d.parts.length === 1)) {
                if (x.state === 'empty' && d.parts.length === 1 && x.name === d.name) { card.append(el('p', 'disk-part', 'Empty: never formatted.')); continue; }
                const line = el('div', 'disk-part');
                const what = { system: `used by the system (${x.mount})`, place: `mounted at ${x.mount}`, 'in-use': `in use at ${x.mount}`, mountable: `${x.fstype}, not mounted`, other: `${x.fstype}: not a file system the machines can live on`, empty: 'no file system', 'part-of-more': 'part of a volume, an array or an encrypted disk' }[x.state];
                line.append(el('span', '', `${x.name === d.name ? 'The whole disk' : x.name}${x.label ? ` "${x.label}"` : ''}: ${size(x.sizeMb)}, ${what}${x.freeMb != null ? `, ${size(x.freeMb)} free` : ''}`));
                if (x.state === 'place' && !x.machines) {
                    const go = el('button', 'danger', 'Move the machines here...'); go.type = 'button'; go.disabled = Boolean(x.why);
                    if (x.why) line.append(el('small', 'hint', ` -- ${x.why}`));
                    go.addEventListener('click', () => {
                        if (go.dataset.sure !== 'yes') { go.dataset.sure = 'yes'; go.textContent = `Yes: stop every machine and this server, and move them to ${x.mount}`; return; }
                        go.disabled = true;
                        void post(`${API}/machines/move`, { to: x.mount }).then(() => said('Moving: this server stops now, and comes back by itself. Reload this page in a few minutes.')).catch((error) => { said(error.message); go.disabled = false; });
                    });
                    line.append(go);
                }
                if (x.state === 'mountable') {
                    const mount = el('button', '', 'Mount it'); mount.type = 'button';
                    mount.addEventListener('click', () => { mount.disabled = true; void post(`${API}/machines/mount`, { path: x.path }).then((r) => { said(`Mounted at ${r.mounted}: nothing on it was changed.`); void paintMoveMachines(); }).catch((error) => { said(error.message); mount.disabled = false; }); });
                    line.append(mount);
                }
                card.append(line);
            }
            /* ROOM SET ASIDE AND NOT USED (a volume made small at installation): given to it, while in use. */
            for (const u of (d.unused ?? []).filter((x) => x.freeMb >= 1024)) {
                const box = el('div', 'disk-room');
                const where = u.mount === '/' ? 'the system (and the machines on it)' : u.mount;
                box.append(el('p', '', `${size(u.freeMb)} of this disk is set aside but not used. It can be given to ${where}, while it runs: nothing is erased.`));
                const go = el('button', 'primary', `Give ${size(u.freeMb)} to ${u.mount === '/' ? 'the system' : u.mount}...`); go.type = 'button';
                go.addEventListener('click', () => {
                    if (go.dataset.sure !== 'yes') { go.dataset.sure = 'yes'; go.textContent = `Yes: grow ${u.mount} by ${size(u.freeMb)}`; return; }
                    go.disabled = true; said(`Growing ${u.mount}...`);
                    void post(`${API}/machines/grow`, { mount: u.mount }).then((r) => { said(`${u.mount} has grown${r.sizeMb ? `: ${size(r.sizeMb)} now` : ''}.`); void paintMoveMachines(); void paintServer(); }).catch((error) => { said(error.message); go.disabled = false; });
                });
                box.append(go); card.append(box);
            }
            /* Its volume's room could not be read: said as it was read, so that it can be put right. */
            for (const w of d.unreadable ?? []) card.append(el('p', 'hint', w.read === 'no-lvm-tools' ? 'Whether part of this disk is set aside and unused cannot be told: the LVM tools are not installed on this server.' : `Part of this disk may be set aside and unused, but its size could not be read (it said "${w.read}"). Please send this line to whoever looks after Clavarium.`));
            /* PREPARE: erase it, one file system on it, mounted. Its name typed again. */
            if (!d.prepare) {
                const box = el('div', 'disk-prepare');
                const go = el('button', 'danger', d.erases ? 'Erase and prepare for the machines...' : 'Prepare for the machines...'); go.type = 'button';
                go.addEventListener('click', () => {
                    go.hidden = true;
                    const warn = el('p', 'error', d.erases ? `Everything on ${d.name} (${size(d.sizeMb)}) is erased for good: ${d.parts.filter((q) => q.fstype).map((q) => `${q.name}${q.label ? ` "${q.label}"` : ''} (${q.fstype})`).join(', ')}.` : `${d.name} (${size(d.sizeMb)}) gets one file system, mounted at /mnt/${d.name}.`);
                    const field = el('input', ''); field.placeholder = d.name; field.setAttribute('aria-label', `Type ${d.name} to go on`); field.autocomplete = 'off'; field.spellcheck = false;
                    const yes = el('button', 'danger', `Erase ${d.name}`); yes.type = 'button'; yes.disabled = true;
                    field.addEventListener('input', () => { yes.disabled = field.value.trim() !== d.name; });
                    const no = el('button', '', 'Cancel'); no.type = 'button'; no.addEventListener('click', () => { void paintMoveMachines(); });
                    yes.addEventListener('click', () => { yes.disabled = true; said(`Preparing ${d.name}...`); void post(`${API}/machines/prepare`, { path: d.path, typed: field.value.trim() }).then((r) => { said(`${r.prepared}. The machines can be moved there now.`); void paintMoveMachines(); }).catch((error) => { said(error.message); yes.disabled = false; }); });
                    const row = el('div', 'row'); row.append(el('span', 'hint', `Type ${d.name}:`), field, yes, no);
                    box.append(warn, row);
                });
                box.append(go); card.append(box);
            } else if (!d.system && !d.parts.some((x) => x.state === 'place')) card.append(el('p', 'hint', `Not prepared here: ${d.prepare}.`));
            rows.append(card);
        }
        if (!p.disks.some((d) => !d.system)) rows.append(el('p', 'hint', 'No other disk: plug one in (or add one to this server), then open this again.'));
    }
    $('move-machines-box').addEventListener('toggle', () => { if ($('move-machines-box').open) void paintMoveMachines(); });
    /* NETWORK: this server's Wi-Fi (server/wifi.mjs). The networks it sees, the one it is on, another
       joined with its password, one it keeps forgotten. A join only STARTS a switch: the host goes back
       to the network before by itself when the new one does not work within a minute -- this page may
       lose the server meanwhile, so it says so before, and reads the outcome when it can again. */
    const WIFI_OUTSIDE = {
        'no-nmcli': 'Wi-Fi is managed outside Clavarium on this server.',
        'not-running': 'Wi-Fi is managed outside Clavarium on this server.',
        'no-device': 'This server has no Wi-Fi.',
        unmanaged: 'Wi-Fi is managed outside Clavarium on this server.',
        unreadable: 'The network cannot be read just now.',
    };
    const WIFI_WHY = { password: 'the password was not accepted', 'no-connection': 'it could not connect', 'no-internet': 'it gave no working network within a minute', stopped: 'the switch was stopped' };
    const SECURITY_WORDS = { open: 'open', wpa: 'password', wpa3: 'password (WPA3)', wep: 'old protection (WEP): not joined here', enterprise: 'user and certificate (802.1X): not joined here', other: 'not joined here' };
    let wifiNow = null; let wifiTimer;
    /* Four bars, as many lit as the signal is strong; the figure for whoever reads it aloud. */
    const signalBars = (signal) => {
        const box = el('span', 'wifi-bars'); box.setAttribute('role', 'img'); box.setAttribute('aria-label', `Signal ${signal}%`); box.title = `Signal ${signal}%`;
        for (let i = 1; i <= 4; i++) { const bar = el('span', signal >= i * 25 - 12 ? 'on' : ''); bar.style.height = `${i * 25}%`; box.append(bar); }
        return box;
    };
    const lockSign = () => {
        const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'wifi-lock'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Protected');
        const body = document.createElementNS(ns, 'rect'); body.setAttribute('x', '5'); body.setAttribute('y', '11'); body.setAttribute('width', '14'); body.setAttribute('height', '10'); body.setAttribute('rx', '2');
        const arch = document.createElementNS(ns, 'path'); arch.setAttribute('d', 'M8 11V7a4 4 0 0 1 8 0v4');
        svg.append(body, arch); return svg;
    };
    /* THE NETWORK HANDED OVER TO NETWORKMANAGER (the host program, "wifi handover"): offered where
       netplan drives it with systemd-networkd; its progress and outcome, as the host recorded them. */
    const HAND_WHY = { install: 'could not install', invalid: 'refused', 'no-network': 'no network', stopped: 'stopped', copy: 'could not copy', write: 'could not write' };
    const HAND_DAY_MS = 24 * 3600_000;
    function paintHand(s) {
        const h = s.hand; const busy = ['installing', 'switching'].includes(h?.state);
        const words = !h ? '' : {
            installing: 'Setting it up (a minute or two)...',
            switching: 'Switching (a few seconds)...',
            handed: 'Done: Clavarium manages the network.',
            'went-back': `It did not work (${HAND_WHY[h.why] ?? h.why ?? 'no reason given'}): all is back as before.`,
            failed: `It did not work (${HAND_WHY[h.why] ?? h.why ?? 'no reason given'}): nothing changed.`,
            interrupted: 'Interrupted (the server restarted?).',
        }[h.state] ?? '';
        const old = h?.state === 'handed' && Date.now() - Date.parse(h.at) > HAND_DAY_MS;
        $('wifi-hand-said').textContent = words; $('wifi-hand-said').hidden = !words || old;
        $('wifi-hand-said').className = h && ['went-back', 'failed', 'interrupted'].includes(h.state) ? 'error' : 'hint';
        $('wifi-hand').hidden = !s.handover || busy;
        if (busy && $('settings-wifi-top').open && !$('settings').hidden) wifiTimer = setTimeout(() => { void paintWifi(); }, 3000);
    }
    const handReset = () => { const go = $('wifi-hand-go'); go.dataset.sure = ''; go.textContent = 'Manage the network'; go.disabled = false; $('wifi-hand-cancel').hidden = true; };
    $('wifi-hand-go').addEventListener('click', () => {
        const go = $('wifi-hand-go');
        /* Two clicks: the network may be cut for a few seconds. */
        if (go.dataset.sure !== 'yes') { go.dataset.sure = 'yes'; go.textContent = 'Confirm (undone by itself if it fails)'; $('wifi-hand-cancel').hidden = false; return; }
        go.disabled = true;
        void post(`${API}/wifi/handover`, {}).then(() => { handReset(); void paintWifi(); }).catch((error) => { handReset(); $('wifi-hand-said').textContent = error.message; $('wifi-hand-said').className = 'error'; $('wifi-hand-said').hidden = false; });
    });
    $('wifi-hand-cancel').addEventListener('click', handReset);
    async function paintWifi() {
        clearTimeout(wifiTimer);
        const s = await fetch(`${API}/wifi`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!s) {
            /* Lost during a switch, most likely: looked at again until it answers. */
            $('wifi-now').textContent = 'This server does not answer just now. If it is changing networks, it comes back within a minute or two.';
            if ($('settings-wifi-top').open && !$('settings').hidden) wifiTimer = setTimeout(() => { void paintWifi(); }, 4000);
            return;
        }
        wifiNow = s;
        paintHand(s);
        /* Its connections, cable and Wi-Fi, each with its address. */
        const links = $('net-links'); links.replaceChildren();
        for (const l of s.links ?? []) {
            const li = el('li', l.address ? '' : 'hint');
            li.append(el('b', '', l.kind === 'wifi' ? 'Wi-Fi' : 'Cable'), ` (${l.device}): `, l.address ? el('code', '', l.address) : 'not connected');
            links.append(li);
        }
        links.hidden = !(s.links ?? []).length;
        $('wifi-controls').hidden = !s.available;
        /* While it is handed over, its progress alone is said. */
        const handing = ['installing', 'switching'].includes(s.hand?.state);
        if (!s.available) { $('wifi-now').textContent = handing ? '' : s.handover ? 'Clavarium does not manage this server\'s network yet.' : WIFI_OUTSIDE[s.why] ?? WIFI_OUTSIDE.unreadable; $('wifi-now').hidden = handing; $('wifi-last').hidden = true; return; }
        $('wifi-now').hidden = false;
        $('wifi-now').replaceChildren();
        if (s.using) $('wifi-now').append(el('span', '', 'On '), el('b', '', s.using.ssid), el('span', '', ` (Wi-Fi, ${s.device}) `), signalBars(s.using.signal));
        else $('wifi-now').textContent = `Not on a Wi-Fi network (${s.device}).`;
        /* The last switch, as the host recorded it. */
        const last = s.last; const words = !last ? '' : {
            joining: `Joining "${last.ssid}"... If it does not work within a minute, the server goes back to ${last.back ? `"${last.back}"` : 'the network before'} by itself.`,
            joined: `"${last.ssid}" worked: this server is on it.`,
            'went-back': `"${last.ssid}" did not work (${WIFI_WHY[last.why] ?? last.why ?? 'no reason given'}): the server went back to ${last.back ? `"${last.back}"` : 'the network before'}.`,
            'back-failed': `"${last.ssid}" did not work, and ${last.back ? `"${last.back}"` : 'the network before'} did not come back at once: NetworkManager goes on trying by itself.`,
            interrupted: `The switch to "${last.ssid}" was interrupted (the server restarted?).`,
        }[last.state] ?? '';
        $('wifi-last').textContent = words; $('wifi-last').hidden = !words;
        if (last?.state === 'joining' && $('settings-wifi-top').open && !$('settings').hidden) wifiTimer = setTimeout(() => { void paintWifi(); }, 3000);
        /* What it keeps: forgotten here (never the one in use). */
        const saved = $('wifi-saved'); saved.replaceChildren();
        for (const ssid of s.saved) {
            const row = el('div', 'folder'); row.append(el('b', '', ssid));
            if (s.using?.ssid === ssid) row.append(el('small', 'hint', ' in use'));
            else {
                const forget = el('button', '', 'Forget...'); forget.type = 'button';
                forget.addEventListener('click', () => {
                    if (forget.dataset.sure !== 'yes') { forget.dataset.sure = 'yes'; forget.textContent = `Yes: forget "${ssid}" and its password`; return; }
                    forget.disabled = true;
                    void post(`${API}/wifi/forget`, { ssid }).then(() => { $('wifi-said').textContent = `"${ssid}" forgotten.`; void paintWifi(); }).catch((error) => { $('wifi-said').textContent = error.message; forget.disabled = false; });
                });
                row.append(forget);
            }
            saved.append(row);
        }
        $('wifi-saved-box').hidden = !s.saved.length;
    }
    $('settings-wifi-top').addEventListener('toggle', () => { if ($('settings-wifi-top').open) void paintWifi(); else clearTimeout(wifiTimer); });
    $('wifi-scan').addEventListener('click', async () => {
        $('wifi-scan').disabled = true; $('wifi-said').textContent = 'Looking (a few seconds)...';
        try {
            const r = await fetch(`${API}/wifi/scan`, { cache: 'no-store' });
            const list = await r.json().catch(() => null);
            if (!r.ok) throw new Error(list?.error ?? 'The networks could not be listed.');
            const ul = $('wifi-list'); ul.replaceChildren();
            for (const n of list) {
                const li = el('li', 'wifi-network'); li.dataset.ssid = n.ssid;
                const joinable = ['open', 'wpa', 'wpa3'].includes(n.security) && !n.inUse;
                const pick = el('button', 'as-link', ''); pick.type = 'button'; pick.disabled = !joinable;
                pick.append(signalBars(n.signal), ...(n.security === 'open' ? [] : [lockSign()]), el('span', 'wifi-name', n.ssid));
                li.append(pick, el('small', 'hint', n.inUse ? 'in use' : SECURITY_WORDS[n.security] ?? n.security));
                pick.addEventListener('click', () => { chooseWifi(n); });
                ul.append(li);
            }
            ul.hidden = !list.length;
            $('wifi-said').textContent = list.length ? '' : 'No network in sight.';
        } catch (error) { $('wifi-said').textContent = error.message; }
        $('wifi-scan').disabled = false;
    });
    /* One chosen: its password asked (never shown back), and what happens if it does not work said BEFORE. */
    let wifiChosen = null;
    function chooseWifi(n) {
        wifiChosen = n;
        const open = n.security === 'open';
        $('wifi-join-what').textContent = open ? `Join "${n.ssid}", an open network?` : `Join "${n.ssid}":`;
        $('wifi-password-box').hidden = open;
        $('wifi-password').value = ''; $('wifi-password').required = !open;
        const back = wifiNow?.using?.ssid;
        $('wifi-join-back').textContent = back
            ? `If it does not work within a minute, the server goes back to "${back}" by itself. This page may lose the server meanwhile: it comes back by itself.`
            : 'If it does not work within a minute, the server leaves it by itself.';
        $('wifi-join-error').hidden = true; $('wifi-join-go').disabled = false;
        $('wifi-join').hidden = false;
        if (!open) $('wifi-password').focus();
    }
    $('wifi-join-cancel').addEventListener('click', () => { $('wifi-join').hidden = true; $('wifi-password').value = ''; wifiChosen = null; });
    $('wifi-join').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!wifiChosen) return;
        const n = wifiChosen; const password = n.security === 'open' ? '' : $('wifi-password').value;
        if (n.security !== 'open' && (password.length < 8 || password.length > 63)) { $('wifi-join-error').textContent = 'A Wi-Fi password has 8 to 63 characters.'; $('wifi-join-error').hidden = false; return; }
        $('wifi-join-go').disabled = true;
        void post(`${API}/wifi/join`, { ssid: n.ssid, password }).then(() => {
            /* The password leaves the page with the request: not kept in the field. */
            $('wifi-password').value = ''; $('wifi-join').hidden = true; wifiChosen = null;
            $('wifi-list').hidden = true;
            void paintWifi();
        }).catch((error) => {
            $('wifi-join-error').textContent = error.message; $('wifi-join-error').hidden = false; $('wifi-join-go').disabled = false;
        });
    });
    /* ---------- Remote screen, in Settings: a self-hosted MeshCentral (server/meshcentral.mjs) ----------
       OFF by default. Turning it on installs it (minutes, the first time) then starts it, in the background:
       its progress is shown and the outcome read back from status(). */
    let meshTimer;
    async function paintScreen() {
        clearTimeout(meshTimer);
        const s = await fetch(`${API}/meshcentral`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const line = $('mesh-line'); const state = $('mesh-state'); const toggle = $('mesh-toggle');
        const url = $('mesh-url'); const progress = $('mesh-progress');
        if (!s) { state.textContent = 'State cannot be read just now.'; line.dataset.tone = 'warn'; toggle.hidden = true; url.hidden = true; progress.hidden = true; return; }
        const turningOn = ['installing', 'starting'].includes(s.step);
        /* One short line of state. */
        state.textContent = turningOn ? 'Turning on...' : s.running ? 'On' : s.step === 'failed' ? 'Off (turn-on failed)' : s.installed ? 'Installed, off' : 'Off';
        line.dataset.tone = s.running ? 'ok' : s.step === 'failed' ? 'bad' : turningOn ? 'warn' : '';
        /* On: its address. */
        if (s.running && s.url) { url.replaceChildren('At ', el('a', '', s.url)); const a = url.querySelector('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noreferrer'; url.hidden = false; }
        else url.hidden = true;
        /* Turning on: install can take a while; the page keeps watching. */
        progress.textContent = turningOn ? (s.step === 'installing' ? 'Installing, this can take a few minutes...' : 'Starting...') : '';
        progress.hidden = !turningOn;
        toggle.hidden = false; toggle.disabled = turningOn;
        toggle.textContent = turningOn ? 'Turning on...' : s.running ? 'Turn off' : 'Turn on';
        toggle.dataset.on = s.running ? 'yes' : '';
        if (turningOn && $('settings-mesh-top').open && !$('settings').hidden) meshTimer = setTimeout(() => { void paintScreen(); }, 4000);
    }
    $('settings-mesh-top').addEventListener('toggle', () => { if ($('settings-mesh-top').open) void paintScreen(); else clearTimeout(meshTimer); });
    $('mesh-toggle').addEventListener('click', () => {
        const toggle = $('mesh-toggle'); const on = toggle.dataset.on === 'yes';
        $('mesh-error').hidden = true;
        toggle.disabled = true;
        const path = on ? `${API}/meshcentral/disable` : `${API}/meshcentral/enable`;
        void post(path, {}).then(() => { void paintScreen(); }).catch((error) => {
            $('mesh-error').textContent = error.message; $('mesh-error').hidden = false; toggle.disabled = false;
        });
    });
    /* WHAT HAPPENED: newest first, a page at a time; chosen by kind, searched. */
    const EVENT_WORDS = { conversation: 'Conversation', machine: 'Machine', access: 'Access', asset: 'Asset', update: 'Update', server: 'Server', 'sign-in': 'Sign-in' };
    let eventsShown = []; let eventsAsk = 0;
    async function paintEvents({ more = false } = {}) {
        const ask = ++eventsAsk;
        const before = more && eventsShown.length ? eventsShown.at(-1).at : '';
        const q = new URLSearchParams({ kind: $('events-kind').value, q: $('events-q').value.trim(), limit: '100', ...(before ? { before } : {}) });
        const got = await fetch(`${API}/events?${q}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (ask !== eventsAsk) return;
        if (!got) { $('events-said').textContent = 'Activity cannot be read just now.'; return; }
        eventsShown = more ? [...eventsShown, ...got] : got;
        const list = $('events-list'); if (!more) list.replaceChildren();
        for (const e of got) {
            const li = el('li', 'event'); li.dataset.kind = e.kind;
            const when = el('time', 'event-when', new Date(e.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })); when.dateTime = e.at;
            /* Which conversation, in a column of its own (and out of the text, where older lines put it first): one click opens it. */
            const conv = el('span', 'event-conv');
            let text = e.text;
            if (e.conversation) {
                if (text.startsWith(`${e.conversation}: `)) text = text.slice(e.conversation.length + 2);
                const open = el('button', 'as-link', e.conversation); open.type = 'button'; open.title = `Open ${e.conversation}`;
                open.disabled = !conversations.some((c) => c.name === e.conversation);
                open.addEventListener('click', () => { leavePlace(); select(e.conversation); });
                conv.append(open);
            }
            li.append(when, el('span', 'event-kind', EVENT_WORDS[e.kind] ?? e.kind), conv, el('span', 'event-text', text));
            if (e.who && !e.text.includes(e.who)) li.append(el('span', 'event-who', e.who));
            list.append(li);
        }
        $('events-said').textContent = eventsShown.length ? '' : 'Nothing yet.';
        $('events-more').hidden = got.length < 100;
    }
    $('settings-events-top').addEventListener('toggle', () => { if ($('settings-events-top').open) void paintEvents(); });
    $('events-kind').addEventListener('change', () => { void paintEvents(); });
    let eventsTyping;
    $('events-q').addEventListener('input', () => { clearTimeout(eventsTyping); eventsTyping = setTimeout(() => { void paintEvents(); }, 250); });
    $('events-more').addEventListener('click', () => { void paintEvents({ more: true }); });
    $('events-copy').addEventListener('click', async () => {
        const text = eventsShown.map((e) => `${e.at}\t${e.kind}\t${e.conversation ?? ''}\t${e.text}${e.who ? `\t${e.who}` : ''}`).join('\n');
        try { await navigator.clipboard.writeText(text); $('events-said').textContent = `Copied: ${eventsShown.length} lines.`; } catch { $('events-said').textContent = 'The clipboard is not available here.'; }
    });
    /* WHAT THE SERVER'S PROGRAMS SAID: one source over a span, to read, copy whole or keep as a file. */
    let logsShown = null;
    $('logs-show').addEventListener('click', async () => {
        const source = $('logs-source').value; const span = $('logs-span').value;
        $('logs-said').textContent = 'Reading...'; $('logs-show').disabled = true;
        try {
            /* A big journal takes a while: the server says "still reading" (202), and is asked again. */
            let r; let body = {};
            for (let i = 0; i < 30; i++) {
                r = await fetch(`${API}/server/logs?source=${encodeURIComponent(source)}&span=${encodeURIComponent(span)}`);
                body = await r.json().catch(() => ({}));
                if (r.status === 202 || (r.status === 503 && body.down === true)) { $('logs-said').textContent = `Reading... (a big journal: ${(i + 1) * 12} s)`; continue; }
                break;
            }
            if (r.status === 202) throw new Error('The logs take too long to read: try a shorter span.');
            if (!r.ok) throw new Error(body.error ?? `The logs could not be read (${r.status}).`);
            logsShown = body;
            $('logs-text').textContent = body.text || '';
            $('logs-text').hidden = !body.text; $('logs-acts').hidden = !body.text;
            $('logs-said').textContent = body.lines ? `${body.lines} line${body.lines > 1 ? 's' : ''}${body.cut ? ' (the newest only: there were more)' : ''}.` : 'Nothing was said over that span.';
            /* The newest at the bottom, in sight. */
            $('logs-text').scrollTop = $('logs-text').scrollHeight;
        } catch (error) { $('logs-said').textContent = error.message; }
        $('logs-show').disabled = false;
    });
    $('logs-copy').addEventListener('click', async () => {
        if (!logsShown?.text) return;
        try { await navigator.clipboard.writeText(logsShown.text); $('logs-said').textContent = `Copied: ${logsShown.lines} lines.`; }
        catch {
            /* No clipboard (plain http, an old browser): all of it selected, for Ctrl+C. */
            const range = document.createRange(); range.selectNodeContents($('logs-text'));
            const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
            $('logs-said').textContent = 'Selected: copy it with Ctrl+C (or the menu of your device).';
        }
    });
    $('logs-save').addEventListener('click', () => {
        if (!logsShown?.text) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([logsShown.text], { type: 'text/plain' }));
        a.download = `clavarium-${logsShown.source}-${logsShown.span === 'boot' ? 'since-start' : `${logsShown.span}h`}-${new Date().toISOString().slice(0, 16).replace(':', '')}.log`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
    /* CLAVARIUM, OR THE WHOLE SERVER, STARTED AGAIN: asked twice (the second says what it does).
       Clavarium: its program only, machines go on. The server (04-11): every machine stops with it. */
    for (const [id, path, kind, sure, label] of [['server-restart', 'restart', 'restart', 'Yes: restart Clavarium now', 'Restart Clavarium...'], ['server-reboot', 'reboot', 'reboot', 'Yes: stop every machine and restart the server', 'Restart the server...']]) {
        $(id).addEventListener('click', () => {
            const go = $(id);
            if (go.dataset.sure !== 'yes') { go.dataset.sure = 'yes'; go.textContent = sure; return; }
            go.disabled = true;
            void post(`${API}/server/${path}`, {}).then(() => {
                $(`${id}-said`).textContent = 'Restarting: this page comes back by itself.';
                /* The maintenance page waits for it (it answers a moment more before it stops), then comes back here. */
                location.replace(`/maintenance.html?${new URLSearchParams({ kind, back: location.pathname + location.search })}`);
            }).catch((error) => { $(`${id}-said`).textContent = error.message; go.disabled = false; delete go.dataset.sure; go.textContent = label; });
        });
    }
    /* THE CURVES (server/history.mjs): memory, CPU and disk over time, one small chart each, one
       line each on one scale (0 to 100 %); the reserve as a dotted level; a dot where a program
       was stopped for lack of memory. Hovered or touched: the value and the time under it. */
    const CURVES = [['memory', 'Memory'], ['cpu', 'CPU'], ['disk', 'Disk']];
    const svgEl = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
    const curveTime = (t, span) => new Date(t).toLocaleString([], span === '7d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    function drawCurve(r, key, label) {
        const W = 300; const H = 72; const top = 4; const bottom = H - 4;
        const box = el('figure', 'curve'); box.dataset.measure = key;
        const values = r[key] ?? []; const known = values.filter((v) => v !== null);
        const head = el('figcaption', 'curve-head');
        const now = [...values].reverse().find((v) => v !== null);
        head.append(el('b', '', label), el('span', 'curve-now', now === undefined ? 'not measured yet' : `${Math.round(now)} %`), el('span', 'curve-max', known.length ? `highest ${Math.round(Math.max(...known))} %` : ''));
        const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label} over time: ${now === undefined ? 'not measured yet' : `${Math.round(now)} % now`}${known.length ? `, highest ${Math.round(Math.max(...known))} %` : ''}` });
        const x = (t) => ((t - r.from) / Math.max(1, r.to - r.from)) * W;
        const y = (v) => bottom - (v / 100) * (bottom - top);
        svg.append(svgEl('line', { x1: 0, x2: W, y1: bottom, y2: bottom, class: 'curve-base' }));
        const level = r.reserve?.[key];
        if (Number.isFinite(level)) svg.append(svgEl('line', { x1: 0, x2: W, y1: y(level), y2: y(level), class: 'curve-reserve' }));
        /* A gap in the looks (the server was down, the machine asleep) is a gap in the line. */
        const step = r.span === '7d' ? 15 * 60_000 : 60_000;
        let d = ''; let prev = null;
        r.t.forEach((t, i) => { const v = values[i]; if (v === null) { prev = null; return; } d += `${prev === null || t - prev > 3 * step ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`; prev = t; });
        if (d) svg.append(svgEl('path', { d, class: 'curve-line', 'vector-effect': 'non-scaling-stroke' }));
        for (const t of r.marks ?? []) { const m = svgEl('circle', { cx: x(t), cy: top + 3, r: 3, class: 'curve-mark' }); const title = svgEl('title', {}); title.textContent = `${curveTime(t, r.span)}: a program was stopped for lack of memory`; m.append(title); svg.append(m); }
        const cross = svgEl('line', { x1: 0, x2: 0, y1: top, y2: bottom, class: 'curve-cross' }); cross.style.display = 'none'; svg.append(cross);
        const tip = el('span', 'curve-tip'); tip.hidden = true;
        svg.addEventListener('pointermove', (event) => {
            if (!r.t.length) return;
            const at = svg.getBoundingClientRect(); const t = r.from + ((event.clientX - at.left) / at.width) * (r.to - r.from);
            let best = 0; r.t.forEach((u, i) => { if (Math.abs(u - t) < Math.abs(r.t[best] - t)) best = i; });
            cross.setAttribute('x1', x(r.t[best])); cross.setAttribute('x2', x(r.t[best])); cross.style.display = '';
            tip.textContent = `${curveTime(r.t[best], r.span)}: ${values[best] === null ? 'not measured' : `${Math.round(values[best])} %`}`; tip.hidden = false;
        });
        svg.addEventListener('pointerleave', () => { cross.style.display = 'none'; tip.hidden = true; });
        const plot = el('div', 'curve-plot'); plot.append(svg, tip);
        const foot = el('div', 'curve-foot'); foot.append(el('span', '', curveTime(r.from, r.span)), el('span', '', 'now'));
        box.append(head, plot, foot);
        if (Number.isFinite(level)) box.append(el('small', 'hint curve-legend', '..... the reserve: what must stay free'));
        /* Said, not only on hover (a tablet has none): what a red dot is, and how many. */
        if (r.marks?.length) box.append(el('small', 'hint curve-legend curve-legend-oom', `● ${r.marks.length === 1 ? 'a program was' : `${r.marks.length} times a program was`} stopped for lack of memory`));
        return box;
    }
    const curvesAt = new WeakMap();
    async function paintCurves(box, { force = false } = {}) {
        const of = box.dataset.of; if (!of) { box.hidden = true; return; }
        const span = box.dataset.span || '1h';
        const was = curvesAt.get(box);
        if (!force && was && was.of === of && was.span === span && Date.now() - was.at < 30_000) return;
        curvesAt.set(box, { of, span, at: Date.now() });
        const r = await fetch(`${API}/history?of=${encodeURIComponent(of)}&span=${span}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (box.dataset.of !== of) return;
        box.hidden = !r; if (!r) return;
        box.querySelector('.curves-row').replaceChildren(...CURVES.map(([key, label]) => drawCurve(r, key, label)));
    }
    for (const box of document.querySelectorAll('.curves')) {
        box.querySelector('.curves-span').addEventListener('click', (event) => {
            const b = event.target.closest('button[data-span]'); if (!b) return;
            box.dataset.span = b.dataset.span;
            for (const x of box.querySelectorAll('.curves-span button')) x.setAttribute('aria-pressed', String(x === b));
            void paintCurves(box, { force: true });
        });
    }
    /* Kept current while in sight: a new look a minute. */
    setInterval(() => { for (const box of document.querySelectorAll('.curves')) if (box.offsetParent !== null) void paintCurves(box, { force: true }); }, 60_000);
    /* SETTINGS, USAGE (server/history.mjs together(); GET /api/history/all): who takes the memory, the CPU
       and the disk -- each machine and this server itself, in GB and cores, now (three tiles) and over time
       (one stacked chart), then ranked. One colour per conversation, given by the order of the names: a
       conversation keeps its colour whatever its rank, and from one span or measure to the next. */
    const USAGE_WORD = { memory: 'Memory', cpu: 'CPU', disk: 'Disk' };
    const USAGE_SPAN = { '1h': '1 h', '24h': '24 h', '7d': '7 days' };
    const usage = { r: null, measure: 'memory', span: '24h', focus: null };
    const uEsc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const uKey = (m) => (m === 'cpu' ? 'cores' : `${m}Gb`);
    const uFix = (v, d) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
    const uFmt = (m, v) => (m === 'cpu' ? `${uFix(v, 1)} ${uFix(v, 1) === '1.0' ? 'core' : 'cores'}` : `${uFix(v, m === 'disk' && v >= 10 ? 0 : 1)} GB`);
    const uAlloc = (m, v) => (m === 'cpu' ? `${v} ${v === 1 ? 'core' : 'cores'}` : `${uFix(v, Number.isInteger(v) ? 0 : 1)} GB`);
    const uAgo = (ms) => { const m = Math.round(ms / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
    const uWhen = (t) => new Date(t).toLocaleString([], usage.span === '7d' ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    /* Six colours, then the same six hatched; past twelve, the rest is one "others" (never a colour reused silently). */
    const uFill = (x) => (x.hatch ? `repeating-linear-gradient(135deg, var(--${x.c}) 0 3px, transparent 3px 5px)` : `var(--${x.c})`);
    function usageWho(r) {
        const all = [...r.machines].sort((a, b) => a.name.localeCompare(b.name));
        const many = all.length > 12; const shown = many ? all.slice(0, 11) : all;
        const who = shown.map((x, i) => ({ ...x, key: x.name, c: `s${(i % 6) + 1}`, hatch: i >= 6 }));
        if (many) {
            const rest = all.slice(11);
            const sum = (m) => r.t.map((_, i) => (rest.some((x) => x[m][i] !== null) ? rest.reduce((a, x) => a + (x[m][i] ?? 0), 0) : null));
            const alloc = (k) => rest.reduce((a, x) => a + (x.alloc[k] ?? 0), 0);
            who.push({ name: `${rest.length} others`, key: '__others', c: 's0', hatch: true, asleep: rest.every((x) => x.asleep), since: null, alloc: { memoryGb: alloc('memoryGb'), cores: alloc('cores'), diskGb: alloc('diskGb') }, memory: sum('memory'), cpu: sum('cpu'), disk: sum('disk'), marks: rest.flatMap((x) => x.marks) });
        }
        return who;
    }
    const uAsleep = (x, m) => x.asleep && m !== 'disk';
    const uLast = (r, m) => { for (let i = r.t.length - 1; i >= 0; i -= 1) if (r.server[m][i] !== null) return i; return -1; };
    const uCap = (r, m) => r.capacity[uKey(m)] ?? Math.max(1, ...r.server[m].filter((v) => v !== null));
    function paintUsageTiles(r, who) {
        const box = $('usage-tiles'); box.replaceChildren();
        for (const m of ['memory', 'cpu', 'disk']) {
            const i = uLast(r, m); const cap = uCap(r, m);
            const parts = who.map((x) => ({ x, v: i < 0 ? 0 : x[m][i] ?? 0 }));
            const itself = i < 0 ? 0 : r.itself[m][i] ?? 0;
            const used = i < 0 ? 0 : r.server[m][i];
            const top = [...parts].sort((a, b) => b.v - a.v)[0];
            const b = el('button', 'u-tile'); b.type = 'button'; b.setAttribute('aria-pressed', String(usage.measure === m));
            const seg = (name, v, fill, faded) => `<span title="${uEsc(name)} · ${uFmt(m, v)}" style="width:${(v / cap) * 100}%;background:${fill}${faded ? ';opacity:.25' : ''}"></span>`;
            b.innerHTML = `<div class="u-tile-head"><span class="u-tile-what">${USAGE_WORD[m]}</span><span class="u-tile-pct u-num">${i < 0 ? '' : `${Math.round((used / cap) * 100)} %`}</span></div>
                <div class="u-tile-big u-num">${i < 0 ? '—' : uFmt(m, used)} <small>of ${uAlloc(m, cap)}</small></div>
                <div class="u-stack" aria-hidden="true">${parts.filter((p) => p.v > 0).map((p) => seg(p.x.name, p.v, uFill(p.x), usage.focus && usage.focus !== p.x.key)).join('')}${itself > 0 ? seg('This server itself', itself, 'var(--s0)', Boolean(usage.focus)) : ''}</div>
                <div class="u-tile-foot"><span>Free ${i < 0 ? '—' : uFmt(m, Math.max(0, cap - used))}</span><span>${top?.v > 0 ? `Most: ${uEsc(top.x.name)}` : ''}</span></div>`;
            b.addEventListener('click', () => { usage.measure = m; paintUsageAll(); });
            box.append(b);
        }
    }
    function paintUsageLegend(who) {
        $('usage-legend').replaceChildren(...who.map((x) => {
            const b = el('button', `u-chip${x.asleep ? ' asleep' : ''}`); b.type = 'button'; b.setAttribute('aria-pressed', String(usage.focus === x.key));
            const sw = el('i'); sw.style.background = uFill(x);
            b.append(sw, document.createTextNode(x.name)); if (x.asleep) b.append(document.createTextNode(' '), el('span', 'u-z', 'asleep'));
            b.addEventListener('click', () => usageFocus(x.key));
            return b;
        }));
    }
    function uNiceStep(max, ticks) { const raw = max / ticks; const p = 10 ** Math.floor(Math.log10(raw)); for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p; return 10 * p; }
    let usageGeo = null;
    function paintUsageChart(r, who) {
        const svg = $('usage-svg'); svg.replaceChildren(); $('usage-tip').hidden = true;
        const m = usage.measure; const N = r.t.length;
        const W = $('usage-plot').clientWidth || 600; usageWidth = W; const phone = W < 560; const H = phone ? 230 : 300;
        const M = { l: phone ? 34 : 44, r: phone ? 6 : 128, t: 14, b: 24 };
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
        $('usage-chart-title').textContent = `${USAGE_WORD[m]} over time`;
        $('usage-k-oom').hidden = m !== 'memory';
        const cap = uCap(r, m);
        /* The machines in their fixed order, bottom to top; the server itself on top. */
        const layers = [...who.map((x) => ({ key: x.key, x, v: x[m] })), { key: '__sys', x: { c: 's0', name: 'This server itself' }, v: r.itself[m] }];
        const tops = []; let acc = new Array(N).fill(0);
        for (const L of layers) { const lo = acc; const hi = lo.map((a, i) => a + (L.v[i] ?? 0)); tops.push({ ...L, lo, hi }); acc = hi; }
        const ymax = Math.max(cap, ...acc) * 1.06;
        const step = uNiceStep(ymax, phone ? 4 : 5);
        const t0 = r.from; const t1 = r.to; const pw = W - M.l - M.r;
        const x = (t) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * pw;
        const y = (v) => H - M.b - (v / ymax) * (H - M.t - M.b);
        for (let v = 0; v <= ymax; v += step) { svg.append(svgEl('line', { class: v === 0 ? 'u-base' : 'u-gridline', x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) })); const tx = svgEl('text', { x: M.l - 6, y: y(v) + 4, 'text-anchor': 'end' }); tx.textContent = String(Math.round(v * 10) / 10); svg.append(tx); }
        const unit = svgEl('text', { x: M.l - 6, y: M.t - 4, 'text-anchor': 'end' }); unit.textContent = m === 'cpu' ? 'cores' : 'GB'; svg.append(unit);
        /* Time ticks: midnights over a week, round hours (or ten minutes) else. */
        const tickStep = usage.span === '7d' ? 24 * 3600_000 : usage.span === '1h' ? (phone ? 15 : 10) * 60_000 : (phone ? 6 : 3) * 3600_000;
        const first = new Date(t0); if (usage.span === '7d') first.setHours(24, 0, 0, 0); else first.setTime(Math.ceil(t0 / tickStep) * tickStep);
        for (let t = first.getTime(); t <= t1; t += tickStep) {
            if (x(t) < M.l + 14 || x(t) > W - M.r - 14) continue;
            const e = svgEl('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }); e.textContent = new Date(t).toLocaleString([], usage.span === '7d' ? { weekday: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' }); svg.append(e);
        }
        /* Hatched fills, for the seventh conversation on. */
        const defs = svgEl('defs', {}); svg.append(defs);
        const fillOf = (L) => { if (!L.x.hatch) return `fill:var(--${L.x.c})`; const id = `u-h-${L.x.c}`; if (!defs.querySelector(`#${id}`)) { const p = svgEl('pattern', { id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }); p.append(svgEl('rect', { width: 3, height: 5, style: `fill:var(--${L.x.c})` })); defs.append(p); } return `fill:url(#${id})`; };
        /* A gap in the looks (the server was down) is a gap in the chart: one shape per run of looks. */
        const gap = 3 * (usage.span === '7d' ? 15 * 60_000 : 60_000);
        const runs = []; let run = null;
        r.t.forEach((t, i) => { if (r.server[m][i] === null) { run = null; return; } if (!run || t - r.t[i - 1] > gap) { run = []; runs.push(run); } run.push(i); });
        const g = svgEl('g', {}); svg.append(g);
        for (const L of tops) {
            const faded = usage.focus && usage.focus !== L.key; const focused = usage.focus === L.key;
            for (const ix of runs) {
                let d = ix.map((i, k) => `${k ? 'L' : 'M'}${x(r.t[i]).toFixed(1)},${y(L.hi[i]).toFixed(1)}`).join('');
                const top = d;
                d += [...ix].reverse().map((i) => `L${x(r.t[i]).toFixed(1)},${y(L.lo[i]).toFixed(1)}`).join('');
                g.append(svgEl('path', { d: `${d}Z`, class: `u-band${faded ? ' u-faded' : ''}`, style: fillOf(L), 'fill-opacity': focused ? 0.95 : L.key === '__sys' ? 0.55 : 0.78 }));
                if (!faded && L.key !== '__sys') g.append(svgEl('path', { d: top, class: 'u-band-top', style: `stroke:var(--${L.x.c})${L.x.hatch ? ';stroke-dasharray:4 2' : ''}` }));
            }
        }
        svg.append(svgEl('line', { class: 'u-cap', x1: M.l, x2: W - M.r, y1: y(cap), y2: y(cap) }));
        const capWord = svgEl('text', { x: M.l + 6, y: y(cap) - 6 }); capWord.textContent = `Capacity · ${uAlloc(m, Math.round(cap * 10) / 10)}`; svg.append(capWord);
        /* Memory full: a red mark on the band of its conversation. */
        if (m === 'memory') for (const L of tops) for (const at of L.x.marks ?? []) {
            if (usage.focus && usage.focus !== L.key) continue;
            const i = r.t.findIndex((t) => t >= at); if (i < 0) continue;
            svg.append(svgEl('circle', { class: 'u-oom', cx: x(r.t[i]), cy: y(L.hi[i]), r: 5 }));
            if (!phone) { const end = x(r.t[i]) > W - M.r - 50; const w = svgEl('text', { x: end ? x(r.t[i]) + 4 : x(r.t[i]), y: y(L.hi[i]) - 10, 'text-anchor': end ? 'end' : 'middle', class: 'u-oom-word' }); w.textContent = 'memory full'; svg.append(w); }
        }
        /* Names at the right end, for bands thick enough; pushed apart so none overlaps. */
        const last = runs.at(-1)?.at(-1);
        if (!phone && last !== undefined) {
            const words = [];
            for (const L of tops) { const h = y(L.lo[last]) - y(L.hi[last]); if (L.key === '__sys' || h >= 7) words.push({ L, y: (y(L.lo[last]) + y(L.hi[last])) / 2, text: L.key === '__sys' ? 'server' : L.x.name.length > 18 ? `${L.x.name.slice(0, 17)}…` : L.x.name }); }
            words.sort((a, b) => b.y - a.y);
            for (let k = 1; k < words.length; k += 1) if (words[k - 1].y - words[k].y < 14) words[k].y = words[k - 1].y - 14;
            for (const w of words) { const e = svgEl('text', { x: W - M.r + 8, y: w.y + 4, class: `u-direct${w.L.key === '__sys' || (usage.focus && usage.focus !== w.L.key) ? ' dim' : ''}` }); e.textContent = w.text; svg.append(e); }
        }
        const cross = svgEl('line', { class: 'u-cross', y1: M.t, y2: H - M.b, visibility: 'hidden' }); svg.append(cross);
        const hit = svgEl('rect', { x: M.l, y: 0, width: Math.max(0, pw), height: H, fill: 'transparent' }); svg.append(hit);
        usageGeo = { x, y, W, H, M, tops, cross, ymax, pw, t0, t1 };
        svg.setAttribute('aria-label', `${USAGE_WORD[m]} per conversation, ${USAGE_SPAN[usage.span]}. The table below gives the same figures.`);
        hit.addEventListener('pointermove', usageHover); hit.addEventListener('pointerdown', usageHover);
        hit.addEventListener('pointerleave', () => { $('usage-tip').hidden = true; cross.setAttribute('visibility', 'hidden'); });
        hit.addEventListener('click', (event) => { const p = usagePick(event); if (!p) return; const L = usageGeo.tops.find((q) => q.key !== '__sys' && p.v >= q.lo[p.i] && p.v <= q.hi[p.i] && q.hi[p.i] > q.lo[p.i]); usageFocus(L ? L.key : null); });
    }
    function usagePick(event) {
        const r = usage.r; if (!r?.t.length || !usageGeo) return null;
        const at = $('usage-svg').getBoundingClientRect(); const px = event.clientX - at.left; const py = event.clientY - at.top;
        const { M, H, ymax, pw, t0, t1 } = usageGeo;
        const t = t0 + ((px - M.l) / pw) * (t1 - t0);
        let i = 0; r.t.forEach((u, k) => { if (Math.abs(u - t) < Math.abs(r.t[i] - t)) i = k; });
        return { i, px, v: ((H - M.b - py) / (H - M.t - M.b)) * ymax };
    }
    function usageHover(event) {
        const p = usagePick(event); if (!p) return;
        const r = usage.r; const m = usage.measure; const { i, px } = p; const { x, tops, cross, W } = usageGeo;
        const tip = $('usage-tip');
        if (r.server[m][i] === null) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); return; }
        cross.setAttribute('x1', x(r.t[i])); cross.setAttribute('x2', x(r.t[i])); cross.setAttribute('visibility', 'visible');
        const rows = [...tops].reverse().map((L) => {
            const zz = L.key !== '__sys' && L.v[i] === null;
            return `<div class="u-tip-row${zz ? ' asleep' : ''}${usage.focus === L.key ? ' focus' : ''}"><i class="u-sw" style="background:${L.key === '__sys' ? 'var(--s0)' : uFill(L.x)}"></i><span>${L.key === '__sys' ? 'this server itself' : uEsc(L.x.name)}</span><b>${zz ? 'asleep' : uFmt(m, L.v[i] ?? 0)}</b></div>`;
        }).join('');
        const near = usage.span === '7d' ? 15 * 60_000 : 2 * 60_000;
        const oom = m === 'memory' ? tops.find((L) => (L.x.marks ?? []).some((at) => Math.abs(at - r.t[i]) <= near)) : null;
        tip.innerHTML = `<div class="u-tip-when">${uWhen(r.t[i])}${usage.span === '7d' ? ' <span class="hint">(peak of 15 min)</span>' : ''}</div>${rows}<div class="u-tip-total"><span>Total</span><b>${uFmt(m, r.server[m][i])} / ${uAlloc(m, Math.round(uCap(r, m) * 10) / 10)}</b></div>${oom ? `<div class="u-tip-oom">▲ ${uEsc(oom.x.name)}: memory full</div>` : ''}`;
        tip.hidden = false;
        if (getComputedStyle(tip).position === 'static') return;
        const tw = tip.offsetWidth;
        let left = px + 14; if (left + tw > W) left = px - tw - 14; if (left < 0) left = Math.max(0, Math.min(W - tw, px - tw / 2));
        tip.style.left = `${left}px`;
    }
    function usageFacts(r, x, m) {
        const a = x[m]; const A = x.alloc[uKey(m)] || 1; const pct = a.map((v) => (v === null ? null : (v / A) * 100));
        const i = uLast(r, m); const now = i < 0 ? null : a[i];
        let pk = -1; let pi = 0; pct.forEach((v, k) => { if (v !== null && v > pk) { pk = v; pi = k; } });
        const known = pct.filter((v) => v !== null);
        const high = known.filter((v) => v >= 95).length;
        const over80 = known.length ? known.filter((v) => v >= 80).length / known.length : 0;
        const ooms = m === 'memory' ? (x.marks ?? []).filter((t) => t >= r.from).length : 0;
        let note = ''; let alert = false;
        if (uAsleep(x, m)) note = x.since ? `asleep for ${uAgo(r.to - x.since)}` : 'asleep';
        else if (ooms) { note = `${high ? 'reached 95 % · ' : ''}memory full ${ooms === 1 ? 'once' : `${ooms} times`}`; alert = true; }
        else if (high) { note = m === 'cpu' ? 'used all its cores' : 'reached 95 %'; alert = m !== 'cpu'; }
        else if (over80 > 0.2) note = 'often above 80 %';
        else if (pk >= 0 && pk < 30 && m !== 'disk') note = 'roomy: little used';
        return { now, nowP: now === null ? null : (now / A) * 100, pk, pkA: pk >= 0 ? a[pi] : 0, pkT: r.t[pi], note, alert, A };
    }
    function usageSpark(r, x, m, wide) {
        const a = x[m]; const lim = x.alloc[uKey(m)] || 1; const W = wide ? 340 : 120; const H = wide ? 34 : 30;
        const sx = (t) => ((t - r.from) / Math.max(1, r.to - r.from)) * W; const sy = (v) => H - 2 - (Math.min(v, lim) / lim) * (H - 4);
        let d = ''; let pen = false;
        a.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${sx(r.t[i]).toFixed(1)},${sy(v).toFixed(1)}`; pen = true; });
        const marks = m === 'memory' ? (x.marks ?? []).map((at) => { const i = r.t.findIndex((t) => t >= at); return i < 0 || a[i] === null ? '' : `<circle class="u-oom" cx="${sx(r.t[i])}" cy="${sy(a[i])}" r="3.2"/>`; }).join('') : '';
        const zz = uAsleep(x, m) ? `<line x1="${Math.max(0, sx(x.since ?? r.from))}" x2="${W}" y1="${H - 2}" y2="${H - 2}" stroke="var(--ink2)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>` : '';
        return `<svg class="u-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line class="u-lim" x1="0" x2="${W}" y1="2" y2="2" vector-effect="non-scaling-stroke"/><path d="${d}" fill="none" stroke="var(--${x.c})" stroke-width="1.75"${x.hatch ? ' stroke-dasharray="4 2"' : ''} vector-effect="non-scaling-stroke" stroke-linejoin="round"/>${zz}${marks}</svg>`;
    }
    function paintUsageList(r, who) {
        const m = usage.measure; const span = USAGE_SPAN[usage.span];
        $('usage-list-title').textContent = `${USAGE_WORD[m]} per conversation`;
        const rows = who.map((x) => ({ x, f: usageFacts(r, x, m) })).sort((a, b) => uAsleep(a.x, m) - uAsleep(b.x, m) || (b.f.now ?? -1) - (a.f.now ?? -1));
        const name = (x) => `<span class="u-who"><i class="u-sw" style="background:${uFill(x)}"></i>${uEsc(x.name)}${uAsleep(x, m) ? ' <span class="u-zz">asleep</span>' : ''}</span>`;
        const quiet = (x, f) => uAsleep(x, m) || f.now === null;
        $('usage-rank').innerHTML = `<thead><tr><th>Conversation</th><th class="r">Now</th><th class="r">Peak · ${span}</th><th>Over ${span}</th><th class="r">Given</th><th>Note</th></tr></thead><tbody>${
            rows.map(({ x, f }) => `<tr data-k="${uEsc(x.key)}" class="${uAsleep(x, m) ? 'asleep' : ''}" aria-selected="${usage.focus === x.key}" tabindex="0">
                <td>${name(x)}</td>
                <td class="r u-num">${quiet(x, f) ? '—' : `<span class="u-big">${uFmt(m, f.now)}</span><span class="u-sub">${Math.round(f.nowP)} % of given</span>`}</td>
                <td class="r u-num">${f.pk < 0 ? '—' : `${uFmt(m, f.pkA)}<span class="u-sub">${Math.round(f.pk)} % · ${uAgo(r.to - f.pkT)} ago</span>`}</td>
                <td>${usageSpark(r, x, m, false)}</td>
                <td class="r u-num">${uAlloc(m, f.A)}</td>
                <td><span class="u-note${f.alert ? ' alert' : ''}">${f.note}</span></td></tr>`).join('')}</tbody>`;
        $('usage-cards').innerHTML = rows.map(({ x, f }) => `<div role="button" tabindex="0" class="u-card${uAsleep(x, m) ? ' asleep' : ''}" data-k="${uEsc(x.key)}" aria-selected="${usage.focus === x.key}">
                ${name(x)}
                <span class="u-now u-num">${quiet(x, f) ? '—' : `<span class="u-big">${uFmt(m, f.now)}</span> <span class="hint">${Math.round(f.nowP)} %</span>`}</span>
                ${usageSpark(r, x, m, true)}
                <span class="u-facts u-num"><span>Peak ${f.pk < 0 ? '—' : `${uFmt(m, f.pkA)} (${Math.round(f.pk)} %)`}</span><span>Given ${uAlloc(m, f.A)}</span></span>
                ${f.note ? `<span class="u-note${f.alert ? ' alert' : ''}">${f.note}</span>` : ''}</div>`).join('');
        for (const row of document.querySelectorAll('#usage-rank tbody tr, #usage-cards .u-card')) {
            row.addEventListener('click', () => usageFocus(row.dataset.k));
            row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); usageFocus(row.dataset.k); } });
        }
    }
    function paintUsageAll() {
        const r = usage.r; if (!r) return;
        for (const b of $('usage-measure').children) b.setAttribute('aria-pressed', String(b.dataset.m === usage.measure));
        for (const b of $('usage-span').children) b.setAttribute('aria-pressed', String(b.dataset.span === usage.span));
        const who = usageWho(r);
        paintUsageTiles(r, who); paintUsageLegend(who); paintUsageChart(r, who); paintUsageList(r, who);
    }
    /* A second touch on the same one, or on nothing, shows them all again. */
    const usageFocus = (key) => { usage.focus = usage.focus === key || !key ? null : key; paintUsageAll(); };
    async function paintUsage() {
        const span = usage.span;
        const r = await fetch(`${API}/history/all?span=${span}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (span !== usage.span) return;
        $('usage-none').hidden = Boolean(r?.t?.length);
        $('usage-none').textContent = r ? 'Nothing measured yet: a look is taken every minute.' : 'Usage cannot be read just now.';
        for (const id of ['usage-tiles', 'usage-legend']) $(id).hidden = !r?.t?.length;
        $('usage').querySelector('.u-chart').hidden = !r?.t?.length; $('usage-rank').parentElement.hidden = !r?.t?.length;
        if (!r?.t?.length) return;
        usage.r = r;
        if (usage.focus && !usageWho(r).some((x) => x.key === usage.focus)) usage.focus = null;
        paintUsageAll();
    }
    $('usage-measure').addEventListener('click', (event) => { const b = event.target.closest('button[data-m]'); if (!b) return; usage.measure = b.dataset.m; paintUsageAll(); });
    $('usage-span').addEventListener('click', (event) => { const b = event.target.closest('button[data-span]'); if (!b) return; usage.span = b.dataset.span; for (const x of $('usage-span').children) x.setAttribute('aria-pressed', String(x === b)); void paintUsage(); });
    /* Usage (#203) is kept out of sight while it is reworked on real machines (operator, 30-10). */
    const USAGE_SHOWN = false;
    $('settings-usage-top').addEventListener('toggle', () => { if ($('settings-usage-top').open) void paintUsage(); });
    /* Drawn again when its width changes only: a phone's bar of address, folding in a scroll, is a resize too. */
    let usageResize; let usageWidth = 0;
    addEventListener('resize', () => { clearTimeout(usageResize); usageResize = setTimeout(() => { const w = $('usage-plot').clientWidth; if (w !== usageWidth && $('settings-usage-top').open && $('usage').offsetParent !== null) paintUsageAll(); }, 80); });
    /* Kept current while in sight: a new look a minute. */
    setInterval(() => { if ($('settings-usage-top').open && $('usage').offsetParent !== null) void paintUsage(); }, 60_000);
    async function paintServer() {
        clearTimeout(serverTimer);
        const r = await fetch(`${API}/server`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        $('settings-server-top').hidden = !r; $('settings-server').hidden = !r; $('settings-usage-top').hidden = !r || !USAGE_SHOWN;
        void paintSettingsHand(r);
        if (!r) return;
        if (r.memory) chapterNow('s-resources', uiSaid('set-res-now', 'Memory {m} % · disk {d} %', { m: Math.round(r.memory.usedPercent), d: Math.round((r.disk?.disks?.[0]?.usedPercent) ?? 0) }));
        void paintCurves($('server-curves'));
        /* The two settings of each: a fixed amount and a share; the larger is kept free. */
        const set = r.settings ?? { ...r.reserve, diskPercent: 0, memoryPercent: 0 };
        const editing = ['reserve-disk', 'reserve-disk-percent', 'reserve-memory', 'reserve-memory-percent'].some((id) => $(id) === document.activeElement);
        if (!editing) {
            $('reserve-disk').value = String(Math.round((set.diskMb / 1024) * 100) / 100); $('reserve-memory').value = String(Math.round((set.memoryMb / 1024) * 100) / 100);
            $('reserve-disk-percent').value = String(set.diskPercent); $('reserve-memory-percent').value = String(set.memoryPercent);
        }
        $('reserve-now').textContent = r.known ? `Kept free now: ${GB(r.reserve.diskMb)} of disk, ${GB(r.reserve.memoryMb)} of memory.` : '';
        /* What was promised, only said: never refused for it. */
        const promised = (line, p, words) => {
            line.hidden = !p; if (!p) return;
            line.dataset.over = String(p.over);
            line.textContent = `${words(GB(p.mb), GB(p.totalMb))}${p.over ? ' That is more than there is: fine while they do not all fill up.' : ''}`;
        };
        promised($('promised-disk'), r.promised?.disk, (mb, total) => `Disks promised to machines, at their largest: ${mb} of ${total}.`);
        promised($('promised-memory'), r.promised?.memory, (mb, total) => `Memory given to running machines: ${mb} of ${total}.`);
        $('server-unknown').hidden = r.known;
        $('server-disks').hidden = !r.disk; $('server-memory').hidden = !r.memory;
        if (r.disk) paintDisks(r);
        if (r.memory) {
            const mem = r.memory;
            $('server-memory-figures').textContent = `${GB(mem.freeMb)} free of ${GB(mem.totalMb)}`;
            meter($('server-memory-meter'), mem.usedPercent, r.reserve.memoryMb, mem.totalMb, levelOf(r.high.memory, mem.usedPercent, mem.freeMb - r.reserve.memoryMb, r.reserve.memoryMb));
            $('server-memory-state').textContent = 'Short'; $('server-memory-state').hidden = !r.high.memory;
            $('server-memory-note').textContent = aboveWords(mem.freeMb - r.reserve.memoryMb, r.reserve.memoryMb);
            const held = r.machines.reduce((a, x) => a + x.rssMb, 0);
            const rest = Math.max(0, mem.totalMb - mem.freeMb - held);
            const named = r.machines.map((x, i) => ({ key: x.name ?? `vm-${i}`, label: x.shelf ? 'ready-made machine (being made)' : (x.name ? machineTitle(x.name) : 'another machine'), mb: x.rssMb, x }));
            const share = shareOf(named, rest, mem.freeMb);
            $('server-memory-share').replaceChildren(...(r.machines.length ? [shareDonut(share.slices, uiSaid('set-share-memory', 'Memory by machine'), mem.totalMb - mem.freeMb, mem.totalMb)] : []));
            parts($('server-memory-parts'), [
                [`Running machines (${r.machines.length})`, held],
                ...named.map(({ key, label, x }) => [label, x.sizeMb ? `uses ${GB(x.rssMb)} · given ${GB(x.sizeMb)}` : `uses ${GB(x.rssMb)}`, true, share.slot.get(key)]),
                ['The system and other programs', rest, false, 'rest'],
            ]);
        }
        /* Still measuring: looked at again in a moment, while Settings is open. */
        if ((r.measuring || !r.usage) && !$('settings').hidden) serverTimer = setTimeout(() => { void paintServer(); }, 4000);
    }
    $('reserve-save').addEventListener('click', async () => {
        $('reserve-error').hidden = true; $('reserve-saved').textContent = '';
        const mb = (id) => { const v = Number.parseFloat($(id).value.replace(',', '.')); return Number.isFinite(v) ? Math.round(v * 1024) : NaN; };
        const share = (id) => { const v = Number($(id).value.trim()); return Number.isInteger(v) && v >= 0 && v <= 100 ? v : NaN; };
        const diskMb = mb('reserve-disk'); const memoryMb = mb('reserve-memory');
        const diskPercent = share('reserve-disk-percent'); const memoryPercent = share('reserve-memory-percent');
        if (!(diskMb >= 0) || !(memoryMb >= 0)) { $('reserve-error').textContent = 'Write a number of gigabytes, 0 or more.'; $('reserve-error').hidden = false; return; }
        if (Number.isNaN(diskPercent) || Number.isNaN(memoryPercent)) { $('reserve-error').textContent = 'Write a whole percent, from 0 to 100.'; $('reserve-error').hidden = false; return; }
        try { await post(`${API}/server/reserve`, { diskMb, diskPercent, memoryMb, memoryPercent }); $('reserve-saved').textContent = 'Saved.'; } catch (error) { $('reserve-error').textContent = error.message; $('reserve-error').hidden = false; return; }
        await paintServer(); void paintGauge();
    });
    /* THE SMALL GAUGE at the bottom of the list: only when disk or memory is
       short. A click opens Settings, at This server. */
    async function paintGauge() {
        if (DEVICE) return;
        const r = await fetch(`${API}/server/brief`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const g = $('server-gauge');
        /* The VM manager does not answer: said here, whatever the room. */
        const away = r?.machines === false;
        if (!r?.high && !away) { g.hidden = true; return; }
        g.replaceChildren();
        if (away) {
            const t = document.createElement('span'); t.className = 'gauge-title'; t.textContent = 'The machines cannot be reached just now';
            g.append(t); g.setAttribute('aria-label', 'The machines cannot be reached just now: the server keeps trying.'); g.hidden = false;
            if (!r.high) return;
        }
        const row = (label, f) => {
            const line = document.createElement('span'); line.className = 'gauge-line'; line.dataset.level = f.level;
            const word = document.createElement('span'); word.className = 'gauge-word'; word.textContent = label;
            const bar = document.createElement('span'); bar.className = 'gauge-bar'; const fill = document.createElement('span'); fill.style.width = `${Math.min(100, f.usedPercent)}%`; bar.append(fill);
            /* What is left before the reserve: what decides whether a machine is refused. */
            const n = document.createElement('span'); n.className = 'gauge-n'; n.textContent = f.aboveMb >= 0 ? `${GB(f.aboveMb)} left` : 'reserve reached';
            line.append(word, bar, n); return line;
        };
        const title = document.createElement('span'); title.className = 'gauge-title'; title.textContent = 'This server is short of room';
        g.append(title);
        if (r.disk) g.append(row('Disk', r.disk));
        if (r.memory) g.append(row('Memory', r.memory));
        const more = document.createElement('span'); more.className = 'gauge-more'; more.textContent = 'See what takes room \u203a';
        g.append(more);
        g.setAttribute('aria-label', `This server is short of room: ${[r.disk?.high ? `disk, ${GB(r.disk.aboveMb)} left before the reserve` : '', r.memory?.high ? `memory, ${GB(r.memory.aboveMb)} left before the reserve` : ''].filter(Boolean).join('; ')}. Open Settings, This server.`);
        g.hidden = false;
    }
    $('server-gauge').addEventListener('click', async () => {
        if (place !== 'settings') await openSettings(); else await paintServer();
        const top = openChapter('s-resources');
        top.scrollIntoView({ block: 'start' });
        $('settings-server').focus({ preventScroll: true });
    });
    /* The ready-made machine: when it was made, how large, what it holds,
       and a rebuild on demand. Why a rebuild was refused is said here. */
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    let shelfTimer;
    async function paintShelf() {
        clearTimeout(shelfTimer);
        const r = await fetch(`${API}/shelf`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        $('shelf').hidden = !r;
        if (!r) return;
        const lines = [];
        if (r.current) {
            lines.push(`Made ${day(r.current.builtAt)}${r.current.sizeMb ? ` · ${(r.current.sizeMb / 1024).toFixed(1)} GB` : ''} · holds ${r.current.tools.join(', ') || 'no tool'}`);
            lines.push(r.current.fresh ? `next rebuild around ${day(r.current.refreshAt)}` : `older than ${r.maxAgeDays} days: new conversations take longer`);
        } else lines.push('None yet: new conversations take several minutes');
        if (r.building) lines.push(`rebuilding since ${new Date(r.building.since).toLocaleTimeString()} (${r.building.step})`);
        if (r.error && !r.building) lines.push(`last rebuild failed: ${r.error}`);
        $('shelf-state').textContent = lines.join(' · ');
        $('shelf-error').hidden = !r.refused || Boolean(r.building);
        $('shelf-error').textContent = r.refused?.text ?? '';
        $('shelf-rebuild').disabled = Boolean(r.building);
        if (r.building && !$('settings').hidden) shelfTimer = setTimeout(() => { void paintShelf(); }, 5000);
    }
    $('shelf-rebuild').addEventListener('click', async () => {
        $('shelf-rebuild').disabled = true; $('shelf-error').hidden = true;
        let refused;
        try { await post(`${API}/shelf/rebuild`, {}); } catch (error) { refused = error.message; }
        await paintShelf();
        if (refused) { $('shelf-error').textContent = refused; $('shelf-error').hidden = false; }
    });
    /* The git servers whose key was recorded at first contact: forgetting
       one is rare and weighty (the next contact trusts any key), so it is
       here, out of the way, and asks twice. */
    async function paintHosts() {
        const hosts = await fetch(`${API}/git-hosts`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
        const rows = $('git-hosts'); rows.replaceChildren();
        $('git-hosts-empty').hidden = hosts.length > 0;
        for (const h of hosts) {
            const row = document.createElement('div'); row.className = 'list-item folder'; row.dataset.host = h.host;
            const label = document.createElement('div'); label.className = 'set-what';
            const name = document.createElement('b'); name.textContent = h.host;
            const key = document.createElement('small'); key.className = 'mono-cut'; key.textContent = `${h.type} ${h.fingerprint}`; key.title = key.textContent;
            label.append(name, key);
            const forget = document.createElement('button'); forget.type = 'button'; forget.textContent = 'Forget';
            forget.addEventListener('click', async () => {
                if (forget.dataset.sure !== 'yes') { forget.dataset.sure = 'yes'; forget.textContent = 'Yes, forget it'; return; }
                forget.disabled = true; $('git-hosts-error').hidden = true;
                try { await post(`${API}/git-hosts/forget`, { host: h.host }); } catch (error) { $('git-hosts-error').textContent = error.message; $('git-hosts-error').hidden = false; }
                await paintHosts();
            });
            row.append(label, forget); rows.append(row);
        }
    }
    $('settings-close').addEventListener('click', () => leavePlace());
    $('git-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('git-error').hidden = true;
        const button = $('git-new').querySelector('button[type=submit]');
        button.disabled = true; button.textContent = $('git-from').value.trim() ? 'Cloning...' : 'Making...';
        $('git-said').hidden = true;
        const from = $('git-from').value.trim(); const method = viaChosen();
        const via = method === 'ssh-key' ? { method, key: $('git-key').value }
            : method === 'token' ? { method, user: $('git-token-user').value.trim(), secret: $('git-token').value }
                : method === 'password' ? { method, user: $('git-pass-user').value.trim(), secret: $('git-pass').value } : { method };
        try {
            const made = await post(`${API}/resources`, { name: $('git-name').value.trim(), type: 'git', from, ...(from ? { via } : {}) });
            /* The secrets typed are not kept in the page a moment longer. */
            $('git-new').reset(); viaTouched = false; showVia(); fillKeyChoice(via.key);
            /* First contact with its host: said in the ending, kept there. */
            if (made.firstSeen) {
                $('git-said').textContent = `${made.name} was cloned. First contact with ${hostOf(made.from)}: its host key (${made.firstSeen.join(', ')}) was recorded. A different key later will be refused.`;
                $('git-said').hidden = false;
            }
            /* A new repository opens on its card, where it is attached: the next thing to do. */
            await assetMade($('git-box'), { key: `git:${made.name}`, name: made.name, note: made.firstSeen ? $('git-said').textContent : '', give: (to, level) => attachTo(to, made.name, level, 'attach-error') });
        } catch (error) { $('git-error').textContent = error.message; $('git-error').hidden = false; }
        button.disabled = false; button.textContent = 'Create';
        await paintAssets();
    });
    /* ---------- a repository: what would go out, then send it ---------- */
    /* `gitTarget` is the branch the last look was made for: Send sends there
       and nowhere else; choosing another branch looks again first. */
    /* `gitBranch`: the agent's branch shown (the owner's pick in `gitAskedBranch`,
       else the one that moved last). `gitConfirm`: more than the page could
       show, so Send asks once more. `gitFsck`: the owner's fsck waivers. */
    let gitShown = ''; let gitHead = null; let gitTarget = null; let gitAsked = ''; let gitState = ''; let gitRequire = false;
    let gitBranch = null; let gitAskedBranch = ''; let gitConfirm = false; let gitFsck = {}; let gitLast = [];
    const NEW_BRANCH = '\u0000new';
    function paintChecks(result) {
        const state = $('gitview-checks-state'); state.className = '';
        if (!result) { state.textContent = 'Running the checks in the agent\'s machine...'; $('gitview-checks-output').textContent = ''; const mini = $('gitview-numbers').querySelector('.checks-mini'); if (mini) { mini.textContent = 'Checks running...'; mini.dataset.status = 'running'; } return; }
        const where = result.machine ? ` (machine of ${result.machine})` : '';
        state.textContent = result.status === 'passed' ? `Checks passed in the agent's machine${where}.`
            : result.status === 'failed' ? `Checks FAILED in the agent's machine${where}.`
                : result.status === 'none' ? 'Nothing was checked: no pre-push hook, no check command.' : 'The checks could not run.';
        if (result.status === 'passed' || result.status === 'failed') state.className = result.status;
        /* Said again in the numbers line and on the tab: the checks at a glance. */
        $('gitview-n-checks').textContent = result.status === 'passed' ? '\u2713' : result.status === 'failed' ? '\u2717' : '';
        const mini = $('gitview-numbers').querySelector('.checks-mini');
        if (mini) { mini.textContent = result.status === 'passed' ? '\u2713 Checks passed' : result.status === 'failed' ? '\u2717 Checks failed' : result.status === 'none' ? 'No checks' : 'Checks not run'; mini.dataset.status = result.status; }
        $('gitview-checks-output').textContent = result.output ?? '';
    }
    function showSend(passed, commits) {
        const button = $('gitview-push');
        button.hidden = gitState !== 'ahead' || (gitRequire && !passed);
        const n = commits;
        /* null: the commits could not be counted, which is not "none". */
        button.textContent = n === null ? `Send the commits to ${gitTarget}` : n > 0 ? `Send ${n} commit${n > 1 ? 's' : ''} to ${gitTarget}` : `Make the branch ${gitTarget}`;
        button.dataset.sure = '';
        button.dataset.text = button.textContent;
        $('gitview-check').hidden = gitState !== 'ahead';
    }
    let gitCommits = 0;
    async function runChecks() {
        const name = gitShown; const head = gitHead; const target = gitTarget;
        $('gitview-checks').hidden = false; paintChecks(null); $('gitview-check').disabled = true;
        let result;
        try { result = await post(`${API}/git/${name}/check`, { head, target }); }
        catch (error) { result = { status: 'unavailable', output: error.message }; }
        $('gitview-check').disabled = false;
        if (gitShown !== name || gitHead !== head || gitTarget !== target) return;
        paintChecks(result);
        showSend(result.status === 'passed', gitCommits);
    }
    async function paintKeep() {
        const name = gitShown;
        let keep;
        try { const r = await fetch(`${API}/git/${name}/keep`); keep = await r.json(); if (!r.ok) throw new Error(keep.error); } catch { return; }
        if (gitShown !== name) return;
        const s = keep.settings;
        gitRequire = s.requireForSend; gitFsck = s.fsck ?? {}; gitLast = Array.isArray(keep.last) ? keep.last : [];
        $('gitview-runhook').checked = s.runHook; $('gitview-checkcommand').value = s.checkCommand; $('gitview-checkseconds').value = String(s.checkSeconds);
        $('gitview-require').checked = s.requireForSend; $('gitview-refreshminutes').value = String(s.refreshMinutes);
        $('gitview-alert').checked = s.alert; $('gitview-tellmoves').checked = s.tellMoves !== false;
        /* Which conversations send by themselves: set in each one's Access panel. */
        const senders = Object.entries(keep.auto ?? {});
        $('gitview-auto-where').textContent = `Automatic sending: set for each conversation, in its Access (Write). ${senders.length ? `Now: ${senders.map(([c, list]) => `${c} (${list.join(', ')})`).join('; ')}.` : 'Now: none.'}`;
        $('gitview-origin').hidden = !keep.origin;
        if (keep.origin) {
            $('gitview-origin-where').textContent = `Its origin, kept up to date by this server, is at ${keep.origin.path} in the agent's machine, read-only, next to the repository. The tool brings it in itself, with no key, by running there:`;
            $('gitview-origin-fetch').textContent = `git fetch ${keep.origin.path} '+refs/heads/*:refs/remotes/origin/*'`;
            $('gitview-origin-state').textContent = keep.origin.at ? `${keep.origin.ok ? 'Refreshed' : 'Not refreshed'} ${new Date(keep.origin.at).toLocaleString()}: ${keep.origin.message}` : 'Not fetched yet.';
        }
        /* The last read of the agent's branches, when it failed; branches held after an unknown outcome. */
        const read = keep.read;
        const held = keep.blocked ?? [];
        $('gitview-read').hidden = !(read && read.ok === false) && held.length === 0;
        $('gitview-read').textContent = [read && read.ok === false ? `Last read of the agent's branches (${new Date(read.at).toLocaleString()}) failed: ${read.what}` : '',
            held.length ? `Automatic sending waits for a refresh to settle an earlier sending to: ${held.join(', ')}.` : ''].filter(Boolean).join(' ');
        const log = $('gitview-log'); log.replaceChildren();
        $('gitview-log-empty').hidden = keep.log.length > 0;
        for (const entry of keep.log) {
            const line = document.createElement('div'); line.className = `logline${entry.ok ? '' : ' bad'}`;
            line.textContent = `${new Date(entry.at).toLocaleString()} - ${entry.branch ?? ''} ${entry.head ? entry.head.slice(0, 8) : ''} - ${entry.what}`;
            log.append(line);
        }
    }
    function fillTargets(out) {
        const select = $('gitview-target'); select.replaceChildren();
        const names = [...(out.branches ?? [])];
        if (out.target && !names.includes(out.target)) names.unshift(out.target);
        for (const b of names) { const o = document.createElement('option'); o.value = b; o.textContent = b === out.target && !out.targetExists ? `${b} (new branch)` : b; select.append(o); }
        const other = document.createElement('option'); other.value = NEW_BRANCH; other.textContent = 'A new branch...'; select.append(other);
        select.value = out.target ?? NEW_BRANCH;
        $('gitview-newbranch').hidden = true; $('gitview-newbranch-go').hidden = true;
    }
    const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
    /* What a review shows beyond the changes: the true count, the weight, the
       largest new files, files changed and changed back, merges. */
    function paintGuards(out) {
        const list = $('gitview-guards-list'); list.replaceChildren();
        const g = out.guards;
        $('gitview-guards').hidden = !g || out.count === 0;
        if (!g) return;
        const item = (text) => { const li = document.createElement('li'); li.textContent = text; list.append(li); };
        /* A number the server could not get is said so, never shown as 0. */
        const counted = out.count === null || out.count === undefined ? 'The number of commits could not be counted' : `${out.count} commit${out.count === 1 ? '' : 's'} in all${out.count > out.commits.length ? `: only the last ${out.commits.length} are listed below` : ''}`;
        item(`${counted}; ${g.newBytes === null || g.newBytes === undefined ? 'the size of the new data is unknown' : `${sizeText(g.newBytes)} of new data`}.`);
        /* What the review could not show: each said, and Send asks to confirm. */
        for (const line of g.incomplete ?? []) item(line);
        if (g.largest?.length) item(`Largest new files: ${g.largest.filter((b, i, all) => !b.path || all.findIndex((x) => x.path === b.path) === i).slice(0, 5).map((b) => `${b.path || '(no path)'} (${sizeText(b.size)})`).join(', ')}.`);
        if (g.unchanged?.length) item(`Changed and changed back, so not in the changes below: ${g.unchanged.join(', ')}${g.unchangedAll > g.unchanged.length ? `, and ${g.unchangedAll - g.unchanged.length} more` : ''}.`);
        if (g.merges) item(`${g.merges} merge commit${g.merges === 1 ? '' : 's'}: what they bring from their other parents is in the count, not listed.`);
        if (out.cut) item('The changes are too long to be shown whole here.');
    }
    function fillBranches(out) {
        const select = $('gitview-branch'); select.replaceChildren();
        for (const b of out.agentBranches ?? []) { const o = document.createElement('option'); o.value = b.name; o.textContent = b.name; select.append(o); }
        select.value = out.branch ?? '';
        $('gitview-branch-row').hidden = (out.agentBranches ?? []).length < 2;
        const dropped = out.dropped ?? [];
        $('gitview-dropped').hidden = dropped.length === 0;
        $('gitview-dropped').textContent = dropped.length ? `Not taken, their names cannot be sent: ${dropped.map((d) => d.name).join(', ')}.` : '';
    }
    /* THE REVIEW PAGE (E). `gitCommit`: one commit looked at (from the branch
       diagram), never sent from here; otherwise what would go. The diff is
       drawn by diff2html from its text: each line escaped there, a subject
       or a path set as text here -- nothing the agent wrote becomes markup. */
    let gitCommit = ''; let gitBase = ''; let gitBack = null; let gitLayout = 'side-by-side'; let gitTab = 'changes'; let gitFile = 0; let gitFiles = [];
    const reviewNarrow = () => matchMedia('(max-width: 700px)').matches;
    /* The files of a diff, from its text: path, lines added and removed, and what became of it. */
    function diffFiles(text) {
        const files = [];
        let f = null;
        for (const line of String(text ?? '').split('\n')) {
            if (line.startsWith('diff --git ')) { const m = / b\/(.*)$/.exec(line); f = { path: m ? m[1] : line.slice(11), added: 0, removed: 0, how: 'changed' }; files.push(f); continue; }
            if (!f) continue;
            if (line.startsWith('new file mode')) f.how = 'added';
            else if (line.startsWith('deleted file mode')) f.how = 'deleted';
            else if (line.startsWith('rename to ')) { f.how = 'renamed'; f.path = line.slice(10); }
            else if (line.startsWith('Binary files')) f.how = f.how === 'changed' ? 'binary' : f.how;
            else if (line.startsWith('+') && !line.startsWith('+++ ')) f.added += 1;
            else if (line.startsWith('-') && !line.startsWith('--- ')) f.removed += 1;
        }
        return files;
    }
    function paintReviewTab() {
        for (const b of $('gitview-tabs').querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === gitTab));
        for (const tab of ['changes', 'commits', 'checks']) $(`gitview-pane-${tab}`).hidden = tab !== gitTab;
        $('gitview-layout').hidden = gitTab !== 'changes' || reviewNarrow();
        for (const b of $('gitview-layout').querySelectorAll('[data-layout]')) b.setAttribute('aria-pressed', String(b.dataset.layout === gitLayout));
    }
    /* On a phone, one file at a time: "1 / 3". */
    function showFile(at) {
        const wrappers = [...$('gitview-diff').querySelectorAll('.d2h-file-wrapper')];
        gitFile = Math.max(0, Math.min(at, wrappers.length - 1));
        const one = reviewNarrow();
        wrappers.forEach((w, i) => { w.hidden = one && i !== gitFile; });
        $('gitview-picker').hidden = !one || wrappers.length < 2;
        $('gitview-picker-at').textContent = `${gitFile + 1} / ${wrappers.length}`;
        for (const [i, b] of [...$('gitview-tree').querySelectorAll('button')].entries()) b.setAttribute('aria-current', String(i === gitFile));
    }
    function drawDiff(text) {
        const target = $('gitview-diff');
        target.replaceChildren();
        gitFiles = diffFiles(text);
        const tree = $('gitview-tree'); tree.replaceChildren();
        gitFiles.forEach((f, i) => {
            const b = document.createElement('button'); b.type = 'button'; b.dataset.how = f.how;
            const name = document.createElement('span'); name.className = 'rv-path'; name.textContent = f.path; name.title = f.path;
            const plus = document.createElement('small'); plus.className = 'plus'; plus.textContent = `+${f.added}`;
            const minus = document.createElement('small'); minus.className = 'minus'; minus.textContent = `−${f.removed}`;
            b.append(name, plus, minus);
            b.addEventListener('click', () => { showFile(i); if (!reviewNarrow()) target.querySelectorAll('.d2h-file-wrapper')[i]?.scrollIntoView({ block: 'start' }); });
            tree.append(b);
        });
        tree.hidden = gitFiles.length === 0;
        if (!text) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No change to show.'; target.append(p); showFile(0); return; }
        const Ui = window.Diff2HtmlUI;
        if (!Ui) { const pre = document.createElement('pre'); pre.textContent = text; target.append(pre); return; }
        const ui = new Ui(target, text, {
            outputFormat: reviewNarrow() ? 'line-by-line' : gitLayout, drawFileList: false, matching: 'lines', diffStyle: 'word',
            fileContentToggle: true, stickyFileHeaders: false, synchronisedScroll: true, highlight: true, renderNothingWhenEmpty: false,
            colorScheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        });
        ui.draw();
        try { ui.highlightCode(); } catch { /* the plain diff stays */ }
        showFile(gitFile);
    }
    let gitText = '';
    async function paintGit() {
        const name = gitShown;
        const commit = gitCommit;
        $('gitview-name').textContent = name;
        $('gitview-back').textContent = gitBack?.label ?? 'Assets';
        $('gitview-error').hidden = true; $('gitview-push').hidden = true; $('gitview-check').hidden = true; $('gitview-checks').hidden = true;
        $('gitview-offer-row').hidden = true; $('gitview-guards').hidden = true; $('gitview-dropped').hidden = true; $('gitview-remote-go').hidden = true;
        $('gitview-state').textContent = commit ? 'Looking at this commit...' : 'Looking at what was committed...';
        $('gitview-state').classList.add('busy');
        $('gitview-numbers').replaceChildren();
        $('gitview-commits').replaceChildren(); $('gitview-stat').textContent = ''; $('gitview-diff').replaceChildren(); $('gitview-tree').replaceChildren();
        $('gitview-n-files').textContent = ''; $('gitview-n-commits').textContent = ''; $('gitview-n-checks').textContent = '';
        $('gitview-from').hidden = true; $('gitview-arrow').hidden = Boolean(commit);
        if (commit) $('gitview-target-row').hidden = $('gitview-branch-row').hidden = true;
        gitHead = null; gitTarget = null; gitState = ''; gitConfirm = false;
        paintReviewTab();
        gitLast = [];
        if (!commit) await paintKeep();
        let out;
        try {
            const query = new URLSearchParams();
            if (commit) query.set('id', commit);
            if (commit && gitBase) query.set('base', gitBase);
            if (!commit && gitAsked) query.set('target', gitAsked);
            if (!commit && gitAskedBranch) query.set('branch', gitAskedBranch);
            const r = await fetch(`${API}/git/${name}/${commit ? 'commit' : 'outgoing'}${query.size ? `?${query}` : ''}`);
            out = await r.json();
            if (!r.ok) throw Object.assign(new Error(out.error || 'The repository could not be read.'), { offer: out.offer });
            $('gitview-state').classList.remove('busy');
        } catch (error) {
            $('gitview-state').classList.remove('busy');
            if (gitShown !== name || gitCommit !== commit) return;
            $('gitview-state').textContent = ''; $('gitview-error').textContent = error.message; $('gitview-error').hidden = false;
            /* An fsck refusal the owner may waive (old histories only): offered, never done for them. */
            if (error.offer) { $('gitview-offer').textContent = `Accept "${error.offer}" in this repository`; $('gitview-offer').dataset.id = error.offer; $('gitview-offer-row').hidden = false; }
            return;
        }
        if (gitShown !== name || gitCommit !== commit) return;
        gitHead = commit ? null : out.head; gitTarget = out.target ?? null; gitState = out.state; gitCommits = out.count === undefined ? out.commits.length : out.count; gitBranch = out.branch ?? null; gitConfirm = Boolean(out.guards?.confirm);
        if (commit) {
            const c = out.commits[0];
            $('gitview-from').textContent = gitBase ? `${String(out.base ?? gitBase).slice(0, 7)}..${String(out.id ?? commit).slice(0, 7)}` : String(out.id ?? commit).slice(0, 7); $('gitview-from').hidden = false; $('gitview-from').title = gitBase ? `${out.count ?? out.commits.length} commits` : c?.subject ?? '';
        } else {
            fillBranches(out);
            if ($('gitview-branch-row').hidden && out.branch) { $('gitview-from').textContent = out.branch; $('gitview-from').hidden = false; }
            $('gitview-target-row').hidden = !['ahead', 'up-to-date', 'diverged'].includes(out.state);
            $('gitview-arrow').hidden = $('gitview-target-row').hidden;
            fillTargets(out);
        }
        paintGuards(out);
        $('gitview-state').textContent = commit ? (out.commits[0]?.subject ?? '') + (out.message ? ` - ${out.message}` : '') : out.message;
        $('gitview-remote-go').hidden = !['no-remote', 'unreachable'].includes(out.state);
        /* The numbers line: commits, files, lines, the weight. */
        gitText = out.diff + (out.cut ? '\n' : '');
        const files = diffFiles(out.diff);
        const added = files.reduce((n, f) => n + f.added, 0); const removed = files.reduce((n, f) => n + f.removed, 0);
        const bit = (text, cls) => { const span = document.createElement('span'); span.textContent = text; if (cls) span.className = cls; return span; };
        const count = out.count === null || out.count === undefined ? 'Commits (not counted)' : `${out.count} commit${out.count === 1 ? '' : 's'}`;
        $('gitview-numbers').append(bit(count, 'strong'), bit(` · ${files.length} file${files.length === 1 ? '' : 's'}`), bit(`+${added}`, 'plus'), bit(`−${removed}`, 'minus'),
            ...(commit || out.state !== 'ahead' ? [] : [bit('', 'checks-mini')]),
            ...(out.guards?.newBytes !== null && out.guards?.newBytes !== undefined ? [bit(`${sizeText(out.guards.newBytes)} of new data`, 'hint')] : []));
        $('gitview-n-files').textContent = String(files.length);
        $('gitview-n-commits').textContent = String(out.commits.length);
        for (const c of out.commits) $('gitview-commits').append(commitRow(c));
        $('gitview-stat').textContent = out.stat;
        gitFile = 0;
        drawDiff(out.diff);
        if (out.cut) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '... (the rest is not shown here: too long)'; $('gitview-diff').append(p); }
        /* Before Send is shown, the checks run in the machine: their result
           is shown, and Send waits for them (it is refused without them only
           if the owner asked for that). */
        if (!commit && out.state === 'ahead') await runChecks();
        else if (!commit) {
            /* Nothing to send now: the last checks kept for this branch and target, as they were. */
            const found = lastFor(gitLast.filter((x) => x.target === out.target), out);
            const last = found ? { ...found, outdated: moved(found, out) } : null;
            if (last) { $('gitview-checks').hidden = false; paintChecks(last); $('gitview-checks-state').textContent += ` On ${String(last.head ?? '').slice(0, 7)}, ${sinceWords(last.at)}${last.outdated ? ' (outdated: the branch moved since)' : ''}.`; }
        }
    }
    /* `commit`: one commit of the diagram. `back`: {label, go} -- where the page goes back to. */
    /* The review is shown inside the page it was opened from, never over it:
       in the server's Assets (its header stays), or in a conversation's Assets
       view (the list of conversations and the bar Chat | Terminal | Assets
       stay, and leave it). */
    /* `commit`: one commit; with `base`, the commits from base to it (a line of the chat). A step of its own: Back, Escape and its "<" give back what it was opened from. */
    async function openGit(name, { commit = '', base = '', back = null, target = '', branch = '', tab = 'changes' } = {}) {
        if (!$('files').classList.contains('embedded')) $('files').hidden = true;
        let host = null; let home = '';
        if (place === 'assets') host = $('assets');
        else if (!DEVICE && current) {
            /* From the chat or another tab: the Assets tab opened on it; closing gives back the tab it was in. */
            if (!assetsShown) {
                const from = tabNow();
                back ??= { label: TAB_WORD[from], go: () => showTab(from) };
                if (nav.last(['tab']) < 0) home = from;
                nav.cut(nav.first(['asset', 'review', 'over']));
                roomPick = `git:${name}`;
                closePanelZone(); await openRoomAssets();
            }
            host = $('cassets');
        }
        const g = $('gitview');
        if (host && g.parentNode !== host) host.append(g);
        g.classList.toggle('inset', Boolean(host));
        if (!DEVICE) {
            const r = nav.last(['review']);
            if (r >= 0) nav.cut(r + 1);
            else { const step = nav.push('review', ({ quiet }) => { const to = gitBack; shutGit(); if (!quiet) { if (to?.go) to.go(); else focusTerminal(); } }); step.home = home; }
        }
        gitShown = name; gitCommit = commit; gitBase = commit ? base : ''; gitAsked = target; gitAskedBranch = branch; gitBack = back; gitTab = tab;
        g.hidden = false; g.scrollTop = 0;
        await paintGit();
    }
    /* Hidden (its step closed, or left for another tab, conversation or place). */
    function shutGit() { $('gitview').hidden = true; gitShown = ''; gitBack = null; }
    for (const b of $('gitview-tabs').querySelectorAll('[data-tab]')) b.addEventListener('click', () => { gitTab = b.dataset.tab; paintReviewTab(); });
    for (const b of $('gitview-layout').querySelectorAll('[data-layout]')) b.addEventListener('click', () => { gitLayout = b.dataset.layout; paintReviewTab(); drawDiff(gitText.replace(/\n$/, '')); });
    for (const b of $('gitview-picker').querySelectorAll('[data-step]')) b.addEventListener('click', () => { showFile(gitFile + Number(b.dataset.step)); $('gitview-diff').scrollIntoView({ block: 'start' }); });
    $('gitview-set-remote').addEventListener('click', () => { const name = gitShown; nav.cut(nav.first(['review'])); shutGit(); void openAssetsPlace(`git:${name}`, { remote: true }); });
    $('gitview-close').addEventListener('click', () => { if (nav.close('review')) return; const back = gitBack; shutGit(); if (back?.go) back.go(); else focusTerminal(); });
    $('gitview-again').addEventListener('click', () => { void paintGit(); });
    $('gitview-check').addEventListener('click', () => { void runChecks(); });
    $('gitview-branch').addEventListener('change', () => { gitAskedBranch = $('gitview-branch').value; gitAsked = ''; void paintGit(); });
    $('gitview-offer').addEventListener('click', async () => {
        const id = $('gitview-offer').dataset.id;
        try { await post(`${API}/git/${gitShown}/keep`, { fsck: { ...gitFsck, [id]: 'warn' } }); await paintGit(); }
        catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
    });
    $('gitview-target').addEventListener('change', () => {
        const value = $('gitview-target').value;
        if (value === NEW_BRANCH) { $('gitview-push').hidden = true; $('gitview-newbranch').hidden = false; $('gitview-newbranch-go').hidden = false; focusField($('gitview-newbranch')); return; }
        gitAsked = value; void paintGit();
    });
    const lookAtNew = () => { const wanted = $('gitview-newbranch').value.trim(); if (!wanted) return; gitAsked = wanted; void paintGit(); };
    $('gitview-newbranch-go').addEventListener('click', lookAtNew);
    $('gitview-newbranch').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); lookAtNew(); } });
    $('gitview-push').addEventListener('click', async () => {
        const button = $('gitview-push');
        /* Two clicks: what leaves cannot be called back. Three when the page
           could not show it all (over 100 commits, or changes cut short). */
        if (!button.dataset.sure) { button.dataset.sure = 'yes'; button.textContent = `Yes, send to ${gitTarget}: this cannot be undone`; return; }
        if (gitConfirm && button.dataset.sure === 'yes') { button.dataset.sure = 'all'; button.textContent = `Not all of it could be shown here: send it all to ${gitTarget} anyway`; return; }
        button.disabled = true; $('gitview-error').hidden = true;
        try {
            const sent = await post(`${API}/git/${gitShown}/push`, { head: gitHead, target: gitTarget, ...(gitConfirm ? { sure: true } : {}) });
            await paintGit();
            const said = sent.already ? `Already on the remote: ${sent.branch} has this commit.` : sent.commits > 0 ? `Sent: ${sent.commits} commit${sent.commits > 1 ? 's' : ''} to ${sent.branch}${sent.made ? ' (a new branch)' : ''}.` : `Made the branch ${sent.branch} on the remote.`;
            $('gitview-state').textContent = `${said}${sent.note ? ` ${sent.note}` : ''} ${$('gitview-state').textContent}`;
        }
        catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
        button.disabled = false;
    });
    $('gitview-refresh').addEventListener('click', async () => {
        const button = $('gitview-refresh'); button.disabled = true; $('gitview-origin-state').textContent = 'Fetching the origin...';
        try { await post(`${API}/git/${gitShown}/refresh`, {}); } catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
        button.disabled = false; await paintKeep();
    });
    $('gitview-keep').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('gitview-error').hidden = true; $('gitview-keep-said').textContent = '';
        try {
            await post(`${API}/git/${gitShown}/keep`, {
                runHook: $('gitview-runhook').checked, checkCommand: $('gitview-checkcommand').value, checkSeconds: Number($('gitview-checkseconds').value),
                requireForSend: $('gitview-require').checked, refreshMinutes: Number($('gitview-refreshminutes').value), alert: $('gitview-alert').checked, tellMoves: $('gitview-tellmoves').checked,
            });
            $('gitview-keep-said').textContent = 'Saved.';
            await paintKeep();
            if (gitState === 'ahead') showSend($('gitview-checks-state').classList.contains('passed'), gitCommits);
        } catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
    });
    $('gitview-remote').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true;
        const name = remoteShown;
        try { await post(`${API}/git/${name}/remote`, { url: $('gitview-url').value.trim(), user: $('gitview-user').value.trim(), key: $('gitview-key').value, ...(looksSsh($('gitview-url').value.trim()) && $('gitview-sshkey').value ? { sshKey: $('gitview-sshkey').value } : {}) }); $('gitview-key').value = ''; remoteEditing = false; await paintAssets(); }
        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
    });

    /* NEW MAILBOX (02-11): an IMAP mailbox is connected LIVE by default, as a Microsoft or Google one -- the
       same levels, through Tether -- with its sending server (SMTP) too, unless "No sending". The former
       read-only copy as files stays, ticked on purpose. */
    let mailboxLooked = '';
    /* An account connected: its targets (mail, calendar, contacts), the first opened, all given from Attach. */
    const targetsMade = (made, user) => {
        const targets = Array.isArray(made?.targets) ? made.targets : [];
        return { key: targets[0] ? `connexion:${targets[0].id}` : '', name: targets[0]?.title ?? user, give: (to, level) => Promise.all(targets.map((t) => grantTarget(t.id, to, targetLevel(level)))) };
    };
    $('mailbox-user').addEventListener('change', async () => {
        const user = $('mailbox-user').value.trim();
        if (!user.includes('@') || user === mailboxLooked) return;
        mailboxLooked = user;
        try {
            const found = await post(`${API}/accounts/lookup`, { user });
            if (found?.imap && !$('mailbox-host').value.trim()) { const [h, p] = String(found.imap).split(':'); $('mailbox-host').value = h; if (p) $('mailbox-port').value = p; }
            if (found?.smtp && !$('mailbox-smtp').value.trim()) $('mailbox-smtp').value = found.smtp;
        } catch { /* typed by hand */ }
    });
    $('mailbox-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('mailbox-error').hidden = true;
        const button = $('mailbox-new').querySelector('button[type=submit]');
        button.disabled = true; button.textContent = 'Trying it...';
        const host = $('mailbox-host').value.trim(); const port = $('mailbox-port').value.trim();
        try {
            const user = $('mailbox-user').value.trim();
            const made = await post(`${API}/accounts/classic`, { user, password: $('mailbox-password').value, imap: port ? `${host}:${port}` : host, smtp: $('mailbox-smtp').value.trim(), kinds: ['mail'] });
            $('mailbox-new').reset(); mailboxLooked = '';
            await assetMade($('mailbox-box'), targetsMade(made, user));
        } catch (error) { $('mailbox-error').textContent = error.message; $('mailbox-error').hidden = false; }
        button.disabled = false; button.textContent = 'Create';
        await paintAssets();
    });
    /* New mailbox: IMAP and SMTP, connected live (02-11). Gmail and Microsoft sign in instead (token kept on
       the server): "Sign in with them" jumps to that form. */
    const MAILBOX_PROVIDER = { google: 'Google', microsoft: 'Microsoft', classic: 'your host' };
    /* Which kinds each provider can be connected for (from the server). */
    let accountSupported = { google: ['mail', 'calendar', 'contacts'], microsoft: ['mail'], classic: ['mail', 'calendar', 'contacts'] };
    /* From New mailbox: the account form, on the host's kind ("Other") with what was typed here, unless it is Gmail or Microsoft. */
    /* The kind of mailbox, in plain sight (02-11): Google or Microsoft sign in (the account form, on that
       provider); any other is the IMAP + SMTP form right here. */
    for (const b of $('mailbox-provider').querySelectorAll('button')) b.addEventListener('click', async () => {
        const provider = b.dataset.provider;
        if (provider === 'classic') return;
        const user = $('mailbox-user').value.trim();
        await newAssetKind($('mailbox-box'), 'connexion');
        setConnexionProvider(provider);
        if (user.includes('@')) $('connexion-email').value = user;
    });
    /* CONNECT AN ACCOUNT (Connexions): a live link through Tether. The person signs
       in in their own browser; the token is kept on the server, never in a machine.
       Both cover mail+calendar+contacts in one go, each landing on the same
       copy-pastable http://127.0.0.1 address. */
    const setConnexionProvider = (provider) => {
        const form = $('connexion-new');
        form.dataset.provider = provider;
        for (const b of $('connexion-provider').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.provider === provider));
        const classic = provider === 'classic';
        $('connexion-classic').hidden = !classic;
        $('connexion-open-row').hidden = classic;
        $('connexion-notice').hidden = classic;
        if (classic) showClassicFields();
        const kinds = classic ? ['mail', 'calendar', 'contacts'] : accountSupported[provider] ?? ['mail'];
        for (const [id, k] of [['connexion-calendar', 'calendar'], ['connexion-contacts', 'contacts']]) { const c = $(id); const ok = kinds.includes(k); if (!ok) c.checked = false; c.disabled = !ok; $(`${id}-label`).classList.toggle('off', !ok); }
        $('connexion-paste').hidden = true;
        $('connexion-error').hidden = true;
        const who = MAILBOX_PROVIDER[provider];
        const all = kinds.includes('calendar') && kinds.includes('contacts');
        /* Say plainly whose app Clavarium borrows (it is what the provider sees),
           and -- before anyone clicks -- that allowing lands on a page that will
           not load, which is expected: the address is what to copy back here. */
        $('connexion-notice').textContent = `Clavarium signs in as Thunderbird's app — that is what ${who} sees.${all ? ' Mail, calendar and contacts together.' : ''} After you allow, your browser lands on an error page — that is normal, nothing is running at that address. Copy the whole address from the bar and paste it below.`;
        $('connexion-open').textContent = `Open the ${who} sign-in page`;
    };
    for (const b of $('connexion-provider').querySelectorAll('button')) b.addEventListener('click', () => setConnexionProvider(b.dataset.provider));
    /* A CLASSIC ACCOUNT (OVH, Infomaniak, Nextcloud...): a password and its servers,
       filled from the address when known. Only the servers of the kinds ticked show. */
    function showClassicFields() {
        const on = (k) => $(`connexion-${k}`).checked;
        for (const [f, k] of [['imap', 'mail'], ['smtp', 'mail'], ['caldav', 'calendar'], ['carddav', 'contacts']]) { $(`connexion-${f}`).hidden = !on(k); $(`connexion-${f}-label`).hidden = !on(k); }
    }
    for (const id of ['connexion-mail', 'connexion-calendar', 'connexion-contacts']) $(id).addEventListener('change', () => { if ($('connexion-new').dataset.provider === 'classic') showClassicFields(); });
    let lookedUp = '';
    $('connexion-email').addEventListener('change', async () => {
        const user = $('connexion-email').value.trim();
        if ($('connexion-new').dataset.provider !== 'classic' || !user.includes('@') || user === lookedUp) return;
        lookedUp = user;
        try {
            const found = await post(`${API}/accounts/lookup`, { user });
            for (const f of ['imap', 'smtp', 'caldav', 'carddav']) if (found?.[f] && !$(`connexion-${f}`).value.trim()) $(`connexion-${f}`).value = found[f];
        } catch { /* filled by hand */ }
    });
    $('connexion-classic-connect').addEventListener('click', async () => {
        $('connexion-error').hidden = true;
        const kinds = connexionKinds();
        if (!kinds.length) { $('connexion-error').textContent = 'Choose at least mail, calendar or contacts.'; $('connexion-error').hidden = false; return; }
        const btn = $('connexion-classic-connect'); const was = btn.textContent; btn.disabled = true; btn.textContent = 'Trying the account…';
        try {
            const made = await post(`${API}/accounts/classic`, { user: $('connexion-email').value.trim(), password: $('connexion-password').value, kinds,
                imap: $('connexion-imap').value.trim(), smtp: $('connexion-smtp').value.trim(), caldav: $('connexion-caldav').value.trim(), carddav: $('connexion-carddav').value.trim() });
            const user = $('connexion-email').value.trim();
            lookedUp = '';
            $('connexion-new').reset(); setConnexionProvider('google');
            await assetMade($('connexion-box'), targetsMade(made, user));
        } catch (error) { $('connexion-error').textContent = error.message; $('connexion-error').hidden = false; }
        $('connexion-password').value = '';
        btn.disabled = false; btn.textContent = was;
        await paintAssets();
    });
    const connexionKinds = () => [['connexion-mail', 'mail'], ['connexion-calendar', 'calendar'], ['connexion-contacts', 'contacts']].filter(([id]) => $(id).checked && !$(id).disabled).map(([, k]) => k);
    $('connexion-open').addEventListener('click', async () => {
        $('connexion-error').hidden = true;
        const kinds = connexionKinds();
        if (!kinds.length) { $('connexion-error').textContent = 'Choose at least mail, calendar or contacts.'; $('connexion-error').hidden = false; return; }
        const btn = $('connexion-open'); btn.disabled = true;
        try {
            const { url } = await post(`${API}/accounts/consent`, { provider: $('connexion-new').dataset.provider, user: $('connexion-email').value.trim(), kinds });
            window.open(url, '_blank', 'noopener');
            $('connexion-paste').hidden = false;
            $('connexion-code').focus();
        } catch (error) { $('connexion-error').textContent = error.message; $('connexion-error').hidden = false; }
        btn.disabled = false;
    });
    $('connexion-connect').addEventListener('click', async () => {
        $('connexion-error').hidden = true;
        const btn = $('connexion-connect'); const was = btn.textContent; btn.disabled = true; btn.textContent = 'Connecting...';
        try {
            const made = await post(`${API}/accounts/connect`, { redirected: $('connexion-code').value.trim() });
            const denied = Array.isArray(made?.denied) ? made.denied : [];
            if (denied.length) {
                /* A partial grant: say plainly what was allowed and what was not,
                   from the token itself, and keep the form so they can allow the rest. */
                const word = (k) => ({ mail: 'mail', calendar: 'calendar', contacts: 'contacts' }[k] || k);
                const ok = (made.authorized || []).map(word);
                const no = denied.map(word);
                $('connexion-error').textContent = `${ok.length ? `Connected for ${ok.join(', ')}. ` : ''}Not allowed: ${no.join(', ')} — connect again and allow ${no.length > 1 ? 'them' : 'it'} on the provider's screen.`;
                $('connexion-error').hidden = false;
                $('connexion-code').value = ''; $('connexion-paste').hidden = true;
            } else {
                const user = $('connexion-email').value.trim();
                $('connexion-new').reset(); setConnexionProvider('google');
                await assetMade($('connexion-box'), targetsMade(made, user));
            }
        } catch (error) { $('connexion-error').textContent = error.message; $('connexion-error').hidden = false; }
        btn.disabled = false; btn.textContent = was;
        await paintAssets();
    });
    setConnexionProvider('google');
    getJson('/accounts', null).then((d) => { if (d?.supported) { accountSupported = { ...d.supported, classic: ['mail', 'calendar', 'contacts'] }; setConnexionProvider($('connexion-new').dataset.provider || 'google'); } });
    $('list-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true; $('attach-error').hidden = true;
        const made = await binderCall('create-list', { template: $('listnew-template').value, title: $('listnew-title').value.trim(), lang: binderLang() });
        if (made.ok) {
            $('listnew-title').value = '';
            const key = `list:${made.data.id}`;
            const attaching = inAttach($('list-box'));
            await assetMade($('list-box'), { key, name: made.data.title ?? $('listnew-template').selectedOptions[0]?.textContent ?? '', give: (to, level) => grantList(made.data.id, to, level) });
            if (!attaching) { listOpen = key; remember(); }
        } else newAssetError($('list-box'), made.text);
        await paintAssets();
    });
    $('folder-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true;
        $('attach-error').hidden = true;
        try {
            const made = await post(`${API}/resources`, { name: $('folder-name').value.trim() }); $('folder-name').value = '';
            const name = made?.name ?? '';
            await assetMade($('folder-box'), { key: name ? `folder:${name}` : '', name, give: name ? (to, level) => attachTo(to, name, level, 'attach-error') : null });
        } catch (error) { newAssetError($('folder-box'), error.message); }
        await paintAssets();
    });

    /* ---------- copying text ---------- */
    /* A terminal in a page draws its own text: a long press on a tablet
       selects nothing, and a tool that takes the mouse takes even a drag. So
       the text is offered again as ordinary text, which every device knows
       how to select and copy. Everything the terminal still holds, top to
       bottom, with the empty lines at the end removed. */
    function screenText() {
        const buffer = terminal.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop();
        return lines.join('\n');
    }
    /* COPY / PASTE: over the screen, a step of its own. */
    const showCopy = () => { nav.over('copy', () => { $('copy').hidden = true; focusTerminal(); }); $('copy').hidden = false; };
    $('copy-open').addEventListener('click', () => {
        $('files').hidden = true;
        $('copy-text').value = screenText();
        $('copy-status').textContent = ''; $('paste-status').textContent = '';
        showCopy();
        /* Shown from its end: the last lines are what one comes for. */
        $('copy-text').scrollTop = $('copy-text').scrollHeight;
    });
    $('copy-close').addEventListener('click', () => { if (!nav.dropOver('copy')) { $('copy').hidden = true; focusTerminal(); } });
    $('copy-all').addEventListener('click', async () => {
        const field = $('copy-text');
        try { await navigator.clipboard.writeText(field.value); $('copy-status').textContent = 'Copied.'; }
        catch {
            /* No clipboard permission: select it all, the person copies. */
            focusField(field); field.select();
            $('copy-status').textContent = 'Selected: now use Copy.';
        }
    });

    /* Pasting. What is pasted goes through the terminal's own paste, which
       tells the tool "this is a paste" when the tool asked to know: a pasted
       line break is then not an Enter. */
    const pasteIntoTerminal = (text) => {
        /* The button that was pressed gives the focus back first: left on it,
           the next Enter pressed it again and pasted twice (caught by a test). */
        document.activeElement?.blur?.();
        if (!nav.dropOver('copy')) $('copy').hidden = true;
        focusTerminal();
        if (text) terminal.paste(text);
    };
    let reading = false;
    $('paste-now').addEventListener('click', async () => {
        /* Reading what was copied takes a moment (the browser may ask). An
           Enter pressed meanwhile must not press this button again: it lets
           go of the focus at once, and a second press is ignored (a test
           caught two pastes and no Enter). */
        if (reading) return;
        reading = true;
        $('paste-now').blur();
        try {
            const text = await navigator.clipboard.readText();
            if (text === '') { $('paste-status').textContent = 'There is nothing to paste.'; return; }
            pasteIntoTerminal(text);
        } catch { $('paste-status').textContent = 'This browser did not let the page read what you copied. Use the field below.'; focusField($('paste-text')); }
        finally { reading = false; }
    });
    $('paste-send').addEventListener('click', () => { const text = $('paste-text').value; $('paste-text').value = ''; pasteIntoTerminal(text); });

    /* ---------- a finger is a wheel ---------- */
    /* On a touch screen there is no wheel, and a terminal in a page does not
       scroll under a finger by itself. A vertical drag is turned into the
       wheel events the terminal already understands: it scrolls its own
       history, or passes the wheel to a tool that asked for the mouse, as
       with a real wheel. A touch that does not move stays a tap. */
    const STEP_PX = 18;                      /* one wheel notch per this much finger travel */
    let touchY = null; let carried = 0;
    const area = $('terminal');

    /* ---------- selecting text: what is selected is copied ---------- */
    /* As in a terminal on a desktop: text selected is text copied, with a word
       to say so.
         - with a finger: a LONG PRESS starts the selection where it is, the
           finger then stretches it, lifting it copies (a short drag still
           scrolls, a tap is still a tap);
         - with a mouse: hold Shift and drag (the tool otherwise takes the
           mouse for itself); releasing copies.
       The terminal draws its text itself: this is its own selection, made
       from where the finger is. */
    const PRESS_MS = 450; const SLOP_PX = 9;
    let pressTimer = null; let pressAt = null; let selecting = false; let anchor = null;
    let flashTimer = null;
    /* A word said for a moment; with `action`, a small menu: what was selected
       is offered for what it is, and stays a little longer. */
    const flash = (text, action) => {
        $('flash-text').textContent = text;
        $('flash-act').hidden = !action;
        if (action) { $('flash-act').textContent = action.label; $('flash-act').onclick = () => { $('flash').hidden = true; action.run(); }; }
        $('flash').dataset.menu = String(Boolean(action));
        $('flash').hidden = false;
        clearTimeout(flashTimer); flashTimer = setTimeout(() => { $('flash').hidden = true; }, action ? 7000 : 1800);
    };
    /* WHAT A SELECTION IS, when it is one thing: a web address, or a file.
       Nothing is ever opened by itself; the button says where it leads.
         - a web address: http or https only, no name-and-password in it; the
           button shows the SITE it goes to, and it opens in another tab that
           is told nothing about this one;
         - a file: a path under /work or an attached folder -- or a plain
           relative path, taken from where the tool works. It opens in the
           window of this page, as a tapped path does. */
    function whatIs(selected) {
        /* A tool wraps a long address or path over several lines: rejoined. */
        const one = selected.trim().replace(/\s*\n\s*/g, '').replace(/[.,;:)\]'"]+$/, '').replace(/^['"(\[]+/, '');
        if (one === '' || one.length > 2000 || /\s/.test(one)) return undefined;
        if (/^https?:\/\//i.test(one)) {
            let url;
            try { url = new URL(one); } catch { return undefined; }
            if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.hostname === '') return undefined;
            return { label: `Open ${url.hostname}`, run: () => { window.open(url.href, '_blank', 'noopener,noreferrer'); } };
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(one)) return undefined;      /* any other scheme: never */
        if (PATH_ONLY.test(one)) return { label: 'Show the file', run: () => { void openPath(one); } };
        /* A relative path with a name that looks like a file, or a folder and a name. */
        if (/^(?:\.\/)?[A-Za-z0-9._@+%~-]+(?:\/[A-Za-z0-9._@+%~-]+)*$/.test(one) && (one.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(one)) && !one.split('/').includes('..')) {
            return { label: 'Show the file', run: () => { void openPath(`/work/${one.replace(/^\.\//, '')}`); } };
        }
        return undefined;
    }
    const cellAt = (x, y) => {
        const box = (area.querySelector('.xterm-screen') ?? area).getBoundingClientRect();
        const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor(((x - box.left) * terminal.cols) / box.width)));
        const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor(((y - box.top) * terminal.rows) / box.height)));
        return { col, row: row + terminal.buffer.active.viewportY };
    };
    const stretch = (to) => {
        const [a, b] = (to.row < anchor.row || (to.row === anchor.row && to.col < anchor.col)) ? [to, anchor] : [anchor, to];
        terminal.select(a.col, a.row, (b.row - a.row) * terminal.cols + (b.col - a.col) + 1);
    };
    async function copySelection() {
        const text = terminal.getSelection();
        if (!text.trim()) return;
        const action = whatIs(text);
        try { await navigator.clipboard.writeText(text); flash(`Copied: ${text.length} character${text.length > 1 ? 's' : ''}`, action); }
        catch {
            /* The browser did not let the page write: the same text, as ordinary text, to copy by hand. */
            $('copy-text').value = text; showCopy(); focusField($('copy-text')); $('copy-text').select();
        }
    }
    area.addEventListener('touchstart', (event) => {
        clearTimeout(pressTimer);
        if (event.touches.length !== 1) return;
        if (terminal.hasSelection()) terminal.clearSelection();
        const touch = event.touches[0];
        pressAt = { x: touch.clientX, y: touch.clientY };
        pressTimer = setTimeout(() => {
            selecting = true; anchor = cellAt(pressAt.x, pressAt.y);
            /* The word under the finger, to begin with: a visible start. */
            const line = terminal.buffer.active.getLine(anchor.row)?.translateToString(true) ?? '';
            let from = anchor.col; let to = anchor.col;
            while (from > 0 && /\S/.test(line[from - 1] ?? '')) from--;
            while (to < line.length - 1 && /\S/.test(line[to + 1] ?? '')) to++;
            if (/\S/.test(line[anchor.col] ?? '')) { anchor = { col: from, row: anchor.row }; stretch({ col: to, row: anchor.row }); }
            else stretch(anchor);
            navigator.vibrate?.(12);
        }, PRESS_MS);
    }, { passive: true });
    area.addEventListener('touchmove', (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (selecting) { stretch(cellAt(touch.clientX, touch.clientY)); event.preventDefault(); event.stopImmediatePropagation(); return; }
        if (pressAt && Math.hypot(touch.clientX - pressAt.x, touch.clientY - pressAt.y) > SLOP_PX) clearTimeout(pressTimer);
    }, { passive: false });
    const endPress = (event) => {
        clearTimeout(pressTimer); pressAt = null;
        if (!selecting) return;
        selecting = false;
        event.preventDefault();            /* not a tap: no click, no link, no keyboard */
        void copySelection();
    };
    area.addEventListener('touchend', endPress, { passive: false });
    area.addEventListener('touchcancel', () => { clearTimeout(pressTimer); selecting = false; pressAt = null; });
    area.addEventListener('contextmenu', (event) => { if (touchScreen) event.preventDefault(); });
    /* With a mouse: the selection made with Shift held is copied once it is made. */
    /* The terminal keeps its mouse events to itself, so the end of a
       selection is not seen as a click: it is seen as a selection that has
       stopped changing for a moment. */
    let settle = []; let lastCopied = '';
    terminal.onSelectionChange(() => {
        for (const timer of settle) clearTimeout(timer);
        settle = [];
        if (touchScreen) return;
        /* Looked at once things are still -- and once more a little later:
           the terminal reports a selection as empty for a moment after it is
           made (seen in a test: the text was selected, and nothing copied). */
        const look = () => {
            const now = terminal.getSelection();
            if (!now.trim()) { lastCopied = ''; return; }
            if (now === lastCopied) return;
            lastCopied = now;
            void copySelection();
        };
        settle = [setTimeout(look, 350), setTimeout(look, 1100)];
    });

    area.addEventListener('touchstart', (event) => { if (event.touches.length === 1) { touchY = event.touches[0].clientY; carried = 0; } }, { passive: true });
    area.addEventListener('touchmove', (event) => {
        if (selecting || touchY === null || event.touches.length !== 1) return;
        const touch = event.touches[0];
        carried += touchY - touch.clientY;           /* finger up: the text moves up, as on any touch screen */
        touchY = touch.clientY;
        const target = area.querySelector('.xterm-screen') ?? area;
        while (Math.abs(carried) >= STEP_PX) {
            const down = carried > 0;
            carried -= down ? STEP_PX : -STEP_PX;
            target.dispatchEvent(new WheelEvent('wheel', { deltaY: down ? 60 : -60, deltaMode: 0, clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true }));
        }
        event.preventDefault();
    }, { passive: false });
    area.addEventListener('touchend', () => { touchY = null; });

    /* ---------- files ---------- */
    /* The folders kept by the server and attached here: listed, shown as a
       list or as icons, downloaded, uploaded into, and -- only where this
       conversation may write -- changed by hand: made, renamed, moved,
       removed, edited. A file name is shown as text and never interpreted.
       Every change is checked again by the server (files.mjs): this page
       only offers what is allowed, it is not what allows it. */
    let filesOf = '';            /* the attached folder being shown */
    let filesAt = '';            /* the path inside it */
    let filesTabs = [];          /* the folders offered, with their access */
    let filesWritable = false;   /* may the folder shown be changed from here? */
    let filesEntries = [];       /* what it holds, as last listed */
    let editing = null;          /* the text file being edited: { tab, inner, name, version, saved, area } */
    let filesChanged = false;    /* edited: the list behind shows the new size and time */
    const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : n === 1 ? '1 byte' : `${n} bytes`);
    const filesQuery = (extra = {}) => new URLSearchParams({ c: current, r: filesOf, p: filesAt, ...extra }).toString();
    /* When it was last changed, short: the time today, the day otherwise. */
    const whenOf = (iso) => {
        const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
    };
    const innerOf = (name) => (filesAt ? `${filesAt}/${name}` : name);
    const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
    /* The limits the server holds (files.mjs), said here before a long upload is begun. */
    const IMPORT_MAX = 50 * 1024 * 1024;
    const DROP_FILES = 2000;
    const DROP_BYTES = 2 * 1024 * 1024 * 1024;
    const DROP_DEPTH = 16;
    const THUMB_MAX = 8 * 1024 * 1024;
    const EDIT_MAX = 1024 * 1024;
    const THUMBS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    const MOVE_TYPE = 'application/x-clavarium-path';

    /* LIST or ICONS, kept on this device. */
    let filesView = 'list';
    try { if (localStorage.getItem('clavarium-files-view') === 'icons') filesView = 'icons'; } catch { /* a private window */ }
    for (const b of $('files-views').querySelectorAll('button')) {
        b.addEventListener('click', () => {
            filesView = b.dataset.view === 'icons' ? 'icons' : 'list';
            try { localStorage.setItem('clavarium-files-view', filesView); } catch { /* as above */ }
            void paintFiles();
        });
    }

    /* What a file is, for its icon. */
    const TYPES = {
        image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'tif', 'tiff', 'avif'],
        pdf: ['pdf'],
        text: ['txt', 'md', 'csv', 'tsv', 'log', 'eml', 'tex', 'rtf', 'srt', 'vtt'],
        code: ['json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'sql', 'c', 'h', 'cpp', 'go', 'rs', 'java', 'rb', 'php', 'kt', 'swift', 'lua', 'pl', 'r', 'vue', 'conf', 'cfg', 'env'],
        sheet: ['xls', 'xlsx', 'ods', 'numbers'],
        doc: ['doc', 'docx', 'odt', 'pages', 'ppt', 'pptx', 'odp', 'key', 'epub'],
        archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'],
        audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus'],
        video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'],
    };
    const typeOf = (entry) => (entry.folder ? 'folder' : Object.keys(TYPES).find((t) => TYPES[t].includes(extOf(entry.name))) ?? 'other');
    /* Text that may be edited here: what the viewer shows as text, and a file without an extension. */
    const editable = (name, size) => size <= EDIT_MAX && (TEXTS.includes(extOf(name)) || ['svg', 'conf', 'cfg', 'env', 'cjs', 'tsx', 'jsx', 'vue', 'kt', 'swift', 'lua', 'pl', 'r', 'srt', 'vtt', 'cpp', 'htm', ''].includes(extOf(name)));
    const SVG = 'http://www.w3.org/2000/svg';
    /* The icon of each kind, from the set of the chat (Lucide, see icons.js). */
    const KIND_ICONS = { folder: 'folder', image: 'file-image', pdf: 'file-text', text: 'file-text', doc: 'file-text', code: 'file-code', sheet: 'file-spreadsheet', archive: 'file-archive', audio: 'file-music', video: 'file-play', other: 'file' };
    /* A drawn icon: a folder, or a page of its kind, its kind written under it. Never the file's own content. */
    function iconFor(entry) {
        const box = document.createElement('span'); box.className = 'icon'; box.dataset.type = typeOf(entry);
        const drawn = window.clavariumIcons?.icon(KIND_ICONS[box.dataset.type] ?? 'file');
        if (drawn) {
            box.dataset.drawn = 'lucide'; box.append(drawn);
            if (!entry.folder) { const ext = document.createElement('span'); ext.className = 'ext'; ext.textContent = (extOf(entry.name) || 'file').slice(0, 4).toUpperCase(); box.append(ext); }
            return box;
        }
        const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('aria-hidden', 'true');
        const path = (d, cls) => { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); svg.append(p); };
        if (entry.folder) {
            svg.setAttribute('viewBox', '0 0 48 40');
            path('M2 8a4 4 0 0 1 4-4h11.5a3 3 0 0 1 2.3 1.1L23 9h19a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z', 'body');
            path('M2 14h44', 'line');
        } else {
            svg.setAttribute('viewBox', '0 0 40 48');
            path('M7 2h19l11 11v31a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'body');
            path('M26 2v9a2 2 0 0 0 2 2h9', 'line');
        }
        box.append(svg);
        if (!entry.folder) { const ext = document.createElement('span'); ext.className = 'ext'; ext.textContent = (extOf(entry.name) || 'file').slice(0, 4).toUpperCase(); box.append(ext); }
        return box;
    }

    /* `keep`: an error just said stays (painted after a change that failed in part). */
    async function paintFiles({ keep = false } = {}) {
        const ownerOthers = DEVICE ? [] : (await (await fetch(`${API}/resources`)).json().catch(() => [])).map((r) => ({ name: r.name, access: r.type === 'mailbox' ? 'read' : 'write', yours: true }));
        /* First, where the tool works -- when that is kept here; then what is attached. */
        const here = conversations.find((x) => x.name === current);
        const attachedHere = here?.resources ?? [];
        const mine = noTerminal() ? deviceShared.map((s) => ({ name: s.name, access: s.access, given: true })) : [...(here?.work === 'kept' ? [{ name: 'work', access: 'write', own: true }] : []), ...attachedHere.map((r) => ({ ...r })),
            /* On a device: what it was given for itself, whatever the conversation. */
            ...deviceShared.filter((s) => !attachedHere.some((r) => r.name === s.name)).map((s) => ({ name: s.name, access: s.access, given: true })),
            /* For the owner: everything else that is kept here, attached to this conversation or not. */
            ...ownerOthers.filter((o) => !attachedHere.some((r) => r.name === o.name))];
        /* Given to the device to write, attached to the conversation to read: the larger of the two holds. */
        for (const r of mine) if (deviceShared.some((s) => s.name === r.name && s.access === 'write')) r.access = 'write';
        filesTabs = mine;
        if (!mine.some((r) => r.name === filesOf)) { filesOf = mine[0]?.name ?? ''; filesAt = ''; }
        const tabs = $('files-tabs');
        tabs.replaceChildren();
        for (const r of mine) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = r.own ? 'work - where the tool works' : `${r.name} - ${r.access === 'write' ? 'read-write' : 'read-only'}${r.given ? ' (given to this device)' : r.yours ? ' (not attached here)' : ''}`; b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', r.name === filesOf ? 'true' : 'false');
            b.addEventListener('click', () => { filesOf = r.name; filesAt = ''; void paintFiles(); });
            tabs.append(b);
        }
        const rows = $('files-rows'); const path = $('files-path');
        $('files-none').hidden = mine.length > 0;
        if (!keep) $('files-error').hidden = true;
        filesWritable = mine.find((r) => r.name === filesOf)?.access === 'write';
        $('files-actions').hidden = !filesOf || !filesWritable;
        $('files-readonly').hidden = !filesOf || filesWritable;
        $('files-readonly').textContent = mine.find((r) => r.name === filesOf)?.given ? 'Read-only: given to this device to read. Nothing can be added or changed here.' : 'Read-only: attached to this conversation to read. Nothing can be added or changed here.';
        $('files-views').hidden = !filesOf;
        for (const b of $('files-views').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === filesView));
        if (!filesOf) { rows.replaceChildren(); path.replaceChildren(); $('files-empty').hidden = true; return; }
        let listing;
        try {
            const r = await fetch(`${API}/files?${filesQuery()}`);
            listing = await r.json();
            if (!r.ok) throw new Error(listing.error || 'The folder could not be read.');
        } catch (error) { rows.replaceChildren(); path.replaceChildren(); $('files-error').textContent = error.message; $('files-error').hidden = false; return; }
        /* Painted only once the listing is here: the old one stays until then, no blink. */
        rows.replaceChildren(); path.replaceChildren();
        hideNameForm();
        filesAt = listing.path;
        filesEntries = listing.entries;
        rows.dataset.view = filesView;
        /* The trail: the folder, then each level, each one a way back -- and a place to drop what is moved. */
        const parts = filesAt ? filesAt.split('/') : [];
        const crumb = (text, to) => {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
            b.addEventListener('click', () => { filesAt = to; void paintFiles(); });
            if (to !== filesAt) moveTarget(b, to);
            path.append(b);
        };
        crumb(filesOf, '');
        parts.forEach((part, i) => { path.append('/'); crumb(part, parts.slice(0, i + 1).join('/')); });
        /* At the top of the folder the trail would only repeat its tab. */
        path.hidden = parts.length === 0;
        for (const entry of listing.entries) rows.append(entryOf(entry));
        $('files-empty').hidden = listing.entries.length > 0;
        $('files-empty').textContent = filesWritable ? (FINE_POINTER ? 'This folder is empty. Drop files or folders here, or use Upload.' : 'This folder is empty. Add files with Upload.') : 'This folder is empty.';
    }
    /* A mouse: dragging and dropping is offered; a finger: the buttons are. */
    const FINE_POINTER = window.matchMedia?.('(pointer: fine)').matches ?? true;
    $('files-drop-hint').hidden = !FINE_POINTER;
    /* An entry's actions close when something else is touched, or with Escape. */
    /* (The path of the click, as it was dispatched: a button the click itself replaced is no longer in the page.) */
    document.addEventListener('click', (event) => { if (!event.composedPath().some((el) => el.classList?.contains('entry') && el.classList.contains('open'))) closeActions(); });
    $('files').addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !$('files-rows').querySelector('.entry.open')) return;
        event.preventDefault(); event.stopPropagation();
        const more = $('files-rows').querySelector('.entry.open > .more');
        closeActions(); more?.focus();
    });

    /* One file or folder: its row (or tile), and, where it may be changed, its actions. */
    function entryOf(entry) {
        const inner = innerOf(entry.name);
        const wrap = document.createElement('div'); wrap.className = 'entry'; wrap.dataset.name = entry.name;
        const row = document.createElement(entry.folder ? 'button' : 'a');
        row.className = 'file'; row.dataset.folder = String(entry.folder); row.dataset.type = typeOf(entry);
        if (filesView === 'icons') {
            const look = document.createElement('span'); look.className = 'look';
            if (!entry.folder && THUMBS.includes(extOf(entry.name)) && entry.size > 0 && entry.size <= THUMB_MAX) {
                /* A picture is shown as a picture, fetched only when it comes into sight; the server proves it is one. */
                const img = document.createElement('img');
                img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.draggable = false;
                img.addEventListener('error', () => img.replaceWith(iconFor(entry)));
                img.src = `${API}/files/thumb?${filesQuery({ p: inner, v: entry.modified })}`;
                look.append(img);
            } else look.append(iconFor(entry));
            row.append(look);
        } else {
            /* Its kind as an icon of the same set, and in a word. */
            const drawn = window.clavariumIcons?.icon(KIND_ICONS[typeOf(entry)] ?? 'file');
            if (drawn) { const ic = document.createElement('span'); ic.className = 'icon file-ic'; ic.dataset.type = typeOf(entry); ic.dataset.drawn = 'lucide'; ic.append(drawn); row.append(ic); }
            const kind = document.createElement('span'); kind.className = 'kind';
            kind.textContent = entry.folder ? 'DIR' : (entry.name.includes('.') ? entry.name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
            row.append(kind);
        }
        const label = document.createElement('span'); label.className = 'label'; label.textContent = entry.name; label.title = entry.name;
        const detail = document.createElement('small');
        detail.textContent = filesView === 'icons' ? (entry.folder ? 'folder' : sizeOf(entry.size)) : entry.folder ? `open - ${whenOf(entry.modified)}` : `${sizeOf(entry.size)} - ${whenOf(entry.modified)}`;
        detail.title = new Date(entry.modified).toLocaleString();
        row.append(label, detail);
        if (entry.folder) { row.type = 'button'; row.addEventListener('click', () => { filesAt = inner; void paintFiles(); }); }
        else {
            /* A click shows the file here; the address stays a plain download for "open in a new tab". */
            row.href = `${API}/files/download?${filesQuery({ p: inner })}`;
            row.addEventListener('click', (event) => { event.preventDefault(); void preview(filesOf, inner, entry.name, entry.size); });
        }
        wrap.append(row);
        if (!filesWritable) { row.draggable = false; return wrap; }
        /* Moved by dragging it onto a folder, or onto a level of the trail above. */
        row.draggable = true;
        row.addEventListener('dragstart', (event) => {
            movingPath = inner;
            event.dataTransfer.setData(MOVE_TYPE, inner);
            event.dataTransfer.setData('text/plain', entry.name);
            event.dataTransfer.effectAllowed = 'move';
            wrap.classList.add('dragging');
        });
        row.addEventListener('dragend', () => { movingPath = ''; wrap.classList.remove('dragging'); });
        if (entry.folder) moveTarget(row, inner);
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'more'; more.textContent = '⋯';
        more.setAttribute('aria-label', `Change ${entry.name}`); more.title = 'Rename, move, delete';
        more.setAttribute('aria-expanded', 'false');
        more.addEventListener('click', () => actionsOf(wrap, entry, more));
        wrap.append(more);
        return wrap;
    }

    /* The actions of one entry, under it: one entry's at a time. */
    function closeActions() {
        for (const open of $('files-rows').querySelectorAll('.acts')) open.remove();
        for (const b of $('files-rows').querySelectorAll('.more[aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
        for (const w of $('files-rows').querySelectorAll('.entry.open')) w.classList.remove('open');
    }
    function actionsOf(wrap, entry, more) {
        const wasOpen = more.getAttribute('aria-expanded') === 'true';
        closeActions(); hideNameForm();
        if (wasOpen) return;
        more.setAttribute('aria-expanded', 'true'); wrap.classList.add('open');
        const inner = innerOf(entry.name);
        const acts = document.createElement('div'); acts.className = 'acts';
        const button = (text, run, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; if (cls) b.className = cls; b.addEventListener('click', run); return b; };
        const menu = () => {
            acts.replaceChildren();
            /* Which file the actions are for, said: on a phone the sheet hides the tile. */
            const what = document.createElement('b'); what.className = 'acts-name'; what.textContent = entry.name; acts.append(what);
            if (!entry.folder && editable(entry.name, entry.size)) acts.append(button('Edit', () => { closeActions(); void editFile(filesOf, inner, entry.name); }));
            acts.append(button('Rename', () => { closeActions(); showNameForm('rename', entry, wrap); }));
            acts.append(button('Move to...', moveMenu));
            acts.append(button('Delete', confirmDelete, 'danger'));
        };
        /* Where it can go: the levels above, and the folders beside it. */
        function moveMenu() {
            const parts = filesAt ? filesAt.split('/') : [];
            const places = [...parts.map((_, i) => parts.slice(0, i).join('/')).map((to) => ({ to, label: to ? `${filesOf}/${to}` : `${filesOf} (the top)` })),
                ...filesEntries.filter((e) => e.folder && e.name !== entry.name).map((e) => ({ to: innerOf(e.name), label: `${e.name} (in this folder)` }))];
            acts.replaceChildren();
            if (places.length === 0) {
                const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'There is no other folder here to move it into. Make one with "New folder", or open a folder and come back.';
                acts.append(p, button('Back', menu));
                return;
            }
            const label = document.createElement('label'); label.textContent = `Move "${entry.name}" to`;
            const select = document.createElement('select'); select.id = 'files-move-to'; label.htmlFor = select.id;
            for (const place of places) { const o = document.createElement('option'); o.value = place.to; o.textContent = place.label; select.append(o); }
            acts.append(label, select, button('Move', () => { void moveTo(inner, select.value); }, 'primary'), button('Cancel', menu));
            select.focus();
        }
        function confirmDelete() {
            acts.replaceChildren();
            acts.classList.add('confirm');
            const p = document.createElement('p'); p.className = 'sure';
            p.textContent = entry.folder ? `Delete the folder "${entry.name}" and everything in it? This cannot be undone.` : `Delete "${entry.name}"? This cannot be undone.`;
            const yes = button(entry.folder ? 'Delete the folder' : 'Delete', async () => {
                yes.disabled = true;
                try { await post(`${API}/files/remove?${filesQuery({ p: inner })}`, {}); filesSaid(`Deleted "${entry.name}".`); await paintFiles(); }
                catch (error) { yes.disabled = false; filesFailed(error.message); }
            }, 'danger');
            acts.append(p, yes, button('Cancel', menu));
            yes.focus();
        }
        menu();
        wrap.append(acts);
        /* As icons, the actions open over the tiles, under this one -- toward the inside of the grid. */
        if (filesView === 'icons') acts.classList.toggle('toward-left', wrap.offsetLeft + 240 > $('files-rows').clientWidth);
        acts.querySelector('button')?.focus();
    }
    const filesSaid = (text) => { $('files-status').textContent = text; };
    const filesFailed = (text) => { $('files-error').textContent = text; $('files-error').hidden = false; $('files-error').scrollIntoView?.({ block: 'nearest' }); };

    /* Moved into a folder (by the menu, or dropped onto a folder or the trail). */
    let movingPath = '';
    async function moveTo(from, to) {
        $('files-error').hidden = true;
        const name = from.split('/').pop();
        try { await post(`${API}/files/move?${filesQuery({ p: from })}`, { to }); filesSaid(`Moved "${name}" to ${to ? `${filesOf}/${to}` : filesOf}.`); }
        catch (error) { filesFailed(error.message); }
        await paintFiles({ keep: true });
    }
    /* A place a dragged entry can be dropped on: not itself, not inside itself, not where it already is. */
    function moveTarget(element, to) {
        const fits = () => movingPath && movingPath !== to && !to.startsWith(`${movingPath}/`) && movingPath.split('/').slice(0, -1).join('/') !== to;
        element.addEventListener('dragover', (event) => {
            if (!event.dataTransfer.types.includes(MOVE_TYPE) || !fits()) return;
            event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('drop-on');
        });
        element.addEventListener('dragleave', () => element.classList.remove('drop-on'));
        element.addEventListener('drop', (event) => {
            element.classList.remove('drop-on');
            if (!event.dataTransfer.types.includes(MOVE_TYPE) || !fits()) return;
            event.preventDefault(); event.stopPropagation();
            const from = movingPath; movingPath = '';
            void moveTo(from, to);
        });
    }

    /* ---------- a name: a new file, a new folder, or a new name ---------- */
    let naming = null;           /* { kind: 'file' | 'folder' | 'rename', entry? } */
    function showNameForm(kind, entry, wrap) {
        closeActions();
        naming = { kind, entry };
        const form = $('files-name');
        $('files-name-label').textContent = kind === 'folder' ? 'Name of the new folder' : kind === 'file' ? 'Name of the new file' : `New name for "${entry.name}"`;
        $('files-name-go').textContent = kind === 'rename' ? 'Rename' : 'Create';
        $('files-name-error').hidden = true;
        const input = $('files-name-input');
        input.value = kind === 'rename' ? entry.name : kind === 'file' ? 'notes.txt' : '';
        /* Renaming happens under its row (as icons, above them); making, at the top of the list. */
        if (wrap && filesView === 'list') wrap.after(form); else $('files-rows').before(form);
        form.hidden = false;
        input.focus();
        /* The name without its extension is selected: what one usually changes. */
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, kind !== 'folder' && dot > 0 ? dot : input.value.length);
        form.scrollIntoView?.({ block: 'nearest' });
    }
    function hideNameForm() {
        const form = $('files-name');
        form.hidden = true; naming = null;
        if (form.parentElement !== $('files')) $('files-rows').before(form);
    }
    $('files-name-cancel').addEventListener('click', hideNameForm);
    $('files-name').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideNameForm(); } });
    $('files-name').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!naming) return;
        const name = $('files-name-input').value.trim();
        const fail = (text) => { $('files-name-error').textContent = text; $('files-name-error').hidden = false; };
        if (!name) return fail('A name is needed.');
        if (name.includes('/') || name.includes('\\')) return fail('A name has no slash.');
        if (name.startsWith('.')) return fail('A name does not start with a dot here: such files are hidden.');
        const { kind, entry } = naming;
        try {
            if (kind === 'rename') {
                if (name !== entry.name) await post(`${API}/files/rename?${filesQuery({ p: innerOf(entry.name) })}`, { name });
                filesSaid(name === entry.name ? '' : `Renamed to "${name}".`);
            } else {
                await post(`${API}/files/make?${filesQuery()}`, { name, folder: kind === 'folder' });
                filesSaid(kind === 'folder' ? `Folder "${name}" made.` : `File "${name}" made.`);
            }
        } catch (error) { fail(error.message); return; }
        hideNameForm();
        await paintFiles();
        /* A new text file opens at once in the editor: it was made to be written. */
        if (kind === 'file' && editable(name, 0)) void editFile(filesOf, innerOf(name), name);
    });
    $('files-new-file').addEventListener('click', () => showNameForm('file'));
    $('files-new-folder').addEventListener('click', () => showNameForm('folder'));

    /* ---------- uploads: by the buttons, or dropped from the computer ---------- */
    let uploading = null;        /* { stopped, xhr } while one runs */
    const pathOf = (item) => (item.dir ? `${item.dir}/${item.file.name}` : item.file.name);
    const dropId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
    /* "A name already exists": asked, once per name, or once for all. */
    function askTaken(name, as, others) {
        return new Promise((done) => {
            const box = $('files-ask');
            $('files-ask-text').textContent = as === 'folder' ? `A folder named "${name}" is already here.` : `"${name}" already exists here.`;
            $('files-ask-replace').hidden = as === 'folder';
            $('files-ask-all').checked = false;
            $('files-ask-all-line').hidden = others === 0;
            $('files-ask-all-text').textContent = others === 1 ? 'Do the same for the 1 other name already taken' : `Do the same for the ${others} other names already taken`;
            box.hidden = false;
            box.scrollIntoView?.({ block: 'nearest' });
            $('files-ask-keep').focus();
            const answer = (choice) => () => {
                box.hidden = true;
                for (const id of ['files-ask-keep', 'files-ask-replace', 'files-ask-skip']) $(id).onclick = null;
                done({ choice, all: $('files-ask-all').checked });
            };
            $('files-ask-keep').onclick = answer('keep'); $('files-ask-replace').onclick = answer('replace'); $('files-ask-skip').onclick = answer('skip');
        });
    }
    function sendFile(address, file, progress) {
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            uploading.xhr = x;
            x.open('POST', address);
            x.setRequestHeader('content-type', 'application/octet-stream');
            x.upload.onprogress = (event) => progress(event.loaded);
            x.onload = () => {
                let j = {}; try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
                if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error(j.error || 'The upload failed.'));
            };
            x.onerror = () => reject(new Error('The connection was lost.'));
            x.onabort = () => reject(Object.assign(new Error('Stopped.'), { stopped: true }));
            x.send(file);
        });
    }
    /* `items`: [{ file, dir }] -- dir: the subfolders it goes in, for a folder dropped whole. `folders`: empty folders of the drop, made too. */
    async function upload(items, { folders = [], hidden = 0, deep = 0 } = {}) {
        $('files-error').hidden = true; filesSaid('');
        if (uploading) { filesFailed('An upload is already running: wait for it, or stop it.'); return; }
        if (!filesWritable) { filesFailed('Nothing can be added here.'); return; }
        const notes = [];
        if (hidden) notes.push(`${hidden} hidden file${hidden > 1 ? 's' : ''} or folder${hidden > 1 ? 's' : ''} (a name starting with a dot) left out`);
        if (deep) notes.push(`${deep} folder${deep > 1 ? 's' : ''} deeper than ${DROP_DEPTH} levels left out`);
        const large = items.filter((i) => i.file.size > IMPORT_MAX);
        if (large.length) notes.push(`${large.length === 1 ? `"${large[0].file.name}" is` : `${large.length} files are`} over ${IMPORT_MAX / 1048576} MB, left out`);
        items = items.filter((i) => i.file.size <= IMPORT_MAX);
        if (items.length > DROP_FILES) { filesFailed(`At most ${DROP_FILES} files at a time: this was ${items.length}. Upload fewer at once.`); return; }
        const total = items.reduce((n, i) => n + i.file.size, 0);
        if (total > DROP_BYTES) { filesFailed(`At most ${DROP_BYTES / 1073741824} GB at a time: this was ${sizeOf(total)}.`); return; }
        if (items.length === 0 && folders.length === 0) { filesFailed(notes.length ? `Nothing to upload: ${notes.join('; ')}.` : 'Nothing to upload.'); return; }
        /* Where it goes is fixed now: moving elsewhere meanwhile does not move the upload. */
        const where = { c: current, r: filesOf, p: filesAt };
        const at = (route, extra = {}) => `${API}/files/${route}?${new URLSearchParams({ ...where, ...extra })}`;
        uploading = { stopped: false, xhr: null };
        try {
            /* Names already taken: asked before anything is sent. */
            let taken = [];
            try { taken = (await post(at('taken'), { names: items.map(pathOf) })).taken; } catch (error) { filesFailed(error.message); return; }
            const as = new Map(taken.map((x) => [x.name, x.as]));
            const blocked = items.filter((i) => as.get(pathOf(i)) === 'blocked');
            if (blocked.length) notes.push(`${blocked.length} left out: a file is where ${blocked.length > 1 ? 'their folder goes' : 'its folder goes'}`);
            items = items.filter((i) => as.get(pathOf(i)) !== 'blocked');
            const clashes = items.filter((i) => as.has(pathOf(i)));
            let always = null;
            for (const [k, item] of clashes.entries()) {
                const kind = as.get(pathOf(item));
                let choice = always && !(always === 'replace' && kind === 'folder') ? always : null;
                if (!choice) { const a = await askTaken(pathOf(item), kind, clashes.length - k - 1); choice = a.choice; if (a.all) always = choice; }
                item.exists = choice;
            }
            const sending = items.filter((i) => i.exists !== 'skip');
            const skipped = items.length - sending.length;
            const bytes = sending.reduce((n, i) => n + i.file.size, 0);
            const bar = $('files-progress');
            bar.hidden = false;
            let done = 0; let sent = 0; let failed = 0; const errors = [];
            const draw = (part, name, n) => {
                const pct = bytes ? Math.min(100, Math.round(((done + part) / bytes) * 100)) : 100;
                $('files-progress-text').textContent = `Uploading ${n} of ${sending.length}: ${name}`;
                $('files-progress-bar').firstElementChild.style.width = `${pct}%`;
                $('files-progress-bar').setAttribute('aria-valuenow', String(pct));
                $('files-progress-bytes').textContent = `${sizeOf(done + part)} of ${sizeOf(bytes)}`;
            };
            const id = dropId();
            for (const [k, item] of sending.entries()) {
                if (uploading.stopped) break;
                draw(0, pathOf(item), k + 1);
                try {
                    await sendFile(at('import', { name: item.file.name, dir: item.dir, exists: item.exists ?? 'keep', batch: id }), item.file, (n) => draw(n, pathOf(item), k + 1));
                    sent++;
                } catch (error) {
                    if (error.stopped) break;
                    failed++; errors.push(`${pathOf(item)}: ${error.message}`);
                }
                done += item.file.size;
            }
            /* Empty folders of a folder dropped whole: made too, the shallow first. */
            for (const folder of folders.sort((a, b) => a.split('/').length - b.split('/').length)) {
                if (uploading.stopped) break;
                const parent = folder.split('/').slice(0, -1).join('/');
                await post(`${API}/files/make?${new URLSearchParams({ ...where, p: [where.p, parent].filter(Boolean).join('/') })}`, { name: folder.split('/').pop(), folder: true }).catch(() => {});
            }
            bar.hidden = true;
            const said = [uploading.stopped ? `Stopped: ${sent} of ${sending.length} uploaded` : `${sent} file${sent === 1 ? '' : 's'} uploaded`];
            if (skipped) said.push(`${skipped} skipped`);
            filesSaid(`${said.join(', ')}.${notes.length ? ` ${notes.join('; ')}.` : ''}`);
            if (failed) filesFailed(`${failed} could not be uploaded. ${errors.slice(0, 4).join(' ')}${errors.length > 4 ? ' ...' : ''}`);
        } finally {
            uploading = null;
            $('files-progress').hidden = true; $('files-ask').hidden = true;
            if (where.r === filesOf && current === where.c) await paintFiles({ keep: true });
        }
    }
    $('files-progress-stop').addEventListener('click', () => { if (uploading) { uploading.stopped = true; uploading.xhr?.abort(); } });

    /* By the buttons: files, or a whole folder where the browser can pick one. */
    const FOLDER_PICK = 'webkitdirectory' in document.createElement('input') && !/iPhone|iPad|iPod/.test(navigator.userAgent);
    $('files-import-folder').hidden = !FOLDER_PICK;
    $('files-pick-folder').webkitdirectory = FOLDER_PICK;
    $('files-import').addEventListener('click', () => $('files-pick').click());
    $('files-import-folder').addEventListener('click', () => $('files-pick-folder').click());
    $('files-pick').addEventListener('change', async () => {
        const items = [...$('files-pick').files].map((file) => ({ file, dir: '' }));
        $('files-pick').value = '';
        await upload(items);
    });
    $('files-pick-folder').addEventListener('change', async () => {
        let hidden = 0; let deep = 0;
        const items = [];
        for (const file of $('files-pick-folder').files) {
            const parts = (file.webkitRelativePath || file.name).split('/');
            if (parts.some((p) => p.startsWith('.'))) { hidden++; continue; }
            if (parts.length - 1 > DROP_DEPTH) { deep++; continue; }
            items.push({ file, dir: parts.slice(0, -1).join('/') });
        }
        $('files-pick-folder').value = '';
        await upload(items, { hidden, deep });
    });

    /* Dropped from the computer: files, and folders with all they hold. */
    async function droppedItems(transfer) {
        const entries = [...(transfer.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
        if (entries.length === 0) return { items: [...transfer.files].map((file) => ({ file, dir: '' })), folders: [], hidden: 0, deep: 0 };
        const items = []; const folders = []; let hidden = 0; let deep = 0;
        async function walk(entry, dir, depth) {
            if (items.length > DROP_FILES) return;
            if (entry.name.startsWith('.')) { hidden++; return; }
            if (entry.isFile) { items.push({ file: await new Promise((ok, no) => entry.file(ok, no)), dir }); return; }
            if (depth >= DROP_DEPTH) { deep++; return; }
            const inside = dir ? `${dir}/${entry.name}` : entry.name;
            const reader = entry.createReader();
            let any = false;
            /* A folder is read in pieces until a piece comes back empty. */
            for (;;) {
                const piece = await new Promise((ok, no) => reader.readEntries(ok, no));
                if (piece.length === 0) break;
                for (const e of piece) { any = true; await walk(e, inside, depth + 1); }
            }
            if (!any) folders.push(inside);
        }
        for (const entry of entries) await walk(entry, '', 0);
        return { items, folders, hidden, deep };
    }
    const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files') && ![...(event.dataTransfer?.types ?? [])].includes(MOVE_TYPE);
    let dragDepth = 0;
    const dropZone = $('files-drop');
    $('files').addEventListener('dragenter', (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth++;
        $('files-drop-text').textContent = !filesOf ? 'There is no folder here to upload into.' : filesWritable ? `Drop to upload into ${[filesOf, filesAt].filter(Boolean).join('/')}${DEVICE ? '' : `, in ${current}`}` : 'This folder is read-only: nothing can be added here.';
        dropZone.dataset.allowed = String(Boolean(filesOf && filesWritable));
        /* Over the part of the sheet in sight, wherever it was scrolled to. */
        dropZone.style.top = `${$('files').scrollTop + 8}px`; dropZone.style.height = `${$('files').clientHeight - 16}px`;
        dropZone.hidden = false;
    });
    $('files').addEventListener('dragover', (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = filesOf && filesWritable ? 'copy' : 'none';
    });
    $('files').addEventListener('dragleave', (event) => {
        if (!carriesFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dropZone.hidden = true;
    });
    $('files').addEventListener('drop', async (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth = 0; dropZone.hidden = true;
        if (!filesOf || !filesWritable) return;
        let found;
        try { found = await droppedItems(event.dataTransfer); } catch { filesFailed('What was dropped could not be read.'); return; }
        await upload(found.items, found);
    });
    /* A file dropped anywhere else is not opened by the browser in place of this page. */
    window.addEventListener('dragover', (event) => { if (carriesFiles(event)) event.preventDefault(); });
    window.addEventListener('drop', (event) => { if (carriesFiles(event)) event.preventDefault(); });

    /* ---------- a file, shown here ---------- */
    /* WHAT IS SHOWN MAY HAVE BEEN WRITTEN BY A TOOL. So a file is never
       opened as a page of this site: a picture is drawn as a picture, text is
       shown as text, a PDF is drawn on a canvas by this page. Anything else
       is offered for download, and nothing is ever run. */
    const PREVIEW_MAX = 25 * 1024 * 1024;
    const TEXT_MAX = 1024 * 1024;
    /* SOUNDS AND VIDEOS (02-11): played here, by the browser's own player. What it cannot read (an .avi, an
       .mkv of another codec) says so, with Download. Up to MEDIA_MAX read whole (so it can be moved through),
       beyond, played as it comes. */
    const MEDIA = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', ogv: 'video/ogg' };
    const MEDIA_MAX = 200 * 1024 * 1024;
    const PICTURES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    /* Office files (02-11), read in the page: spreadsheets by SheetJS, Word by mammoth (loaded on first use). */
    const SHEETS = ['xlsx', 'xlsm', 'xls', 'ods'];
    const SHEET_ROWS = 2000; const SHEET_COLS = 100;
    const scriptsLoaded = new Map();
    const loadScript = (url) => {
        if (!scriptsLoaded.has(url)) scriptsLoaded.set(url, new Promise((ok, ko) => { const t = document.createElement('script'); t.src = url; t.onload = ok; t.onerror = () => { scriptsLoaded.delete(url); ko(new Error('The reader could not be loaded.')); }; document.head.append(t); }));
        return scriptsLoaded.get(url);
    };
    const TEXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'mjs', 'ts', 'py', 'sh', 'sql', 'c', 'h', 'go', 'rs', 'java', 'rb', 'php', 'tex', 'eml'];
    const PDF_PAGES = 30;
    /* Beyond this, a Markdown file is shown as its text: formatting it would hold the page. */
    const MD_MAX = 512 * 1024;
    let shownUrl = null;
    /* The file is shown in a WINDOW over the screen, wherever it was asked
       from: closing it leaves the terminal, or the list, as it was. */
    function closePreview() {
        if ($('viewer').classList.contains('viewer-full')) { $('viewer').classList.remove('viewer-full'); $('preview-full').setAttribute('aria-pressed', 'false'); try { if (document.fullscreenElement === $('viewer')) document.exitFullscreen?.(); } catch { /* already out */ } }
        if (shownUrl) { URL.revokeObjectURL(shownUrl); shownUrl = null; }
        for (const url of mdUrls) URL.revokeObjectURL(url);
        mdUrls.clear();
        editing = null;
        delete $('viewer').dataset.editing;
        $('preview-body').replaceChildren();
        $('preview-edit').hidden = true; $('preview-download').hidden = false;
        $('viewer').classList.remove('viewer-sheet');
        offerCopy(null);
        const was = !$('viewer').hidden;
        $('viewer').hidden = true;
        /* Its step goes with it, whoever closed it. */
        nav.dropOver('viewer');
        if ($('files').hidden && !panelShown) focusTerminal();
        if (was && filesChanged && !$('files').hidden) { filesChanged = false; void paintFiles(); }
    }
    /* COPY, in the window: all the text of a text file, or the picture.
       The clipboard is written INSIDE the click (a browser refuses it
       otherwise, Safari first). Text refused: the text is selected instead,
       for the person's own copy. A picture goes as PNG -- the one type every
       browser takes -- drawn on a canvas when it is another; the button is
       offered only where the browser can put a picture on the clipboard.
       `what`: { text } or { picture: Blob }, or null for no button. */
    let copyLabel = 'Copy';
    function offerCopy(what, { select } = {}) {
        const button = $('preview-copy');
        const pictures = typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function' && (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'));
        const can = what && (what.text !== undefined || (what.picture && pictures));
        button.hidden = !can;
        copyLabel = what?.picture ? 'Copy image' : 'Copy';
        /* An icon: its word is its name (hover, long press, reader); "Copied" shows a moment as a tick of colour. */
        const word = (w) => { button.title = w; button.setAttribute('aria-label', w); if (w === 'Copied') button.dataset.done = 'true'; else delete button.dataset.done; };
        word(copyLabel);
        button.onclick = !can ? null : () => {
            const done = (ok, why) => {
                word(ok ? 'Copied' : copyLabel);
                if (!ok && why) { $('preview-note').textContent = why; $('preview-note').hidden = false; }
                if (ok) setTimeout(() => { if (button.dataset.done) word(copyLabel); }, 1800);
            };
            if (what.text !== undefined) {
                const fallback = () => { const at = select?.(); done(false, at ? 'The browser did not let this page copy: the text is selected, copy it yourself (Ctrl+C, or a long press).' : 'The browser did not let this page copy.'); };
                try { void navigator.clipboard.writeText(what.text).then(() => done(true), fallback); } catch { fallback(); }
                return;
            }
            /* A PNG goes as it is; one the clipboard will not decode (Chrome
               is stricter there than in an <img>) is drawn again, once. */
            const refused = () => done(false, 'The browser did not let this page copy the picture: download it instead.');
            const write = (png) => navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            try {
                const first = what.picture.type === 'image/png' ? write(Promise.resolve(what.picture)).catch(() => write(asPng(what.picture))) : write(asPng(what.picture));
                void first.then(() => done(true), refused);
            } catch { refused(); }
        };
    }
    /* A picture of another type, drawn and given back as PNG. */
    async function asPng(blob) {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('not drawn'))), 'image/png'));
    }
    /* Selects all of an element's text, for a copy by hand. */
    function selectAll(node) {
        if (!node) return false;
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return true;
    }
    /* A MARKDOWN FILE, SHOWN FORMATTED, as the chat shows what the tool
       writes. Parley reads the text into plain data (its markdown()); the
       page is built from that data element by element, its text as text:
       never the file as markup. Parley does not export its painter yet: once
       it does (renderMarkdown, with these same slots), it is used instead of
       the one here. Slots: picture(src) the address of a picture this
       preview may show, or null (then its caption is shown); open(href) a
       function opening a file of the same folder, or null; diagram and
       highlight as for the chat. Blob addresses made go into `urls`. */
    const mdUrls = new Set();
    let mdWords = null;
    async function markdownPage(text, slots) {
        const P = await import(new URL('vendor/parley-ui.js', new URL(DEVICE ? '/c/' : '/', location.href)).href);
        if (!mdWords) mdWords = await readWords().catch(() => ({}));
        const all = { words: mdWords, urls: mdUrls, ...slots };
        if (typeof P.renderMarkdown === 'function') return P.renderMarkdown(text, all);
        return paintMarkdown(P.markdown(text), P.safeLink, all);
    }
    function paintMarkdown(data, safeLink, { words, picture, open, diagram, highlight, urls }) {
        const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
        const said = (key, fallback) => (typeof words?.[key] === 'string' ? words[key] : fallback);
        const KINDS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
        const BADGES = { ok: 'ok', todo: 'todo', blocked: 'blocked', warn: 'warn' };
        function inlines(nodes, into) {
            for (const n of nodes) {
                if (n.t === 'text') into.append(n.v);
                else if (n.t === 'br') into.append(el('br'));
                else if (n.t === 'code') into.append(el('code', '', n.v));
                else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'mark') into.append(inlines(n.c, el(n.t === 'del' ? 's' : n.t)));
                else if (n.t === 'badge') { const b = el('span', 'parley-badge', said(`badge-${n.kind}`, BADGES[n.kind] ?? n.kind)); b.dataset.kind = n.kind; into.append(b); }
                else if (n.t === 'link') {
                    const href = safeLink(n.href);
                    const go = href ? null : open?.(n.href);
                    if (href) { const a = el('a', 'parley-link'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; a.title = href; into.append(inlines(n.c, a)); }
                    else if (go) { const b = el('button', 'parley-pathlink'); b.type = 'button'; b.title = n.href; b.addEventListener('click', go); into.append(inlines(n.c, b)); }
                    else into.append(inlines(n.c, el('span')));
                } else if (n.t === 'img') {
                    const url = picture?.(n.src);
                    if (url) { const img = el('img'); img.src = url; img.alt = n.alt || n.src.split('/').pop(); img.loading = 'lazy'; img.decoding = 'async'; into.append(img); }
                    else { const off = el('span', 'parley-noimg', n.alt || n.src.split('/').pop()); off.title = said('not-shown', 'Not shown here'); into.append(off); }
                }
            }
            return into;
        }
        function tokens(list, depth) {
            const out = [];
            for (const t of list) {
                if (typeof t === 'string') { out.push(t); continue; }
                if (!t || typeof t !== 'object' || depth > 12) continue;
                const span = el('span', 'parley-tok');
                for (const n of [t.type, ...(Array.isArray(t.alias) ? t.alias : [t.alias])]) if (typeof n === 'string' && /^[a-z][a-z-]{0,30}$/.test(n)) span.classList.add(`parley-tok-${n}`);
                span.append(...(Array.isArray(t.content) ? tokens(t.content, depth + 1) : [String(t.content ?? '')]));
                out.push(span);
            }
            return out;
        }
        function code(b) {
            const holder = el('div', 'parley-code');
            const bar = el('div', 'parley-code-bar');
            const c = el('code', '', b.text);
            const pre = el('pre'); pre.append(c);
            const copy = el('button', 'parley-copy', said('copy', 'Copy')); copy.type = 'button';
            copy.addEventListener('click', () => {
                const done = () => { copy.textContent = said('copied', 'Copied'); setTimeout(() => { copy.textContent = said('copy', 'Copy'); }, 1500); };
                try { void navigator.clipboard.writeText(b.text).then(done, () => selectAll(c)); } catch { selectAll(c); }
            });
            bar.append(el('span', 'parley-code-lang', b.lang), copy);
            holder.append(bar, pre);
            if (highlight && b.lang && b.text.length <= 40_000) Promise.resolve().then(() => highlight(b.text, b.lang)).then((tree) => { if (Array.isArray(tree)) c.replaceChildren(...tokens(tree, 0)); }, () => {});
            return holder;
        }
        function drawing(b) {
            if (!diagram || b.text.length > 20_000) return code(b);
            const fig = el('figure', 'parley-diagram');
            fig.append(el('span', 'parley-diagram-wait', said('diagram', 'Diagram')));
            Promise.resolve().then(() => diagram(b.text)).then((svg) => {
                if (typeof svg !== 'string' || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) throw new Error('not a drawing');
                /* A picture runs nothing and loads nothing: the drawing is shown as one. */
                const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
                urls?.add(url);
                const img = el('img'); img.src = url; img.alt = said('diagram', 'Diagram');
                fig.replaceChildren(img);
            }).catch(() => fig.replaceWith(code(b)));
            return fig;
        }
        function block(b) {
            if (b.t === 'p') return inlines(b.c, el('p'));
            if (b.t === 'h') return inlines(b.c, el(`h${Math.min(6, b.level + 1)}`, `parley-h parley-h${b.level}`));
            if (b.t === 'hr') return el('hr');
            if (b.t === 'code') return b.lang === 'mermaid' ? drawing(b) : code(b);
            if (b.t === 'quote') return blocks(b.c, el('blockquote'));
            if (b.t === 'alert') {
                const box = el('div', 'parley-callout'); box.dataset.kind = b.kind; box.setAttribute('role', 'note');
                box.append(el('p', 'parley-callout-head', said(b.kind, KINDS[b.kind] ?? b.kind)));
                return blocks(b.c, box);
            }
            if (b.t === 'list') {
                const list = el(b.ordered ? 'ol' : 'ul');
                if (Number.isInteger(b.start)) list.start = b.start;
                for (const item of b.items) {
                    const li = el('li');
                    if (item.task !== null) { li.className = 'parley-task'; const box = el('span', 'parley-check', item.task ? '☑' : '☐'); box.dataset.done = String(item.task); li.append(box); }
                    if (item.c.length === 1 && item.c[0].t === 'p') inlines(item.c[0].c, li); else blocks(item.c, li);
                    list.append(li);
                }
                return list;
            }
            if (b.t === 'table') {
                const wrap = el('div', 'parley-table'); wrap.tabIndex = 0;
                const table = el('table'); const head = el('thead'); const tr = el('tr'); const body = el('tbody');
                b.head.forEach((cell, k) => { const th = el('th'); if (b.align[k]) th.style.textAlign = b.align[k]; tr.append(inlines(cell, th)); });
                head.append(tr);
                for (const row of b.rows) { const r = el('tr'); row.forEach((cell, k) => { const td = el('td'); if (b.align[k]) td.style.textAlign = b.align[k]; r.append(inlines(cell, td)); }); body.append(r); }
                table.append(head, body); wrap.append(table);
                return wrap;
            }
            return el('span');
        }
        function blocks(list, into) { for (const b of list) into.append(block(b)); return into; }
        return blocks(data, el('div', 'parley-md'));
    }
    /* A path written in a Markdown file, as a place in the same folder kept
       here: relative to the file, or absolute under /work or the folder's own
       /resources/<name>. Never above the top of the folder; anything else: null. */
    function besideFile(tab, inner, href) {
        let raw = String(href ?? '').trim().replace(/[?#].*$/, '');
        if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
        try { raw = decodeURIComponent(raw); } catch { return null; }
        let parts;
        const top = tab === 'work' ? '/work/' : `/resources/${tab}/`;
        if (raw.startsWith('/')) { if (!raw.startsWith(top)) return null; parts = raw.slice(top.length).split('/'); }
        else parts = [...inner.split('/').slice(0, -1), ...raw.split('/')];
        const out = [];
        for (const p of parts) { if (p === '' || p === '.') continue; if (p === '..') { if (!out.length) return null; out.pop(); } else out.push(p); }
        return out.length ? out.join('/') : null;
    }
    /* `tab`, `inner`: its place in a folder kept here. `from`: an address to
       read it at instead (a file of the machine's own disk). */
    /* `opts.own`: a blob address of the page's own (an attachment of a mail), let go with the window; `opts.within`: the mail it came from;
       `opts.bytes`: its bytes, already read. */
    async function preview(tab, inner, name, size, from, opts = {}) {
        closePreview();
        if (opts.own) mdUrls.add(opts.own);
        const address = from ?? `${API}/files/download?${new URLSearchParams({ c: current, r: tab, p: inner })}`;
        $('preview-name').textContent = name;
        $('preview-download').href = address; $('preview-download').setAttribute('download', name);
        /* From the terminal, a way to the folder it sits in. */
        /* From the terminal or the chat, a way to the folder it sits in: the Assets tab, on it (Files, on a device). */
        $('preview-where').hidden = Boolean(from) || (!$('files').hidden && !$('files').classList.contains('embedded')) || noTerminal() || (!DEVICE && assetsShown);
        { const word = DEVICE ? 'Show in Files' : 'Show in Assets'; $('preview-where').title = word; $('preview-where').setAttribute('aria-label', word); }
        $('preview-where').onclick = async () => {
            closePreview();
            const folder = inner.split('/').slice(0, -1).join('/');
            if (!DEVICE) { showInAssets(tab, folder); return; }
            filesOf = tab; filesAt = folder;
            await paintFiles(); showFiles();
        };
        nav.over('viewer', ({ history: back }) => {
            /* Back with changes not saved: asked first, never lost by a stray gesture. */
            if (back && dirty()) { askDiscard(); return false; }
            if (!$('viewer').hidden) closePreview();
            return undefined;
        });
        /* A mail cited by its reference: a sheet over the thread (a panel at the right on a wide screen), the thread seen behind. */
        $('viewer').classList.toggle('viewer-sheet', Boolean(opts.mailRef));
        $('viewer').hidden = false;
        /* Text in a folder this conversation may write in: editable here. */
        $('preview-edit').hidden = Boolean(from) || !editable(name, size) || !canWrite(tab);
        $('preview-edit').onclick = () => { void editFile(tab, inner, name); };
        /* A file of the shared folders: attached to a card from here (#180). */
        $('preview-attach').hidden = (Boolean(from) && !opts.mailRef) || DEVICE;
        /* Full screen: the file takes the whole screen (the real API where granted, else a cover); kept while it is open. */
        const full = (on) => { $('viewer').classList.toggle('viewer-full', on); $('preview-full').setAttribute('aria-pressed', String(on)); const w2 = on ? 'Leave full screen' : 'Full screen'; $('preview-full').title = w2; $('preview-full').setAttribute('aria-label', w2); try { if (on) $('viewer').requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement === $('viewer')) document.exitFullscreen?.(); } catch { /* the cover stands in */ } };
        $('preview-full').onclick = () => full(!$('viewer').classList.contains('viewer-full'));
        $('preview-attach').onclick = () => void attachToCard(opts.mailRef ? { kind: 'mail', ref: opts.mailRef.got?.ref || opts.mailRef.ref, title: opts.mailRef.title || opts.mailRef.label || name } : { kind: 'file', ref: tab === 'work' ? `/work/${inner}` : `/resources/${tab}/${inner}`, title: name });
        /* A file read from the machine's disk says so, whatever else is said. */
        const origin = opts.within ? uiSaid('set-mail-of', 'An attachment of {name}', { name: opts.within }) : opts.mailRef ? '' : from ? 'Read from the disk of the machine: this file is not kept here, and goes with the machine.' : '';
        const note = (text) => { const all = [text, text === 'Loading...' ? '' : origin].filter(Boolean).join(' '); $('preview-note').textContent = all; $('preview-note').hidden = !all; };
        /* NOTHING TO SHOW (02-11): not an empty frame, but a file, why, and a Download button that is seen. */
        const cannot = (why) => {
            const box = el('div', 'preview-cannot');
            const icon = el('div', 'preview-cannot-icon'); icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
            const get = el('a', 'button primary preview-cannot-get'); get.href = address; get.setAttribute('download', name);
            get.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';
            get.append(document.createTextNode(' Download'));
            box.append(icon, el('b', 'preview-cannot-name', name), el('p', 'hint', why), get);
            $('preview-body').replaceChildren(box); note('');
        };
        /* Its bytes: read from the server, or already here (an attachment of a mail: this page's rules fetch no blob:). */
        const readIt = async () => {
            if (opts.bytes) return opts.bytes.buffer.slice(opts.bytes.byteOffset, opts.bytes.byteOffset + opts.bytes.byteLength);
            const r = await fetch(address);
            if (!r.ok) { const said = await r.json().catch(() => ({})); throw Object.assign(new Error(said.error || 'The file could not be read.'), { kind: said.kind }); }
            /* A mail read by its reference: where it was found, and its reference as it is now. */
            if (opts.mailRef) { const h = (k) => { try { return decodeURIComponent(r.headers.get(k) ?? ''); } catch { return ''; } }; opts.mailRef.got = { box: h('x-mail-box'), folder: h('x-mail-folder'), ref: h('x-mail-ref') || opts.mailRef.ref, cut: r.headers.get('x-mail-cut') === '1' }; }
            return r.arrayBuffer();
        };
        /* A mail that cannot be opened by its reference: one clear line (gone, not theirs, unreachable), never a download. */
        const mailState = (error) => {
            const LINES = { gone: ['set-mail-gone', 'This mail is no longer in the mailbox.'], 'not-yours': ['set-mail-not-yours', 'This mailbox is not yours to open.'], 'old-ref': ['set-mail-old-ref', 'Old reference: ask the AI to attach it again.'], unreachable: ['set-mail-unreachable', 'The mailbox cannot be reached just now.'] };
            const line = LINES[error.kind];
            const box = el('div', 'preview-cannot mail-state'); box.dataset.kind = error.kind || 'error'; box.setAttribute('role', 'status');
            const icon = el('div', 'preview-cannot-icon'); icon.setAttribute('aria-hidden', 'true');
            icon.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
            box.append(icon, el('b', 'mail-state-line', line ? uiSaid(line[0], line[1]) : error.message));
            if (error.kind === 'unreachable' || !line) {
                const again = el('button', 'quiet mail-state-retry', uiSaid('set-mail-retry', 'Try again')); again.type = 'button';
                again.addEventListener('click', () => { void openMailRef(opts.mailRef.ref, { label: opts.mailRef.label, of: opts.mailRef.of }); });
                box.append(again);
            }
            $('preview-name').textContent = opts.mailRef.label || uiSaid('set-mail-mail', 'Mail');
            $('preview-body').replaceChildren(box); note('');
            $('preview-attach').hidden = true; $('preview-download').hidden = true;
        };
        const kind = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        if (MEDIA[kind]) {
            const video = MEDIA[kind].startsWith('video/');
            const player = document.createElement(video ? 'video' : 'audio');
            player.controls = true; player.preload = 'metadata'; player.className = `preview-media${video ? ' preview-video' : ''}`;
            player.setAttribute('playsinline', '');
            player.addEventListener('error', () => { if (!$('viewer').hidden && $('preview-name').textContent === name) cannot(`${size ? `${sizeOf(size)} · ` : ''}This browser cannot play this file.`); }, { once: true });
            if (size && size > MEDIA_MAX) { player.src = address; $('preview-body').replaceChildren(player); note(''); return; }
            note('Loading...');
            let got;
            try { got = await readIt(); } catch (error) { cannot(error.message); return; }
            if ($('viewer').hidden || $('preview-name').textContent !== name) return;
            shownUrl = URL.createObjectURL(new Blob([got], { type: MEDIA[kind] }));
            player.src = shownUrl; $('preview-body').replaceChildren(player); note('');
            return;
        }
        const known = PICTURES[kind] || kind === 'pdf' || TEXTS.includes(kind) || SHEETS.includes(kind) || kind === 'docx';
        if (!known) { cannot(`${size ? `${sizeOf(size)} · ` : ''}This kind of file cannot be shown here.`); return; }
        if (size > (TEXTS.includes(kind) && kind !== 'eml' ? TEXT_MAX : PREVIEW_MAX)) { cannot(`${sizeOf(size)} · Too large to be shown here.`); return; }
        note('Loading...');
        let bytes;
        try { bytes = await readIt(); } catch (error) { if (opts.mailRef) { if (!$('viewer').hidden && $('preview-name').textContent === name) mailState(error); return; } cannot(error.message); return; }
        if ($('viewer').hidden || $('preview-name').textContent !== name) return;      /* closed meanwhile */
        const body = $('preview-body');
        if (PICTURES[kind]) {
            shownUrl = URL.createObjectURL(new Blob([bytes], { type: PICTURES[kind] }));
            const img = document.createElement('img'); img.alt = name; img.src = shownUrl;
            body.append(img); note('');
            offerCopy({ picture: new Blob([bytes], { type: PICTURES[kind] }) });
        } else if (SHEETS.includes(kind)) {
            /* A WORKBOOK: each sheet a table, tabs between them; its cells as text, never as markup. */
            try {
                await loadScript(`${DEVICE ? '/c/vendor' : '/vendor'}/xlsx.js`);
                const book = window.XLSX.read(new Uint8Array(bytes), { type: 'array', cellDates: true, dense: true });
                const tabs = el('div', 'sheet-tabs'); tabs.setAttribute('role', 'tablist');
                const view = el('div', 'sheet-view');
                const showSheet = (sheetName) => {
                    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.sheet === sheetName));
                    const rows = window.XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: false });
                    const table = el('table', 'sheet-table');
                    const width = Math.min(SHEET_COLS, Math.max(0, ...rows.map((r) => r.length)));
                    const head = el('tr'); head.append(el('th', 'sheet-corner', ''));
                    for (let c = 0; c < width; c++) head.append(el('th', '', window.XLSX.utils.encode_col(c)));
                    const thead = el('thead'); thead.append(head); table.append(thead);
                    const tbody = el('tbody');
                    rows.slice(0, SHEET_ROWS).forEach((r, i) => { const tr = el('tr'); tr.append(el('th', '', String(i + 1))); for (let c = 0; c < width; c++) tr.append(el('td', '', String(r[c] ?? ''))); tbody.append(tr); });
                    table.append(tbody);
                    view.replaceChildren(table);
                    note(rows.length > SHEET_ROWS ? `The first ${SHEET_ROWS} rows of ${rows.length}. Download the file for the rest.` : '');
                };
                for (const sheetName of book.SheetNames) { const b = el('button', 'sheet-tab', sheetName); b.type = 'button'; b.dataset.sheet = sheetName; b.setAttribute('role', 'tab'); b.addEventListener('click', () => showSheet(sheetName)); tabs.append(b); }
                body.append(...(book.SheetNames.length > 1 ? [tabs] : []), view);
                showSheet(book.SheetNames[0]);
            } catch { cannot('This spreadsheet could not be read here.'); }
        } else if (kind === 'docx') {
            /* A WORD DOCUMENT, as a readable page: in a frame where nothing runs, as a page written by the tool. */
            try {
                await loadScript(`${DEVICE ? '/c/vendor' : '/vendor'}/mammoth.js`);
                const made = await window.mammoth.convertToHtml({ arrayBuffer: bytes });
                const frame = document.createElement('iframe'); frame.className = 'doc-frame'; frame.setAttribute('sandbox', ''); frame.title = name;
                const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
                frame.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.55 system-ui,sans-serif;max-width:46rem;margin:24px auto;padding:0 16px;${dark ? 'background:#131a22;color:#e7edf4' : 'background:#fff;color:#17202b'}}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #8888;padding:4px 8px}a{color:inherit}</style>${made.value}`;
                body.append(frame); note('Shown as a page: its exact layout is not kept. Download it for the original.');
            } catch { cannot('This document could not be read here.'); }
        } else if (kind === 'pdf') {
            try {
                const base = DEVICE ? '/c/vendor' : '/vendor';
                const pdfjs = await import(`${base}/pdf.mjs`);
                pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.mjs`;
                const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false }).promise;
                const pages = Math.min(doc.numPages, PDF_PAGES);
                const width = Math.max(320, body.clientWidth - 2);
                for (let n = 1; n <= pages; n++) {
                    const page = await doc.getPage(n);
                    const fit = page.getViewport({ scale: 1 });
                    const ratio = Math.min(2, window.devicePixelRatio || 1);
                    const viewport = page.getViewport({ scale: (Math.min(width, 1100) / fit.width) * ratio });
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
                    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
                    canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
                    body.append(canvas);
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                    if ($('viewer').hidden) return;
                }
                note(doc.numPages > pages ? `The first ${pages} pages of ${doc.numPages}. Download the file to read the rest.` : `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}.`);
            } catch { cannot('This PDF could not be shown here.'); }
        } else if (kind === 'eml') {
            showMail({ bytes, name, tab, inner, from, note, ref: opts.mailRef });
        } else {
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            const source = () => { const pre = document.createElement('pre'); pre.className = 'source'; pre.textContent = text; return pre; };
            /* Copy: all its text, the source of a page too. Refused, the text is shown and selected. */
            offerCopy({ text }, { select: () => { if (!body.querySelector('pre.source')) body.querySelector('button')?.click(); return selectAll(body.querySelector('pre.source')); } });
            /* A page written by the tool is SHOWN AS A PAGE -- in a frame that is
               nobody: no session, no network, nothing of this site (the server
               answers it with those rules; see files.mjs). Its source is one
               tap away. A file of the machine's disk, or of a conversation that
               is offline, stays text. */
            const offline = conversations.find((x) => x.name === current)?.offline === true;
            if ((kind === 'html' || kind === 'htm') && !from && !offline) {
                const frame = document.createElement('iframe');
                frame.setAttribute('sandbox', 'allow-scripts');
                frame.setAttribute('referrerpolicy', 'no-referrer');
                frame.title = `${name}, a page written by the tool`;
                frame.src = `${API}/files/page?${new URLSearchParams({ c: current, r: tab, p: inner })}`;
                const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = 'Show its source';
                let shown = 'page';
                toggle.addEventListener('click', () => {
                    shown = shown === 'page' ? 'source' : 'page';
                    body.replaceChildren(toggle, shown === 'page' ? frame : source());
                    toggle.textContent = shown === 'page' ? 'Show its source' : 'Show it as a page';
                });
                body.append(toggle, frame);
                note('A page written by the tool, shown in a closed frame: it reaches nothing outside itself. Never type a password into it.');
            } else if ((kind === 'md' || kind === 'markdown') && text.length <= MD_MAX) {
                /* Markdown: formatted, its text one tap away (the choice kept on this device). */
                let page;
                try {
                    page = await markdownPage(text, {
                        /* Pictures as the thumbnails of Files allow them (the server checks the folder and the bytes); a file of the machine's disk shows none. */
                        picture: (src) => { const p = from ? null : besideFile(tab, inner, src); return p && /\.(png|jpe?g|gif|webp)$/i.test(p) ? `${API}/files/thumb?${new URLSearchParams({ c: current, r: tab, p })}` : null; },
                        open: (href) => { const p = from ? null : besideFile(tab, inner, href); return p ? () => { void preview(tab, p, p.split('/').pop(), 0); } : null; },
                        diagram: drawDiagram, highlight: colourCode,
                    });
                } catch { page = null; }
                if ($('viewer').hidden || $('preview-name').textContent !== name) return;
                if (!page) { body.append(source()); note(''); return; }
                const formatted = document.createElement('div'); formatted.className = 'parley md-view'; formatted.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
                formatted.append(page);
                const raw = source();
                const switcher = document.createElement('div'); switcher.className = 'md-switch'; switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'Show');
                const choice = (label, what) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.show = what; b.addEventListener('click', () => show(what, true)); return b; };
                const asFormatted = choice('Formatted', 'formatted'); const asText = choice('Text', 'text');
                switcher.append(asFormatted, asText);
                const show = (what, keep) => {
                    asFormatted.setAttribute('aria-pressed', String(what === 'formatted')); asText.setAttribute('aria-pressed', String(what === 'text'));
                    formatted.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
                    body.replaceChildren(switcher, what === 'text' ? raw : formatted);
                    if (keep) { try { localStorage.setItem('clavarium-md-show', what); } catch { /* a private window: not kept */ } }
                };
                let first = 'formatted';
                try { if (localStorage.getItem('clavarium-md-show') === 'text') first = 'text'; } catch { /* as above */ }
                show(first, false);
                /* Refused copy: the text is shown and selected. */
                offerCopy({ text }, { select: () => { show('text', false); return selectAll(raw); } });
                note('');
            } else { body.append(source()); note(offline && (kind === 'html' || kind === 'htm') ? 'This conversation is offline: its page is shown as text, not run.' : ''); }
        }
    }
    /* A MAIL FILE (.eml), as a mail program shows it (05-11): subject, who, when, its words, its
       attachments; its source one tap away (Copy, Download, Full screen: the file as it is). Read by
       web/mail-view.js, here, in the page. Its HTML, which a stranger wrote, is drawn in a frame that
       runs nothing (sandbox: no scripts, no same-origin; its own rules: nothing fetched), made harmless
       first; remote pictures blocked till asked for -- then the server's page of it (files.mjs mailPage),
       still no script. Nothing is fetched on opening. */
    function showMail({ bytes, name, tab, inner, from, note, ref = null }) {
        const body = $('preview-body');
        const M = window.clavariumMail;
        /* Its source: the first megabyte of a large one (Download for all of it). */
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes.byteLength > TEXT_MAX ? bytes.slice(0, TEXT_MAX) : bytes) + (bytes.byteLength > TEXT_MAX ? '\n…' : '');
        const source = el('pre', 'source', raw);
        offerCopy({ text: raw }, { select: () => { show('source'); return selectAll(source); } });
        let mail = null;
        try { mail = M.parse(new Uint8Array(bytes)); } catch { mail = null; }
        if (!mail || (!mail.headers.length && mail.html === null && mail.text === null)) { body.append(source); note(''); return; }
        const view = el('div', 'mail-view');
        /* Opened by its reference: its subject heads the window, where it is now is said, and its bytes are
           what Download gives (read once, never fetched again for it). */
        if (ref) {
            $('preview-name').textContent = mail.subject || ref.label || name;
            ref.title = [mail.subject || ref.label, mail.from[0]?.name || mail.from[0]?.address, mail.date ? mail.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''].filter(Boolean).join(' · ');
            const file = URL.createObjectURL(new Blob([bytes], { type: 'message/rfc822' })); mdUrls.add(file);
            $('preview-download').href = file; $('preview-download').setAttribute('download', `${(mail.subject || 'mail').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.eml`);
            const where = [ref.got?.box, ref.got?.folder].filter(Boolean).join(' · ');
            if (where) view.append(el('div', 'mail-where hint', where));
            if (ref.got?.cut) view.append(el('div', 'mail-cut hint', uiSaid('set-mail-cut', 'Mail cut: attachments may be incomplete.')));
        }
        /* Who, to whom, when. */
        const head = el('div', 'mail-head');
        head.append(el('h2', 'mail-subject', mail.subject || uiSaid('set-mail-no-subject', '(no subject)')));
        const who = (list) => { const span = el('span', 'mail-who'); list.forEach((a, i) => { if (i) span.append(', '); if (a.name) { span.append(el('b', '', a.name), ' '); span.append(el('span', 'hint mail-addr', `<${a.address}>`)); } else span.append(el('b', '', a.address)); }); return span; };
        if (mail.from.length) { const line = el('div', 'mail-from'); line.append(who(mail.from)); head.append(line); }
        const row = (label, value) => { const line = el('div', 'mail-line'); line.append(el('span', 'mail-label', label), value); head.append(line); };
        if (mail.to.length) row(uiSaid('set-mail-to', 'To'), who(mail.to));
        if (mail.cc.length) row(uiSaid('set-mail-cc', 'Cc'), who(mail.cc));
        if (mail.date) row(uiSaid('set-mail-date', 'Date'), el('span', '', mail.date.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
        const details = el('button', 'quiet mail-details', uiSaid('set-mail-details', 'Show details')); details.type = 'button'; details.setAttribute('aria-expanded', 'false');
        const all = el('pre', 'mail-headers', mail.head); all.hidden = true;
        details.addEventListener('click', () => { all.hidden = !all.hidden; details.setAttribute('aria-expanded', String(!all.hidden)); details.textContent = all.hidden ? uiSaid('set-mail-details', 'Show details') : uiSaid('set-mail-hide-details', 'Hide details'); });
        head.append(details, all);
        view.append(head);
        /* Reply: never sent from here -- the AI is asked in the chat, and its answer comes back as a request to approve. */
        if (ref && (ref.of || DEVICE) && (!DEVICE || deviceParts.chat === 'write')) {
            const acts = el('div', 'mail-acts');
            const reply = el('button', 'mail-reply', uiSaid('set-mail-reply', 'Reply…')); reply.type = 'button';
            reply.addEventListener('click', () => { void replyToMail({ ref: ref.got?.ref || ref.ref, of: ref.of }); });
            acts.append(reply); view.append(acts);
        }
        /* Its words: the HTML in a frame that runs nothing, or the plain words with their links. */
        const offline = conversations.find((x) => x.name === (ref ? ref.of : current))?.offline === true;
        const frameOf = () => { const f = document.createElement('iframe'); f.className = 'mail-frame'; f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); f.setAttribute('referrerpolicy', 'no-referrer'); f.title = mail.subject || name; return f; };
        if (mail.html !== null) {
            const page = M.pageOf(mail);
            let frame = frameOf(); frame.srcdoc = page.html;
            if (page.blocked) {
                const bar = el('div', 'mail-remote'); bar.setAttribute('role', 'status');
                bar.append(el('span', '', uiSaid('set-mail-remote', 'Remote pictures blocked')));
                /* Shown by the server's page of the same file: one of a folder kept here, a conversation not cut off. */
                /* A mail opened by its reference: the server's page of the same mail, read again then (asked for). */
                if ((ref || !from) && !offline) {
                    const go = el('button', 'quiet mail-remote-show', uiSaid('set-mail-show-remote', 'Show them')); go.type = 'button';
                    const shown = ref ? `${API}/mail/page?${new URLSearchParams({ ref: ref.got?.ref || ref.ref, ...(ref.of ? { c: ref.of } : {}) })}` : `${API}/files/mail?${new URLSearchParams({ c: current, r: tab, p: inner })}`;
                    go.addEventListener('click', () => { const f = frameOf(); f.src = shown; frame.replaceWith(f); frame = f; bar.remove(); });
                    bar.append(' · ', go);
                }
                view.append(bar);
            }
            view.append(frame);
        } else if (mail.text !== null && mail.text.trim()) {
            const words = el('div', 'mail-text');
            for (const piece of M.linkify(mail.text)) {
                if (!piece.href) { words.append(piece.text); continue; }
                const a = el('a', '', piece.text); a.href = piece.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; words.append(a);
            }
            view.append(words);
        } else view.append(el('p', 'hint mail-empty', uiSaid('set-mail-empty', 'This mail has no text.')));
        /* Its attachments: each opens in this same window (or offers its download), as a file of a folder does. */
        if (mail.attachments.length) {
            const list = el('ul', 'mail-files');
            list.setAttribute('aria-label', mail.attachments.length === 1 ? uiSaid('set-mail-file', '1 attachment') : uiSaid('set-mail-files', '{n} attachments', { n: mail.attachments.length }));
            for (const a of mail.attachments) {
                const li = el('li', 'mail-file');
                const open = el('button', 'quiet mail-file-open'); open.type = 'button';
                const ext = a.name.includes('.') ? a.name.split('.').pop().toUpperCase().slice(0, 4) : '';
                open.append(el('span', 'kind', ext || '?'), el('b', '', a.name), el('small', '', `${sizeOf(a.size)} · ${a.type}`));
                open.addEventListener('click', () => { const url = URL.createObjectURL(new Blob([a.bytes], { type: a.type })); void preview(tab, inner, a.name, a.size, url, { own: url, within: name, bytes: a.bytes }); });
                const get = el('a', 'mail-file-get'); get.setAttribute('download', a.name); get.title = uiSaid('set-mail-download', 'Download'); get.setAttribute('aria-label', `${get.title} ${a.name}`);
                get.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';
                /* Its address let go with the window. */
                { const url = URL.createObjectURL(new Blob([a.bytes], { type: a.type })); mdUrls.add(url); get.href = url; }
                li.append(open, get); list.append(li);
            }
            view.append(list);
        }
        /* Message, or its source. */
        const switcher = el('div', 'md-switch'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'Show');
        const choice = (label, what) => { const b = el('button', '', label); b.type = 'button'; b.dataset.show = what; b.addEventListener('click', () => show(what)); return b; };
        const asMail = choice(uiSaid('set-mail-message', 'Message'), 'mail'); const asSource = choice(uiSaid('set-mail-source', 'Source'), 'source');
        switcher.append(asMail, asSource);
        function show(what) {
            asMail.setAttribute('aria-pressed', String(what === 'mail')); asSource.setAttribute('aria-pressed', String(what === 'source'));
            /* The frame is kept as it is (moved, not made again): hidden, not removed. */
            if (!view.isConnected) body.replaceChildren(switcher, view, source);
            view.hidden = what !== 'mail'; source.hidden = what !== 'source';
        }
        show('mail');
        note('');
    }
    $('preview-close').addEventListener('click', () => leavePreview());
    /* Outside the window, or Escape: closed too -- unless what is edited is not saved. */
    $('viewer').addEventListener('click', (event) => { if (event.target === $('viewer')) leavePreview(); });
    /* Escape, even from the text being edited: the window is left as with its button (asked first if not saved). */
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('viewer').hidden && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); leavePreview(); } }, true);

    /* ---------- a text file, edited here ---------- */
    /* A plain editor: the text, its lines, Save and Cancel. It is saved at the
       version it was read at; if the tool wrote the file meanwhile, the server
       refuses (files.mjs) and the person chooses: take the tool's version,
       write over it, or keep both. */
    const canWrite = (tab) => {
        const known = filesTabs.find((r) => r.name === tab);
        if (known) return known.access === 'write';
        const here = conversations.find((x) => x.name === current);
        if (tab === 'work') return here?.work === 'kept' && !noTerminal();
        return (here?.resources ?? []).some((r) => r.name === tab && r.access === 'write') || deviceShared.some((s) => s.name === tab && s.access === 'write');
    };
    const dirty = () => editing !== null && editing.area.value !== editing.saved;
    /* Leaving the window: unsaved changes are asked about first, never lost by a stray tap. */
    function leavePreview() {
        if (dirty()) { askDiscard(); return; }
        closePreview();
    }
    function askDiscard(then = closePreview) {
        const box = $('preview-body').querySelector('.edit-ask');
        if (!box) return;
        box.replaceChildren();
        const p = document.createElement('b'); p.textContent = 'Your changes are not saved.';
        const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save them';
        save.addEventListener('click', () => { box.hidden = true; void saveEdit(); });
        const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'danger'; drop.textContent = 'Discard them';
        drop.addEventListener('click', () => { editing.saved = editing.area.value; then(); });
        const stay = document.createElement('button'); stay.type = 'button'; stay.textContent = 'Keep editing';
        stay.addEventListener('click', () => { box.hidden = true; editing.area.focus(); });
        const row = document.createElement('div'); row.className = 'action-row'; row.append(stay, drop, save);
        box.append(p, row); box.hidden = false;
        save.focus();
    }
    async function editFile(tab, inner, name) {
        closePreview();
        const query = new URLSearchParams({ c: current, r: tab, p: inner });
        $('preview-name').textContent = name;
        $('preview-download').href = `${API}/files/download?${query}`; $('preview-download').setAttribute('download', name);
        $('preview-where').hidden = true; $('preview-edit').hidden = true;
        $('preview-note').textContent = 'Loading...'; $('preview-note').hidden = false;
        $('viewer').hidden = false;
        let read;
        try {
            const r = await fetch(`${API}/files/text?${query}`);
            read = await r.json();
            if (!r.ok) throw new Error(read.error || 'The file could not be read.');
        } catch (error) { $('preview-note').textContent = error.message; return; }
        if ($('viewer').hidden || $('preview-name').textContent !== name) return;
        $('preview-note').hidden = true;
        $('viewer').dataset.editing = 'true';
        const body = $('preview-body');
        const area = document.createElement('textarea');
        area.className = 'editor'; area.value = read.text; area.spellcheck = false;
        area.setAttribute('autocapitalize', 'off'); area.setAttribute('autocomplete', 'off'); area.setAttribute('wrap', 'off');
        area.setAttribute('aria-label', `Text of ${name}`);
        const ask = document.createElement('div'); ask.className = 'edit-ask files-card callout confirm'; ask.hidden = true; ask.setAttribute('role', 'alertdialog');
        const bar = document.createElement('div'); bar.className = 'row edit-bar';
        const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save'; save.id = 'edit-save';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.id = 'edit-cancel';
        const info = document.createElement('small'); info.className = 'hint'; info.id = 'edit-info'; info.setAttribute('role', 'status');
        bar.append(save, cancel, info);
        body.replaceChildren(ask, area, bar);
        editing = { tab, inner, name, version: read.version, saved: read.text, area, info, ask };
        let told = '';
        const count = () => {
            let lines = 1; const text = area.value;
            for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
            const bytes = new TextEncoder().encode(text).length;
            info.textContent = `${lines} line${lines === 1 ? '' : 's'}, ${sizeOf(bytes)}${bytes > EDIT_MAX ? ` - over ${EDIT_MAX / 1048576} MB, too large to save here` : ''}${dirty() ? ' - not saved' : told ? ` - ${told}` : ''}`;
            save.disabled = bytes > EDIT_MAX;
        };
        editing.count = count; editing.tell = (text) => { told = text; count(); };
        let pending = 0;
        area.addEventListener('input', () => { told = ''; cancelAnimationFrame(pending); pending = requestAnimationFrame(count); });
        area.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveEdit(); }
            /* Tab writes a tab, as in any editor; Escape (handled above) still leaves. */
            if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end'); area.dispatchEvent(new Event('input')); }
        });
        save.addEventListener('click', () => { void saveEdit(); });
        cancel.addEventListener('click', () => {
            const back = () => { const e = editing; editing = null; void preview(e.tab, e.inner, e.name, new TextEncoder().encode(e.saved).length); };
            if (dirty()) askDiscard(back); else back();
        });
        count();
        area.focus();
        area.setSelectionRange(0, 0); area.scrollTop = 0;
    }
    /* `how`: undefined (at the version read), 'any' (over whatever is there), 'copy' (beside it). */
    async function saveEdit(how) {
        if (!editing) return;
        const e = editing;
        const text = e.area.value;
        const query = new URLSearchParams({ c: current, r: e.tab, p: e.inner, ...(how === 'copy' ? { copy: '1' } : { version: how === 'any' ? 'any' : e.version }) });
        e.ask.hidden = true;
        let j;
        try {
            const r = await fetch(`${API}/files/save?${query}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([text]) });
            j = await r.json().catch(() => ({}));
            if (r.status === 409 && j.kind === 'changed') { changedMeanwhile(); return; }
            if (!r.ok) throw new Error(j.error || 'It could not be saved.');
        } catch (error) { e.tell(`not saved: ${error.message}`); return; }
        if (editing !== e) return;
        filesChanged = true;
        if (how === 'copy') {
            /* Saved beside it: what is edited from now on is the copy. */
            e.inner = [...e.inner.split('/').slice(0, -1), j.name].join('/'); e.name = j.name;
            $('preview-name').textContent = j.name;
            $('preview-download').href = `${API}/files/download?${new URLSearchParams({ c: current, r: e.tab, p: e.inner })}`; $('preview-download').setAttribute('download', j.name);
        }
        e.version = j.version; e.saved = text;
        e.tell(how === 'copy' ? `saved as "${j.name}"; the file the tool wrote is left as it was` : `saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
    /* The tool wrote the file after it was opened here: nothing was written; the person chooses. */
    function changedMeanwhile() {
        const e = editing; const box = e.ask;
        box.replaceChildren();
        const p = document.createElement('b'); p.textContent = 'This file changed since you opened it: the tool may have written it. Your text was not saved.';
        /* What changed, and when: read again, compared line by line with what is in the editor. */
        const look = document.createElement('button'); look.type = 'button'; look.textContent = 'Show what is different';
        look.addEventListener('click', async () => {
            look.disabled = true;
            try {
                const r = await fetch(`${API}/files/text?${new URLSearchParams({ c: current, r: e.tab, p: e.inner })}`);
                const theirs = await r.json();
                if (!r.ok) throw new Error(theirs.error || 'Its new version could not be read.');
                const when = document.createElement('small'); when.className = 'hint';
                when.textContent = `Changed at ${new Date(theirs.modified).toLocaleString()}. Lines with - are only in its new version, lines with + only in yours.`;
                look.replaceWith(when, differences(theirs.text, e.area.value));
            } catch (error) { look.disabled = false; look.textContent = error.message; }
        });
        const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Load its new version (your changes are lost)';
        reload.addEventListener('click', async () => {
            const keep = e.area.value; e.saved = keep;     /* not "dirty" while it is replaced */
            editing = null;
            await editFile(e.tab, e.inner, e.name);
        });
        const over = document.createElement('button'); over.type = 'button'; over.className = 'danger'; over.textContent = 'Overwrite it with mine';
        over.addEventListener('click', () => { void saveEdit('any'); });
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'primary'; copy.textContent = 'Save mine as a copy';
        copy.addEventListener('click', () => { void saveEdit('copy'); });
        const row = document.createElement('div'); row.className = 'action-row'; row.append(reload, over, copy);
        box.append(p, look, row); box.hidden = false;
        copy.focus();
        e.tell('not saved: changed meanwhile');
    }
    /* Two texts, line by line: what only one has, with three lines around each change. */
    function differences(a, b) {
        const pre = document.createElement('pre'); pre.className = 'diff';
        const x = a.split('\n'); const y = b.split('\n');
        const line = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; pre.append(s); };
        if (x.length * y.length > 4_000_000) { line('gap', 'These texts are too long to be compared here.'); return pre; }
        /* The longest run of lines both share (LCS), then walked from the top. */
        const n = x.length; const m = y.length; const w = m + 1;
        const len = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
        const out = [];
        let i = 0; let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
            else if (j < m && (i >= n || len[i * w + j + 1] >= len[(i + 1) * w + j])) { out.push(['+', y[j]]); j++; }
            else { out.push(['-', x[i]]); i++; }
        }
        if (!out.some(([k]) => k !== ' ')) { line('gap', 'The texts are the same.'); return pre; }
        const near = out.map((_, k) => out.slice(Math.max(0, k - 3), k + 4).some(([kind]) => kind !== ' '));
        let skipped = false;
        out.forEach(([kind, text], k) => {
            if (!near[k]) { if (!skipped) line('gap', '...'); skipped = true; return; }
            skipped = false;
            line(kind === '+' ? 'add' : kind === '-' ? 'del' : '', `${kind} ${text}`);
        });
        return pre;
    }


    /* ---------- a path the tool printed, opened here ---------- */
    /* THE PAGE reads its own screen for this, never the server: a path under
       /work/ or /resources/<folder>/ that is on the screen can be clicked or
       tapped, and opens in Files. Only those two places exist here; anything
       else on the machine's disk is said to be out of reach. */
    const PATH_ONLY = /^\/(?:work|resources\/[a-z][a-z0-9-]{0,31})(?:\/[A-Za-z0-9._@+%~-]+)+$/;
    const PATH = /\/(?:work|resources\/[a-z][a-z0-9-]{0,31})(?:\/[A-Za-z0-9._@+%~-]+)+/g;
    /* FROM THE CHAT (02-11): a folder named in a message is listed, as in Assets -- not an empty preview. */
    async function openFromChat(tab, inner) {
        const clean = String(inner).replace(/\/+$/, '');
        const asFolder = await fetch(`${API}/files?${new URLSearchParams({ c: current, r: tab, p: clean })}`).catch(() => null);
        if (asFolder?.ok) {
            if (!DEVICE) { showInAssets(tab, clean); return; }
            filesOf = tab; filesAt = clean; await paintFiles(); showFiles(); return;
        }
        await preview(tab, clean, clean.split('/').pop(), 0);
    }
    async function openPath(text) {
        /* A finger on the terminal also calls the on-screen keyboard: it is
           sent away, the file is what was asked for. */
        terminal.blur(); document.activeElement?.blur?.();
        const inResources = /^\/resources\/([^/]+)\/(.*)$/.exec(text);
        const tab = inResources ? inResources[1] : 'work';
        const inner = inResources ? inResources[2] : text.slice('/work/'.length);
        const reachable = () => {
            const here = conversations.find((x) => x.name === current);
            return inResources ? (here?.resources ?? []).some((r) => r.name === tab) : here?.work === 'kept';
        };
        /* What this page knows may be a few seconds old (a folder attached
           from another screen): it asks again before saying no. */
        if (!reachable()) await refresh();
        const name = text.split('/').pop();
        if (!reachable() && !inResources) {
            /* On the disk of the machine, not kept here: it is fetched from
               the machine for this once, and shown all the same. */
            notice.hidden = true;
            await preview('', '', name, 0, `${API}/files/machine?${new URLSearchParams({ c: current, p: text })}`);
            return;
        }
        const back = () => { notice.hidden = true; focusTerminal(); };
        if (!reachable()) { show(`"${tab}" is not a folder attached to this conversation.`, 'Back to the terminal', back); return; }
        /* A folder is listed in Files; a file is shown in its window, over the terminal. */
        const asFolder = await fetch(`${API}/files?${new URLSearchParams({ c: current, r: tab, p: inner })}`);
        if (asFolder.ok) {
            notice.hidden = true;
            if (!DEVICE) { showInAssets(tab, inner); return; }
            filesOf = tab; filesAt = inner;
            await paintFiles();
            showFiles();
            return;
        }
        const parent = inner.split('/').slice(0, -1).join('/');
        const listed = await (await fetch(`${API}/files?${new URLSearchParams({ c: current, r: tab, p: parent })}`)).json().catch(() => ({}));
        const entry = (listed.entries ?? []).find((e) => e.name === name && !e.folder);
        if (!entry) { show(`"${name}" is not there (any more).`, 'Back to the terminal', back); return; }
        notice.hidden = true;
        await preview(tab, inner, name, entry.size);
    }
    /* WEB ADDRESSES WRITTEN AS PLAIN TEXT, even when the screen cut them over
       several rows: a sign-in address is long. The rows that continue one
       another are read as one line, and the link covers each of its rows. */
    const URL_IN_TEXT = /https?:\/\/[^\s"'<>()]+/g;
    terminal.registerLinkProvider({
        provideLinks(y, callback) {
            const buffer = terminal.buffer.active;
            let first = y - 1;
            while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
            let last = y - 1;
            while (buffer.getLine(last + 1)?.isWrapped) last++;
            const width = terminal.cols;
            let text = '';
            for (let row = first; row <= last; row++) text += buffer.getLine(row)?.translateToString(row === last) ?? '';
            const links = [];
            for (const m of text.matchAll(URL_IN_TEXT)) {
                const found = m[0].replace(/[.,;:]+$/, '');
                const start = m.index, end = m.index + found.length - 1;
                const startRow = first + Math.floor(start / width), endRow = first + Math.floor(end / width);
                if (y - 1 < startRow || y - 1 > endRow) continue;
                links.push({ text: found, range: { start: { x: (start % width) + 1, y: startRow + 1 }, end: { x: (end % width) + 1, y: endRow + 1 } }, activate: () => openWeb(found) });
            }
            callback(links.length ? links : undefined);
        },
    });
    terminal.registerLinkProvider({
        provideLinks(y, callback) {
            const line = terminal.buffer.active.getLine(y - 1);
            if (!line) { callback(undefined); return; }
            const text = line.translateToString(true);
            const links = [...text.matchAll(PATH)].map((m) => ({
                text: m[0].replace(/[.,;:]+$/, ''),
                range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].replace(/[.,;:]+$/, '').length, y } },
                activate: (_event, found) => { void openPath(found); },
            }));
            callback(links.length ? links : undefined);
        },
    });

    /* FILES, a sheet over the screen: on a device's page only (the owner's are in the Assets tab of a conversation). */
    function showFiles() { nav.over('files', () => { if (!$('files').classList.contains('embedded')) { $('files').hidden = true; focusTerminal(); } }); $('files').hidden = false; }
    $('files-open').addEventListener('click', async () => { await paintFiles(); showFiles(); });
    $('files-close').addEventListener('click', () => { if (!nav.dropOver('files')) { $('files').hidden = true; focusTerminal(); } });

    /* ---------- sign-in mailbox ---------- */
    /* While a conversation with a mailbox is open, the page asks every few
       seconds whether a sign-in mail has just arrived, and shows its link. The
       link is opened in a new tab; nothing here follows it. */
    const SIGNIN_EVERY_MS = 6000;
    const dismissed = new Set();
    let signinTimer;
    async function watchSignIn() {
        clearTimeout(signinTimer);
        if (DEVICE || !home || !current) { $('signin-strip').hidden = true; return; }
        const name = current;
        try {
            const r = await fetch(`${API}/conversations/${encodeURIComponent(name)}/signin`);
            const j = r.ok ? await r.json() : { configured: false, items: [] };
            if (name !== current) return;
            const item = (j.items ?? []).find((i) => !dismissed.has(i.link));
            $('signin-strip').hidden = !item;
            if (item) {
                const seconds = Math.max(0, Math.round((Date.now() - Date.parse(item.at)) / 1000));
                const ago = seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
                $('signin-text').textContent = `Sign-in link received ${ago} from ${item.from}${item.verified ? '' : ' (sender NOT verified by the mailbox)'}`;
                $('signin-open').href = item.link;
                $('signin-dismiss').onclick = () => { dismissed.add(item.link); $('signin-strip').hidden = true; };
            }
            if (j.configured) signinTimer = setTimeout(watchSignIn, SIGNIN_EVERY_MS);
        } catch { signinTimer = setTimeout(watchSignIn, SIGNIN_EVERY_MS * 3); }
    }
    async function paintSignIn() {
        const j = await (await fetch(`${API}/conversations/${encodeURIComponent(current)}/signin`)).json();
        $('signin-setup').hidden = !j.available;
        $('signin-state').textContent = j.configured ? `Watching ${j.user} on ${j.host}.${j.failure ? ` Not readable just now: ${j.failure}` : ''}` : 'No mailbox is set for this conversation.';
        $('signin-remove').hidden = !j.configured;
    }
    $('signin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        $('signin-state').textContent = 'Reading the mailbox once, to check...';
        try { await post(`${API}/conversations/${encodeURIComponent(current)}/signin`, { host: $('signin-host').value, user: $('signin-user').value, password: $('signin-password').value }); $('signin-password').value = ''; }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        await paintSignIn(); void watchSignIn();
    });
    $('signin-remove').addEventListener('click', async () => { await post(`${API}/conversations/${encodeURIComponent(current)}/signin`, { host: '' }).catch(() => {}); await paintSignIn(); void watchSignIn(); });

    /* ---------- sharing ---------- */
    /* SHARING, in one sheet with three faces:
         compose  what a device gets -- a BASKET you add to, not a grid to fill
                  in. For a new device it ends on a code; for a device already
                  paired it just saves.
         code     the code, and whether it was used.
         manage   who has what: by device, and by thing.
       Opened from a conversation (that conversation in the basket), from a
       folder (that folder, to read), or from "Devices & sharing" (who has
       what). Nothing is ever chosen for the owner but the thing they came
       from; writing is never chosen for them. */
    const KINDS = [['', 'All'], ['conversation', 'Conversations'], ['folder', 'Folders'], ['git', 'Repositories'], ['mailbox', 'Mailboxes']];
    const KIND_WORD = { conversation: 'conversation', folder: 'folder', git: 'repository', mailbox: 'mailbox', agenda: 'calendar', contacts: 'address book', acces: 'access' };
    const ago = (date) => {
        if (!date) return 'never opened';
        const minutes = Math.max(0, Math.round((Date.now() - Date.parse(date)) / 60000));
        return minutes < 1 ? 'opened just now' : minutes < 60 ? `opened ${minutes} min ago` : minutes < 1440 ? `opened ${Math.round(minutes / 60)} h ago` : `opened ${Math.round(minutes / 1440)} d ago`;
    };
    let sharedDevices = [];          /* every device with what it was given, as last read */
    let basket = new Map();          /* asset -> rights */
    let shareTarget = '';            /* '' : a new device; otherwise the device being changed */
    let shareKind = ''; let catalog = []; let codeTimers = [];
    const readDevices = async () => { sharedDevices = DEVICE ? [] : await (await fetch(`${API}/devices`)).json().catch(() => []); return sharedDevices; };
    const devicesWith = (asset) => sharedDevices.filter((d) => d.grants.some((g) => g.asset === asset));
    const face = (which) => {
        for (const id of ['share-compose', 'share-code', 'share-manage']) $(id).hidden = id !== `share-${which}`;
        for (const timer of codeTimers) clearInterval(timer); codeTimers = [];
        /* Choosing what a device gets, or its code: a step of its own, with its way back. */
        $('sharing-top').hidden = which === 'manage';
    };

    /* A two-way control: Read | Write. `onChange(rights)`. */
    function levelControl(rights, onChange, label) {
        const group = document.createElement('div'); group.className = 'levels'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
        for (const [value, text] of [['r', 'Read'], ['rw', 'Write']]) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.rights = value;
            b.setAttribute('aria-pressed', String(value === rights));
            b.addEventListener('click', () => { if (value !== rights) onChange(value); });
            group.append(b);
        }
        return group;
    }
    const fixedRight = (type) => { const s = document.createElement('span'); s.className = 'hint'; s.textContent = type === 'conversation' ? 'Use - the whole terminal' : 'Read only'; return s; };
    /* A CONVERSATION IS GIVEN IN TWO PARTS, ticked one by one: its terminal
       ("x") and its chat ("rw": read, and write there). At least one: the
       last one ticked cannot be unticked (taking it all back is "Take back").
       The server holds the device to it (see server/door.mjs). */
    const talksHere = (name) => Boolean(conversations.find((c) => c.name === name)?.talk);
    /* What is proposed when a conversation is added: its chat where it talks through the app, else its terminal. */
    const partsFor = (name) => (talksHere(name) ? 'rw' : 'x');
    function partsControl(rights, onChange, name) {
        const group = document.createElement('div'); group.className = 'parts'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', `What of ${name} it gets`);
        const has = { terminal: rights.includes('x'), chat: rights.includes('r') };
        const boxes = {};
        for (const [part, text] of [['terminal', 'Terminal'], ['chat', 'Chat']]) {
            const label = document.createElement('label'); label.className = 'check'; label.dataset.part = part;
            const box = document.createElement('input'); box.type = 'checkbox'; box.checked = has[part];
            box.addEventListener('change', () => {
                const next = { ...has, [part]: box.checked };
                /* The last one ticked stays ticked, and says why. */
                if (!next.terminal && !next.chat) { box.checked = true; need.hidden = false; return; }
                const chat = next.chat ? (has.chat ? rights.replace('x', '') : 'rw') : '';
                onChange(`${chat}${next.terminal ? 'x' : ''}`);
            });
            boxes[part] = box;
            label.append(box, ` ${text}`); group.append(label);
        }
        /* The one left ticked cannot be unticked: marked so, and said when tried. */
        for (const [part, other] of [['terminal', 'chat'], ['chat', 'terminal']]) if (has[part] && !has[other]) boxes[part].setAttribute('aria-disabled', 'true');
        const need = document.createElement('small'); need.className = 'hint parts-need'; need.hidden = true; need.textContent = 'At least one. To give nothing, take it back.';
        group.append(need);
        /* Its chat, given while it is off: said, so that nobody wonders why the device shows nothing. */
        if (has.chat && !talksHere(name)) {
            const off = document.createElement('small'); off.className = 'hint parts-off'; off.textContent = 'Its chat is off: the device waits until you turn it on (General).'; off.title = 'Given, and waiting: the device sees its chat once you turn it on, in This conversation, then General.';
            group.append(off);
        }
        return group;
    }
    /* The right control of a thing given: a conversation in parts, a folder or a repository to read or write. */
    const rightControl = (type, name, rights, onChange, label) => (type === 'conversation' ? partsControl(rights, onChange, name)
        : type === 'folder' || type === 'git' ? levelControl(rights, onChange, label) : fixedRight(type));

    async function loadCatalog() {
        const things = await (await fetch(`${API}/resources`)).json().catch(() => []);
        const attached = new Set((conversations.find((x) => x.name === current)?.resources ?? []).map((r) => r.name));
        catalog = [
            ...conversations.filter((c) => c.phase === 'ready').map((c) => ({ asset: `conversation:${c.name}`, type: 'conversation', name: c.name, near: c.name === current })),
            ...things.map((r) => { const type = r.type === 'mailbox' || r.type === 'git' ? r.type : 'folder'; return { asset: `${type}:${r.name}`, type, name: r.name, near: attached.has(r.name) }; }),
        ];
    }
    function sayChoice() {
        const who = shareTarget ? (sharedDevices.find((d) => d.id === shareTarget)?.label ?? 'This device') : ($('sharing-label').value.trim() || 'The new device');
        const talks = [...basket].filter(([a]) => a.startsWith('conversation:'));
        const whole = talks.filter(([, r]) => r.includes('x')).map(([a]) => a.split(':')[1]);
        const chats = talks.filter(([, r]) => r.includes('r')).map(([a]) => a.split(':')[1]);
        const rest = [...basket].filter(([a]) => !a.startsWith('conversation:')).map(([a, r]) => `${r === 'rw' ? 'change' : 'read'} ${a.split(':')[1]}`);
        const parts = [whole.length ? `use ${whole.join(', ')} - the whole terminal, as root in its machine, with the files of that conversation` : '',
            chats.length ? `write in the chat of ${chats.join(', ')}${whole.length ? '' : ', and see its files'}` : '', rest.join(', ')].filter(Boolean);
        $('sharing-summary').textContent = basket.size === 0 ? 'Nothing is chosen yet.' : `${who} will be able to ${parts.join('; and ')}.`;
        const named = shareTarget !== '' || $('sharing-label').value.trim() !== '';
        $('sharing-new').disabled = basket.size === 0 || !named;
        $('sharing-new').textContent = shareTarget ? 'Save changes' : `Show a code${$('sharing-label').value.trim() ? ` for ${$('sharing-label').value.trim()}` : ''}`;
    }
    function paintCompose() {
        /* Who: a new device, or one that is already paired. */
        const who = $('share-who'); who.replaceChildren();
        const chip = (id, text) => {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(shareTarget === id));
            b.addEventListener('click', () => {
                shareTarget = id;
                if (id) basket = new Map(sharedDevices.find((d) => d.id === id).grants.map((g) => [g.asset, g.rights]));
                paintCompose();
            });
            who.append(b);
        };
        chip('', '+ New device');
        for (const d of sharedDevices) chip(d.id, d.label);
        $('share-name-row').hidden = shareTarget !== '';
        const suggest = $('share-suggest'); suggest.replaceChildren();
        for (const text of ['My phone', 'My tablet', "Dad's tablet"]) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
            b.addEventListener('click', () => { $('sharing-label').value = text; sayChoice(); });
            suggest.append(b);
        }
        /* The basket: only what is given carries a control. */
        const box = $('share-basket'); box.replaceChildren();
        for (const [asset, rights] of basket) {
            const [type, name] = asset.split(':');
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.asset = asset;
            const label = document.createElement('b'); label.textContent = name;
            const kind = document.createElement('small'); kind.className = 'hint'; kind.textContent = ` ${KIND_WORD[type] ?? type}`; label.append(kind);
            const right = rightControl(type, name, rights, (value) => { basket.set(asset, value); paintCompose(); }, `What it may do with ${name}`);
            const out = document.createElement('button'); out.type = 'button'; out.textContent = 'Remove'; out.setAttribute('aria-label', `Remove ${name} from what it will get`);
            out.addEventListener('click', () => { basket.delete(asset); paintCompose(); });
            row.append(label, right, out); box.append(row);
        }
        $('share-basket-title').textContent = `It will get (${basket.size})`;
        $('share-basket-empty').hidden = basket.size > 0;
        /* What can be added: near things first, then by kind and name. */
        const filters = $('share-filters'); filters.replaceChildren();
        for (const [kind, text] of KINDS) {
            if (kind && !catalog.some((c) => c.type === kind)) continue;
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-pressed', String(shareKind === kind));
            b.addEventListener('click', () => { shareKind = kind; paintCompose(); });
            filters.append(b);
        }
        $('share-search').hidden = catalog.length <= 8;
        const wanted = $('share-search').hidden ? '' : $('share-search').value.trim().toLowerCase();
        const add = $('share-add'); add.replaceChildren();
        const order = (c) => `${c.near ? 0 : 1}${KINDS.findIndex(([k]) => k === c.type)}${c.name}`;
        for (const c of [...catalog].sort((a, b2) => order(a).localeCompare(order(b2)))) {
            if ((shareKind && c.type !== shareKind) || (wanted && !c.name.includes(wanted))) continue;
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.asset = c.asset;
            const label = document.createElement('b'); label.textContent = c.name;
            const kind = document.createElement('small'); kind.className = 'hint'; kind.textContent = ` ${KIND_WORD[c.type]}${c.near && c.type !== 'conversation' ? ', attached here' : ''}`; label.append(kind);
            const plus = document.createElement('button'); plus.type = 'button';
            if (basket.has(c.asset)) { plus.textContent = 'Added'; plus.disabled = true; }
            else {
                plus.textContent = '+ Add'; plus.setAttribute('aria-label', `Add ${c.name}`);
                /* A conversation is given whole; anything else to read -- writing is asked for, never assumed. */
                plus.addEventListener('click', () => { basket.set(c.asset, c.type === 'conversation' ? partsFor(c.name) : 'r'); paintCompose(); });
            }
            row.append(label, plus); add.append(row);
        }
        sayChoice();
    }
    /* `start`: [[asset, rights], ...] put in the basket; `target`: a paired device to change instead of a new one.
       A step of its own over where it was opened (the map, all devices, an asset of Assets); from a
       conversation, it is the place itself. Its "<" says where it goes back to, and goes there. */
    async function openCompose(start = [], target = '') {
        await Promise.all([loadCatalog(), readDevices()]);
        shareTarget = target; shareKind = '';
        basket = new Map(target ? sharedDevices.find((d) => d.id === target)?.grants.map((g) => [g.asset, g.rights]) ?? [] : []);
        for (const [asset, rights] of start) basket.set(asset, rights);
        $('sharing-label').value = ''; $('share-search').value = ''; $('sharing-error').hidden = true;
        $('sharing-title').textContent = target ? `What ${sharedDevices.find((d) => d.id === target)?.label ?? 'this device'} gets` : 'Share with a new device';
        if (!composing) {
            let back;
            if (place === 'conversations') {
                const c = conversations.find((x) => x.name === current);
                back = current ? shownName(c) || current : 'Conversations';
                accessTab = 'devices'; mapMode = 'map';
                enterPlace('access');
            } else {
                const from = place === 'assets' ? 'assets' : accessTab === 'devices' ? 'devices' : 'map';
                back = { assets: 'Assets', devices: 'All devices', map: 'Access' }[from];
                if (place !== 'access') showPlace('access');
                accessTab = 'devices';
                nav.push('compose', ({ quiet }) => {
                    composing = false; face('manage');
                    if (quiet) return;
                    if (from === 'assets') { showPlace('assets'); void paintAssets(); return; }
                    accessTab = from === 'devices' ? 'devices' : 'map'; paintTabs();
                    if (from === 'devices') void paintManage(); else void links?.open({ pin: accessFor ? `conversation:${accessFor}` : null });
                });
            }
            $('sharing-close').textContent = `‹ ${back}`;
            composing = true;
        }
        paintTabs(); paintCompose(); face('compose');
    }
    $('sharing-label').addEventListener('input', sayChoice);
    $('share-search').addEventListener('input', paintCompose);

    /* Who has what. */
    function takeBack(button, question, run) {
        const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = question;
        const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep';
        keep.addEventListener('click', () => { void repaintDevices(); });
        sure.addEventListener('click', async () => { await run().catch(() => {}); await repaintDevices(); void refresh(); });
        const ask = document.createElement('span'); ask.className = 'callout bad confirm'; ask.setAttribute('role', 'alertdialog'); ask.append(keep, sure);
        button.replaceWith(ask); sure.focus();
    }
    function grantRow(device, g) {
        const [type, name] = g.asset.split(':');
        const row = document.createElement('div'); row.className = 'given-row'; row.dataset.asset = g.asset;
        const label = document.createElement('span'); label.textContent = name;
        const kind = document.createElement('small'); kind.className = 'hint'; kind.textContent = ` ${KIND_WORD[type] ?? type}`; label.append(kind);
        const right = rightControl(type, name, g.rights, async (value) => { await post(`${API}/devices/${device.id}/give`, { asset: g.asset, rights: value }).catch(() => {}); await repaintDevices(); }, `What ${device.label} may do with ${name}`);
        const take = document.createElement('button'); take.type = 'button'; take.textContent = 'Take back';
        take.addEventListener('click', () => takeBack(take, `Take ${name} back from ${device.label}`, () => post(`${API}/devices/${device.id}/take`, { asset: g.asset })));
        row.append(label, right, take);
        return row;
    }
    let manageBy = 'device';
    const deviceShut = new Set();      /* the device cards folded on this page */
    /* After a change to a device: its list (the Devices pane) or the map, drawn again. */
    async function repaintDevices() {
        if (place === 'access' && accessTab === 'devices') { await paintManage(); return; }
        await readDevices(); await links?.changed();
    }
    /* One device's card: its name (renamed here), what it has, revoke it. On
       the map's card of the device too (`onMap`: never folded). */
    function deviceCard(device, only, onMap = false) {
        const card = document.createElement('div'); card.className = 'device card'; card.dataset.device = device.id;
        const name = document.createElement('b'); name.textContent = device.label;
        const rename = document.createElement('button'); rename.type = 'button'; rename.textContent = 'Rename';
        rename.addEventListener('click', () => {
            const field = document.createElement('input'); field.value = device.label; field.maxLength = 40; field.setAttribute('aria-label', 'Name of this device');
            const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
            const done = async () => { if (field.value.trim()) await post(`${API}/devices/${device.id}/rename`, { label: field.value.trim() }).catch(() => {}); await repaintDevices(); };
            save.addEventListener('click', () => { void done(); });
            field.addEventListener('keydown', (event) => { if (event.key === 'Enter') void done(); event.stopPropagation(); });
            name.replaceWith(field); rename.replaceWith(save); focusField(field); if (document.activeElement === field) field.select();
        });
        const seen = document.createElement('small'); seen.textContent = `${ago(device.seenAt)} · paired ${new Date(device.createdAt).toLocaleDateString()}`;
        if (!device.seenAt) seen.className = 'warn';
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Revoke device';
        revoke.addEventListener('click', () => takeBack(revoke, `Revoke ${device.label}: it loses all ${device.grants.length} thing${device.grants.length > 1 ? 's' : ''}, now`, () => post(`${API}/devices/${device.id}/revoke`)));
        /* A card that folds, as the chapters of a conversation do: open unless folded on purpose. */
        const shut = !onMap && deviceShut.has(device.id);
        const fold = document.createElement('button'); fold.type = 'button'; fold.className = 'card-fold'; fold.textContent = shut ? 'Expand' : 'Collapse';
        fold.setAttribute('aria-expanded', String(!shut)); fold.setAttribute('aria-label', `${shut ? 'Expand' : 'Collapse'} ${device.label}`);
        fold.addEventListener('click', () => { if (shut) deviceShut.delete(device.id); else deviceShut.add(device.id); void repaintDevices(); });
        const count = document.createElement('small'); count.className = 'device-count'; count.textContent = `${device.grants.length} thing${device.grants.length === 1 ? '' : 's'}`;
        const sub = document.createElement('span'); sub.className = 'device-sub'; sub.append(count, ' · ', seen);
        const head = document.createElement('div'); head.className = 'device-head'; head.append(name, sub, fold);
        const given = document.createElement('div'); given.className = 'given';
        const mine = only ? device.grants.filter((g) => g.asset === only) : device.grants;
        for (const g of mine) given.append(grantRow(device, g));
        /* Several chats given while off: said once for the card, not under each. */
        const waiting = [...given.querySelectorAll('.parts-off')];
        if (waiting.length > 1) {
            for (const w of waiting) w.remove();
            const once = document.createElement('p'); once.className = 'hint parts-off'; once.title = waiting[0].title;
            once.textContent = `${waiting.length} chats are off: the device waits until you turn each on (the conversation's General).`;
            given.prepend(once);
        }
        if (only && mine.length === 0) {
            const row = document.createElement('div'); row.className = 'given-row'; row.dataset.asset = only;
            const label = document.createElement('span'); label.textContent = accessFor;
            const none = document.createElement('small'); none.className = 'hint'; none.textContent = ' not shared'; label.append(none);
            const give = document.createElement('button'); give.type = 'button'; give.className = 'primary'; give.textContent = `Give ${accessFor}`;
            give.addEventListener('click', async () => { give.disabled = true; await post(`${API}/devices/${device.id}/give`, { asset: only, rights: partsFor(accessFor) }).catch(() => {}); await repaintDevices(); void refresh(); });
            row.append(label, give); given.append(row);
        }
        /* What the filter leaves out is named, never only counted. */
        if (only && device.grants.length > mine.length) { const rest = document.createElement('p'); rest.className = 'hint'; rest.textContent = `It also has: ${device.grants.filter((g) => g.asset !== only).map((g) => { const [type, what] = g.asset.split(':'); return `${what} (${KIND_WORD[type] ?? type})`; }).join(', ')}.`; given.append(rest); }
        const more = document.createElement('button'); more.type = 'button'; more.textContent = '+ Give more';
        more.addEventListener('click', () => { void openCompose([], device.id); });
        const acts = document.createElement('div'); acts.className = 'action-row device-acts'; acts.append(more, rename, revoke);
        const body = document.createElement('div'); body.className = 'card-body'; body.hidden = shut; body.append(given, acts);
        card.append(head, body);
        return card;
    }
    /* ---- voice boxes (boxes.mjs): pairing codes, the flash from this browser, the list ---- */
    /* THE WAKE WORD THAT LEARNS (wakelearn.mjs): normal, or each wake clip kept with its label to train a better one. */
    function boxWake(b) {
        const part = el('div', 'box-wake');
        const choice = el('div', 'levels'); choice.setAttribute('role', 'group'); choice.setAttribute('aria-label', uiSaid('box-wake', 'Wake word'));
        const modes = [['normal', uiSaid('box-wake-normal', 'Normal')], ['learn', uiSaid('box-wake-learn', 'Learns from home')]].map(([mode, word]) => { const x = el('button', '', word); x.type = 'button'; x.dataset.mode = mode; choice.append(x); return x; });
        const lines = el('div', 'box-wake-lines');
        const row = el('div', 'action-row box-wake-row'); row.append(el('span', '', uiSaid('box-wake', 'Wake word')), choice);
        part.append(row, lines);
        const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        const paint = (w) => {
            for (const x of modes) x.setAttribute('aria-pressed', String(x.dataset.mode === w.mode));
            lines.replaceChildren();
            if (w.mode !== 'learn' && !w.kept) return;
            lines.append(el('small', 'hint', uiSaid('box-wake-kept', '{kept} kept \u00b7 {real} real \u00b7 {false} false \u00b7 {near} near', { kept: w.kept, real: w.real, false: w.false, near: w.near ?? 0 })));
            lines.append(el('small', 'hint', w.model
                ? uiSaid('box-wake-rate-model', 'False wakes: {before} a day \u2192 {after} a day since the model of {date}', { before: w.model.falsePerDayBefore, after: w.model.falsePerDayAfter, date: day(w.model.installedAt) })
                : uiSaid('box-wake-rate', 'False wakes: {n} a day', { n: w.falsePerDay })));
            const cut = (v) => Number(v).toFixed(2);
            lines.append(el('small', 'hint', uiSaid('box-wake-missed', 'Missed calls: {n} a day \u00b7 threshold {cutoff}', { n: w.missedPerDay ?? 0, cutoff: cut(w.cutoff ?? 0.94) })));
            const t = w.tuning;
            if (t) lines.append(el('small', 'hint', t.better
                ? (t.state === 'applied' ? uiSaid('box-wake-tuned', 'Tuned {date}: {from} \u2192 {to}', { date: day(t.appliedAt ?? t.at), from: cut(t.from), to: cut(t.to) })
                    : t.state === 'refused' ? uiSaid('box-wake-tune-refused', 'Threshold {to} refused by the box', { to: cut(t.to) })
                        : uiSaid('box-wake-tune-sent', 'Threshold {from} \u2192 {to}: waiting for the box', { from: cut(t.from), to: cut(t.to) }))
                : t.reason === 'not-enough' ? uiSaid('box-wake-tune-few', 'Tuning: not enough clips yet')
                    : uiSaid('box-wake-tune-kept', 'Tuned {date}: threshold {from} kept', { date: day(t.at), from: cut(t.from) })));
            lines.append(el('small', 'hint', uiSaid('box-wake-private', 'Only the wake word\u2019s 1.6 s, on this server: nothing is sent elsewhere.')));
            const acts = el('div', 'action-row');
            if (w.mode === 'learn') {
                const now = el('button', '', uiSaid('box-wake-improve', 'Improve now')); now.type = 'button';
                now.addEventListener('click', async () => { now.disabled = true; try { await post(`${API}/boxes/${b.id}/wake-improve`, {}); const fresh = await getJson(`/boxes/${b.id}/wake`, null); if (fresh) paint(fresh); else now.disabled = false; } catch (error) { now.textContent = error.message; now.disabled = false; } });
                acts.append(now);
            }
            if (w.kept) {
                const erase = el('button', '', uiSaid('box-wake-erase', 'Erase all\u2026')); erase.type = 'button';
                const sure = el('span', 'box-wake-sure'); sure.hidden = true;
                const yes = el('button', 'danger', uiSaid('box-wake-erase-yes', 'Yes, erase')); yes.type = 'button';
                sure.append(el('span', '', uiSaid('box-wake-erase-ask', 'Erase the {n} clips?', { n: w.kept })), ' ', yes);
                erase.addEventListener('click', () => { sure.hidden = !sure.hidden; });
                yes.addEventListener('click', async () => { yes.disabled = true; try { paint(await post(`${API}/boxes/${b.id}/wake-erase`, {})); } catch (error) { yes.textContent = error.message; yes.disabled = false; } });
                acts.append(erase, sure);
            }
            if (acts.childElementCount) lines.append(acts);
        };
        for (const x of modes) x.addEventListener('click', async () => {
            try { paint(await post(`${API}/boxes/${b.id}/wake-mode`, { mode: x.dataset.mode })); } catch (error) { lines.replaceChildren(el('small', 'warn', error.message)); }
        });
        paint({ mode: b.wake ?? 'normal', kept: 0 });
        void getJson(`/boxes/${b.id}/wake`, null).then((w) => { if (w) paint(w); });
        return part;
    }
    async function paintBoxes() {
        const list = await getJson('/boxes', []); await loadRooms();
        const rows = $('box-list'); rows.replaceChildren();
        const places = el('datalist'); places.id = 'box-places';
        for (const p of [...new Set(list.map((b) => b.place).filter(Boolean))]) { const o = el('option'); o.value = p; places.append(o); }
        rows.append(places);
        if (!list.length) rows.append(el('p', 'hint', 'No voice box yet.'));
        for (const b of list) {
            const card = el('div', 'device card box-card'); card.dataset.box = b.id;
            const head = el('div', 'device-head');
            const conv = conversations.find((c) => c.name === b.conversation);
            head.append(el('b', '', b.place ? `${b.name} \u00b7 ${b.place}` : b.name), el('small', b.online ? '' : 'warn', `${b.online ? 'online' : 'offline'} · ${conv ? shownName(conv) : String(b.conversation ?? '').startsWith('room:') ? `room ${rooms.find((r) => `room:${r.id}` === b.conversation)?.name ?? '?'}` : b.conversation}${b.firmware ? ` · firmware ${b.firmware}` : ''}${b.muted ? ' · muted' : ''}`));
            const rename = el('button', '', 'Rename'); rename.type = 'button';
            rename.addEventListener('click', () => {
                const field = el('input'); field.value = b.name; field.maxLength = 40; field.setAttribute('aria-label', 'Name of this voice box');
                const save = el('button', 'primary', 'Save'); save.type = 'button';
                const done = async () => { if (field.value.trim()) await post(`${API}/boxes/${b.id}/rename`, { name: field.value.trim() }).catch(() => {}); await paintBoxes(); };
                save.addEventListener('click', () => { void done(); });
                field.addEventListener('keydown', (event) => { if (event.key === 'Enter') void done(); event.stopPropagation(); });
                rename.replaceWith(save); head.firstChild.replaceWith(field); focusField(field);
            });
            const remove = el('button', '', 'Remove'); remove.type = 'button';
            remove.addEventListener('click', () => takeBack(remove, `Remove ${b.name}: its key stops working now, and it goes back to its setup`, () => post(`${API}/boxes/${b.id}/revoke`)));
            /* Its conversation: where what it hears is said, and whose answers it speaks. Changed here at any time. */
            const where = el('select'); where.setAttribute('aria-label', `Conversation of ${b.name}`);
            for (const c of conversations) { const o = el('option', '', shownName(c)); o.value = c.name; where.append(o); }
            /* Or a room (#281): it speaks there, and says what is sent to it there. */
            if (rooms.length) { const g = document.createElement('optgroup'); g.label = 'Rooms'; for (const r of rooms) { const o = el('option', '', r.name); o.value = `room:${r.id}`; g.append(o); } where.append(g); }
            where.value = b.conversation;
            where.addEventListener('change', async () => { await post(`${API}/boxes/${b.id}/move`, { conversation: where.value }).catch(() => {}); await paintBoxes(); });
            const whereRow = el('label', 'box-where'); whereRow.append('Speaks in ', where);
            /* Where it is (a home): typed once, then offered for the next ones. */
            const place = el('input'); place.value = b.place ?? ''; place.maxLength = 40; place.placeholder = 'Place (a home)'; place.setAttribute('list', 'box-places'); place.setAttribute('aria-label', `Place of ${b.name}`);
            place.addEventListener('change', async () => { await post(`${API}/boxes/${b.id}/place`, { place: place.value.trim() }).catch(() => {}); await paintBoxes(); });
            /* A box paired before it knew its time zone takes this page's: its lights follow the hours here. */
            if (!b.zone || !b.lang) void post(`${API}/boxes/${b.id}/zone`, { zone: b.zone || Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language }).catch(() => {});
            /* Louder, softer: kept here, given to the box now or when it comes back. */
            const vol = el('input'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '5'; vol.value = String(b.volume ?? 80); vol.setAttribute('aria-label', `Volume of ${b.name}`);
            const volSaid = el('small', 'hint', `${vol.value} %`);
            vol.addEventListener('input', () => { volSaid.textContent = `${vol.value} %`; });
            vol.addEventListener('change', async () => { await post(`${API}/boxes/${b.id}/volume`, { level: Number(vol.value) }).catch((error) => { volSaid.textContent = error.message; }); });
            const volRow = el('label', 'box-volume'); volRow.append('Volume ', vol, volSaid);
            const acts = el('div', 'action-row'); acts.append(whereRow, place, volRow, rename, remove);
            card.append(head, acts);
            card.append(boxWake(b));
            /* TESTED FROM HERE (01-11): its sound -- it says a test sentence -- and its microphone -- it listens
               once, and what it heard shows here, not in the conversation. */
            if (b.online) {
                const test = el('div', 'action-row box-test');
                const sound = el('button', '', 'Test the sound'); sound.type = 'button';
                const mic = el('button', '', 'Test the microphone'); mic.type = 'button';
                const heard = el('small', 'hint box-test-heard', '');
                sound.addEventListener('click', async () => {
                    sound.disabled = true; heard.textContent = 'It says a test sentence…';
                    try { await post(`${API}/boxes/${b.id}/test-sound`, {}); heard.textContent = 'Sent: you should hear « Test du son ».'; }
                    catch (error) { heard.textContent = `Not played: ${error.message}`; }
                    sound.disabled = false;
                });
                mic.addEventListener('click', async () => {
                    mic.disabled = true; heard.textContent = 'It asks you to speak, then listens…';
                    try { await post(`${API}/boxes/${b.id}/test-mic`, {}); }
                    catch (error) { heard.textContent = `Not started: ${error.message}`; mic.disabled = false; return; }
                    for (let i = 0; i < 50; i++) {
                        await new Promise((r) => setTimeout(r, 1000));
                        const r = await post(`${API}/boxes/${b.id}/test-result`, {}).catch(() => null);
                        if (!r || r.state === 'listening') continue;
                        heard.textContent = r.state === 'heard' ? `Heard: « ${r.text} »` : r.state === 'failed' ? `The dictation failed: ${r.text}` : 'Nothing heard.';
                        break;
                    }
                    mic.disabled = false;
                });
                test.append(sound, mic, heard);
                card.append(test);
            }
            /* ITS WI-FI NETWORKS (01-11): the box knows several and goes to the strongest it hears; one is added
               here before it moves, from the networks it hears itself -- no phone, no button. */
            if (b.online) {
                const wifi = el('div', 'box-wifi');
                const known = el('div', 'box-wifi-known');
                const add = el('button', '', 'Add a Wi-Fi'); add.type = 'button';
                const paintKnown = async () => {
                    known.replaceChildren(el('small', 'hint', 'Its Wi-Fi networks…'));
                    const r = await post(`${API}/boxes/${b.id}/wifi-known`, {}).catch(() => null);
                    known.replaceChildren();
                    if (!r) { known.append(el('small', 'hint', 'Its networks cannot be read just now.')); return; }
                    for (const ssid of r.networks) {
                        const chip = el('span', 'box-wifi-net', ssid === r.current ? `${ssid} (now)` : ssid);
                        if (ssid !== r.current) {
                            const x = el('button', 'quiet', '×'); x.type = 'button'; x.setAttribute('aria-label', `Forget ${ssid}`);
                            x.addEventListener('click', async () => { await post(`${API}/boxes/${b.id}/wifi-forget`, { ssid }).catch(() => {}); await paintKnown(); });
                            chip.append(x);
                        }
                        known.append(chip);
                    }
                };
                add.addEventListener('click', async () => {
                    add.disabled = true; add.textContent = 'Listening for networks…';
                    const r = await post(`${API}/boxes/${b.id}/wifi-scan`, {}).catch(() => ({ networks: [] }));
                    add.disabled = false; add.textContent = 'Add a Wi-Fi';
                    const pick = el('select'); pick.setAttribute('aria-label', 'Network');
                    for (const n of r.networks ?? []) { const o = el('option', '', `${n.ssid}${n.secure ? '' : ' (open)'}`); o.value = n.ssid; pick.append(o); }
                    const pass = el('input'); pass.type = 'password'; pass.placeholder = 'Password'; pass.autocomplete = 'off'; pass.setAttribute('aria-label', 'Password of the network');
                    const join = el('button', 'primary', 'Add'); join.type = 'button';
                    const said = el('small', 'hint', '');
                    join.addEventListener('click', async () => {
                        join.disabled = true; said.textContent = 'The box tries it (up to 20 s); it comes back on its network after.';
                        try { await post(`${API}/boxes/${b.id}/wifi-join`, { ssid: pick.value, password: pass.value }); said.textContent = `Added: ${pick.value}.`; form.remove(); await paintKnown(); }
                        catch (error) { said.textContent = `Not joined: ${error.message}`; join.disabled = false; }
                    });
                    const form = el('div', 'action-row box-wifi-add'); form.append(pick, pass, join, said);
                    wifi.append(form); focusField(pass);
                });
                wifi.append(el('small', 'hint', 'Wi-Fi it knows (it goes to the strongest): '), known, add);
                card.append(wifi);
                void paintKnown();
            }
            rows.append(card);
        }
    }
    /* A NEW VOICE BOX: a kind of New asset (05-11, step 4), the same flow wherever it is asked for -- Assets, a
       conversation's Attach, "+ Voice box" here and in a room, Features. Where it speaks (preselected from where it
       was asked), plug it (a flash its conversation asked for waits here), pair it (the code, link and QR of before),
       it answers (it shows among the boxes). The box itself is paired as it always was: one pairCode() for all. */
    $('assets-forms').append($('box-add'));
    /* Where it speaks, said: a conversation's name, or "room <name>". */
    function whereName(where) {
        const w = String(where ?? '');
        if (w.startsWith('room:')) return `${uiSaid('set-na-room', 'room')} ${rooms.find((r) => `room:${r.id}` === w)?.name ?? '?'}`;
        return shownName(conversations.find((c) => c.name === w)) || w;
    }
    const speaksLine = (where) => uiSaid('set-na-speaks', 'Will speak in {name}', { name: whereName(where) });
    function stopBoxWait() { if (boxFlow?.timer) { clearTimeout(boxFlow.timer); boxFlow.timer = null; } }
    function startBoxFlow(host) {
        stopBoxWait();
        boxFlow = { host, where: host.where ?? '', step: 'where', made: null, known: null, timer: null, until: 0 };
        $('box-room').value = ''; $('box-ready').hidden = true; $('box-error').hidden = true; $('box-waiting').textContent = '';
        if (!rooms.length) void loadRooms().then(() => { if (boxFlow?.host === host && boxFlow.step === 'where') fillBoxWhere(); });
    }
    /* Which conversation it speaks in, or a room (#281): chosen on purpose, never a silent default. */
    function fillBoxWhere() {
        const pick = $('box-conversation'); pick.replaceChildren();
        const none = el('option', '', 'Choose a conversation...'); none.value = ''; pick.append(none);
        for (const c of conversations) { const o = el('option', '', shownName(c)); o.value = c.name; pick.append(o); }
        if (rooms.length) { const g = document.createElement('optgroup'); g.label = 'Rooms'; for (const r of rooms) { const o = el('option', '', r.name); o.value = `room:${r.id}`; g.append(o); } pick.append(g); }
        pick.value = [...pick.options].some((o) => o.value === boxFlow?.where) ? boxFlow.where : '';
    }
    /* The form at its step, for the box that shows it (newAssetBox). */
    function paintBoxFlow() {
        if (!boxFlow) startBoxFlow({ where: '', repaint: () => {}, close: () => {} });
        const form = $('box-add'); form.hidden = false;
        for (const part of form.querySelectorAll('.box-step')) part.hidden = part.dataset.step !== boxFlow.step;
        if (boxFlow.step === 'where') fillBoxWhere();
        if (boxFlow.step === 'plug') void paintBoxJobs();
        $('box-back').hidden = boxFlow.step === 'where';
        $('box-next').hidden = boxFlow.step === 'pair';
        return form;
    }
    /* A flash its conversation asked for (Tether, device-flash): its card, as in the thread -- started here. */
    async function paintBoxJobs() {
        const tether = await getJson('/tether', {});
        const jobs = Array.isArray(tether.jobs) ? tether.jobs : [];
        if (boxFlow?.step !== 'plug') return;
        $('box-jobs').replaceChildren(...jobs.map((j) => jobCard(j, () => { if (boxFlow?.step === 'plug') void paintBoxJobs(); })));
    }
    const boxGo = (step) => { if (!boxFlow) return; boxFlow.step = step; $('box-error').hidden = true; boxFlow.host.repaint(); };
    $('box-next').addEventListener('click', () => {
        if (!boxFlow) return;
        if (boxFlow.step === 'where' && !$('box-conversation').value) { $('box-error').textContent = 'Choose the conversation it speaks in first.'; $('box-error').hidden = false; $('box-conversation').focus(); return; }
        boxGo(BOX_STEPS[BOX_STEPS.indexOf(boxFlow.step) + 1] ?? boxFlow.step);
    });
    $('box-back').addEventListener('click', () => { if (boxFlow) { stopBoxWait(); boxGo(BOX_STEPS[Math.max(0, BOX_STEPS.indexOf(boxFlow.step) - 1)]); } });
    $('box-conversation').addEventListener('change', () => {
        if (!boxFlow) return;
        boxFlow.where = $('box-conversation').value;
        const line = $('box-add').closest('.kit-newasset')?.querySelector('.kit-na-context > span');
        if (line && boxFlow.where) line.textContent = speaksLine(boxFlow.where);
    });
    /* ONE PAIRING CODE for a voice box (boxes.mjs), whoever asks: this flow, a flash run from the thread. With
       `origin` (this page's address), the server adds the setup key, its link and QR code. */
    function pairCode({ conversation, name, origin = '' }) {
        return post(`${API}/boxes/code`, { conversation, name, ...(origin ? { origin } : {}), zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    }
    /* It answers: paired, it shows among the boxes -- read again until it does, while the code holds. */
    function waitBoxPaired() {
        stopBoxWait();
        const flow = boxFlow;
        const look = async () => {
            if (boxFlow !== flow || flow.made || $('assets-forms').contains($('box-add')) || Date.now() > flow.until) return;
            const list = await getJson('/boxes', null);
            const fresh = Array.isArray(list) && flow.known ? list.find((b) => !flow.known.has(b.id)) : null;
            if (boxFlow !== flow) return;
            if (fresh) {
                flow.made = { id: fresh.id, name: fresh.name, where: fresh.conversation };
                flow.host.repaint();
                if (!$('boxes').closest('[hidden]')) void paintBoxes();
                return;
            }
            flow.timer = setTimeout(() => { void look(); }, 3000);
        };
        flow.timer = setTimeout(() => { void look(); }, 3000);
    }
    $('box-key-copy').addEventListener('click', async () => {
        const key = $('box-key').textContent;
        try { await navigator.clipboard.writeText(key); $('box-key-copy').textContent = 'Copied'; }
        catch { const range = document.createRange(); range.selectNodeContents($('box-key')); getSelection().removeAllRanges(); getSelection().addRange(range); }
        setTimeout(() => { $('box-key-copy').textContent = 'Copy the key'; }, 2000);
    });
    $('box-code').addEventListener('click', async () => {
        if (!$('box-conversation').value) { boxGo('where'); $('box-error').textContent = 'Choose the conversation it speaks in first.'; $('box-error').hidden = false; return; }
        try {
            const before = await getJson('/boxes', null);
            const r = await pairCode({ conversation: $('box-conversation').value, name: $('box-room').value.trim(), origin: location.origin });
            $('box-code-shown').textContent = r.code; $('box-code-minutes').textContent = `valid ${r.minutes} minutes, once`;
            $('box-key').textContent = r.key ?? '';
            $('box-link').href = r.link ?? '#';
            $('box-qr').innerHTML = r.qr ?? '';
            $('box-ready').hidden = false;
            if (boxFlow && Array.isArray(before)) {
                boxFlow.known = new Set(before.map((b) => b.id)); boxFlow.until = Date.now() + Number(r.minutes || 10) * 60_000;
                $('box-waiting').textContent = uiSaid('set-na-box-waiting', 'Waiting for it to answer…');
                waitBoxPaired();
            }
        } catch (error) { $('box-code-minutes').textContent = error.message; $('box-ready').hidden = false; }
    });
    /* "+ Voice box" of Access › Boxes: the New asset box, right here, on its kind; on the conversation Access is for. */
    function paintBoxNew() {
        const holder = $('box-newasset');
        if (holder.contains($('box-add'))) $('assets-forms').append($('box-add'));
        holder.hidden = false;
        holder.replaceChildren(newAssetBox({ kind: 'box', boxHost: boxFlow.host }));
    }
    function closeBoxNew() { const holder = $('box-newasset'); if (holder.contains($('box-add'))) $('assets-forms').append($('box-add')); holder.replaceChildren(); holder.hidden = true; }
    function openBoxNew() {
        startBoxFlow({ where: accessFor && conversations.some((c) => c.name === accessFor) ? accessFor : '', repaint: paintBoxNew, close: closeBoxNew });
        paintBoxNew();
        focusFirst($('box-newasset'));
    }
    $('box-new').addEventListener('click', () => { if (!$('box-newasset').hidden) { stopBoxWait(); boxFlow = null; closeBoxNew(); } else openBoxNew(); });
    async function paintManage() {
        await readDevices();
        void paintBoxes();
        $('share-by-device').setAttribute('aria-pressed', String(manageBy === 'device')); $('share-by-thing').setAttribute('aria-pressed', String(manageBy === 'thing'));
        const rows = $('sharing-devices'); rows.replaceChildren(); rows.hidden = manageBy !== 'device';
        const things = $('share-things'); things.replaceChildren(); things.hidden = manageBy !== 'thing';
        $('sharing-none').hidden = sharedDevices.length > 0;
        /* Filtered on one conversation (opened from it): each device with what it has of that conversation, or a way to give it. */
        const only = accessFor && conversations.some((c) => c.name === accessFor) ? `conversation:${accessFor}` : '';
        $('share-by').hidden = Boolean(only);
        if (manageBy === 'device' || only) {
            rows.hidden = false; things.hidden = true;
            for (const device of [...sharedDevices].sort((a, b2) => String(b2.seenAt ?? '').localeCompare(String(a.seenAt ?? '')))) {
                rows.append(deviceCard(device, only));
            }
            return;
        }
        /* By thing: who can see this folder? What nobody has is folded away. */
        await loadCatalog();
        const alone = [];
        for (const c of catalog) {
            const holders = devicesWith(c.asset);
            if (holders.length === 0) { alone.push(c); continue; }
            const block = document.createElement('details'); block.className = 'thing'; block.dataset.asset = c.asset; block.open = true;
            const top = document.createElement('summary'); top.textContent = `${c.name} - ${KIND_WORD[c.type]} - ${holders.length} device${holders.length > 1 ? 's' : ''}`;
            block.append(top);
            for (const device of holders) {
                const row = grantRow(device, device.grants.find((g) => g.asset === c.asset));
                row.firstChild.textContent = device.label;
                block.append(row);
            }
            things.append(block);
        }
        const rest = document.createElement('details'); rest.className = 'thing';
        const top = document.createElement('summary'); top.textContent = `Not shared (${alone.length})`; rest.append(top);
        for (const c of alone) {
            const row = document.createElement('div'); row.className = 'given-row';
            const label = document.createElement('span'); label.textContent = `${c.name} - ${KIND_WORD[c.type]}`;
            const give = document.createElement('button'); give.type = 'button'; give.textContent = 'Share...';
            give.addEventListener('click', () => { void openCompose([[c.asset, c.type === 'conversation' ? partsFor(c.name) : 'r']]); });
            row.append(label, give); rest.append(row);
        }
        things.append(rest);
    }
    /* Devices are a tab of Access. */
    async function openManage() { await openAccessPage('devices'); }
    $('share-by-device').addEventListener('click', () => { manageBy = 'device'; void paintManage(); });
    $('share-by-thing').addEventListener('click', () => { manageBy = 'thing'; void paintManage(); });
    /* A NEW DEVICE: a kind of New asset (05-11, step 4) -- the share sheet, the same for every way in (the Device
       kind of the box, the map's "+", "+ New device" here and on the map). On a conversation (`of`), it is offered it. */
    function newDevice(of = '') {
        const c = String(of ?? '');
        void openCompose(c && !c.startsWith('room:') ? [[`conversation:${c}`, partsFor(c)]] : []);
    }
    /* Filtered on a conversation, a new device is offered that conversation. */
    $('share-new-device').addEventListener('click', () => newDevice(accessFor));
    /* From a conversation: that conversation, and nothing else, is in the basket. */
    $('share').addEventListener('click', () => { void openCompose([[`conversation:${current}`, partsFor(current)]]); });
    /* The Sharing chapter of a conversation: who has it, and which parts -- changed there, at once. */
    async function paintShareHere() {
        if (DEVICE) return;
        await readDevices();
        const box = $('share-here'); box.replaceChildren();
        const asset = `conversation:${current}`;
        for (const device of devicesWith(asset)) {
            const g = device.grants.find((x) => x.asset === asset);
            const row = document.createElement('div'); row.className = 'given-row'; row.dataset.device = device.id;
            const label = document.createElement('span'); label.textContent = device.label;
            const right = partsControl(g.rights, async (value) => { await post(`${API}/devices/${device.id}/give`, { asset, rights: value }).catch(() => {}); await paintShareHere(); }, current);
            const take = document.createElement('button'); take.type = 'button'; take.textContent = 'Take back';
            take.addEventListener('click', () => {
                const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Take ${current} back from ${device.label}`;
                const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep';
                keep.addEventListener('click', () => { void paintShareHere(); });
                sure.addEventListener('click', async () => { await post(`${API}/devices/${device.id}/take`, { asset }).catch(() => {}); await paintShareHere(); void refresh(); });
                const ask = document.createElement('span'); ask.className = 'callout bad confirm'; ask.setAttribute('role', 'alertdialog'); ask.append(keep, sure);
                take.replaceWith(ask); sure.focus();
            });
            row.append(label, right, take); box.append(row);
        }
        $('share-here-none').hidden = box.children.length > 0;
    }
    /* Back from choosing or from the code: where it was opened from, as Back and Escape. */
    const leaveCompose = () => { void refresh(); if (!nav.close('compose')) leavePlace(); };
    $('sharing-close').addEventListener('click', leaveCompose);

    $('sharing-new').addEventListener('click', async () => {
        $('sharing-error').hidden = true;
        try {
            if (shareTarget) {
                /* A device already paired: what changed is given or taken, and that is all. */
                const before = new Map(sharedDevices.find((d) => d.id === shareTarget).grants.map((g) => [g.asset, g.rights]));
                for (const [asset, rights] of basket) if (before.get(asset) !== rights) await post(`${API}/devices/${shareTarget}/give`, { asset, rights });
                for (const asset of before.keys()) if (!basket.has(asset)) await post(`${API}/devices/${shareTarget}/take`, { asset });
                /* Back where it was opened, on that device's card when that is the map. */
                const device = shareTarget;
                await readDevices(); leaveCompose();
                if (place === 'access' && accessTab === 'map') void links?.open({ pin: `device:${device}` });
                return;
            }
            const label = $('sharing-label').value.trim();
            const known = new Set((await readDevices()).map((d) => d.id));
            const shared = await post(`${API}/shares`, { grants: [...basket].map(([asset, rights]) => ({ asset, rights })), label });
            face('code');
            $('sharing-qr').src = `data:image/svg+xml;base64,${btoa(shared.qr)}`;
            $('sharing-link').textContent = shared.url;
            $('sharing-copy').textContent = 'Copy the link';
            $('sharing-copy').onclick = async () => { try { await navigator.clipboard.writeText(shared.url); $('sharing-copy').textContent = 'Copied'; } catch { $('sharing-copy').textContent = 'Select the link above and copy it'; } };
            $('share-done').hidden = true; $('share-cancel').hidden = false;
            $('share-waiting').textContent = `Waiting for ${label}...`;
            /* How long it works, counted down; and whether it was used, looked for. */
            const until = Date.now() + shared.minutes * 60_000;
            const count = () => {
                const left = Math.max(0, Math.round((until - Date.now()) / 1000));
                $('sharing-status').textContent = left > 0 ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'This code is too old now. Make another.';
            };
            count();
            const arrived = async () => {
                const now = (await readDevices()).find((d) => !known.has(d.id));
                if (!now) return;
                for (const timer of codeTimers) clearInterval(timer); codeTimers = [];
                $('share-waiting').textContent = `${now.label} is connected.`; $('sharing-status').textContent = '';
                $('share-done').hidden = false; $('share-cancel').hidden = true;
            };
            codeTimers = [setInterval(count, 1000), setInterval(() => { void arrived(); }, 2500)];
            $('share-cancel').onclick = async () => { await post(`${API}/shares/cancel`, { code: new URL(shared.url).hash.slice(1) }).catch(() => {}); await openCompose([...basket]); $('sharing-label').value = label; sayChoice(); };
        } catch (error) { $('sharing-error').textContent = error.message; $('sharing-error').hidden = false; }
    });
    /* Done: the device is paired; back where it was opened. */
    $('share-done').addEventListener('click', leaveCompose);

    /* ---------- resting and archiving ---------- */
    async function sleepMachine() {
        const name = current;
        leavePanel();
        disconnect();
        say('going to sleep', 'connecting');
        show('Going to sleep...'); mascot('asleep');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/sleep`); await refresh(); enter(); }
        catch (error) { say('awake', 'ended'); show(error.message, 'Back to the terminal', connect); }
    }
    $('sleep').addEventListener('click', () => void sleepMachine());
    /* The quick actions at the top of the panel do the same as the Machine chapter's. */
    $('hand-terminal').addEventListener('click', () => { leavePanel(); seeTerminal(); });
    $('quick-wake').addEventListener('click', () => { leavePanel(); seeTerminal(); });
    async function rebuild() {
        const name = current;
        disconnect();
        say('building', 'connecting'); show('Building its machine again...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/rebuild`); await refresh(); enter(); }
        catch (error) { show(error.message, 'Close', enter); }
    }
    async function archive(confirmed) {
        const name = current;
        leavePanel();
        if (!confirmed) {
            const resume = socket ? () => { notice.hidden = true; focusTerminal(); } : enter;
            show(`Archive "${name}"? Its machine is deleted, with everything on its disk. Attached folders are kept; its work folder is put aside on the server.`, 'Archive', () => archive(true), resume);
            return;
        }
        disconnect();
        say('archiving', 'connecting'); show('Archiving: deleting its machine...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/archive`); await refresh(); select(''); }
        catch (error) { show(error.message, 'Close', enter); }
    }
    $('archive').addEventListener('click', () => { void archive(false); });
    /* RESET or DELETE FOR GOOD (01-11): whatever state its machine is in -- one that never started too. Both
       erase, so its name is typed first; nothing is done until it matches. */
    let sureAction = null;
    function askSure(what, button, action) {
        const c = conversations.find((x) => x.name === current); if (!c) return;
        sureAction = { name: c.name, shown: shownName(c), action };
        $('sure-what').textContent = `${what} Type « ${shownName(c)} » to confirm.`;
        $('sure-go').textContent = button; $('sure-go').disabled = true; $('sure-name').value = '';
        $('sure-form').hidden = false; focusField($('sure-name'));
    }
    const sureClose = () => { sureAction = null; $('sure-form').hidden = true; };
    $('sure-name').addEventListener('input', () => { $('sure-go').disabled = !sureAction || $('sure-name').value.trim() !== sureAction.shown; });
    $('sure-cancel').addEventListener('click', sureClose);
    $('sure-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!sureAction || $('sure-name').value.trim() !== sureAction.shown) return;
        const { name, action } = sureAction; sureClose(); void action(name);
    });
    $('reset-machine').addEventListener('click', () => askSure('Reset: its machine and its files are erased, and a new empty machine is built. Its settings and attached assets stay.', 'Reset', async (name) => {
        leavePanel(); disconnect();
        say('building', 'connecting'); show('Resetting: a new machine is being built...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/rebuild`, { reset: true, confirm: name }); await refresh(); enter(); }
        catch (error) { show(error.message, 'Close', enter); }
    }));
    $('erase-conversation').addEventListener('click', () => askSure('Delete for good: its machine and its files are erased; nothing is put aside. Attached assets stay where they are.', 'Delete for good', async (name) => {
        leavePanel(); disconnect();
        say('archiving', 'connecting'); show('Deleting for good...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/erase`, { confirm: name }); await refresh(); select(''); }
        catch (error) { show(error.message, 'Close', enter); }
    }));
    /* "<" of a conversation (a phone): the list, as Back does. */
    $('back').addEventListener('click', () => { if (!nav.close('room')) select(''); });

    /* A device whose door is closed: say why, and leave nothing on screen
       that can no longer work (a tester found Files still offered after the
       device had been removed). */
    function shut(message) {
        disconnect(); clearTimeout(pollTimer);
        say('not connected', 'ended');
        for (const id of ['keys', 'shortcuts', 'files-open', 'files', 'tool', 'copy-open', 'copy']) $(id).hidden = true;
        $('chips').replaceChildren();
        show(message);
    }
    /* A new code opened in the same tab is a new pairing: the page starts over. */
    if (DEVICE) window.addEventListener('hashchange', () => { if (location.hash.length > 1) location.reload(); });

    /* ---------- start ---------- */
    /* ---------- install as an app ---------- */
    /* The page can be installed; it now SAYS so, with a button, instead of
       leaving it to a browser menu nobody opens. Where the browser lets a
       page ask (Chrome, Edge, Android), the button asks. On an iPhone or an
       iPad no page can ask: the button explains the two taps it takes.
       Already running as an app: there is nothing to offer. */
    const asApp = matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
    const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let installEvent = null;
    let installOffered = false;
    /* 06-11: offered where it is seen -- a button at the top of the list too, not only in Settings › This device. */
    const offerInstall = () => { installOffered = true; $('install').hidden = false; $('install-row').hidden = false; if (!DEVICE) $('install-top').hidden = false; };
    /* Chrome reads the manifest again when its address changes, and may then
       offer the install anew: that offer, if it comes soon, is the one used. */
    let freshOffer = null;
    addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault(); installEvent = event; offerInstall();
        if (freshOffer) { const take = freshOffer; freshOffer = null; take(event); }
    });
    addEventListener('appinstalled', () => { installEvent = null; installOffered = false; $('install').hidden = true; $('install-row').hidden = true; $('install-name-form').hidden = true; $('install-top').hidden = true; });
    /* The top button is the same gesture: Settings at This device, its Install pressed. */
    $('install-top').addEventListener('click', () => { $('nav-settings').click(); openChapter('s-screen'); $('install-row').scrollIntoView({ block: 'center' }); $('install').click(); });
    if (apple && !asApp) offerInstall();
    /* FIRST A NAME FOR THIS DEVICE, then the browser's own question. */
    $('install').addEventListener('click', async () => {
        const back = () => { notice.hidden = true; focusTerminal(); };
        if (installEvent) {
            $('install-name').value = installName() || appName;
            $('install-name-form').hidden = false;
            focusField($('install-name'));
            return;
        }
        show(DEVICE
            ? 'To install it: touch the Share button of the browser (the square with an arrow), then "Add to Home Screen". IMPORTANT, on an iPhone or iPad: the installed app does not share anything with this page, so it will ask to be paired again -- ask the person who shared this conversation for a new code, and open it once the app is installed.'
            : 'To install it: touch the Share button of the browser (the square with an arrow), then "Add to Home Screen". The app will ask you to sign in once.',
        'Back', back);
    });

    $('install-name-cancel').addEventListener('click', () => { $('install-name-form').hidden = true; });
    $('install-name-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!installEvent) { $('install-name-form').hidden = true; return; }
        /* Text only, as the server takes it; anything else falls back to the name of this Clavarium. */
        const name = $('install-name').value.trim().replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').slice(0, 30).trim();
        const chosen = name && name !== appName ? name : '';
        $('install-name-form').hidden = true;
        let asked = installEvent;
        if (chosen !== installName()) {
            try { if (chosen) localStorage.setItem(INSTALL_NAME, chosen); else localStorage.removeItem(INSTALL_NAME); } catch { /* the address carries it all the same */ }
            pointManifest(chosen);
            asked = await new Promise((resolve) => { const t = setTimeout(() => { freshOffer = null; resolve(installEvent); }, 1200); freshOffer = (e) => { clearTimeout(t); resolve(e); }; });
        }
        if (!asked) return;
        installEvent = null;
        asked.prompt();
        const choice = await asked.userChoice.catch(() => ({ outcome: 'dismissed' }));
        if (choice.outcome === 'accepted') { installOffered = false; $('install').hidden = true; $('install-row').hidden = true; }
        else installEvent = asked;
    });

    /* ---------- the other conversations of this device ---------- */
    /* A device may have been given several conversations, each by a code of
       its own. One is shown at a time; the others are a tap away. */
    function offerOthers(others) {
        $('others').hidden = false;
        $('others').textContent = others.length > 0 ? `Conversations (${others.length + 1})` : 'This device';
        $('others').onclick = () => {
            const rows = $('others-rows');
            rows.replaceChildren();
            const line = (label, id, isCurrent, conversation) => {
                const row = document.createElement('div'); row.className = 'folder';
                const name = document.createElement('b'); name.textContent = isCurrent ? `${label} (shown now)` : label;
                const open = document.createElement('button'); open.type = 'button'; open.className = 'primary'; open.textContent = 'Open'; open.hidden = isCurrent;
                open.addEventListener('click', () => { void window.clavariumShowPairing(id, conversation); });
                const leave = document.createElement('button'); leave.type = 'button'; leave.textContent = 'Remove from this device';
                leave.addEventListener('click', () => {
                    leave.textContent = 'Yes, remove it'; leave.className = 'danger';
                    leave.onclick = async () => { await window.clavariumLeave(id); location.reload(); };
                });
                row.append(name, open, leave); rows.append(row);
            };
            line(current || 'Shared files', pairing, true, current || null);
            for (const o of others) line(o.name ?? 'Shared files', o.pairing, false, o.name);
            $('files').hidden = true; $('copy').hidden = true;
            $('others-sheet').hidden = false;
        };
    }
    $('others-close').addEventListener('click', () => { $('others-sheet').hidden = true; focusTerminal(); });
    /* A link pasted instead of scanned: only its code is taken, and it is
       handed to this page exactly as a scanned one would be. */
    $('others-add').addEventListener('submit', (event) => {
        event.preventDefault();
        const code = /#([A-Za-z0-9_-]{43})\s*$/.exec($('others-link').value.trim())?.[1];
        if (!code) { $('others-error').textContent = 'This is not a link to a shared conversation. It ends with "#" and a long code.'; $('others-error').hidden = false; return; }
        $('others-link').value = '';
        location.hash = code;
    });

    async function start() {
        void readAppName();
        if (DEVICE) {
            view('room');
            const fresh = location.hash.length > 1;      /* arriving with a code: a first visit */
            say(fresh ? 'pairing' : 'connecting', 'connecting');
            const door = await window.clavariumDoor();
            if (!door.ok) { shut(door.message); return; }
            pairing = door.pairing; API = `/c/api/${pairing}`; current = door.conversation ?? '';
            document.documentElement.dataset.pairing = pairing;      /* not a secret: a name, useless without the key */
            offerOthers(door.others);
            welcoming = fresh && door.conversation !== null;
            await refresh();
            if (door.conversation === null) {
                /* Given folders and no conversation: this page is their files, and nothing else. */
                for (const id of ['keys', 'shortcuts', 'copy-open', 'theme', 'files-close']) $(id).hidden = true;
                $('name').textContent = 'Shared files'; pageTitle = 'Shared files'; paintTitle();
                say('', 'ended'); $('state').hidden = true; notice.hidden = true;
                await paintFiles(); $('files').hidden = false;
                $('files-none').textContent = 'Nothing is shared with this device any more.';
                return;
            }
            void offerVoice();          /* only now is there a session to ask with */
            if (fresh && home) {
                /* The one thing a first-time visitor is told, before the dark screen. */
                const c = conversations[0];
                $('name').textContent = c?.name ?? '';
                await readTalk();
                /* Said for what it was given: its chat, its terminal, or both. */
                const how = noTerminal() && !talk.on ? 'You will talk with it here, as in a messaging app, once the person who shared it turns its chat on.'
                    : talk.on ? `You talk with it here, as in a messaging app: write below, or press Dictate and speak.${noTerminal() ? '' : ' Its terminal is one tap away.'}`
                        : 'Tap the dark screen to type, or press Dictate and speak. The buttons under it send ready-made answers.';
                show(`You are connected to "${c?.name}", an assistant that works in writing. ${how}${installOffered ? ' To keep it at hand, "Install the app" at the top puts it on this device like any other app.' : ''}`, 'Start', () => { welcoming = false; notice.hidden = true; enter(); void chatFirst(); });
                return;
            }
            enter();
            /* Where it talks through the app, the chat is what this device opens on. */
            void chatFirst();
            /* A link to a mail (?mail=mail:...): opened over it, if this device may read that mailbox (else it says so). */
            if (/^mail:/.test(new URLSearchParams(location.search).get('mail') ?? '')) void openMailRef(new URLSearchParams(location.search).get('mail'), { of: current });
            return;
        } else {
            view(current ? 'room' : 'list');
            if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
        }
        await refresh();
        if (!home) { view('room'); if (!NAME.test(current)) current = ''; }
        enter();
        /* Arriving on a conversation: the list is one Back away, as if it had been picked there. */
        const arrived = new URLSearchParams(location.search);
        if (home && current && !arrived.has('open') && !Number.isInteger(history.state?.nav)) {
            history.replaceState(null, '', location.pathname);
            nav.push('room', ({ quiet }) => { if (!quiet) select(''); }, { address: `?c=${encodeURIComponent(current)}` });
        }
        /* On one of its binders (a reload): that binder, that card, its first tab one Back away. */
        if (home && current && !arrived.has('open') && /^[\w-]{1,80}$/.test(arrived.get('binder') ?? '')) {
            nav.replace(`?c=${encodeURIComponent(current)}`);
            const card = arrived.get('card') ?? '';
            /* Its first tab known first (its chat, when it talks): Back comes back to it. */
            await chatFirst();
            goTab('lists', { pick: { list: arrived.get('binder'), ...(/^\d{1,9}$/.test(card) ? { card } : {}) } });
        }
        /* A link to a mail (?mail=mail:TARGET/MESSAGE-ID): the mail viewer opened on it, over the page. */
        if (/^mail:/.test(arrived.get('mail') ?? '')) void openMailRef(arrived.get('mail'), { of: current });
        /* Arriving on the address of a place (a reload, a link): it is opened. */
        if (home && new URLSearchParams(location.search).has('open')) await followAddress();
        /* THE FIRST START (Features, features.js): nothing made yet, the welcome not passed -- the home
           page opens on it, once; passed ("Skip", or a conversation made), it never comes back by itself. */
        else if (home && !DEVICE && !current && conversations.length === 0) {
            const d = await features?.refresh().catch(() => null);
            if (d?.welcome && place === 'conversations' && !conversations.length) openDeck(false);
        }
    }
    void start();
})();
