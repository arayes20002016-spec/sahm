import { createServer } from 'node:net';
import { createServer as createTlsServer, TLSSocket, createSecureContext } from 'node:tls';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ftpCaFile = fileURLToPath(new URL('../fixtures/ftp/server-cert.pem', import.meta.url));
const key = await readFile(new URL('../fixtures/ftp/server-key.pem', import.meta.url));
const cert = await readFile(ftpCaFile);
const secureContext = createSecureContext({ key, cert });

// A deliberately small wire-level FTP/FTPS server. It records protocol actions,
// never passwords, and can advertise a hostile PASV address for bounce checks.
export async function ftpFixture(t, { mode = 'plain', epsv = true, pasvHost = '127,0,0,1', requireLogin = false, rest = true, missingMetadata = false, rejectTls = false, chunkDelay = 1, held = false } = {}) {
  const sockets = new Set(), dataServers = new Set(), requests = [];
  const heldWriters = new Set();
  let body = Buffer.alloc(256 * 1024), modified = '20261018010203', retrievals = 0, offline = false;
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const original = Buffer.from(body);
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); return socket; };
  const session = raw => {
    if (offline) { raw.destroy(); return; }
    track(raw);
    let control = raw, buffered = '', dataServer, dataSocket, dataReady, protectedData = false, offset = 0, timer, heldWriter;
    const send = line => { if (!control.destroyed) control.write(line + '\r\n'); };
    const stopData = () => {
      clearTimeout(timer); dataSocket?.destroy(); dataServer?.close();
      if (heldWriter) { heldWriters.delete(heldWriter); heldWriter = null; }
      if (dataServer) dataServers.delete(dataServer);
      dataSocket = null; dataServer = null;
    };
    raw.on('close', stopData);
    const passive = async extended => {
      stopData();
      dataReady = new Promise(resolveSocket => {
        dataServer = createServer(socket => { dataSocket = track(socket); resolveSocket(socket); });
        dataServer.on('error', () => {});
        dataServers.add(dataServer);
      });
      await new Promise(resolveListen => dataServer.listen(0, '127.0.0.1', resolveListen));
      const port = dataServer.address().port;
      send(extended ? `229 Entering Extended Passive Mode (|||${port}|)` : `227 Entering Passive Mode (${pasvHost},${Math.floor(port / 256)},${port % 256})`);
    };
    const retrieve = async () => {
      if (!dataServer) { send('425 Use passive mode'); return; }
      retrievals++;
      send('150 Opening binary data connection');
      let socket = await dataReady;
      if (protectedData) {
        socket = track(new TLSSocket(socket, { isServer: true, secureContext }));
        socket.once('error', stopData);
      }
      const content = body.subarray(offset); offset = 0;
      let written = 0;
      const writeChunk = () => {
        if (socket.destroyed) return;
        if (held && written >= 32768) { heldWriter = writeChunk; heldWriters.add(writeChunk); return; }
        const complete = () => {
          socket.end(); send('226 Transfer complete');
          dataServer?.close(); if (dataServer) dataServers.delete(dataServer);
        };
        if (written >= content.length) { complete(); return; }
        socket.write(content.subarray(written, written + 8192)); written += 8192;
        if (written >= content.length) complete(); else timer = setTimeout(writeChunk, chunkDelay);
      };
      if (protectedData) socket.once('secure', writeChunk); else writeChunk();
    };
    const command = async line => {
      const split = line.indexOf(' '), name = (split < 0 ? line : line.slice(0, split)).toUpperCase(), value = split < 0 ? '' : line.slice(split + 1);
      requests.push({ command: name, value: name === 'PASS' ? '[redacted]' : value });
      if (name === 'AUTH') {
        if (rejectTls || mode === 'plain') { send('502 TLS unavailable'); return; }
        send('234 Begin TLS');
        control.removeListener('data', receive);
        control = track(new TLSSocket(control, { isServer: true, secureContext }));
        control.on('data', receive); return;
      }
      if (name === 'USER') { send(requireLogin && value !== 'test-user' ? '530 Login incorrect' : '331 Password required'); return; }
      if (name === 'PASS') { send(requireLogin && value !== 'secret-ftp-password' ? '530 Login incorrect' : '230 Logged in'); return; }
      if (name === 'PWD') { send('257 "/" is current directory'); return; }
      if (name === 'FEAT') { send('211-Features\r\n EPSV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n AUTH TLS\r\n211 End'); return; }
      if (name === 'SYST') { send('215 UNIX Type: L8'); return; }
      if (['TYPE', 'CWD', 'PBSZ', 'OPTS'].includes(name)) { send('200 OK'); return; }
      if (name === 'PROT') { protectedData = value === 'P'; send('200 Protection set'); return; }
      if (name === 'SIZE') { send(missingMetadata ? '502 SIZE unavailable' : `213 ${body.length}`); return; }
      if (name === 'MDTM') { send(missingMetadata ? '502 MDTM unavailable' : `213 ${modified}`); return; }
      if (name === 'EPSV') { if (!epsv) send('502 EPSV unavailable'); else await passive(true); return; }
      if (name === 'PASV') { await passive(false); return; }
      if (name === 'REST') { if (!rest) send('502 REST unavailable'); else { offset = Number(value); send('350 Restart accepted'); } return; }
      if (name === 'RETR') { await retrieve(); return; }
      if (name === 'QUIT') { send('221 Goodbye'); control.end(); return; }
      send('502 Command unavailable');
    };
    let chain = Promise.resolve();
    const receive = data => {
      buffered += data.toString('utf8');
      let index;
      while ((index = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 2);
        chain = chain.then(() => command(line)).catch(() => control.destroy());
      }
    };
    control.on('data', receive); send('220 SAHM FTP fixture');
  };
  const server = mode === 'implicit' ? createTlsServer({ key, cert }, session) : createServer(session);
  server.on('tlsClientError', () => {});
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const directory = await mkdtemp(join(tmpdir(), 'sahm-ftp-'));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const dataServer of dataServers) dataServer.close();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    url: `${mode === 'implicit' ? 'ftps' : 'ftp'}://127.0.0.1:${server.address().port}/fixture.bin`,
    path: join(directory, 'result.bin'), directory, original, requests,
    get retrievals() { return retrievals; },
    interrupt() { offline = true; for (const socket of sockets) socket.destroy(); },
    reconnect() { offline = false; },
    hold() { held = true; },
    release() { held = false; const writers = [...heldWriters]; heldWriters.clear(); for (const write of writers) write(); },
    get heldTransfers() { return heldWriters.size; },
    change(value = Buffer.alloc(body.length, 97)) { body = value; modified = '20261019010203'; },
  };
}
