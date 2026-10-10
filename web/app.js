/* The page of one conversation: a terminal, and the keys a phone lacks.
   It draws what the tool prints and sends what the person types. It reads
   neither: no link is made clickable, no output becomes a card. */
(() => {
    const CLOSE_ENDED = 1000;
    const CLOSE_TAKEN = 4001;
    const RETRY_MS = 1500;
    /* What each key of the row sends, as a terminal expects it. */
    const KEYS = { esc: '\x1b', tab: '\t', enter: '\r', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };

    const name = new URLSearchParams(location.search).get('c') || '';
    const $ = (id) => document.getElementById(id);
    const state = $('state');
    const notice = $('notice');
    $('name').textContent = name || 'No conversation';
    document.title = name ? `${name} - Clavarium` : 'Clavarium';

    const show = (text, action, run) => {
        $('notice-text').textContent = text;
        $('notice-action').textContent = action;
        $('notice-action').onclick = run;
        notice.hidden = false;
    };
    const say = (label, kind) => { state.textContent = label; state.dataset.state = kind; };

    if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) {
        say('no conversation', 'ended');
        show('This address names no conversation.', 'Open "demo"', () => { location.search = '?c=demo'; });
        $('keys').hidden = true;
        return;
    }

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
    let socket;
    const send = (text) => { if (socket?.readyState === 1) socket.send(encoder.encode(text)); };
    const sendSize = () => {
        if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };

    function connect() {
        notice.hidden = true;
        say('connecting', 'connecting');
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(`${scheme}://${location.host}/terminal?c=${encodeURIComponent(name)}&cols=${terminal.cols}&rows=${terminal.rows}`);
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => { say('live', 'live'); terminal.focus(); };
        socket.onmessage = (event) => {
            /* Binary is terminal output. Text is the bridge talking to the page. */
            if (typeof event.data !== 'string') terminal.write(new Uint8Array(event.data));
        };
        socket.onclose = (event) => {
            if (event.code === CLOSE_TAKEN) {
                say('open elsewhere', 'waiting');
                show('This conversation is now open on another screen.', 'Use it here', connect);
            } else if (event.code === CLOSE_ENDED) {
                say('ended', 'ended');
                show('The tool has exited. The session is over.', 'Start it again', connect);
            } else {
                say('reconnecting', 'connecting');
                setTimeout(connect, RETRY_MS);
            }
        };
    }

    terminal.onData(send);
    terminal.onResize(sendSize);
    new ResizeObserver(() => fit.fit()).observe($('terminal'));
    for (const button of document.querySelectorAll('#keys button')) {
        button.addEventListener('click', () => { send(KEYS[button.dataset.keys]); terminal.focus(); });
    }
    connect();
})();
