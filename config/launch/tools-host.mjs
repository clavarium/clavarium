/* ONE PROGRAM FOR ALL THE TOOLS OF A CONVERSATION (11-11, card #350). Each tool (Parley, Docket, Tether...) was
 * given to the agent as its own Node program, under its own relay: two Node programs a tool, ~435 MB for three.
 * Here they share one: each session of a tool runs in a worker thread of this host, the same file started the
 * same way (its own argv, stdin and stdout), so a tool runs unchanged. ~100 MB for three.
 *
 * The agent still starts one command a tool (mcp-sock.sh, a few lines of sh and netcat): it connects to this
 * host's socket, says on its first line which tool and with which arguments, then the session flows through.
 * The relay is the same as before (mcp-relay.mjs): a version installed under a session is taken up between two
 * requests -- its worker replaced, the session told its tools may have changed.
 *
 * The socket lives in a folder of this user alone (700): in a machine shared by several conversations, one
 * conversation never reaches another's tools. Nobody connected for 10 minutes: the host stops; the next tool
 * started starts it again. */
import { createServer } from 'node:net';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { existsSync, realpathSync, rmSync, statSync, readFileSync } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relay, packageOf } from './mcp-relay.mjs';

const say = (text) => process.stderr.write(`${new Date().toISOString()} tools-host: ${text}\n`);

/* The script a command runs, when it is a Node script (node FILE, or a command whose file is one): its path. */
export function scriptOf(command, args, path = process.env.PATH ?? '') {
    if (/(^|\/)node$/.test(command)) return args[0] ? { file: args[0], args: args.slice(1) } : null;
    const found = isAbsolute(command) ? command : path.split(delimiter).map((d) => join(d, command)).find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    if (!found) return null;
    let file; try { file = realpathSync(found); } catch { return null; }
    if (/\.(mjs|cjs|js)$/.test(file)) return { file, args };
    try { if (/^#!.*\bnode\b/.test(readFileSync(file, 'utf8').slice(0, 120))) return { file, args }; } catch { /* unreadable */ }
    return null;
}

/* A worker that looks like a child process to the relay: stdin, stdout, 'exit', kill. Not a Node script: a real
   child, as before. */
export function workerSpawner(command, args, opts = {}) {
    const script = scriptOf(command, args);
    if (!script) return spawn(command, args, opts);
    const w = new Worker(script.file, { argv: script.args, stdin: true, stdout: true, env: { ...(opts.env ?? process.env) } });
    w.on('error', (error) => say(`${script.file}: ${error?.stack ?? error}`));
    const child = {
        stdin: w.stdin, stdout: w.stdout,
        on(event, f) { if (event === 'exit') w.on('exit', f); return child; },
        kill() { void w.terminate(); },
    };
    return child;
}

/* One session: its first line names the tool { command, args }; the rest is the session, relayed to a worker. */
export function session(socket, { spawner = workerSpawner } = {}) {
    const input = new PassThrough();
    let header = null;
    const lines = createInterface({ input: socket });
    lines.on('line', (line) => {
        if (header) { input.write(`${line}\n`); return; }
        try { header = JSON.parse(line); } catch { header = null; }
        if (!header || typeof header.command !== 'string' || !Array.isArray(header.args)) { socket.end(); return; }
        const script = scriptOf(header.command, header.args);
        const target = script?.file ?? header.command;
        relay({ command: header.command, args: header.args.map(String), packageJson: packageOf(target) ?? '/nonexistent/package.json',
            input, output: socket, spawner, log: say });
    });
    lines.on('close', () => input.end());
    socket.on('error', () => { /* the agent went: its worker ends with its input */ });
}

export function host(dir, { idleMs = 10 * 60_000 } = {}) {
    const sock = join(dir, 'host.sock');
    rmSync(sock, { force: true });
    let open = 0; let idle = null;
    const server = createServer((socket) => {
        open++; clearTimeout(idle);
        socket.on('close', () => { open--; if (open === 0) idle = setTimeout(() => { server.close(); rmSync(sock, { force: true }); process.exit(0); }, idleMs); });
        session(socket);
    });
    server.listen(sock, () => say(`listening (${process.pid})`));
    idle = setTimeout(() => { if (open === 0) { server.close(); rmSync(sock, { force: true }); process.exit(0); } }, idleMs);
    return server;
}

const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const dir = process.argv[2];
    if (!dir || !existsSync(dir)) { say('a folder of its own, given first'); process.exit(64); }
    /* Its folder: this user's, closed to others -- or nothing is served. */
    const st = statSync(dir);
    if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) { say(`${dir} is not closed to others: nothing served`); process.exit(77); }
    host(dir);
}
