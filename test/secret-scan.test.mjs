import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../server/secret-scan.mjs';

const values = (text) => scan(text).map((m) => m.value);

test('catches known token shapes', () => {
    assert.deepEqual(values('here is npm_abcdef ghij KL'), []);          /* too short */
    assert.deepEqual(values(`token npm_${'a'.repeat(36)} end`), [`npm_${'a'.repeat(36)}`]);
    assert.deepEqual(values(`gh ghp_${'A1b2'.repeat(9)} x`), [`ghp_${'A1b2'.repeat(9)}`]);
    assert.deepEqual(values('key AKIAIOSFODNN7EXAMPLE here'), ['AKIAIOSFODNN7EXAMPLE']);
    assert.deepEqual(values('slack xoxb-123456789012-abcdefABCDEF go'), ['xoxb-123456789012-abcdefABCDEF']);
    assert.ok(values('use sk-ant-api03-' + 'Xy9'.repeat(10)).length === 1);
});

test('catches a PEM private key, whole', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\nmorelines==\n-----END OPENSSH PRIVATE KEY-----';
    const got = scan(`before\n${pem}\nafter`);
    assert.equal(got.length, 1);
    assert.equal(got[0].value, pem);
    assert.equal(got[0].kind, 'private-key');
});

test('catches a high-entropy blob but not prose, paths, hashes, UUIDs', () => {
    assert.deepEqual(values('the quick brown fox jumps over the lazy dog again'), []);
    assert.deepEqual(values('/srv/project/server/some/long/path/to/a/file.mjs'), []);
    assert.deepEqual(values('https://example.com/a/fairly/long/url/that/is/not/secret'), []);
    assert.deepEqual(values('commit 5f5e4d3c2b1a09887766554433221100ffeeddcc'), []);   /* 40 hex = 2 classes */
    assert.deepEqual(values('id 123e4567-e89b-12d3-a456-426614174000 done'), []);     /* uuid < 40, dashes */
    const blob = 'Xk9aB3dE7fG2hJ5kL8mN1pQ4rS6tU0vWzZ7cD5eF8g';   /* 42 chars, mixed, random */
    assert.deepEqual(values(`secret ${blob} ok`), [blob]);
});

test('non-overlapping, left to right; a prefix wins over the blob rule', () => {
    const token = 'npm_aZ3kP9mQ2wE7rT1yU5iO0pS8dF4gH6jKxL2n';   /* npm_ + 36 random chars: the blob rule matches it too */
    const got = scan(`a ${token} b`);
    assert.equal(got.length, 1);
    assert.equal(got[0].value, token);
    assert.equal(got[0].kind, 'npm');
});

test('two secrets in one message, in order', () => {
    const a = `npm_${'a'.repeat(36)}`;
    const b = 'AKIAIOSFODNN7EXAMPLE';
    const got = scan(`first ${a} then ${b} end`);
    assert.deepEqual(got.map((m) => m.value), [a, b]);
    assert.ok(got[0].start < got[1].start);
});

test('empty and non-string input', () => {
    assert.deepEqual(scan(''), []);
    assert.deepEqual(scan(null), []);
    assert.deepEqual(scan(undefined), []);
});

test('the shorter net: an improbable alphanumeric word (mixed case + digits) is caught; ids, hashes, prose are not', () => {
    const pw = 'Xk9mP2wQ7rT1yU5iO0pS8d';                                   /* 22 chars, upper+lower+digit */
    assert.deepEqual(values(`the password is ${pw} ok`), [pw]);
    assert.deepEqual(values('id 123e4567-e89b-12d3-a456-426614174000 done'), [], 'a uuid: its dashes break it up');
    assert.deepEqual(values('build abcdef0123456789abcdef0123456789 now'), [], '32 hex: no uppercase, not flagged');
    assert.deepEqual(values('the configuration seems reasonable enough today honestly'), [], 'ordinary prose');
    assert.deepEqual(values('getUserByIdentifierAndName is the method'), [], 'a camelCase name: no digits');
});

test('with a nearby word that announces a secret, a shorter improbable string is caught; without, it is left alone', () => {
    assert.deepEqual(values('F9VhOtouT6'), [], 'a bare 10-char string: too short, not flagged');
    assert.deepEqual(values('mon mot de passe: F9VhOtouT6'), ['F9VhOtouT6'], 'same string, but "mot de passe" nearby');
    assert.deepEqual(values('the token is Xk9mP2wQ7rT'), ['Xk9mP2wQ7rT'], 'a short key with "token" nearby');
    assert.deepEqual(values('my password is required for the login page'), [], 'a secret word but no improbable value: nothing');
    assert.deepEqual(values('password: hello there friend'), [], 'ordinary words after the keyword stay untouched');
});
