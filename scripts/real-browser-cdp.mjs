import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';

// No external automation dependency: Chromium's documented null-delimited CDP pipe.
export class BrowserCdp extends EventEmitter {
  constructor(binary, profile) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = '';
    this.child = spawn(binary, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--headless=new', '--disable-background-networking', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', () => {});
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', () => this.fail(new Error('Browser exited')));
    this.child.stdio[4].on('data', chunk => {
      this.buffer += chunk;
      for (let index; (index = this.buffer.indexOf('\0')) >= 0;) {
        const value = JSON.parse(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 1);
        const task = this.pending.get(value.id);
        if (task) {
          this.pending.delete(value.id); clearTimeout(task.timer);
          value.error ? task.reject(new Error(`${task.method}: ${JSON.stringify(value.error)}`)) : task.resolve(value.result);
        } else if (value.method) this.emit('event', value);
      }
    });
  }
  static async launch(binary, profile) { await mkdir(profile, { recursive: true }); return new BrowserCdp(binary, profile); }
  fail(error) {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async attach(targetId) { return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  async evaluate(sessionId, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || ''));
    return result.result.value;
  }
  async page(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await this.attach(targetId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    return { targetId, sessionId };
  }
  async close() {
    await this.send('Browser.close').catch(() => {});
    if (this.child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { this.child.kill(); resolve(); }, 5000); this.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    // Windows child/grandchild process handles can outlive the browser process.
    for (const stream of this.child.stdio) stream?.destroy();
  }
}
