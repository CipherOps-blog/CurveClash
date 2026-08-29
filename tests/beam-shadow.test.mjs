import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBeamEnvelope, buildCombatHitEvents, beamRadiusAtDistance } from '../src/beam.js';

/** Solid rectangle terrain, in the same shape the ObstacleField adapter has. */
function wall({ x, y, width, height }) {
  return {
    cellSize: 4,
    isBlocked: (px, py) => px >= x && px <= x + width && py >= y && py <= y + height
  };
}

/** A straight horizontal path of `length` px starting at (0, 200). */
function straightPath(length, step = 4) {
  const points = [];
  for (let x = 0; x <= length; x += step) points.push({ x, y: 200 });
  return points;
}

// For a left-to-right path the outward normal is (0, +1), so `topExtent`
// measures the side below the curve in canvas space. The slabs below sit
// there, 16px clear of the centerline.
const GRAZING_SLAB = { x: 300, y: 216, width: 60, height: 34 };

test('an obstacle beside the beam casts a shadow that never re-lights', () => {
  // A slab poking into the cone between x=300 and x=360 only.
  const terrain = wall(GRAZING_SLAB);
  const { paths } = buildBeamEnvelope([straightPath(900)], terrain);
  const marks = paths[0];

  const at = (distance) => marks.reduce(
    (best, mark) => (Math.abs(mark.distance - distance) < Math.abs(best.distance - distance) ? mark : best)
  );

  // Cut while passing the slab...
  const beside = at(330);
  assert.ok(beside.topExtent < beamRadiusAtDistance(beside.distance) * 0.9);
  // ...and still cut far past its trailing edge, where a per-cross-section
  // lateral test would have found clear air and re-lit the cone.
  const behind = at(700);
  assert.ok(
    behind.topExtent <= beamRadiusAtDistance(behind.distance) * 0.75,
    `beam re-lit inside the shadow: ${behind.topExtent} of ${beamRadiusAtDistance(behind.distance)}`
  );
  // The unobstructed side is untouched.
  assert.equal(behind.bottomExtent, beamRadiusAtDistance(behind.distance));
});

test('the lit fraction only ever shrinks, so the lit edge stays continuous', () => {
  const terrain = wall(GRAZING_SLAB);
  const { paths } = buildBeamEnvelope([straightPath(900)], terrain);

  let previousFraction = 1;
  for (const mark of paths[0]) {
    const fraction = mark.topExtent / beamRadiusAtDistance(mark.distance);
    assert.ok(
      fraction <= previousFraction + 1e-9,
      `lit fraction grew back at distance ${mark.distance}: ${previousFraction} -> ${fraction}`
    );
    previousFraction = fraction;
  }
});

test('the lit face of an obstruction is reported for burning', () => {
  const terrain = wall(GRAZING_SLAB);
  const { contacts } = buildBeamEnvelope([straightPath(900)], terrain);

  assert.ok(contacts.length > 0, 'a grazed wall must report contacts to burn');
  // Every contact sits on the slab, and they span its lit face rather than
  // collapsing onto a single point.
  for (const contact of contacts) assert.ok(terrain.isBlocked(contact.x, contact.y));
  const spanX = Math.max(...contacts.map((c) => c.x)) - Math.min(...contacts.map((c) => c.x));
  assert.ok(spanX > 20, `contacts should trace the lit face, spanned only ${spanX}px`);
});

test('open space leaves the cone at full width and burns nothing', () => {
  const { paths, contacts } = buildBeamEnvelope([straightPath(600)], wall({ x: 0, y: 0, width: 0, height: 0 }));
  assert.equal(contacts.length, 0);
  for (const mark of paths[0]) {
    assert.equal(mark.topExtent, beamRadiusAtDistance(mark.distance));
    assert.equal(mark.bottomExtent, beamRadiusAtDistance(mark.distance));
  }
});

test('terrain far outside the cone never dims it', () => {
  // The cone is at most BEAM_MAX_RADIUS wide; this slab sits well beyond that.
  const terrain = wall({ x: 200, y: 400, width: 400, height: 40 });
  const { paths, contacts } = buildBeamEnvelope([straightPath(900)], terrain);
  assert.equal(contacts.length, 0);
  const last = paths[0][paths[0].length - 1];
  assert.equal(last.bottomExtent, beamRadiusAtDistance(last.distance));
});

test('a target in the beam shadow is not hit, one in the lit cone still is', () => {
  const terrain = wall(GRAZING_SLAB);
  const path = straightPath(900);
  const envelope = buildBeamEnvelope([path], terrain);

  // Both sit 62px off the centerline at x=700, well past the slab, so each is
  // reachable only by the outer part of the cone: the shadowed side is cut to
  // ~30px there while the clear side still spans its full ~40px. Neither is
  // behind the slab as seen from the centerline, so the straight-ray test on
  // its own would kill both.
  const shadowed = { id: 'shadowed', position: { x: 700, y: 262 } };
  const lit = { id: 'lit', position: { x: 700, y: 138 } };
  const shooter = { id: 'shooter' };
  const options = { paths: [path], shooter, terrain, beam: true, defaultHitRadius: 26 };

  const withoutEnvelope = buildCombatHitEvents({ ...options, players: [shadowed, lit] });
  assert.deepEqual(withoutEnvelope.map((e) => e.playerId).sort(), ['lit', 'shadowed']);

  const withEnvelope = buildCombatHitEvents({ ...options, players: [shadowed, lit], envelope });
  assert.deepEqual(withEnvelope.map((e) => e.playerId), ['lit']);
});
