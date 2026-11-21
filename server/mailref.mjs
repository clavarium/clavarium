/* A MAIL CITED BY ITS REFERENCE (06-11), opened in the page's mail viewer -- the one .eml files open in
 * (web/mail-view.js, showMail in app.js): one reader, never a second one.
 *
 *   mail:TARGET/MESSAGE-ID[?in=FOLDER&uid=N]      Tether's reference (clavarium-tether/verbs): the
 *                                                 mailbox target, the mail's own Message-ID, hints
 *
 *   GET .../mail/open?ref=     the mail's bytes (message/rfc822), read through Tether (mail.open) at the
 *                              moment it is opened: never before, never kept here, on disk or elsewhere
 *   GET .../mail/page?ref=     the same mail as a page with its remote pictures (files.mjs mailPage, the
 *                              .eml's own code and headers), only when the reader asks for them
 *
 * WHO MAY OPEN IT: whoever may read that mailbox -- the owner always; a device only with the Read right
 * on a mailbox asset of the same address (grants.mjs, "mailbox r"). Anyone else is told it is not theirs
 * to open, and nothing is read. The read is that person's in Tether's journal, never an agent's, and is
 * never asked of anyone.
 *
 * An OLD REFERENCE (a bare uid a card kept before references existed) opens only where it can be read
 * without guessing: the one mailbox its conversation was given, its inbox. Else it says so. */
import { readMailRef } from 'clavarium-tether/verbs';
import { Refusal } from './conversations.mjs';
import { mailPage, mailName, MAIL_MAX } from './files.mjs';

const refused = (status, kind, message) => Object.assign(new Refusal(status, message), { kind });
const OLD_REF = /^[A-Za-z0-9_=+/-]{1,1024}$/;
export const isMailRef = (text) => readMailRef(text) !== null;

/* A device may read the mailbox of a target when it was given a mailbox asset of the same address, to read. */
export function deviceMayRead(target, own, mailboxes) {
    const user = String(target?.config?.user ?? '').trim().toLowerCase();
    if (!user) return false;
    const boxes = mailboxes?.list?.() ?? [];
    return (own ?? []).some((g) => g.type === 'mailbox' && boxes.some((m) => m.name === g.name && String(m.user ?? '').trim().toLowerCase() === user));
}

/* The mail of a reference, read now: { bytes, box, folder, ref, cut }. `may(target)`: this person reads that
   mailbox. `who`: { id, name }, said in Tether's journal. `of`: the conversation an old reference was kept by. */
export async function openMail(tethers, given, { who, may, of = '' }) {
    if (!tethers) throw refused(503, 'unreachable', 'Mailboxes are not reached from this server.');
    const text = String(given ?? '').trim();
    const ref = readMailRef(text);
    if (!ref) return oldRef(tethers, text, { who, may, of });
    const target = tethers.store().target(ref.target);
    if (!target || target.kind !== 'mail') throw refused(404, 'gone', 'This mailbox is no longer here.');
    if (!may(target)) throw refused(403, 'not-yours', 'This mailbox is not yours to open.');
    const got = await tethers.read('mail.open', { ref: text }, who);
    if (!got.ok) {
        if (got.code === 'gone') throw refused(410, 'gone', 'This mail is no longer in the mailbox.');
        throw refused(502, 'unreachable', `${target.title} cannot be reached: ${got.text}`);
    }
    return { bytes: got.data.raw, box: target.title, folder: got.data.folder ?? '', ref: got.data.ref || text, cut: got.data.cut === true };
}
async function oldRef(tethers, text, { who, may, of }) {
    const old = () => refused(409, 'old-ref', 'An old reference: ask the AI to attach this mail again.');
    if (!OLD_REF.test(text) || !of) throw old();
    const boxes = tethers.store().targets().filter((t) => t.kind === 'mail' && t.grants?.[`conversation:${of}`]);
    if (boxes.length !== 1) throw old();
    const [target] = boxes;
    if (!may(target)) throw refused(403, 'not-yours', 'This mailbox is not yours to open.');
    const got = await tethers.read('mail.source', { target: target.id, uid: text }, who);
    if (!got.ok) throw old();
    const raw = String(got.text).replace(/\n\n\(Large message — [^)]*\)$/, '');
    return { bytes: Buffer.from(raw, 'utf8'), box: target.title, folder: '', ref: text, cut: raw.length !== String(got.text).length };
}

/* The two routes, one implementation for the owner's page (api.mjs) and a device's (door.mjs). `route`:
   '/mail/open' or '/mail/page'. `offline`: the conversation shown is cut off (no remote pictures, as for an
   .eml). Returns true when answered. */
export async function mailRoute(route, query, response, { tethers, headers, who, may, offline = false, of = '' }) {
    if (route !== '/mail/open' && route !== '/mail/page') return false;
    if (route === '/mail/page' && offline) throw new Refusal(403, 'This conversation is offline: remote pictures stay blocked.');
    const opened = await openMail(tethers, query.get('ref'), { who, may, of });
    if (opened.bytes.length > MAIL_MAX) throw refused(413, 'too-large', 'This mail is too large to be shown here.');
    const bytes = new Uint8Array(opened.bytes.buffer, opened.bytes.byteOffset, opened.bytes.byteLength);
    if (route === '/mail/page') {
        const shown = mailPage(bytes);
        response.writeHead(200, shown.headers);
        response.end(shown.body);
        return true;
    }
    /* Its bytes, as a file to download too; where it was found, said beside them. */
    response.writeHead(200, {
        ...headers, 'content-type': 'message/rfc822', 'content-length': opened.bytes.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(mailName(bytes))}`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'x-mail-box': encodeURIComponent(opened.box), 'x-mail-folder': encodeURIComponent(opened.folder),
        'x-mail-ref': encodeURIComponent(opened.ref), ...(opened.cut ? { 'x-mail-cut': '1' } : {}),
    });
    response.end(opened.bytes);
    return true;
}
