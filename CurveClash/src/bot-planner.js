/**
 * Terrain-aware function planner for bots.
 *
 * A legal shot is a graph y=f(x), so a route toward one side of the shooter
 * must be monotone in world x. This module searches that graph-shaped space,
 * simplifies the resulting route, and turns it into parser-safe equations.
 * It deliberately has no DOM, math.js, or game-state dependency.
 */

const SQRT_TWO = Math.SQRT2;
const clearanceCache = new WeakMap();

export function planTerrainRoutes({
  origin,
  target,
  bounds,
  terrain,
  targetRadius = 26,
  maxRoutes = 5,
  maxRoutePoints = 15
}) {
  if (!isFinitePoint(origin) || !isFinitePoint(target)) return [];
  const area = normalizeBounds(bounds);
  const clearanceAt = createClearanceSampler(terrain, area);
  const goals = buildGoalCandidates(origin, target, area, targetRadius);
  const profiles = [
    { clearance: 8, preference: 0, maxSlope: 4.8, deviationWeight: 0.012 },
    { clearance: 6, preference: -1, maxSlope: 5.8, deviationWeight: 0.007 },
    { clearance: 6, preference: 1, maxSlope: 5.8, deviationWeight: 0.007 },
    { clearance: 3, preference: 0, maxSlope: 7.2, deviationWeight: 0.003 },
    { clearance: 1, preference: 0, maxSlope: 9, deviationWeight: 0 }
  ];
  const routes = [];
  const signatures = new Set();
  let searches = 0;
  let expandedNodes = 0;

  for (const profile of profiles) {
    for (const goal of goals) {
      if (routes.length >= maxRoutes) break;
      searches += 1;
      const result = searchMonotoneRoute(origin, goal, area, terrain, clearanceAt, profile);
      expandedNodes += result?.expandedNodes ?? 0;
      if (!result?.points?.length) continue;
      const simplified = simplifyRoute(result.points, area, terrain, clearanceAt, profile.clearance);
      if (simplified.length > maxRoutePoints) continue;
      const signature = simplified
        .map((point) => `${Math.round(point.x / 3)},${Math.round(point.y / 3)}`)
        .join(";");
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      routes.push({
        route: simplified,
        goal,
        cost: result.cost,
        clearance: profile.clearance,
        strategy: simplified.length === 2 ? "direct" : "terrain-route",
        diagnostics: {
          rawPoints: result.points.length,
          simplifiedPoints: simplified.length,
          expandedNodes: result.expandedNodes,
          searches,
          terrainRevision: Number(terrain?.revision ?? 0)
        }
      });
    }
    if (routes.length >= maxRoutes) break;
  }

  routes.sort((first, second) => {
    if (second.clearance !== first.clearance) return second.clearance - first.clearance;
    if (first.route.length !== second.route.length) return first.route.length - second.route.length;
    return first.cost - second.cost;
  });
  for (const route of routes) {
    route.diagnostics.totalSearches = searches;
    route.diagnostics.totalExpandedNodes = expandedNodes;
  }
  return routes.slice(0, maxRoutes);
}

/** Exact continuous linear spline represented with ReLU/hinge basis terms. */
export function routeToHingeEquation(route, origin) {
  const points = worldRouteToLocal(route, origin);
  if (points.length < 2) return "f(x) = 0";
  const direction = points[points.length - 1].x < 0 ? -1 : 1;
  const forward = direction > 0 ? "x" : "(-x)";
  const knots = points.map((point) => ({ u: direction * point.x, y: point.y }));
  const slopes = [];
  for (let index = 0; index < knots.length - 1; index += 1) {
    const run = Math.max(1e-6, knots[index + 1].u - knots[index].u);
    slopes.push((knots[index + 1].y - knots[index].y) / run);
  }

  const terms = [];
  if (Math.abs(slopes[0]) > 1e-12) {
    // The first segment can extend linearly onto the non-target branch. It
    // still passes through (0, 0), while avoiding an unnecessary abs() term.
    terms.push(`${formatNumber(slopes[0])} * ${forward}`);
  }
  for (let index = 1; index < slopes.length; index += 1) {
    const change = slopes[index] - slopes[index - 1];
    if (Math.abs(change) <= 1e-12) continue;
    terms.push(
      positivePartTerm(change, `${forward} - ${formatNumber(knots[index].u)}`)
    );
  }
  return `f(x) = ${terms.length ? terms.join(" + ") : "0"}`;
}

/**
 * Smooth route approximation using a discrete sine basis. Both endpoints are
 * exact; callers must collision-verify it because the interpolation can bow
 * between its fitted samples. The hinge equation is the guaranteed fallback.
 */
