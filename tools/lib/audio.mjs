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

/**
 * Re-encodes one MP3 per `encode` ({ bitrate, stereo, sampleRate, maxSeconds, split }).
 * Returns [relative output name, bytes] pairs: one, or up to `split` takes named name_1.mp3, name_2.mp3...
 */
export function encodeSound(rel, data, e) {
  if (!e.split) return [[rel, encodeRegion(data, e)]];
  const stem = rel.replace(/\.mp3$/, '');
  return soundRegions(data).slice(0, e.split).map(([a, b], i) => [`${stem}_${i + 1}.mp3`, encodeRegion(data, e, a, b)]);
}
