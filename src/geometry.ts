import { BoundingBox } from "@owlbear-rodeo/sdk";

/**
 * Shared layout so the static shapes (scene items) and the animated effects
 * (local items) line up exactly.
 */

export function barRect(bounds: BoundingBox, dpi: number) {
  const width = bounds.width * 0.8;
  const height = Math.max(dpi * 0.12, 6);
  return {
    x: bounds.center.x - width / 2,
    y: bounds.max.y - height - dpi * 0.05,
    width,
    height,
    /** Matches the 12% border in BAR_SKSL. */
    border: Math.max(height * 0.12, 1),
  };
}

/** Square the ring effect draws into; the ring itself sits at 86% of it. */
export function ringBox(bounds: BoundingBox) {
  const size = bounds.width * 1.25;
  return { x: bounds.center.x - size / 2, y: bounds.center.y - size / 2, size, ringDiameter: size * 0.86 };
}
