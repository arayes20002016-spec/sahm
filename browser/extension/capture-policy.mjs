export const DEFAULT_SETTINGS = { enabled: false, allowSession: false, allowPost: false, showVideoButton: true, videoPanelMode: 'full', excludedDomains: [], bypassUntil: 0, bypassNext: false };

export function supportedUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value.length <= 8192;
  } catch { return false; }
}

export function captureDecision(item, settings, observed, now = Date.now()) {
  const url = item.finalUrl || item.url;
  if (!settings.enabled) return 'disabled';
  if (settings.bypassUntil > now || settings.bypassNext) return 'bypass';
  if (item.incognito || item.byExtensionId || item.state !== 'in_progress') return 'unsupported';
  if (!supportedUrl(url) || !supportedUrl(item.url)) return 'unsupported-url';
  if (item.danger && item.danger !== 'safe') return 'browser-safety';
  const domain = new URL(url).hostname;
  if (settings.excludedDomains.some(value => domain === value || domain.endsWith(`.${value}`))) return 'excluded-domain';
  if (!observed || !['GET', 'POST'].includes(observed.method) || typeof observed.usesCredentials !== 'boolean' || now - observed.time > 60000 || observed.time > now + 1000) return 'unsupported-request';
  if (observed.usesCredentials && (!settings.allowSession || (observed.method === 'GET' && !observed.requestContext))) return 'unsupported-request';
  if (observed.method === 'POST') return settings.allowPost && observed.attachment && observed.responseStatus === 200 ? 'browser-complete' : 'unsupported-request';
  return 'capture';
}

export async function handoffDownload(item, { settings, observed, send, cancel, now = Date.now() }) {
  const decision = captureDecision(item, settings, observed, now);
  if (decision === 'browser-complete') return { captured: false, reason: 'browser-completing' };
  if (decision !== 'capture') return { captured: false, reason: decision };
  const requestId = `download:${item.id}:${String(item.startTime).replace(/[^a-zA-Z0-9:._-]/g, '')}`;
  let response;
  try {
    response = await send({ v: 1, type: 'enqueue', requestId, expiresAt: now + 8000, source: 'automatic', url: item.finalUrl || item.url, name: (item.filename || '').split(/[\\/]/).pop(), mime: item.mime, totalBytes: item.totalBytes, method: observed.method, usesCredentials: observed.usesCredentials, requestObserved: true, requestContext: observed.requestContext, attachment: observed.attachment, sessionApproved: settings.allowSession === true, postApproved: settings.allowPost === true });
  } catch { return { captured: false, reason: 'app-unavailable' }; }
  if (response?.v !== 1 || response.requestId !== requestId || response.ok !== true || response.durable !== true || typeof response.jobId !== 'string' || !response.jobId) return { captured: false, reason: 'not-acknowledged' };
  try {
    await cancel(item.id);
    return { captured: true, jobId: response.jobId };
  } catch { return { captured: false, reason: 'browser-kept-original', jobId: response.jobId }; }
}
