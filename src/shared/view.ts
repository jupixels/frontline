import type { EntityId, Vec2 } from './types';

/** Screen-space queries the renderer provides to input handling (ui/). Coordinates are CSS pixels. */
export interface Picker {
  /** Ground point under the cursor, or null if off the map / sky. */
  pickGround(sx: number, sy: number): Vec2 | null;
  /** Topmost entity under the cursor. */
  pickEntity(sx: number, sy: number): EntityId | null;
  /** Entities whose on-screen position falls inside the rectangle. */
  entitiesInRect(x0: number, y0: number, x1: number, y1: number): EntityId[];
}

/** Resolve a path under public/assets/ to a URL that works in dev and on GitHub Pages. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}
