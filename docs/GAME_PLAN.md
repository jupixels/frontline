# FRONTLINE — Modern Military RTS (working title)

A 3D modern-warfare RTS that runs in the browser from GitHub Pages and supports online multiplayer (1v1, 2v2) plus solo play against an AI. One match takes **60–90 minutes** and always ends, because the victory system is built to force an outcome.

---

## 1. Pillars

1. **It looks real.** PBR lighting, soft shadows, atmospheric fog, color grading, dust and smoke, tracers, craters. Everything sits in one grounded visual style (muted military palette). Toy-like assets get reskinned or left out.
2. **Combined arms is how you win.** Infantry, armor, artillery, air and navy counter each other. No single unit spam wins.
3. **Every minute matters.** Contested capture points, a ticket bleed and escalating tech tiers keep the pressure on, so the 60–90 minute match never stalls.
4. **Zero install.** Open a link, share a lobby code, play. No server to host or pay for.

---

## 2. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language/build | **TypeScript + Vite** | Fast dev loop, static build output for Pages |
| Rendering | **three.js** (WebGL2; WebGPU later if it's stable) | Native GLB + animation-clip support; the asset pack targets it |
| Post-processing | `postprocessing` lib (SSAO/N8AO, bloom, SMAA, tone mapping, LUT) | Realistic look on a budget |
| Multiplayer transport | **WebRTC data channels via Trystero** (signaling over public Nostr/MQTT relays) | GitHub Pages is static-only, so it can't run a game server. P2P needs none. PeerJS's public broker is the fallback |
| Netcode model | **Deterministic lockstep** (commands only, ~10 turns/s, 2–3 turn input delay) | Standard for RTS. Bandwidth stays tiny with hundreds of units, and the host can't cheat on unit state |
| Simulation | Fixed-tick (20 Hz) ECS-style sim in pure TS, **no three.js imports**, fixed-point/int math + table trig | Required for lockstep determinism across browsers |
| Pathfinding | Flow fields on a nav grid + local steering/avoidance | Scales to large group moves |
| Audio | Web Audio API (adapt the bundled `sfx.js`), positional panning by camera distance | Already have the manager |
| Deploy | GitHub Actions → `actions/deploy-pages` | Push to `main` → live |
| Tests | Vitest (sim and determinism tests run headless) | A desync test can replay one match twice and compare hashes |

**Determinism rule (critical):** `src/sim/**` can't use `Math.random`, `Math.sin/cos/atan2/sqrt` on gameplay values, `Date`, or object iteration order that depends on insertion timing. It uses a seeded PRNG plus fixed-point helpers from `src/sim/math/`. Rendering interpolates sim state and may use floats freely.

---

## 3. Assets — what we use and how

### Pipeline
- Raw zips stay **out of the repo** (~360 MB). A script (`tools/build-assets.mjs`) copies the selected files into `public/assets/` and runs **gltf-transform**: meshopt compression, textures → WebP/KTX2, dedupe, and stripping unused clips. This step also fixes scale (some models are in cm).
- Target is **< 40 MB of shipped assets**, all lazy-loaded per faction/map. Don't use Git LFS: Pages serves the LFS pointer files, not the real ones.
- The four soldier GLBs (~5 MB each) share one skeleton. We ship one mesh + a weapon swap + a single clip set, instanced via `SkinnedMesh` cloning (GPU skinning; LOD to a static impostor past a camera distance).
- Untextured "abstract"/"toon" models get a shared **procedural camo PBR material** with a team-color mask, so they match the textured ones.

### Roster mapping (launch content)
Two factions share most of the roster. Each gets 2–3 signature units so it plays differently.

| Role | NATO-style "Coalition" | Eastern "Pact" | Model source |
|---|---|---|---|
| Rifle squad | Rifleman / Rifleman_Female | Rifleman | soldiers/*.glb |
| Anti-tank team | AntiTank_Bazooka | AntiTank_Bazooka | soldiers |
| Sniper | Sniper | Sniper | soldiers |
| Recon vehicle | Jeep_zsky | Jeep_GAZ67 | vehicles/ground |
| APC/IFV | IFV_MechInfantry | ScoutCar_zsky (armored car) | vehicles/ground |
| Main battle tank | Tank_MBT | Tank_Super_zsky | vehicles/ground |
| Light tank | Tank_Light_zsky | Tank_Light_toon (reskinned) | vehicles/ground |
| Mobile AA | AntiAirTank1 (reskinned) | AntiAirTank3 (reskinned) | vehicles/ground |
| Rocket artillery | Rocket_Artillery_Truck | Rocket_Artillery_Truck (alt skin) | vehicles/ground |
| Attack helicopter | Helicopter_Gunship_zsky | Helicopter_Transport (armed variant) | vehicles/air |
| Utility/transport heli | Helicopter_Utility_zsky | Helicopter_Transport | vehicles/air |
| Fighter (off-map strike) | Jet_StealthFighter | Jet_MiG15 / Phantom | vehicles/air |
| Superweapon/ultimate | Jet_StealthBomber carpet strike | Missile_Cruise strike | vehicles/air |
| Naval: patrol | Patrol_Boat_zsky | Patrol_Boat_zsky | vehicles/naval |
| Naval: destroyer | Destroyer | Cruiser | vehicles/naval |
| Naval: capital | Cruiser_AEGIS | Battleship | vehicles/naval |
| Naval: submarine | Submarine | Submarine | vehicles/naval |
| Naval: transport | Transport_Ship | Transport_Ship | vehicles/naval |

**Buildings** come from `base_buildings/zsky_military_base` (HQ=Quarter, Barracks=Refectory, Helipad=HelicopterBase, Radar=RadioStation, Supply depot=Storage, Field hospital=MedicTent, Watchtower=SniperTower, plus walls/sandbags/containers as props). We still need a **War Factory, Airfield, Naval Yard and Power Plant**: use `abstract_rts_pack` factory/airport reskinned, or kitbash from containers + props.

**Not used at launch:** Helicopter_Attack_toon (renders as a flat plane in the preview, so the mesh is broken), Tank1–3_abstract (too toy-like), Artillery_Howitzer (antique wheeled gun; maybe a WWII-relic easter egg), voxel models (style clash), and everything in `_free_but_no_license_stated/` (unclear license).

### Still missing (needs your OK to download — all free/CC0)
- **Terrain textures** (grass, dirt, rock, sand, mud, asphalt, normal maps): ambientCG / Poly Haven, CC0.
- **HDRI sky** for lighting: Poly Haven, CC0.
- **Trees/rocks/foliage**: Quaternius or Kenney nature packs, CC0.
- **VFX sprites** (smoke, fire, muzzle flash flipbooks): Kenney particle pack (CC0), or generate them procedurally.
- More **unit voice lines** (only artillery/destroyer/heli/factories have them). We could use TTS with radio filtering, or reuse the existing lines.

### Credits screen (required)
Zsky (CC BY 4.0), dklon jet sound (CC BY 3.0), the five ww2 sound credits from the README, and Kevin Iglesias for the soldier animations. Add the CC0 authors as a courtesy.

---

## 4. Game design

### Match flow (target 60–90 min)
| Phase | Time | What happens |
|---|---|---|
| Deploy | 0–5 min | HQ + 1 engineer truck + 2 rifle squads. Build the economy and grab the nearest capture points |
| Skirmish (Tier 1) | 5–20 | Infantry, recon, light vehicles. Fights over the central points |
| Escalation (Tier 2) | 20–45 | Tanks, IFVs, artillery, helicopters, navy. Unlocked by the Radar + tech research |
| Total War (Tier 3) | 45+ | Air strikes, capital ships, one superweapon per side (bomber run / cruise missile, long cooldown, early warning to the enemy) |
| Endgame | — | Ticket bleed accelerates; sudden death at 90 min (the HQ loses armor) |

### Victory conditions (choose in lobby)
- **Frontline (default):** each side starts with **1000 tickets**. A side holding the majority of the **Strategic Points** drains enemy tickets, and losing units drains your own a little. First to 0 loses. Destroying the enemy HQ also wins. The drain is tuned so a dominant side wins in ~45 min and an even game ends by ~90.
- **Annihilation:** destroy all enemy production buildings.

### Economy (2 resources, kept simple)
- **Supply:** gained from capture points (passive trickle) and from **Supply Depots** built on oil/supply nodes. It's spent on everything.
- **Power:** made by Power Plants. Low power slows production and disables radar/defenses, so power plants make good raid targets.
- **Command Points (CP)** cap your army size (pop cap). CP grows with the points you hold, which keeps the leader from snowballing too hard.

### Combat model
- Damage types: **small-arms / AP / HE / AA / torpedo** vs armor classes **infantry / light / heavy / air / naval / structure**, using a multiplier table (`data/damage.json`).
- **Directional armor** on tanks: front/side/rear, so flanking matters.
- **Line of sight + fog of war.** Height gives vision and a range bonus, and forests block LOS and give infantry cover.
- **Suppression:** infantry under heavy fire go prone, move slowly and fire less accurately.
- **Veterancy:** 3 ranks (+accuracy, +HP, self-heal at rank 3).
- **Garrison:** infantry can enter buildings/trenches. Transports (IFV, heli, transport ship) carry squads.
- Artillery fires indirect, needs spotters (vision), and shows a target marker the enemy can see, so they get a chance to dodge.

### Counter wheel
Infantry ← (snipers, MGs) · AT infantry → tanks · tanks → light vehicles/infantry · artillery → static/clumped targets · attack heli → armor · mobile AA → helis/jets · fighters → helis · destroyers → subs/boats · subs → capital ships · capital ships → shore bombardment.

### Maps (launch: 3 maps)
1. **Valley Pass** (1v1, ~2×2 km): land only, river with 3 bridges, good for learning.
2. **Coastal Strait** (2v2): islands + mainland, naval matters, amphibious landings.
3. **Desert Oilfields** (1v1/2v2): open terrain, armor-focused, many supply nodes.

Each map is a heightmap + splat map + JSON (points, spawns, props). An in-repo map editor is a stretch goal.

### Controls (standard RTS)
Box select, double-click to select all of a type, control groups (Ctrl+1–9), attack-move (A), stop (S), hold (H), patrol (P), queue with Shift, formation drag (right-drag to set facing), edge-pan/WASD, wheel zoom, middle-drag rotate, minimap click, and alerts with Space to jump to the last one.

### Multiplayer UX
- Main menu → **Host** (gets a 6-char room code / share link `…/#room=ABC123`) or **Join**.
- Lobby: pick a faction, team, color and map; chat; ready-check. The host starts the match.
- In-match: ping indicator, a "waiting for player" overlay when a peer lags, desync detection (state hash every 50 ticks, compared between peers), and surrender / pause votes.
- **Reconnect:** the rejoiner gets the command log from a peer and fast-forwards the sim.
- **Replays come free with lockstep:** save the command log as a file.
- Solo: **Skirmish vs AI** (Easy/Normal/Hard) plus a short tutorial mission.

---

## 5. Visual direction ("aesthetic + realistic")
- Time of day per map (golden hour, overcast, desert noon) with an HDRI sky, cascaded shadow maps, and fog that tints with distance.
- Post stack: N8AO ambient occlusion, soft bloom on muzzle flashes/explosions, filmic tone mapping, a subtle LUT grade, vignette, optional film grain.
- Terrain: splat-blended PBR textures, tire tracks and craters as decals, and instanced grass/trees with wind sway.
- Water: animated normals, foam at the shoreline, ship wakes.
- VFX: GPU-instanced particle system for smoke columns from wrecks, dust trails behind vehicles, tracers, rocket trails and shockwave rings. Wrecks persist for a while.
- Camera: a slight tilt-shift depth of field when zoomed in, shake on nearby explosions.
- UI: dark translucent military HUD with monospace readouts and a minimal accent color. It shouldn't look like a mobile game.
- Performance budget: 60 fps with 300 units on a mid laptop iGPU at 1080p. Quality presets (Low/Med/High/Ultra) toggle the post effects and shadow resolution.

---

## 6. Code architecture

```
militaryrts/
├─ .github/workflows/deploy.yml     # build + deploy to Pages
├─ tools/build-assets.mjs           # raw zips → optimized public/assets
├─ public/assets/{models,sounds,textures,maps}
├─ data/                            # JSON balance: units, buildings, damage, tech
├─ src/
│  ├─ main.ts                       # bootstraps app, routes menu ↔ match
│  ├─ shared/                       # types & contracts shared by all modules
│  │   ├─ commands.ts               # Command union (Move, Attack, Build, …)
│  │   ├─ entities.ts               # component shapes, EntityId, PlayerId
│  │   └─ events.ts                 # sim→view events (UnitFired, Died, …)
│  ├─ sim/                          # DETERMINISTIC, no DOM/three imports
│  │   ├─ math/ (fixed, prng, trig)
│  │   ├─ world.ts, systems/*.ts    # movement, combat, economy, capture, fog
│  │   └─ path/ (navgrid, flowfield)
│  ├─ net/                          # lockstep, transport (Trystero), lobby
│  ├─ render/                       # three.js scene, terrain, units, vfx, post
│  ├─ audio/                        # sound manager, positional, music, voices
│  ├─ ui/                           # menus, HUD, minimap, input → Commands
│  └─ ai/                           # skirmish AI: issues Commands like a player
└─ tests/                           # vitest: sim, determinism, net
```

**Key contract:** UI and AI only produce `Command`s. `net/` orders them into turns. `sim/` consumes the turns and emits `events`. `render/` and `audio/` read sim state + events. No module reaches into another's internals. This contract is what lets the parallel sessions work without stepping on each other.

---

## 7. Build plan & parallel sessions

### Phase 0 — Foundation (master session, sequential, ~1 session)
Needs to land **before** fan-out, because everyone builds on it:
- Repo scaffold (Vite + TS + three + Vitest + ESLint), Pages deploy workflow, `base` path config.
- `src/shared/` contracts (commands, entities, events) and the deterministic math lib.
- Minimal vertical slice: a flat map, one tank GLB that you can select and move with right-click, running through sim → render. This proves the architecture.
- `tools/build-assets.mjs` with a first pass over ~10 assets.
- `CONTRIBUTING.md` with ownership rules: which session owns which folders.

### Phase 1 — Parallel workstreams (each in its own worktree/branch → PR to `main`)
| # | Session | Owns | Delivers |
|---|---|---|---|
| A | **Simulation core** | `src/sim/`, `data/`, `tests/sim` | ECS world, movement + flow-field pathing, combat/damage/armor, economy, capture points, tickets, fog of war, production queues, determinism test |
| B | **Rendering & VFX** | `src/render/` | Terrain + splat + water, lighting/post stack, unit view layer (GLB loading, instancing, animation state machine driven by events, turret aiming), particles, decals, quality presets |
| C | **Networking** | `src/net/`, `tests/net` | Trystero transport, lobby/rooms, lockstep turn scheduler, desync hash check, reconnect, replay save/load |
| D | **UI / UX & input** | `src/ui/`, `index.html`, CSS | Main menu, lobby screen, HUD (resources, selection panel, build grid, minimap), selection/box-select/control groups, input→Command mapping, settings, credits |
| E | **Audio** | `src/audio/`, `public/assets/sounds` | Port `sfx.js`, positional mixing, weapon/explosion mapping per unit, voice responses, music states (menu/calm/battle), ambient bed |
| F | **Assets pipeline & content** | `tools/`, `public/assets/models`, `public/assets/textures` | Full optimization of the roster, scale normalization, camo/team-color material, missing buildings (kitbash), terrain textures/HDRI/foliage |

A–F don't overlap in files. Anything that must change `src/shared/` goes through the master session, which keeps the contracts stable.

### Phase 2 — Content & integration (after A–F merge)
| # | Session | Delivers |
|---|---|---|
| G | **Skirmish AI** (`src/ai/`) | Build orders, economy and attack waves, unit micro, 3 difficulties |
| H | **Maps** (`public/assets/maps/`, map loader) | The 3 launch maps, with props and points |
| I | **Balance & match pacing** (`data/`) | Headless AI-vs-AI sims to tune ticket drain so matches finish in 60–90 min |
| J | **Drawn frontlines** (sim + ui + render; master adds the `holdLine` contract first) | Select units, hold **F** and draw a polyline; units spread along it facing away from your side and hold. Role-aware placement: infantry seek cover, tanks slightly back, AT on flanks, artillery behind. Gaps fill when units die, reinforcements sent to the line fill the weakest spots, and "advance line" pushes the whole line forward. Lines show on map and minimap in team color, and teammates see them in shared command |
| — | **Master** | Integration, playtests, perf profiling, bug triage |

### Phase 3 — Polish
**Shared command (optional co-op mode):** 2+ players control one army with a shared base and economy, optionally split into roles (ground / air / navy / logistics). The sim's `canCommand` hook (Phase 1) makes this a lobby option, not a rewrite.

Tutorial mission, replays UI, achievements/stats screen, accessibility (colorblind team colors, rebindable keys), and mobile/tablet touch controls (stretch goal).

### Milestones
- **M0:** one tank moves on a flat map; the site is live on Pages.
- **M1:** two browsers connect by room code; both see the same tanks fight (lockstep works).
- **M2:** a full 1v1 on Valley Pass with economy, building and tickets is playable start to finish.
- **M3:** AI opponent, 3 maps, both factions, navy and air.
- **M4:** polish pass and the 1.0 release.

---

## 8. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Public signaling relays flaky / blocked | Pluggable transport: Trystero (Nostr → MQTT → BitTorrent trackers) with PeerJS fallback. Show a clear error with a retry |
| Strict NATs block P2P (~10% of users) | Use free public STUN servers. Optionally let users paste their own TURN creds later |
| Lockstep desyncs | Fixed-point sim, headless determinism tests in CI, a per-tick state hash with a debug dump on mismatch |
| Mixed asset styles look cheap | One shared camo PBR material, unified lighting/post, and drop the worst-fitting models |
| Download size | Meshopt + KTX2, lazy load per map/faction, a loading screen with progress |
| Matches drag on | Ticket bleed + sudden death at 90 min, both tunable through headless sims |

---

## 8b. Strategic depth (so it's not "biggest army A-moves")
**Phase 1 (sim workstream A, built into the core now):**
- **Ability system:** data-driven active abilities with cooldowns/costs and a `useAbility` command. Starter set: smoke (blocks LOS), deploy/entrench (infantry: +armor, no move), sprint/overdrive, artillery barrage on a spotted area, AT ambush (hidden until it fires).
- **Physical logistics:** supply is carried by **supply trucks** from depots/points to the HQ along roads. Trucks can be ambushed, and cutting a line starves production. Units far from supply slowly lose readiness (fire rate/morale).

**Phase 2:**
- **Map design goals** (maps workstream): every map has chokepoints, bridges, high ground, forests/cover, at least 2 alternate routes to each point, and points that are harder to hold than to take.
- **Smart AI** (AI workstream): scouts, counter-builds against what it has seen, flanks, raids supply lines and power, contests points instead of sending waves.
- **Anti-degenerate balance tests** (balance workstream): headless sims assert that no single-unit-type army beats a mixed army of equal cost, and that a side down 30% on tickets can still come back.
- **Pacing review:** tune sudden death, bleed acceleration and the pop-cap comeback mechanic against playtests so they don't reward turtling.

## 9. Decisions (2026-10-29)
1. **Repo:** https://github.com/jupixels/frontline, deployed to https://jupixels.github.io/frontline/
2. **Extra assets:** downloading free assets is approved. Prefer CC0, and record anything CC-BY in the credits.
3. **Factions:** v1 uses **one shared roster with team colors**. The two-faction split in §3 is post-v1.
4. **Players:** 1v1, 2v2 and **1v1v1v1 FFA** at launch. Design for **up to 8 players** (PlayerId 0–7, team ids separate from player ids, maps declare their spawn count, and lockstep must not assume 2 peers). With FFA, the Frontline ticket rule becomes: each player holding fewer points than the leader bleeds tickets.
5. **Name:** Frontline.
