import { createHash } from 'node:crypto';
import { normalizeNetworkConfig } from './network.mjs';
import { authenticationOrigin, serverCredentialKey } from './enterprise-auth.mjs';
import { clientCertificateKey, loadClientCertificate } from './client-certificates.mjs';
import { clientIdentityTlsOptions } from './client-certificate-identity.mjs';

export function proxyCredentialKey(value) {
  const route = value.mode === 'manual' ? value.proxy : value;
  if (!route?.host || !route?.port || !route?.type) return null;
  return 'proxy:' + createHash('sha256').update(`${route.type}://${route.host.toLowerCase()}:${route.port}`).digest('hex');
}

export class ConnectionSettings {
  constructor(network, preferences, vault) {
    this.network = network;
    this.preferences = preferences;
    this.vault = vault;
    this.memory = new Map();
    this.saving = Promise.resolve();
  }
  credentialsFor(route) {
    const key = proxyCredentialKey(route);
    return key ? this.memory.get(key) || this.vault.get(key) : null;
  }
  secretFor(key) { return this.memory.get(key) || this.vault.get(key); }
  serverCredentialsFor(origin) { return this.secretFor(serverCredentialKey(origin)); }
  async clientCertificateFor(origin) {
    const profile = this.preferences.snapshot().network.clientCertificates?.find(value => value.origin === origin && value.enabled);
    if (!profile) return null;
    return loadClientCertificate(origin, profile, this.secretFor(clientCertificateKey(origin))?.password || '');
  }
  snapshot() {
    const config = this.preferences.snapshot().network;
    const key = proxyCredentialKey(config);
    const login = key && this.credentialsFor(config);
    const summary = (origin, secretKey) => { const secret = this.secretFor(secretKey); return { origin, username: secret?.username || '', hasPassword: !!secret, remembered: !!this.vault.get(secretKey) }; };
    return { config, username: login?.username || '', hasPassword: !!login, remembered: !!(key && this.vault.get(key)), encryptionAvailable: this.vault.available(), warning: this.vault.loadError || null,
      serverLogins: (config.authentication?.servers || []).map(server => summary(server.origin, serverCredentialKey(server.origin))),
      clientCertificateLogins: (config.clientCertificates || []).map(profile => ({ origin: profile.origin, hasPassphrase: !!this.secretFor(clientCertificateKey(profile.origin)), remembered: !!this.vault.get(clientCertificateKey(profile.origin)) })) };
  }
  async init() { await this.network.configure(this.preferences.snapshot().network); return this; }
  save(data) {
    this.saving = this.saving.catch(() => {}).then(() => this.change(data));
    return this.saving;
  }
  async change(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('إعدادات اتصال غير صالحة.');
    const config = normalizeNetworkConfig(data.config);
    const previous = this.preferences.snapshot().network;
    const key = proxyCredentialKey(config);
    const changes = new Map();
    const validateEntry = (entry, flags) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || flags.some(flag => entry[flag] !== undefined && typeof entry[flag] !== 'boolean')) throw new Error('إعدادات حفظ بيانات الدخول غير صالحة.');
    };
    const stage = (secretKey, login, remember) => changes.set(secretKey, { oldMemory: this.memory.get(secretKey), oldStored: this.vault.get(secretKey), login, remember });
    const loginFor = (secretKey, entry) => {
      if (typeof entry.username !== 'string' || typeof entry.password !== 'string' || entry.username.includes(':') || entry.username.length > 512 || entry.password.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.username + entry.password)) throw new Error('بيانات الدخول غير صالحة.');
      const existing = this.secretFor(secretKey);
      if (entry.clearCredentials || !entry.username && !entry.password) return null;
      return !entry.password && existing?.username === entry.username ? existing : { username: entry.username, password: entry.password };
    };
    if (key) {
      validateEntry(data, ['remember', 'clearCredentials']);
      stage(key, config.authentication?.proxy.currentAccount ? null : loginFor(key, data), data.remember === true);
    }
    const serverEntries = data.serverCredentials ?? [], certificateEntries = data.clientCertificateSecrets ?? [];
    if (!Array.isArray(serverEntries) || !Array.isArray(certificateEntries) || serverEntries.length > 32 || certificateEntries.length > 32) throw new Error('إعدادات بيانات الدخول غير صالحة.');
    const seen = new Set();
    for (const entry of serverEntries) {
      validateEntry(entry, ['remember', 'clearCredentials']);
      const origin = authenticationOrigin(entry.origin), secretKey = serverCredentialKey(origin);
      if (seen.has(secretKey) || !config.authentication?.servers.some(value => value.origin === origin && !value.currentAccount)) throw new Error('بيانات الدخول لا تطابق خادمًا محددًا.');
      seen.add(secretKey); stage(secretKey, loginFor(secretKey, entry), entry.remember === true);
    }
    for (const entry of certificateEntries) {
      validateEntry(entry, ['remember', 'clearPassphrase']);
      const secretKey = clientCertificateKey(entry.origin);
      const profile = config.clientCertificates?.find(value => clientCertificateKey(value.origin) === secretKey);
      if (!profile || seen.has(secretKey) || typeof entry.passphrase !== 'string' || entry.passphrase.length > 4096 || /[\x00-\x1f\x7f]/.test(entry.passphrase)) throw new Error('بيانات شهادة العميل غير صالحة.');
      seen.add(secretKey);
      const existing = this.secretFor(secretKey);
      const login = entry.clearPassphrase ? null : entry.passphrase ? { username: 'tls-client-pfx', password: entry.passphrase } : existing || { username: 'tls-client-pfx', password: '' };
      stage(secretKey, login, entry.remember === true);
    }
    for (const server of previous.authentication?.servers || []) {
      if (!config.authentication?.servers.some(value => value.origin === server.origin && !value.currentAccount)) stage(serverCredentialKey(server.origin), null, false);
    }
    for (const profile of previous.clientCertificates || []) {
      if (!config.clientCertificates?.some(value => value.origin === profile.origin)) stage(clientCertificateKey(profile.origin), null, false);
    }
    const applied = [];
    try {
      for (const [secretKey, change] of changes) {
        // Record before writing so rollback also covers a later vault failure.
        applied.push([secretKey, change]);
        if (change.remember && change.login) await this.vault.set(secretKey, change.login);
        else if (change.oldStored) await this.vault.set(secretKey, null);
        if (change.login) this.memory.set(secretKey, change.login); else this.memory.delete(secretKey);
      }
      await this.network.configure(config);
      for (const profile of config.clientCertificates || []) {
        if (profile.enabled) {
          const identity = await loadClientCertificate(profile.origin, profile, this.secretFor(clientCertificateKey(profile.origin))?.password || '');
          await clientIdentityTlsOptions(identity);
        }
      }
      await this.preferences.update({ network: config });
    } catch (error) {
      let rollbackFailed = false;
      for (const [secretKey, change] of applied.reverse()) {
        if (change.oldMemory) this.memory.set(secretKey, change.oldMemory); else this.memory.delete(secretKey);
        if (this.vault.available()) await this.vault.set(secretKey, change.oldStored || null).catch(() => { rollbackFailed = true; });
      }
      await this.network.configure(previous).catch(() => { rollbackFailed = true; });
      if (rollbackFailed) throw new Error('تعذّر حفظ الاتصال واستعادة جميع بياناته السابقة. راجع إعدادات الاتصال وأدخل بيانات الدخول مجددًا قبل الاستئناف.');
      throw error;
    }
    return this.snapshot();
  }
}
