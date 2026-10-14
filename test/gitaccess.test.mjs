/* Private repositories: where one may come from, the keys made here, and the
   way in -- used by this server only, through git's environment. Cloning and
   sending over ssh are played with a real git and a stand-in ssh. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitAccess, readAddress, makeEd25519 } from '../server/gitaccess.mjs';
import { Resources } from '../server/resources.mjs';
import { GitReview } from '../server/gitpush.mjs';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Vms } from '../server/vm.mjs';
import { installFakeSsh, FAKE_HOST_KEY } from '../e2e/fake-ssh.mjs';

const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hasKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

function bench(t, { git: fakeGit } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-access-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sshRoot = join(dir, 'far');
    const ssh = installFakeSsh(sshRoot);
    const vault = new Vault(join(dir, 'vault.key'));
    const access = new GitAccess({ vault, dataDir: join(dir, 'data'), ssh });
    const resources = new Resources({
        store: new Store(join(dir, 'data', 'resources.json')), vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']),
        host: async (argv) => {
            if (argv[0] === 'folder' && argv[1] === 'make') mkdirSync(join(dir, 'data', 'resources', argv[2]), { recursive: true });
            if (argv[0] === 'folder' && argv[1] === 'aside') rmSync(join(dir, 'data', 'resources', argv[2]), { recursive: true, force: true });
            return { code: 0, stdout: '', stderr: '' };
        },
        dataDir: join(dir, 'data'), uid: 1, gid: 1, access, ...(fakeGit ? { git: fakeGit } : {}),
    });
    const review = new GitReview({ store: new Store(join(dir, 'data', 'git.json')), vault, resources, dataDir: join(dir, 'data'), access, ...(fakeGit ? { git: (argv, o) => fakeGit(argv, o.cwd, o.env) } : {}) });
    /* A bare repository "on the hosting service", reached as user@example.com:team/<name>.git */
    const remote = (name, withCommit = true) => {
        const bare = join(sshRoot, 'remotes', 'team', `${name}.git`);
        mkdirSync(bare, { recursive: true });
        git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
        if (withCommit) {
            const seed = join(dir, `seed-${name}`);
            git(dir, 'clone', '--quiet', bare, seed);
            writeFileSync(join(seed, 'README.md'), `# ${name}\n`); git(seed, 'add', 'README.md'); git(seed, 'commit', '--quiet', '-m', 'Start'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
        }
        return bare;
    };
    const sshLog = () => (existsSync(join(sshRoot, 'ssh-log')) ? readFileSync(join(sshRoot, 'ssh-log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    return { dir, sshRoot, vault, access, resources, review, remote, sshLog };
}

test('an address is https, ssh:// or user@host:path -- and nothing a command line or this machine could take for something else', () => {
    assert.deepEqual(readAddress('https://example.com/team/site.git'), { url: 'https://example.com/team/site.git', transport: 'https', host: 'example.com', port: '' });
    assert.equal(readAddress('ssh://git@example.com:2222/team/site.git').transport, 'ssh');
    assert.equal(readAddress('ssh://git@example.com:2222/team/site.git').port, '2222');
    assert.equal(readAddress('ssh://example.com/team/site.git').host, 'example.com');
    assert.deepEqual(readAddress('git@example.com:team/site.git'), { url: 'git@example.com:team/site.git', transport: 'ssh', host: 'example.com', port: '' });
    assert.equal(readAddress('  git@example.com:/srv/site.git  ').url, 'git@example.com:/srv/site.git');
    assert.equal(readAddress(''), undefined);
    assert.equal(readAddress(undefined), undefined);
    for (const bad of [
        'https://user:pw@example.com/x.git', 'https://token@example.com/x.git', 'ssh://git:pw@example.com/x.git',
        'http://example.com/x.git', 'file:///etc', '/srv/repo.git', './repo', '../repo', 'repo', 'C:/repo',
        'ext::sh -c touch% /tmp/x', '--upload-pack=touch /tmp/x', '-oProxyCommand=x', 'ssh://-oProxyCommand=x/y',
        'git@-oProxyCommand=x:y', 'git@example.com:-x', 'git@example.com:', 'https://example.com/x y.git',
        'git@example.com:team/x\n.git', 'git@example.com:team/x\u0007.git', `https://example.com/${'a'.repeat(600)}`,
        'example.com:team/x.git', 'ftp://example.com/x.git',
    ]) assert.throws(() => readAddress(bad), /repository address is https/, bad);
    /* A directory is a remote only where a test says so. */
    assert.equal(readAddress('/srv/repo.git', { localRemotes: true }).transport, 'local');
});

test('a key made here: its public half is an OpenSSH ed25519 line, its private half is sealed and never said', { skip: !hasKeygen && 'ssh-keygen is not installed' }, async (t) => {
    const b = bench(t);
    const said = [];
    const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(keep)) console[k] = (...a) => said.push(a.join(' '));
    t.after(() => Object.assign(console, keep));
    const key = b.access.makeKey({ name: 'deploy-a' });
    assert.match(key.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} clavarium-deploy-a$/);
    assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'fingerprint', 'name', 'publicKey', 'usedBy']);
    /* OpenSSH reads it, and finds the same fingerprint. */
    writeFileSync(join(b.dir, 'k.pub'), `${key.publicKey}\n`);
    assert.match(execFileSync('ssh-keygen', ['-l', '-f', join(b.dir, 'k.pub')], { encoding: 'utf8' }), new RegExp(`^256 ${key.fingerprint.replace(/[+/]/g, '\\$&')} clavarium-deploy-a \\(ED25519\\)`));
    /* The private half: only sealed on disk, nowhere in what is answered. */
    const stored = readFileSync(join(b.dir, 'data', 'git-keys.json'), 'utf8');
    assert.equal(stored.includes('PRIVATE KEY'), false);
    const sealed = JSON.parse(stored)[0].sealed;
    const privateKey = b.vault.open(sealed);
    assert.match(privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    for (const answer of [b.access.keys(), key, b.access.describe('x')]) {
        assert.equal(JSON.stringify(answer).includes('PRIVATE'), false);
        assert.equal(JSON.stringify(answer).includes(sealed), false);
    }
    /* And it is the private key of that public key. */
    writeFileSync(join(b.dir, 'k'), privateKey, { mode: 0o600 });
    assert.equal(execFileSync('ssh-keygen', ['-y', '-f', join(b.dir, 'k')], { encoding: 'utf8' }).trim(), key.publicKey);
    assert.throws(() => b.access.makeKey({ name: 'deploy-a' }), /already has this name/);
    assert.throws(() => b.access.makeKey({ name: '../x' }), /A key name is/);
    assert.notEqual(makeEd25519('c').publicKey, makeEd25519('c').publicKey, 'two keys are two keys');
    assert.deepEqual(said, [], 'nothing was logged');
});

