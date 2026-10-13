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
    const KEYS = { esc: '\x1b', tab: '\t', enter: '\r', stop: '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

    /* A paired device gets the same page with less in it, and asks its own
       door: see server/door.mjs. */
    const DEVICE = document.documentElement.dataset.door === 'device';
    /* On a paired device, every request names the pairing it speaks for:
       the address is completed once the device has signed in. */
    let API = DEVICE ? '/c/api' : '/api';
    let pairing = '';
    let deviceShared = [];
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
        notice.hidden = false;
    };
    const view = (which) => { app.dataset.view = which; };

    /* ---------- the terminal ---------- */
    const terminal = new Terminal({
        cursorBlink: true, scrollback: 5000,
        fontSize: innerWidth < 500 ? 11 : 14,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: { background: '#0f141a' },
    });
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
        fit.fit(); terminal.focus();
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
        terminal.focus();
    });
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open($('terminal'));
    if (!DEVICE) applyFold(listFolded);
    fit.fit();
    window.clavariumTerminal = terminal; /* for the end-to-end proof */

    const encoder = new TextEncoder();
    const send = (text) => { if (socket?.readyState === 1) socket.send(encoder.encode(text)); };
    const sendSize = () => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    const disconnect = () => { wanted = false; socket?.close(); socket = undefined; stopVoice?.(); };

    function connect() {
        disconnect();
        if (!NAME.test(current)) return;
        const name = current;
        wanted = true;
        notice.hidden = true;
        say('connecting', 'connecting');
        fit.fit();
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const where = DEVICE ? `/c/terminal?d=${pairing}&c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}` : `/terminal?c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`;
        const mine = new WebSocket(`${scheme}://${location.host}${where}`);
        socket = mine;
        mine.binaryType = 'arraybuffer';
        let failure = ''; let machineGone = false;
        /* Open means the bridge answered, not that the machine is awake yet. */
        mine.onopen = () => { say('opening', 'connecting'); terminal.focus(); };
        mine.onmessage = (event) => {
            /* Binary is terminal output. Text is the bridge talking to the page. */
            if (typeof event.data !== 'string') {
                /* Output is the proof the terminal is there: "waking" is over. */
                if (state.dataset.state !== 'live') {
                    say('live', 'live');
                    notice.hidden = true;
                    /* Asking for the size again makes the tool redraw whole:
                       after a re-attach the first typed line was misplaced. */
                    setTimeout(() => { fit.fit(); sendSize(); }, 300);
                }
                terminal.write(new Uint8Array(event.data));
                return;
            }
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === 'ready') { say('live', 'live'); notice.hidden = true; setTimeout(() => { fit.fit(); sendSize(); }, 300); }
            if (message.type === 'status') {
                say(String(message.text), 'connecting');
                /* In the middle of the screen too: a small word in the header is
                   not enough for a wait that can last minutes (a tester waited
                   three, with nothing else to read). */
                show(`${message.text} This can take a few minutes: the machine was stopped.`);
            }
            if (message.type === 'error') { failure = String(message.text); machineGone = message.gone === true; }
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
                else show(failure || 'The terminal could not be opened.', 'Try again', connect);
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
    for (const button of document.querySelectorAll('#keys button')) {
        button.addEventListener('click', () => { send(KEYS[button.dataset.keys]); terminal.focus(); });
    }

    /* ---------- the on-screen keyboard, on demand ---------- */
    /* On a phone or a tablet, a finger on the terminal used to call the
       on-screen keyboard every time -- to scroll, to tap a path, to look --
       and it took half the screen from someone who did not want to type
       (said by the owner). The terminal still takes the focus, so the key
       row, the shortcuts, dictation and a real keyboard go on working; but
       the browser is told NOT to raise its keyboard (inputmode "none", the
       standard way, nothing to do with which tool runs). "Keyboard" raises
       it, and puts it away again. */
    const touchScreen = matchMedia('(pointer: coarse)').matches;
    let keyboardWanted = false;
    const applyKeyboard = () => {
        const field = terminal.textarea;
        if (!field || !touchScreen) return;
        field.setAttribute('inputmode', keyboardWanted ? 'text' : 'none');
        $('kbd').setAttribute('aria-pressed', String(keyboardWanted));
        $('kbd').textContent = keyboardWanted ? 'Hide keyboard' : 'Keyboard';
    };
    if (touchScreen) {
        $('kbd').hidden = false;
        applyKeyboard();
        $('kbd').addEventListener('click', () => {
            keyboardWanted = !keyboardWanted;
            /* A browser reads the hint when the field takes the focus: it is
               let go and taken again, so that the change is seen at once. */
            terminal.blur();
            applyKeyboard();
            terminal.focus();
        });
    }

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
        $('sleep').hidden = !usable || c.asleep === true;
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
        if (home && current) void paintShortcuts();
        if (!current) { disconnect(); terminal.reset(); say('', 'ended'); show(home ? 'Choose a conversation, or create one.' : 'This address names no conversation.'); return; }
        if (home && !c) { disconnect(); say('unknown', 'ended'); show('No such conversation.'); return; }
        const usable = Boolean(c) && c.phase === 'ready';
        $('shortcuts').hidden = $('keys').hidden = !current || (home && !usable);
        if (c && c.phase === 'building') {
            disconnect(); say('building', 'connecting');
            const minutes = c.buildingSince ? Math.floor((Date.now() - Date.parse(c.buildingSince)) / 60000) : 0;
            show(`${c.step ?? 'Building'}... (${minutes < 1 ? 'started less than a minute ago' : `${minutes} min so far`}; a new machine takes a few minutes)`);
            return;
        }
        if (c && c.phase === 'moving') { disconnect(); say('moving', 'connecting'); show(`Moving its work: ${c.step ?? 'working'}... The tool is stopped meanwhile and starts again by itself.`); return; }
        if (c && c.phase === 'failed') { disconnect(); say('failed', 'ended'); show(c.error ?? 'This conversation could not be built.', DEVICE ? undefined : 'Build it again', () => void rebuild()); return; }
        /* Asleep because somebody asked: it stays asleep until somebody asks. */
        if (c && c.asleep === true && !socket) { say('asleep', 'waiting'); show('Asleep. The tool is frozen as it was.', 'Wake it', connect); return; }
        if (!socket) { terminal.reset(); connect(); }
        void watchSignIn();
    }
    function select(name) {
        if (name !== current) { disconnect(); terminal.reset(); }
        current = name;
        history.replaceState(null, '', name ? `?c=${encodeURIComponent(name)}` : location.pathname);
        view(name ? 'room' : 'list');
        paint();
        enter();
    }

    /* ---------- the list ---------- */
    const post = async (path, body) => {
        const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The request failed.');
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
            if (c.answerer?.on) { const mark = document.createElement('small'); mark.className = c.answerer.needs ? 'needs-mark' : 'shared-mark'; mark.textContent = c.answerer.needs ? 'asks for you' : 'answered in your place'; b.append(mark); }
            /* Seen at a glance: this conversation is in other hands too. */
            const holders = sharedDevices.filter((d) => d.grants.some((g) => g.asset === `conversation:${c.name}`)).length;
            if (holders > 0) { const mark = document.createElement('small'); mark.className = 'shared-mark'; mark.textContent = `shared with ${holders} device${holders > 1 ? 's' : ''}`; b.append(mark); }
            b.addEventListener('click', () => select(c.name));
            items.append(b);
        }
        $('empty').hidden = conversations.length > 0;
        $('sharing-open').hidden = $('assets-open').hidden = $('settings-open').hidden = DEVICE;
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
            paint();
            paintChips();
            const now = mark(conversations.find((x) => x.name === current));
            paintActions();
            if (before !== now || now.startsWith('building')) enter(true);
        } catch { /* a server without VMs has no list: the page is one terminal */ }
        /* The panel is open: what the answerer did meanwhile is said there. */
        if (!DEVICE && !$('panel').hidden) { void paintAnswerer(); paintWakeups(); }
        if (home) pollTimer = setTimeout(refresh, conversations.some((c) => c.phase === 'building' || c.phase === 'moving') ? 2500 : 10000);
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
        $('create-name').focus();
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
        $('shortcuts').hidden = !current;
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
                terminal.focus();
            });
            row.append(b);
        }
        const quiet = (text, run) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = text; b.addEventListener('click', run); row.append(b); };
        if (DEVICE) return;
        if (removing) quiet('Done', () => { removing = false; void paintShortcuts(); });
        else {
            quiet('+ Shortcut', () => { $('shortcut-new').hidden = false; $('shortcut-error').hidden = true; $('shortcut-enter').checked = true; $('shortcut-label').focus(); });
            if (all.length > 0) quiet('Remove...', () => { removing = true; void paintShortcuts(); });
        }
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
       the person has stopped: a new phrase beginning cancels the pending Enter. */
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
    $('mic').addEventListener('click', async () => {
        if (stopListening) { stopVoice(); terminal.focus(); return; }
        try {
            stopListening = await window.clavariumVoice.listen({
                state: (word) => sayVoice(WORDS[word] ?? word, word),
                speech: () => clearTimeout(enterTimer),
                phrase: (text) => {
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
        terminal.focus();
    });
    $('auto').addEventListener('click', () => {
        autoEnter = !autoEnter;
        $('auto').setAttribute('aria-pressed', String(autoEnter));
        if (!autoEnter) clearTimeout(enterTimer);
        terminal.focus();
    });
    async function offerVoice() {
        const available = window.clavariumVoice ? await window.clavariumVoice.available() : false;
        $('mic').hidden = $('auto').hidden = !available;
    }
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
    const attachTo = async (conversation, name, access, errorId = 'panel-error') => {
        $(errorId).hidden = true;
        try { await post(`${API}/conversations/${encodeURIComponent(conversation)}/resources`, { resource: name, access }); }
        catch (error) { $(errorId).textContent = error.message; $(errorId).hidden = false; }
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
                }, () => { notice.hidden = true; terminal.focus(); });
        };
        void paintAnswerer(); paintWakeups();
        const offline = here?.offline === true;
        for (const b of $('network').children) b.setAttribute('aria-pressed', String((b.dataset.online === 'true') !== offline));
        await paintSignIn();
    }
    /* ---------- the simple screen: the same conversation, without its terminal ---------- */
    /* For whoever does not read a terminal. The terminal stays where it is,
       underneath, attached as always: what is written in the box is typed
       into it, and what it shows is read here BY THIS PAGE, from its own
       screen, as plain text. The server reads nothing more than before. */
    let simple = false;
    try { const kept = localStorage.getItem('clavarium-simple'); if (kept !== null) simple = kept === '1'; } catch { /* a private window */ }
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
        $('room').toggleAttribute('data-simple', simple);
        $('simple-toggle').setAttribute('aria-pressed', String(simple));
        $('simple-toggle').textContent = simple ? 'Its screen' : 'Simple';
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
        try { localStorage.setItem('clavarium-simple', simple ? '1' : '0'); } catch { /* as above */ }
        simpleFilesAt = 0; paintSimple();
        if (!simple) terminal.focus();
    });
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
        if (often === 'custom') { $('wakeup-line').focus(); return; }
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
        $('panel').hidden = false;
        if (picking) $('attach-picker').scrollIntoView({ block: 'nearest' });
    }
    $('folders').addEventListener('click', () => { void openAccess(false); });
    $('attach-open').addEventListener('click', () => { $('attach-picker').hidden = false; $('attach-picker').scrollIntoView({ block: 'nearest' }); });
    $('attach-close').addEventListener('click', () => { $('attach-picker').hidden = true; });
    $('attach-manage').addEventListener('click', () => { void openAssets(); });
    $('chips').addEventListener('click', () => { if (!DEVICE && current) void openAccess(false); });
    $('panel-close').addEventListener('click', () => { $('panel').hidden = true; terminal.focus(); });

    /* ---------- Assets: everything kept here ---------- */
    let assetsKind = ''; let assetOpen = '';
    async function paintAssets() {
        const [all, boxes, secrets] = await Promise.all([
            fetch(`${API}/resources`).then((r) => r.json()), fetch(`${API}/mailboxes`).then((r) => r.json()).catch(() => []), fetch(`${API}/secrets`).then((r) => r.json()).catch(() => []), readDevices()]);
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
            given.textContent = [holders.length ? `on ${holders.map((d) => d.label).join(', ')}` : '', box ? (box.failure ? box.failure : `${box.messages} message(s)`) : '', kind === 'git' && resource.from ? `from ${new URL(resource.from).hostname}` : ''].filter(Boolean).join(' - ');
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
    }
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
    $('assets-close').addEventListener('click', () => { $('assets').hidden = true; terminal.focus(); });

    /* ---------- Settings: this device, and the platform ---------- */
    async function openSettings() {
        void paintAlerts().catch(() => {});
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
    }
    $('settings-open').addEventListener('click', () => { void openSettings(); });
    $('settings-close').addEventListener('click', () => { $('settings').hidden = true; terminal.focus(); });
    $('git-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('git-error').hidden = true;
        const button = $('git-new').querySelector('button[type=submit]');
        button.disabled = true; button.textContent = $('git-from').value.trim() ? 'Cloning...' : 'Making...';
        try {
            await post(`${API}/resources`, { name: $('git-name').value.trim(), type: 'git', from: $('git-from').value.trim() });
            $('git-new').reset(); $('git-box').open = false;
        } catch (error) { $('git-error').textContent = error.message; $('git-error').hidden = false; }
        button.disabled = false; button.textContent = 'Add';
        await paintAssets();
    });
    /* ---------- a repository: what would go out, then send it ---------- */
    let gitShown = ''; let gitHead = null;
    async function paintGit() {
        const name = gitShown;
        $('gitview-name').textContent = `${name} - git repository`;
        $('gitview-error').hidden = true; $('gitview-push').hidden = true;
        $('gitview-state').textContent = 'Looking at what was committed...';
        $('gitview-commits').replaceChildren(); $('gitview-stat').textContent = ''; $('gitview-diff').textContent = '';
        const settings = await (await fetch(`${API}/git/${name}`)).json().catch(() => ({}));
        $('gitview-url').value = settings.remote ?? ''; $('gitview-user').value = settings.user ?? '';
        $('gitview-key-state').textContent = settings.hasKey ? 'A key is kept for this repository.' : 'No key is kept: a remote that asks for one will refuse.';
        let out;
        try {
            const r = await fetch(`${API}/git/${name}/outgoing`);
            out = await r.json();
            if (!r.ok) throw new Error(out.error || 'The repository could not be read.');
        } catch (error) { $('gitview-state').textContent = ''; $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; return; }
        if (gitShown !== name) return;
        gitHead = out.head;
        $('gitview-state').textContent = out.message;
        $('gitview-remote-box').open = out.state === 'no-remote' || out.state === 'unreachable';
        for (const c of out.commits) {
            const line = document.createElement('div'); line.className = 'commit';
            const id = document.createElement('code'); id.textContent = c.id.slice(0, 8);
            const what = document.createElement('b'); what.textContent = c.subject;
            const who = document.createElement('small'); who.textContent = `${c.author}, ${new Date(c.date).toLocaleString()}`;
            line.append(id, what, who); $('gitview-commits').append(line);
        }
        $('gitview-stat').textContent = out.stat;
        $('gitview-diff').textContent = out.diff + (out.cut ? '\n... (the rest is not shown here: too long)' : '');
        $('gitview-push').hidden = out.state !== 'ahead';
        $('gitview-push').textContent = `Send ${out.commits.length} commit${out.commits.length > 1 ? 's' : ''} to ${out.branch}`;
        $('gitview-push').dataset.sure = '';
    }
    async function openGit(name) { gitShown = name; for (const id of ['panel', 'assets', 'settings', 'files', 'sharing']) $(id).hidden = true; $('gitview').hidden = false; await paintGit(); }
    $('gitview-close').addEventListener('click', () => { $('gitview').hidden = true; gitShown = ''; terminal.focus(); });
    $('gitview-again').addEventListener('click', () => { void paintGit(); });
    $('gitview-push').addEventListener('click', async () => {
        const button = $('gitview-push');
        /* Two clicks: what leaves cannot be called back. */
        if (button.dataset.sure !== 'yes') { button.dataset.sure = 'yes'; button.textContent = 'Yes, send them: this cannot be undone'; return; }
        button.disabled = true; $('gitview-error').hidden = true;
        try { const sent = await post(`${API}/git/${gitShown}/push`, { head: gitHead }); await paintGit(); $('gitview-state').textContent = `Sent: ${sent.commits} commit${sent.commits > 1 ? 's' : ''} to ${sent.branch}. ${$('gitview-state').textContent}`; }
        catch (error) { $('gitview-error').textContent = error.message; $('gitview-error').hidden = false; }
        button.disabled = false;
    });
    $('gitview-remote').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('gitview-error').hidden = true;
        try { await post(`${API}/git/${gitShown}/remote`, { url: $('gitview-url').value.trim(), user: $('gitview-user').value.trim(), key: $('gitview-key').value }); $('gitview-key').value = ''; await paintGit(); }
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
        try { await post(`${API}/resources`, { name: $('folder-name').value.trim() }); $('folder-name').value = ''; $('folder-box').open = false; }
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
    $('copy-close').addEventListener('click', () => { $('copy').hidden = true; terminal.focus(); });
    $('copy-all').addEventListener('click', async () => {
        const field = $('copy-text');
        try { await navigator.clipboard.writeText(field.value); $('copy-status').textContent = 'Copied.'; }
        catch {
            /* No clipboard permission: select it all, the person copies. */
            field.focus(); field.select();
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
        terminal.focus();
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
        } catch { $('paste-status').textContent = 'This browser did not let the page read what you copied. Use the field below.'; $('paste-text').focus(); }
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
            $('copy-text').value = text; $('copy').hidden = false; $('copy-text').focus(); $('copy-text').select();
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
        const mine = [...(here?.work === 'kept' ? [{ name: 'work', access: 'write', own: true }] : []), ...attachedHere,
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
        if ($('files').hidden && $('panel').hidden) terminal.focus();
    }
    /* `tab`, `inner`: its place in a folder kept here. `from`: an address to
       read it at instead (a file of the machine's own disk). */
    async function preview(tab, inner, name, size, from) {
        closePreview();
        const address = from ?? `${API}/files/download?${new URLSearchParams({ c: current, r: tab, p: inner })}`;
        $('preview-name').textContent = name;
        $('preview-download').href = address; $('preview-download').setAttribute('download', name);
        /* From the terminal, a way to the folder it sits in. */
        $('preview-where').hidden = Boolean(from) || !$('files').hidden;
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
        const back = () => { notice.hidden = true; terminal.focus(); };
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
    $('files-close').addEventListener('click', () => { $('files').hidden = true; terminal.focus(); });
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
        const whole = [...basket].filter(([, r]) => r === 'x').map(([a]) => a.split(':')[1]);
        const rest = [...basket].filter(([, r]) => r !== 'x').map(([a, r]) => `${r === 'rw' ? 'change' : 'read'} ${a.split(':')[1]}`);
        const parts = [whole.length ? `use ${whole.join(', ')} - the whole terminal, as root in its machine, with the files of that conversation` : '', rest.join(', ')].filter(Boolean);
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
            const right = type === 'folder' || type === 'git' ? levelControl(rights, (value) => { basket.set(asset, value); paintCompose(); }, `What it may do with ${name}`) : fixedRight(type);
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
                plus.addEventListener('click', () => { basket.set(c.asset, c.type === 'conversation' ? 'x' : 'r'); paintCompose(); });
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
        const right = type === 'folder' || type === 'git'
            ? levelControl(g.rights, async (value) => { await post(`${API}/devices/${device.id}/give`, { asset: g.asset, rights: value }).catch(() => {}); await paintManage(); }, `What ${device.label} may do with ${name}`)
            : fixedRight(type);
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
                    name.replaceWith(field); rename.replaceWith(save); field.focus(); field.select();
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
            give.addEventListener('click', () => { void openCompose([[c.asset, c.type === 'conversation' ? 'x' : 'r']]); });
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
    $('share').addEventListener('click', () => { void openCompose([[`conversation:${current}`, 'x']]); });
    $('sharing-close').addEventListener('click', () => { face('compose'); $('sharing').hidden = true; terminal.focus(); void refresh(); });

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
            const resume = socket ? () => { notice.hidden = true; terminal.focus(); } : enter;
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
        const back = () => { notice.hidden = true; terminal.focus(); };
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
    $('others-close').addEventListener('click', () => { $('others-sheet').hidden = true; terminal.focus(); });
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
                show(`You are connected to "${c?.name}", an assistant that works in writing. Tap the dark screen to type, or press Dictate and speak. The buttons under it send ready-made answers.${installOffered ? ' To keep it at hand, "Install the app" at the top puts it on this device like any other app.' : ''}`, 'Start', () => { welcoming = false; notice.hidden = true; enter(); });
                return;
            }
            enter();
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
