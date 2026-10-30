# Frontline generated-model style bible

Every Meshy generation for Frontline starts from this file. Keep it fixed. If it has to change, note the date
and why at the bottom, because models made before and after a change won't match.

Plan and budgets: `docs/MODEL_GEN_PLAN.md`. Per-model records: `tools/generated/<id>.json`.

## Look

- Realistic modern military, roughly 2010s–2020s NATO-style, but generic: no real insignia, flags, patches,
  text, numbers or brand markings.
- Matte, slightly desaturated PBR. Light dust and mud on the lower parts. No cartoon proportions and no
  glossy plastic.
- **Paint is one flat olive-drab tone with no camouflage pattern.** The renderer tints the paint toward the
  team color while keeping its light and dark detail (`TeamPaint`, see Materials), so a printed pattern would
  muddy the team color and make the paint harder to separate. Everything that isn't paint (rubber, steel, glass, skin, boots, optics) should
  clearly differ in color from the olive.
- Readable from the RTS camera (40° FOV, 25–320 m): silhouette first. Slightly exaggerate the features that
  identify the unit, such as gun length, missile pods and radar dishes.

## Reference images

- Model: `nano-banana-2-lite` (3 credits) for previews. Use `nano-banana-2` only if lite can't give a clean
  image.
- One object, fully in frame, on a plain light-grey background, with no ground plane or cast shadow.
- Soft, even overcast light.
- Vehicles: a three-quarter front view from slightly above.
- Soldiers: front view in a T-pose with empty hands. The rifle is a separate prop that `tools/blender/`
  attaches to the hand bone, so it sits correctly in every clip.

### Prompt prefixes (copy exactly)

**Vehicle (tracked, wheeled):**

> Realistic modern military vehicle, generic 2010s NATO style, no insignia, no markings, no text, no numbers.
> Matte slightly desaturated plain olive drab paint, one flat color with no camouflage pattern, light dust and
> mud on the lower hull, black rubber and dark steel running gear. Single object, entire vehicle in frame,
> three-quarter front view from slightly above, centered on a plain light grey background, no ground, no
> shadow, soft even overcast lighting, photorealistic 3D render.

**Infantry:**

> Realistic modern infantry soldier, generic NATO style, no insignia, no flags, no patches, no text. Plain
> olive drab combat uniform, one flat color with no camouflage pattern, olive plate carrier vest with
> pouches, olive combat helmet, tan boots, black gloves, matte fabric with light dust. Full body, front view,
> T-pose, arms straight out, empty hands, no weapon, neutral face, plain light grey background, soft even
> lighting, photorealistic 3D render.

After the prefix, add one or two sentences on the specific model's identifying features.

## 3D generation

- Candidates (only when the reference image is in doubt): `meshy_image_to_3d`, `ai_model: meshy-6-lite`,
  `should_texture: false` (5 credits each), one or two per model. When the reference is clearly right, skip them
  and go straight to the final model. Judge them in `tools/viewer.html` (`?files=...&rts=110`) from the RTS camera, not from Meshy thumbnails.
  Use them for shape only: lite geometry is too rough to ship.
- Final: `meshy_image_to_3d` from the chosen reference with `model_type: smart-topology`,
  `ai_model: meshy-t2.5`, `target_polycount` = the budget, textured (15 credits). It comes out clean and under
  budget, so neither Meshy remesh nor Blender decimation is needed. (Batch 0 first tried lite + retexture +
  Blender decimation; it looked lumpy and was thrown away.)
- Soldiers: `pose_mode: t-pose`, then `meshy_rig` (5 credits, includes walk and run) and `meshy_animate`
  (3 credits per clip). A rig belongs to one mesh, so rig only the final model. The renderer plays idle, move,
  fire and death only, so request 5 clips: 0 Idle, 690 Walk_Forward_While_Shooting_inplace, 654
  Rifle_Charge_inplace, 183 Shot_and_Fall_Backward, 184 Shot_and_Fall_Forward (15 credits).
- Typical cost: a vehicle or structure is 18 credits (reference 3 + final 15); a soldier is 38 (+ rig 5 + clips 15).

## Budgets (triangles after Blender, before pipeline compression)

| Category | Triangles | Texture | GLB after pipeline |
|---|---|---|---|
| Infantry (rigged) | ≤ 4k | 512² | ≤ 500 KB incl. clips |
| Light vehicles | ≤ 8k | 1024² | ≤ 300 KB |
| Tanks / heavy | ≤ 12k | 1024² | ≤ 400 KB |
| Aircraft | ≤ 10k | 1024² | ≤ 350 KB |
| Ships | ≤ 20k | 1024²–2048² | ≤ 600 KB |
| Structures | ≤ 15k | 1024² | ≤ 500 KB |
| Props | ≤ 2k | 512² | ≤ 80 KB |

## Materials (what the renderer does with them)

`src/render/units.ts` and `materials.ts` pick each material's role by name and texture:

- `TeamPaint`: a copy of the Meshy material (same texture) on most of the paint (vehicles) or uniform
  (soldiers). The renderer gives it only a faint team tint, so it stays olive/grey and weathered.
- `TeamAccent`: same texture on the team-color areas: upward-facing paint high on the model (turret roofs,
  upper decks, cab roofs, superstructure roofs, aircraft upper surfaces) and the helmet and vest. The renderer
  keeps the texture's brightness (weathering, dirt, panel lines) and pulls its hue strongly toward the team
  color (`createTintMaterial` in `src/render/materials.ts`, also used by the far-LOD instancer).
  Older models without a `TeamPaint` material keep the procedural camo.
- Everything else keeps the Meshy texture and is named `Detail` (vehicles) or `Gear` (soldiers); the renderer
  leaves it as it is.
- Small parts made in Blender (weapons, the turret-ring cap) use `Weapon_metal`/`Metal_ring` and are kept as-is.
- Moving parts: `P_turret` (and `turretNode: "P_turret"` in `data/units.json`), `P_barrel` (recoil in `Fire`),
  and spinning parts named so the renderer keeps them animated (`turret_radar`).

## Changes

- 2026-10-29: first version (batch 0 pilot).
- 2026-10-29: final models use meshy-t2.5 smart topology instead of lite + Blender decimation.
- 2026-10-30: team color via a texture-preserving `TeamPaint` tint instead of procedural camo; 1 candidate (or
  none) when the reference is clear; 5 clips per soldier.
- 2026-10-30: team color as an accent (`TeamAccent`) with a faint tint elsewhere. Aircraft use "plain olive drab"
  (helicopters) or "plain grey-green" (jets) paint; ships "plain haze grey, dark red-brown below the waterline,
  full hull out of the water"; the submarine matte dark grey.
