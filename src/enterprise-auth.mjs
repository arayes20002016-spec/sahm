import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const invalid = () => new Error('إعدادات المصادقة المؤسسية غير صالحة.');

export function authenticationOrigin(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
  return url.origin;
}

export function normalizeAuthentication(input = {}) {
  if (!object(input) || !onlyKeys(input, ['proxy', 'servers'])) throw invalid();
  const proxy = input.proxy ?? {};
  if (!object(proxy) || !onlyKeys(proxy, ['scheme', 'currentAccount', 'allowedHosts'])) throw invalid();
  const scheme = proxy.scheme ?? 'basic', currentAccount = proxy.currentAccount ?? false, hosts = proxy.allowedHosts ?? [];
  if (!['basic', 'ntlm', 'negotiate'].includes(scheme) || typeof currentAccount !== 'boolean' || scheme === 'basic' && currentAccount || !Array.isArray(hosts) || hosts.length > 64) throw invalid();
  const allowedHosts = [...new Set(hosts.map(host => {
    if (typeof host !== 'string' || !host || host.length > 253 || /[\s*\/@\\\x00-\x1f\x7f]/.test(host)) throw invalid();
    const checked = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (!isIP(checked) && !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(checked)) throw invalid();
    return checked;
  }))];
  if (currentAccount && !allowedHosts.length) throw new Error('أضف عنوان الوكيل الموثوق قبل استخدام حساب Windows.');
  const servers = input.servers ?? [];
  if (!Array.isArray(servers) || servers.length > 32) throw invalid();
  const origins = new Set();
  return {
    proxy: { scheme, currentAccount, allowedHosts },
    servers: servers.map(server => {
      if (!object(server) || !onlyKeys(server, ['origin', 'scheme', 'currentAccount']) || !['ntlm', 'negotiate'].includes(server.scheme) || typeof server.currentAccount !== 'boolean') throw invalid();
      const origin = authenticationOrigin(server.origin);
      if (origins.has(origin)) throw new Error('يوجد خادم مصادقة مكرر.');
      origins.add(origin);
      return { origin, scheme: server.scheme, currentAccount: server.currentAccount };
    })
  };
}

export function serverCredentialKey(origin) {
  return 'server-auth:' + createHash('sha256').update(authenticationOrigin(origin)).digest('hex');
}

export function serverAuthentication(url, config) {
  const origin = new URL(url).origin;
  return config.authentication?.servers.find(server => server.origin === origin) || null;
}

export function proxyAuthentication(route, config) {
  if (!['http', 'https'].includes(route.type)) return null;
  const policy = config.authentication?.proxy;
  if (!policy || policy.scheme === 'basic') return null;
  if (policy.currentAccount && !policy.allowedHosts.includes(route.host.toLowerCase())) throw Object.assign(new Error('الوكيل المكتشف غير مدرج ضمن عناوين حساب Windows الموثوقة.'), { code: 'windows-auth-untrusted-host' });
  return { scheme: policy.scheme, currentAccount: policy.currentAccount, allowedHosts: [...policy.allowedHosts] };
}
