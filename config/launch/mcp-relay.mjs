/* TAKEN UP WITHOUT A RESTART (02-11), FOR EVERY TOOL OF EVERY CONVERSATION: the launcher gives Claude Code
 * each MCP server through this relay -- `node mcp-relay.mjs COMMAND ARGS...` -- so a tool updated on the
 * machine is taken up between two requests, whatever the tool, with nothing for the agent to do. Its
 * version is the package.json of the package its command comes from.
 *
 * (Below, the relay as each Clavarium tool also carries it.)
 * An MCP server lives as long as the session that started it: a new
 * version installed under it was not seen until the session itself was restarted ("on ne peut pas mettre à
 * jour un composant sans redémarrer la session ?"). So the server runs as a child of this relay; between two
 * requests, when the version installed on disk is no longer the child's, the relay starts the new one, says
 * hello to it as the session did, and tells the session its tools may have changed. Nothing is lost: a
 * request in flight is answered by the child it went to, the next goes to the new one. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/* -> the version installed now, read from package.json (null if unreadable: keep the child). */
export const installedVersion = (packageJson) => { try { return String(JSON.parse(readFileSync(packageJson, 'utf8')).version ?? '') || null; } catch { return null; } };

export function relay({ command = process.execPath, args, packageJson, input = process.stdin, output = process.stdout, spawner = spawn, version = installedVersion, log = () => {} }) {
    let child = null; let running = null; let hello = null; let helloDone = false;
    const pending = new Set(); const queue = [];
    const send = (m) => output.write(`${JSON.stringify(m)}\n`);
    const start = () => {
        running = version(packageJson);
        const c = spawner(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, MCP_RELAYED: '1' } });
        child = c;
        createInterface({ input: c.stdout }).on('line', (line) => {
            let m; try { m = JSON.parse(line); } catch { return; }
            if (m && typeof m.id === 'string' && m.id.startsWith('relay:')) return;   /* its answer to our own hello */
            if (m && m.id !== undefined) pending.delete(m.id);
            output.write(`${line}\n`);
            if (pending.size === 0) flush();
        });
        c.on('exit', () => {
            if (child !== c) return;
            child = null;
            /* It stopped under a request: answered, never left waiting; the next one starts it again. */
            for (const id of pending) send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The tool stopped; try again.' } });
            pending.clear(); flush();
        });
        return c;
    };
    const greet = (c) => {
        if (!hello) return;
        c.stdin.write(`${JSON.stringify({ ...hello, id: `relay:${Date.now()}` })}\n`);
        c.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    };
    /* Between requests: the new version if there is one (once nothing is in flight), then what waited. */
    const needsNew = () => { if (!child) return true; if (!helloDone) return false; const now = version(packageJson); return Boolean(now && now !== running); };
    const flush = () => {
        while (queue.length) {
            if (needsNew()) {
                if (pending.size > 0) return;
                const old = child; const was = running;
                const c = start(); greet(c);
                log(`relay: ${was} -> ${running}`);
                try { old?.stdin.end(); old?.kill(); } catch { /* gone already */ }
                if (helloDone) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
            }
            const m = queue.shift();
            if (m.id !== undefined) pending.add(m.id);
            child.stdin.write(`${JSON.stringify(m)}\n`);
        }
    };
    start();
    createInterface({ input }).on('line', (line) => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (m.method === 'initialize') { hello = m; }
        if (m.method === 'notifications/initialized') helloDone = true;
        queue.push(m);
        flush();
    });
    input.on('end', () => { try { child?.stdin.end(); } catch { /* gone */ } });
    return { get child() { return child; }, get version() { return running; } };
}

/* The package a command comes from: its file followed to the end of its links, then up to a package.json. */
import { realpathSync, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
export function packageOf(command, path = process.env.PATH ?? '') {
    const found = isAbsolute(command) ? command : path.split(delimiter).map((d) => join(d, command)).find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    if (!found) return null;
    let at; try { at = dirname(realpathSync(found)); } catch { return null; }
    for (let i = 0; i < 6; i++) { if (existsSync(join(at, 'package.json'))) return join(at, 'package.json'); const up = dirname(at); if (up === at) break; at = up; }
    return null;
}
const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const [command, ...args] = process.argv.slice(2);
    if (!command) { process.stderr.write('mcp-relay: COMMAND [ARGS...]\n'); process.exit(64); }
    /* A node script given by its path (node /x/server.mjs): its package is that of the script. */
    const target = /(^|\/)node$/.test(command) && args[0] ? args[0] : command;
    relay({ command, args, packageJson: packageOf(target) ?? '/nonexistent/package.json' });
}
