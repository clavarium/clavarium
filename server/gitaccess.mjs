/* HOW THIS SERVER GETS INTO A PRIVATE REPOSITORY -- and why only it does.
 *
 * A repository may be cloned from a private remote, over SSH or HTTPS. What
 * opens it -- a key, a token, a password -- is kept HERE, sealed in the vault,
 * and used here only: for the clone, for every later fetch, and for Send.
 * The agent's machine never receives it, for the same reason the push key
 * never enters a machine: what a tool holds, a tool can lose or misuse.
 *
 * THE SAFEST WAY IS A KEY MADE HERE. The private half is generated on this
 * server and never leaves it: it is not sent to the page, not written into a
 * machine, not logged, never on a command line. Only its public half is
 * shown, to be pasted into the hosting service as a deploy key. One key may
 * serve several repositories (a hosting service decides whether it accepts
 * that), so keys are named things of their own, and a key in use cannot be
 * removed: that would silently cut a repository off.
 *
 * Git reads an SSH key from a file. So for the length of ONE git command the
 * key is written to a 0600 file in a directory only this server reads, and
 * removed right after, whatever happened. ssh is told to use that key and
 * nothing else, never to ask anything, and to trust a host on first contact
 * only: the host key seen then is recorded, and a different one later is
 * refused (the remote may not be who it says).
 *
 * A token or a password reaches git through its environment, as a header
 * setting, never in the address (git would write the address into the
 * repository the tool can read) and never on a command line.
 */
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, renameSync } from 'node:fs';
import { Refusal } from './conversations.mjs';
import { isConversationName } from './names.mjs';
import { Store } from './store.mjs';

export const METHODS = ['ssh-key', 'token', 'password', 'none'];
export const ADDRESS_MAX = 500;
const FORMS = 'A repository address is https://host/path, ssh://user@host/path or user@host:path.';
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\])$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const PATH = /^[A-Za-z0-9._~\/+@-]{1,400}$/;

/* Where a repository may come from, read strictly: { url, transport, host, port }.
   transport: 'https', 'ssh', or 'local' (a directory, for tests only).
   Anything else is refused BEFORE git sees it: a password in the address (it
   would be written into the repository), a local path or file:// (this
   server's own files), a value a command line would take for an option. */
export function readAddress(from, { localRemotes = false } = {}) {
    if (from === undefined || from === null) return undefined;
    const text = String(from).trim();
    if (text === '') return undefined;
    const refuse = (why) => { throw new Refusal(400, `${why} ${FORMS}`); };
    if (text.length > ADDRESS_MAX) refuse('This address is too long.');
    if (/[\s\x00-\x1f\x7f]/.test(text)) refuse('An address has no space and no control character.');
    if (text.startsWith('-')) refuse('An address does not start with "-".');
    if (localRemotes && text.startsWith('/')) return { url: text, transport: 'local', host: '', port: '' };
    if (/^https:\/\//i.test(text)) {
        let url; try { url = new URL(text); } catch { refuse('This https address cannot be read.'); }
        if (url.username !== '' || url.password !== '') refuse('An address carries no user name or password: give them apart, they are kept sealed.');
        if (!HOST.test(url.hostname) || url.pathname.length < 2) refuse('This https address has no host or no path.');
        return { url: url.href, transport: 'https', host: url.hostname, port: url.port };
    }
    if (/^ssh:\/\//i.test(text)) {
        let url; try { url = new URL(text); } catch { refuse('This ssh address cannot be read.'); }
        if (url.password !== '') refuse('An address carries no password.');
        if (!HOST.test(url.hostname) || (url.username !== '' && !USER.test(url.username)) || !PATH.test(url.pathname) || url.pathname.length < 2) refuse('This ssh address has an odd host, user or path.');
        return { url: text, transport: 'ssh', host: url.hostname, port: url.port };
    }
    /* scp-like: user@host:path. The user is required, so that a local path
       with a colon in it is never taken for a remote. */
    const scp = /^([^@/:]+)@([^:/]+):(.+)$/.exec(text);
    if (scp) {
        if (!USER.test(scp[1]) || !HOST.test(scp[2]) || !PATH.test(scp[3]) || scp[3].startsWith('-')) refuse('This ssh address has an odd host, user or path.');
        return { url: text, transport: 'ssh', host: scp[2], port: '' };
    }
    return refuse('This is not an address a repository is cloned from.');
}

