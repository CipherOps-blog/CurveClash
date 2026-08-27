/**
 * DOM-free buried power-up placement helpers.
 *
 * Power-ups begin inside solid terrain. A placement is considered safely
 * buried only when a complete solid disk surrounds its center, so an impact at
 * the obstacle surface cannot uncover it in one maximum-size crater.
 */

export const POWERUP_TYPES = Object.freeze(["shield", "beam"]);
export const MAX_CRATER_RADIUS = 19;
export const DEFAULT_BURIAL_RADIUS = 24;

/**
 * Place exactly one shield and one beam. Existing deep obstacle interiors are
 * preferred. When fewer than two suitably separated points exist, dedicated
 * rounded obstacle vaults are added away from every player.
 */
export function placeBuriedPowerUps({
  field,
  bounds = null,
  players = [],
  random = Math.random,
  maxCraterRadius = MAX_CRATER_RADIUS,
  burialRadius = null,
  minimumSeparation = null,
  playerAvoidance = null,
  candidateLimit = 520
} = {}) {
  if (!field) throw new TypeError("A terrain field is required to bury power-ups.");
  const area = normalizeBounds(bounds, field);
  const cellSize = terrainCellSize(field);
  const safeBurialRadius = Math.max(
    Number(maxCraterRadius) + cellSize * 1.15,
    Number(burialRadius ?? DEFAULT_BURIAL_RADIUS)
  );
  const separation = Number(minimumSeparation ?? Math.max(
    safeBurialRadius * 4.5,
    Math.min(area.width, area.height) * 0.27
  ));
  const avoidPlayersBy = Number(playerAvoidance ?? Math.max(88, safeBurialRadius * 3.6));
  const existing = collectBuriedCandidates({
    field,
    bounds: area,
    players,
    burialRadius: safeBurialRadius,
    playerAvoidance: avoidPlayersBy,
    random,
    limit: candidateLimit
  });

  let pair = chooseDistantPair(existing, existing, separation, random, true);
  let vaultCount = 0;
  if (!pair) {
    const vaultCandidates = collectVaultCandidates({
      bounds: area,
      players,
      burialRadius: safeBurialRadius,
      playerAvoidance: avoidPlayersBy,
      random,
      limit: candidateLimit
    });
    pair = chooseDistantPair(existing, vaultCandidates, separation, random, false);
    if (!pair) pair = chooseDistantPair(vaultCandidates, vaultCandidates, separation, random, true);
    if (!pair) {
      throw new Error("The map has no two safe, distant positions for buried power-ups.");
    }

    const revisionBefore = Number(field.revision ?? 0);
    for (const candidate of pair) {
      if (candidate.source !== "vault") continue;
      createObstacleVault(field, candidate, safeBurialRadius, cellSize);
      vaultCount += 1;
    }
    if (vaultCount > 0) finalizeTerrainMutation(field, revisionBefore);
  }

  if (!pair || pair.length !== 2) {
    throw new Error("Power-up placement did not produce exactly two positions.");
  }
  for (const candidate of pair) {
    if (!isDeeplyBuried(field, candidate, safeBurialRadius, area)) {
      throw new Error("A power-up vault could not provide the required burial depth.");
    }
  }

  // Randomize which distant location receives which ability without changing
  // the invariant that exactly one instance of each type exists.
  const positions = random() < 0.5 ? pair : [pair[1], pair[0]];
  return POWERUP_TYPES.map((type, index) => {
    const point = positions[index];
    return {
      id: `powerup-${type}`,
      type,
      kind: type,
      x: point.x,
      y: point.y,
      position: { x: point.x, y: point.y },
      burialRadius: safeBurialRadius,
      source: point.source,
      vaultCreated: point.source === "vault",
      exposed: false,
      collected: false
    };
  });
}

