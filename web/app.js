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
    const KEYS = { esc: '\x1b', tab: '\t', enter: '\r', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

    const $ = (id) => document.getElementById(id);
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
    const disconnect = () => { wanted = false; socket?.close(); socket = undefined; };

    function connect() {
        disconnect();
        if (!NAME.test(current)) return;
        const name = current;
        wanted = true;
        notice.hidden = true;
        say('connecting', 'connecting');
        fit.fit();
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        const mine = new WebSocket(`${scheme}://${location.host}/terminal?c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`);
        socket = mine;
        mine.binaryType = 'arraybuffer';
        let failure = '';
        /* Open means the bridge answered, not that the machine is awake yet. */
        mine.onopen = () => { say('opening', 'connecting'); terminal.focus(); };
        mine.onmessage = (event) => {
            /* Binary is terminal output. Text is the bridge talking to the page. */
            if (typeof event.data !== 'string') {
                /* Output is the proof the terminal is there: "waking" is over. */
                if (state.dataset.state !== 'live') say('live', 'live');
                terminal.write(new Uint8Array(event.data));
                return;
            }
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === 'status') say(String(message.text), 'connecting');
            if (message.type === 'error') failure = String(message.text);
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
                show(failure || 'The terminal could not be opened.', 'Try again', connect);
            } else {
                say('reconnecting', 'connecting');
                setTimeout(() => { if (socket === mine && wanted) connect(); }, RETRY_MS);
            }
        };
    }

    terminal.onData(send);
    terminal.onResize(sendSize);
    new ResizeObserver(() => fit.fit()).observe($('terminal'));
    for (const button of document.querySelectorAll('#keys button')) {
        button.addEventListener('click', () => { send(KEYS[button.dataset.keys]); terminal.focus(); });
    }

    /* ---------- one conversation ---------- */
    function enter() {
        const c = conversations.find((x) => x.name === current);
        $('name').textContent = current || 'No conversation';
        document.title = current ? `${current} - Clavarium` : 'Clavarium';
        $('tool').hidden = !c; $('tool').textContent = c?.toolLabel ?? '';
        $('sleep').hidden = $('archive').hidden = !c;
        $('folders').hidden = $('files-open').hidden = !c || c.phase !== 'ready';
        $('panel').hidden = $('files').hidden = true;
        paintChips();
        $('keys').hidden = !current;
        if (!current) { disconnect(); terminal.reset(); say('', 'ended'); show(home ? 'Choose a conversation, or create one.' : 'This address names no conversation.'); return; }
        if (home && !c) { disconnect(); say('unknown', 'ended'); show('No such conversation.'); return; }
        if (c && c.phase === 'building') { disconnect(); say('building', 'connecting'); show(`${c.step ?? 'Building'}...`); return; }
        if (c && c.phase === 'failed') { disconnect(); say('failed', 'ended'); show(c.error ?? 'This conversation could not be built.', 'Archive it', () => archive(true)); return; }
        if (!socket) { terminal.reset(); connect(); }
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
            sub.textContent = c.phase === 'ready' ? c.toolLabel : c.phase === 'building' ? `${c.toolLabel} - ${c.step ?? 'building'}` : `${c.toolLabel} - failed`;
            b.append(title, sub);
            b.addEventListener('click', () => select(c.name));
            items.append(b);
        }
        $('empty').hidden = conversations.length > 0;
    }
    async function refresh() {
        clearTimeout(pollTimer);
        try {
            const r = await fetch('/api/conversations');
            if (!r.ok) throw new Error('no api');
            const before = conversations.find((x) => x.name === current)?.phase;
            conversations = await r.json();
            home = true;
            $('list').hidden = false; $('back').hidden = false;
            paint();
            paintChips();
            const now = conversations.find((x) => x.name === current)?.phase;
            if (before !== now || now === 'building') enter();
        } catch { /* a server without VMs has no list: the page is one terminal */ }
        if (home) pollTimer = setTimeout(refresh, conversations.some((c) => c.phase === 'building') ? 2500 : 10000);
    }

    /* ---------- creating ---------- */
    let chosenTool = '';
    async function openCreate() {
        const tools = await (await fetch('/api/tools')).json();
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
            await post('/api/conversations', { name, tool: chosenTool });
            $('create').hidden = true; $('create-name').value = '';
            await refresh();
            select(name);
        } catch (error) { $('create-error').textContent = error.message; $('create-error').hidden = false; }
    });

    /* ---------- folders ---------- */
    const LEVELS = [['none', 'Off'], ['read', 'Read'], ['write', 'Write']];
    function paintChips() {
        const chips = $('chips');
        chips.replaceChildren();
        for (const r of conversations.find((x) => x.name === current)?.resources ?? []) {
            const chip = document.createElement('span');
            chip.className = 'chip'; chip.dataset.access = r.access;
            chip.textContent = `${r.name} - ${r.access}`;
            chips.append(chip);
        }
    }
    async function paintPanel() {
        const all = await (await fetch('/api/resources')).json();
        const mine = new Map((conversations.find((x) => x.name === current)?.resources ?? []).map((r) => [r.name, r.access]));
        const rows = $('panel-rows');
        rows.replaceChildren();
        for (const resource of all) {
            const row = document.createElement('div'); row.className = 'folder';
            const label = document.createElement('b'); label.textContent = resource.name;
            const levels = document.createElement('div'); levels.className = 'levels';
            levels.setAttribute('role', 'group'); levels.setAttribute('aria-label', `Access of this conversation to ${resource.name}`);
            for (const [access, text] of LEVELS) {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = text;
                b.setAttribute('aria-pressed', (mine.get(resource.name) ?? 'none') === access ? 'true' : 'false');
                b.addEventListener('click', async () => {
                    for (const other of levels.children) other.disabled = true;
                    $('panel-error').hidden = true;
                    try { await post(`/api/conversations/${encodeURIComponent(current)}/resources`, { resource: resource.name, access }); }
                    catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
                    await refresh();
                    await paintPanel();
                });
                levels.append(b);
            }
            row.append(label, levels);
            rows.append(row);
        }
        $('panel-empty').hidden = all.length > 0;
    }
    $('folders').addEventListener('click', async () => { $('files').hidden = true; await paintPanel(); $('panel').hidden = false; });
    $('panel-close').addEventListener('click', () => { $('panel').hidden = true; terminal.focus(); });
    $('folder-new').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('panel-error').hidden = true;
        try { await post('/api/resources', { name: $('folder-name').value.trim() }); $('folder-name').value = ''; }
        catch (error) { $('panel-error').textContent = error.message; $('panel-error').hidden = false; }
        await paintPanel();
    });

    /* ---------- files ---------- */
    /* The folders kept by the server and attached here: listed, downloaded,
       imported into. A file name is shown as text and never interpreted. */
    let filesOf = '';            /* the attached folder being shown */
    let filesAt = '';            /* the path inside it */
    const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const filesQuery = (extra = {}) => new URLSearchParams({ c: current, r: filesOf, p: filesAt, ...extra }).toString();
    async function paintFiles() {
        const mine = conversations.find((x) => x.name === current)?.resources ?? [];
        if (!mine.some((r) => r.name === filesOf)) { filesOf = mine[0]?.name ?? ''; filesAt = ''; }
        const tabs = $('files-tabs');
        tabs.replaceChildren();
        for (const r of mine) {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = `${r.name} - ${r.access}`; b.setAttribute('role', 'tab');
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
            const r = await fetch(`/api/files?${filesQuery()}`);
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
            detail.textContent = entry.folder ? 'open' : `${sizeOf(entry.size)} - download`;
            row.append(kind, label, detail);
            if (entry.folder) { row.type = 'button'; row.addEventListener('click', () => { filesAt = inner; void paintFiles(); }); }
            else { row.href = `/api/files/download?${filesQuery({ p: inner })}`; row.setAttribute('download', entry.name); }
            rows.append(row);
        }
        $('files-empty').hidden = listing.entries.length > 0;
    }
    $('files-open').addEventListener('click', async () => { $('panel').hidden = true; await paintFiles(); $('files').hidden = false; });
    $('files-close').addEventListener('click', () => { $('files').hidden = true; terminal.focus(); });
    $('files-import').addEventListener('click', () => $('files-pick').click());
    $('files-pick').addEventListener('change', async () => {
        const status = $('files-status');
        $('files-error').hidden = true;
        for (const file of $('files-pick').files) {
            status.textContent = `Importing ${file.name}...`;
            try {
                const r = await fetch(`/api/files/import?${filesQuery({ name: file.name })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || 'The import failed.');
                status.textContent = `Imported as ${j.name}.`;
            } catch (error) { status.textContent = ''; $('files-error').textContent = `${file.name}: ${error.message}`; $('files-error').hidden = false; }
        }
        $('files-pick').value = '';
        await paintFiles();
    });

    /* ---------- resting and archiving ---------- */
    $('sleep').addEventListener('click', async () => {
        const name = current;
        disconnect();
        say('going to sleep', 'connecting');
        try { await post(`/api/conversations/${encodeURIComponent(name)}/sleep`); say('asleep', 'waiting'); show('Asleep. The tool is frozen as it was.', 'Wake it', connect); }
        catch (error) { say('awake', 'ended'); show(error.message, 'Back to the terminal', connect); }
    });
    async function archive(confirmed) {
        const name = current;
        if (!confirmed) {
            const resume = socket ? () => { notice.hidden = true; terminal.focus(); } : enter;
            show(`Archive "${name}"? Its machine is deleted, with everything on its disk. Attached folders are kept.`, 'Archive', () => archive(true), resume);
            return;
        }
        disconnect();
        try { await post(`/api/conversations/${encodeURIComponent(name)}/archive`); await refresh(); select(''); }
        catch (error) { show(error.message, 'Close', enter); }
    }
    $('archive').addEventListener('click', () => { void archive(false); });
    $('back').addEventListener('click', () => select(''));

    /* ---------- start ---------- */
    view(current ? 'room' : 'list');
    refresh().then(() => {
        if (!home) { view('room'); if (!NAME.test(current)) { current = ''; } }
        enter();
    });
})();
