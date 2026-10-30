# Asset pipeline

`npm run assets` builds `public/assets/` from two kinds of input:

1. **The raw asset zips** (not committed, ~360 MB together):
   - `Modern-RTS-Animations.zip`: animated GLBs (soldiers, vehicles, aircraft, ships)
   - `Modern-RTS-Models.zip`: source models (.blend/.fbx/.obj), including the Zsky base buildings
   - `Modern-RTS-Sounds.zip`: MP3 sound effects, music and voices

   By default the script looks in `~/Downloads`. Point it elsewhere with `--src <dir>` or `FRONTLINE_ASSET_SRC`.
2. **Free downloads** listed under `sources` in `assets.manifest.json` (terrain textures, sky HDRI, Kenney kits).
   `tools/fetch-sources.mjs` downloads any that are missing into `~/Downloads/frontline-sources`
   (`--cache <dir>` or `FRONTLINE_ASSET_CACHE` to change it) and checks each file's sha256.
   `npm run assets` runs it first, so there's no separate download step. If an upstream file changes,
   the build stops; look at the new file, then run `node tools/fetch-sources.mjs --update-hashes`.

```bash
npm run assets                        # everything
npm run assets -- --only tank         # just entries whose output path contains "tank"
node tools/fetch-sources.mjs          # only download / verify the free sources
```

No Blender needed: OBJ files are converted by `lib/obj.mjs`, GLB/glTF by glTF-Transform.

## What it produces

| Output | What |
|---|---|
| `models/<unit>.glb` | Units. Face +Z, sit on y=0 centered on x/z, meters, clips kept. Ships put the waterline at y=0 (keel at `-draft`). |
| `models/buildings/<id>.glb` | HQ, barracks, helipad, radar, supply depot, hospital, watchtower (Zsky), and the kitbashed war factory, airfield, power plant, naval yard |
| `models/buildings/props/<id>.glb` | Walls, sandbags, containers, barrels, concrete block, crates, gas tank, light pole, barrier, gatehouse |
| `models/env/<tree_*\|bush_*\|rock_*>.glb` | Foliage and rocks (Kenney Nature Kit, recolored to natural tones) |
| `models/catalog.json` | Generated. Per model: id, path, kind, size `[x, y, z]` m, clips, named nodes (turrets, rotors, wheels), license, credits, `draft` for ships, `materials.team` = the material to tint with the team color |
| `textures/terrain/<grass\|dirt\|rock\|sand\|mud>_<albedo\|normal\|rough>.webp` | 1024², tileable. Normals are OpenGL convention (+Y), as three.js expects |
| `textures/sky/sky.hdr` | 1K equirectangular HDRI, golden hour, partly cloudy |

Check models in the dev-only viewer: `npm run dev`, then open `/tools/viewer.html`
(`?kind=unit|building|prop|env`, `?id=<id>` for one model with a clip picker, `?ids=a,b`).
The red arrow under each model points to +Z. The viewer isn't part of the build.

## Manifest reference (`assets.manifest.json`)

Model entries:

- `zip`, `path`: the source file inside a zip (`.glb`, `.gltf` or `.obj`). Zips are found in `--src`, then the download cache.
- `out`: output path under `public/assets/`. `kind`: `unit | building | prop | env` (for the catalog).
- `credit`: key into `credits` (defaults to the zip name). The catalog's license and credits come from here.
- Size: `length` (longest horizontal side, m), `height`, or `scale` (explicit factor; skinned characters need `scale: 1`
  because their bind-pose bounds are wrong).
- `rotateY` (degrees) so the model faces +Z. `center: false` keeps the source origin. `draft` sinks ships to their waterline.
- `clips`: keep only these clips. `animTolerance`: keyframe resampling tolerance.
  `animPrune.dropBones`: regex of bones whose channels to drop. Channels on non-deforming rig helpers and channels
  that hold the rest pose are always dropped.
