import { createHash } from 'node:crypto';
import { MEDIA_CONTAINERS, validateMediaSelection, isAudioContainer } from '../browser/extension/media-selection.mjs';

export { validateMediaSelection, isAudioContainer };
const qualities = ['best', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'];
const labels = { auto: 'تلقائي', mp4: 'MP4 · H.264 / AAC', mkv: 'MKV', webm: 'WebM · VP9 / AV1 / Opus', mp3: 'MP3 · صوت فقط', m4a: 'M4A · صوت فقط (AAC)' };
const safeId = /^[A-Za-z0-9_.-]{1,160}$/;
// These names are selector keywords or container shortcuts, not literal IDs.
const reservedIds = new Set(['all', 'mergeall', 'best', 'worst', 'b', 'w', 'bestvideo', 'worstvideo', 'bestaudio', 'worstaudio', 'bv', 'wv', 'ba', 'wa', 'mp4', 'mkv', 'webm', 'mov', 'flv', '3gp', 'm4a', 'aac', 'mp3', 'opus', 'ogg', 'wav', 'flac']);
const hasVideo = format => format.vcodec && format.vcodec !== 'none';
const hasAudio = format => format.acodec ? format.acodec !== 'none' : format.vcodec === 'none';
const audioOnly = format => format.vcodec === 'none' && hasAudio(format);

function compatible(format, container) {
  if (container === 'auto' || container === 'mkv') return true;
  if (container === 'mp4') return (!hasVideo(format) || /^(?:avc1|h264)/i.test(format.vcodec)) && (!hasAudio(format) || /^(?:mp4a|aac)/i.test(format.acodec));
  return (!hasVideo(format) || /^(?:vp0?8|vp0?9|av01|av1)/i.test(format.vcodec)) && (!hasAudio(format) || /^(?:opus|vorbis)/i.test(format.acodec));
}

function trackId(format) {
  return 'a-' + createHash('sha256').update(JSON.stringify([format.format_id, format.language || '', format.acodec, format.audio_channels || null])).digest('hex').slice(0, 24);
}

function trackLabel(format) {
  const language = typeof format.language === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(format.language) ? format.language : 'لغة غير محددة';
  const codec = typeof format.acodec === 'string' && /^[a-zA-Z0-9_.-]{1,48}$/.test(format.acodec) ? format.acodec : 'ترميز غير معلن';
  const details = [language, codec];
  try {
    const name = new Intl.DisplayNames(['ar'], { type: 'language' }).of(language.replace(/-orig$/, '').replaceAll('_', '-'));
    if (name && name !== language) details.splice(1, 0, name);
  } catch { /* Unknown extractor language identifiers remain visible as provided. */ }
  if (Number.isFinite(format.abr) && format.abr > 0) details.push(`${Math.round(format.abr)} kb/s`);
  if (Number.isInteger(format.audio_channels) && format.audio_channels > 0) details.push(`${format.audio_channels} قنوات`);
  if (/audio description|descriptive/i.test(format.format_note || '')) details.push('وصف صوتي');
  if (/\boriginal\b/i.test(format.format_note || '')) details.push('أصلي');
  return details.join(' · ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
}

function best(formats, video) {
  return formats.toSorted((left, right) => {
    const fields = video ? ['height', 'fps', 'quality', 'tbr'] : ['language_preference', 'quality', 'abr', 'asr'];
    for (const field of fields) {
      const difference = (Number(left[field]) || 0) - (Number(right[field]) || 0);
      if (difference) return difference;
    }
    return 0;
  }).at(-1);
}

function estimate(formats, duration) {
  let bytes = 0, approximate = false;
  for (const format of formats) {
    if (Number.isSafeInteger(format.filesize) && format.filesize > 0) bytes += format.filesize;
    else if (Number.isFinite(format.filesize_approx) && format.filesize_approx > 0) { bytes += format.filesize_approx; approximate = true; }
    else if (Number.isFinite(format.tbr) && format.tbr > 0 && Number.isFinite(duration) && duration > 0) { bytes += format.tbr * 1000 / 8 * duration; approximate = true; }
    else return { estimatedBytes: null, approximate: false };
  }
  return { estimatedBytes: Number.isSafeInteger(Math.round(bytes)) && bytes > 0 ? Math.round(bytes) : null, approximate };
}

export function mediaSelectionCatalog(info) {
  const formats = (Array.isArray(info.formats) ? info.formats : []).filter(format => !format.has_drm && typeof format.format_id === 'string' && safeId.test(format.format_id) && !reservedIds.has(format.format_id.toLowerCase()));
  const videos = formats.filter(hasVideo), audios = formats.filter(audioOnly);
  const tracks = (audios.length ? audios : videos.filter(hasAudio)).slice(-32).map(format => ({ id: trackId(format), label: trackLabel(format), format }));
  const combinations = [], plans = new Map();
  for (const container of MEDIA_CONTAINERS) {
    if (isAudioContainer(container)) {
      for (const track of [{ id: 'default' }, ...tracks]) {
        const audio = track.format || best(audios.length ? audios : videos.filter(hasAudio), false);
        if (!audio) continue;
        combinations.push({ container, quality: 'best', audioTrack: track.id, ...estimate([audio], info.duration), requiresVideoDownload: Boolean(hasVideo(audio)) });
        plans.set(JSON.stringify([container, 'best', track.id]), { selector: audio.format_id, container, audioTrack: track.id });
      }
      continue;
    }
    const availableQualities = qualities.filter(value => value === 'best' || videos.some(format => compatible(format, container) && String(format.height) === value));
    for (const quality of availableQualities) {
      const candidates = videos.filter(format => compatible(format, container) && (quality === 'best' || Number(format.height) <= Number(quality)));
      for (const track of [{ id: 'default' }, ...tracks]) {
        if (track.format && !audioOnly(track.format)) continue;
        const audio = track.format || best(audios.filter(format => compatible(format, container)), false);
        if (audio && !compatible(audio, container)) continue;
        const videoCandidates = audio ? candidates.filter(format => !hasAudio(format)) : candidates.filter(format => !formats.some(hasAudio) || hasAudio(format));
        const video = best(videoCandidates, true) || (track.id === 'default' ? best(candidates.filter(hasAudio), true) : null);
        if (!video) continue;
        const selected = hasAudio(video) || !audio ? [video] : [video, audio];
        const combination = { container, quality, audioTrack: track.id, ...estimate(selected, info.duration) };
        combinations.push(combination);
        plans.set(JSON.stringify([container, quality, track.id]), { selector: selected.map(format => format.format_id).join('+'), container, audioTrack: track.id });
      }
    }
  }
  const options = {
    containers: MEDIA_CONTAINERS.filter(id => combinations.some(value => value.container === id)).map(id => ({ id, label: labels[id] })),
    audioTracks: [{ id: 'default', label: 'الصوت الافتراضي' }, ...tracks.filter(track => combinations.some(value => value.audioTrack === track.id)).map(({ id, label }) => ({ id, label }))],
    combinations,
  };
  return { options, plans };
}

export function resolveMediaSelection(info, { quality = 'best', ...input } = {}) {
  const { container, audioTrack } = validateMediaSelection({ ...input, quality });
  const plan = mediaSelectionCatalog(info).plans.get(JSON.stringify([container, quality, audioTrack]));
  if (!plan) throw Object.assign(new Error('لم تعد الصيغة أو الدقة أو المسار الصوتي المختار متاحة. أعد فحص الفيديو وأضف تنزيلًا جديدًا.'), { code: 'media-selection-unavailable' });
  return plan;
}
