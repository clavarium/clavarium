/* ALERTS: this server tells its owner's phone that something waits.
 *
 * A tool that stopped for its owner is no use if the owner does not know. The
 * page, installed as an app, can be told by the browser's own push service:
 * nothing of ours runs outside the house, and no port is opened. This server
 * calls the push service the device named (Google's, Apple's, Mozilla's,
 * Microsoft's), which wakes the device.
 *
 * WHAT THE PUSH SERVICE SEES: that a message goes to that device, and when.
 * Not what it says: the message is encrypted here for the device alone (that
 * is the standard, not a choice of ours).
 *
 * What holds it:
 *   - a device is told only because its owner asked, on that device, and can
 *     stop at any time; a device the push service no longer knows is dropped;
 *   - the address this server is asked to call comes from a browser, so it is
 *     never called unless it is https and one of the push services known
 *     here: otherwise it would be a way to make this server call anything;
 *   - a message is a title, a line and a place in this site. Nothing else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { Refusal } from './conversations.mjs';

export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];
export const DEVICES_MAX = 20;
export const BODY_MAX = 200;
const KEY = /^[A-Za-z0-9_-]{16,200}$/;
// eslint-disable-next-line no-control-regex
const plain = (text, max) => String(text ?? '').replace(/[\u0000-\u001F\u007F-\u009F]+/gu, ' ').trim().slice(0, max);

export class Alerts {
    #store; #keys; #subject; #send;

    /* `keyFile`: this installation's own pair of keys, made once. `subject`:
       who the push services may contact about these messages: the address of
       this installation. `send`: injected, so tests call nobody. */
    constructor({ store, keyFile, subject, send = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options) }) {
        this.#store = store; this.#send = send;
        this.#subject = subject?.startsWith('https://') ? subject : 'https://clavarium.invalid';
        try { this.#keys = JSON.parse(readFileSync(keyFile, 'utf8')); } catch { this.#keys = undefined; }
        if (typeof this.#keys?.publicKey !== 'string' || typeof this.#keys?.privateKey !== 'string') {
            this.#keys = webpush.generateVAPIDKeys();
            writeFileSync(keyFile, JSON.stringify(this.#keys), { mode: 0o600 });
        }
    }

    about() { return { key: this.#keys.publicKey, devices: this.#store.all().map(({ name, label, made }) => ({ id: name, label, made })) }; }

    add({ endpoint, keys } = {}, label) {
        let url;
        try { url = new URL(String(endpoint)); } catch { throw new Refusal(400, 'This is not a device that can be told.'); }
        if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || !PUSH_HOSTS.some((host) => host.test(url.hostname))) throw new Refusal(400, 'This browser\'s push service is not one this server calls.');
        if (!KEY.test(String(keys?.p256dh)) || !KEY.test(String(keys?.auth))) throw new Refusal(400, 'This is not a device that can be told.');
        const known = this.#store.all().find((d) => d.endpoint === url.href);
        if (!known && this.#store.all().length >= DEVICES_MAX) throw new Refusal(400, `At most ${DEVICES_MAX} devices are told.`);
        this.#store.put({ name: known?.name ?? randomUUID(), endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth }, label: plain(label, 60) || 'A device', made: known?.made ?? new Date().toISOString() });
        return this.about();
    }

    remove(endpoint) {
        for (const d of this.#store.all()) if (d.endpoint === endpoint || d.name === endpoint) this.#store.remove(d.name);
        return this.about();
    }

    /* Tells every device. Resolves with how many were reached. Never throws:
       an alert that fails must not stop what it was about. */
    async tell({ title, body, url }) {
        const payload = JSON.stringify({ title: plain(title, 80) || 'Clavarium', body: plain(body, BODY_MAX), url: /^\/[^/\\]/.test(String(url)) || url === '/' ? url : '/' });
        let reached = 0;
        await Promise.all(this.#store.all().map(async (d) => {
            try {
                await this.#send({ endpoint: d.endpoint, keys: d.keys }, payload, { TTL: 3600, urgency: 'high', vapidDetails: { subject: this.#subject, publicKey: this.#keys.publicKey, privateKey: this.#keys.privateKey } });
                reached++;
            } catch (error) {
                /* The push service no longer knows this device: it left. */
                if (error?.statusCode === 404 || error?.statusCode === 410) this.#store.remove(d.name);
            }
        }));
        return reached;
    }
}
