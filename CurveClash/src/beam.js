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