test('a way in is checked before anything is made: the method must suit the address', (t) => {
    const b = bench(t);
    b.access.makeKey({ name: 'deploy-a' });
    const ssh = readAddress('git@example.com:team/site.git'); const https = readAddress('https://example.com/team/site.git');
    assert.deepEqual(b.access.prepare(ssh, { method: 'ssh-key', key: 'deploy-a' }), { method: 'ssh-key', key: 'deploy-a' });
    assert.equal(b.access.prepare(https, { method: 'none' }), undefined);
    assert.equal(b.access.prepare(https), undefined);
    const token = b.access.prepare(https, { method: 'token', secret: 'tok-123' });
    assert.deepEqual([token.method, token.origin, token.user], ['token', 'https://example.com', undefined]);
    assert.equal(b.vault.open(token.sealed), 'tok-123');
    assert.equal(JSON.stringify(token).includes('tok-123'), false);
    assert.equal(b.access.prepare(https, { method: 'password', user: 'robin', secret: 'pw' }).user, 'robin');
    for (const [address, via, why] of [
        [https, { method: 'ssh-key', key: 'deploy-a' }, /SSH key is used with an ssh address/],
        [ssh, { method: 'ssh-key' }, /Choose a key/],
        [ssh, { method: 'ssh-key', key: 'nope' }, /No such key/],
        [ssh, { method: 'none' }, /needs a key/],
        [ssh, { method: 'token', secret: 'x' }, /used with an https address/],
        [https, { method: 'token' }, /token is missing/],
        [https, { method: 'password', secret: 'pw' }, /goes with a user name/],
        [https, { method: 'token', secret: 'two\nlines' }, /one line/],
        [https, { method: 'token', user: 'a:b', secret: 'x' }, /no colon/],
        [https, { method: 'magic' }, /way in is/],
    ]) assert.throws(() => b.access.prepare(address, via), why, JSON.stringify(via));
});

