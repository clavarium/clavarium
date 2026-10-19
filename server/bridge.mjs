/* THE TERMINAL BRIDGE: browser <-> WebSocket <-> PTY <-> tmux <-> the tool.
 *
 * It carries bytes and reads none of them. What the tool prints is never
 * parsed here: that is the rule the whole product stands on. (The one
 * exception is not here: see answerer.mjs, which the owner turns on.)
 *
 * On the wire:
 *   browser -> server   binary frame   keystrokes
 *                       text frame     {"type":"resize","cols":n,"rows":n}
 *   server -> browser   binary frame   terminal output
 *                       text frame     {"type":"taken"}  another screen took over
 *                                      {"type":"ready"}  the terminal is attached
 *                                      {"type":"status","text":...,"progress":...}  e.g. waking
                                        (either may be missing: see conversations.mjs, progress)
 *                                      {"type":"error","text":...,"retry":bool}   then close 1011
 *                                        (retry: it may work in a moment by itself,
 *                                        e.g. a machine that is starting: the page tries again)
 *   close 1000  the tool exited, the session is over
 *   close 4001  taken over: do not reconnect by yourself
 */
import { WebSocketServer } from 'ws';
import { isConversationName } from './names.mjs';
import { Seats } from './seats.mjs';
import { makeOriginCheck } from './gate.mjs';

export const PATH = '/terminal';
/* The same terminal, for a paired device: the conversation is not in the
   address, it is the one the device was bound to. */
export const DEVICE_PATH = '/c/terminal';
export const CLOSE_ENDED = 1000;
export const CLOSE_TAKEN = 4001;
/* A channel that dropped is reopened after a moment, a few times a minute at most. */
export const REOPEN_AFTER_MS = 1000;
export const REDRAW_AFTER_MS = 250;
export const REOPEN_MAX = 5;
/* tmux's prefix key, and how long after a screen pressed it nothing of this
   server is typed down that screen's channel. */
const PREFIX = '\x02';
export const PREFIX_QUIET_MS = 60_000;
const COLS = [2, 500];
const ROWS = [2, 300];

const within = (n, [low, high]) => Number.isInteger(n) && n >= low && n <= high;

/* A TERMINAL OPENED BEFORE ANY SCREEN (`warm`) IS ASKED WHAT IT IS, AND
   SOMEBODY MUST ANSWER. When tmux starts, it asks the terminal who it is
   (the "device attributes" questions) and waits for an answer. With no
   screen nobody answers; tmux then waits five seconds and redraws the whole
   screen -- in front of the person who has come meanwhile: a selection being
   made is wiped, a long press on a tablet lost, at a moment that depends on
   how fast the machine was (measured: the browser tests failed a different
   one each run). So while no screen is there, the bridge answers as the
   page's terminal (xterm.js) would; tmux settles at once, when nobody looks.
   Only these two questions, only while there is no screen.
   What tmux says back to a terminal at that moment is lost with nobody
   there, and one thing of it matters: "report your focus" (tmux is told to
   pass focus on: see tmux.mjs; a tool asked for it). A screen that takes a
   terminal already open is therefore told it in tmux's place
   (FOCUS_REPORTS), as tmux tells a terminal it starts with. */
