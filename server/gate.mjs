/* WHO IS ASKING. This server does not sign anybody in: an authenticating
   proxy stands in front of it and names the person in a header.
 *
 * That header is only worth something because of WHERE this server listens:
 * on the loopback interface, where the proxy is the one that reaches it. The
 * proxy strips the header from anything it lets through unauthenticated, so
 * a visitor cannot bring their own.
 *
 * Two modes, and no third:
 *   - no operator declared: development on one machine. Everybody who can
 *     reach the loopback interface is the operator.
 *   - operators declared: every request, page, API call or terminal, must
 *     carry the header with one of those addresses. Anything else is refused,
 *     including a request with no header at all.
 */
export const IDENTITY_HEADER = 'x-forwarded-email';

export function readOperators(text) {
    const list = String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    for (const address of list) {
        if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(address)) throw new Error(`not an email address: ${address}`);
    }
    return list;
}

/* Returns a function: (headers) -> the operator's address, or undefined when
   the request is not from an operator. In development mode it returns 'local'. */
export function makeGate(operators = []) {
    if (operators.length === 0) return () => 'local';
    const allowed = new Set(operators);
    return (headers) => {
        const value = headers[IDENTITY_HEADER];
        /* A header sent twice arrives as one string joined by commas: two
           identities is not an identity. */
        if (typeof value !== 'string' || value.includes(',')) return undefined;
        const address = value.trim().toLowerCase();
        return allowed.has(address) ? address : undefined;
    };
}

/* Whether a request that changes something, or a WebSocket, comes from this
   site's own pages. Behind the edge the public address is declared, because
   the Host header seen here is whatever the proxies made of it. */
export function makeOriginCheck(publicOrigin) {
    if (publicOrigin) {
        const expected = new URL(publicOrigin).origin;
        return (headers) => headers.origin === expected;
    }
    return (headers) => {
        const { origin, host } = headers;
        if (typeof origin !== 'string' || typeof host !== 'string') return false;
        return origin === `http://${host}` || origin === `https://${host}`;
    };
}