export function routeToHarmonicEquation(route, origin, options = {}) {
  const points = worldRouteToLocal(route, origin);
  if (points.length < 2) return "f(x) = 0";
  const endpoint = points[points.length - 1];
  const direction = endpoint.x < 0 ? -1 : 1;
  const length = Math.max(1e-6, Math.abs(endpoint.x));
  const forward = direction > 0 ? "x" : "(-x)";
  // A signed normalized coordinate keeps the target-facing interpolation
  // unchanged and gives the opposite branch a normal analytic continuation.
  const normalized = `((${forward}) / ${formatNumber(length)})`;
  const harmonics = clamp(
    Math.floor(options.harmonics ?? Math.max(4, Math.min(8, points.length + 2))),
    1,
    8
  );
  const knots = points.map((point) => ({ u: direction * point.x, y: point.y }));
  const residuals = [];
  for (let sample = 1; sample <= harmonics; sample += 1) {
    const progress = sample / (harmonics + 1);
    const y = interpolateRouteY(knots, progress * length);
    residuals.push(y - endpoint.y * progress);
  }

  const coefficients = [];
  for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
    let sum = 0;
    for (let sample = 1; sample <= harmonics; sample += 1) {
      sum += residuals[sample - 1]
        * Math.sin(Math.PI * harmonic * sample / (harmonics + 1));
    }
    coefficients.push(2 * sum / (harmonics + 1));
  }

  const terms = [`${formatNumber(endpoint.y)} * ${normalized}`];
  coefficients.forEach((coefficient, index) => {
    if (Math.abs(coefficient) <= 1e-10) return;
    terms.push(
      `${formatNumber(coefficient)} * sin(${index + 1} * pi * ${normalized})`
    );
  });
  return `f(x) = ${terms.join(" + ")}`;
}

/**
 * Apply bot inaccuracy only after the perfect route is known. Displacement is
 * eased from zero at the shooter to the full miss vector at the route endpoint,
 * preserving the route's recognizable shape and its root at x=0.
 */
export function buildRouteShot(routeCandidate, {
  origin,
  target,
  difficulty = 100,
  random = Math.random,
  maxOffset = 340,
  family = "hinge",
  offsetSign = null
}) {
  const perfectRoute = routeCandidate.route;
  const perfectEquation = family === "harmonic"
    ? routeToHarmonicEquation(perfectRoute, origin)
    : routeToHingeEquation(perfectRoute, origin);
  const accuracy = clamp(Number(difficulty) / 100, 0, 1);
  const severity = 1 - accuracy;
  const signRoll = random();
  const magnitudeRoll = random();
  const sign = offsetSign == null ? (signRoll < 0.5 ? -1 : 1) : Math.sign(offsetSign) || 1;
  const offset = severity === 0
    ? 0
    : sign * maxOffset * severity * (0.78 + magnitudeRoll * 0.22);
  if (offset === 0) {
    const endpoint = perfectRoute[perfectRoute.length - 1];
    return {
      style: `terrain-${family}`,
      strategy: routeCandidate.strategy,
      equation: perfectEquation,
      perfectEquation,
      route: perfectRoute,
      perfectRoute,
      accuracy,
      offset: 0,
      aimedWorldTarget: { ...endpoint },
      diagnostics: { ...routeCandidate.diagnostics, family }
    };
  }

  const localRoute = worldRouteToLocal(perfectRoute, origin);
  const endpoint = localRoute[localRoute.length - 1];
  const trueTarget = { x: target.x - origin.x, y: origin.y - target.y };
  const distance = Math.max(1, Math.hypot(trueTarget.x, trueTarget.y));
  const perpendicular = { x: -trueTarget.y / distance, y: trueTarget.x / distance };
  const maximumHorizontalShift = Math.max(2, Math.abs(endpoint.x) * 0.48);
  const shiftX = clamp(perpendicular.x * offset, -maximumHorizontalShift, maximumHorizontalShift);
  const remainingShift = Math.sqrt(Math.max(0, offset ** 2 - shiftX ** 2));
  const verticalSign = Math.sign(perpendicular.y * offset) || Math.sign(offset) || 1;
  const shiftY = verticalSign * remainingShift;
  const direction = endpoint.x < 0 ? -1 : 1;
  const length = Math.max(1e-6, Math.abs(endpoint.x));
  const perturbedLocal = localRoute.map((point) => {
    const progress = clamp(direction * point.x / length, 0, 1);
    const weight = progress * progress * (3 - 2 * progress);
    return { x: point.x + shiftX * weight, y: point.y + shiftY * weight };
  });
  const perturbedRoute = perturbedLocal.map((point) => ({
    x: origin.x + point.x,
    y: origin.y - point.y
  }));
  const equation = family === "harmonic"
    ? routeToHarmonicEquation(perturbedRoute, origin)
    : routeToHingeEquation(perturbedRoute, origin);
  const aimedEndpoint = perturbedRoute[perturbedRoute.length - 1];

  return {
    style: `terrain-${family}`,
    strategy: routeCandidate.strategy,
    equation,
    perfectEquation,
    route: perturbedRoute,
    perfectRoute,
    accuracy,
    offset,
    aimedWorldTarget: { ...aimedEndpoint },
    aimedTarget: {
      x: aimedEndpoint.x - origin.x,
      y: origin.y - aimedEndpoint.y
    },
    diagnostics: { ...routeCandidate.diagnostics, family }
  };
}

