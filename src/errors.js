// Error type shared by all logic modules, plus plain-language messages for the UI.
export class VoxError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'VoxError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function friendlyMessage(err) {
  const code = err && err.code;
  switch (code) {
    case 'NOT_AUDIO':
      return "That doesn't look like an audio file. Try an MP3, WAV or M4A.";
    case 'TOO_LONG':
      if (err.duration && Number.isFinite(err.duration)) {
        return `That one runs ${formatDuration(err.duration)}. Vox-Slice handles up to 15 minutes per file, so trim it or split it first.`;
      }
      return 'That file is too long. Vox-Slice handles up to 15 minutes per file, so trim it or split it first.';
    case 'TIER_LIMIT': {
      const limit = err.limit && err.limit < 60 ? `${err.limit} seconds` : `${Math.round((err.limit || 0) / 60)} minutes`;
      const runs = err.duration && Number.isFinite(err.duration) ? `That one runs ${formatDuration(err.duration)}.` : 'That one is too long.';
      return `${runs} The free tier takes files up to ${limit}. Go Pro to slice whole speeches, or trim it down and drop it in again. Nothing was cut short.`;
    }
    case 'DECODE_FAILED':
      return "We couldn't read that audio. The file might be damaged or in an unusual format. Try converting it to MP3 or WAV and drop it in again.";
    case 'MODEL_DOWNLOAD':
      return "Couldn't download the speech model. Check your internet connection and try again. It only needs to download once.";
    case 'TIMEOUT':
      return 'Transcribing is taking much longer than expected, so we stopped it. Try again, or try a shorter file or a smaller model.';
    case 'CANCELLED':
      return 'Cancelled. Nothing was changed.';
    case 'WORKER':
      return 'Something went wrong while transcribing. Please try again. If it keeps happening, reload the page.';
    case 'BAD_PROJECT':
      return "That file isn't a Vox-Slice project, or it's damaged. Pick a .json project file saved from Vox-Slice.";
    default:
      return 'Something went wrong. Please try again.';
  }
}
