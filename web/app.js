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
    const API = DEVICE ? '/c/api' : '/api';
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
        const where = DEVICE ? `/c/terminal?cols=${terminal.cols}&rows=${terminal.rows}` : `/terminal?c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`;
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

    /* ---------- one conversation ---------- */
    /* True while a first-time visitor is reading the welcome: the terminal is
       not opened behind it, or its first output would wipe the welcome away
       (seen on the live site: the "Start" button vanished before it could be
       pressed). */
    let welcoming = false;
    function enter() {
        if (welcoming) return;
        const c = conversations.find((x) => x.name === current);
        $('name').textContent = current || 'No conversation';
        document.title = current ? `${current} - Clavarium` : 'Clavarium';
        $('tool').hidden = !c; $('tool').textContent = c?.toolLabel ?? '';
        $('sleep').hidden = $('archive').hidden = !c;
        $('folders').hidden = $('files-open').hidden = $('share').hidden = !c || c.phase !== 'ready';
        $('copy-open').hidden = !current || (home && (!c || c.phase !== 'ready'));
        $('panel').hidden = $('files').hidden = $('sharing').hidden = $('copy').hidden = true;
        paintChips();
        $('keys').hidden = !current;
        if (home && current) void paintShortcuts();
        if (!current) { disconnect(); terminal.reset(); say('', 'ended'); show(home ? 'Choose a conversation, or create one.' : 'This address names no conversation.'); return; }
        if (home && !c) { disconnect(); say('unknown', 'ended'); show('No such conversation.'); return; }
        const usable = Boolean(c) && c.phase === 'ready';
        $('shortcuts').hidden = $('keys').hidden = !current || (home && !usable);
        $('sleep').hidden = !usable || c.asleep === true;
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
            b.addEventListener('click', () => select(c.name));
            items.append(b);
        }
        $('empty').hidden = conversations.length > 0;
    }
    async function refresh() {
        clearTimeout(pollTimer);
        try {
            const mark = (x) => (x ? `${x.phase}/${x.asleep === true}` : '');
            const before = mark(conversations.find((x) => x.name === current));
            if (DEVICE) {
                let r = await fetch(`${API}/me`);
                if (r.status === 401) {
                    /* The session ended: the device signs again, quietly. */
                    const door = await window.clavariumDoor();
                    if (!door.ok) { shut(door.message); return; }
                    r = await fetch(`${API}/me`);
                }
                if (!r.ok) throw new Error('no api');
                const me = await r.json();
                conversations = [me]; current = me.name;
            } else {
                const r = await fetch(`${API}/conversations`);
                if (!r.ok) throw new Error('no api');
                conversations = await r.json();
                $('list').hidden = false; $('back').hidden = false;
            }
            home = true;
            paint();
            paintChips();
            const now = mark(conversations.find((x) => x.name === current));
            if (before !== now || now.startsWith('building')) enter();
        } catch { /* a server without VMs has no list: the page is one terminal */ }
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
    async function paintPanel() {
        const all = await (await fetch(`${API}/resources`)).json();
        const boxes = DEVICE ? [] : await (await fetch(`${API}/mailboxes`)).json().catch(() => []);
        const mine = new Map((conversations.find((x) => x.name === current)?.resources ?? []).map((r) => [r.name, r.access]));
        const rows = $('panel-rows');
        rows.replaceChildren();
        for (const resource of all) {
            const row = document.createElement('div'); row.className = 'folder';
            const label = document.createElement('b'); label.textContent = resource.name;
            const box = resource.type === 'mailbox' ? boxes.find((m) => m.name === resource.name) : undefined;
            if (resource.type === 'mailbox') {
                const about = document.createElement('small'); about.className = 'hint';
                about.textContent = box ? ` mailbox of ${box.user} - ${box.failure ? box.failure : `${box.messages} message(s)`}` : ' mailbox';
                label.append(about);
            }
            const levels = document.createElement('div'); levels.className = 'levels';
            levels.setAttribute('role', 'group'); levels.setAttribute('aria-label', `Access of this conversation to ${resource.name}`);
            for (const [access, text] of LEVELS) {
                /* Somebody's mail is read, never written. */
                if (resource.type === 'mailbox' && access === 'write') continue;
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = text;
                b.setAttribute('aria-pressed', (mine.get(resource.name) ?? 'none') === access ? 'true' : 'false');
                b.addEventListener('click', async () => {
                    for (const other of levels.children) other.disabled = true;
                    $('panel-error').hidden = true;
                    b.textContent = access === 'none' ? 'Detaching...' : 'Attaching...';
                    try { await post(`${API}/conversations/${encodeURIComponent(current)}/resources`, { resource: resource.name, access }); }
                    catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
                    await refresh();
                    await paintPanel();
                });
                levels.append(b);
            }
            /* Offered only where it can work: a folder attached nowhere. */
            if (Object.keys(resource.attachments ?? {}).length === 0) {
                const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
                remove.addEventListener('click', () => {
                    const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Yes, remove ${resource.name} (its files are kept aside on the server)`;
                    sure.addEventListener('click', async () => {
                        try { await post(`${API}/resources/${resource.name}/remove`); }
                        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
                        await paintPanel();
                    });
                    remove.replaceWith(sure);
                });
                row.append(label, levels, remove);
            } else row.append(label, levels);
            rows.append(row);
        }
        $('panel-empty').hidden = all.length > 0;
        /* Where the tool works, and the way to the other place. */
        const here = conversations.find((x) => x.name === current);
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
        const offline = conversations.find((x) => x.name === current)?.offline === true;
        for (const b of $('network').children) b.setAttribute('aria-pressed', String((b.dataset.online === 'true') !== offline));
        await paintSecrets();
        await paintSignIn();
    }
    for (const b of $('network').children) {
        b.addEventListener('click', async () => {
            $('panel-error').hidden = true;
            try { await post(`${API}/conversations/${encodeURIComponent(current)}/network`, { online: b.dataset.online === 'true' }); }
            catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
            await refresh();
            await paintPanel();
        });
    }
    /* Secrets: a name and a switch. A value goes in and never comes back. */
    async function paintSecrets() {
        const all = await (await fetch(`${API}/secrets`)).json();
        const rows = $('secret-rows');
        rows.replaceChildren();
        for (const secret of all) {
            const row = document.createElement('div'); row.className = 'folder';
            const label = document.createElement('b'); label.textContent = secret.name;
            const levels = document.createElement('div'); levels.className = 'levels';
            levels.setAttribute('role', 'group'); levels.setAttribute('aria-label', `Hand ${secret.name} to this conversation`);
            const on = secret.conversations.includes(current);
            for (const [attached, text] of [[false, 'Off'], [true, 'Handed to the tool']]) {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = text; b.setAttribute('aria-pressed', String(on === attached));
                b.addEventListener('click', async () => {
                    $('panel-error').hidden = true;
                    try { await post(`${API}/conversations/${encodeURIComponent(current)}/secrets`, { secret: secret.name, attached }); }
                    catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
                    await paintSecrets();
                    $('secret-note').textContent = `${secret.name}: ${attached ? 'will be handed' : 'will no longer be handed'} to the tool the next time it starts (leave the tool, then "Start it again").`;
                });
                levels.append(b);
            }
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
            remove.addEventListener('click', () => {
                const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = `Yes, delete ${secret.name}`;
                sure.addEventListener('click', async () => { await post(`${API}/secrets/${secret.name}/remove`).catch(() => {}); await paintSecrets(); });
                remove.replaceWith(sure);
            });
            row.append(label, levels, remove);
            rows.append(row);
        }
        $('secret-empty').hidden = all.length > 0;
    }
    $('secret-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try { await post(`${API}/secrets`, { name: $('secret-name').value.trim(), value: $('secret-value').value }); $('secret-name').value = ''; $('secret-value').value = ''; }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        await paintSecrets();
    });
    $('folders').addEventListener('click', async () => { $('files').hidden = true; await paintPanel(); $('panel').hidden = false; });
    $('panel-close').addEventListener('click', () => { $('panel').hidden = true; terminal.focus(); });
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
        await paintPanel();
    });
    $('folder-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try { await post(`${API}/resources`, { name: $('folder-name').value.trim() }); $('folder-name').value = ''; }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        await paintPanel();
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
    area.addEventListener('touchstart', (event) => { if (event.touches.length === 1) { touchY = event.touches[0].clientY; carried = 0; } }, { passive: true });
    area.addEventListener('touchmove', (event) => {
        if (touchY === null || event.touches.length !== 1) return;
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
        /* First, where the tool works -- when that is kept here; then what is attached. */
        const here = conversations.find((x) => x.name === current);
        const mine = [...(here?.work === 'kept' ? [{ name: 'work', access: 'write', own: true }] : []), ...(here?.resources ?? [])];
        if (!mine.some((r) => r.name === filesOf)) { filesOf = mine[0]?.name ?? ''; filesAt = ''; }
        const tabs = $('files-tabs');
        tabs.replaceChildren();
        for (const r of mine) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = r.own ? 'work - where the tool works' : `${r.name} - ${r.access}`; b.setAttribute('role', 'tab');
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
            const pre = document.createElement('pre');
            pre.textContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            body.append(pre); note('');
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

    $('files-open').addEventListener('click', async () => { $('panel').hidden = true; await paintFiles(); $('files').hidden = false; });
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
    async function paintDevices() {
        const list = await (await fetch(`${API}/conversations/${encodeURIComponent(current)}/devices`)).json();
        const rows = $('sharing-devices');
        rows.replaceChildren();
        for (const device of list) {
            const row = document.createElement('div'); row.className = 'device';
            const label = document.createElement('b'); label.textContent = device.label;
            const seen = document.createElement('small');
            seen.textContent = device.seenAt ? `last opened ${new Date(device.seenAt).toLocaleString()}` : 'never opened';
            const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Revoke';
            /* Two clicks, and the second one is not where the first was. */
            remove.addEventListener('click', () => {
                const sure = document.createElement('button'); sure.type = 'button'; sure.className = 'danger'; sure.textContent = 'Yes, remove this device';
                const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep';
                keep.addEventListener('click', () => { void paintDevices(); });
                sure.addEventListener('click', async () => { await post(`${API}/devices/${device.id}/revoke`).catch(() => {}); await paintDevices(); });
                remove.replaceWith(keep, sure);
            });
            row.append(label, seen, remove);
            rows.append(row);
        }
        $('sharing-none').hidden = list.length > 0;
    }
    $('share').addEventListener('click', async () => {
        $('panel').hidden = $('files').hidden = true;
        $('sharing-qr').hidden = $('sharing-link').hidden = $('sharing-error').hidden = true;
        $('sharing-status').textContent = '';
        await paintDevices();
        $('sharing').hidden = false;
    });
    $('sharing-close').addEventListener('click', () => { $('sharing').hidden = true; terminal.focus(); });
    $('sharing-new').addEventListener('click', async () => {
        $('sharing-error').hidden = true;
        try {
            const shared = await post(`${API}/conversations/${encodeURIComponent(current)}/share`);
            $('sharing-qr').src = `data:image/svg+xml;base64,${btoa(shared.qr)}`;
            $('sharing-qr').hidden = false;
            $('sharing-link').textContent = shared.url; $('sharing-link').hidden = false;
            $('sharing-status').textContent = `Works once, for ${shared.minutes} minutes.`;
        } catch (error) { $('sharing-error').textContent = error.message; $('sharing-error').hidden = false; }
    });

    /* ---------- resting and archiving ---------- */
    $('sleep').addEventListener('click', async () => {
        const name = current;
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

    async function start() {
        if (DEVICE) {
            view('room');
            const fresh = location.hash.length > 1;      /* arriving with a code: a first visit */
            say(fresh ? 'pairing' : 'connecting', 'connecting');
            const door = await window.clavariumDoor();
            if (!door.ok) { shut(door.message); return; }
            welcoming = fresh;
            await refresh();
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