/* What git says when it could not get in, said for a person. */
export function explain(stderr) {
    const text = String(stderr ?? '');
    if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return 'The remote server showed a different host key from the one recorded the first time it was reached: nothing was done. It may not be the server it claims to be.';
    if (/Permission denied \(publickey/i.test(text)) return 'The key was refused: add its public key to the repository on the hosting service (as a deploy key), then try again.';
    if (/Authentication failed|HTTP Basic: Access denied|could not read Username|returned error: 40[13]/i.test(text)) return 'The remote asked for a token or a password, or refused the one given, or it gives no right on this repository.';
    return String(text).trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
}

/* What the remote's own hooks said (pre-receive, update: the "remote:" lines of a push), for a
   person and for the agent: colours and control characters out, git's progress lines out, the
   last REMOTE_LINES lines, REMOTE_CHARS characters at most. Text of the remote: data, quoted. */
export const REMOTE_LINES = 20;
export const REMOTE_CHARS = 1500;
export function remoteSaid(stderr) {
    const lines = String(stderr ?? '').split(/\r?\n|\r/)
        .filter((l) => /^remote:/.test(l))
        .map((l) => l.replace(/^remote:\s?/, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trimEnd())
        .filter((l) => l.trim() && !/^(Resolving deltas|Counting objects|Compressing objects|Processing changes|Total \d|Enumerating objects|Writing objects)\b/.test(l.trim()));
    /* A very talkative hook: the lines that say what is wrong first (error, refused, must…), in their
       order, then the end of what it said, up to REMOTE_LINES; "[N lines left out]" where lines went. */
    let kept = lines;
    if (lines.length > REMOTE_LINES) {
        const telling = new Set(lines.map((l, i) => (/\b(error|errors|denied|reject|rejected|refused|must|fail|failed|failure|forbidden|invalid|not allowed|violation|required|missing|GH\d{3})\b/i.test(l) ? i : -1)).filter((i) => i >= 0).slice(0, REMOTE_LINES - 5));
        for (let i = lines.length - 1; telling.size < REMOTE_LINES && i >= 0; i -= 1) telling.add(i);
        const picked = [...telling].sort((a, b) => a - b);
        kept = [];
        picked.forEach((i, k) => { const gap = i - (k ? picked[k - 1] + 1 : 0); if (gap > 0) kept.push(`[${gap} line${gap > 1 ? 's' : ''} left out]`); kept.push(lines[i]); });
    }
    let text = kept.join('\n');
    if (text.length > REMOTE_CHARS) text = `…${text.slice(-REMOTE_CHARS)}`;
    return text;
}

/* An ed25519 key pair in the formats OpenSSH reads, made with Node's own
   crypto: no program is run and nothing touches the disk. The private key is
   the unencrypted "openssh-key-v1" container (it is encrypted by the vault). */
export function makeEd25519(comment) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d, 'base64url'); const pub = Buffer.from(jwk.x, 'base64url');
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const str = (v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'); return Buffer.concat([u32(b.length), b]); };
    const blob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
    const check = randomBytes(4);
    const secret = Buffer.concat([seed, pub]);
    let inner = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(secret), str(comment)]);
    const pad = []; for (let i = 1; (inner.length + pad.length) % 8 !== 0; i += 1) pad.push(i);
    inner = Buffer.concat([inner, Buffer.from(pad)]);
    const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'binary'), str('none'), str('none'), str(''), u32(1), str(blob), str(inner)]);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
    /* The raw secret is not left lying in memory longer than needed. */
    seed.fill(0); secret.fill(0); inner.fill(0); body.fill(0);
    return { publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, privateKey: pem, fingerprint: fingerprintOf(blob) };
}
const fingerprintOf = (blob) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

