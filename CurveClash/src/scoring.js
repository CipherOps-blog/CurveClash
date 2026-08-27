/**
 * Score and ranking helpers for Curve Clash.
 *
 * A kill is worth the straight-line distance between both players, with every
 * part of that segment lying inside terrain counted a second time. For a
 * multi-kill, increasingly valuable kills receive increasingly large integer
 * multipliers after sorting by their base value.
 */

const EPSILON = 1e-9;

export function measureKillValue(shooter, target, terrain = null) {
  const origin = resolvePoint(shooter, "shooter");
  const destination = resolvePoint(target, "target");
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const straightDistance = Math.hypot(dx, dy);
  if (!(straightDistance > EPSILON)) {
    return { straightDistance: 0, obstacleDistance: 0, value: 0 };
  }

  const cellSize = Number(terrain?.cellSize ?? terrain?.resolution);
  const obstacleDistance = Number.isFinite(cellSize) && cellSize > 0
    ? exactBlockedSegmentLength(origin, destination, terrain, cellSize, straightDistance)
    : sampledBlockedSegmentLength(origin, destination, terrain, straightDistance);

  return {
    straightDistance,
    obstacleDistance,
    value: straightDistance + obstacleDistance
  };
}

export function scoreMultiKill({ shooter, targets = [], terrain = null } = {}) {
  const seen = new Set();
  const measured = [];
  for (const target of targets) {
    if (!target) continue;
    const identity = target.id ?? target;
    if (seen.has(identity)) continue;
    seen.add(identity);
    measured.push({
      target,
      targetId: target.id ?? null,
      ...measureKillValue(shooter, target, terrain)
    });
  }

  measured.sort((first, second) => {
    if (Math.abs(first.value - second.value) > EPSILON) return first.value - second.value;
    if (Math.abs(first.straightDistance - second.straightDistance) > EPSILON) {
      return first.straightDistance - second.straightDistance;
    }
    return String(first.targetId ?? first.target?.name ?? "")
      .localeCompare(String(second.targetId ?? second.target?.name ?? ""));
  });

  const awards = measured.map((entry, index) => {
    const multiplier = index + 1;
    const pointUnits = Math.round(entry.value * multiplier * 100);
    return {
      ...entry,
      multiplier,
      pointUnits,
      points: pointUnits / 100
    };
  });
  const totalPointUnits = awards.reduce((sum, award) => sum + award.pointUnits, 0);
  return {
    awards,
    totalPointUnits,
    totalPoints: totalPointUnits / 100
  };
}

/** Score, kills, survival, then the fixed draw provide stable tie-breakers. */
export function rankPlayers(players = [], turnOrder = []) {
  const turnIndexes = new Map(turnOrder.map((playerId, index) => [playerId, index]));
  return [...players]
    .sort((first, second) => {
      const scoreDifference = playerScoreUnits(second) - playerScoreUnits(first);
      if (scoreDifference) return scoreDifference;
      const killDifference = finiteScore(second.kills) - finiteScore(first.kills);
      if (killDifference) return killDifference;
      if (Boolean(first.alive) !== Boolean(second.alive)) return first.alive ? -1 : 1;
      const firstTurn = turnIndexes.get(first.id) ?? Number.MAX_SAFE_INTEGER;
      const secondTurn = turnIndexes.get(second.id) ?? Number.MAX_SAFE_INTEGER;
      if (firstTurn !== secondTurn) return firstTurn - secondTurn;
      return String(first.name ?? first.id ?? "").localeCompare(String(second.name ?? second.id ?? ""));
    })
    .map((player, index) => ({ player, rank: index + 1 }));
}

function exactBlockedSegmentLength(origin, target, terrain, cellSize, totalDistance) {
  if (!terrain || !hasCollisionMethod(terrain)) return 0;
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const crossings = [0, 1];
  addAxisCrossings(crossings, origin.x, target.x, dx, cellSize);
  addAxisCrossings(crossings, origin.y, target.y, dy, cellSize);
  crossings.sort((first, second) => first - second);

  let blockedDistance = 0;
  let previous = crossings[0];
  for (let index = 1; index < crossings.length; index += 1) {
    const current = crossings[index];
    if (current - previous <= EPSILON) continue;
    const midpoint = (previous + current) / 2;
    const x = origin.x + dx * midpoint;
    const y = origin.y + dy * midpoint;
    if (isTerrainBlocked(terrain, x, y)) blockedDistance += (current - previous) * totalDistance;
    previous = current;
  }
  return blockedDistance;
}

function addAxisCrossings(output, start, end, delta, cellSize) {
  if (Math.abs(delta) <= EPSILON) return;
  const minimum = Math.min(start, end);
  const maximum = Math.max(start, end);
  const firstGridIndex = Math.floor(minimum / cellSize) + 1;
  const lastGridIndex = Math.ceil(maximum / cellSize) - 1;
  for (let gridIndex = firstGridIndex; gridIndex <= lastGridIndex; gridIndex += 1) {
    const coordinate = gridIndex * cellSize;
    const progress = (coordinate - start) / delta;
    if (progress > EPSILON && progress < 1 - EPSILON) output.push(progress);
  }
}

function sampledBlockedSegmentLength(origin, target, terrain, totalDistance) {
  if (!terrain || !hasCollisionMethod(terrain)) return 0;
  const samples = Math.max(1, Math.ceil(totalDistance));
  const stepLength = totalDistance / samples;
  let blockedDistance = 0;
  for (let index = 0; index < samples; index += 1) {
    const progress = (index + 0.5) / samples;
    const x = origin.x + (target.x - origin.x) * progress;
    const y = origin.y + (target.y - origin.y) * progress;
    if (isTerrainBlocked(terrain, x, y)) blockedDistance += stepLength;
  }
  return blockedDistance;
}

function hasCollisionMethod(terrain) {
  return typeof terrain?.isBlocked === "function" || typeof terrain?.isSolid === "function";
}

function isTerrainBlocked(terrain, x, y) {
  if (typeof terrain?.isBlocked === "function") return Boolean(terrain.isBlocked(x, y));
  if (typeof terrain?.isSolid === "function") return Boolean(terrain.isSolid(x, y));
  return false;
}

function resolvePoint(value, label) {
  const point = value?.position ?? value;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError(`${label} must contain finite x and y coordinates.`);
  }
  return point;
}

function finiteScore(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function playerScoreUnits(player) {
  if (Number.isFinite(Number(player?.scoreUnits))) return Number(player.scoreUnits);
  return Math.round(finiteScore(player?.score) * 100);
}
