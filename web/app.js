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
    /* On a paired device, every request names the pairing it speaks for:
       the address is completed once the device has signed in. */
    let API = DEVICE ? '/c/api' : '/api';
    let pairing = '';
    let deviceShared = [];
    /* The parts of its conversation this device was given: its terminal, its
       chat ('write', 'read' or null). Only those are shown -- and the server
       refuses the others whatever this page does. */
    let deviceParts = { terminal: true, chat: null };
    /* What Parley mounted for the chat screen, and for which conversation. */
    let thread = null;
    let threadOf = '';
    const noTerminal = () => DEVICE && !deviceParts.terminal;
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

    const say = (label, kind) => { state.textContent = label; state.dataset.state = kind; };
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
    };
    /* WHILE A MACHINE IS BUILT: a wheel that turns, and the three steps with the
       one in progress marked, so a wait of several minutes reads as progress. */
    const BUILD_STEPS = ['Starting the machine', 'Preparing the machine', 'Installing the tool'];
    const building = (step) => {
        $('notice-spin').hidden = false;
        const at = step?.startsWith('Installing') ? 2 : BUILD_STEPS.indexOf(step);
        const list = $('notice-steps'); list.hidden = at < 0; list.replaceChildren();
        BUILD_STEPS.forEach((label, i) => {
            const li = document.createElement('li');
            li.dataset.state = i < at ? 'done' : i === at ? 'now' : 'later';
            li.textContent = i === 2 && at === 2 && step ? step : label;
            list.append(li);
        });
    };
    const view = (which) => { app.dataset.view = which; };

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
    const applyFold = (folded) => {
        app.dataset.list = folded ? 'folded' : 'open';
        $('fold').textContent = folded ? '\u00bb' : '\u00ab';
        $('fold').setAttribute('aria-pressed', String(folded));
        $('fold').setAttribute('aria-label', folded ? 'Show the list of conversations' : 'Hide the list of conversations');
    };
    let listFolded = false;
    try { listFolded = localStorage.getItem('clavarium-list') === 'folded'; } catch { /* a private window */ }
    $('fold').addEventListener('click', () => {
        listFolded = !listFolded;
        try { localStorage.setItem('clavarium-list', listFolded ? 'folded' : 'open'); } catch { /* as above */ }
        applyFold(listFolded);
        fit.fit(); focusTerminal();
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
        terminal.options.theme = light ? LIGHT : DARK;
        document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? LIGHT.background : DARK.background);
        $('theme').textContent = light ? 'Dark' : 'Light';
    };
    let lightScreen = false;
    try { lightScreen = localStorage.getItem('clavarium-theme') === 'light'; } catch { /* a private window: the choice lasts as long as the page */ }
    applyTheme(lightScreen);
    $('theme').addEventListener('click', () => {
        lightScreen = !lightScreen;
        try { localStorage.setItem('clavarium-theme', lightScreen ? 'light' : 'dark'); } catch { /* as above */ }
        applyTheme(lightScreen);
        focusTerminal();
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
    const send = (text) => {
        if (socket?.readyState === 1) socket.send(encoder.encode(text));
        /* Something was sent: the tool has its answer. */
        if (String(text).includes('\r')) $('room').removeAttribute('data-asking');
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
       it is read. Times can be shortened by a test (window.clavariumTimes). */
    const PROOF_BYTES = 32;
    const FOCUS_REPORTS = '\x1b[?1004h';
    const times = () => ({ look: 12_000, repair: 30_000, offer: 180_000, retry: 3000, ...(window.clavariumTimes ?? {}) });
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
        /* An opening that takes long: what is known of the machine is said under the wait. */
        later(T.look, () => void explainMachine(true));
        /* Repaired already in this wait, and still nothing: said plainly, with the restart. */
        if (repairedFor === name) slowTimers.push(setTimeout(() => { if (socket === mine && !output && name === current) stuck(name); }, T.repair));
        else later(T.repair, () => void repairTerminal(name));
        later(T.offer, () => void explainMachine(true, true));
        /* Open means the bridge answered, not that the machine is awake yet. */
        mine.onopen = () => { say('opening', 'connecting'); focusTerminal(); };
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
            if (message.type === 'status') {
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
    addEventListener('wheel', (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault(); event.stopPropagation();
        if (Date.now() - wheelAt < 120 || event.deltaY === 0) return;
        wheelAt = Date.now();
        stepText(event.deltaY < 0 ? 1 : -1);
    }, { passive: false, capture: true });
    /* Two fingers pinched: the text follows them; the terminal is laid out
       once they lift (not at every move: each new size is sent to the machine). */
    let pinch = null;
    const spread = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    document.addEventListener('touchstart', (event) => { if (event.touches.length === 2) pinch = { from: spread(event.touches), scale: textScale }; }, { passive: true, capture: true });
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
        const usable = Boolean(c) && c.phase === 'ready';
        $('archive').hidden = !c;
        $('files-open').hidden = $('share').hidden = !usable;
        /* Given its chat alone: the files of the chat open from the chat; Files holds only what was given to the device itself. */
        if (noTerminal()) $('files-open').hidden = deviceShared.length === 0;
        $('sleep').hidden = !usable || c.asleep === true;
        $('restart').hidden = DEVICE || !usable;
        /* Its own sheet is there as soon as it exists: archiving one that failed is done from it. */
        $('folders').hidden = DEVICE || !c;
    }
    /* `keepSheets`: the same conversation, looked at again (its state changed):
       a sheet the owner has open is not shut under their fingers. */
    function enter(keepSheets = false) {
        if (welcoming) return;
        const c = conversations.find((x) => x.name === current);
        $('name').textContent = current || 'No conversation';
        document.title = current ? `${current} - Clavarium` : 'Clavarium';
        $('tool').hidden = !c; $('tool').textContent = c?.toolLabel ?? '';
        paintActions();
        $('copy-open').hidden = !current || (home && (!c || c.phase !== 'ready'));
        if (!keepSheets) $('panel').hidden = $('files').hidden = $('sharing').hidden = $('copy').hidden = true;
        paintChips();
        $('keys').hidden = !current;
        if (!current) { disconnect(); terminal.reset(); say('', 'ended'); show(home ? 'Choose a conversation, or create one.' : 'This address names no conversation.'); return; }
        if (home && !c) { disconnect(); say('unknown', 'ended'); show('No such conversation.'); return; }
        const usable = Boolean(c) && c.phase === 'ready';
        $('shortcuts').hidden = $('keys').hidden = !current || (home && !usable);
        if (home && usable && !noTerminal()) void paintShortcuts();
        if (c && c.phase === 'building') {
            disconnect(); say('building', 'connecting');
            const minutes = c.buildingSince ? Math.floor((Date.now() - Date.parse(c.buildingSince)) / 60000) : 0;
            show(`${minutes < 1 ? 'Started less than a minute ago' : `${minutes} min so far`}. A new machine takes a few minutes.`);
            building(c.step);
            return;
        }
        if (c && c.phase === 'restarting') { disconnect(); say('restarting', 'connecting'); show(`${c.step ?? 'Restarting its machine'}... The tool starts again by itself.`); $('notice-spin').hidden = false; return; }
        if (c && c.phase === 'moving') { disconnect(); say('moving', 'connecting'); show(`Moving its work: ${c.step ?? 'working'}... The tool is stopped meanwhile and starts again by itself.`); $('notice-spin').hidden = false; return; }
        if (c && c.phase === 'failed') { disconnect(); say('failed', 'ended'); show(c.error ?? 'This conversation could not be built.', DEVICE ? undefined : 'Build it again', () => void rebuild()); return; }
        /* Given its chat and not its terminal: the chat is the whole page, and no terminal is ever opened. */
        if (noTerminal()) { chatAlone(); return; }
        /* Asleep because somebody asked: it stays asleep until somebody asks. */
        if (c && c.asleep === true && !socket) { say('asleep', 'waiting'); show('Asleep. The tool is frozen as it was.', 'Wake it', connect); return; }
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
    function select(name) {
        if (name !== current) { disconnect(); terminal.reset(); }
        current = name;
        history.replaceState(null, '', name ? `?c=${encodeURIComponent(name)}` : location.pathname);
        view(name ? 'room' : 'list');
        paint();
        enter();
        void chatFirst();
    }

    /* ---------- the list ---------- */
    const post = async (path, body) => {
        const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(j.error || 'The request failed.'), { kind: j.kind, retry: j.retry === true });
        return j;
    };
    function paint() {
        const items = $('items');
        items.replaceChildren();
        for (const c of conversations) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'item'; b.dataset.phase = c.phase;
            if (c.name === current) b.setAttribute('aria-current', 'true');
            const title = document.createElement('b');
            const dot = document.createElement('span'); dot.className = 'dot';
            title.append(dot, c.name);
            const sub = document.createElement('small');
            sub.textContent = c.phase === 'ready' ? `${c.toolLabel}${c.asleep ? ' - asleep' : ''}` : c.phase === 'building' ? `${c.toolLabel} - ${c.step ?? 'building'}` : c.phase === 'moving' ? `${c.toolLabel} - moving its work` : `${c.toolLabel} - failed`;
            if (c.asleep) b.dataset.asleep = 'true';
            b.append(title, sub);
            /* Several models answer its simple questions; or they stopped, and it waits for its owner. */
            const waking = (c.wakeups?.items ?? []).filter((w) => w.on).length;
            if (waking > 0) { const mark = document.createElement('small'); mark.className = 'shared-mark'; mark.textContent = `${waking} wake-up${waking > 1 ? 's' : ''}`; b.append(mark); }
            /* It talks through the app, and asks or waits for its owner there. */
            if (c.talk && (c.talk.waiting > 0 || c.talk.state === 'waiting')) { const mark = document.createElement('small'); mark.className = 'needs-mark'; mark.textContent = c.talk.waiting > 0 ? 'asks you' : 'waits for you'; b.append(mark); }
            if (c.answerer?.on) { const mark = document.createElement('small'); mark.className = c.answerer.needs ? 'needs-mark' : 'shared-mark'; mark.textContent = c.answerer.needs ? 'asks for you' : 'answered in your place'; b.append(mark); }
            /* Seen at a glance: this conversation is in other hands too. */
            const holders = sharedDevices.filter((d) => d.grants.some((g) => g.asset === `conversation:${c.name}`)).length;
            if (holders > 0) { const mark = document.createElement('small'); mark.className = 'shared-mark'; mark.textContent = `shared with ${holders} device${holders > 1 ? 's' : ''}`; b.append(mark); }
            b.addEventListener('click', () => select(c.name));
            items.append(b);
        }
        $('empty').hidden = conversations.length > 0;
        $('sharing-open').hidden = $('assets-open').hidden = $('settings-open').hidden = $('links-open').hidden = DEVICE;
        $('sharing-open').textContent = sharedDevices.length > 0 ? `Devices & sharing (${sharedDevices.length})` : 'Devices & sharing';
    }
    async function refresh() {
        clearTimeout(pollTimer);
        try {
            const mark = (x) => (x ? `${x.phase}/${x.asleep === true}` : '');
            const before = mark(conversations.find((x) => x.name === current));
            if (DEVICE) {
                const mePath = () => `${API}/me?c=${encodeURIComponent(current)}`;
                let r = await fetch(mePath());
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
                if (!r.ok) throw new Error('no api');
                conversations = await r.json();
                await readDevices();
                $('list').hidden = false; $('back').hidden = false;
            }
            home = true;
            if (conversations.find((x) => x.name === current)?.answerer?.needs) $('room').setAttribute('data-asking', '');
            paint();
            paintChips();
            paintHealth();
            const now = mark(conversations.find((x) => x.name === current));
            paintActions();
            if (before !== now || now.startsWith('building') || now.startsWith('restarting') || now.startsWith('moving')) enter(true);
        } catch { /* a server without VMs has no list: the page is one terminal */ }
        /* The panel is open: what the answerer did meanwhile is said there. */
        if (!DEVICE && !$('panel').hidden) { void paintAnswerer(); paintWakeups(); paintMachine(conversations.find((x) => x.name === current)); }
        if (home) pollTimer = setTimeout(refresh, conversations.some((c) => c.phase === 'building' || c.phase === 'moving' || c.phase === 'restarting') ? 2500 : 10000);
    }

    /* ---------- creating ---------- */
    let chosenTool = '';
    async function openCreate() {
        const tools = await (await fetch(`${API}/tools`)).json();
        const box = $('create-tools');
        box.replaceChildren();
        chosenTool = tools[0]?.id ?? '';
        for (const t of tools) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = t.label; b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', t.id === chosenTool ? 'true' : 'false');
            b.addEventListener('click', () => {
                chosenTool = t.id;
                for (const other of box.children) other.setAttribute('aria-checked', other === b ? 'true' : 'false');
            });
            box.append(b);
        }
        $('create-error').hidden = true;
        $('create').hidden = false;
        focusField($('create-name'));
    }
    $('new').addEventListener('click', () => { void openCreate(); });
    $('create-cancel').addEventListener('click', () => { $('create').hidden = true; });
    $('create').addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = $('create-name').value.trim();
        try {
            await post(`${API}/conversations`, { name, tool: chosenTool, workOnDisk: $('create-disk').checked });
            $('create').hidden = true; $('create-name').value = ''; $('create-disk').checked = false;
            await refresh();
            select(name);
        } catch (error) { $('create-error').textContent = error.message; $('create-error').hidden = false; }
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
       presses Enter is sent, the other is put in its box to be completed. */
    const asReplies = (all) => (Array.isArray(all) ? all : []).map((x) => ({ label: x.label, text: x.text, send: x.enter === true }));
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
                    send(`${text} `);
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
    void offerVoice();

    /* ---------- folders ---------- */
    const LEVELS = [['none', 'Off'], ['read', 'Read'], ['write', 'Write']];
    function paintChips() {
        const chips = $('chips');
        chips.replaceChildren();
        if (conversations.find((x) => x.name === current)?.offline === true) {
            const chip = document.createElement('span'); chip.className = 'chip'; chip.dataset.access = 'offline'; chip.textContent = 'offline';
            chips.append(chip);
        }
        for (const r of conversations.find((x) => x.name === current)?.resources ?? []) {
            const chip = document.createElement('span');
            chip.className = 'chip'; chip.dataset.access = r.access;
            chip.textContent = `${r.name} - ${r.access}`;
            chips.append(chip);
        }
    }
    /* THREE PLACES, ONE RULE: the left column is the platform, the bar is this
       conversation.
         Access    what THIS conversation has: attached folders, repositories
                   and mailboxes, secrets handed to its tool, its network.
                   Nothing is created there.
         Assets    everything kept here, whatever the conversation: made
                   there, and attached to any conversation from there.
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
        /* What can still be attached, for the picker. */
        const picker = $('attach-rows'); picker.replaceChildren();
        $('attach-title').textContent = `Attach to "${current}"`;
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
        $('work-now').textContent = kept
            ? 'In a folder kept here: you see its files in Files, and they outlive the machine. It has a fixed size, and refuses symbolic links that point upwards or outside: a code project that installs packages belongs on the disk of its machine.'
            : 'On the disk of its machine: faster for a large code project, but its files are not shown in Files and go with the machine.';
        $('work-moved').textContent = here?.moved ?? ''; $('work-moved').hidden = !here?.moved;
        $('work-move').textContent = kept ? 'Move its work to the disk of its machine...' : 'Keep its work here (shown in Files)...';
        $('work-move').onclick = () => {
            const to = kept ? 'disk' : 'kept';
            /* The question is asked over the terminal, not under this panel. */
            $('panel').hidden = true;
            show(`Move the work of "${current}" ${kept ? 'to the disk of its machine' : 'into a folder kept here'}? THE TOOL IS STOPPED AND STARTED AGAIN: what it is doing now is interrupted, and a tool that keeps a conversation must be asked to resume it. Its files are copied; the move is refused if less than 1 GB would stay free${kept ? '' : ', or if the work holds symbolic links that a kept folder refuses'}.`,
                'Move it', async () => {
                    try { await post(`${API}/conversations/${encodeURIComponent(current)}/work`, { to }); await refresh(); enter(); }
                    catch (error) { show(error.message, 'Back to the terminal', enter); }
                }, () => { notice.hidden = true; focusTerminal(); });
        };
        void paintAnswerer(); paintWakeups(); void paintTalkBox(); void paintShareHere();
        paintMachine(here);
        const offline = here?.offline === true;
        for (const b of $('network').children) b.setAttribute('aria-pressed', String((b.dataset.online === 'true') !== offline));
        await paintSignIn();
    }
    /* ---------- the chapters of "This conversation": folded or not, kept on this device ---------- */
    /* What is used every day is open at first; the rest is one tap away. */
    const OPEN_AT_FIRST = { general: true, machine: true, access: true };
    let chapters = {};
    try { chapters = JSON.parse(localStorage.getItem('clavarium-chapters') ?? '{}') ?? {}; } catch { /* a private window */ }
    for (const chapter of document.querySelectorAll('details.chapter')) {
        const key = chapter.dataset.chapter;
        chapter.open = chapters[key] ?? OPEN_AT_FIRST[key] ?? false;
        chapter.addEventListener('toggle', () => {
            chapters[key] = chapter.open;
            try { localStorage.setItem('clavarium-chapters', JSON.stringify(chapters)); } catch { /* as above */ }
        });
    }
    const openChapter = (key) => { const chapter = document.querySelector(`details.chapter[data-chapter="${key}"]`); if (chapter) chapter.open = true; return chapter; };

    /* ---------- the machine: its health, its size, a restart ---------- */
    const sizeWords = (mb) => (mb >= 1024 ? `${Number.isInteger(mb / 1024) ? mb / 1024 : (mb / 1024).toFixed(1)} GB` : `${mb} MB`);
    function healthLines(list, record, { all = true } = {}) {
        list.replaceChildren();
        const problems = (record?.problems ?? []).filter((p) => all || p.level === 'warn' || p.level === 'bad');
        for (const p of problems) { const li = document.createElement('li'); li.dataset.level = p.level; li.textContent = p.text; list.append(li); }
        if (all && record && record.state === 'Running' && record.answering) {
            const li = document.createElement('li'); li.dataset.level = problems.length ? 'info' : 'ok';
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
        const serious = h && (h.level === 'warn' || h.level === 'bad') && c.phase === 'ready' && !c.asleep;
        const key = serious ? `${current}:${h.problems.map((p) => p.text).join('|')}` : '';
        $('health-strip').hidden = !serious || key === healthDismissed;
        /* Running, but not well: the dot beside "live" says so too. */
        state.dataset.health = serious ? h.level : '';
        if (!serious) return;
        $('health-strip').dataset.level = h.level;
        const shown = h.problems.filter((p) => p.level === 'warn' || p.level === 'bad');
        $('health-text').textContent = shown.map((p) => p.text).join(' ');
        /* What can be done, from here: more memory where memory is short, a restart, its terminal when the chat is in front. */
        $('health-memory').hidden = DEVICE || !shown.some((p) => p.kind === 'memory');
        $('health-restart').hidden = DEVICE;
        $('health-terminal').hidden = !simple || noTerminal();
        $('health-dismiss').onclick = () => { healthDismissed = key; $('health-strip').hidden = true; };
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
    /* Its terminal, asked for: never shown by itself in place of its chat. */
    function seeTerminal() { simple = false; paintSimple(); paintHealth(); focusTerminal(); }
    $('health-memory').addEventListener('click', () => { void openMemory(); });
    $('health-terminal').addEventListener('click', seeTerminal);
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
        /* Nothing over the screen to say it under: a long wait still says so. */
        if (notice.hidden && !long) return;
        if (notice.hidden) show('Its terminal still does not come.');
        /* Waking it is what the page is doing: "it is asleep" would say the opposite. */
        const said = waiting && record ? { ...record, problems: (record.problems ?? []).filter((p) => p.kind !== 'state') } : record;
        const shown = healthLines($('notice-health'), said, { all: true });
        $('notice-health').hidden = $('notice-health').childElementCount === 0;
        $('notice-restart').hidden = !(record && (record.level === 'bad' || record.level === 'warn' || long));
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
        say('repairing', 'connecting');
        show('Its terminal does not come, though its machine runs: it is being repaired...');
        $('notice-spin').hidden = false;
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
        $('panel').hidden = true;
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
    function paintMachine(here) {
        /* General: what it is. */
        const facts = $('general-facts'); facts.replaceChildren();
        const fact = (term, value) => { const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; facts.append(dt, dd); };
        if (here) {
            fact('Name', here.name);
            fact('Tool', here.toolLabel ?? here.tool);
            if (here.createdAt) fact('Created', new Date(here.createdAt).toLocaleString());
            fact('Machine', `${sizeWords(here.memoryMb)} of memory, ${here.diskGb ? `${here.diskGb} GB` : 'an unknown size of'} disk`);
            fact('Works in', here.work === 'kept' ? 'a folder kept here (/work)' : 'the disk of its machine (/work)');
        }
        healthLines($('machine-health'), here?.health ?? null);
        $('machine-restarted').textContent = here?.restarted ?? ''; $('machine-restarted').hidden = !here?.restarted;
        /* The choices are not painted over while somebody is choosing. */
        const memory = $('machine-memory'); const disk = $('machine-disk');
        const of = `${here?.name}/${here?.memoryMb}/${here?.diskGb}/${here?.memoryMinMb}`;
        if (here && memory.dataset.of !== of && document.activeElement !== memory && document.activeElement !== disk) {
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
        $('machine-size').hidden = DEVICE || !here || here.phase !== 'ready';
        /* When its tool starts: its last session, or a new one -- for a tool that can take one up. */
        $('resume-box').hidden = DEVICE || !here?.resumes;
        for (const b of $('resume-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === (here?.resume !== false)));
    }
    for (const b of $('resume-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/resume`, { on: b.dataset.on === 'true' }); await refresh(); paintMachine(conversations.find((x) => x.name === current)); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
    $('machine-size').addEventListener('submit', (event) => {
        event.preventDefault();
        const name = current;
        const here = conversations.find((x) => x.name === name);
        if (!here) return;
        const memoryMb = Number($('machine-memory').value); const diskGb = Number($('machine-disk').value);
        if (memoryMb === here.memoryMb && diskGb === (here.diskGb ?? 8)) { $('panel-error').textContent = 'Nothing to change: choose another memory or disk first.'; $('panel-error').hidden = false; return; }
        $('panel').hidden = true;
        const resume = socket && state.dataset.state === 'live' ? () => { notice.hidden = true; focusTerminal(); } : enter;
        const changes = [memoryMb !== here.memoryMb ? `${sizeWords(memoryMb)} of memory (now ${sizeWords(here.memoryMb)})` : '', diskGb !== (here.diskGb ?? 8) ? `a disk of ${diskGb} GB (now ${here.diskGb ?? 8} GB; it can never shrink again)` : ''].filter(Boolean).join(' and ');
        show(`Give "${name}" ${changes}? ITS MACHINE IS STOPPED CLEANLY, SET, AND STARTED AGAIN: what the tool is doing now is interrupted. Its work folder, its folders and its branches stay.`,
            'Change it', async () => {
                disconnect(); say('restarting', 'connecting'); show('Changing its machine...'); $('notice-spin').hidden = false;
                try { await post(`${API}/conversations/${encodeURIComponent(name)}/machine`, { memoryMb, diskGb }); await refresh(); enter(); }
                catch (error) { show(error.message, 'Back', enter); }
            }, resume);
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
    $('simple-toggle').addEventListener('click', () => {
        simple = !simple;
        /* Its terminal, one click from a chat, for now: the next opening is on the chat again. */
        if (!(talk.on && talkOf === current)) { simplePref = simple; try { localStorage.setItem('clavarium-simple', simple ? '1' : '0'); } catch { /* as above */ } }
        simpleFilesAt = 0; paintSimple();
        if (simple) void readTalk().then(paintThread);
        if (!simple) focusTerminal();
    });
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
    const deviceLang = () => (navigator.language || 'en');
    let chatWords = null;
    async function readWords() {
        if (!chatWords) chatWords = await fetch(`${API}/talk/words?${new URLSearchParams({ lang: deviceLang() })}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
        return chatWords;
    }
    /* The same on this server's own page and on a device's (which speaks for its own conversation). */
    const talkPath = (name, tail = '') => `${API}/conversations/${encodeURIComponent(name)}/talk${tail}${DEVICE ? `?${new URLSearchParams({ c: name })}` : ''}`;
    async function readTalk() {
        /* A device not given the chat does not ask for it: the server would refuse. */
        if (!current || (DEVICE && deviceParts.chat === null)) { talk = { on: false, messages: [] }; talkOf = current; return talk; }
        talk = await fetch(talkPath(current)).then((r) => (r.ok ? r.json() : { on: false, messages: [] })).catch(() => ({ on: false, messages: [] }));
        talkOf = current;
        return talk;
    }
    async function paintThread() {
        const box = $('simple-thread');
        const wanted = talk.on && talkOf === current;
        box.hidden = !wanted;
        /* Where the tool talks through the app, the chat is the whole screen: one box to write in. */
        $('simple-plain').hidden = wanted;
        $('simple').toggleAttribute('data-chat', wanted);
        /* The ready-made answers type into the terminal: not under a chat. */
        $('room').toggleAttribute('data-chat', wanted && simple);
        /* Its chat alone was given, and the owner has not turned it on: said, not left blank. */
        $('chat-off').hidden = !(noTerminal() && !wanted);
        if (noTerminal()) { $('room').setAttribute('data-chat', ''); keysForChat(); say(wanted ? 'chat' : 'chat off', wanted ? 'live' : 'waiting'); }
        /* The bar's dictation types into the terminal: not while the chat is in front, which has its own. */
        if (wanted && simple && stopListening) stopVoice();
        paintSimple();
        if (!wanted) { thread?.destroy(); thread = null; threadOf = ''; return; }
        if (thread && threadOf === current) { void thread.refresh(); return; }
        thread?.destroy();
        /* From where this page is: a device's page lives under /c/, and nothing else is open to it. */
        const [{ mount }, words] = await Promise.all([import(new URL('vendor/parley-ui.js', new URL(DEVICE ? '/c/' : '/', location.href)).href), readWords()]);
        const name = current;
        if (name !== current || (thread && threadOf === current)) return;
        threadOf = name;
        thread = mount(box, {
            words, view: chatView,
            onView: (v) => { chatView = v; try { localStorage.setItem('clavarium-chat-view', v); } catch { /* as above */ } },
            load: () => fetch(talkPath(name)).then((r) => r.json()).then(machineLines),
            send: (text, answers, files) => post(talkPath(name), { text, answers, ...(files ? { files: files.map((f) => f.path) } : {}) }),
            /* The buttons of a line of the machine: what this screen may do. */
            act: (id) => { if (id === 'memory') void openMemory(); else if (id === 'restart') void restartMachine(false); else if (id === 'terminal') seeTerminal(); },
            /* Files attached to a message: wherever the chat may be written in. */
            ...(!DEVICE || deviceParts.chat === 'write' ? { attach: { upload: (file) => attachToChat(name, file) } } : {}),
            /* Its terminal, when this device was given it. */
            /* A file the tool showed opens in the window when it is in its work folder or an attached folder ("work:report.html"). */
            open: (file) => { if (!file.open) return; const at = file.open.indexOf(':'); const tab = file.open.slice(0, at); const inner = file.open.slice(at + 1); void preview(tab, inner, inner.split('/').pop(), 0); },
            ...(noTerminal() ? {} : { terminal: () => { simple = false; paintSimple(); focusTerminal(); } }),
            remind: () => post(talkPath(name, '/remind'), {}),
            /* The helpers of the terminal, in the chat: this page's voice, the owner's ready answers, the keyboard rule of this device. */
            voice: chatVoice(), autoSend: chatAuto,
            onAutoSend: (on) => { chatAuto = on; try { localStorage.setItem('clavarium-chat-auto', on ? '1' : '0'); } catch { /* as above */ } },
            touch: touchScreen,
        });
        const replies = await loadReplies();
        if (thread && threadOf === name) thread.replies = replies;
    }
    /* THE LINES OF ITS MACHINE in the chat: their buttons, as this screen may
       use them -- its memory and a restart are the owner's; its terminal, a
       screen's that was given it. */
    const ACTIONS = { memory: 'More memory...', restart: 'Restart...', terminal: 'See the terminal' };
    function machineLines(data) {
        if (!Array.isArray(data?.messages)) return data;
        const may = (id) => (id === 'terminal' ? !noTerminal() : (id === 'memory' || id === 'restart') && !DEVICE);
        return { ...data, messages: data.messages.map((m) => (m.from === 'system' ? { ...m, actions: (m.actions ?? []).filter(may).map((id) => ({ id, label: ACTIONS[id] })) } : m)) };
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
        if (talk.on && name === current) focusTerminal();
    }
    function languageName(tag) { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag.split('-')[0]) ?? tag; } catch { return tag; } }
    async function paintTalkBox() {
        if (DEVICE) { $('talk-box').hidden = true; return; }
        await readTalk();
        for (const b of $('talk-on').children) b.setAttribute('aria-pressed', String((b.dataset.on === 'true') === talk.on));
        $('talk-invite').hidden = !talk.on;
        $('talk-declare').hidden = !talk.on;
        if (talk.on) $('talk-declare').textContent = talk.tools
            ? `Then "Ask the tool to use it": it is asked, in its terminal, to install parley from /tools and to write to you in ${languageName(deviceLang())}. From then on, this conversation opens on its chat; its terminal is one click away.`
            : 'The tools folder (/tools) is not in place on this server yet: the tool cannot be asked to install parley.';
        if (!talk.on && talk.possible === false) $('talk-about').textContent = 'This conversation works on the disk of its machine: talking through the app needs its work folder kept here.';
    }
    for (const b of $('talk-on').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/talk`, { on: b.dataset.on === 'true' }); await paintTalkBox(); void paintThread(); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        });
    }
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
        select.replaceChildren(...[['device', `The language of each device (here: ${languageName(deviceLang())})`], ...wordsSettings.languages.map((l) => [l, languageName(l)])].map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }));
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
            state.textContent = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'On an iPhone or an iPad, alerts come once the page is installed as an app (Share, then "Add to Home Screen").' : 'This browser cannot be alerted.';
            return;
        }
        const registration = await navigator.serviceWorker.ready;
        const mine = await registration.pushManager.getSubscription();
        const about = await fetch(`${API}/alerts`).then((r) => r.json()).catch(() => ({ devices: [] }));
        $('alerts-on').hidden = Boolean(mine); $('alerts-off').hidden = $('alerts-test').hidden = !mine;
        state.textContent = said ?? (mine ? `This device is told when a tool stops and waits for you. ${about.devices.length} device(s) in all.` : `When a tool stops and waits for you, this device can be told.${about.devices.length > 0 ? ` ${about.devices.length} other device(s) already are.` : ''}`);
    }
    $('alerts-on').addEventListener('click', async () => {
        try {
            if ((await Notification.requestPermission()) !== 'granted') { await paintAlerts('Alerts are refused for this site in the settings of this browser.'); return; }
            const { key } = await fetch(`${API}/alerts`).then((r) => r.json());
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey(key) });
            await post(`${API}/alerts`, { subscription: subscription.toJSON(), label: /Android/.test(navigator.userAgent) ? 'Android' : /iPad|iPhone/.test(navigator.userAgent) ? 'iPhone or iPad' : 'Computer' });
            await paintAlerts();
        } catch (error) { await paintAlerts(`This device could not be set up for alerts: ${error.message}`); }
    });
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
            const last = document.createElement('p'); last.className = 'hint wakeup-last'; last.textContent = w.last ? `Last, ${new Date(w.last.at).toLocaleString()}: ${w.last.what}` : 'Not yet.';
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
        $('wakeups-sent').textContent = `${mine.sentThisHour} this hour.`;
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
        $('files').hidden = $('sharing').hidden = $('assets').hidden = $('settings').hidden = true;
        /* What is attached may have changed from another screen: asked again before it is shown. */
        await refresh();
        await paintPanel();
        $('attach-picker').hidden = !picking;
        if (picking) openChapter('access');
        $('panel').hidden = false;
        if (picking) $('attach-picker').scrollIntoView({ block: 'nearest' });
    }
    $('folders').addEventListener('click', () => { void openAccess(false); });
    $('attach-open').addEventListener('click', () => { openChapter('access'); $('attach-picker').hidden = false; $('attach-picker').scrollIntoView({ block: 'nearest' }); });
    $('attach-close').addEventListener('click', () => { $('attach-picker').hidden = true; });
    $('attach-manage').addEventListener('click', () => { void openAssets(); });
    $('chips').addEventListener('click', () => { if (!DEVICE && current) void openAccess(false); });
    $('panel-close').addEventListener('click', () => { $('panel').hidden = true; focusTerminal(); });

    /* ---------- Assets: everything kept here ---------- */
    let assetsKind = ''; let assetOpen = '';
    async function paintAssets() {
        const [all, boxes, secrets, keys] = await Promise.all([
            fetch(`${API}/resources`).then((r) => r.json()), fetch(`${API}/mailboxes`).then((r) => r.json()).catch(() => []), fetch(`${API}/secrets`).then((r) => r.json()).catch(() => []), fetch(`${API}/git-keys`).then((r) => r.json()).catch(() => []), readDevices()]);
        const ready = conversations.filter((c) => c.phase === 'ready');
        const count = { folder: 0, git: 0, mailbox: 0, secret: secrets.length };
        for (const r of all) count[kindOf(r)] += 1;
        /* The kinds, as chips with how many there are. */
        const filters = $('assets-filters'); filters.replaceChildren();
        for (const [kind, text] of [['', `All ${all.length + secrets.length}`], ['folder', `Folders ${count.folder}`], ['git', `Repositories ${count.git}`], ['mailbox', `Mailboxes ${count.mailbox}`], ['secret', `Secrets ${count.secret}`]]) {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-pressed', String(assetsKind === kind));
            b.addEventListener('click', () => { assetsKind = kind; void paintAssets(); });
            filters.append(b);
        }
        for (const section of $('assets').querySelectorAll('section')) section.hidden = assetsKind !== '' && section.dataset.kind !== assetsKind;
        for (const kind of ['folder', 'git', 'mailbox']) $(`assets-${kind}`).replaceChildren();
        for (const resource of all) {
            const kind = kindOf(resource); const asset = `${kind}:${resource.name}`;
            const users = Object.entries(resource.attachments ?? {});
            const holders = devicesWith(asset);
            const row = document.createElement('div'); row.className = 'asset'; row.dataset.name = resource.name;
            const head = document.createElement('button'); head.type = 'button'; head.className = 'asset-head'; head.setAttribute('aria-expanded', String(assetOpen === asset));
            const name = document.createElement('b'); name.textContent = resource.name;
            const used = document.createElement('span'); used.className = users.length ? '' : 'hint';
            used.textContent = users.length ? users.map(([c, access]) => `${c} (${access})`).join(', ') : 'not used';
            const given = document.createElement('span'); given.className = 'hint';
            const box = kind === 'mailbox' ? boxes.find((m) => m.name === resource.name) : undefined;
            given.textContent = [holders.length ? `on ${holders.map((d) => d.label).join(', ')}` : '', box ? (box.failure ? box.failure : `${box.messages} message(s)`) : '', kind === 'git' && resource.from ? `from ${hostOf(resource.from)}${viaText(resource.via)}` : ''].filter(Boolean).join(' - ');
            head.append(name, used, given);
            head.addEventListener('click', () => { assetOpen = assetOpen === asset ? '' : asset; void paintAssets(); });
            row.append(head);
            if (kind === 'git') {
                const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Review & send';
                review.addEventListener('click', () => { void openGit(resource.name); });
                row.append(review);
            }
            if (assetOpen === asset) {
                /* Opened: every conversation, with what it may do with this. */
                const inside = document.createElement('div'); inside.className = 'asset-inside';
                if (kind === 'git' && resource.from) {
                    const where = document.createElement('p'); where.className = 'hint';
                    where.textContent = `Cloned from ${resource.from}${viaText(resource.via)}.${resource.via?.hostKey ? ` Host key recorded for ${hostOf(resource.from)}: ${resource.via.hostKey}.` : ''}`;
                    inside.append(where);
                }
                for (const c of ready) {
                    const line = document.createElement('div'); line.className = 'given-row'; line.dataset.conversation = c.name;
                    const who = document.createElement('span'); who.textContent = c.name;
                    const options = kind === 'mailbox' ? [['none', 'Off'], ['read', 'Read']] : [['none', 'Off'], ['read', 'Read'], ['write', 'Write']];
                    line.append(who, modes(options, resource.attachments?.[c.name] ?? 'none', async (access) => { await attachTo(c.name, resource.name, access, 'assets-error'); await paintAssets(); }, `What ${c.name} may do with ${resource.name}`));
                    inside.append(line);
                }
                if (ready.length === 0) { const none = document.createElement('p'); none.className = 'hint'; none.textContent = 'No conversation is ready to attach it to.'; inside.append(none); }
                const actions = document.createElement('div'); actions.className = 'row';
                const give = document.createElement('button'); give.type = 'button'; give.textContent = holders.length ? `Shared with ${holders.length} - Share...` : 'Share...';
                give.addEventListener('click', () => { void openCompose([[asset, 'r']]); });
                /* Always shown; when it cannot be done, it says why. */
                const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
                const why = document.createElement('span'); why.className = 'hint';
                if (users.length > 0) { remove.disabled = true; why.textContent = `attached to ${users.length} conversation${users.length > 1 ? 's' : ''}: set ${users.length > 1 ? 'them' : 'it'} to Off first`; }
                remove.addEventListener('click', () => {
                    const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Yes, remove ${resource.name} (its files are kept aside on the server)`;
                    sure.addEventListener('click', async () => {
                        try { await post(`${API}/resources/${resource.name}/remove`); assetOpen = ''; }
                        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
                        await paintAssets();
                    });
                    remove.replaceWith(sure);
                });
                actions.append(give, remove, why); inside.append(actions); row.append(inside);
            }
            $(`assets-${kind}`).append(row);
        }
        for (const kind of ['folder', 'git', 'mailbox']) $(`assets-${kind}-title`).textContent = `${{ folder: 'Folders', git: 'Repositories', mailbox: 'Mailboxes' }[kind]} (${count[kind]})`;
        $('assets-secret-title').textContent = `Secrets (${count.secret})`;
        paintSecrets(secrets, ready);
        paintKeys(keys);
    }
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
    /* The key offered in "Add a repository": the one chosen stays chosen. */
    function fillKeyChoice(chosen = $('git-key').value) {
        const select = $('git-key'); select.replaceChildren();
        if (gitKeys.length === 0) { const none = document.createElement('option'); none.value = ''; none.textContent = 'No key yet: make one'; select.append(none); }
        for (const key of gitKeys) {
            const o = document.createElement('option'); o.value = key.name;
            o.textContent = key.usedBy.length ? `${key.name} (used by ${key.usedBy.join(', ')})` : key.name;
            select.append(o);
        }
        if (gitKeys.some((k) => k.name === chosen)) select.value = chosen;
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
    $('git-key').addEventListener('change', showChosenKey);
    $('git-key-new').addEventListener('click', () => {
        const taken = new Set(gitKeys.map((k) => k.name));
        const wanted = $('git-name').value.trim();
        let suggestion = wanted && !taken.has(wanted) ? wanted : '';
        for (let n = 1; !suggestion; n += 1) if (!taken.has(`key-${n}`)) suggestion = `key-${n}`;
        $('git-key-name').value = suggestion;
        $('git-key-make').hidden = false; focusField($('git-key-name'));
    });
    $('git-key-make-go').addEventListener('click', async () => {
        $('git-error').hidden = true;
        try {
            const made = await post(`${API}/git-keys`, { name: $('git-key-name').value.trim() });
            $('git-key-make').hidden = true;
            gitKeys = await fetch(`${API}/git-keys`).then((r) => r.json());
            fillKeyChoice(made.name);
            await paintAssets();
        } catch (error) { $('git-error').textContent = error.message; $('git-error').hidden = false; }
    });
    $('git-key-copy').addEventListener('click', () => { void copyField($('git-key-public'), $('git-key-copy')); });
    /* Secrets: a name, and which conversations' tools are handed it. A value goes in and never comes back. */
    function paintSecrets(all, ready) {
        const rows = $('secret-rows');
        rows.replaceChildren();
        for (const secret of all) {
            const asset = `secret:${secret.name}`;
            const row = document.createElement('div'); row.className = 'asset'; row.dataset.name = secret.name;
            const head = document.createElement('button'); head.type = 'button'; head.className = 'asset-head'; head.setAttribute('aria-expanded', String(assetOpen === asset));
            const name = document.createElement('b'); name.textContent = secret.name;
            const used = document.createElement('span'); used.className = secret.conversations.length ? '' : 'hint'; used.textContent = secret.conversations.length ? secret.conversations.join(', ') : 'not used';
            head.append(name, used);
            head.addEventListener('click', () => { assetOpen = assetOpen === asset ? '' : asset; void paintAssets(); });
            row.append(head);
            if (assetOpen === asset) {
                const inside = document.createElement('div'); inside.className = 'asset-inside';
                for (const c of ready) {
                    const line = document.createElement('div'); line.className = 'given-row'; line.dataset.conversation = c.name;
                    const who = document.createElement('span'); who.textContent = c.name;
                    line.append(who, modes([['off', 'Off'], ['use', 'Use']], secret.conversations.includes(c.name) ? 'use' : 'off', async (value) => { await handTo(c.name, secret.name, value === 'use', 'assets-error'); await paintAssets(); }, `Whether the tool of ${c.name} is handed ${secret.name}`));
                    inside.append(line);
                }
                const note = document.createElement('p'); note.className = 'hint'; note.textContent = 'A change takes effect the next time the tool starts (leave the tool, then "Start it again").'; inside.append(note);
                const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
                remove.addEventListener('click', () => {
                    const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Yes, delete ${secret.name}`;
                    sure.addEventListener('click', async () => { await post(`${API}/secrets/${secret.name}/remove`).catch(() => {}); assetOpen = ''; await paintAssets(); });
                    remove.replaceWith(sure);
                });
                inside.append(remove); row.append(inside);
            }
            rows.append(row);
        }
        $('secret-empty').hidden = all.length > 0;
    }
    $('secret-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true;
        try { await post(`${API}/secrets`, { name: $('secret-name').value.trim(), value: $('secret-value').value }); $('secret-name').value = ''; $('secret-value').value = ''; $('secret-box').open = false; }
        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
        await paintAssets();
    });
    async function openAssets() {
        $('panel').hidden = $('files').hidden = $('sharing').hidden = $('settings').hidden = true;
        $('assets-error').hidden = true;
        await paintAssets();
        $('assets').hidden = false;
    }
    $('assets-open').addEventListener('click', () => { void openAssets(); });
    $('assets-close').addEventListener('click', () => { $('assets').hidden = true; focusTerminal(); });

    /* ---------- who gets what, and flows: see links.js ---------- */
    /* What those sheets share with the rest of the page: the requests, the
       automatic sending form of Access, the share sheet for a device to pair. */
    const links = DEVICE ? undefined : window.clavariumLinks?.({
        API: () => API, refresh, focusTerminal, openAssets: () => { void openAssets(); },
        autoSending: (conversation, name) => autoSending(conversation, name),
        partsFor: (name) => partsFor(name),
        hideSheets: () => { for (const id of ['panel', 'files', 'assets', 'settings', 'gitview', 'sharing', 'copy']) $(id).hidden = true; },
        pairNew: async (grants, label) => { await openCompose(grants.map((g) => [g.asset, g.rights])); $('sharing-label').value = label; sayChoice(); },
    });
    $('links-open').addEventListener('click', () => { void links?.open(); });
    $('assets-links').addEventListener('click', () => { $('assets').hidden = true; void links?.open(); });

    /* ---------- Settings: this device, and the platform ---------- */
    async function openSettings() {
        void paintAlerts().catch(() => {});
        void paintWords().catch(() => {});
        $('panel').hidden = $('files').hidden = $('sharing').hidden = $('assets').hidden = true;
        const [platform, saved] = await Promise.all([fetch(`${API}/platform`).then((r) => r.json()).catch(() => ({})), fetch(`${API}/shortcuts`).then((r) => r.json()).catch(() => [])]);
        const list = $('settings-shortcuts'); list.replaceChildren();
        for (const shortcut of saved) {
            const row = document.createElement('div'); row.className = 'folder';
            const label = document.createElement('b'); label.textContent = shortcut.label;
            const what = document.createElement('small'); what.className = 'hint'; what.textContent = ` ${shortcut.enter ? 'sent with Enter' : 'typed, left to be completed'}`; label.append(what);
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
            remove.addEventListener('click', async () => { await post(`${API}/shortcuts/${shortcut.id}/remove`).catch(() => {}); await openSettings(); void paintShortcuts(); });
            row.append(label, remove); list.append(row);
        }
        $('settings-dictation').textContent = platform.dictation ? `Speech is turned into text by "${platform.dictation}". It is set on the server (CLAVARIUM_TRANSCRIPTION_URL).` : 'No speech-to-text engine is set on the server: Dictate is not offered.';
        $('settings-people').textContent = (platform.operators ?? []).length
            ? `Who may sign in: ${platform.operators.join(', ')}. Address: ${platform.address ?? 'not declared'}. Both were set when this was installed.`
            : 'Development mode: anyone on this machine is the operator.';
        $('settings-about').textContent = `Clavarium ${platform.version ?? ''}`;
        $('settings').hidden = false;
        await Promise.all([paintHosts(), paintShelf()]);
    }
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
            lines.push(`Made ${day(r.current.builtAt)}${r.current.sizeMb ? `, ${(r.current.sizeMb / 1024).toFixed(1)} GB on disk` : ''}. Holds: ${r.current.tools.join(', ') || 'no tool'}.`);
            lines.push(r.current.fresh ? `Next rebuild around ${day(r.current.refreshAt)}.` : `Older than ${r.maxAgeDays} days: new conversations are built the long way until it is rebuilt.`);
        } else lines.push('None yet: new conversations are built the long way (several minutes).');
        if (r.building) lines.push(`Being rebuilt since ${new Date(r.building.since).toLocaleTimeString()} (${r.building.step}). New conversations use ${r.current ? 'the current one' : 'the long way'} meanwhile.`);
        if (r.error && !r.building) lines.push(`Last rebuild failed: ${r.error}`);
        $('shelf-state').textContent = lines.join(' ');
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
            const row = document.createElement('div'); row.className = 'folder'; row.dataset.host = h.host;
            const label = document.createElement('b'); label.textContent = h.host;
            const key = document.createElement('code'); key.textContent = `${h.type} ${h.fingerprint}`;
            const forget = document.createElement('button'); forget.type = 'button'; forget.textContent = 'Forget';
            forget.addEventListener('click', async () => {
                if (forget.dataset.sure !== 'yes') { forget.dataset.sure = 'yes'; forget.textContent = 'Yes, forget it: the next contact will trust whatever key this server shows'; return; }
                forget.disabled = true; $('git-hosts-error').hidden = true;
                try { await post(`${API}/git-hosts/forget`, { host: h.host }); } catch (error) { $('git-hosts-error').textContent = error.message; $('git-hosts-error').hidden = false; }
                await paintHosts();
            });
            row.append(label, key, forget); rows.append(row);
        }
    }
    $('settings-open').addEventListener('click', () => { void openSettings(); });
    $('settings-close').addEventListener('click', () => { $('settings').hidden = true; focusTerminal(); });
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
            /* A new repository opens on its card, where it is attached: the next thing to do. */
            assetOpen = `git:${made.name}`;
            if (made.firstSeen) {
                $('git-said').textContent = `${made.name} was cloned. First contact with ${hostOf(made.from)}: its host key (${made.firstSeen.join(', ')}) was recorded. A different key later will be refused.`;
                $('git-said').hidden = false;
            } else $('git-box').open = false;
        } catch (error) { $('git-error').textContent = error.message; $('git-error').hidden = false; }
        button.disabled = false; button.textContent = 'Add';
        await paintAssets();
    });
    /* ---------- a repository: what would go out, then send it ---------- */
    /* `gitTarget` is the branch the last look was made for: Send sends there
       and nowhere else; choosing another branch looks again first. */
    /* `gitBranch`: the agent's branch shown (the owner's pick in `gitAskedBranch`,
       else the one that moved last). `gitConfirm`: more than the page could
       show, so Send asks once more. `gitFsck`: the owner's fsck waivers. */
    let gitShown = ''; let gitHead = null; let gitTarget = null; let gitAsked = ''; let gitState = ''; let gitRequire = false;
    let gitBranch = null; let gitAskedBranch = ''; let gitConfirm = false; let gitFsck = {};
    const NEW_BRANCH = '\u0000new';
    function paintChecks(result) {
        const state = $('gitview-checks-state'); state.className = '';
        if (!result) { state.textContent = 'Running the checks in the agent\'s machine...'; $('gitview-checks-output').textContent = ''; return; }
        const where = result.machine ? ` (machine of ${result.machine})` : '';
        state.textContent = result.status === 'passed' ? `Checks passed in the agent's machine${where}.`
            : result.status === 'failed' ? `Checks FAILED in the agent's machine${where}.`
                : result.status === 'none' ? 'Nothing was checked: no pre-push hook, no check command.' : 'The checks could not run.';
        if (result.status === 'passed' || result.status === 'failed') state.className = result.status;
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
        gitRequire = s.requireForSend; gitFsck = s.fsck ?? {};
        $('gitview-runhook').checked = s.runHook; $('gitview-checkcommand').value = s.checkCommand; $('gitview-checkseconds').value = String(s.checkSeconds);
        $('gitview-require').checked = s.requireForSend; $('gitview-refreshminutes').value = String(s.refreshMinutes);
        $('gitview-alert').checked = s.alert;
        /* Which conversations send by themselves: set in each one's Access panel. */
        const senders = Object.entries(keep.auto ?? {});
        $('gitview-auto-where').textContent = `Automatic sending is set for each conversation, under its access to this repository (Write), in the conversation's Access panel. ${senders.length ? `Now: ${senders.map(([c, list]) => `${c} (${list.join(', ')})`).join('; ')}.` : 'Now: none.'}`;
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
        if (g.largest?.length) item(`Largest new files: ${g.largest.slice(0, 5).map((b) => `${b.path || '(no path)'} (${sizeText(b.size)})`).join(', ')}.`);
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
    async function paintGit() {
        const name = gitShown;
        $('gitview-name').textContent = `${name} - git repository`;
        $('gitview-error').hidden = true; $('gitview-push').hidden = true; $('gitview-check').hidden = true; $('gitview-checks').hidden = true;
        $('gitview-offer-row').hidden = true; $('gitview-guards').hidden = true; $('gitview-dropped').hidden = true;
        $('gitview-state').textContent = 'Looking at what was committed...';
        $('gitview-commits').replaceChildren(); $('gitview-stat').textContent = ''; $('gitview-diff').textContent = '';
        gitHead = null; gitTarget = null; gitState = ''; gitConfirm = false;
        const settings = await (await fetch(`${API}/git/${name}`)).json().catch(() => ({}));
        $('gitview-url').value = settings.remote ?? ''; $('gitview-user').value = settings.user ?? '';
        const keys = await fetch(`${API}/git-keys`).then((r) => r.json()).catch(() => []);
        const pick = $('gitview-sshkey'); pick.replaceChildren();
        for (const [value, text] of [['', '(none)'], ...keys.map((k) => [k.name, k.name])]) { const o = document.createElement('option'); o.value = value; o.textContent = text; pick.append(o); }
        pick.value = settings.sshKey ?? '';
        $('gitview-key-state').textContent = settings.hasKey ? 'A key is kept for this repository.'
            : settings.sshKey ? `Over ssh, the SSH key ${settings.sshKey} is used.` : 'No key is kept for sending: what the repository was cloned with is used, for the same server only; a remote that asks for more will refuse.';
        await paintKeep();
        let out;
        try {
            const query = new URLSearchParams();
            if (gitAsked) query.set('target', gitAsked);
            if (gitAskedBranch) query.set('branch', gitAskedBranch);
            const r = await fetch(`${API}/git/${name}/outgoing${query.size ? `?${query}` : ''}`);
            out = await r.json();
            if (!r.ok) throw Object.assign(new Error(out.error || 'The repository could not be read.'), { offer: out.offer });
        } catch (error) {
            $('gitview-state').textContent = ''; $('gitview-error').textContent = error.message; $('gitview-error').hidden = false;
            /* An fsck refusal the owner may waive (old histories only): offered, never done for them. */
            if (error.offer && gitShown === name) { $('gitview-offer').textContent = `Accept "${error.offer}" in this repository`; $('gitview-offer').dataset.id = error.offer; $('gitview-offer-row').hidden = false; }
            return;
        }
        if (gitShown !== name) return;
        gitHead = out.head; gitTarget = out.target; gitState = out.state; gitCommits = out.count === undefined ? out.commits.length : out.count; gitBranch = out.branch; gitConfirm = Boolean(out.guards?.confirm);
        fillBranches(out);
        paintGuards(out);
        $('gitview-target-row').hidden = !['ahead', 'up-to-date', 'diverged'].includes(out.state);
        fillTargets(out);
        $('gitview-state').textContent = out.message;
        $('gitview-remote-box').open = out.state === 'no-remote' || out.state === 'unreachable';
        for (const c of out.commits) {
            const line = document.createElement('div'); line.className = 'commit';
            const id = document.createElement('code'); id.textContent = c.id.slice(0, 8);
            const what = document.createElement('b'); what.textContent = c.subject;
            const who = document.createElement('small'); who.textContent = `${c.author}, ${new Date(c.date).toLocaleString()}`;
            line.append(id, what, who);
            /* The whole message: what a subject line leaves out is part of what is sent. */
            if (c.message && c.message !== c.subject) { const body = document.createElement('pre'); body.textContent = c.message.split('\n').slice(1).join('\n').trim(); if (body.textContent) line.append(body); }
            $('gitview-commits').append(line);
        }
        $('gitview-stat').textContent = out.stat;
        $('gitview-diff').textContent = out.diff + (out.cut ? '\n... (the rest is not shown here: too long)' : '');
        /* Before Send is shown, the checks run in the machine: their result
           is shown, and Send waits for them (it is refused without them only
           if the owner asked for that). */
        if (out.state === 'ahead') await runChecks();
    }
    async function openGit(name) { gitShown = name; gitAsked = ''; gitAskedBranch = ''; for (const id of ['panel', 'assets', 'settings', 'files', 'sharing']) $(id).hidden = true; $('gitview').hidden = false; await paintGit(); }
    $('gitview-close').addEventListener('click', () => { $('gitview').hidden = true; gitShown = ''; focusTerminal(); });
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
                requireForSend: $('gitview-require').checked, refreshMinutes: Number($('gitview-refreshminutes').value), alert: $('gitview-alert').checked,
            });
            $('gitview-keep-said').textContent = 'Saved.';
            await paintKeep();
            if (gitState === 'ahead') showSend($('gitview-checks-state').classList.contains('passed'), gitCommits);
        } catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
    });
    $('gitview-remote').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('gitview-error').hidden = true;
        try { await post(`${API}/git/${gitShown}/remote`, { url: $('gitview-url').value.trim(), user: $('gitview-user').value.trim(), key: $('gitview-key').value, ...(looksSsh($('gitview-url').value.trim()) && $('gitview-sshkey').value ? { sshKey: $('gitview-sshkey').value } : {}) }); $('gitview-key').value = ''; await paintGit(); }
        catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
    });

    $('mailbox-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('mailbox-error').hidden = true;
        const button = $('mailbox-new').querySelector('button[type=submit]');
        button.disabled = true; button.textContent = 'Reading the mailbox...';
        try {
            await post(`${API}/mailboxes`, { name: $('mailbox-name').value.trim(), host: $('mailbox-host').value.trim(), port: $('mailbox-port').value.trim(), user: $('mailbox-user').value.trim(), password: $('mailbox-password').value });
            $('mailbox-new').reset(); $('mailbox-box').open = false;
        } catch (error) { $('mailbox-error').textContent = error.message; $('mailbox-error').hidden = false; }
        button.disabled = false; button.textContent = 'Add';
        await paintAssets();
    });
    $('folder-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('assets-error').hidden = true;
        try { const made = await post(`${API}/resources`, { name: $('folder-name').value.trim() }); $('folder-name').value = ''; $('folder-box').open = false; if (made?.name) assetOpen = `folder:${made.name}`; }
        catch (error) { $('assets-error').textContent = error.message; $('assets-error').hidden = false; }
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
    $('copy-open').addEventListener('click', () => {
        $('files').hidden = $('panel').hidden = $('sharing').hidden = true;
        $('copy-text').value = screenText();
        $('copy-status').textContent = ''; $('paste-status').textContent = '';
        $('copy').hidden = false;
        /* Shown from its end: the last lines are what one comes for. */
        $('copy-text').scrollTop = $('copy-text').scrollHeight;
    });
    $('copy-close').addEventListener('click', () => { $('copy').hidden = true; focusTerminal(); });
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
        $('copy').hidden = true;
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
            $('copy-text').value = text; $('copy').hidden = false; focusField($('copy-text')); $('copy-text').select();
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
    /* The folders kept by the server and attached here: listed, downloaded,
       imported into. A file name is shown as text and never interpreted. */
    let filesOf = '';            /* the attached folder being shown */
    let filesAt = '';            /* the path inside it */
    const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
    const filesQuery = (extra = {}) => new URLSearchParams({ c: current, r: filesOf, p: filesAt, ...extra }).toString();
    async function paintFiles() {
        const ownerOthers = DEVICE ? [] : (await (await fetch(`${API}/resources`)).json().catch(() => [])).map((r) => ({ name: r.name, access: r.type === 'mailbox' ? 'read' : 'write', yours: true }));
        /* First, where the tool works -- when that is kept here; then what is attached. */
        const here = conversations.find((x) => x.name === current);
        const attachedHere = here?.resources ?? [];
        const mine = noTerminal() ? deviceShared.map((s) => ({ name: s.name, access: s.access, given: true })) : [...(here?.work === 'kept' ? [{ name: 'work', access: 'write', own: true }] : []), ...attachedHere,
            /* On a device: what it was given for itself, whatever the conversation. */
            ...deviceShared.filter((s) => !attachedHere.some((r) => r.name === s.name)).map((s) => ({ name: s.name, access: s.access, given: true })),
            /* For the owner: everything else that is kept here, attached to this conversation or not. */
            ...ownerOthers.filter((o) => !attachedHere.some((r) => r.name === o.name))];
        /* Given to the device to write, attached to the conversation to read: the larger of the two holds. */
        for (const r of mine) if (deviceShared.some((s) => s.name === r.name && s.access === 'write')) r.access = 'write';
        if (!mine.some((r) => r.name === filesOf)) { filesOf = mine[0]?.name ?? ''; filesAt = ''; }
        const tabs = $('files-tabs');
        tabs.replaceChildren();
        for (const r of mine) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = r.own ? 'work - where the tool works' : `${r.name} - ${r.access}${r.given ? ' (given to this device)' : r.yours ? ' (not attached here)' : ''}`; b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', r.name === filesOf ? 'true' : 'false');
            b.addEventListener('click', () => { filesOf = r.name; filesAt = ''; void paintFiles(); });
            tabs.append(b);
        }
        const rows = $('files-rows'); const path = $('files-path');
        rows.replaceChildren(); path.replaceChildren();
        $('files-none').hidden = mine.length > 0;
        $('files-error').hidden = true;
        const writable = mine.find((r) => r.name === filesOf)?.access === 'write';
        $('files-actions').hidden = !filesOf || !writable;
        $('files-readonly').hidden = !filesOf || writable;
        $('files-readonly').textContent = mine.find((r) => r.name === filesOf)?.given ? 'Given to this device to read: nothing can be added here.' : 'Attached read-only: nothing can be imported here.';
        $('files-empty').hidden = true;
        if (!filesOf) return;
        let listing;
        try {
            const r = await fetch(`${API}/files?${filesQuery()}`);
            listing = await r.json();
            if (!r.ok) throw new Error(listing.error || 'The folder could not be read.');
        } catch (error) { $('files-error').textContent = error.message; $('files-error').hidden = false; return; }
        filesAt = listing.path;
        /* The trail: the folder, then each level, each one a way back. */
        const parts = filesAt ? filesAt.split('/') : [];
        const crumb = (text, to) => {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
            b.addEventListener('click', () => { filesAt = to; void paintFiles(); });
            path.append(b);
        };
        crumb(filesOf, '');
        parts.forEach((part, i) => { path.append('/'); crumb(part, parts.slice(0, i + 1).join('/')); });
        for (const entry of listing.entries) {
            const inner = filesAt ? `${filesAt}/${entry.name}` : entry.name;
            const row = document.createElement(entry.folder ? 'button' : 'a');
            row.className = 'file'; row.dataset.folder = String(entry.folder);
            const kind = document.createElement('span'); kind.className = 'kind';
            kind.textContent = entry.folder ? 'DIR' : (entry.name.includes('.') ? entry.name.split('.').pop().slice(0, 4).toUpperCase() : 'FILE');
            const label = document.createElement('span'); label.className = 'label'; label.textContent = entry.name;
            const detail = document.createElement('small');
            detail.textContent = entry.folder ? 'open' : `${sizeOf(entry.size)} - view`;
            row.append(kind, label, detail);
            if (entry.folder) { row.type = 'button'; row.addEventListener('click', () => { filesAt = inner; void paintFiles(); }); }
            else {
                /* A click shows the file here; the address stays a plain download for "open in a new tab". */
                row.href = `${API}/files/download?${filesQuery({ p: inner })}`;
                row.addEventListener('click', (event) => { event.preventDefault(); void preview(filesOf, inner, entry.name, entry.size); });
            }
            rows.append(row);
        }
        $('files-empty').hidden = listing.entries.length > 0;
    }
    /* ---------- a file, shown here ---------- */
    /* WHAT IS SHOWN MAY HAVE BEEN WRITTEN BY A TOOL. So a file is never
       opened as a page of this site: a picture is drawn as a picture, text is
       shown as text, a PDF is drawn on a canvas by this page. Anything else
       is offered for download, and nothing is ever run. */
    const PREVIEW_MAX = 25 * 1024 * 1024;
    const TEXT_MAX = 1024 * 1024;
    const PICTURES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const TEXTS = ['txt', 'md', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'mjs', 'ts', 'py', 'sh', 'sql', 'c', 'h', 'go', 'rs', 'java', 'rb', 'php', 'tex', 'eml'];
    const PDF_PAGES = 30;
    let shownUrl = null;
    /* The file is shown in a WINDOW over the screen, wherever it was asked
       from: closing it leaves the terminal, or the list, as it was. */
    function closePreview() {
        if (shownUrl) { URL.revokeObjectURL(shownUrl); shownUrl = null; }
        $('preview-body').replaceChildren();
        $('viewer').hidden = true;
        if ($('files').hidden && $('panel').hidden) focusTerminal();
    }
    /* `tab`, `inner`: its place in a folder kept here. `from`: an address to
       read it at instead (a file of the machine's own disk). */
    async function preview(tab, inner, name, size, from) {
        closePreview();
        const address = from ?? `${API}/files/download?${new URLSearchParams({ c: current, r: tab, p: inner })}`;
        $('preview-name').textContent = name;
        $('preview-download').href = address; $('preview-download').setAttribute('download', name);
        /* From the terminal, a way to the folder it sits in. */
        $('preview-where').hidden = Boolean(from) || !$('files').hidden || noTerminal();
        $('preview-where').onclick = async () => {
            closePreview();
            filesOf = tab; filesAt = inner.split('/').slice(0, -1).join('/');
            $('panel').hidden = true; await paintFiles(); $('files').hidden = false;
        };
        $('viewer').hidden = false;
        /* A file read from the machine's disk says so, whatever else is said. */
        const origin = from ? 'Read from the disk of the machine: this file is not kept here, and goes with the machine.' : '';
        const note = (text) => { const all = [text, text === 'Loading...' ? '' : origin].filter(Boolean).join(' '); $('preview-note').textContent = all; $('preview-note').hidden = !all; };
        const kind = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        const known = PICTURES[kind] || kind === 'pdf' || TEXTS.includes(kind);
        if (!known) { note('This kind of file is not shown here. Download it to open it.'); return; }
        if (size > (TEXTS.includes(kind) ? TEXT_MAX : PREVIEW_MAX)) { note(`This file is too large to be shown here (${sizeOf(size)}). Download it to open it.`); return; }
        note('Loading...');
        let bytes;
        try {
            const r = await fetch(address);
            if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The file could not be read.');
            bytes = await r.arrayBuffer();
        } catch (error) { note(error.message); return; }
        if ($('viewer').hidden || $('preview-name').textContent !== name) return;      /* closed meanwhile */
        const body = $('preview-body');
        if (PICTURES[kind]) {
            shownUrl = URL.createObjectURL(new Blob([bytes], { type: PICTURES[kind] }));
            const img = document.createElement('img'); img.alt = name; img.src = shownUrl;
            body.append(img); note('');
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
            } catch { body.replaceChildren(); note('This PDF could not be shown here. Download it to open it.'); }
        } else {
            const source = () => { const pre = document.createElement('pre'); pre.textContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes); return pre; };
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
            } else { body.append(source()); note(offline && (kind === 'html' || kind === 'htm') ? 'This conversation is offline: its page is shown as text, not run.' : ''); }
        }
    }
    $('preview-close').addEventListener('click', closePreview);
    /* Outside the window, or Escape: closed too. */
    $('viewer').addEventListener('click', (event) => { if (event.target === $('viewer')) closePreview(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('viewer').hidden) { event.preventDefault(); event.stopPropagation(); closePreview(); } }, true);

    /* ---------- a path the tool printed, opened here ---------- */
    /* THE PAGE reads its own screen for this, never the server: a path under
       /work/ or /resources/<folder>/ that is on the screen can be clicked or
       tapped, and opens in Files. Only those two places exist here; anything
       else on the machine's disk is said to be out of reach. */
    const PATH_ONLY = /^\/(?:work|resources\/[a-z][a-z0-9-]{0,31})(?:\/[A-Za-z0-9._@+%~-]+)+$/;
    const PATH = /\/(?:work|resources\/[a-z][a-z0-9-]{0,31})(?:\/[A-Za-z0-9._@+%~-]+)+/g;
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
            notice.hidden = true; $('panel').hidden = true;
            filesOf = tab; filesAt = inner;
            await paintFiles();
            $('files').hidden = false;
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

    $('files-open').addEventListener('click', async () => { for (const id of ['panel', 'assets', 'settings', 'sharing', 'gitview']) $(id).hidden = true; await paintFiles(); $('files').hidden = false; });
    $('files-close').addEventListener('click', () => { $('files').hidden = true; focusTerminal(); });
    $('files-import').addEventListener('click', () => $('files-pick').click());
    $('files-pick').addEventListener('change', async () => {
        const status = $('files-status');
        $('files-error').hidden = true;
        for (const file of $('files-pick').files) {
            status.textContent = `Importing ${file.name}...`;
            try {
                const r = await fetch(`${API}/files/import?${filesQuery({ name: file.name })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || 'The import failed.');
                status.textContent = `Imported as ${j.name}.`;
            } catch (error) { status.textContent = ''; $('files-error').textContent = `${file.name}: ${error.message}`; $('files-error').hidden = false; }
        }
        $('files-pick').value = '';
        await paintFiles();
    });

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
    const KIND_WORD = { conversation: 'conversation', folder: 'folder', git: 'repository', mailbox: 'mailbox' };
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
    const face = (which) => { for (const id of ['share-compose', 'share-code', 'share-manage']) $(id).hidden = id !== `share-${which}`; for (const timer of codeTimers) clearInterval(timer); codeTimers = []; };

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
            const off = document.createElement('small'); off.className = 'hint parts-off'; off.textContent = 'Its chat is off: the device sees it once you turn it on (General).';
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
    /* `start`: [[asset, rights], ...] put in the basket; `target`: a paired device to change instead of a new one. */
    async function openCompose(start = [], target = '') {
        await Promise.all([loadCatalog(), readDevices()]);
        shareTarget = target; shareKind = '';
        basket = new Map(target ? sharedDevices.find((d) => d.id === target)?.grants.map((g) => [g.asset, g.rights]) ?? [] : []);
        for (const [asset, rights] of start) basket.set(asset, rights);
        $('sharing-label').value = ''; $('share-search').value = ''; $('sharing-error').hidden = true;
        $('sharing-title').textContent = 'Share';
        for (const id of ['panel', 'files', 'assets', 'settings', 'gitview']) $(id).hidden = true;
        paintCompose(); face('compose');
        $('sharing').hidden = false;
    }
    $('sharing-label').addEventListener('input', sayChoice);
    $('share-search').addEventListener('input', paintCompose);

    /* Who has what. */
    function takeBack(button, question, run) {
        const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = question;
        const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep';
        keep.addEventListener('click', () => { void paintManage(); });
        sure.addEventListener('click', async () => { await run().catch(() => {}); await paintManage(); void refresh(); });
        button.replaceWith(sure, keep);
    }
    function grantRow(device, g) {
        const [type, name] = g.asset.split(':');
        const row = document.createElement('div'); row.className = 'given-row'; row.dataset.asset = g.asset;
        const label = document.createElement('span'); label.textContent = name;
        const kind = document.createElement('small'); kind.className = 'hint'; kind.textContent = ` ${KIND_WORD[type] ?? type}`; label.append(kind);
        const right = rightControl(type, name, g.rights, async (value) => { await post(`${API}/devices/${device.id}/give`, { asset: g.asset, rights: value }).catch(() => {}); await paintManage(); }, `What ${device.label} may do with ${name}`);
        const take = document.createElement('button'); take.type = 'button'; take.textContent = 'Take back';
        take.addEventListener('click', () => takeBack(take, `Take ${name} back from ${device.label}`, () => post(`${API}/devices/${device.id}/take`, { asset: g.asset })));
        row.append(label, right, take);
        return row;
    }
    let manageBy = 'device';
    async function paintManage() {
        await readDevices();
        $('share-by-device').setAttribute('aria-pressed', String(manageBy === 'device')); $('share-by-thing').setAttribute('aria-pressed', String(manageBy === 'thing'));
        const rows = $('sharing-devices'); rows.replaceChildren(); rows.hidden = manageBy !== 'device';
        const things = $('share-things'); things.replaceChildren(); things.hidden = manageBy !== 'thing';
        $('sharing-none').hidden = sharedDevices.length > 0;
        if (manageBy === 'device') {
            for (const device of [...sharedDevices].sort((a, b2) => String(b2.seenAt ?? '').localeCompare(String(a.seenAt ?? '')))) {
                const card = document.createElement('div'); card.className = 'device'; card.dataset.device = device.id;
                const name = document.createElement('b'); name.textContent = device.label;
                const rename = document.createElement('button'); rename.type = 'button'; rename.textContent = 'Rename';
                rename.addEventListener('click', () => {
                    const field = document.createElement('input'); field.value = device.label; field.maxLength = 40; field.setAttribute('aria-label', 'Name of this device');
                    const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
                    const done = async () => { if (field.value.trim()) await post(`${API}/devices/${device.id}/rename`, { label: field.value.trim() }).catch(() => {}); await paintManage(); };
                    save.addEventListener('click', () => { void done(); });
                    field.addEventListener('keydown', (event) => { if (event.key === 'Enter') void done(); event.stopPropagation(); });
                    name.replaceWith(field); rename.replaceWith(save); focusField(field); if (document.activeElement === field) field.select();
                });
                const seen = document.createElement('small'); seen.textContent = `${ago(device.seenAt)}, paired ${new Date(device.createdAt).toLocaleDateString()}`;
                if (!device.seenAt) seen.className = 'warn';
                const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Revoke device';
                revoke.addEventListener('click', () => takeBack(revoke, `Revoke ${device.label}: it loses all ${device.grants.length} thing${device.grants.length > 1 ? 's' : ''}, now`, () => post(`${API}/devices/${device.id}/revoke`)));
                const head = document.createElement('div'); head.className = 'device-head'; head.append(name, rename, seen, revoke);
                const given = document.createElement('div'); given.className = 'given';
                for (const g of device.grants) given.append(grantRow(device, g));
                const more = document.createElement('button'); more.type = 'button'; more.textContent = '+ Give more';
                more.addEventListener('click', () => { void openCompose([], device.id); });
                card.append(head, given, more); rows.append(card);
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
    async function openManage() {
        for (const id of ['panel', 'files', 'assets', 'settings', 'gitview']) $(id).hidden = true;
        $('sharing-title').textContent = 'Devices & sharing';
        face('manage'); await paintManage();
        $('sharing').hidden = false;
    }
    $('share-by-device').addEventListener('click', () => { manageBy = 'device'; void paintManage(); });
    $('share-by-thing').addEventListener('click', () => { manageBy = 'thing'; void paintManage(); });
    $('share-new-device').addEventListener('click', () => { void openCompose(); });
    $('sharing-open').addEventListener('click', () => { void openManage(); });
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
                take.replaceWith(sure, keep);
            });
            row.append(label, right, take); box.append(row);
        }
        $('share-here-none').hidden = box.children.length > 0;
    }
    $('sharing-close').addEventListener('click', () => { face('compose'); $('sharing').hidden = true; focusTerminal(); void refresh(); });

    $('sharing-new').addEventListener('click', async () => {
        $('sharing-error').hidden = true;
        try {
            if (shareTarget) {
                /* A device already paired: what changed is given or taken, and that is all. */
                const before = new Map(sharedDevices.find((d) => d.id === shareTarget).grants.map((g) => [g.asset, g.rights]));
                for (const [asset, rights] of basket) if (before.get(asset) !== rights) await post(`${API}/devices/${shareTarget}/give`, { asset, rights });
                for (const asset of before.keys()) if (!basket.has(asset)) await post(`${API}/devices/${shareTarget}/take`, { asset });
                await openManage(); void refresh();
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
    $('share-done').addEventListener('click', () => { void openManage(); void refresh(); });

    /* ---------- resting and archiving ---------- */
    $('sleep').addEventListener('click', async () => {
        const name = current;
        $('panel').hidden = true;
        disconnect();
        say('going to sleep', 'connecting');
        show('Going to sleep...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/sleep`); await refresh(); enter(); }
        catch (error) { say('awake', 'ended'); show(error.message, 'Back to the terminal', connect); }
    });
    async function rebuild() {
        const name = current;
        disconnect();
        say('building', 'connecting'); show('Building its machine again...');
        try { await post(`${API}/conversations/${encodeURIComponent(name)}/rebuild`); await refresh(); enter(); }
        catch (error) { show(error.message, 'Close', enter); }
    }
    async function archive(confirmed) {
        const name = current;
        $('panel').hidden = true;
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
    $('back').addEventListener('click', () => select(''));

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
    const asApp = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let installEvent = null;
    let installOffered = false;
    const offerInstall = () => { installOffered = true; $('install').hidden = false; };
    addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installEvent = event; offerInstall(); });
    addEventListener('appinstalled', () => { installEvent = null; installOffered = false; $('install').hidden = true; });
    if (apple && !asApp) offerInstall();
    $('install').addEventListener('click', async () => {
        const back = () => { notice.hidden = true; focusTerminal(); };
        if (installEvent) {
            const asked = installEvent; installEvent = null;
            asked.prompt();
            const choice = await asked.userChoice.catch(() => ({ outcome: 'dismissed' }));
            if (choice.outcome === 'accepted') { installOffered = false; $('install').hidden = true; }
            else installEvent = asked;
            return;
        }
        show(DEVICE
            ? 'To install it: touch the Share button of the browser (the square with an arrow), then "Add to Home Screen". IMPORTANT, on an iPhone or iPad: the installed app does not share anything with this page, so it will ask to be paired again -- ask the person who shared this conversation for a new code, and open it once the app is installed.'
            : 'To install it: touch the Share button of the browser (the square with an arrow), then "Add to Home Screen". The app will ask you to sign in once.',
        'Back', back);
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
                $('name').textContent = 'Shared files'; document.title = 'Shared files - Clavarium';
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
            return;
        } else {
            view(current ? 'room' : 'list');
            if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
        }
        await refresh();
        if (!home) { view('room'); if (!NAME.test(current)) current = ''; }
        enter();
    }
    void start();
})();
