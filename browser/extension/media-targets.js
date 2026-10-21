(() => {
  'use strict';

  function httpUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch { return null; }
  }

  function youtubePageUrl(value) {
    const url = httpUrl(value);
    if (!url || url.protocol !== 'https:' || url.port) return null;
    const host = url.hostname.toLowerCase();
    let videoId;
    if (host === 'youtu.be') videoId = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      if (/^\/watch\/?$/.test(url.pathname)) videoId = url.searchParams.get('v');
      else videoId = /^\/(?:shorts|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
    return /^[\w-]{11}$/.test(videoId || '') ? `https://www.youtube.com/watch?v=${videoId}` : null;
  }

  function excludedPage(value, domains) {
    const url = httpUrl(value);
    if (!url) return true;
    const host = url.hostname.toLowerCase();
    return Array.isArray(domains) && domains.some(value => {
      if (typeof value !== 'string') return false;
      const domain = value.trim().toLowerCase().replace(/^\.+/, '');
      return /^[a-z0-9.-]+$/.test(domain) && (host === domain || host.endsWith(`.${domain}`));
    });
  }

  function mediaTarget({ pageUrl, sources = [], encrypted = false }) {
    if (encrypted) return { kind: 'unsupported', reasonCode: 'encrypted', reason: __sahmT("هذا الفيديو محمي ولا يمكن تنزيله باستخدام سَهم.") };
    const youtube = youtubePageUrl(pageUrl);
    if (youtube) return { kind: 'youtube', url: youtube };
    for (const value of sources) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const url = httpUrl(value, pageUrl);
      if (!url) continue;
      if (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) continue;
      if (/\.(m3u8|mpd)(?:$|\/)/i.test(url.pathname)) continue;
      return { kind: 'direct', url: url.href };
    }
    return { kind: 'unsupported', reason: __sahmT("تعذّر العثور على رابط فيديو مباشر. هذا النوع من البث غير مدعوم حاليًا.") };
  }

  function mediaTargetLabel(item) {
    const url = httpUrl(item.url);
    let name = url?.pathname.split('/').pop() || __sahmT("فيديو");
    try { name = decodeURIComponent(name); } catch { /* Keep the server's escaped filename. */ }
    name = name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
    const type = item.kind === 'youtube' ? 'YouTube' : item.kind === 'stream' ? (/\.mpd$/i.test(url?.pathname || '') ? 'DASH' : 'HLS') : (item.mime?.split('/')[1] || 'VIDEO').toUpperCase();
    const size = Number.isSafeInteger(item.bytes) && item.bytes > 0 ? __sahmT(" · {0} م.ب", [new Intl.NumberFormat(sahmI18n.locale(), { maximumFractionDigits: 1 }).format(item.bytes / 1048576)]) : '';
    return `${type} · ${name}${size}${item.requiresSession ? __sahmT(" · يتطلب جلسة") : ''}`;
  }

  globalThis.sahmMediaTargets = Object.freeze({ httpUrl, youtubePageUrl, excludedPage, mediaTarget, mediaTargetLabel });
})();

