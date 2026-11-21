/* A MAIL FILE read as a mail program shows it (web/mail-view.js): its headers, its words in their
   charset, its attachments, its pictures -- and nothing of its HTML that runs or fetches. Mails
   written here by hand, example.com / example.org only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FILES } from '../server/main.mjs';
import { mailPage } from '../server/files.mjs';

const web = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
const holder = {};
new Function('window', web('mail-view.js'))(holder);
const MAIL = holder.clavariumMail;
const eml = (text) => new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
const latin1 = (text) => Uint8Array.from(text.replace(/\n/g, '\r\n'), (c) => c.charCodeAt(0));

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('multipart/alternative: the HTML is the body; headers, names, RFC 2047 subject and date read', () => {
    const mail = MAIL.parse(eml(`From: =?UTF-8?Q?Ren=C3=A9e_Example?= <renee@example.com>
To: "Doe, Bo" <bo@example.org>, ann@example.org
Cc: Team <team@example.org>
Subject: =?UTF-8?Q?Caf=C3=A9_?=
 =?UTF-8?B?w6AgbWlkaQ==?=
Date: Tue, 03 Nov 2026 09:15:00 +0100
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

Plain words.
--b1
Content-Type: text/html; charset=utf-8

<p>Rich <b>words</b>.</p>
--b1--
`));
    assert.equal(mail.subject, 'Café à midi');
    assert.deepEqual(mail.from, [{ name: 'Renée Example', address: 'renee@example.com' }]);
    assert.deepEqual(mail.to, [{ name: 'Doe, Bo', address: 'bo@example.org' }, { name: '', address: 'ann@example.org' }]);
    assert.deepEqual(mail.cc, [{ name: 'Team', address: 'team@example.org' }]);
    assert.equal(mail.date.toISOString(), '2026-11-03T08:15:00.000Z');
    assert.match(mail.html, /<p>Rich <b>words<\/b>\.<\/p>/);
    assert.equal(mail.text, null);
    assert.deepEqual(mail.attachments, []);
    assert.ok(mail.headers.some(([k, v]) => k === 'Subject' && v === 'Café à midi'));
});

test('quoted-printable and base64 bodies, utf-8', () => {
    const qp = MAIL.parse(eml(`Subject: qp
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Un caf=C3=A9 tr=C3=A8s long qui continue sur la ligne suiv=
ante.
`));
    assert.equal(qp.text.trim(), 'Un café très long qui continue sur la ligne suivante.');
    const b64 = MAIL.parse(eml(`Subject: b64
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

${Buffer.from('<p>Été ✓</p>').toString('base64')}
`));
    assert.equal(b64.html, '<p>Été ✓</p>');
});

test('iso-8859-1 and windows-1252 bodies; 8-bit headers', () => {
    const mail = MAIL.parse(latin1(`Subject: =?iso-8859-1?Q?R=E9sum=E9?=
Content-Type: text/plain; charset="iso-8859-1"
Content-Transfer-Encoding: 8bit

Gar\xe7on, d\xe9j\xe0.
`));
    assert.equal(mail.subject, 'Résumé');
    assert.equal(mail.text.trim(), 'Garçon, déjà.');
    const cp = MAIL.parse(latin1(`Subject: x
Content-Type: text/plain; charset=windows-1252
Content-Transfer-Encoding: quoted-printable

=93quoted=94 =80
`));
    assert.equal(cp.text.trim(), '“quoted” €');
});

test('multipart/mixed with related: a cid picture drawn inline, the attachments listed (RFC 2231 name)', () => {
    const mail = MAIL.parse(eml(`From: shop@example.com
Subject: Invoice
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/related; boundary="rel"

--rel
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain

See the logo.
--alt
Content-Type: text/html

<p><img src="cid:logo@example.com" alt="logo"> See the logo.</p>
--alt--
--rel
Content-Type: image/png
Content-ID: <logo@example.com>
Content-Transfer-Encoding: base64

${PIXEL}
--rel--
--outer
Content-Type: application/pdf
Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf
Content-Transfer-Encoding: base64

${Buffer.from('%PDF-1.4 fake').toString('base64')}
--outer
Content-Type: text/plain; name="notes.txt"
Content-Disposition: attachment

hello
--outer--
`));
    assert.match(mail.html, /cid:logo@example.com/);
    assert.deepEqual(mail.attachments.map((a) => [a.name, a.type, a.size]), [['résumé.pdf', 'application/pdf', 13], ['notes.txt', 'text/plain', 5]]);
    assert.equal(new TextDecoder().decode(mail.attachments[0].bytes), '%PDF-1.4 fake');
    const page = MAIL.pageOf(mail);
    assert.match(page.html, /<img src="data:image\/png;base64,iVBORw0KGgo[^"]*" alt="logo">/);
    assert.equal(page.blocked, 0);
});

test('scripts, handlers, forms, frames and dangerous links never survive', () => {
    const evil = `<html><head><title>t</title><meta http-equiv="refresh" content="0;url=https://evil.example.com/"><base href="https://evil.example.com/">
<link rel="stylesheet" href="https://evil.example.com/a.css"><script>alert(1)</script></head>
<body onload="alert(2)" bgcolor="#eeeeee"><p onclick="alert(3)" style="color:red">Hi</p>
<a href="javascript:alert(4)">a</a><a href="jav&#x09;ascript:alert(5)">b</a><a href=" JaVaScRiPt:alert(6)">c</a><a href="data:text/html,x">d</a>
<a href="https://example.org/ok">ok</a>
<img src=x onerror=alert(7)><svg><script>alert(8)</script><a xlink:href="javascript:alert(9)">s</a></svg>
<iframe src="https://evil.example.com/"></iframe><object data="x"></object><embed src="x">
<form action="https://evil.example.com/"><input name="password"><button>Go</button></form>
<div style="background:url(javascript:alert(10));width:expression(alert(11))">x</div>
<style>@import url(https://evil.example.com/b.css); p{color:blue} </style><img src="x" onerror="alert(12)"></style>
<scr<script>ipt>alert(13)</script>
<a href="https://example.org/" onmouseover="alert(14)" target="_self">t</a>
<!-- <script>alert(15)</script> --><noscript><img src=x onerror=alert(16)></noscript>
<math><mi xlink:href="javascript:alert(17)">m</mi></math><template><script>alert(18)</script></template>
<p title="x&quot;onmouseover=&quot;alert(19)">q</p></body></html>`;
    const { html } = MAIL.sanitize(evil);
    assert.doesNotMatch(html, /<script|<iframe|<object|<embed|<form|<input|<button|<svg|<math|<meta|<base|<link|<template|<noscript/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:|data:text|expression\(|@import/i);
    assert.doesNotMatch(html, /evil\.example\.com/);
    assert.match(html, /<a href="https:\/\/example\.org\/ok" target="_blank" rel="noopener noreferrer">ok<\/a>/);
    assert.match(html, /<p style="color:red">Hi<\/p>/);
    assert.match(html, /<div class="mail-body" style="background-color:#eeeeee">/);
    /* The quoted title stays one attribute: its quote escaped, no handler out of it. */
    assert.match(html, /<p title="x&quot;onmouseover=&quot;alert\(19\)">q<\/p>/);
    /* Only <a>, set by us, carries a target. */
    assert.doesNotMatch(html, /target="_self"/);
});

