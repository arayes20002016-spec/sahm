import { createHash, X509Certificate } from 'node:crypto';

const error = () => Object.assign(new Error('تعذّرت مصادقة Windows مع الوكيل. راجع الحساب وطريقة المصادقة والعنوان الموثوق.'), { code: 'windows-proxy-auth-failed' });

export function tlsChannelBinding(socket) {
  if (!socket.encrypted) return undefined;
  const raw = socket.getPeerCertificate()?.raw;
  if (!raw) throw error();
  const algorithm = new X509Certificate(raw).signatureAlgorithm;
  const match = /sha[- ]?(224|256|384|512)/i.exec(algorithm || '');
  const hash = match ? `sha${match[1]}` : /md5|sha[- ]?1/i.test(algorithm || '') ? 'sha256' : null;
  if (!hash) throw error();
  return Buffer.concat([Buffer.from('tls-server-end-point:'), createHash(hash).update(raw).digest()]);
}

function read(socket, { length, delimiter, signal, maximum = 32768 }) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0), done = false;
    const finish = failure => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket.off('data', receive); socket.off('error', failed); socket.off('end', failed); socket.off('close', failed);
      socket.pause();
      if (failure) { reject(failure); return; }
      const count = delimiter ? bytes.indexOf(delimiter) + delimiter.length : length;
      if (bytes.length > count) socket.unshift(bytes.subarray(count));
      resolve(bytes.subarray(0, count));
    };
    const receive = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      const count = delimiter ? bytes.indexOf(delimiter) + delimiter.length : length;
      if (delimiter ? count >= delimiter.length : bytes.length >= length) { if (count > maximum) finish(error()); else finish(); }
      else if (bytes.length > maximum) finish(error());
    };
    const failed = () => finish(error()), abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(error()), 15000);
    socket.on('data', receive); socket.once('error', failed); socket.once('end', failed); socket.once('close', failed);
    signal.addEventListener('abort', abort, { once: true }); socket.resume();
    if (signal.aborted) abort();
  });
}

async function discardBody(socket, headers, signal) {
  let total = 0;
  if (headers.get('transfer-encoding')) {
    if (headers.get('transfer-encoding').toLowerCase() !== 'chunked') throw error();
    for (;;) {
      const line = (await read(socket, { delimiter: Buffer.from('\r\n'), signal, maximum: 1024 })).toString('ascii').trim();
      if (!/^[0-9a-f]+(?:;[^\r\n]*)?$/i.test(line)) throw error();
      const length = parseInt(line, 16); total += length;
      if (!Number.isSafeInteger(length) || total > 1024 * 1024) throw error();
      if (!length) {
        let trailer = 0;
        for (;;) { const line = await read(socket, { delimiter: Buffer.from('\r\n'), signal }); trailer += line.length; if (trailer > 32768) throw error(); if (line.length === 2) return; }
      }
      const data = await read(socket, { length: length + 2, signal, maximum: 1024 * 1024 + 2 });
      if (!data.subarray(-2).equals(Buffer.from('\r\n'))) throw error();
    }
  }
  const value = headers.get('content-length');
  // Without framing, the next challenge would not have a trustworthy boundary.
  if (value === null || !/^\d+$/.test(value) || Number(value) > 1024 * 1024) throw error();
  if (Number(value)) await read(socket, { length: Number(value), signal, maximum: 1024 * 1024 });
}

export async function authenticateProxyTunnel(socket, { authority, route, policy, credentials, service, signal }) {
  const scheme = policy.scheme === 'ntlm' ? 'NTLM' : 'Negotiate';
  if (typeof authority !== 'string' || !/^(?:\[[a-f0-9:]+\]|[a-z0-9_.-]+):\d{1,5}$/i.test(authority)) throw error();
  const context = await service.createContext({ scheme: policy.scheme, host: route.host, currentAccount: policy.currentAccount, allowedHosts: policy.allowedHosts || [], credentials: credentials || undefined, channelBinding: tlsChannelBinding(socket), signal });
  try {
    let challenge = null;
    for (let round = 0; round < 4; round++) {
      const result = await context.step(challenge);
      if (!result.token || !/^[a-z0-9+/]+={0,2}$/i.test(result.token)) throw error();
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\nProxy-Authorization: ${scheme} ${result.token}\r\n\r\n`);
      const head = (await read(socket, { delimiter: Buffer.from('\r\n\r\n'), signal, maximum: 256 * 1024 })).toString('latin1');
      const lines = head.split('\r\n'), status = /^HTTP\/1\.[01] (\d{3})\b/.exec(lines.shift() || '');
      if (!status) throw error();
      if (status[1] === '200') {
        if (!result.complete) {
          const final = new RegExp(`(?:^|\\r\\n)Proxy-Authenticate:\\s*${scheme}\\s+([a-z0-9+/]+={0,2})\\s*\\r\\n`, 'i').exec(head);
          if (!final || !(await context.step(final[1])).complete) throw error();
        }
        return socket;
      }
      if (status[1] !== '407') throw error();
      const headers = new Headers();
      for (const line of lines.filter(Boolean)) {
        const colon = line.indexOf(':'); if (colon <= 0) throw error();
        headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      if (/close/i.test(headers.get('connection') || '') || /close/i.test(headers.get('proxy-connection') || '')) throw error();
      await discardBody(socket, headers, signal);
      const match = new RegExp(`(?:^|,\\s*)${scheme}\\s+([a-z0-9+/]+={0,2})(?:\\s*(?:,|$))`, 'i').exec(headers.get('proxy-authenticate') || '');
      if (!match || match[1].length > 174764) throw error();
      challenge = match[1];
    }
    throw error();
  } finally { await context.close().catch(() => {}); }
}
