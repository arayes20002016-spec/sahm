import assert from 'node:assert/strict';
import net from 'node:net';
import { windowsAuthServerService } from './windows-auth-fixture.mjs';

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

export async function windowsConnectProxy(t, scheme) {
  const native = await windowsAuthServerService(), seen = [], failures = [], accepted = [];
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0), context, pending = Promise.resolve();
    socket.on('data', receive);
    socket.once('close', () => { context?.close().catch(() => {}); });
    function receive(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 256 * 1024) { socket.destroy(); return; }
      let end;
      while ((end = buffered.indexOf('\r\n\r\n')) >= 0) {
        const header = buffered.subarray(0, end + 4).toString('latin1'); buffered = buffered.subarray(end + 4);
        pending = pending.then(async () => {
          const authority = /^CONNECT (127\.0\.0\.1:\d+) HTTP\/1\.1\r\n/.exec(header)?.[1];
          const auth = /\r\nProxy-Authorization:\s*(\S+)(?:\s+([^\r\n]+))?\r\n/i.exec(header);
          seen.push({ target: authority, scheme: auth?.[1] || null });
          const wireScheme = scheme === 'ntlm' ? 'NTLM' : 'Negotiate';
          assert.ok(authority && auth?.[1].toLowerCase() === wireScheme.toLowerCase(), 'Only the configured SSPI scheme may reach the upstream proxy');
          context ||= await native.createContext({ scheme, host: 'localhost', currentAccount: true, allowedHosts: ['localhost'] });
          const result = await context.step(auth[2]);
          if (!result.complete) {
            socket.write(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${wireScheme} ${result.token}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`);
            return;
          }
          socket.pause(); socket.off('data', receive);
          const [host, port] = authority.split(':'), upstream = net.connect({ host, port: Number(port) });
          upstream.on('error', () => socket.destroy());
          socket.once('close', () => upstream.destroy());
          upstream.once('connect', () => {
            accepted.push(authority);
            const proof = result.token ? `Proxy-Authenticate: ${wireScheme} ${result.token}\r\n` : '';
            socket.write(`HTTP/1.1 200 Connection Established\r\n${proof}\r\n`);
            if (buffered.length) upstream.write(buffered);
            buffered = Buffer.alloc(0);
            socket.pipe(upstream); upstream.pipe(socket); socket.resume();
          });
          await context.close(); context = null;
        }).catch(error => { failures.push({ code: error.code, sspiStatus: error.sspiStatus }); socket.destroy(); });
      }
    }
  });
  t.after(() => native.close());
  return { port: await listen(t, server), seen, accepted, failures };
}

