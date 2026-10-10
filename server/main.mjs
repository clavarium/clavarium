/* Slice 1: one page, one terminal, on the loopback interface only.
 *
 *     node server/main.mjs --command claude --cwd /path/to/work
 *     open http://127.0.0.1:7717/?c=my-conversation
 *
 * No VM yet: the command runs on this machine. The next slice puts the same
 * argument vector behind the VM's own channel; nothing else changes.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { attachBridge } from './bridge.mjs';
import { attachCommand } from './tmux.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = {
    '/': ['web/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
    '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
/* Nothing loads from anywhere else, and nothing may frame the page. */
const HEADERS = {
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
};

export function option(argv, name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

export function start({ port, command, cwd, env = process.env }) {
    /* A tmux inside a tmux refuses to start: the variable does not travel. */
    const clean = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'));
    const server = createServer(async (request, response) => {
        const file = FILES[new URL(request.url ?? '/', 'http://local').pathname];
        if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
            response.writeHead(404, HEADERS).end();
            return;
        }
        response.writeHead(200, { ...HEADERS, 'content-type': file[1] }).end(await readFile(ROOT + file[0]));
    });
    attachBridge(server, {
        spawn: (name, cols, rows) => {
            const [program, ...argv] = attachCommand(name, command, cwd);
            return pty.spawn(program, argv, { name: 'xterm-256color', cwd, env: clean, cols, rows });
        },
    });
    return new Promise((ready) => server.listen(port, '127.0.0.1', () => ready(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const port = Number(option(argv, 'port', '7717'));
    const command = option(argv, 'command', 'bash').split(' ').filter(Boolean);
    const cwd = option(argv, 'cwd', process.cwd());
    const server = await start({ port, command, cwd });
    console.log(`http://127.0.0.1:${server.address().port}/?c=demo`);
}