test('remote pictures and styles are blocked by default, and counted; allowed only when asked', () => {
    const mail = { html: `<p style="background-image:url('https://img.example.com/bg.png')">x</p>
<img src="https://img.example.com/track.gif" width="1" height="1"><img src="//img.example.com/b.png"><table background="http://img.example.com/c.png"><tr><td>c</td></tr></table>
<style>.x{background:url(https://img.example.com/d.png)}</style>`, cids: {} };
    const page = MAIL.pageOf(mail);
    assert.doesNotMatch(page.html.replace(/<meta http-equiv[^>]*>/, ''), /img\.example\.com/);
    assert.equal(page.blocked, 5);
    assert.match(page.html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'/);
    assert.match(page.html, /<img data-blocked="" width="1" height="1">/);
    const shown = MAIL.pageOf(mail, { remote: true });
    assert.match(shown.html, /<img src="https:\/\/img\.example\.com\/track\.gif"/);
    assert.match(shown.html, /<img src="https:\/\/img\.example\.com\/b\.png">/);
    assert.match(shown.html, /img-src data: https: http:;/);
    assert.equal(shown.blocked, 0);
    /* Nothing of the remote rules ever lets a script in. */
    assert.doesNotMatch(shown.html, /script-src/);
    assert.match(shown.html, /default-src 'none'/);
});

test('plain words cut into text and links; a message attached is named after its subject', () => {
    assert.deepEqual(MAIL.linkify('See https://example.org/a?b=1. Or mail ann@example.org!'), [
        { text: 'See ' }, { text: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1' }, { text: '. Or mail ' },
        { text: 'ann@example.org', href: 'mailto:ann@example.org' }, { text: '!' }]);
    const mail = MAIL.parse(eml(`Subject: Fwd
Content-Type: multipart/mixed; boundary=m

--m
Content-Type: text/plain

Forwarded.
--m
Content-Type: message/rfc822

Subject: The original
From: a@example.com

Hello.
--m--
`));
    assert.equal(mail.text.trim(), 'Forwarded.');
    assert.equal(mail.attachments[0].name, 'The original.eml');
    assert.equal(mail.attachments[0].type, 'message/rfc822');
});

test('the page loads it, the server serves it (and on the device door), and its frame runs nothing', () => {
    assert.deepEqual(FILES['/mail-view.js'], ['web/mail-view.js', 'text/javascript; charset=utf-8']);
    assert.match(web('index.html'), /<script src="\/mail-view\.js"><\/script>\s*<script src="\/app\.js/);
    assert.match(web('device.html'), /<script src="mail-view\.js"><\/script>/);
    const app = web('app.js');
    /* The frame: a sandbox with no scripts and no same-origin; only new tabs for its links. */
    assert.match(app, /setAttribute\('sandbox', 'allow-popups allow-popups-to-escape-sandbox'\)/);
    assert.doesNotMatch(app.slice(app.indexOf('function showMail'), app.indexOf('function showMail') + 12000), /allow-scripts|allow-same-origin/);
});

test('the server\'s page of a mail, remote pictures allowed: its own rules, no script, a sandbox', async () => {
    const page = mailPage(eml(`Subject: s
Content-Type: text/html

<p>Hi <img src="https://img.example.com/x.png"><script>alert(1)</script></p>
`));
    assert.match(page.body, /<img src="https:\/\/img\.example\.com\/x\.png">/);
    assert.doesNotMatch(page.body, /<script>alert/);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none';/);
    assert.match(csp, /img-src data: https: http:/);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin|script-src/);
    assert.match(csp, /frame-ancestors 'self'/);
});