/* Settings handed to git through its environment: [[key, value], ...]. */
export const asEnv = (pairs) => Object.fromEntries([['GIT_CONFIG_COUNT', String(pairs.length)], ...pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])]);
const basic = (user, secret) => Buffer.from(`${user}:${secret}`).toString('base64');
/* GIT_SSH_COMMAND is read by a shell (git's, not ours): every value is quoted. */
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const originOf = (address) => `https://${address.host}${address.port ? `:${address.port}` : ''}`;

export class GitAccess {
    #keys; #credentials; #vault; #dir; #ssh;

    /* `ssh`: the ssh program. A test gives a stand-in that plays a remote. */
    constructor({ vault, dataDir, keys = new Store(`${dataDir}/git-keys.json`), credentials = new Store(`${dataDir}/git-access.json`), ssh = 'ssh' }) {
        this.#vault = vault; this.#keys = keys; this.#credentials = credentials; this.#dir = `${dataDir}/git-ssh`; this.#ssh = ssh;
        /* A key file outlives its command only if this server was stopped in
           the middle of one: whatever is left there is removed at start. */
        rmSync(this.runDir, { recursive: true, force: true });
    }

    get knownHosts() { return `${this.#dir}/known_hosts`; }
    /* Where a key lives for the length of one git command. */
    get runDir() { return `${this.#dir}/run`; }

    #usersOf(key) { return this.#credentials.all().filter((c) => c.method === 'ssh-key' && c.key === key).map((c) => c.name); }

    /* What the page may know of the keys: the public half, never the private one. */
    keys() {
        return this.#keys.all().map((k) => ({ name: k.name, publicKey: k.publicKey, fingerprint: k.fingerprint, createdAt: k.createdAt, usedBy: this.#usersOf(k.name) }));
    }
    #publicOf(name) { return this.keys().find((k) => k.name === name); }

