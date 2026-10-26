/* ---------------------------------------------------------------------------
 * THE SIGN-IN CLIENT ID. Between the sign-in proxy (oauth2-proxy) and the
 * small identity provider (dex), one OAuth client ties them together: dex
 * knows it under `staticClients`, the proxy names it as `client_id`. The two
 * MUST carry the same id, or no one can sign in.
 *
 * That id travels in the open: an unconnected browser sent to sign in gets a
 * redirect to .../auth?client_id=<id>... So the id tells nothing by default --
 * it is a random string (randomClientId), made at install. An operator who
 * needs a particular name (a third party that connects to this installation
 * one day) sets it: `sudo clavarium client-id <name>`.
 *
 * Installations made before this (26-10) carried the literal "clavarium",
 * which both named the product and gave it away. ensureGenericClientId, run
 * by the updater each turn, migrates such an installation ONCE to a random
 * id, writing dex and the proxy together so they never disagree -- and, should
 * a migration be cut off half-way, converges them on a later turn.
 *
 * A machine with no sign-in (local mode, --core-only) has neither file: then
 * every function here does nothing.
 * ------------------------------------------------------------------------- */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const DEX_CONF = '/etc/dex/config.yaml';
export const PROXY_CFG = '/etc/oauth2-proxy/oauth2-proxy.cfg';

/* What the installer wrote before the id was made generic: an installation
   still carrying either is migrated to a random id. */
export const LEGACY_ID = 'clavarium';
export const LEGACY_NAME = 'Clavarium';

/* A chosen id: letters and digits, with . _ - between them; no space, no colon,
   nothing that could break the YAML line or the proxy line it sits on. 64 max. */
export const VALID_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/* 32 hex characters: random, and telling nothing about what it is. */
export const randomClientId = () => randomBytes(16).toString('hex');

/* dex writes the client as "  - id: X" then, on the next line, "    name: Y".
   The proxy writes client_id = "X". These read and rewrite exactly those. */
const DEX_ID = /^(  - id: )(.*)$/m;
const DEX_NAME = /^(    name: )(.*)$/m;
const PROXY_ID = /^(client_id = ")([^"\n]*)(")/m;

export const dexClientId = (yaml) => DEX_ID.exec(yaml ?? '')?.[2]?.trim() ?? null;
export const dexClientName = (yaml) => DEX_NAME.exec(yaml ?? '')?.[2]?.trim() ?? null;
export const proxyClientId = (cfg) => PROXY_ID.exec(cfg ?? '')?.[2] ?? null;

export const withDexClient = (yaml, id, name) => yaml.replace(DEX_ID, `$1${id}`).replace(DEX_NAME, `$1${name}`);
export const withProxyClient = (cfg, id) => cfg.replace(PROXY_ID, `$1${id}$3`);

/* Writes BOTH files to the one id, so dex and the proxy never disagree. Each
   file is replaced atomically (.new then rename); as root the dex file is
   chowned back to root:dex and both services are restarted (dex first: the
   proxy talks to it). Returns the services whose file changed. Only the files
   that differ are touched, so this is safe to call again. */
export async function applyClientId({ dexConf = DEX_CONF, proxyCfg = PROXY_CFG, id, name = id, run, isRoot = process.getuid?.() === 0 } = {}) {
    let dex; let proxy;
    try { dex = readFileSync(dexConf, 'utf8'); proxy = readFileSync(proxyCfg, 'utf8'); } catch { return { changed: [], id: null }; }
    const changed = [];
    if (dexClientId(dex) !== id || dexClientName(dex) !== name) {
        writeFileSync(`${dexConf}.new`, withDexClient(dex, id, name), { mode: 0o640 });
        if (isRoot && run) await run(['chown', 'root:dex', `${dexConf}.new`]);
        renameSync(`${dexConf}.new`, dexConf);
        changed.push('dex');
    }
    if (proxyClientId(proxy) !== id) {
        writeFileSync(`${proxyCfg}.new`, withProxyClient(proxy, id), { mode: 0o600 });
        renameSync(`${proxyCfg}.new`, proxyCfg);
        changed.push('oauth2-proxy');
    }
    if (changed.length && isRoot && run) {
        await run(['systemctl', 'restart', 'dex.service'], { timeoutMs: 60_000 });
        await run(['systemctl', 'restart', 'oauth2-proxy.service'], { timeoutMs: 60_000 });
    }
    return { changed, id };
}

/* Idempotent, each updater turn. An installation still on the legacy id (or
   name), or one left disagreeing by a cut-off migration, is converged onto a
   single non-revealing id -- a fresh random one if it was still the legacy id,
   otherwise the id dex already carries, with the proxy brought into line. */
export async function ensureGenericClientId({ dexConf = DEX_CONF, proxyCfg = PROXY_CFG, run, isRoot } = {}) {
    let dex; let proxy;
    try { dex = readFileSync(dexConf, 'utf8'); proxy = readFileSync(proxyCfg, 'utf8'); } catch { return { changed: [], id: null }; }
    const dexId = dexClientId(dex); const dexName = dexClientName(dex); const proxyId = proxyClientId(proxy);
    const legacy = dexId === null || dexId === LEGACY_ID || dexName === LEGACY_NAME;
    const id = legacy ? randomClientId() : dexId;
    const name = legacy ? id : (dexName ?? id);
    if (dexId === id && dexName === name && proxyId === id) return { changed: [], id };
    return applyClientId({ dexConf, proxyCfg, id, name, run, isRoot });
}

/* `sudo clavarium client-id [VALUE]`: set a particular id (a third party that
   connects here), or, with no value or --random, a fresh random one. */
export async function setClientId({ value, dexConf = DEX_CONF, proxyCfg = PROXY_CFG, run, isRoot } = {}) {
    const id = value && value !== '--random' ? value : randomClientId();
    if (!VALID_ID.test(id)) throw new Error('a client id is letters, digits and . _ - (no spaces), 64 at most');
    try { readFileSync(dexConf, 'utf8'); } catch { throw new Error('no sign-in on this machine (local mode): nothing to set'); }
    return applyClientId({ dexConf, proxyCfg, id, name: id, run, isRoot });
}
