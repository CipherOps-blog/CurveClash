/** Shared tapered-beam geometry for previews, official hits, and rendering. */

export const BEAM_NEAR_RADIUS = 2;
export const BEAM_GROWTH_PER_PIXEL = 0.055;
export const BEAM_MAX_RADIUS = 54;

export function beamRadiusAtDistance(distance) {
  return Math.min(
    BEAM_MAX_RADIUS,
    BEAM_NEAR_RADIUS + Math.max(0, Number(distance) || 0) * BEAM_GROWTH_PER_PIXEL
  );
}

const BEAM_CROSS_SECTION_SPACING = 5;

/**
 * Precompute how far the beam actually lights up on each side of the
 * centerline, the way a widening flashlight beam would: obstacles that poke
 * into its cone block the light past them and cast a shadow, instead of the
 * translucent cone simply being drawn on top of the terrain regardless. This
 * mirrors buildCombatHitEvents' own lateralRayIsClear rule — a target hidden
 * behind an obstacle is exactly as unlit here as it is unhittable there — so
 * the rendered glow always matches what the beam can actually reach.
 *
 * Returns one array of cross-sections per path, each carrying the point,
 * its distance from the shooter, and the lit extent to each side. The result
 * is meant to be computed once per shot and cached: obstacles that appear
 * later (this shot's own craters, or a later shooter's) must not reshape a
 * beam that already fired.
 */
export function buildBeamEnvelope(paths, terrain, options = {}) {
  const spacing = Math.max(2, Number(options.crossSectionSpacing) || BEAM_CROSS_SECTION_SPACING);
  return (paths ?? []).map((path) => buildPathEnvelope(path, terrain, spacing));
}

function buildPathEnvelope(path, terrain, spacing) {
  if (!Array.isArray(path) || path.length < 2) return [];
  const marks = collectDistanceMarks(path, spacing);
  return marks.map(({ point, distance, nx, ny }) => {
    const radius = beamRadiusAtDistance(distance);
    return {
      point,
      distance,
      topExtent: castLateralExtent(terrain, point, nx, ny, radius),
      bottomExtent: castLateralExtent(terrain, point, -nx, -ny, radius)
    };
  });
}

/**
 * Walk the traced polyline and place evenly spaced cross-sections, each
 * carrying its point, its distance from the shooter, and the local outward
 * normal the beam widens along there. Spacing is independent of the path's
 * own (potentially very fine) sampling resolution, which keeps the terrain
 * sampling below bounded regardless of collision step.
 */
function collectDistanceMarks(path, spacing) {
  const marks = [{ point: path[0], distance: 0, ...segmentNormal(path[0], path[1]) }];
  let traveled = 0;
  let nextMark = spacing;
  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (!(segmentLength > 1e-9)) continue;
    const normal = segmentNormal(start, end);
    while (nextMark <= traveled + segmentLength) {
      const amount = (nextMark - traveled) / segmentLength;
      marks.push({
        point: { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount },
        distance: nextMark,
        ...normal
      });
      nextMark += spacing;
    }
    traveled += segmentLength;
  }
  const last = path[path.length - 1];
  const lastMark = marks[marks.length - 1];
  if (!lastMark || squaredDistance(lastMark.point, last) > 1) {
    const previousPoint = path[path.length - 2] ?? last;
    marks.push({ point: last, distance: traveled, ...segmentNormal(previousPoint, last) });
  }
  return marks;
}

function segmentNormal(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-9)) return { nx: 0, ny: 0 };
  return { nx: -dy / length, ny: dx / length };
}

/** How far light reaches from `origin` along (nx, ny) before solid terrain
 * blocks it, capped at maxDistance. Everything past that point is shadow. */
