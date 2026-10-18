/* A STAND-IN FOR THE NPM REGISTRY, for the tests of the updater (deploy/updater.mjs):
 * a tiny local HTTP server that serves what npm and the updater ask for, and nothing else.
 *
 *   GET /<name>                               the packument: versions, dist-tags, dist (tarball, integrity, attestations)
 *   GET /<name>/-/<name>-<version>.tgz        the archive, made here with tar
 *   GET /-/npm/v1/attestations/<name>@<v>     a provenance statement naming a repository (not signed: the
 *                                             signatures are npm's own check, `npm audit signatures`, not tried here)
 *
 * `publish(name, version, files, { tag, repo, packageJson })` adds a version while it runs.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export async function fakeRegistry() {
    const dir = mkdtempSync(join(tmpdir(), 'clv-registry-'));
    const packages = new Map();
    const asked = [];
    let origin = '';

    function publish(name, version, files, { tag = version.includes('-') ? 'next' : 'latest', repo = 'https://github.com/clavarium/clavarium', packageJson = {}, attest = true } = {}) {
        const stage = join(dir, 'stage', `${name}-${version}`);
        rmSync(stage, { recursive: true, force: true });
        const manifest = { name, version, ...packageJson };
        for (const [path, content] of Object.entries({ 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, ...files })) {
            mkdirSync(dirname(join(stage, 'package', path)), { recursive: true });
            writeFileSync(join(stage, 'package', path), content);
        }
        const file = join(dir, `${name}-${version}.tgz`);
        const made = spawnSync('tar', ['-czf', file, '--owner=0', '--group=0', '-C', stage, 'package']);
        if (made.status !== 0) throw new Error(`tar: ${made.stderr}`);
        const bytes = readFileSync(file);
        const sha512 = createHash('sha512').update(bytes).digest();
        const p = packages.get(name) ?? { name, 'dist-tags': {}, versions: {}, attestations: {} };
        /* As the registry says of a package published with its shrinkwrap: npm then installs exactly what it lists. */
        p.versions[version] = { ...manifest, ...('npm-shrinkwrap.json' in files ? { _hasShrinkwrap: true } : {}), dist: { tarball: `${origin}/${name}/-/${name}-${version}.tgz`, integrity: `sha512-${sha512.toString('base64')}`, shasum: createHash('sha1').update(bytes).digest('hex'), ...(attest ? { attestations: { url: `${origin}/-/npm/v1/attestations/${name}@${version}`, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } : {}) } };
        if (tag) p['dist-tags'][tag] = version;
        if (attest) {
            const statement = { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: `pkg:npm/${name}@${version}`, digest: { sha512: sha512.toString('hex') } }], predicateType: 'https://slsa.dev/provenance/v1', predicate: { buildDefinition: { externalParameters: { workflow: { repository: repo, path: '.github/workflows/publish.yml', ref: 'refs/heads/main' } } } } };
            p.attestations[version] = { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } }] };
        }
        packages.set(name, p);
        return p.versions[version].dist;
    }

    const server = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
        asked.push(path);
        const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        const att = /^\/-\/npm\/v1\/attestations\/(.+)@([^@]+)$/.exec(path);
        if (att) { const a = packages.get(att[1])?.attestations[att[2]]; return a ? json(200, a) : json(404, { error: 'not found' }); }
        const tgz = /^\/([^/]+)\/-\/([^/]+\.tgz)$/.exec(path);
        if (tgz) {
            try { const bytes = readFileSync(join(dir, tgz[2])); return response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }).end(bytes); } catch { return json(404, { error: 'not found' }); }
        }
        const p = packages.get(path.slice(1));
        if (!p) return json(404, { error: 'not found' });
        const { attestations, ...packument } = p;
        return json(200, packument);
    });
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        origin, publish, asked,
        /* A tag moved by hand (a version taken back to "latest"). */
        tag(name, tag, version) { packages.get(name)['dist-tags'][tag] = version; },
        close() { server.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}
