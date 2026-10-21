import { connect } from 'node:net';

export async function connectQmp(port) {
  const socket = connect({ host: '127.0.0.1', port });
  let buffer = '', sequence = 0;
  const pending = new Map();
  socket.setEncoding('utf8');
  const greeting = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error('Invalid QMP response')); return; }
        if (message.QMP) resolve(message.QMP);
        const entry = pending.get(message.id);
        if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.return); }
      }
    });
  });
  socket.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  socket.on('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('QMP closed')); } pending.clear(); });
  const command = (execute, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('QMP command timed out: ' + execute)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.write(JSON.stringify({ execute, arguments: args, id }) + '\n');
  });
  await greeting; await command('qmp_capabilities');
  return { command, close: () => socket.destroy() };
}
