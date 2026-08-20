/**
 * Loopback hosts, as they can appear in a URL authority.
 *
 * Scrypted's rebroadcast plugin advertises its RTSP endpoints on 127.0.0.1 because the
 * consumers it was designed for — HomeKit, the NVR, other plugins — run inside the Scrypted
 * process. Homey is not one of them: from the Homey, 127.0.0.1 is the Homey itself, and the
 * player fails with "unable to open the MRL".
 */
const LOOPBACK_AUTHORITY = /^([a-z][a-z0-9+.\-]*:\/\/)([^@/]*@)?(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i;

/**
 * Points a loopback stream URL at the host actually serving it.
 *
 * Only the host is touched: the port and path identify the rebroadcast session and any
 * embedded credentials must survive. A URL that already names a routable host, or that does
 * not parse as expected, is returned unchanged — guessing would be worse than passing the
 * original through and letting the player report the real problem.
 */
export function rewriteLoopbackHost(url: string, host: string): string {
  if (!url || !host) return url;
  return url.replace(LOOPBACK_AUTHORITY, (_match, scheme: string, userinfo = '') =>
    `${scheme}${userinfo}${host}`);
}

/** True when the URL points at a loopback address and would be unreachable from Homey. */
export function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_AUTHORITY.test(url);
}
