import { readFile } from 'node:fs/promises';
import { WindowsAuthService } from '../../src/windows-auth.mjs';

export async function windowsAuthServerService(options = {}) {
  const [clientSource, serverSource] = await Promise.all([
    readFile(new URL('../../src/native/windows-auth.cs', import.meta.url), 'utf8'),
    readFile(new URL('./windows-auth-server.cs', import.meta.url), 'utf8')
  ]);
  return new WindowsAuthService({ ...options, nativeSource: clientSource + '\n' + serverSource, contextType: 'SahmWindowsAuth.ServerContext' });
}

export const loopbackWindowsIdentity = Object.freeze({ scheme: 'ntlm', host: 'localhost', currentAccount: true, allowedHosts: ['localhost'] });
