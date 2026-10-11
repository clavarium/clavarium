/* THE TERMINAL BRIDGE: browser <-> WebSocket <-> PTY <-> tmux <-> the tool.
 *
 * It carries bytes and reads none of them. What the tool prints is never
 * parsed here: that is the rule the whole product stands on.
 *
 * On the wire:
 *   browser -> server   binary frame   keystrokes
 *                       text frame     {"type":"resize","cols":n,"rows":n}
 *   server -> browser   binary frame   terminal output
 *                       text frame     {"type":"taken"}  another screen took over
 *                                      {"type":"ready"}  the terminal is attached
 *                                      {"type":"status","text":...}  e.g. waking
 *                                      {"type":"error","text":...}   then close 1011
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
const COLS = [2, 500];
const ROWS = [2, 300];

const within = (n, [low, high]) => Number.isInteger(n) && n >= low && n <= high;

/* A page from another site, open in the same browser, must not be able to
   attach: a WebSocket is not covered by the same-origin policy, so the Origin
   header is compared by hand. Kept under this name for the callers that have
   no declared public address. */
export const sameOrigin = makeOriginCheck();

/* `spawn(name, cols, rows, say)` returns a PTY-like object (write, resize,
   kill, onData, onExit), or a promise of one; `say(text)` tells the screen
   what is taking time. Injected, so tests need neither tmux nor a real PTY.
   `onLeft(name)` is called when a screen goes away; `onEnded(name)` when the
   terminal ended by itself, and answers (a promise of) whether the tool is
   still running, in which case only the channel dropped; `onRejoin(name)`
   when a screen takes a terminal that was already open. `originOk` and
   `gate` decide who may attach at all: see gate.mjs. */
export function attachBridge(server, { spawn, onLeft = () => {}, onEnded = () => {}, originOk = sameOrigin, gate = () => 'local', deviceName = () => undefined, onRejoin = () => {} }) {
    const sockets = new WebSocketServer({ noServer: true });
    const seats = new Seats();

    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        let name;
        if (url.pathname === DEVICE_PATH) {
            /* A device: no operator identity is looked at, and none is needed. */
            /* `d`: which of its pairings this device speaks for. */
            name = deviceName(request.headers, url.searchParams.get('d') ?? '') ?? '';
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
    const live = new Map();          /* name -> { terminal, sink, cols, rows } */
    const reopened = new Map();      /* name -> times of recent automatic reopenings */

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
        const kept = { terminal, sink, cols, rows };
        live.set(name, kept);
        terminal.onData((bytes) => { if (kept.sink?.readyState === 1) kept.sink.send(bytes, { binary: true }); });
        terminal.onExit(async () => {
            if (live.get(name) !== kept) return;              /* we closed it ourselves */
            live.delete(name);
            /* Asked, not guessed: is the tool still running in there? */
            const stillRunning = await onEnded(name);
            const recent = (reopened.get(name) ?? []).filter((at) => Date.now() - at < 60_000);
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
        const say = (text) => { if (viewer.readyState === 1) viewer.send(JSON.stringify({ type: 'status', text })); };

        let kept = live.get(name);
        if (kept) {
            /* Taken as it is. The size is set a line short, then right: that
               makes the tool draw its whole screen for the newcomer. */
            kept.sink = viewer; kept.cols = cols; kept.rows = rows;
            onRejoin(name);
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
                if (viewer.readyState === 1) { viewer.send(JSON.stringify({ type: 'error', text, gone: error?.status === 410 })); viewer.close(1011, 'cannot open'); }
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
            if (binary) { mine.terminal.write(data.toString()); return; }
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

    server.on('close', () => { for (const name of [...live.keys()]) close(name); });

    /* `drop(name)` closes a kept terminal at once: the machine is being put
       to sleep, stopped or deleted, and a channel into it would hang. */
    return { seats, drop: close, warm };
}