/** True when every terrain cell intersecting the burial disk is solid. */
export function isDeeplyBuried(field, point, radius = DEFAULT_BURIAL_RADIUS, bounds = null) {
  if (!field || !isFinitePoint(point) || !(Number(radius) > 0)) return false;
  const area = normalizeBounds(bounds, field);
  const safeRadius = Number(radius);
  if (
    point.x - safeRadius < area.x || point.x + safeRadius > area.right
    || point.y - safeRadius < area.y || point.y + safeRadius > area.bottom
  ) return false;

  const cellSize = terrainCellSize(field);
  if (typeof field.isCellSolid === "function" && Number.isFinite(field.columns) && Number.isFinite(field.rows)) {
    const left = Math.floor((point.x - safeRadius) / cellSize);
    const right = Math.floor((point.x + safeRadius) / cellSize);
    const top = Math.floor((point.y - safeRadius) / cellSize);
    const bottom = Math.floor((point.y + safeRadius) / cellSize);
    const radiusSquared = safeRadius ** 2;
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const cellLeft = column * cellSize;
        const cellTop = row * cellSize;
        const nearestX = clamp(point.x, cellLeft, cellLeft + cellSize);
        const nearestY = clamp(point.y, cellTop, cellTop + cellSize);
        if ((nearestX - point.x) ** 2 + (nearestY - point.y) ** 2 > radiusSquared) continue;
        if (!field.isCellSolid(column, row)) return false;
      }
    }
    return true;
  }

  const step = clamp(cellSize * 0.45, 1, 2.5);
  const sampleRadius = safeRadius + step * 0.75;
  const radiusSquared = sampleRadius ** 2;
  for (let y = -sampleRadius; y <= sampleRadius + 1e-6; y += step) {
    for (let x = -sampleRadius; x <= sampleRadius + 1e-6; x += step) {
      if (x * x + y * y > radiusSquared) continue;
      if (!isTerrainSolid(field, point.x + x, point.y + y)) return false;
    }
  }
  return true;
}

/** A power-up becomes exposed once its center cell is no longer solid. */
export function isPowerUpExposed(powerUp, field) {
  const center = powerUp?.position ?? powerUp;
  return isFinitePoint(center) && !isTerrainSolid(field, center.x, center.y);
}

/** Mark and return only power-ups that became exposed during this check. */
export function updatePowerUpExposure(powerUps, field) {
  const newlyExposed = [];
  for (const powerUp of powerUps ?? []) {
    if (!powerUp || powerUp.collected || powerUp.exposed) continue;
    if (!isPowerUpExposed(powerUp, field)) continue;
    powerUp.exposed = true;
    newlyExposed.push(powerUp);
  }
  return newlyExposed;
}

/** True when an impact crater reaches (or nearly reaches) a power-up center. */
export function isImpactNearPowerUp(
  impact,
  powerUp,
  craterRadius = MAX_CRATER_RADIUS,
  padding = 0
) {
  const impactPoint = impact?.point ?? impact;
  const center = powerUp?.position ?? powerUp;
  if (!isFinitePoint(impactPoint) || !isFinitePoint(center)) return false;
  const reach = Math.max(0, Number(craterRadius) || 0) + Math.max(0, Number(padding) || 0);
  return squaredDistance(impactPoint, center) <= reach ** 2;
}

/** Return every uncollected power-up within reach of an impact crater. */
export function findPowerUpsNearImpact(
  powerUps,
  impact,
  craterRadius = MAX_CRATER_RADIUS,
  padding = 0
) {
  return (powerUps ?? []).filter((powerUp) => (
    powerUp && !powerUp.collected
    && isImpactNearPowerUp(impact, powerUp, craterRadius, padding)
  ));
}

function collectBuriedCandidates({
  field,
  bounds,
  players,
  burialRadius,
  playerAvoidance,
  random,
  limit
}) {
  const cellSize = terrainCellSize(field);
  const step = clamp(cellSize * 2, 6, 10);
  const candidates = [];
  let validSeen = 0;
  const offsetX = random() * step;
  const offsetY = random() * step;
  for (let y = bounds.y + burialRadius + offsetY; y <= bounds.bottom - burialRadius; y += step) {
    for (let x = bounds.x + burialRadius + offsetX; x <= bounds.right - burialRadius; x += step) {
      const point = { x, y, source: "existing" };
      if (!isTerrainSolid(field, x, y)) continue;
      if (!isAwayFromPlayers(point, players, playerAvoidance)) continue;
      if (!isDeeplyBuried(field, point, burialRadius, bounds)) continue;
      validSeen += 1;
      reservoirAdd(candidates, point, validSeen, limit, random);
    }
  }
  return candidates;
}

