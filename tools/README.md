# Asset pipeline

`npm run assets` builds `public/assets/` from the raw asset zips. The zips aren't committed because they total ~360 MB:

- `Modern-RTS-Animations.zip`: animated GLBs (soldiers, vehicles, aircraft, ships)
- `Modern-RTS-Models.zip`: source models (.blend/.fbx/.obj), including the base buildings
- `Modern-RTS-Sounds.zip`: MP3 sound effects, music and voices

By default the script looks in `~/Downloads`. You can point it elsewhere with `--src <dir>` or `FRONTLINE_ASSET_SRC`.

```bash
npm run assets                      # everything in the manifest
npm run assets -- --only tank       # just matching entries
```

## Adding a model

Add an entry to `assets.manifest.json`:

- `zip`, `path`: the source file inside the zip
- `out`: the output path under `public/assets/`
- `length` (meters, longest horizontal side), `height`, or `scale` (an explicit factor, needed for skinned characters)
- `rotateY` (degrees), if the model doesn't face +Z
- `clips`, to keep only the listed animation clips

The script prints final size, dimensions and clip names, so you can check them. Output is meshopt-compressed with WebP textures. three.js loads it via `GLTFLoader` + `MeshoptDecoder`, as `src/render/units.ts` does.

The processed output **is** committed: GitHub Pages can't serve Git LFS files, so they can't go there.

## Adding sounds

Sound entries copy every `.mp3` under `prefix` in the zip to `out`. Optional fields:

- `files`: only these names (relative to `prefix`)
- `encode`: re-encode with ffmpeg (must be on `PATH`, or set `FFMPEG=<path>`). Output is MP3:
  - `bitrate` (default `64k`), mono unless `stereo: true`, `sampleRate` (default 44100)
  - `maxSeconds`: trim to this length with a short fade-out
  - `split: n`: the file holds several takes separated by silence (the `02_weapons` recordings do); write up to `n` of them as `name_1.mp3`, `name_2.mp3`, ...

Entries without `encode` don't need ffmpeg.

## Licenses

Anything marked `CC-BY` needs a credit line in the in-game credits. The list is in `docs/GAME_PLAN.md` §3.
