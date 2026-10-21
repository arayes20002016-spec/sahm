import tls from 'node:tls';

// Read existing Windows trust only; neither client identities nor new trust
// anchors are imported into the operating system.
export function useWindowsSystemTrust({ platform = process.platform, tlsApi = tls } = {}) {
  if (platform !== 'win32') return { enabled: false, systemCertificates: 0 };
  if (typeof tlsApi.getCACertificates !== 'function' || typeof tlsApi.setDefaultCACertificates !== 'function') throw new Error('محرك TLS الحالي لا يدعم قراءة شهادات الثقة من Windows.');
  const existing = tlsApi.getCACertificates('default');
  const system = tlsApi.getCACertificates('system');
  tlsApi.setDefaultCACertificates([...new Set([...existing, ...system])]);
  return { enabled: true, systemCertificates: system.length };
}
