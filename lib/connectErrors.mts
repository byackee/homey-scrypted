/**
 * Turning a failed connection attempt into something the person reading it can act on.
 *
 * `connectScryptedClient` races every address it knows — the base URL it was given, the
 * local addresses the server reported about itself, the cloud relay — and takes the first
 * that opens. It does that with `Promise.any`, so when every one of them fails what comes
 * back is an `AggregateError` whose own message is the fixed string "All promises were
 * rejected". The reasons are in `errors`, and the message names neither the host, nor the
 * port, nor the refusal.
 *
 * That fixed string is what a user reporting a broken app sends us, and on its own it is
 * worth nothing: a wrong password, a firewall, a server that is not running and a name that
 * does not resolve all arrive spelled identically. Flattening the aggregate here is what
 * turns such a report into a diagnosis.
 */

/** Beyond this many distinct reasons the list stops informing and starts scrolling. */
const MAX_REASONS = 6;

/**
 * The reason one leaf failure carries.
 *
 * engine.io does not put its detail in `message`: a transport failure is reported as the
 * bare word "websocket error" or "xhr poll error", with what actually happened in
 * `description` — an HTTP status for the polling transport, a nested error for the socket.
 * A status of 401 there is the difference between "Scrypted is unreachable" and "the
 * password is wrong", so it is read rather than dropped.
 */
function reasonOf(err: unknown): string {
  if (err == null) return '';

  const candidate = err as {
    message?: unknown;
    code?: unknown;
    description?: unknown;
  };

  const message = typeof candidate.message === 'string' && candidate.message
    ? candidate.message
    : String(err);

  const details: string[] = [];
  const code = candidate.code;
  if ((typeof code === 'string' || typeof code === 'number') && !message.includes(String(code))) {
    details.push(String(code));
  }

  const description = candidate.description;
  if (typeof description === 'number') {
    details.push(`HTTP ${description}`);
  } else if (description && typeof description === 'object') {
    const nested = reasonOf(description);
    if (nested && nested !== message) details.push(nested);
  }

  return details.length ? `${message} (${details.join(', ')})` : message;
}

/**
 * Every distinct reason behind a failed connect, in one line.
 *
 * Aggregates nest — the client races a group of addresses inside a wider race — so this
 * recurses rather than reading one level. Duplicates are dropped: five addresses refused by
 * the same firewall produce five identical strings, and repeating them hides the one reason
 * that differs.
 */
export function describeConnectFailure(
  err: unknown,
  fallback = 'The connection failed without reporting a reason.',
): string {
  const reasons: string[] = [];
  const seen = new Set<string>();

  const collect = (candidate: unknown, depth: number): void => {
    if (candidate == null || depth > 4) return;

    const nested = (candidate as { errors?: unknown }).errors;
    if (Array.isArray(nested) && nested.length) {
      for (const inner of nested) collect(inner, depth + 1);
      return;
    }

    const reason = reasonOf(candidate).trim();
    if (!reason || seen.has(reason)) return;
    seen.add(reason);
    reasons.push(reason);
  };

  collect(err, 0);

  if (!reasons.length) return fallback;
  if (reasons.length <= MAX_REASONS) return reasons.join('; ');
  return `${reasons.slice(0, MAX_REASONS).join('; ')}; and ${reasons.length - MAX_REASONS} more`;
}
