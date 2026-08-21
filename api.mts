import type ScryptedApp from './app.mjs';

type Request = {
  homey: ScryptedApp['homey'];
  query: Record<string, string>;
  params: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * Endpoints consumed by the app settings page.
 *
 * The password is deliberately never returned: the settings page can set a new one but
 * cannot read the stored one back.
 */
export default {
  async getStatus({ homey }: Request) {
    const app = homey.app as ScryptedApp;
    return { ...app.getStatus(), config: app.getPublicConfig() };
  },

  async getDiagnostics({ homey, query }: Request) {
    return (homey.app as ScryptedApp).getDiagnostics({
      video: query.video === '1',
      settings: query.settings,
      noAudio: query.noAudio === '1',
    });
  },

  async setConfig({ homey, body }: Request) {
    const app = homey.app as ScryptedApp;
    await app.saveConfig({
      host: String(body.host ?? '').trim(),
      port: Number(body.port ?? 10443),
      username: String(body.username ?? '').trim(),
      password: String(body.password ?? ''),
    });
    return app.getStatus();
  },
};
