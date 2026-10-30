# Frontline: AI model generation plan (Meshy)

How one session uses the Meshy MCP to create Frontline's own realistic models (units, soldiers, buildings,
props), and how they get into the game. Written 2026-10-29 by the master session at the user's request.

## Goal

Replace the current mixed-source models with one consistent, realistic modern-military look that reads well
from the RTS camera. Also fill the gaps the current asset packs leave:
- no engineer or supply truck model
- no trenches or bunkers for garrisons
- no superweapon props
- no map-specific props (oil derricks, bridges, docks)

## Ground rules

- **Spending:** every Meshy generation costs the user's credits.
  - Run the pilot (batch 0) first and report what each model cost.
  - Estimate the total for the rest, then wait for the user's go-ahead before batch 1.
  - Report credits used at the end of every batch, and stop if credits run low.
- **Quality bar:** a new model replaces the current one only if it's clearly better in game, not just in
  isolation. For each replacement, show the user the old and new side by side in a match screenshot.
- **Reproducible:**
  - Raw Meshy downloads live outside the repo, in `~/Downloads/frontline-generated/`, like the source zips.
  - Every committed model has a record in `tools/generated/<id>.json` with the prompt(s), reference image,
    Meshy task ids, chosen candidate, post-processing steps and date.
  - `npm run assets` rebuilds `public/assets/` from those raw files, just like it does from the zips.
- **License:** ask the user which Meshy plan they're on.
  - Paid plans give ownership of the output.
  - Free-tier output has attribution terms, which must go in the credits.
  - Either way, record it in the catalog's `license`/`credits`.

## Style bible (written first, before any generation)

- **Look:** realistic modern military, about 2010s–2020s NATO-style equipment, but generic, with no real
  insignia or brand markings.
  - Matte, slightly desaturated PBR with weathering, dust and mud.
  - No cartoon proportions and no glossy plastic.
- **Readable from the RTS camera** (40° FOV, 25–320 m away):
  - Each unit must be identifiable from its silhouette alone.
  - Slightly exaggerate distinguishing features: barrel length, missile pods, radar dishes.
  - Keep the main body a large, flat-colored area so the team-color tint reads.
- **Consistency:**
  - Build one reference sheet per category (tracked, wheeled, infantry, air, naval, structure) using the
    same lighting and palette.
  - Generate with image-to-3D (or multi-image) from those references rather than text alone. Text-only
    output drifts in style from model to model.
  - Keep a fixed style prompt prefix in `tools/generated/STYLE.md`.
- **Budgets** (after Meshy remesh, before pipeline compression):

| Category | Triangles | Texture | Target GLB after pipeline |
|---|---|---|---|
| Infantry (rigged) | ≤ 4k | 512² | ≤ 500 KB incl. clips |
| Light vehicles | ≤ 8k | 1024² | ≤ 300 KB |
| Tanks / heavy | ≤ 12k | 1024² | ≤ 400 KB |
| Aircraft | ≤ 10k | 1024² | ≤ 350 KB |
| Ships | ≤ 20k | 1024²–2048² | ≤ 600 KB |
| Structures | ≤ 15k | 1024² | ≤ 500 KB |
| Props | ≤ 2k | 512² | ≤ 80 KB |

  - Use Meshy's remesh/polycount control to hit the triangle budgets.
  - The renderer can also simplify at load time (`render/models.ts`), but don't rely on it.

## What the game needs from a model (contract with the renderer)

Read `tools/README.md` and the generated `public/assets/models/catalog.json` first. Then match these:

- **Placement:** in meters, facing +Z, sitting on y=0, centered on x/z.
  - Ships put the waterline at y=0 and use `draft`.
  - Match the current model's `size` in the catalog unless the gameplay footprint (`data/units.json`
    `radius`, `data/structures.json` `size`) says otherwise.
- **Moving parts as separate named nodes**, each with its pivot at the rotation axis:
  - turret: `P_turret` / `turretNode` in `data/units.json`
  - barrels or guns
  - rotors
  - wheels or tracks where useful

  Meshy returns one fused mesh, so splitting it is a post-processing step. Do it with headless **Blender 5.2**
  (installed): `blender -b -P tools/blender/<script>.py`. Use one reusable script per category, driven by
  JSON cut volumes.
