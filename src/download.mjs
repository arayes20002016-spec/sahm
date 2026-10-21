import { open, readFile, rename, unlink, mkdir, link } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadHttpUrl, normalizeRequestContext, requestDownload } from './request-context.mjs';
import { writeCheckpoint } from './checkpoint.mjs';
import { recoverPublishedDownload } from './download-publication.mjs';
import { withServerTransfer, limitedRate, transferSpeedLimit } from './server-rules.mjs';

const minimumSplitBytes = 64 * 1024;
const maximumParts = 1024;

async function retryTransfer(operation, { signal, maxRetries, enabled = true }) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const retryable = error.retryable || error instanceof TypeError || error.name === 'TimeoutError';
      if (signal.aborted || !enabled || !retryable || attempt >= maxRetries) throw error;
      if (error.retryAfterMs > 1000) throw error;
      await delay(Math.max(250 * 2 ** attempt, error.retryAfterMs || 0), undefined, { signal });
    }
  }
}

export function prepareDownload(url, options = {}) {
  // Unlike a range probe, this response is retained and becomes the download.
  return requestDownload(url, options);
}

async function* bodyChunks(body, signal) {
  const reader = body.getReader();
  try {
    for (;;) {
      let timeout, aborted;
      let chunk;
      try {
        signal.throwIfAborted();
        const stalled = new Promise((_, reject) => { timeout = setTimeout(() => reject(new DOMException('Response stalled', 'TimeoutError')), 30000); });
        const cancelled = new Promise((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); });
        chunk = await Promise.race([reader.read(), stalled, cancelled]);
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', aborted); }
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function download(input, destination, options = {}) {
  return withServerTransfer(() => downloadHttp(input, destination, options));
}
async function downloadHttp(input, destination, { connections = 4, signal = new AbortController().signal, onProgress = () => {}, maxBytesPerSecond = 0, checkpointInterval = 1000, maxRetries = 2, requestContext, preparedResponse } = {}) {
  const url = downloadHttpUrl(input);
  const context = normalizeRequestContext(requestContext);
  if (preparedResponse && (!preparedResponse.ok || !preparedResponse.body || preparedResponse.bodyUsed)) throw new Error('Prepared download response is unavailable');
  if (!Number.isInteger(connections) || connections < 1 || connections > 16) throw new Error('Connections must be between 1 and 16');
  if (typeof maxBytesPerSecond !== 'function' && (!Number.isFinite(maxBytesPerSecond) || maxBytesPerSecond < 0)) throw new Error('Invalid speed limit');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('Retries must be between 0 and 5');
  if (!Number.isFinite(checkpointInterval) || checkpointInterval < 50) throw new Error('Checkpoint interval must be at least 50ms');
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  const partial = target + '.part';
  const manifest = target + '.resume.json';
  let state, file;
  try {
    try { state = JSON.parse(await readFile(manifest, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read resume state: ${error.message}`); }
    const published = await recoverPublishedDownload(url, target, state);
    if (published) { await preparedResponse?.body?.cancel(); return published; }
  } catch (error) { await preparedResponse?.body?.cancel().catch(() => {}); throw error; }
  // POSTs and accepted browser responses are consumed once, without a probe.
  const retainedResponse = preparedResponse || (context.method === 'POST' ? await prepareDownload(url, { requestContext: context, signal }) : null);
  // A real GET probe checks range behavior before resuming saved offsets.
  const probe = retainedResponse || await retryTransfer(
    () => requestDownload(url, { requestContext: context, headers: { Range: 'bytes=0-0' }, signal }),
    { signal, maxRetries },
  );
  const range = /^bytes 0-0\/(\d+)$/.exec(probe.headers.get('content-range') || '');
  const encoding = probe.headers.get('content-encoding');
  const size = range ? Number(range[1]) : Number(probe.headers.get('content-length')) || null;
  const etag = probe.headers.get('etag');
  const validator = etag && !etag.startsWith('W/') ? etag : probe.headers.get('last-modified');
  const ranged = context.method === 'GET' && (!encoding || encoding === 'identity') && (retainedResponse
    ? probe.status === 200 && size > 0 && Boolean(validator) && /\bbytes\b/i.test(probe.headers.get('accept-ranges') || '')
    : probe.status === 206 && Boolean(range));
  if (!retainedResponse) await probe.body?.cancel();
  try {
    if (!retainedResponse && state && ranged && validator && state.url === url && state.validator === validator && state.size === size && state.ranged) {
      if (!Array.isArray(state.parts) || state.parts.length === 0 || state.parts.length > maximumParts) throw new Error('Invalid resume state');
      let next = 0;
      for (const part of state.parts) {
        if (![part.start, part.end, part.done].every(Number.isSafeInteger) || part.start !== next || part.end < part.start || part.done < 0 || part.done > part.end - part.start + 1) throw new Error('Invalid resume ranges');
        next = part.end + 1;
      }
      if (next !== size) throw new Error('Invalid resume size');
      file = await open(partial, 'r+');
      if ((await file.stat()).size !== size) throw new Error('Partial file size changed');
    } else {
      const count = ranged && !retainedResponse ? Math.min(connections, size) : 1;
      state = { url, validator, size, ranged, parts: Array.from({ length: count }, (_, i) => ({ start: ranged ? Math.floor(i * size / count) : 0, end: ranged ? Math.floor((i + 1) * size / count) - 1 : null, done: 0 })) };
      // Existing unrelated partial data is preserved for inspection.
      if (await readFile(manifest).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) {
        await rename(manifest, manifest + `.stale-${Date.now()}`);
        await rename(partial, partial + `.stale-${Date.now()}`).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      file = await open(partial, 'wx+');
      if (ranged) await file.truncate(size);
    }
  } catch (error) {
    await file?.close().catch(() => {});
    await retainedResponse?.body?.cancel().catch(() => {});
    throw error;
  }
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const adaptive = state.ranged && !retainedResponse;
  const activeParts = new Map();
  const completedParts = new Set();
  let failure, checkpointTimer, nextSlot = Date.now();
  let saving = Promise.resolve();
  const persist = () => {
    // Snapshot offsets before fsync, so the manifest never claims unflushed writes.
    const snapshot = JSON.stringify(state);
    saving = saving.then(async () => {
      await file.sync();
      await writeCheckpoint(manifest, snapshot);
    });
    return saving;
  };
  const throttle = async count => {
    const rate = limitedRate(typeof maxBytesPerSecond === 'function' ? maxBytesPerSecond() : maxBytesPerSecond, transferSpeedLimit());
    if (!rate) { nextSlot = Date.now(); return; }
    nextSlot = Math.max(nextSlot, Date.now()) + count * 1000 / rate;
    await delay(Math.ceil(nextSlot - Date.now()), undefined, { signal: combined });
  };
  const claimPart = () => {
    combined.throwIfAborted();
    let part = state.parts.find(candidate => !activeParts.has(candidate) && !completedParts.has(candidate) && (!state.ranged || candidate.done < candidate.end - candidate.start + 1));
    if (!part && adaptive && state.parts.length < maximumParts) {
      let largest;
      for (const [candidate, reservation] of activeParts) {
        // A pending write owns its whole chunk until it finishes. Split only
        // beyond that reservation, including while the shared rate limiter waits.
        const start = Math.max(candidate.start + candidate.done, reservation.end + 1);
        const remaining = candidate.end - start + 1;
        if (remaining >= minimumSplitBytes * 2 && (!largest || remaining > largest.remaining)) largest = { candidate, start, remaining };
      }
      if (largest) {
        const start = largest.start + Math.ceil(largest.remaining / 2);
        part = { start, end: largest.candidate.end, done: 0 };
        largest.candidate.end = start - 1;
        state.parts.splice(state.parts.indexOf(largest.candidate) + 1, 0, part);
      }
    }
    if (part) activeParts.set(part, { end: part.start + part.done - 1 });
    return part;
  };
  try {
    await persist();
    checkpointTimer = setInterval(() => {
      persist().catch(error => { failure ||= error; controller.abort(error); });
    }, checkpointInterval);
    const transfer = async part => {
      if (state.ranged && part.done === part.end - part.start + 1) return;
      const start = part.start + part.done;
      // The response must match the range actually requested even if another
      // worker subsequently takes its unwritten tail.
      const requestedEnd = part.end;
      const headers = state.ranged ? { Range: `bytes=${start}-${requestedEnd}`, ...(validator ? { 'If-Range': validator } : {}) } : {};
      const response = retainedResponse || await requestDownload(url, { requestContext: context, headers, signal: combined });
      if (state.ranged && !retainedResponse && (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${requestedEnd}/${size}` || ![null, 'identity'].includes(response.headers.get('content-encoding')))) {
        await response.body?.cancel();
        throw new Error('Server changed or ignored the requested range');
      }
      const responseValidator = response.headers.get(etag && !etag.startsWith('W/') ? 'etag' : 'last-modified');
      if (validator && responseValidator && responseValidator !== validator) {
        await response.body?.cancel();
        throw new Error('Server content changed during transfer');
      }
      let responseBytes = 0;
      for await (const receivedChunk of bodyChunks(response.body, combined)) {
        combined.throwIfAborted();
        responseBytes += receivedChunk.length;
        if (state.ranged && responseBytes > requestedEnd - start + 1) throw new Error('Server sent excess bytes');
        const remaining = state.ranged ? part.end - part.start + 1 - part.done : receivedChunk.length;
        const chunk = receivedChunk.subarray(0, remaining);
        activeParts.get(part).end = part.start + part.done + chunk.length - 1;
        await throttle(chunk.length);
        let written = 0;
        while (written < chunk.length) {
          const result = await file.write(chunk, written, chunk.length - written, part.start + part.done);
          if (!result.bytesWritten) throw new Error('File write made no progress');
          written += result.bytesWritten;
          part.done += result.bytesWritten;
        }
        onProgress({ received: state.parts.reduce((sum, p) => sum + p.done, 0), total: size, connections: activeParts.size, parts: state.parts.map(value => ({ start: value.start, end: value.end, received: value.done, active: activeParts.has(value) })) });
        if (state.ranged && part.done === part.end - part.start + 1) return;
      }
      if (state.ranged && part.done !== part.end - part.start + 1) {
        const error = new Error('Incomplete range'); error.retryable = true; error.code = 'DOWNLOAD_INCOMPLETE_RANGE'; throw error;
      }
      if (!state.ranged && size !== null && part.done !== size && !encoding) throw new Error('Incomplete response');
    };
    const workers = Array.from({ length: adaptive ? connections : 1 }, async () => {
      for (let part; (part = claimPart());) {
        try {
          await retryTransfer(() => transfer(part), {
            signal: combined, maxRetries, enabled: !retainedResponse && context.method === 'GET' && state.ranged,
          });
          completedParts.add(part);
        } finally {
          activeParts.delete(part);
        }
      }
    });
    await Promise.all(workers.map(p => p.catch(error => { failure ||= error; controller.abort(error); })));
    clearInterval(checkpointTimer);
    if (!failure) {
      const info = await file.stat({ bigint: true });
      state.fileIdentity = { dev: info.dev.toString(), ino: info.ino.toString(), bytes: Number(info.size) };
      state.finished = true;
    }
    await persist();
    if (failure) throw failure;
  } finally { clearInterval(checkpointTimer); await saving.catch(() => {}); await file.close(); await retainedResponse?.body?.cancel().catch(() => {}); }
  // Hard-link promotion is exclusive: never overwrite an existing user file.
  await link(partial, target);
  await unlink(partial);
  await unlink(manifest);
  return { path: target, bytes: state.parts.reduce((sum, p) => sum + p.done, 0) };
}