function searchMonotoneRoute(origin, goal, bounds, terrain, clearanceAt, profile) {
  const direction = Math.sign(goal.x - origin.x) || 1;
  const horizontalDistance = Math.abs(goal.x - origin.x);
  if (horizontalDistance < 1) return null;
  if (segmentIsClear(origin, goal, bounds, terrain, clearanceAt, profile.clearance)) {
    return {
      points: [{ ...origin }, { ...goal }],
      cost: Math.hypot(goal.x - origin.x, goal.y - origin.y),
      expandedNodes: 1
    };
  }

  const columnStep = clamp(horizontalDistance / 72, 9, 16);
  const columnCount = clamp(Math.ceil(horizontalDistance / columnStep), 2, 170);
  const rowStep = clamp(bounds.height / 72, 8, 13);
  const yValues = [];
  const top = bounds.y + Math.max(1, profile.clearance);
  const bottom = bounds.bottom - Math.max(1, profile.clearance);
  for (let y = top; y <= bottom + 0.001; y += rowStep) yValues.push(Math.min(y, bottom));
  yValues.push(origin.y, goal.y);
  yValues.sort((a, b) => a - b);
  const uniqueY = yValues.filter((value, index) => index === 0 || Math.abs(value - yValues[index - 1]) > 0.5);
  const layers = new Array(columnCount);
  let previousLayer = null;
  let expandedNodes = 0;

  for (let column = 1; column < columnCount; column += 1) {
    const progress = column / columnCount;
    const x = origin.x + direction * horizontalDistance * progress;
    const previousX = column === 1
      ? origin.x
      : origin.x + direction * horizontalDistance * (column - 1) / columnCount;
    const horizontalStep = Math.abs(x - previousX);
    const maximumRise = horizontalStep * profile.maxSlope + rowStep;
    const straightY = origin.y + (goal.y - origin.y) * progress;
    const layer = new Map();

    for (let row = 0; row < uniqueY.length; row += 1) {
      const y = uniqueY[row];
      const clearance = clearanceAt(x, y);
      if (clearance + 1e-6 < profile.clearance) continue;
      let best = null;
      const predecessors = previousLayer
        ? previousLayer.entries()
        : [[-1, { point: origin, cost: 0, slope: 0 }]];
      for (const [previousRow, previousState] of predecessors) {
        if (Math.abs(y - previousState.point.y) > maximumRise) continue;
        const point = { x, y };
        const length = Math.hypot(point.x - previousState.point.x, point.y - previousState.point.y);
        const slope = (point.y - previousState.point.y) / Math.max(1, horizontalStep);
        const bendPenalty = Math.abs(slope - previousState.slope) * 1.35;
        const clearancePenalty = Math.max(0, profile.clearance * 2.2 - clearance) * 0.22;
        const deviationPenalty = Math.abs(y - straightY) * profile.deviationWeight;
        const preferencePenalty = profile.preference < 0
          ? ((y - bounds.y) / bounds.height) * 0.32
          : profile.preference > 0
            ? ((bounds.bottom - y) / bounds.height) * 0.32
            : 0;
        const cost = previousState.cost + length + bendPenalty + clearancePenalty
          + deviationPenalty + preferencePenalty;
        if (best && cost >= best.cost) continue;
        if (!segmentIsClear(previousState.point, point, bounds, terrain, clearanceAt, profile.clearance)) continue;
        best = { point, cost, slope, parentRow: previousRow };
      }
      if (best) {
        layer.set(row, best);
        expandedNodes += 1;
      }
    }
    if (!layer.size) return { points: null, expandedNodes };
    layers[column] = layer;
    previousLayer = layer;
  }

  let finish = null;
  const lastX = origin.x + direction * horizontalDistance * (columnCount - 1) / columnCount;
  const finalHorizontalStep = Math.max(1, Math.abs(goal.x - lastX));
  const maximumFinalRise = finalHorizontalStep * profile.maxSlope + rowStep;
  for (const [row, state] of previousLayer.entries()) {
    if (Math.abs(goal.y - state.point.y) > maximumFinalRise) continue;
    if (!segmentIsClear(state.point, goal, bounds, terrain, clearanceAt, profile.clearance)) continue;
    const slope = (goal.y - state.point.y) / finalHorizontalStep;
    const cost = state.cost + Math.hypot(goal.x - state.point.x, goal.y - state.point.y)
      + Math.abs(slope - state.slope) * 1.35;
    if (!finish || cost < finish.cost) finish = { row, cost };
  }
  if (!finish) return { points: null, expandedNodes };

  const reversed = [{ ...goal }];
  let row = finish.row;
  for (let column = columnCount - 1; column >= 1; column -= 1) {
    const state = layers[column].get(row);
    if (!state) return { points: null, expandedNodes };
    reversed.push({ ...state.point });
    row = state.parentRow;
  }
  reversed.push({ ...origin });
  return { points: reversed.reverse(), cost: finish.cost, expandedNodes };
}

