function createClipboardMonitor({ readText, isEnabled, isReady, onLink }) {
  let lastValue = null, reading = false, closed = false, generation = 0;

  async function poll() {
    let started = false;
    try {
      if (closed) return;
      if (!isEnabled()) { lastValue = null; generation++; return; }
      if (reading || !isReady()) return;
      reading = true; started = true;
      const currentGeneration = generation;
      const text = await readText();
      if (closed || currentGeneration !== generation || !isEnabled() || !isReady() || typeof text !== 'string') return;
      const value = text.trim();
      if (value === lastValue) return;
      lastValue = value;
      if (value.length > 8192) return;
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      if (!/\.(?:zip|rar|7z|tar|gz|exe|msi|iso|pdf|epub|mp4|webm|mkv|mp3|m4a|m3u8|mpd)$/i.test(url.pathname) && !['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) return;
      await onLink(url.href);
    } catch { /* An unavailable clipboard or unsupported text must not interrupt the application. */ }
    finally { if (started) reading = false; }
  }

  function close() { closed = true; generation++; lastValue = null; }
  return { poll, close };
}

module.exports = { createClipboardMonitor };