const ASKED_PRIMARY = /\x1b\[0?c/;
const ASKED_SECONDARY = /\x1b\[>0?c/;
export const FOCUS_REPORTS = '\x1b[?1004h';
export function answerForAbsentScreen(output) {
    const text = String(output);
    return `${ASKED_PRIMARY.test(text) ? '\x1b[?1;2c' : ''}${ASKED_SECONDARY.test(text) ? '\x1b[>0;276;0c' : ''}`;
}

/* A page from another site, open in the same browser, must not be able to
   attach: a WebSocket is not covered by the same-origin policy, so the Origin
   header is compared by hand. Kept under this name for the callers that have
   no declared public address. */
export const sameOrigin = makeOriginCheck();

/* `spawn(name, cols, rows, say)` returns a PTY-like object (write, resize,
   kill, onData, onExit), or a promise of one; `say(text, progress)` tells the
   screen what is taking time. Injected, so tests need neither tmux nor a real PTY.
   `onLeft(name)` is called when a screen goes away; `onEnded(name)` when the
   terminal ended by itself, and answers (a promise of) whether the tool is
   still running, in which case only the channel dropped; `onRejoin(name)`
   when a screen takes a terminal that was already open. `originOk` and
   `gate` decide who may attach at all: see gate.mjs. */
export function attachBridge(server, { spawn, onLeft = () => {}, onEnded = () => {}, originOk = sameOrigin, gate = () => 'local', deviceName = () => undefined, onRejoin = () => {}, onTyped = () => {} }) {
    const sockets = new WebSocketServer({ noServer: true });
    const seats = new Seats();

    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        let name;
        if (url.pathname === DEVICE_PATH) {
            /* A device: no operator identity is looked at, and none is needed. */
            /* `d`: which of its pairings this device speaks for. */
            name = deviceName(request.headers, url.searchParams.get('d') ?? '', url.searchParams.get('c') ?? undefined) ?? '';
            if (!isConversationName(name) || !originOk(request.headers)) { socket.destroy(); return; }
        } else if (url.pathname === PATH) {
            name = url.searchParams.get('c') ?? '';
            if (!isConversationName(name) || !originOk(request.headers) || gate(request.headers) === undefined) { socket.destroy(); return; }
        } else return;
        const cols = Number(url.searchParams.get('cols'));
        const rows = Number(url.searchParams.get('rows'));
        sockets.handleUpgrade(request, socket, head, (viewer) => {
            seat(viewer, name, within(cols, COLS) ? cols : 80, within(rows, ROWS) ? rows : 24);
        });
    });

    /* THE TERMINAL OF A RUNNING MACHINE STAYS OPEN, screen or no screen.
     *
     * Opening a terminal into a VM costs one to three seconds (measured: the
     * VM manager is asked for the machine's state, then opens a channel into
     * it). Paid at every page load, the owner felt it at once. So the channel
     * is opened when the machine is known to run and KEPT: a screen that
     * arrives takes it as it is and asks the tool to redraw, at once. A
     * screen that takes the conversation from another gets it the same way.
     *
     * If the channel drops while the tool is still running, it is reopened by
     * itself. It is closed on purpose only when the machine is put to sleep,
     * stopped or deleted (`drop`), or when this server stops.
     */
    const live = new Map();          /* name -> { terminal, sink, cols, rows, prefixAt } */
    const reopened = new Map();      /* name -> times of recent automatic reopenings */
    /* name -> when its terminal was last closed for its machine's sake (put
       to sleep, stopped, deleted) or ended by itself: what was known of its
       machine before that is not known any more (talk.mjs). */
    const dropped = new Map();

    /* A terminal that has just closed refuses a new size with an error that
       would take the whole server down: a size nobody will see is not worth that. */
    const resize = (kept, cols, rows) => { try { kept.terminal.resize(cols, rows); } catch { /* closed meanwhile */ } };

    function close(name) {
        const kept = live.get(name);
        if (!kept) return;
        live.delete(name);
        kept.sink = null;
        /* A terminal whose program is already gone refuses to be killed
           again, loudly: there is nothing left to do about it. */
        try { kept.terminal.kill(); } catch { /* already gone */ }
    }

    /* Opens the terminal of `name` and keeps it; `sink` is the screen that
       receives its output, if there is one. */
    async function open(name, cols, rows, sink, say = () => {}) {
        const terminal = await spawn(name, cols, rows, say);
        /* While it was being opened another one may have been: the newest wins. */
        if (live.has(name)) close(name);
        const kept = { terminal, sink, cols, rows, openedAt: Date.now(), outputAt: Date.now() };
        live.set(name, kept);
        terminal.onData((bytes) => {
            kept.outputAt = Date.now();
            if (kept.sink?.readyState === 1) { kept.sink.send(bytes, { binary: true }); return; }
            if (!kept.sink) { const answer = answerForAbsentScreen(bytes); if (answer) terminal.write(answer); }
        });
        terminal.onExit(async () => {
            if (live.get(name) !== kept) return;              /* we closed it ourselves */
            live.delete(name);
            /* Asked, not guessed: is the tool still running in there? */
            const stillRunning = await onEnded(name);
            const recent = (reopened.get(name) ?? []).filter((at) => Date.now() - at < 60_000);
            if (!stillRunning) dropped.set(name, Date.now());
            if (stillRunning && recent.length < REOPEN_MAX && !live.has(name)) {
                /* Only the channel dropped: it is reopened, for whoever is there or will come. */
                reopened.set(name, [...recent, Date.now()]);
                setTimeout(() => {
                    if (live.has(name)) return;
                    open(name, kept.cols, kept.rows, kept.sink).then(() => { if (!kept.sink) onLeft(name); }, () => kept.sink?.close(1011, 'cannot reopen'));
                }, REOPEN_AFTER_MS).unref?.();
                return;
            }
            kept.sink?.close(CLOSE_ENDED, 'ended');
        });
        return kept;
    }

    async function seat(viewer, name, cols, rows) {
        const previous = seats.take(name, viewer);
        if (previous) {
            previous.send(JSON.stringify({ type: 'taken' }));
            previous.close(CLOSE_TAKEN, 'taken over');
        }
        let gone = false;
        viewer.on('close', () => {
            gone = true;
            if (seats.holder(name) !== viewer) return;       /* replaced: the terminal went on with the newcomer */
            seats.leave(name, viewer);
            onLeft(name);
            const kept = live.get(name);
            if (kept?.sink === viewer) kept.sink = null;     /* the terminal stays open */
        });
        /* `progress`: where a start is, step by step (conversations.mjs); the page draws it. */
        const say = (text, progress) => { if (viewer.readyState === 1) viewer.send(JSON.stringify({ type: 'status', ...(text ? { text } : {}), ...(progress ? { progress } : {}) })); };

        let kept = live.get(name);
        if (kept) {
            /* Taken as it is. The size is set a line short, then right: that
               makes the tool draw its whole screen for the newcomer. */
            kept.sink = viewer; kept.cols = cols; kept.rows = rows;
            onRejoin(name);
            if (viewer.readyState === 1) viewer.send(Buffer.from(FOCUS_REPORTS), { binary: true });
            /* The two sizes are sent APART. Sent together, they reached the
               machine as one change to the size it already had: nothing was
               redrawn, and the page waited for an output that never came
               (measured on the live site: a reload stayed blank). */
            const taken = kept;
            resize(taken, cols, Math.max(2, rows - 1));
            setTimeout(() => { if (live.get(name) === taken && taken.sink === viewer) resize(taken, taken.cols, taken.rows); }, REDRAW_AFTER_MS);
        } else {
            try { kept = await open(name, cols, rows, viewer, say); }
            catch (error) {
                /* Only a message written for the person is passed on. */
                const text = typeof error?.status === 'number' ? error.message : 'The terminal could not be opened.';
                if (viewer.readyState === 1) { viewer.send(JSON.stringify({ type: 'error', text, gone: error?.status === 410, retry: error?.retry === true })); viewer.close(1011, 'cannot open'); }
                return;
            }
            if (gone) kept.sink = null;
        }
        /* Said in so many words: the page must not have to guess, from an
           output that may not come, that its terminal is there. */
        if (viewer.readyState === 1) viewer.send(JSON.stringify({ type: 'ready' }));
        const mine = kept;
        viewer.on('message', (data, binary) => {
            if (mine.sink !== viewer) return;
            /* `onTyped`: told THAT something came from a screen (the owner is there), which is not reading what the tool prints. */
            if (binary) {
                const typed = data.toString();
                /* tmux's prefix key (Ctrl-B): what comes next may be read as
                   a tmux command, not by the tool. A line of this server is
                   then not typed through this channel for a while (`type`). */
                if (typed.includes(PREFIX)) mine.prefixAt = Date.now();
                mine.terminal.write(typed); onTyped(name, typed); return;
            }
            let message;
            try { message = JSON.parse(data.toString()); } catch { return; }
            if (message?.type === 'resize' && within(message.cols, COLS) && within(message.rows, ROWS)) {
                mine.cols = message.cols; mine.rows = message.rows;
                resize(mine, message.cols, message.rows);
            }
        });
    }

    /* Opens the terminal of a machine known to run, before anybody asks: the
       first screen then shows it at once. Does nothing if it is open already. */
    async function warm(name) {
        if (live.has(name)) return;
        try { await open(name, 120, 40, null); onLeft(name); } catch { /* it will be opened when a screen asks */ }
    }

    /* A LINE OF THIS SERVER, TYPED DOWN THE CHANNEL ALREADY OPEN (talk.mjs):
       the terminal kept here is attached to the tool's own tmux pane, so
       writing to it is typing there -- with no command sent into the machine.
       The line, then Enter `enterAfterMs` later (apart: see ENTER_AFTER_MS in
       talk.mjs). Resolves false when there is no such channel, or when a
       screen pressed tmux's prefix key lately; the caller then uses its
       other way. Nothing of it is told to `onTyped`: nobody typed. */
    async function type(name, line, enterAfterMs = 0) {
        const kept = live.get(name);
        if (!kept || Date.now() - (kept.prefixAt ?? -Infinity) < PREFIX_QUIET_MS) return false;
        try { kept.terminal.write(String(line)); } catch { return false; }
        if (enterAfterMs > 0) await new Promise((r) => { setTimeout(r, enterAfterMs).unref?.(); });
        if (live.get(name) !== kept) return false;
        try { kept.terminal.write('\r'); } catch { return false; }
        return true;
    }

    server.on('close', () => { for (const name of [...live.keys()]) close(name); });

    /* `drop(name)` closes a kept terminal at once: the machine is being put
       to sleep, stopped or deleted, and a channel into it would hang.
       `open(name)`: whether a terminal of it is kept open now. */
    /* `type(name, line, ms)`: see above. `droppedAt(name)`: when it was last
       closed for its machine's sake, or undefined. */
    const drop = (name) => { dropped.set(name, Date.now()); close(name); };
    /* `settled(name)`: how long its terminal has been open, and how long
       since anything came out of it -- THAT something came, never what: a
       tool still drawing its first screen is not reading its keyboard yet. */
    const settled = (name) => { const kept = live.get(name); return kept ? { openFor: Date.now() - kept.openedAt, quietFor: Date.now() - kept.outputAt } : null; };
    return { seats, drop, warm, type, settled, open: (name) => live.has(name), droppedAt: (name) => dropped.get(name) };
}