test('cloned over ssh with a key made here: the key is a 0600 file for one command, then gone; ssh is told to trust nothing else', { skip: !hasKeygen && 'ssh-keygen is not installed' }, async (t) => {
    const b = bench(t);
    b.remote('site');
    const key = b.access.makeKey({ name: 'deploy-a' });
    /* Not yet added on the hosting service: refused, said plainly, nothing left. */
    writeFileSync(join(b.sshRoot, 'authorized_keys'), '');
    await assert.rejects(b.resources.create({ name: 'site', type: 'git', from: 'git@example.com:team/site.git', via: { method: 'ssh-key', key: 'deploy-a' } }), /key was refused: add its public key/);
    assert.equal(b.resources.get('site'), undefined);
    assert.deepEqual(readdirSync(b.access.runDir), [], 'the key file was removed after a failure too');
    /* Added (as the owner pastes it into the hosting service). */
    writeFileSync(join(b.sshRoot, 'authorized_keys'), `${key.publicKey}\n`);
    const made = await b.resources.create({ name: 'site', type: 'git', from: 'git@example.com:team/site.git', via: { method: 'ssh-key', key: 'deploy-a' } });
    assert.equal(readFileSync(join(b.dir, 'data', 'resources', 'site', 'README.md'), 'utf8'), '# site\n');
    /* The host was met by the refused attempt already: its key was recorded then. */
    assert.equal(made.firstSeen, undefined);
    const hostKey = `ssh-ed25519 SHA256:${createHash('sha256').update(Buffer.from(FAKE_HOST_KEY, 'base64')).digest('base64').replace(/=+$/, '')}`;
    assert.deepEqual(made.via, { method: 'ssh-key', key: 'deploy-a', hostKey });
    const call = b.sshLog().at(-1);
    assert.equal(call.keyMode, '600', 'the key file was readable by this server only');
    assert.equal(call.derived, key.publicKey, 'and it was that key');
    assert.ok(call.keyFile.startsWith(b.access.runDir));
    assert.equal(existsSync(call.keyFile), false, 'and it is gone');
    assert.deepEqual(readdirSync(b.access.runDir), []);
    for (const option of ['IdentitiesOnly=yes', 'BatchMode=yes', 'StrictHostKeyChecking=accept-new', 'IdentityAgent=none', `UserKnownHostsFile=${b.access.knownHosts}`, 'GlobalKnownHostsFile=/dev/null']) assert.ok(call.argv.includes(option), option);
    assert.deepEqual(call.argv.slice(0, 2), ['-F', '/dev/null']);
    assert.equal(call.argv.join(' ').includes('PRIVATE'), false, 'the key itself is never an argument');
    assert.match(readFileSync(b.access.knownHosts, 'utf8'), new RegExp(`^example\\.com ssh-ed25519 ${FAKE_HOST_KEY.replace(/[+/]/g, '\\$&')}$`, 'm'));
    /* The tool's copy knows where it came from, and holds no secret. */
    assert.equal(git(join(b.dir, 'data', 'resources', 'site'), 'config', 'remote.origin.url'), 'git@example.com:team/site.git');
    assert.equal(JSON.stringify(b.resources.list()).includes('PRIVATE'), false);
    /* One key, several repositories: it says which, and it is not removed while used. */
    b.remote('docs');
    const second = await b.resources.create({ name: 'docs', type: 'git', from: 'ssh://git@example.org/team/docs.git', via: { method: 'ssh-key', key: 'deploy-a' } });
    assert.deepEqual(second.firstSeen, [hostKey], 'a host met for the first time is said once');
    assert.equal(second.via.hostKey, hostKey);
    assert.deepEqual(b.access.keys()[0].usedBy, ['site', 'docs']);
    assert.throws(() => b.access.removeKey('deploy-a'), /how site, docs are reached: removing it would cut them off/);
    b.review.forget('site'); b.review.forget('docs');
    b.access.removeKey('deploy-a');
    assert.deepEqual(b.access.keys(), []);
    assert.throws(() => b.access.removeKey('deploy-a'), /No such key/);
});