- **Team color:**
  - The renderer tints the material named in the catalog's `materials.team`.
  - With baked Meshy textures, split the main paint areas into their own material (a Blender
    selection-by-texture/region script), or add a team-mask texture.
  - A mask needs a small renderer change in `src/render/models.ts`, so agree it with the master session first.
- **Clips:**
  - `src/render/units.ts` looks clips up by name: idle `Idle|MilitaryIdle01|Idle01`,
    move `Move|Run01_Forward|Walk01_Forward|Fly`, fire `Fire|AssaultRifle_Aim01_Shoot01|Shoot`,
    death `Death|Death01|Death02|Crash|Sink`.
  - **Infantry:** use Meshy rigging + animation for idle, walk, run, aim+shoot, reload, hit and two deaths,
    then rename the clips to the names above.
  - Hold weapons properly. The current soldiers needed `holdPose`/`reparent` fixes for this, so check the
    rifle sits in both hands.
  - **Vehicles:** recoil, turret turning and death come from node animation or the renderer's procedural
    motion. Check what `units.ts` does when a clip is missing before generating any.

## Workflow per model

1. **Brief:** id, role, real-world inspiration (generic), size, triangle budget, moving parts, team-paint
   areas.
2. **Reference:** a category reference image (generated or composed) plus a short prompt with the style prefix.
3. **Generate:** create 2–4 preview candidates. Render each in `tools/viewer.html` from the RTS camera
   angle and pick one. Don't pick from a Meshy thumbnail.
4. **Refine:** texture/refine the chosen candidate, then remesh to budget.
5. **Post (Blender script):**
   - scale and orientation
   - split moving parts and set pivots
   - team material
   - clean up stray geometry
   - export GLB to `~/Downloads/frontline-generated/<id>.glb`
6. **Pipeline:**
   - add a manifest entry pointing at the generated source (add a `generated` source type to
     `tools/build-assets.mjs`)
   - run `npm run assets -- --only <id>`
   - write `tools/generated/<id>.json`
7. **Check:**
   - in `tools/viewer.html`, then in a skirmish (`?fakeLobby` is fine)
   - compare screenshots, old vs new, at default zoom and fully zoomed in
   - check the turret turns, the team color shows, clips play, and the scale matches neighbors

## Batches

| # | Models | Purpose |
|---|---|---|
| 0 Pilot | `tank_mbt`, `rifleman` | Prove the whole workflow (vehicle parts + rigged infantry). Report cost and quality, then **stop for user approval** |
| 1 Ground vehicles | jeep, scout_car, ifv, tank_light, aa_tank, rocket_truck, artillery, **supply_truck** (new) | |
| 2 Infantry | sniper, at_soldier, **engineer** (new); squad variety (2–3 rifleman variants) | |
| 3 Air | heli_attack, heli_transport, jet_fighter, bomber, cruise_missile | Rotors and props as nodes |
| 4 Naval | patrol_boat, destroyer, cruiser, submarine, transport_ship | Waterline, turrets |
| 5 Structures | hq, barracks, war_factory, airfield, helipad, naval_yard, power_plant, supply_depot, radar, hospital, watchtower | Plus construction-stage and destroyed variants if cheap |
| 6 Phase 2 needs | trenches, bunker, garrisonable buildings, superweapon launch site, oil derrick, bridge, dock, map props per biome | Check GAME_PLAN §7 and the Phase 2 PR for the final list |

Environment (trees and rocks) stays Kenney for now. It's cheap and fine; revisit in Phase 3.

## Ownership and coordination

- **Owns:** `public/assets/`, `tools/` (incl. `tools/blender/`, `tools/generated/`), and the catalog.
- **Doesn't change** unit stats, sim or UI.
- **Renderer changes** (team mask, new node names) must be small, listed in the PR, and agreed with the
  master session, because the Phase 2 session is also active.
- **Branch:** work on its own branch with a draft PR and a checklist per batch. **Never merge**; the master
  session asks the user.
- **Testing etiquette:** mute game audio while testing, use a dev port other than 5173 (e.g. 5181), and close
  browser tabs and stop dev servers when done.
