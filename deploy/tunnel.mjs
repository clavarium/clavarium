/* THE TUNNEL TO THE RELAY (see deploy/clavarium-tunnel): its unit, one text for install.sh and the
 * updater, and how the updater keeps it up to date. No side effect when imported. */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* THE TUNNEL TO THE RELAY, kept by the updater: written by install.sh with what was known then, an update
   did not touch it. Its unit runs the program of the release (deploy/clavarium-tunnel, installed with the
   other privileged programs): a cut of the network noticed in 20 to 30 s and tried again every 5 s, a refusal
   tried again ever more slowly (found 22-10: a short cut kept the pages away for two minutes). The relay and
   its port are read from the unit there, written as before or as now. Restarted only when it changed. */
export const TUNNEL_UNIT = '/etc/systemd/system/clavarium-tunnel.service';
export const TUNNEL_PROGRAM = '/usr/local/sbin/clavarium-tunnel';
export function tunnelUnit(relay, port, program = TUNNEL_PROGRAM) {
    return `[Unit]
Description=Clavarium - the outgoing tunnel to the relay
After=network-online.target caddy.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=clavarium-tunnel
Group=clavarium-tunnel
# Only TLS (443) and the certificate challenge (80) are carried: see ${program}.
ExecStart=${program} ${relay} ${port}
Restart=always
RestartSec=5
# What it counts of the relay's refusals, kept across its restarts.
RuntimeDirectory=clavarium-tunnel
RuntimeDirectoryPreserve=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
`;
}
export function relayOfUnit(text) {
    const now = new RegExp(`^ExecStart=\\S+clavarium-tunnel ([A-Za-z0-9.-]{1,253}) (\\d{1,5})$`, 'm').exec(text);
    if (now) return { relay: now[1], port: now[2] };
    const before = /-p (\d{1,5}) clavarium-tunnel@([A-Za-z0-9.-]{1,253})\s*$/m.exec(text);
    return before ? { relay: before[2], port: before[1] } : null;
}
/* `from`: the program of THIS release -- installed first when it differs (an older updater made the
   release, and did not know it). */
export async function ensureTunnel({ file = TUNNEL_UNIT, program = TUNNEL_PROGRAM, from = fileURLToPath(new URL('./clavarium-tunnel', import.meta.url)), run } = {}) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    let installed = false;
    if (existsSync(from) && (!existsSync(program) || !readFileSync(from).equals(readFileSync(program)))) {
        const r = await run(['install', '-o', 'root', '-g', 'root', '-m', '0755', from, program], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`${program}: ${String(r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.code}`}`);
        installed = true;
    }
    if (!existsSync(program)) return false;
    const at = relayOfUnit(text);
    if (!at) return false;
    const wanted = tunnelUnit(at.relay, at.port, program);
    if (text === wanted) {
        /* The same unit, a new program: what runs now is the old one until it is started again. */
        if (installed && process.getuid?.() === 0) await run(['systemctl', 'try-restart', 'clavarium-tunnel.service'], { timeoutMs: 60_000 });
        return installed;
    }
    writeFileSync(`${file}.new`, wanted, { mode: 0o644 });
    renameSync(`${file}.new`, file);
    if (process.getuid?.() === 0) {
        await run(['systemctl', 'daemon-reload'], { timeoutMs: 60_000 });
        await run(['systemctl', 'try-restart', 'clavarium-tunnel.service'], { timeoutMs: 60_000 });
    }
    return true;
}

