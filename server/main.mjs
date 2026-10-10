/* The server. Loopback only: what faces the internet is the edge in front of it.
 *
 * Two ways to run it:
 *
 *   node server/main.mjs --multipass "sudo multipass" --data /path/to/data
 *       conversations are VMs, created from the page
 *
 *   node server/main.mjs --command "your-tool" --cwd /path/to/work
 *       no VM: one tool on this machine, at /?c=<name>. For development.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { attachBridge } from './bridge.mjs';
import { attachCommand } from './tmux.mjs';
import { handleApi } from './api.mjs';
import { Conversations } from './conversations.mjs';
import { Store } from './store.mjs';
import { loadTools } from './tools.mjs';
import { Vms, runner } from './vm.mjs';

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

/* A tmux inside a tmux refuses to start: the variable does not travel. */
const withoutTmux = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'));

function serve(port, conversations) {
    const server = createServer(async (request, response) => {
        if (conversations && await handleApi(request, response, conversations, HEADERS)) return;
        const file = FILES[new URL(request.url ?? '/', 'http://local').pathname];
        if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
            response.writeHead(404, HEADERS).end();
            return;
        }
        response.writeHead(200, { ...HEADERS, 'content-type': file[1] }).end(await readFile(ROOT + file[0]));
    });
    return { server, listening: new Promise((ready) => server.listen(port, '127.0.0.1', () => ready(server))) };
}

/* Development: one tool on this machine, no VM. */
export function start({ port, command, cwd, env = process.env }) {
    const { server, listening } = serve(port);
    attachBridge(server, {
        spawn: (name, cols, rows) => {
            const [program, ...argv] = attachCommand(name, command, cwd);
            return pty.spawn(program, argv, { name: 'xterm-256color', cwd, env: withoutTmux(env), cols, rows });
        },
    });
    return listening;
}

/* The product: conversations are VMs. `prefix` is how the VM manager is
   reached on this installation, as an argument vector. */
export function startHome({ port, prefix, dataDir, env = process.env, conversations }) {
    const all = conversations ?? new Conversations({
        store: new Store(`${dataDir}/conversations.json`),
        vms: new Vms(runner(prefix), prefix),
        tools: loadTools(),
    });
    const { server, listening } = serve(port, all);
    attachBridge(server, {
        spawn: async (name, cols, rows, say) => {
            const [program, ...argv] = await all.open(name, say);
            return pty.spawn(program, argv, { name: 'xterm-256color', env: withoutTmux(env), cols, rows });
        },
        onLeft: (name) => all.left(name),
        onEnded: (name) => { void all.ended(name); },
    });
    return listening;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const port = Number(option(argv, 'port', '7717'));
    const multipass = option(argv, 'multipass', '');
    if (multipass) {
        const dataDir = option(argv, 'data', `${process.cwd()}/data`);
        const server = await startHome({ port, prefix: multipass.split(' ').filter(Boolean), dataDir });
        console.log(`http://127.0.0.1:${server.address().port}/`);
    } else {
        const command = option(argv, 'command', 'bash').split(' ').filter(Boolean);
        const server = await start({ port, command, cwd: option(argv, 'cwd', process.cwd()) });
        console.log(`http://127.0.0.1:${server.address().port}/?c=demo`);
    }
}
