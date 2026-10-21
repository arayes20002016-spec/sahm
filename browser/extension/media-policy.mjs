import { supportedUrl } from './capture-policy.mjs';
import './media-targets.js';

export const MEDIA_QUALITIES = ['best', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'];

export function youtubeUrl(value) {
  return supportedUrl(value) ? globalThis.sahmMediaTargets.youtubePageUrl(value) : null;
}

export async function youtubeSenderMatches(url, sender, readTab) {
  if (!url) return false;
  if (sender.frameId !== 0) return youtubeUrl(sender.url) === url;
  try {
    const current = await readTab(sender.tab.id);
    if (current.id !== sender.tab.id || current.incognito || youtubeUrl(current.url) !== url) return false;
    return new URL(sender.url).origin === new URL(current.url).origin;
  } catch { return false; }
}

export function directMediaUrl(value) {
  if (!supportedUrl(value)) return null;
  const url = new URL(value);
  if (youtubeUrl(value) || /(^|\.)(?:youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/.test(url.hostname) || url.hostname === 'youtu.be') return null;
  if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(url.href)) return null;
  return url.href;
}

export function streamMediaUrl(value) {
  if (!supportedUrl(value)) return null;
  const url = new URL(value);
  if (url.hash || !/\.(m3u8|mpd)$/i.test(url.pathname) || /(^|\.)(?:youtube\.com|youtube-nocookie\.com|googlevideo\.com)$/.test(url.hostname)) return null;
  return url.href;
}

export function mediaSenderAllowed(sender, extensionId, settings) {
  if (sender?.id !== extensionId || !Number.isInteger(sender.tab?.id) || sender.tab.incognito || !supportedUrl(sender.url)) return false;
  if (!settings.enabled || !settings.showVideoButton) return false;
  const hostname = new URL(sender.url).hostname;
  return !settings.excludedDomains.some(value => hostname === value || hostname.endsWith(`.${value}`));
}

export function qualityOptions(qualities) {
  return [...new Set(qualities)].filter(value => MEDIA_QUALITIES.includes(value)).map(id => ({ id, label: id === 'best' ? 'أفضل جودة' : `حتى ${id}p` }));
}
