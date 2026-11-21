/* A MAIL FILE (.eml), read as a mail program shows it (05-11): its subject, who wrote to whom and when,
 * its words, its attachments -- and its source one tap away.
 *
 *   parse(bytes)            RFC 822 / MIME: headers (RFC 2047 words, RFC 2231 names), multipart
 *                           alternative / mixed / related, quoted-printable, base64, charsets.
 *   sanitize(html, opts)    the HTML of a mail, which a stranger wrote: kept are the tags and the
 *                           attributes that draw a page, nothing that runs, submits or frames;
 *                           remote pictures and styles blocked unless `remote`; `cid:` pictures
 *                           drawn from the mail itself.
 *   pageOf(mail, opts)      the document the viewer's frame shows (srcdoc), its own rules in it.
 *   linkify(text)           plain words cut into text and links (http, https, mailto), for the page to draw.
 *
 * Pure: no DOM, no network. The page (app.js) draws it in a frame that runs nothing (sandbox without
 * scripts or same-origin); the server (files.mjs) uses the same code when remote pictures are asked for.
 * Loaded as a classic script (index.html, device.html): window.clavariumMail. */
(function (root) {
    /* ---------- bytes and words ---------- */
    const latin = (bytes) => {
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        return s;
    };
    const bytesOf = (binary) => { const b = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) b[i] = binary.charCodeAt(i) & 255; return b; };
    const ALIASES = { 'utf8': 'utf-8', 'latin1': 'iso-8859-1', 'latin-1': 'iso-8859-1', 'cp1252': 'windows-1252', 'us-ascii': 'utf-8', 'ascii': 'utf-8', 'ansi_x3.4-1968': 'utf-8', 'unknown-8bit': 'windows-1252', 'x-unknown': 'windows-1252' };
    /* Bytes in a charset; one a browser does not know is read as UTF-8, and failing that as Windows-1252. */
    function decode(bytes, charset) {
        let label = String(charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
        label = ALIASES[label] || label;
        try { return new TextDecoder(label, { fatal: label === 'utf-8' }).decode(bytes); } catch { /* unknown, or not UTF-8 after all */ }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 8-bit */ }
        try { return new TextDecoder('windows-1252').decode(bytes); } catch { return latin(bytes); }
    }
    function fromBase64(text) {
        const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
        const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
        const at = (c) => { const n = c.charCodeAt(0); return n >= 97 ? n - 71 : n >= 65 ? n - 65 : n >= 48 ? n + 4 : n === 43 ? 62 : 63; };
        let o = 0;
        for (let i = 0; i + 1 < clean.length; i += 4) {
            const a = at(clean[i]); const b = at(clean[i + 1]); const c = i + 2 < clean.length ? at(clean[i + 2]) : -1; const d = i + 3 < clean.length ? at(clean[i + 3]) : -1;
            out[o++] = (a << 2) | (b >> 4);
            if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
            if (d >= 0) out[o++] = ((c & 3) << 6) | d;
        }
        return out.subarray(0, o);
    }
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function toBase64(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
            s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
        }
        return s;
    }
    /* Quoted-printable, on the binary string: "=XX" a byte, "=" at a line's end a soft break. */
    function fromQuotedPrintable(binary, header = false) {
        let s = String(binary).replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '');
        if (header) s = s.replace(/_/g, ' ');
        const out = [];
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else out.push(s.charCodeAt(i) & 255);
        }
        return Uint8Array.from(out);
    }
    /* RFC 2047: "=?UTF-8?Q?caf=C3=A9?=" -- words side by side are one; the rest, 8-bit, read as UTF-8. */
    function words(value) {
        const raw = String(value ?? '');
        const re = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/g;
        let out = ''; let last = 0; let wasWord = false; let m;
        while ((m = re.exec(raw))) {
            const between = raw.slice(last, m.index);
            if (!(wasWord && /^\s*$/.test(between))) out += decode(bytesOf(between), 'utf-8');
            const charset = m[1].split('*')[0];
            const bytes = m[2].toUpperCase() === 'B' ? fromBase64(m[3]) : fromQuotedPrintable(m[3], true);
            out += decode(bytes, charset);
            last = re.lastIndex; wasWord = true;
        }
        out += decode(bytesOf(raw.slice(last)), 'utf-8');
        return out;
    }

    /* ---------- an entity: its headers, its body ---------- */
    function split(binary) {
        const m = /\r?\n\r?\n/.exec(binary);
        const head = m ? binary.slice(0, m.index) : binary;
        const body = m ? binary.slice(m.index + m[0].length) : '';
        /* A message that starts with its body (no header at all) has no "name:" first. */
        if (!/^[!-9;-~]+:/.test(head)) return { head: '', body: binary, headers: [] };
        const headers = [];
        for (const line of head.split(/\r?\n/)) {
            if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1][1] += ` ${line.trim()}`;
            else { const at = line.indexOf(':'); if (at > 0) headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]); }
        }
        return { head, body, headers };
    }
    const first = (headers, name) => { const h = headers.find(([k]) => k.toLowerCase() === name); return h ? h[1] : ''; };
    /* "text/html; charset=\"utf-8\"; name*=utf-8''r%C3%A9sum%C3%A9.pdf" -> { value, params } (RFC 2231 names and pieces). */
    function params(value) {
        const parts = []; let cur = ''; let quoted = false;
        for (const ch of String(value ?? '')) {
            if (ch === '"') quoted = !quoted;
            if (ch === ';' && !quoted) { parts.push(cur); cur = ''; } else cur += ch;
        }
        parts.push(cur);
        const out = {}; const pieces = {};
        for (const p of parts.slice(1)) {
            const at = p.indexOf('='); if (at < 0) continue;
            const key = p.slice(0, at).trim().toLowerCase();
            let val = p.slice(at + 1).trim();
            if (val.startsWith('"')) val = val.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
            const piece = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
            if (piece) { (pieces[piece[1]] ??= []).push({ n: Number(piece[2] ?? 0), val, enc: Boolean(piece[3]) || (piece[2] === undefined) }); } else out[key] = val;
        }
        for (const [key, list] of Object.entries(pieces)) {
            list.sort((a, b) => a.n - b.n);
            let charset = 'utf-8'; let bin = '';
            list.forEach((p, i) => {
                let v = p.val;
                if (p.enc && i === 0) { const m = /^([^']*)'[^']*'(.*)$/.exec(v); if (m) { charset = m[1] || charset; v = m[2]; } }
                bin += p.enc ? v.replace(/%([0-9A-Fa-f]{2})/g, (a, h) => String.fromCharCode(parseInt(h, 16))) : v;
            });
            out[key] = decode(bytesOf(bin), charset);
        }
        for (const k of Object.keys(out)) if (!(k in pieces)) out[k] = words(out[k]);
        return { value: parts[0].trim().toLowerCase(), params: out };
    }
    function bodyBytes(binary, encoding) {
        const e = String(encoding || '').trim().toLowerCase();
        if (e === 'base64') return fromBase64(binary);
        if (e === 'quoted-printable') return fromQuotedPrintable(binary);
        return bytesOf(binary);
    }
    function entity(binary, depth = 0, parentType = '') {
        const { head, body, headers } = split(binary);
        const ct = params(first(headers, 'content-type') || (parentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain; charset=us-ascii'));
        const cd = params(first(headers, 'content-disposition'));
        const node = {
            head, headers, type: ct.value || 'text/plain', params: ct.params,
            disposition: cd.value, filename: cd.params.filename || ct.params.name || '',
            cid: first(headers, 'content-id').replace(/^\s*<|>\s*$/g, ''),
            encoding: first(headers, 'content-transfer-encoding'), raw: body, parts: [],
        };
        const boundary = ct.params.boundary;
        if (node.type.startsWith('multipart/') && boundary && depth < 20) {
            const mark = `--${boundary}`;
            const lines = body.split(/\r?\n/);
            let cur = null;
            for (const line of lines) {
                const t = line.replace(/[ \t]+$/, '');
                if (t === mark || t === `${mark}--`) {
                    if (cur) node.parts.push(entity(cur.join('\r\n'), depth + 1, node.type));
                    cur = t === mark ? [] : null;
                    if (t !== mark) break;
                } else if (cur) cur.push(line);
            }
            if (cur && cur.length) node.parts.push(entity(cur.join('\r\n'), depth + 1, node.type));
        }
        return node;
    }
    const contentOf = (node) => bodyBytes(node.raw, node.encoding);
    const textOf = (node) => decode(contentOf(node), node.params.charset);

    /* "Ann Example <ann@example.com>, \"Doe, Bo\" <bo@example.org>" -> [{ name, address }]. */
    function addresses(value) {
        const text = words(value);
        const out = []; let cur = ''; let quoted = false; let angle = false;
        for (const ch of text) {
            if (ch === '"') quoted = !quoted;
            else if (ch === '<' && !quoted) angle = true;
            else if (ch === '>' && !quoted) angle = false;
            if (ch === ',' && !quoted && !angle) { out.push(cur); cur = ''; } else cur += ch;
        }
        out.push(cur);
        return out.map((one) => {
            const m = /^(.*?)<([^>]*)>\s*$/.exec(one.trim());
            if (m) return { name: m[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim(), address: m[2].trim() };
            const bare = one.trim().replace(/\s*\(([^)]*)\)\s*$/, '');
            const note = /\(([^)]*)\)\s*$/.exec(one.trim());
            return { name: note ? note[1].trim() : '', address: bare };
        }).filter((a) => a.address || a.name);
    }

    /* ---------- the mail ---------- */
    function parse(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
        const top = entity(latin(bytes));
        const mail = {
            headers: top.headers.map(([k, v]) => [k, words(v)]), head: top.head,
            subject: words(first(top.headers, 'subject')).trim(),
            from: addresses(first(top.headers, 'from')), to: addresses(first(top.headers, 'to')), cc: addresses(first(top.headers, 'cc')),
            replyTo: addresses(first(top.headers, 'reply-to')),
            date: null, html: null, text: null, attachments: [], cids: {},
        };
        const d = Date.parse(first(top.headers, 'date').replace(/\s*\([^)]*\)\s*$/, ''));
        mail.date = Number.isNaN(d) ? null : new Date(d);
        const attach = (node, inline) => {
            const content = contentOf(node);
            let name = node.filename;
            if (!name && node.type === 'message/rfc822') name = `${(words(first(split(node.raw).headers, 'subject')).trim() || 'message').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 80)}.eml`;
            if (!name) name = `part-${mail.attachments.length + 1}${EXT[node.type] ?? ''}`;
            const one = { name: name.replace(/[\\/]+/g, '_'), type: node.type, size: content.length, bytes: content, cid: node.cid, inline: Boolean(inline) };
            mail.attachments.push(one);
            return one;
        };
        const isAttachment = (node) => node.disposition === 'attachment' || (Boolean(node.filename) && !/^text\/(plain|html)$/.test(node.type));
        const hasHtml = (node) => node.type === 'text/html' || node.parts.some(hasHtml);
        /* `body`: may this part be the mail's words, or only beside them. */
        const walk = (node, body) => {
            if (node.type === 'multipart/alternative') {
                const best = [...node.parts].reverse().find((p) => hasHtml(p) && !isAttachment(p)) ?? [...node.parts].reverse().find((p) => p.type === 'text/plain') ?? node.parts[0];
                if (best) walk(best, body);
                return;
            }
            if (node.type === 'multipart/related') {
                const start = node.params.start ? node.params.start.replace(/^<|>$/g, '') : '';
                const main = node.parts.find((p) => start && p.cid === start) ?? node.parts[0];
                for (const p of node.parts) {
                    if (p === main) continue;
                    if (p.cid && p.parts.length === 0) { const one = attach(p, true); mail.cids[p.cid] = one; } else walk(p, false);
                }
                if (main) walk(main, body);
                return;
            }
            if (node.type.startsWith('multipart/')) { for (const p of node.parts) walk(p, body); return; }
            if (!isAttachment(node) && (node.type === 'text/html' || node.type === 'text/plain') && body && mail.html === null && mail.text === null) {
                if (node.type === 'text/html') mail.html = textOf(node); else mail.text = textOf(node);
                return;
            }
            const one = attach(node, false);
            if (node.cid && node.type.startsWith('image/')) mail.cids[node.cid] = one;
        };
        walk(top, true);
        /* A picture of the page drawn in it is not one more attachment; one it never shows is. */
        if (mail.html !== null) {
            const used = new Set([...mail.html.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => decodeURIComponentSafe(m[1])));
            mail.attachments = mail.attachments.filter((a) => !(a.cid && used.has(a.cid)));
        }
        for (const a of mail.attachments) delete a.inline;
        return mail;
    }
    const decodeURIComponentSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const EXT = { 'text/plain': '.txt', 'text/html': '.html', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/calendar': '.ics' };

    /* ---------- its HTML, made harmless ---------- */
    /* Tags kept (the page they draw); any other tag is dropped, its words kept. */
    const KEEP = new Set(('a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em '
        + 'figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q s samp section small span strike strong '
        + 'style sub summary sup table tbody td tfoot th thead tr tt u ul var wbr').split(' '));
    /* Dropped with all that is in them. */
    const DROP = new Set('script noscript template iframe frame frameset object embed applet svg math title select textarea option button audio video canvas map xml'.split(' '));
    const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
    const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr', 'area', 'base', 'link', 'meta', 'input', 'source', 'track', 'param', 'embed', 'keygen']);
    const ATTRS = new Set(('href src alt title width height style class id align valign bgcolor color face size border cellpadding cellspacing colspan rowspan '
        + 'dir lang start type span background nowrap hspace vspace summary scope headers abbr reversed open cite datetime').split(' '));
    const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\', period: '.', comma: ',' };
    const unescape = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, e) => {
        if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;
    const REMOTE = /^(https?:)?\/\//i;
    /* An address as a browser reads it: no blanks or controls anywhere in it ("java\tscript:"). */
    const squeezed = (v) => unescape(v).replace(/[\u0000-\u0020\u007f-\u00a0\u00ad\u200b-\u200f\u2028\u2029\ufeff]+/g, '');
    function sanitize(html, opts = {}) {
        const remote = Boolean(opts.remote); const cids = opts.cids || {};
        let blocked = 0;
        const picture = (value) => {
            const v = squeezed(value);
            if (/^cid:/i.test(v)) { const one = cids[decodeURIComponentSafe(v.slice(4))]; return one && /^image\//.test(one.type) ? `data:${one.type};base64,${toBase64(one.bytes)}` : null; }
            if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]*$/i.test(v)) return v;
            if (REMOTE.test(v)) { if (remote) return v.startsWith('//') ? `https:${v}` : v; blocked++; return null; }
            return null;
        };
        /* CSS: nothing that runs or binds, no @import; a url() kept only as a picture is. */
        const cssOnce = (text) => unescape(String(text)).replace(/\\/g, '')
            .replace(/expression\s*\(|behaviou?r\s*:|-moz-binding|javascript:|vbscript:/gi, 'x-')
            .replace(/@import[^;]*;?/gi, '')
            .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, q, v) => { const p = picture(v); return p ? `url("${p.replace(/"/g, '%22')}")` : 'none'; })
            ;
        const css = (text) => { let t = cssOnce(text); for (let n = 0; n < 5 && /<\/?\s*style/i.test(t); n++) t = t.replace(/<\/?\s*style/gi, ''); return t.replace(/<\/?\s*style/gi, '').replace(/</g, ' '); };
        let out = ''; let i = 0; const s = String(html ?? '');
        let skip = null; let depth = 0; let bodyOpen = false;
        while (i < s.length) {
            const lt = s.indexOf('<', i);
            if (lt < 0) { if (!skip) out += textOut(s.slice(i)); break; }
            if (!skip) out += textOut(s.slice(i, lt));
            i = lt;
            if (s.startsWith('<!--', i)) { const end = s.indexOf('-->', i + 4); i = end < 0 ? s.length : end + 3; continue; }
            if (s[i + 1] === '!' || s[i + 1] === '?') { const end = s.indexOf('>', i); i = end < 0 ? s.length : end + 1; continue; }
            const closing = s[i + 1] === '/';
            const nm = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(s.slice(i + (closing ? 2 : 1), i + 80));
            if (!nm) { if (!skip) out += '&lt;'; i += 1; continue; }
            const name = nm[0].toLowerCase();
            /* The attributes, quotes kept whole ("a>b" inside one does not end the tag). */
            let j = i + (closing ? 2 : 1) + nm[0].length; const attrs = [];
            while (j < s.length && s[j] !== '>') {
                if (/[\s/]/.test(s[j])) { j++; continue; }
                const an = /^[^\s/>=]+/.exec(s.slice(j)); if (!an) { j++; continue; }
                j += an[0].length;
                let k = j; while (/\s/.test(s[k] ?? '')) k++;
                let value = '';
                if (s[k] === '=') {
                    k++; while (/\s/.test(s[k] ?? '')) k++;
                    if (s[k] === '"' || s[k] === "'") { const end = s.indexOf(s[k], k + 1); value = s.slice(k + 1, end < 0 ? s.length : end); j = end < 0 ? s.length : end + 1; } else { const v = /^[^\s>]*/.exec(s.slice(k))[0]; value = v; j = k + v.length; }
                }
                attrs.push([an[0].toLowerCase(), value]);
            }
            i = j + 1;
            if (skip) {
                if (name === skip) { if (closing) { depth--; if (depth === 0) skip = null; } else if (!RAW.has(name)) depth++; }
                continue;
            }
            if (RAW.has(name) && !closing && name !== 'style' && !KEEP.has(name)) {
                /* Raw text (a script's, a textarea's): to its own end tag, nothing in it read as markup. */
                const end = s.toLowerCase().indexOf(`</${name}`, i);
                i = end < 0 ? s.length : (s.indexOf('>', end) < 0 ? s.length : s.indexOf('>', end) + 1);
                continue;
            }
            if (name === 'style' && !closing) {
                const end = s.toLowerCase().indexOf('</style', i);
                const content = s.slice(i, end < 0 ? s.length : end);
                i = end < 0 ? s.length : (s.indexOf('>', end) < 0 ? s.length : s.indexOf('>', end) + 1);
                out += `<style>${css(content)}</style>`;
                continue;
            }
            if (DROP.has(name)) { if (!closing && !VOID.has(name)) { skip = name; depth = 1; } continue; }
            if (name === 'body' && !closing) {
                /* The body's colour and its background colour, kept on a box of their own. */
                const bg = attrs.find(([k]) => k === 'bgcolor'); const st = attrs.find(([k]) => k === 'style');
                const style = [bg && /^#?[\w]+$/.test(bg[1]) ? `background-color:${bg[1]}` : '', st ? css(st[1]) : ''].filter(Boolean).join(';');
                out += `<div class="mail-body"${style ? ` style="${escape(style)}"` : ''}>`; bodyOpen = true; continue;
            }
            if (name === 'body' && closing) { if (bodyOpen) { out += '</div>'; bodyOpen = false; } continue; }
            if (!KEEP.has(name)) continue;
            if (closing) { if (!VOID.has(name)) out += `</${name}>`; continue; }
            let tag = `<${name}`;
            for (const [k, raw] of attrs) {
                if (k.startsWith('on') || !ATTRS.has(k)) continue;
                let v = raw;
                if (k === 'href') { const u = squeezed(v); if (!SAFE_LINK.test(u)) continue; v = u; }
                else if (k === 'src') { if (name !== 'img') continue; const p = picture(v); if (!p) { tag += ' data-blocked=""'; continue; } v = p; }
                else if (k === 'background') { const p = picture(v); if (!p) continue; v = p; }
                else if (k === 'style') v = css(v);
                else if (k === 'cite') continue;
                else v = unescape(v);
                tag += ` ${k}="${escape(v)}"`;
            }
            if (name === 'a') tag += ' target="_blank" rel="noopener noreferrer"';
            out += `${tag}>`;
        }
        if (bodyOpen) out += '</div>';
        return { html: out, blocked };
        function textOut(t) { return t.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    }

    /* The frame's document: its own rules first (no script, nothing fetched but what `remote` allows),
       links to a new tab; a mail is drawn on white as it was written for, whatever the page's theme. */
    function pageOf(mail, opts = {}) {
        const { html, blocked } = sanitize(mail.html ?? '', { remote: opts.remote, cids: mail.cids });
        const img = opts.remote ? "data: https: http:" : 'data:';
        const rules = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'`;
        const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rules}">`
            + '<meta name="referrer" content="no-referrer"><base target="_blank">'
            + '<style>html{background:#fff;color:#17202b}body{margin:0;padding:16px;font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}img[data-blocked]{display:none}pre{white-space:pre-wrap}</style>'
            + `</head><body>${html}</body></html>`;
        return { html: doc, blocked };
    }

    /* Words and links, for the page to draw as text and <a> (never as markup). */
    function linkify(text) {
        const out = []; const re = /\b(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
        let last = 0; let m;
        const t = String(text ?? '');
        while ((m = re.exec(t))) {
            let link = m[0]; const trail = /[.,;:!?)\]]+$/.exec(link); if (trail) link = link.slice(0, -trail[0].length);
            if (m.index > last) out.push({ text: t.slice(last, m.index) });
            out.push({ text: link, href: /^(https?|mailto):/i.test(link) ? link : `mailto:${link}` });
            last = m.index + link.length; re.lastIndex = last;
        }
        if (last < t.length) out.push({ text: t.slice(last) });
        return out;
    }

    root.clavariumMail = { parse, sanitize, pageOf, linkify, words, decode, addresses };
})(typeof window !== 'undefined' ? window : globalThis);
