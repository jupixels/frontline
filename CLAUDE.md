# Frontline

Browser RTS (three.js + TypeScript + Vite), deployed to GitHub Pages at https://jupixels.github.io/frontline/. Multiplayer is P2P WebRTC with deterministic lockstep.

- Design: `docs/GAME_PLAN.md`. Ownership and determinism rules: `CONTRIBUTING.md`. Read both before changing code.
- Write only in the folders your workstream owns. `src/shared/` is master-session-only.
- `src/sim/` must stay deterministic: no `Math.sin/cos/atan2/pow/random`, no `Date`, no `**`. Use `src/sim/math/`.
- Verify with `npm run typecheck && npm test && npm run build`. Use the `frontline-dev` preview (`.claude/launch.json`) to see it running.
- Raw asset zips are not in the repo. `npm run assets -- --src <dir>` rebuilds `public/assets/` from them (see `tools/README.md`).