    makeKey(body) {
        const name = String(body?.name ?? '').trim();
        if (!isConversationName(name)) throw new Refusal(400, 'A key name is 1 to 32 lower-case letters, digits or hyphens; it starts with a letter and does not end with a hyphen.');
        if (this.#keys.get(name)) throw new Refusal(409, 'A key already has this name.');
        /* The comment names the key, never a person or a machine. */
        const made = makeEd25519(`clavarium-${name}`);
        this.#keys.put({ name, publicKey: made.publicKey, fingerprint: made.fingerprint, sealed: this.#vault.seal(made.privateKey), createdAt: new Date().toISOString() });
        made.privateKey = '';
        return this.#publicOf(name);
    }

    /* A key that a repository uses is not removed: that would cut it off without a word. */
    removeKey(name) {
        if (!this.#keys.get(String(name))) throw new Refusal(404, 'No such key.');
        const used = this.#usersOf(String(name));
        if (used.length > 0) throw new Refusal(409, `This key is how ${used.join(', ')} ${used.length > 1 ? 'are' : 'is'} reached: removing it would cut ${used.length > 1 ? 'them' : 'it'} off. Remove ${used.length > 1 ? 'those repositories' : 'that repository'} first.`);
        this.#keys.remove(String(name));
    }

    /* How a repository is reached, as the page may see it: no secret in it. */
    describe(repository, from) {
        const c = this.#credentials.get(repository);
        let address; try { address = readAddress(from); } catch { address = undefined; }
        const hostKey = address?.transport === 'ssh' ? this.hostKeyOf(address) : undefined;
        return { method: c?.method ?? 'none', ...(c?.key ? { key: c.key } : {}), ...(c?.user ? { user: c.user } : {}), ...(hostKey ? { hostKey } : {}) };
    }

    /* Reads a way in asked by the page, before anything is made. Returns
       what is to be remembered (the secret already sealed), or undefined. */
    prepare(address, via) {
        if (!address) return undefined;
        const method = String(via?.method ?? 'none');
        if (!METHODS.includes(method)) throw new Refusal(400, 'The way in is an SSH key made here, an access token, a user name and password, or none.');
        if (address.transport === 'local') return undefined;
        if (method === 'ssh-key') {
            if (address.transport !== 'ssh') throw new Refusal(400, 'An SSH key is used with an ssh address (user@host:path or ssh://...). For an https address, choose a token, a password, or none.');
            const key = String(via?.key ?? '');
            if (!key) throw new Refusal(400, 'Choose a key, or make a new one.');
            if (!this.#keys.get(key)) throw new Refusal(404, 'No such key.');
            return { method, key };
        }
        if (method === 'none') {
            if (address.transport === 'ssh') throw new Refusal(400, 'An ssh address needs a key: make one here, add its public key to the repository, then clone.');
            return undefined;
        }
        if (address.transport !== 'https') throw new Refusal(400, 'A token or a password is used with an https address.');
        const user = String(via?.user ?? '').trim();
        const secret = String(via?.secret ?? '');
        if (user.length > 100 || /[\s:\x00-\x1f]/.test(user)) throw new Refusal(400, 'A user name has no space, no colon and is at most 100 characters.');
        if (method === 'password' && !user) throw new Refusal(400, 'A password goes with a user name.');
        if (!secret) throw new Refusal(400, method === 'token' ? 'The token is missing.' : 'The password is missing.');
        if (secret.length > 1000 || /[\r\n\0]/.test(secret)) throw new Refusal(400, 'A token or a password is one line.');
        return { method, ...(user ? { user } : {}), origin: originOf(address), sealed: this.#vault.seal(secret) };
    }

    remember(repository, credential) {
        if (credential) this.#credentials.put({ name: repository, ...credential });
        else this.#credentials.remove(repository);
    }
    /* The stored way in of a repository (the secret still sealed), for Send. */
    credentialOf(repository) { return this.#credentials.get(repository); }
    /* A repository that is sent over ssh with a key made here. */
    useKey(repository, key) {
        if (!this.#keys.get(String(key ?? ''))) throw new Refusal(404, 'No such key.');
        this.#credentials.put({ name: repository, method: 'ssh-key', key: String(key) });
    }
    /* The repository is gone: its way in goes with it (a key stays, it is a thing of its own). */
    forget(repository) { this.#credentials.remove(repository); }

    /* The host keys recorded for an address, as fingerprints. */
    hostKeyOf(address) {
        const names = new Set([address.host, `[${address.host}]:${address.port || 22}`]);
        return this.#hostLines().filter((l) => names.has(l.host)).map((l) => `${l.type} ${l.fingerprint}`).join(', ') || undefined;
    }
    /* Every host recorded, as the page may show it: { host, type, fingerprint }. */
    hosts() {
        return this.#hostLines().map(({ host, type, fingerprint }) => ({ host, type, fingerprint }))
            .sort((a, b) => a.host.localeCompare(b.host) || a.type.localeCompare(b.type));
    }

    /* FORGETTING A HOST, for the rare day a hosting service really changes
       its key. Until then a different key is refused, which is the point;
       after this, the NEXT contact trusts whatever key the host shows, as
       on the very first contact. So it is the owner's decision, made in
       Settings, never automatic. The other hosts are kept as they were. */
    forgetHost(host) {
        const name = String(host ?? '');
        if (!this.hosts().some((h) => h.host === name)) throw new Refusal(404, 'No key is recorded for this host.');
        let text = ''; try { text = readFileSync(this.knownHosts, 'utf8'); } catch { /* nothing recorded */ }
        const kept = text.split('\n').flatMap((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3 || parts[0].startsWith('#')) return line.trim() ? [line] : [];
            const others = parts[0].split(',').filter((h) => h !== name);
            return others.length === 0 ? [] : [[others.join(','), ...parts.slice(1)].join(' ')];
        });
        /* Written whole and then put in place: a stop halfway leaves the old file, never half of one. */
        const next = `${this.knownHosts}.new`;
        writeFileSync(next, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
        renameSync(next, this.knownHosts);
        return this.hosts();
    }
    #hostLines() {
        let text = ''; try { text = readFileSync(this.knownHosts, 'utf8'); } catch { return []; }
        return text.split('\n').map((line) => line.trim().split(/\s+/)).filter((p) => p.length >= 3 && !p[0].startsWith('#'))
            .flatMap(([hosts, type, b64]) => hosts.split(',').map((host) => ({ host, type, fingerprint: fingerprintOf(Buffer.from(b64, 'base64')), line: `${hosts} ${type} ${b64}` })));
    }

    /* Runs `work(env)` with what git needs to reach `address` with
       `credential` -- and leaves nothing behind. Returns
       { result, firstSeen }: firstSeen lists the host keys recorded by this
       very contact. A credential only goes where it belongs: a token to the
       https origin it was given for, a key only over ssh. */
    async run(credential, address, work) {
        if (address?.transport === 'ssh') {
            mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
            chmodSync(this.#dir, 0o700); chmodSync(this.runDir, 0o700);
            let keyFile;
            if (credential?.method === 'ssh-key') {
                const key = this.#keys.get(credential.key);
                if (!key) throw new Refusal(409, `The key "${credential.key}" this repository used is gone.`);
                keyFile = `${this.runDir}/${randomBytes(12).toString('hex')}`;
                writeFileSync(keyFile, this.#vault.open(key.sealed), { mode: 0o600, flag: 'wx' });
            }
            const before = new Set(this.#hostLines().map((l) => l.line));
            try {
                const result = await work(this.#sshEnv(keyFile));
                const firstSeen = [...new Set(this.#hostLines().filter((l) => !before.has(l.line)).map((l) => `${l.type} ${l.fingerprint}`))];
                return { result, firstSeen };
            } finally {
                if (keyFile) rmSync(keyFile, { force: true });
            }
        }
        if (address?.transport === 'https' && (credential?.method === 'token' || credential?.method === 'password') && credential.origin === originOf(address)) {
            const secret = this.#vault.open(credential.sealed);
            const header = basic(credential.user || 'x-access-token', secret);
            const result = await work(asEnv([['http.extraHeader', `Authorization: Basic ${header}`]]));
            /* Git does not print what it sends; were it ever to, it would not get further than here. */
            if (result && typeof result.stderr === 'string') result.stderr = result.stderr.split(secret).join('[hidden]').split(header).join('[hidden]');
            return { result, firstSeen: [] };
        }
        return { result: await work({}), firstSeen: [] };
    }

    /* ssh reads no configuration of this machine (-F /dev/null), offers the
       one key it is given or none at all, never asks a question, and trusts
       a host on first contact only, recording it in a file of its own. */
    #sshEnv(keyFile) {
        const argv = [quote(this.#ssh), '-F', '/dev/null',
            ...(keyFile ? ['-i', quote(keyFile)] : ['-o', 'IdentityFile=none']),
            '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
            '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
            '-o', `UserKnownHostsFile=${quote(this.knownHosts)}`, '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'StrictHostKeyChecking=accept-new', '-o', 'HashKnownHosts=no', '-o', 'UpdateHostKeys=no',
            '-o', 'ConnectTimeout=20', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes'];
        return { GIT_SSH_COMMAND: argv.join(' '), GIT_SSH_VARIANT: 'ssh' };
    }
}
