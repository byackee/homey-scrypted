import type { ScryptedConfig } from './types.mjs';

/**
 * Reading server details out of whatever a view submitted.
 *
 * Two views collect these — the repair dialog and the app's settings page — and only the
 * first used to check them. The settings page took what it was given, so an empty host was
 * stored as an empty host: the app then connected to `https://:10443`, failed for a reason
 * that reads like a network fault, and kept failing until someone thought to reopen a page
 * that had reported success. Refusing here is the difference between a mistake that is
 * corrected in the field it was made in and one that has to be diagnosed later.
 *
 * `translate` is passed in because the messages belong to Homey's locale files and this
 * module has no Homey to ask.
 */
export interface ServerConfigInput {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
}

/** Scrypted's own default HTTPS port, and what both views prefill. */
export const DEFAULT_PORT = 10443;

export function normaliseServerConfig(
  input: ServerConfigInput,
  translate: (key: string) => string,
): ScryptedConfig {
  const host = String(input.host ?? '').trim();
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const port = Number(input.port ?? DEFAULT_PORT);

  if (!host) throw new Error(translate('errors.host_required'));
  if (!username) throw new Error(translate('errors.username_required'));
  if (!password) throw new Error(translate('errors.password_required'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(translate('errors.port_invalid'));
  }

  return { host, port, username, password };
}