function castLateralExtent(terrain, origin, nx, ny, maxDistance) {
  if (!terrain || !hasCollisionMethod(terrain) || !(maxDistance > 0) || (!nx && !ny)) {
    return Math.max(0, maxDistance);
  }
  const terrainStep = Number(terrain.cellSize ?? terrain.resolution ?? 4);
  const step = clamp(terrainStep * 0.5, 1, 3);
  const samples = Math.max(1, Math.ceil(maxDistance / step));
  for (let index = 1; index <= samples; index += 1) {
    const distance = Math.min(maxDistance, step * index);
    const x = origin.x + nx * distance;
    const y = origin.y + ny * distance;
    if (isTerrainBlocked(terrain, x, y)) return Math.max(0, distance - step);
  }
  return maxDistance;
}

function squaredDistance(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * Return one earliest contact per target. The normal curve remains the
 * obstacle-clipped centerline; a beam only expands hit testing laterally.
 */
export function buildCombatHitEvents({
  paths = [],
  shooter,
  players = [],
  terrain = null,
  beam = false,
  defaultHitRadius = 26
} = {}) {
  const events = [];
  for (const target of players) {
    if (!target || target.alive === false || target.id === shooter?.id) continue;
    const targetPoint = target.position ?? target;
    if (!isFinitePoint(targetPoint)) continue;
    const hitRadius = Math.max(0, Number(target.hitRadius ?? target.radius ?? defaultHitRadius));
    let earliest = null;

    for (let branchIndex = 0; branchIndex < paths.length; branchIndex += 1) {
      const path = paths[branchIndex];
      if (!Array.isArray(path) || path.length < 2) continue;
      let traveled = 0;
      for (let pathIndex = 0; pathIndex < path.length - 1; pathIndex += 1) {
        const start = path[pathIndex];
        const end = path[pathIndex + 1];
        const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
        if (!(segmentLength > 1e-9)) continue;
        const projection = projectPointToSegment(targetPoint, start, end);
        const distanceAlongPath = traveled + segmentLength * projection.amount;
        const beamRadius = beam ? beamRadiusAtDistance(distanceAlongPath) : 0;
        const contactRadius = hitRadius + beamRadius;
        if (projection.distanceSquared <= contactRadius ** 2) {
          const regularContact = projection.distanceSquared <= hitRadius ** 2;
          const visible = regularContact || !beam || lateralRayIsClear(
            projection.point,
            targetPoint,
            hitRadius,
            terrain
          );
          if (visible) {
            const progress = (pathIndex + projection.amount) / (path.length - 1);
            if (!earliest || progress < earliest.progress) {
              earliest = {
                playerId: target.id,
                point: projection.point,
                branchIndex,
                pathIndex,
                segmentAmount: projection.amount,
                progress,
                beamRadius,
                beamContact: beam && !regularContact,
                handled: false
              };
            }
          }
        }
        traveled += segmentLength;
      }
    }
    if (earliest) events.push(earliest);
  }
  return events.sort((first, second) => first.progress - second.progress);
}

function lateralRayIsClear(start, target, targetRadius, terrain) {
  if (!terrain || !hasCollisionMethod(terrain)) return true;
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > targetRadius + 1e-9)) return true;
  const visibleLength = Math.max(0, distance - targetRadius);
  const terrainStep = Number(terrain.cellSize ?? terrain.resolution ?? 4);
  const step = clamp(terrainStep * 0.4, 0.8, 2);
  const samples = Math.max(1, Math.ceil(visibleLength / step));
  for (let index = 1; index <= samples; index += 1) {
    const traveled = visibleLength * index / samples;
    const amount = traveled / distance;
    const x = start.x + dx * amount;
    const y = start.y + dy * amount;
    if (isTerrainBlocked(terrain, x, y)) return false;
  }
  return true;
}

function projectPointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared > 0
    ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
    : 0;
  const projected = { x: start.x + dx * amount, y: start.y + dy * amount };
  return {
    amount,
    point: projected,
    distanceSquared: (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2
  };
}

function hasCollisionMethod(terrain) {
  return typeof terrain?.isBlocked === "function" || typeof terrain?.isSolid === "function";
}

function isTerrainBlocked(terrain, x, y) {
  if (typeof terrain?.isBlocked === "function") return Boolean(terrain.isBlocked(x, y));
  if (typeof terrain?.isSolid === "function") return Boolean(terrain.isSolid(x, y));
  return false;
}

function isFinitePoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
