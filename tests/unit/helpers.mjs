export function fakeBuffer(sampleRate, chans) {
  return {
    sampleRate,
    length: chans[0].length,
    numberOfChannels: chans.length,
    duration: chans[0].length / sampleRate,
    getChannelData: (c) => chans[c],
  };
}
export const sine = (sr, secs, freq = 440, amp = 0.5) =>
  Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / sr));
export const constant = (n, v) => new Float32Array(n).fill(v);
