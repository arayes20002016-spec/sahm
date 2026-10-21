export const MEDIA_CONTAINERS = Object.freeze(['auto', 'mp4', 'mkv', 'webm', 'mp3', 'm4a']);
export const isAudioContainer = container => container === 'mp3' || container === 'm4a';
export const AUDIO_TRACK_ID = /^a-[a-f0-9]{24}$/;

export function validateMediaSelection({ container = 'auto', audioTrack = 'default', quality = 'best' } = {}) {
  if (!MEDIA_CONTAINERS.includes(container)) throw new Error('صيغة حفظ الفيديو غير صالحة.');
  if (audioTrack !== 'default' && (typeof audioTrack !== 'string' || !AUDIO_TRACK_ID.test(audioTrack))) throw new Error('المسار الصوتي غير صالح. أعد فحص الفيديو.');
  if (isAudioContainer(container) && quality !== 'best') throw new Error('تنزيل الصوت لا يقبل دقة فيديو. أعد اختيار صيغة الصوت.');
  return { container, audioTrack };
}

// The bridge publishes only this bounded catalogue, never extractor URLs or headers.
export function publicMediaOptions(input) {
  if (!input || !Array.isArray(input.containers) || !Array.isArray(input.audioTracks) || !Array.isArray(input.combinations)) return null;
  const containers = input.containers.filter(item => MEDIA_CONTAINERS.includes(item?.id)).slice(0, 6).map(item => ({ id: item.id, label: String(item.label || item.id).slice(0, 100) }));
  const audioTracks = input.audioTracks.filter(item => item?.id === 'default' || typeof item?.id === 'string' && AUDIO_TRACK_ID.test(item.id)).slice(0, 33).map(item => ({ id: item.id, label: String(item.label || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) }));
  const combinations = input.combinations.filter(item => containers.some(value => value.id === item?.container) && audioTracks.some(value => value.id === item.audioTrack) && /^(best|4320|2160|1440|1080|720|480|360|240|144)$/.test(item.quality) && (!isAudioContainer(item.container) || item.quality === 'best')).slice(0, 1518).map(item => ({
    container: item.container, quality: item.quality, audioTrack: item.audioTrack,
    estimatedBytes: Number.isSafeInteger(item.estimatedBytes) && item.estimatedBytes > 0 ? item.estimatedBytes : null,
    approximate: item.approximate === true,
    ...(isAudioContainer(item.container) ? { requiresVideoDownload: item.requiresVideoDownload === true } : {}),
  }));
  return combinations.length ? { containers, audioTracks, combinations } : null;
}