function collectVaultCandidates({
  bounds,
  players,
  burialRadius,
  playerAvoidance,
  random,
  limit
}) {
  const padding = Math.max(12, burialRadius * 0.48);
  const halfSize = burialRadius + padding;
  const candidates = [];
  let validSeen = 0;
  const consider = (x, y) => {
    const point = { x, y, source: "vault" };
    if (
      x - halfSize < bounds.x || x + halfSize > bounds.right
      || y - halfSize < bounds.y || y + halfSize > bounds.bottom
    ) return;
    if (!isAwayFromPlayers(point, players, playerAvoidance + halfSize * 0.65)) return;
    validSeen += 1;
    reservoirAdd(candidates, point, validSeen, limit, random);
  };

  // Random attempts keep vault positions from looking grid-aligned.
  for (let attempt = 0; attempt < 260; attempt += 1) {
    consider(
      bounds.x + halfSize + random() * Math.max(1, bounds.width - halfSize * 2),
      bounds.y + halfSize + random() * Math.max(1, bounds.height - halfSize * 2)
    );
  }
  // Deterministic coverage guarantees a fallback whenever the map geometry
  // actually contains two safe locations.
  const step = Math.max(34, halfSize * 0.9);
  for (let y = bounds.y + halfSize; y <= bounds.bottom - halfSize; y += step) {
    for (let x = bounds.x + halfSize; x <= bounds.right - halfSize; x += step) consider(x, y);
  }
  return candidates;
}

function chooseDistantPair(firstPool, secondPool, minimumSeparation, random, samePool) {
  if (!firstPool.length || !secondPool.length) return null;
  const minimumSquared = minimumSeparation ** 2;
  let best = null;
  for (let firstIndex = 0; firstIndex < firstPool.length; firstIndex += 1) {
    const secondStart = samePool ? firstIndex + 1 : 0;
    for (let secondIndex = secondStart; secondIndex < secondPool.length; secondIndex += 1) {
      const first = firstPool[firstIndex];
      const second = secondPool[secondIndex];
      if (first === second) continue;
      const distanceSquared = squaredDistance(first, second);
      if (distanceSquared < minimumSquared) continue;
      const score = distanceSquared * (0.94 + random() * 0.12);
      if (!best || score > best.score) best = { pair: [first, second], score };
    }
  }
  return best?.pair ?? null;
}

function createObstacleVault(field, center, burialRadius, cellSize) {
  const padding = Math.max(12, cellSize * 3);
  const halfSize = burialRadius + padding;
  const size = halfSize * 2;
  if (typeof field.fillRoundedRect === "function") {
    field.fillRoundedRect(
      center.x - halfSize,
      center.y - halfSize,
      size,
      size,
      Math.min(15, padding)
    );
    return;
  }
  if (typeof field.fillEllipse === "function") {
    field.fillEllipse(center.x, center.y, halfSize, halfSize);
    return;
  }
  throw new TypeError("The terrain field cannot create a dedicated obstacle vault.");
}

function finalizeTerrainMutation(field, revisionBefore) {
  const current = Number(field.revision ?? revisionBefore);
  if (!(current > revisionBefore)) field.revision = revisionBefore + 1;
  if (typeof field.rebuildVisual === "function") field.rebuildVisual(Boolean(field.dark));
}

function reservoirAdd(items, value, seenCount, limit, random) {
  if (items.length < limit) {
    items.push(value);
    return;
  }
  const replacement = Math.floor(random() * seenCount);
  if (replacement < limit) items[replacement] = value;
}

function isAwayFromPlayers(point, players, minimumDistance) {
  for (const player of players ?? []) {
    if (!player || player.alive === false) continue;
    const center = player.position ?? player;
    if (!isFinitePoint(center)) continue;
    const radius = Math.max(0, Number(player.hitRadius ?? player.radius ?? 26));
    if (Math.sqrt(squaredDistance(point, center)) < minimumDistance + radius) return false;
  }
  return true;
}

function isTerrainSolid(field, x, y) {
  if (!field || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (typeof field.isSolid === "function") return Boolean(field.isSolid(x, y));
  if (typeof field.isBlocked === "function") return Boolean(field.isBlocked(x, y));
  const cellSize = terrainCellSize(field);
  if (typeof field.isCellSolid === "function") {
    return Boolean(field.isCellSolid(Math.floor(x / cellSize), Math.floor(y / cellSize)));
  }
  return false;
}

function terrainCellSize(field) {
  return clamp(Number(field?.cellSize ?? field?.resolution ?? 4) || 4, 1, 32);
}

function normalizeBounds(bounds, field) {
  const x = Number(bounds?.x ?? 0);
  const y = Number(bounds?.y ?? 0);
  const width = Number(bounds?.width ?? field?.width ?? 0);
  const height = Number(bounds?.height ?? field?.height ?? 0);
  if (!(width > 0 && height > 0)) throw new TypeError("Power-up bounds must have positive dimensions.");
  return { x, y, width, height, right: x + width, bottom: y + height };
}

function isFinitePoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function squaredDistance(first, second) {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
