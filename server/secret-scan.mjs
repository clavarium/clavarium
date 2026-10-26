/* SECRET SCANNER -- finds likely secrets in a message, without any model.
 *
 * Used when a person's message arrives (talk.mjs): what looks like a token,
 * key or password is lifted out, kept in the vault for a few minutes, and the
 * message keeps only a reference. The aim is FEW FALSE POSITIVES: we match
 * shapes that are almost never anything but a secret (known token prefixes, a
 * PEM private key), plus long high-entropy blobs. Ordinary prose, file paths,
 * URLs, git hashes and UUIDs are left alone. A person can still mark a
 * selection by hand (talk.mjs) for what the shapes miss, or undo a wrong one.
 *
 * `scan(text)` returns the non-overlapping matches, each { start, end, value,
 * kind }, left to right. Nothing is stored here: the caller decides.
 */

/* Shapes that are almost always a secret. Order matters only for the `kind`
   label; overlaps are resolved by position below. */
const SHAPES = [
    { kind: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
    { kind: 'github', re: /\bgithub_pat_[0-9A-Za-z_]{40,}\b/g },
    { kind: 'github', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g },
    { kind: 'npm', re: /\bnpm_[0-9A-Za-z]{36}\b/g },
    { kind: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: 'slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
    { kind: 'api-key', re: /\bsk-(?:ant-|proj-|live-|test-)?[0-9A-Za-z_-]{20,}\b/g },
    { kind: 'jwt', re: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g },
];

/* A long run of token characters, caught only when it looks random (not a
   path, a hash or a word). */
const BLOB = /[0-9A-Za-z+/=_-]{40,}/g;
const ENTROPY_MIN = 3.5;      /* bits per character */
const CLASSES_MIN = 3;        /* of: lower, upper, digit, symbol */

function entropy(s) {
    const count = new Map();
    for (const c of s) count.set(c, (count.get(c) ?? 0) + 1);
    let bits = 0;
    for (const n of count.values()) { const p = n / s.length; bits -= p * Math.log2(p); }
    return bits;
}
function classes(s) {
    let n = 0;
    if (/[a-z]/.test(s)) n += 1;
    if (/[A-Z]/.test(s)) n += 1;
    if (/[0-9]/.test(s)) n += 1;
    if (/[^0-9A-Za-z]/.test(s)) n += 1;
    return n;
}
/* A blob that is only hex (a git sha, a checksum) or only one case is not a
   secret for us: too many false positives, and real tokens mix classes. */
function looksRandom(s) {
    return classes(s) >= CLASSES_MIN && entropy(s) >= ENTROPY_MIN;
}

/* How a lifted secret is written back into the message: a marker the chat
   shows as stars (ui side), and the tool reads to use /run/secrets/<name>.
   Named like `SECRET_` + 10 hex (secrets.mjs stash). The angle brackets
   (U+27E8/U+27E9) are vanishingly rare in a real message. */
export const secretRef = (name) => `⟨secret:${name}⟩`;
export const SECRET_REF = /⟨secret:(SECRET_[0-9A-F]{10})⟩/g;

export function scan(text) {
    const str = String(text ?? '');
    const found = [];
    for (const { kind, re } of SHAPES) {
        re.lastIndex = 0;
        for (let m; (m = re.exec(str));) found.push({ start: m.index, end: m.index + m[0].length, value: m[0], kind });
    }
    for (let m; (m = BLOB.exec(str));) {
        if (looksRandom(m[0])) found.push({ start: m.index, end: m.index + m[0].length, value: m[0], kind: 'high-entropy' });
    }
    BLOB.lastIndex = 0;
    /* Keep left-to-right, and when two matches overlap keep the one that starts
       first (and, equal, the longer): a known prefix wins over the blob rule. */
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let reach = -1;
    for (const f of found) { if (f.start >= reach) { out.push(f); reach = f.end; } }
    return out;
}