function simplifyRoute(points, bounds, terrain, clearanceAt, clearance) {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const simplified = [{ ...points[0] }];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let next = anchor + 1;
    for (let candidate = points.length - 1; candidate > anchor + 1; candidate -= 1) {
      if (segmentIsClear(points[anchor], points[candidate], bounds, terrain, clearanceAt, clearance)) {
        next = candidate;
        break;
      }
    }
    simplified.push({ ...points[next] });
    anchor = next;
  }
  return removeCollinearPoints(simplified);
}

function removeCollinearPoints(points) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = result[result.length - 1];
    const current = points[index];
    const next = points[index + 1];
    const firstSlope = (current.y - previous.y) / Math.max(1e-6, Math.abs(current.x - previous.x));
    const secondSlope = (next.y - current.y) / Math.max(1e-6, Math.abs(next.x - current.x));
    if (Math.abs(firstSlope - secondSlope) > 0.015) result.push(current);
  }
  result.push(points[points.length - 1]);
  return result;
}

function buildGoalCandidates(origin, target, bounds, targetRadius) {
  const radius = clamp(Number(targetRadius) || 22, 8, 40);
  const horizontal = target.x - origin.x;
  const candidates = [];
  const add = (x, y) => {
    const point = {
      x: clamp(x, bounds.x + 2, bounds.right - 2),
      y: clamp(y, bounds.y + 2, bounds.bottom - 2)
    };
    if (Math.hypot(point.x - target.x, point.y - target.y) > radius - 2) return;
    if (Math.abs(point.x - origin.x) < 4) return;
    if (candidates.some((entry) => Math.hypot(entry.x - point.x, entry.y - point.y) < 2)) return;
    candidates.push(point);
  };

  if (Math.abs(horizontal) >= 12) {
    add(target.x, target.y);
    add(target.x - Math.sign(horizontal) * Math.min(12, radius * 0.45), target.y);
    add(target.x, target.y - radius * 0.35);
    add(target.x, target.y + radius * 0.35);
  } else {
    const side = Math.min(14, Math.max(10, radius * 0.52));
    add(target.x + side, target.y);
    add(target.x - side, target.y);
    add(target.x + side * 0.75, target.y - radius * 0.28);
    add(target.x - side * 0.75, target.y + radius * 0.28);
  }
  return candidates;
}

