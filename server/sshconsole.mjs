/* A MACHINE'S SHARED CONSOLE, SEEN BY ITS PERSON (16-11): the live SSH console of a machine asset (a Tether target
 * of kind ssh), shown in its asset panel. ONE shell per machine, kept by Tether's keeper in this server: the person
 * streams it from the page, the conversations given the machine reach the same shell through terminal.open / read /
 * type (Tether's console.mjs says who sees and types what: the person's key always wins, password prompts hide the
 * input from the AI, « hide from the AI », destructive lines always asked).
 *
 *   WebSocket /api/tether/console?target=ID[&cols=N&rows=N]
 *     browser -> server   binary frame   keystrokes (the person's own: never read here, never kept)
 *                         text frame     {"type":"resize","cols":n,"rows":n} | {"type":"hidden","on":bool}
 *                                        | {"type":"hide-ai","on":bool} | {"type":"take-back"} | {"type":"interrupt"}
 *     server -> browser   binary frame   what the machine prints (first: the screen so far, for a page that comes back)
 *                         text frame     {"type":"ready","state":{...}} | {"type":"state","state":{...}}
 *                                        | {"type":"error","text":...}   then close 1011
 *     close 1000          the shell ended (the page offers to open it again)
 *
 *   POST /api/tether/console-journal  {target}  -> { lines: [...] }: the console's short journal -- the agents' inputs
 *                                     (sent, refused, edited, destructive), control taken back, input hidden; never
 *                                     what the person typed (Tether never journals it).
 *
 * THE SAME CHECKS AS THE TERMINAL BRIDGE (bridge.mjs): this site's own pages only (the Origin, compared by hand: a
 * WebSocket is not covered by the same-origin policy), past the gate (a signed-in operator, as every asset route);
 * a machine that exists. A device's page (/c/) has no way here: its console is not given to devices. What the
 * machine prints is carried, never parsed nor kept here; the page draws it with xterm only (never as HTML). */
import { WebSocketServer } from 'ws';
import { Refusal } from './conversations.mjs';
import { IDENTITY_HEADER } from './gate.mjs';

export const CONSOLE_PATH = '/api/tether/console';
export const KEYS_MAX = 64 * 1024;
export const JOURNAL_MAX = 30;
const CLOSE_ENDED = 1000;
const CLOSE_FAILED = 1011;

const whoOf = (headers) => {
    const identity = String(headers?.[IDENTITY_HEADER] ?? '').trim().toLowerCase();
    return { id: `person:${identity || 'owner'}`, name: identity || 'Owner' };
};
const machineOf = (tethers, id) => {
    const t = tethers?.store().target(String(id ?? ''));
    return t && t.kind === 'ssh' ? t : null;
};

export function attachConsole(server, { tethers, gate = () => 'local', originOk }) {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: KEYS_MAX });
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://local');
        if (url.pathname !== CONSOLE_PATH) return;
        const target = machineOf(tethers, url.searchParams.get('target'));
        if (!originOk(request.headers) || gate(request.headers) === undefined || !target) { socket.destroy(); return; }
        const cols = Number(url.searchParams.get('cols')); const rows = Number(url.searchParams.get('rows'));
        sockets.handleUpgrade(request, socket, head, (ws) => { void seat(ws, target, whoOf(request.headers), { cols, rows }); });
    });

    async function seat(ws, target, who, { cols, rows }) {
        const send = (data, binary = false) => { if (ws.readyState === 1) ws.send(data, { binary }); };
        let handle = null; let gone = false; const early = [];
        const onEvent = (e) => {
            if (!handle) { early.push(e); return; }
            if (e.type === 'data') send(Buffer.from(e.data, 'utf8'), true);
            else if (e.type === 'state') send(JSON.stringify({ type: 'state', state: e.state }));
            else if (e.type === 'closed') { try { ws.close(CLOSE_ENDED, 'ended'); } catch { /* gone */ } }
        };
        ws.on('close', () => { gone = true; handle?.detach(); });
        try { handle = await tethers.console(target.id, who, onEvent); } catch (error) {
            send(JSON.stringify({ type: 'error', text: String(error?.message ?? error) }));
            try { ws.close(CLOSE_FAILED, 'failed'); } catch { /* gone */ }
            return;
        }
        if (gone) { handle.detach(); return; }
        handle.resize(cols, rows);
        send(JSON.stringify({ type: 'ready', state: handle.state() }));
        if (handle.replay) send(Buffer.from(handle.replay, 'utf8'), true);
        /* What came meanwhile is in the replay already: only the latest state is said again. */
        if (early.some((e) => e.type === 'closed')) { try { ws.close(CLOSE_ENDED, 'ended'); } catch { /* gone */ } return; }
        ws.on('message', (data, binary) => {
            if (binary) { handle.write(Buffer.from(data).toString('utf8')); return; }
            let m; try { m = JSON.parse(String(data)); } catch { return; }
            if (m?.type === 'resize') handle.resize(Number(m.cols), Number(m.rows));
            else if (m?.type === 'hidden') handle.hidden(m.on === true);
            else if (m?.type === 'hide-ai') handle.hideFromAi(m.on === true);
            else if (m?.type === 'take-back') handle.takeBack();
            else if (m?.type === 'interrupt') handle.interrupt();
        });
    }
    return sockets;
}

/* The console's short journal: the newest first, its agents' inputs and its events. */
export async function consoleJournal(tethers, body = {}) {
    const target = machineOf(tethers, body.target);
    if (!target) throw new Refusal(404, 'No such machine.');
    const r = await tethers.act('journal', { target: target.id, limit: 200 }, '');
    if (!r.ok) throw new Refusal(502, r.text);
    const lines = (Array.isArray(r.data) ? r.data : []).filter((l) => l.op === 'console' || String(l.verb ?? '').startsWith('terminal.') && l.verb !== 'terminal.read' && l.verb !== 'terminal.open')
        .slice(0, JOURNAL_MAX)
        .map((l) => ({ at: l.at, ...(l.op ? { op: l.op } : {}), ...(l.verb ? { verb: l.verb } : {}), detail: String(l.detail ?? ''), ...(l.agent?.name ? { agent: l.agent.name } : {}), ...(l.by?.name ? { by: l.by.name } : {}),
            ...(l.decision ? { decision: l.decision } : {}), ...(l.ok !== undefined ? { ok: l.ok } : {}), ...(l.risk ? { risk: l.risk } : {}), ...(l.edited ? { edited: true } : {}), ...(l.error ? { error: String(l.error) } : {}) }));
    return { lines };
}
