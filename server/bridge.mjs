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
 *                                      {"type":"status","text":...}  e.g. waking
 *                                      {"type":"error","text":...}   then close 1011
 *   close 1000  the tool exited, the session is over
 *   close 4001  taken over: do not reconnect by yourself
 */
import { WebSocketServer } from 'ws';
import { isConversationName } from './names.mjs';
import { Seats } from './seats.mjs';

export const PATH = '/terminal';
export const CLOSE_ENDED = 1000;
export const CLOSE_TAKEN = 4001;
const COLS = [2, 500];
const ROWS = [2, 300];

const within = (n, [low, high]) => Number.isInteger(n) && n >= low && n <= high;

/* A page from another site, open in the same browser, must not be able to
   attach: a WebSocket is not covered by the same-origin policy, so the Origin
   header is compared by hand. */
export function sameOrigin(headers) {
    const origin = headers.origin;
    const host = headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string') return false;
    return origin === `http://${host}` || origin === `https://${host}`;
}

/* `spawn(name, cols, rows, say)` returns a PTY-like object (write, resize,
   kill, onData, onExit), or a promise of one; `say(text)` tells the screen
   what is taking time. Injected, so tests need neither tmux nor a real PTY.
   `onLeft(name)` is called when a screen goes away, `onEnded(name)` when the
   terminal ended by itself rather than because the screen left. */
export function attachBridge(server, { spawn, onLeft = () => {}, onEnded = () => {} }) {
    const sockets = new WebSocketServer({ noServer: true });
    const seats = new Seats();

    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        if (url.pathname !== PATH) return;
        const name = url.searchParams.get('c') ?? '';
        if (!isConversationName(name) || !sameOrigin(request.headers)) { socket.destroy(); return; }
        const cols = Number(url.searchParams.get('cols'));
        const rows = Number(url.searchParams.get('rows'));
        sockets.handleUpgrade(request, socket, head, (viewer) => {
            seat(viewer, name, within(cols, COLS) ? cols : 80, within(rows, ROWS) ? rows : 24);
        });
    });

    async function seat(viewer, name, cols, rows) {
        const previous = seats.take(name, viewer);
        if (previous) {
            previous.send(JSON.stringify({ type: 'taken' }));
            previous.close(CLOSE_TAKEN, 'taken over');
        }
        let gone = false;
        let terminal;
        viewer.on('close', () => { gone = true; seats.leave(name, viewer); onLeft(name); terminal?.kill(); });
        const say = (text) => { if (viewer.readyState === 1) viewer.send(JSON.stringify({ type: 'status', text })); };
        try { terminal = await spawn(name, cols, rows, say); }
        catch (error) {
            /* Only a message written for the person is passed on. */
            const text = typeof error?.status === 'number' ? error.message : 'The terminal could not be opened.';
            if (viewer.readyState === 1) { viewer.send(JSON.stringify({ type: 'error', text })); viewer.close(1011, 'cannot open'); }
            return;
        }
        /* The screen left while the terminal was being opened. */
        if (gone) { terminal.kill(); return; }

        terminal.onData((bytes) => { if (viewer.readyState === 1) viewer.send(bytes, { binary: true }); });
        terminal.onExit(() => {
            if (gone) return;                 /* we killed it: the screen left */
            onEnded(name);
            viewer.close(CLOSE_ENDED, 'ended');
        });
        viewer.on('message', (data, binary) => {
            if (binary) { terminal.write(data.toString()); return; }
            let message;
            try { message = JSON.parse(data.toString()); } catch { return; }
            if (message?.type === 'resize' && within(message.cols, COLS) && within(message.rows, ROWS)) {
                terminal.resize(message.cols, message.rows);
            }
        });
    }

    return { seats };
}
