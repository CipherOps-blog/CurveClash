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
 * A cross-section only constrains the shadow once the cone is wider than one
 * terrain cell. Closer to the muzzle the beam is thinner than the grid it is
 * sampled against, so an apparent graze there is a sampling artefact rather
 * than a real occlusion — and the centerline is obstacle-clipped already.
 */
const MIN_SHADOWING_RADIUS = 4;

/**
 * Precompute how far the beam actually lights up on each side of the
 * centerline, the way a widening flashlight beam would: obstacles that poke
 * into its cone block the light past them and cast a shadow, instead of the
 * translucent cone simply being drawn on top of the terrain regardless.
 *
 * Light travels *forward*, so occlusion has to be remembered rather than
 * re-tested independently at every cross-section. Each ray of the cone keeps a
 * constant fraction of the widening radius, so a fraction that is blocked once
 * stays dark for the whole rest of the path: the lit width is the local radius
 * times a running minimum that only ever shrinks. That is what puts a real
 * shadow behind an obstacle instead of letting the cone light up again the
 * moment the centerline clears the wall, and being monotone it also keeps the
 * lit edge continuous rather than punching holes into the beam.
 *
 * Returns `{ paths, contacts }`. `paths` holds one array of cross-sections per
 * path, each carrying the point, its distance from the shooter, the local
 * normal, and the lit extent to each side. `contacts` holds every point where
 * the still-lit edge of the beam ends on solid terrain — the surface the shot
 * burns. The result is meant to be computed once per shot and reused:
 * obstacles that appear later (this shot's own craters, or a later shooter's)
 * must not reshape a beam that already fired.
 */
export function buildBeamEnvelope(paths, terrain, options = {}) {
  const spacing = Math.max(2, Number(options.crossSectionSpacing) || BEAM_CROSS_SECTION_SPACING);
  const contacts = [];
  return {
    paths: (paths ?? []).map((path) => buildPathEnvelope(path, terrain, spacing, contacts)),
    contacts
  };
}

function buildPathEnvelope(path, terrain, spacing, contacts) {
  if (!Array.isArray(path) || path.length < 2) return [];
  // Surviving fraction of the cone on each side of the centerline. Both start
  // fully lit and are only ever reduced, never restored.
  let topLit = 1;
  let bottomLit = 1;
  const sections = [];

  for (const { point, distance, nx, ny } of collectDistanceMarks(path, spacing)) {
    const radius = beamRadiusAtDistance(distance);
    if (radius >= MIN_SHADOWING_RADIUS) {
      topLit = admitReach(castLateralExtent(terrain, point, nx, ny, radius), radius, topLit, contacts);
      bottomLit = admitReach(castLateralExtent(terrain, point, -nx, -ny, radius), radius, bottomLit, contacts);
    }
    sections.push({
      point,
      distance,
      nx,
      ny,
      topExtent: radius * topLit,
      bottomExtent: radius * bottomLit
    });
  }
  return sections;
}

/**
 * Fold one cross-section's lateral reach into the running lit fraction for
 * that side, and record the burn where the lit edge lands on terrain. A
 * surface only burns while light still reaches it: if the shadow edge already
 * sits closer in than this obstruction, the beam is dark here and the wall is
 * merely being passed behind, not lit.
 */
