# Asset pipeline

`npm run assets` builds `public/assets/` from three kinds of input:

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

3. **Generated models** (Meshy AI, post-processed in Blender), read from `~/Downloads/frontline-generated/`
   (`--generated <dir>` or `FRONTLINE_GENERATED_SRC`). See [Generated models](#generated-models-meshy--blender).

```bash
npm run assets                        # everything
npm run assets -- --only tank         # just entries whose output path contains "tank"
node tools/fetch-sources.mjs          # only download / verify the free sources
```

No Blender needed for the zips and free sources: OBJ files are converted by `lib/obj.mjs`, GLB/glTF by
glTF-Transform. Generated models need Blender once, to turn the raw Meshy download into the GLB the build reads.

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
- `generated`: instead of `zip`/`path`, a GLB in the generated folder written by a `tools/blender/` script.
- `out`: output path under `public/assets/`. `kind`: `unit | building | prop | env` (for the catalog).
- `credit`: key into `credits` (defaults to the zip name). The catalog's license and credits come from here.
- Size: `length` (longest horizontal side, m), `height`, or `scale` (explicit factor; skinned characters need `scale: 1`
  because their bind-pose bounds are wrong).
- `rotateY` (degrees) so the model faces +Z. `center: false` keeps the source origin. `draft` sinks ships to their waterline.
- `clips`: keep only these clips. `animTolerance`: keyframe resampling tolerance.
  `animPrune.dropBones`: regex of bones whose channels to drop. Channels on non-deforming rig helpers and channels
  that hold the rest pose are always dropped.
- `holdPose`: `{ clip, into, bones }` bakes the first frame of `clip` into the `bones` channels of each clip in `into`.
  The soldiers' idle and locomotion clips let the weapon dangle from one hand; Unity layers `WeaponHold_*` over them,
  three.js can't, so the hold pose is baked in.
- `reparent`: node name → new parent node name, keeping the rest-pose placement (the soldiers' weapons go on the hand bone).
- `colors`: material name (or `"*"`) → hex color, multiplied into any texture. `palette`: name of a shared `palettes` entry.
- `meshMaterials`: mesh name → `{ name, color, roughness, metallic }`, for meshes that ship without materials (the soldiers).
- `textureAdjust`: `{ saturation, brightness, tint }` applied to base color textures (tones down the Kenney colormap).
- `textureSize`: max texture size (default 512).
- `texture`: base color image (next to the file) for OBJs that ship without an `.mtl`.
- `kitbash`: instead of `zip`/`path`, a list of parts merged into one model. Each part is either a source model
  (same fields as above, plus `at: [x, y, z]`) or a primitive: `{ box: [w, h, d] }`, `{ cylinder: [rBottom, rTop, h] }`
  or `{ arch: [w, d] }` with `color`, `name`, `at`, and `center: false` so `at` is the base center.
  A part's `parent` hangs it under a named node so it follows that node's animation. `stripMeshesUnder` removes the
  meshes below a node and keeps the node and its clips. aa_tank uses both to swap the MBT's turret for an AA turret
  that still turns with `TurretTurn` and can be aimed through `P_turret`.

`textures` entries pick maps out of an ambientCG zip by filename suffix. `roughMin` remaps roughness into
`[roughMin, 1]` (Grass004 ships a mean roughness of 0.26, which renders as a wet glint). `files` copies a
downloaded file as-is.

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

## Generated models (Meshy + Blender)

Frontline's own models are made with the Meshy AI MCP and cleaned up in headless Blender 5.2. The plan, budgets
and batches are in `docs/MODEL_GEN_PLAN.md`; the fixed style and prompt prefixes are in `tools/generated/STYLE.md`.

- Raw Meshy downloads (reference images, candidates, the final textured model, rig and animation GLBs) go in
  `~/Downloads/frontline-generated/raw/<id>/`. They're not committed, like the zips.
- `tools/generated/<id>.json` records everything needed to redo a model: prompts, Meshy task ids, the chosen
  candidate, what was thrown away and why, post-processing steps and credits.
- `tools/blender/` has one script per category, driven by a per-model JSON config:

```bash
blender -b --factory-startup -P tools/blender/vehicle.py  -- tools/blender/tank_mbt.json [--preview <dir>]
blender -b --factory-startup -P tools/blender/infantry.py -- tools/blender/rifleman.json [--preview <dir>]
npm run assets -- --only tank_mbt
```

  - `vehicle.py`: orientation and size, team-paint split by texture color (`TeamPaint`, same texture, which the
    renderer tints toward the team color; the rest stays `Detail`), moving parts cut out by box with pivots
    (`P_turret`, `P_barrel`, spinning `turret_radar`), and `Fire`/`TurretScan`/`Death`/`Idle` clips. `TurretScan` is never played; it keeps `P_turret` animated so
    `render/models.ts` doesn't merge the turret into the hull.
  - `infantry.py`: uniform split (`TeamPaint` vs `Gear`), a weapon built from boxes and tubes on the right hand bone lined up with the
    left hand in the aim pose, the aim pose baked into the idle's arms, a built `Fire` kick, and clip renames to
    the names `render/units.ts` looks up.
  - `--preview <dir>` writes workbench renders for checking cuts (debug colors, not what the game shows).
- Check raw files in the viewer before building: `/tools/viewer.html?files=/a.glb,/b.glb&len=9.5&rts=110`
  (files must be served by Vite, e.g. copied under `public/`; `rts` frames like the game camera).

## Sources and licenses

| Source | Used for | License |
|---|---|---|
| Modern-RTS-Animations.zip, Zsky vehicles (`*_zsky_CC-BY`) | heli_attack, patrol_boat | **CC-BY 4.0**, Zsky (zsky2000.itch.io) |
| Modern-RTS-Models.zip, Zsky military base | hq, barracks, helipad, radar, supply_depot, hospital, watchtower, props, parts of the kitbashes | **CC-BY 4.0**, Zsky |
| Modern-RTS-Animations.zip, Freeciv units by yd | heli_transport, jet_fighter, bomber, cruise_missile, destroyer, cruiser, submarine, transport_ship | CC0 |
| Modern-RTS-Animations.zip, toon vehicles | (no longer used). The pack README lists them as CC0; they look like CptDrunkBear's N64-style set, so they're credited to CptDrunkBear | CC0 |
| Generated with Meshy AI (Pro plan; the output is owned by the project) | tank_mbt, rifleman, engineer, sniper, at_soldier, supply_truck, tank_light, ifv, artillery, aa_tank, rocket_truck, scout_car, jeep | owned, no attribution needed (credited as "made with Meshy AI") |
| Modern-RTS-Animations.zip, Kevin Iglesias soldiers | (no longer used) | Royalty-free, commercial use OK, no resale of the assets themselves |
| [Kenney Nature Kit](https://kenney.nl/assets/nature-kit) | `models/env/*` | CC0 |
| [Kenney City Kit (Industrial)](https://kenney.nl/assets/city-kit-industrial) | parts of war_factory, airfield, power_plant, naval_yard | CC0 |
| ambientCG [Grass004](https://ambientcg.com/view?id=Grass004), [Ground103](https://ambientcg.com/view?id=Ground103), [Rock030](https://ambientcg.com/view?id=Rock030), [Ground080](https://ambientcg.com/view?id=Ground080), [Ground048](https://ambientcg.com/view?id=Ground048) | grass, dirt, rock, sand, mud | CC0 |
| Poly Haven [Kloppenheim 06 (Pure Sky)](https://polyhaven.com/a/kloppenheim_06_puresky) by Greg Zaal, Jarod Guest | sky.hdr | CC0 |

Nikke's Abstract RTS pack (`*_abstract`) is **CC-BY-SA 3.0** per its own README.txt, even though the pack README says
CC0, so we don't ship anything from it.

Anything marked CC-BY needs a credit line in the in-game credits (see the Credits section of the root
`README.md` and `docs/GAME_PLAN.md` §3).

## Maps

The launch maps in `data/maps/` (Valley Pass, Coastal Strait, Desert Oilfields) are generated:

```bash
node tools/make-maps.mjs
```

Edit `tools/make-maps.mjs`, not the JSON. Features are written once and copied with 180-degree (two
sides) or 90-degree (four corners) rotational symmetry, and `terrain.symmetry` makes the random
relief match, so every spawn gets identical ground. `tests/maps.test.ts` checks the result:
buildable bases, reachable points, and exact symmetry. The terrain format is `TerrainDef` in
`src/shared/terrain.ts`; the sim and the renderer both read it.