test('what was cloned over ssh is sent back with the same key, and the key leaves nothing behind', { skip: !hasKeygen && 'ssh-keygen is not installed' }, async (t) => {
    const b = bench(t);
    const bare = b.remote('site');
    const key = b.access.makeKey({ name: 'deploy-a' });
    writeFileSync(join(b.sshRoot, 'authorized_keys'), `${key.publicKey}\n`);
    await b.resources.create({ name: 'site', type: 'git', from: 'git@example.com:team/site.git', via: { method: 'ssh-key', key: 'deploy-a' } });
    const work = join(b.dir, 'data', 'resources', 'site');
    writeFileSync(join(work, 'page.html'), '<p>hi</p>\n'); git(work, 'add', 'page.html'); git(work, 'commit', '--quiet', '-m', 'Add a page');
    assert.deepEqual(b.review.settings('site'), { remote: 'git@example.com:team/site.git', user: null, hasKey: false, sshKey: 'deploy-a' });
    const seen = await b.review.outgoing('site');
    assert.equal(seen.state, 'ahead', seen.message);
    assert.deepEqual(seen.commits.map((c) => c.subject), ['Add a page']);
    await b.review.push('site', { head: seen.head });
    assert.equal(git(bare, 'log', '--format=%s', '-1', 'main'), 'Add a page');
    assert.ok(b.sshLog().every((c) => c.keyMode === '600' && !existsSync(c.keyFile)));
    assert.deepEqual(readdirSync(b.access.runDir), []);
    /* A key that is not let in: what the remote said, put plainly. */
    writeFileSync(join(b.sshRoot, 'authorized_keys'), '');
    assert.match((await b.review.outgoing('site')).message, /key was refused/);
    /* An empty repository may be pointed at an ssh remote with a key made here. */
    const other = b.access.makeKey({ name: 'deploy-b' });
    writeFileSync(join(b.sshRoot, 'authorized_keys'), `${other.publicKey}\n`);
    b.review.setRemote('site', { url: 'git@example.com:team/site.git', sshKey: 'deploy-b' });
    assert.equal(b.review.settings('site').sshKey, 'deploy-b');
    assert.equal((await b.review.outgoing('site')).state, 'up-to-date');
    assert.throws(() => b.review.setRemote('site', { url: 'https://example.com/team/site.git', sshKey: 'deploy-b' }), /used with an ssh address/);
    assert.throws(() => b.review.setRemote('site', { url: 'git@example.com:team/site.git', sshKey: 'nope' }), /No such key/);
});

test('a token or a password goes to git in its environment, never in argv, and only back to the origin it was given for', async (t) => {
    const ran = [];
    const fake = async (argv, cwd, env = {}) => { ran.push({ argv, env }); return { code: 0, stdout: '', stderr: '' }; };
    const b = bench(t, { git: fake });
    const made = await b.resources.create({ name: 'site', type: 'git', from: 'https://example.com/team/site.git', via: { method: 'token', secret: 'tok-very-secret' } });
    const header = `Authorization: Basic ${Buffer.from('x-access-token:tok-very-secret').toString('base64')}`;
    const clone = ran.find((r) => r.argv.includes('clone'));
    assert.deepEqual([clone.env.GIT_CONFIG_KEY_0, clone.env.GIT_CONFIG_VALUE_0, clone.env.GIT_CONFIG_COUNT], ['http.extraHeader', header, '1']);
    assert.equal(JSON.stringify(clone.argv).includes('tok-very-secret'), false);
    assert.equal(JSON.stringify(clone.argv).includes(header.slice(21)), false);
    assert.equal(clone.argv.at(-2), 'https://example.com/team/site.git', 'the address carries no secret');
    assert.deepEqual(made.via, { method: 'token' });
    for (const file of ['resources.json', 'git-access.json']) assert.equal(readFileSync(join(b.dir, 'data', file), 'utf8').includes('tok-very-secret'), false, file);
    assert.equal(JSON.stringify(b.resources.list()).includes('sealed'), false, 'not even sealed, it is not shown');

    await b.resources.create({ name: 'old', type: 'git', from: 'https://example.com/team/old.git', via: { method: 'password', user: 'robin', secret: 'pw-123' } });
    assert.equal(ran.at(-1).env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('robin:pw-123').toString('base64')}`);
    assert.deepEqual(b.resources.list().find((r) => r.name === 'old').via, { method: 'password', user: 'robin' });
    /* A public one: nothing is added. */
    await b.resources.create({ name: 'open', type: 'git', from: 'https://example.com/team/open.git' });
    assert.equal(ran.at(-1).env.GIT_CONFIG_COUNT, undefined);

    /* Send: the same token by default, to the same origin only. */
    const push = new GitReview({ store: new Store(join(b.dir, 'data', 'git.json')), vault: b.vault, resources: b.resources, dataDir: join(b.dir, 'data'), access: b.access,
        git: async (argv, { env = {} } = {}) => { ran.push({ argv, env }); return argv.includes('symbolic-ref') ? { code: 0, stdout: 'main\n', stderr: '' } : argv.includes('rev-parse') ? { code: 0, stdout: 'a'.repeat(40), stderr: '' } : { code: 0, stdout: '', stderr: '' }; } });
    await push.outgoing('site');
    const fetchedWith = ran.filter((r) => r.argv.includes('fetch')).at(-1);
    assert.equal(fetchedWith.env.GIT_CONFIG_VALUE_0, header);
    assert.equal(JSON.stringify(fetchedWith.argv).includes('tok-very-secret'), false);
    push.setRemote('site', { url: 'https://elsewhere.example.com/team/site.git' });
    await push.outgoing('site');
    assert.equal(ran.filter((r) => r.argv.includes('fetch')).at(-1).env.GIT_CONFIG_COUNT, undefined, 'never handed to another server');
    /* A key set for sending comes first, as it always did. */
    push.setRemote('site', { url: 'https://elsewhere.example.com/team/site.git', user: 'bot', key: 'push-key' });
    await push.outgoing('site');
    assert.equal(ran.filter((r) => r.argv.includes('fetch')).at(-1).env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('bot:push-key').toString('base64')}`);
    /* The repository is gone: its way in with it. */
    push.forget('site');
    assert.equal(b.access.credentialOf('site'), undefined);
});

