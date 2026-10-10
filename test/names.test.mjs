import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConversationName } from '../server/names.mjs';

test('a conversation name is letters, digits and hyphens, and nothing a command line could misread', () => {
    for (const good of ['a', 'demo', 'website-redesign', 'q3', 'a'.repeat(32)]) assert.equal(isConversationName(good), true, good);
    for (const bad of ['', 'Demo', '-x', 'x-', '3d', 'a b', 'a;b', 'a/b', '../x', 'a'.repeat(33), 'été', 'a\n', '=x', 12, null, undefined]) {
        assert.equal(isConversationName(bad), false, String(bad));
    }
});
