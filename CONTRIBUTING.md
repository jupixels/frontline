# Contributing to Frontline

Several Claude Code sessions build this game in parallel. Each one works on its own branch and opens a PR into `main`. These rules keep them from colliding.

The full design is in [docs/GAME_PLAN.md](docs/GAME_PLAN.md).

## Folder ownership

| Folder | Owner (workstream) |
|---|---|
| `src/shared/` | **Master session only.** Propose changes in your PR description; don't edit it yourself unless your brief says so |
| `src/sim/`, `data/`, `tests/sim*` | A: Simulation |
| `src/render/` | B: Rendering & VFX |
| `src/net/`, `tests/net*` | C: Networking |
| `src/ui/`, `index.html` | D: UI / UX |
| `src/audio/`, `public/assets/sounds/` | E: Audio |
| `tools/`, `public/assets/models/`, `public/assets/textures/` | F: Asset pipeline |
| `src/ai/` | G: Skirmish AI (phase 2) |
| `src/game/`, `src/main.ts`, `.github/`, root config | Master session |

You may *read* anything. Write only inside your folders. If you need something from another workstream, code against the interface in `src/shared/` and leave a `// TODO(<workstream>):` note. If you need a new shared type, add it in your own folder first and list it in your PR under **Shared contract proposals**; the master session promotes it.

## The architecture contract

```
ui/ & ai/ ──Command──▶ net/ ──Turn──▶ sim/ ──SimEvent + SimView──▶ render/ & audio/ & ui/
```

- `ui/` and `ai/` only produce `Command`s (`src/shared/commands.ts`).
- `net/` orders commands into `Turn`s (`NetSession` in `src/net/session.ts`).
- `sim/` is the only place gameplay state changes. Others read it through `SimView` (`src/shared/entities.ts`) and `SimEvent`s.
- `render/` and `audio/` never change game state.

## Determinism rules for `src/sim/` (lockstep multiplayer depends on these)

- Use only `+ - * /`, `Math.sqrt/abs/floor/ceil/round/min/max/trunc/sign/imul`.
- For trig use `src/sim/math/dmath.ts` (`dsin`, `dcos`, `datan2`, `headingTo`, …).
- For randomness use `world.rng` (`src/sim/math/prng.ts`). Never `Math.random`.
- No `Date`, `performance.now`, `**`, DOM, three.js, or `async` in sim.
- Iterate entities in id order (`world.entities` is a Map with insertion = id order). Never iterate object keys whose order could differ.
- `tests/determinism.test.ts` enforces most of this. Keep it green.

## Conventions

- TypeScript strict mode, ES modules, 2-space indent, single quotes.
- Units: meters, seconds, radians. Heading 0 faces +Z; forward is `(sin h, cos h)`.
- Sim runs at 20 Hz (`SIM_HZ`). Rendering interpolates.
- Up to 8 players (`MAX_PLAYERS`). Never assume 2 players or 2 teams.
- Asset URLs go through `assetUrl()` so they work under `/frontline/` on Pages.

## Before opening a PR

```bash
npm run typecheck && npm test && npm run build
```

Keep PRs focused on your workstream. Describe what changed, how you verified it, and any shared-contract proposals.