function admitReach(reach, radius, litFraction, contacts) {
  const fraction = reach.extent / radius;
  if (fraction > litFraction) return litFraction;
  if (reach.contact) contacts.push(reach.contact);
  return fraction;
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

/**
 * How far light reaches from `origin` along (nx, ny) before solid terrain
 * blocks it, capped at maxDistance. Everything past that point is shadow.
 * `contact` is the blocking sample itself — the lit face of the obstruction —
 * and is null when the cone reaches its full width unobstructed.
 */
function castLateralExtent(terrain, origin, nx, ny, maxDistance) {
  if (!terrain || !hasCollisionMethod(terrain) || !(maxDistance > 0) || (!nx && !ny)) {
    return { extent: Math.max(0, maxDistance), contact: null };
  }
  const terrainStep = Number(terrain.cellSize ?? terrain.resolution ?? 4);
  const step = clamp(terrainStep * 0.5, 1, 3);
  const samples = Math.max(1, Math.ceil(maxDistance / step));
  let lastClear = 0;
  for (let index = 1; index <= samples; index += 1) {
    const distance = Math.min(maxDistance, step * index);
    const x = origin.x + nx * distance;
    const y = origin.y + ny * distance;
    if (isTerrainBlocked(terrain, x, y)) {
      // Falling back to the previous sample would throw away a whole step of
      // clearance. That matters most exactly where it is cheapest to be wrong
      // about: a beam grazing a wall would read as fully blocked, and since
      // the shadow is remembered, that one rounding would kill the rest of
      // the beam. Bisect instead, so a graze costs only what it really blocks.
      const contact = refineLateralContact(terrain, origin, nx, ny, lastClear, distance);
      return { extent: contact.extent, contact: contact.point };
    }
    lastClear = distance;
  }
  return { extent: maxDistance, contact: null };
}

/** Narrow a clear/blocked bracket down to sub-pixel precision, returning the
 * last lit distance and the first solid point beyond it. */
function refineLateralContact(terrain, origin, nx, ny, clearDistance, blockedDistance) {
  let clear = clearDistance;
  let blocked = blockedDistance;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const middle = (clear + blocked) / 2;
    if (isTerrainBlocked(terrain, origin.x + nx * middle, origin.y + ny * middle)) blocked = middle;
    else clear = middle;
  }
  return {
    extent: Math.max(0, clear),
    point: { x: origin.x + nx * blocked, y: origin.y + ny * blocked }
  };
}

function squaredDistance(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/**
 * Return one earliest contact per target. The normal curve remains the
 * obstacle-clipped centerline; a beam only expands hit testing laterally.
 *
 * Pass the shot's `envelope` to hold the beam's reach to exactly the width it
 * is drawn lit. Without it a target could be killed from inside the shadow of
 * a wall the cone passed earlier, because the straight centerline-to-target
 * ray below is clear there even though no light ever reaches that far out.
 */
export function buildCombatHitEvents({
  paths = [],
  shooter,
  players = [],
  terrain = null,
  beam = false,
  envelope = null,
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
          const visible = regularContact || !beam || (
            lateralRayIsClear(projection.point, targetPoint, hitRadius, terrain)
            && beamLightsTarget(envelope, branchIndex, distanceAlongPath, {
              start,
              end,
              projected: projection.point,
              target: targetPoint,
              hitRadius
            })
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

/**
 * Does the lit part of the cone actually reach this target? Answered against
 * the same cross-sections the beam is drawn from, so a target is killable
 * exactly while some of the glow covers it. Without an envelope the caller
 * gets the unrestricted cone, which is what candidate bot plans want.
 */
function beamLightsTarget(envelope, branchIndex, distanceAlongPath, contact) {
  const marks = envelope?.paths?.[branchIndex];
  if (!marks?.length) return true;
  const { start, end, projected, target, hitRadius } = contact;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (!(length > 1e-9)) return true;

  let nearest = marks[0];
  for (const mark of marks) {
    if (Math.abs(mark.distance - distanceAlongPath) < Math.abs(nearest.distance - distanceAlongPath)) {
      nearest = mark;
    }
  }
  // Signed lateral offset of the target, on the same normal the envelope's
  // two extents are measured along.
  const offset = ((target.x - projected.x) * -(end.y - start.y)
    + (target.y - projected.y) * (end.x - start.x)) / length;
  const litExtent = offset >= 0 ? nearest.topExtent : nearest.bottomExtent;
  return litExtent >= Math.abs(offset) - hitRadius;
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