- `colors`: material name (or `"*"`) → hex color, multiplied into any texture. `palette`: name of a shared `palettes` entry.
- `meshMaterials`: mesh name → `{ name, color, roughness, metallic }`, for meshes that ship without materials (the soldiers).
- `textureAdjust`: `{ saturation, brightness, tint }` applied to base color textures (tones down the Kenney colormap).
- `textureSize`: max texture size (default 512).
- `kitbash`: instead of `zip`/`path`, a list of parts merged into one model. Each part is either a source model
  (same fields as above, plus `at: [x, y, z]`) or a primitive: `{ box: [w, h, d] }`, `{ cylinder: [rBottom, rTop, h] }`
  or `{ arch: [w, d] }` with `color`, `name`, `at`, and `center: false` so `at` is the base center.

`textures` entries pick maps out of an ambientCG zip by filename suffix; `files` copies a downloaded file as-is.

`sounds` entries copy every `.mp3` under `prefix` in the zip to `out`. Optional fields:

- `files`: only these names (relative to `prefix`)
- `encode`: re-encode with ffmpeg (must be on `PATH`, or set `FFMPEG=<path>`). Output is MP3:
  - `bitrate` (default `64k`), mono unless `stereo: true`, `sampleRate` (default 44100)
  - `maxSeconds`: trim to this length with a short fade-out
  - `split: n`: the file holds several takes separated by silence (the `02_weapons` recordings do); write up to `n` of them as `name_1.mp3`, `name_2.mp3`, ...

Entries without `encode` don't need ffmpeg.

Output is meshopt-compressed (`EXT_meshopt_compression`, with quaternion/exponential filters on animation data)
with WebP textures. three.js loads it via `GLTFLoader` + `MeshoptDecoder`, as `src/render/units.ts` does.

The processed output **is** committed: GitHub Pages can't serve Git LFS files, so they can't go there.

## Sources and licenses

| Source | Used for | License |
|---|---|---|
| Modern-RTS-Animations.zip, Zsky vehicles (`*_zsky_CC-BY`) | jeep, scout_car, tank_light, heli_attack, patrol_boat | **CC-BY 4.0**, Zsky (zsky2000.itch.io) |
| Modern-RTS-Models.zip, Zsky military base | hq, barracks, helipad, radar, supply_depot, hospital, watchtower, props, parts of the kitbashes | **CC-BY 4.0**, Zsky |
| Modern-RTS-Animations.zip, Freeciv units by yd | ifv, tank_mbt, heli_transport, jet_fighter, bomber, cruise_missile, destroyer, cruiser, submarine, transport_ship | CC0 |
| Modern-RTS-Animations.zip, toon vehicles | rocket_truck, artillery (recolored). The pack README lists them as CC0; they look like CptDrunkBear's N64-style set, so they're credited to CptDrunkBear | CC0 |
| Modern-RTS-Animations.zip, `AntiAirTank1_abstract` from Nikke's Abstract RTS pack | aa_tank (recolored) | **CC-BY-SA 3.0**, Nikke / Nickotopia (nickotopia.com). The models pack README says CC0, but the pack's own README.txt says CC-BY-SA 3.0, so we follow that |
| Modern-RTS-Animations.zip, Kevin Iglesias soldiers | rifleman, sniper, at_soldier | Royalty-free, commercial use OK, no resale of the assets themselves |
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) | `models/env/*` | CC0 |
| [Kenney City Kit (Industrial)](https://kenney.nl/assets/city-kit-industrial) | parts of war_factory, airfield, power_plant, naval_yard | CC0 |
| ambientCG [Grass004](https://ambientcg.com/view?id=Grass004), [Ground103](https://ambientcg.com/view?id=Ground103), [Rock030](https://ambientcg.com/view?id=Rock030), [Ground080](https://ambientcg.com/view?id=Ground080), [Ground048](https://ambientcg.com/view?id=Ground048) | grass, dirt, rock, sand, mud | CC0 |
| Poly Haven [Kloppenheim 06 (Pure Sky)](https://polyhaven.com/a/kloppenheim_06_puresky) by Greg Zaal, Jarod Guest | sky.hdr | CC0 |

Anything marked CC-BY or CC-BY-SA needs a credit line in the in-game credits (see the Credits section of the root
`README.md` and `docs/GAME_PLAN.md` §3).