test('data written before private repositories load unchanged: a public clone, a push key, no way in recorded', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-access-old-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const vault = new Vault(join(dir, 'vault.key'));
    writeFileSync(join(dir, 'resources.json'), JSON.stringify([{ name: 'site', type: 'git', from: 'https://example.com/team/site.git', createdAt: '2026-10-01T00:00:00.000Z' }]));
    writeFileSync(join(dir, 'git.json'), JSON.stringify([{ name: 'site', remote: 'https://example.com/team/site.git', user: 'me', sealed: vault.seal('old-token') }]));
    const access = new GitAccess({ vault, dataDir: dir });
    const resources = new Resources({ store: new Store(join(dir, 'resources.json')), vms: new Vms(async () => ({ code: 0, stdout: '', stderr: '' }), ['vmm']), host: async () => ({ code: 0, stdout: '', stderr: '' }), dataDir: dir, uid: 1, gid: 1, access });
    assert.deepEqual(resources.list()[0].via, { method: 'none' });
    const review = new GitReview({ store: new Store(join(dir, 'git.json')), vault, resources, dataDir: dir, access });
    assert.deepEqual(review.settings('site'), { remote: 'https://example.com/team/site.git', user: 'me', hasKey: true, sshKey: null });
    assert.deepEqual(access.keys(), []);
});

test('a recorded host key can be forgotten, host by host, for the day a hosting service really changes it', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'clv-hosts-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const access = new GitAccess({ vault: new Vault(join(dir, 'vault.key')), dataDir: dir });
    assert.deepEqual(access.hosts(), []);
    assert.throws(() => access.forgetHost('example.com'), /No key is recorded/);
    mkdirSync(join(dir, 'git-ssh'), { recursive: true });
    const other = 'AAAAC3NzaC1lZDI1NTE5AAAAIA' + 'b'.repeat(42) + '=';
    writeFileSync(access.knownHosts, `example.com ssh-ed25519 ${FAKE_HOST_KEY}\n[git.example.org]:2222,git.example.net ssh-ed25519 ${other}\n`);
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(FAKE_HOST_KEY, 'base64')).digest('base64').replace(/=+$/, '')}`;
    assert.deepEqual(access.hosts().map((h) => h.host), ['[git.example.org]:2222', 'example.com', 'git.example.net']);
    assert.deepEqual(access.hosts().find((h) => h.host === 'example.com'), { host: 'example.com', type: 'ssh-ed25519', fingerprint });
    /* Forgotten: that host only; a line shared with another host keeps the other. */
    assert.deepEqual(access.forgetHost('git.example.net').map((h) => h.host), ['[git.example.org]:2222', 'example.com']);
    assert.equal(readFileSync(access.knownHosts, 'utf8'), `example.com ssh-ed25519 ${FAKE_HOST_KEY}\n[git.example.org]:2222 ssh-ed25519 ${other}\n`);
    access.forgetHost('example.com');
    assert.deepEqual(access.hosts().map((h) => h.host), ['[git.example.org]:2222']);
    assert.throws(() => access.forgetHost('example.com'), /No key is recorded/);
    assert.throws(() => access.forgetHost('../etc'), /No key is recorded/);
});
