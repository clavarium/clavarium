/* toml-block FILE NAME [TEXT]: keeps, in the TOML file FILE of the home, one block of its own --
 * "# >>> clavarium NAME" ... "# <<< clavarium NAME" -- written anew with TEXT (its tables), every other
 * line kept as the person or the tool wrote it. No TEXT: the block taken out. Written only when it
 * changes, readable by its owner alone (02-11: Codex, Vibe -- their settings are TOML).
 * Only tables go in a block (a key outside a table would land in the table above it).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const [file, name, text = ''] = process.argv.slice(2);
if (!file || !name || isAbsolute(file) || file.split('/').includes('..') || !/^[a-z0-9-]+$/.test(name)) { console.error('usage: toml-block <file in the home> <name> [text]'); process.exit(64); }
const at = join(homedir(), file);
let was = '';
try { was = readFileSync(at, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') { console.error(`toml-block: ${file} cannot be read`); process.exit(3); } }
const open = `# >>> clavarium ${name}`; const close = `# <<< clavarium ${name}`;
const lines = was.split('\n'); const kept = []; let inside = false;
for (const l of lines) { if (l === open) { inside = true; continue; } if (l === close) { inside = false; continue; } if (!inside) kept.push(l); }
let out = kept.join('\n').replace(/\n+$/, '');
if (text.trim()) out = `${out ? `${out}\n\n` : ''}${open}\n${text.trim()}\n${close}`;
out = out ? `${out}\n` : '';
if (out !== was) {
    mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
    writeFileSync(`${at}.new`, out, { mode: 0o600 });
    renameSync(`${at}.new`, at);
}