function createClearanceSampler(terrain, bounds) {
  if (!terrain || typeof terrain !== "object") {
    return (x, y) => Math.min(x - bounds.x, bounds.right - x, y - bounds.y, bounds.bottom - y);
  }
  const columns = Number(terrain.columns);
  const rows = Number(terrain.rows);
  const cellSize = Number(terrain.cellSize ?? terrain.resolution);
  const revision = Number(terrain.revision ?? 0);
  const cached = clearanceCache.get(terrain);
  let entry = cached;
  if (!entry || entry.revision !== revision || entry.columns !== columns || entry.rows !== rows) {
    entry = Number.isFinite(columns) && Number.isFinite(rows) && Number.isFinite(cellSize)
      ? buildClearanceField(terrain, columns, rows, cellSize, revision)
      : null;
    if (entry) clearanceCache.set(terrain, entry);
  }
  if (!entry) {
    return (x, y) => {
      if (isTerrainBlocked(terrain, x, y)) return 0;
      return Math.min(x - bounds.x, bounds.right - x, y - bounds.y, bounds.bottom - y, 12);
    };
  }
  return (x, y) => {
    if (x < bounds.x || x > bounds.right || y < bounds.y || y > bounds.bottom) return 0;
    const column = clamp(Math.floor(x / entry.cellSize), 0, entry.columns - 1);
    const row = clamp(Math.floor(y / entry.cellSize), 0, entry.rows - 1);
    const obstacleDistance = Math.max(0, entry.distances[row * entry.columns + column] * entry.cellSize - entry.cellSize * 0.55);
    const edgeDistance = Math.min(x - bounds.x, bounds.right - x, y - bounds.y, bounds.bottom - y);
    return Math.min(obstacleDistance, edgeDistance);
  };
}

function buildClearanceField(terrain, columns, rows, cellSize, revision) {
  const distances = new Float32Array(columns * rows);
  distances.fill(1e6);
  const solidAt = (column, row) => {
    if (typeof terrain.isCellSolid === "function") return terrain.isCellSolid(column, row);
    const data = terrain.cells ?? terrain.data;
    return Boolean(data?.[row * columns + column]);
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (solidAt(column, row)) distances[row * columns + column] = 0;
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (column > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      if (row > 0) distances[index] = Math.min(distances[index], distances[index - columns] + 1);
      if (column > 0 && row > 0) distances[index] = Math.min(distances[index], distances[index - columns - 1] + SQRT_TWO);
      if (column + 1 < columns && row > 0) distances[index] = Math.min(distances[index], distances[index - columns + 1] + SQRT_TWO);
    }
  }
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const index = row * columns + column;
      if (column + 1 < columns) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      if (row + 1 < rows) distances[index] = Math.min(distances[index], distances[index + columns] + 1);
      if (column + 1 < columns && row + 1 < rows) distances[index] = Math.min(distances[index], distances[index + columns + 1] + SQRT_TWO);
      if (column > 0 && row + 1 < rows) distances[index] = Math.min(distances[index], distances[index + columns - 1] + SQRT_TWO);
    }
  }
  return { columns, rows, cellSize, revision, distances };
}

function segmentIsClear(start, end, bounds, terrain, clearanceAt, clearance) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const step = clamp(Number(terrain?.cellSize ?? terrain?.resolution ?? 4) * 0.48, 1, 2.5);
  const samples = Math.max(1, Math.ceil(distance / step));
  for (let index = 0; index <= samples; index += 1) {
    const amount = index / samples;
    const x = start.x + (end.x - start.x) * amount;
    const y = start.y + (end.y - start.y) * amount;
    if (x < bounds.x || x > bounds.right || y < bounds.y || y > bounds.bottom) return false;
    if (isTerrainBlocked(terrain, x, y) || clearanceAt(x, y) + 1e-6 < clearance) return false;
  }
  return true;
}

function isTerrainBlocked(terrain, x, y) {
  if (!terrain) return false;
  if (typeof terrain.isBlocked === "function") return Boolean(terrain.isBlocked(x, y));
  if (typeof terrain.isSolid === "function") return Boolean(terrain.isSolid(x, y));
  return false;
}

function worldRouteToLocal(route, origin) {
  return (route ?? []).map((point) => ({ x: point.x - origin.x, y: origin.y - point.y }));
}

function interpolateRouteY(knots, u) {
  if (u <= knots[0].u) return knots[0].y;
  for (let index = 0; index < knots.length - 1; index += 1) {
    const first = knots[index];
    const second = knots[index + 1];
    if (u > second.u) continue;
    const amount = (u - first.u) / Math.max(1e-6, second.u - first.u);
    return first.y + (second.y - first.y) * amount;
  }
  return knots[knots.length - 1].y;
}

function normalizeBounds(bounds) {
  const x = Number(bounds?.x ?? 0);
  const y = Number(bounds?.y ?? 0);
  const width = Number(bounds?.width ?? 0);
  const height = Number(bounds?.height ?? 0);
  return { x, y, width, height, right: x + width, bottom: y + height };
}

function isFinitePoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function formatNumber(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-11) return "0";
  return Number(value.toPrecision(11)).toString();
}

/** Parser-safe c*max(0,z), expressed using the still-supported abs(). */
function positivePartTerm(coefficient, expression) {
  return `${formatNumber(coefficient / 2)} * ((${expression}) + abs(${expression}))`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
