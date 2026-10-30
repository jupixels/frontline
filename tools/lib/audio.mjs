// ffmpeg re-encoding for sound entries with `encode` (see tools/README.md "Adding sounds").

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
// Input goes through a temp file: ffmpeg stops reading early when trimming, which breaks stdin pipes.
const tmpIn = join(tmpdir(), `frontline-sound-${process.pid}.mp3`);
process.on('exit', () => rmSync(tmpIn, { force: true }));

function runFfmpeg(args, input) {
  writeFileSync(tmpIn, input);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', tmpIn, ...args], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`Can't run ffmpeg (${r.error.message}). Install it or set FFMPEG=<path>; sound entries with "encode" need it.`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-500)}`);
  return r;
}

/** Non-silent [start, end) regions, for recordings that hold several takes separated by silence. */
function soundRegions(data) {
  const log = runFfmpeg(['-af', 'silencedetect=n=-40dB:d=0.25', '-f', 'null', '-'], data).stderr.toString();
  const marks = [...log.matchAll(/silence_(start|end): ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]);
  const regions = [];
  let start = 0;
  for (const [kind, t] of marks) {
    if (kind === 'start') {
      if (t - start > 0.15) regions.push([start, t]);
      start = Infinity;
    } else start = t;
  }
  const dur = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const end = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : Infinity;
  if (end - start > 0.15) regions.push([start, Infinity]);
  return regions;
}

function encodeRegion(data, e, start = 0, end = Infinity) {
  const from = Math.max(0, start - 0.02);
  // Silence detection cuts reverb tails short, so keep a bit past the detected end.
  const dur = Math.min(end + 0.3 - from, e.maxSeconds ?? Infinity);
  const args = ['-ss', from.toFixed(3)];
  if (Number.isFinite(dur)) args.push('-t', dur.toFixed(3), '-af', `afade=t=out:st=${Math.max(0, dur - 0.12).toFixed(3)}:d=0.12`);
  args.push('-ac', e.stereo ? '2' : '1', '-ar', String(e.sampleRate ?? 44100), '-b:a', e.bitrate ?? '64k', '-f', 'mp3', 'pipe:1');
  return runFfmpeg(args, data).stdout;
}

const TRIM_ENDS =
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.01,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-58dB:start_silence=0.05,areverse';

/** Per-kind filters for generated (ElevenLabs) sounds, applied before peak normalization. */
const GENERATED = {
  // Weapons, impacts, deaths: lead and tail silence trimmed (tails stop below -58 dB), mono for the panner.
  shot: { pre: TRIM_ENDS, peak: -1, channels: 1, bitrate: '64k' },
  // Seamless loops from the generator: untouched so the seam stays clean.
  loop: { pre: 'anull', peak: -1, channels: 1, bitrate: '64k' },
  // Interface: tight trim, a bit quieter than combat at peak.
  ui: { pre: TRIM_ENDS + ',afade=t=in:d=0.004', peak: -3, channels: 1, bitrate: '64k' },
  // Unit voices: trimmed, band-limited like a field radio, gently compressed.
  voice: { pre: TRIM_ENDS + ',highpass=f=280,lowpass=f=3600,acompressor=threshold=-20dB:ratio=3:attack=5:release=80', peak: -1, channels: 1, bitrate: '64k' },
  // Music: stereo, loudness-matched, faded at both ends so the loop point is soft.
  music: { pre: 'loudnorm=I=-18:TP=-1.5:LRA=11,afade=t=in:d=1.5,areverse,afade=t=in:d=3,areverse', channels: 2, bitrate: '112k' },
};

/** Processes one generated sound of `kind` (see GENERATED); null if the take is near-silent. */
export function processGenerated(data, kind) {
  const k = GENERATED[kind];
  if (!k) throw new Error(`Unknown generated sound kind "${kind}"`);
  let gain = 0;
  if (k.peak !== undefined) {
    const log = runFfmpeg(['-af', `${k.pre},volumedetect`, '-f', 'null', '-'], data).stderr.toString();
    const max = Number(log.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? -Infinity);
    // The generator sometimes returns a near-silent take; boosting it only amplifies noise.
    if (!(max > -35)) return null;
    gain = k.peak - max;
  }
  const af = gain ? `${k.pre},volume=${gain.toFixed(2)}dB` : k.pre;
  return runFfmpeg(['-af', af, '-ac', String(k.channels), '-ar', '44100', '-b:a', k.bitrate, '-f', 'mp3', 'pipe:1'], data).stdout;
}

/**
 * Re-encodes one MP3 per `encode` ({ bitrate, stereo, sampleRate, maxSeconds, split }).
 * Returns [relative output name, bytes] pairs: one, or up to `split` takes named name_1.mp3, name_2.mp3...
 */
export function encodeSound(rel, data, e) {
  if (!e.split) return [[rel, encodeRegion(data, e)]];
  const stem = rel.replace(/\.mp3$/, '');
  return soundRegions(data).slice(0, e.split).map(([a, b], i) => [`${stem}_${i + 1}.mp3`, encodeRegion(data, e, a, b)]);
}
