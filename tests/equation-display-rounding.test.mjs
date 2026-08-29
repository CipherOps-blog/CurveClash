import test from 'node:test';
import assert from 'node:assert/strict';
import * as math from 'mathjs';

import { buildCurvePlan, equationToLatex, makeBounds, parseEquation } from '../src/equation-engine.js';

const BOT_CUBIC = '0.1749178443 * x + 4.614099836 * (x / (13.90836547))';

test('long coefficients are shortened for display', () => {
  const latex = equationToLatex(parseEquation('-9.098564556556 * x', math), math, {
    significantDigits: 2
  });
  assert.match(latex, /-9\.1/);
  assert.doesNotMatch(latex, /9\.0985/);
});

test('rounding is announced with an approximation sign', () => {
  const parsed = parseEquation(BOT_CUBIC, math);
  assert.match(equationToLatex(parsed, math, { significantDigits: 2 }), /\\approx/);
});

test('an already-short equation is left exact', () => {
  for (const source of ['0.5 * x', '2 * sin(x / 1.5)', 'x^3 - x']) {
    const parsed = parseEquation(source, math);
    const latex = equationToLatex(parsed, math, { significantDigits: 2 });
    assert.doesNotMatch(latex, /\\approx/, `${source} was needlessly marked approximate`);
    assert.equal(latex, equationToLatex(parsed, math), `${source} was altered`);
  }
});

test('a coefficient far below one keeps its magnitude', () => {
  // Rounding to a fixed number of decimals would erase this term entirely;
  // significant figures keep the curve recognisable.
  const latex = equationToLatex(parseEquation('0.0007123456 * x^2', math), math, {
    significantDigits: 2
  });
  assert.match(latex, /7\.1/);
  assert.match(latex, /10\^\{-4\}/);
});

test('two significant figures is as long as a coefficient gets', () => {
  const latex = equationToLatex(parseEquation('0.06908110911 * x', math), math, {
    significantDigits: 2
  });
  assert.match(latex, /0\.069/);
  assert.doesNotMatch(latex, /0\.0690|0\.06908/);
});

test('display rounding never reaches the function that is fired', () => {
  // The shot keeps every digit the author gave it; only the reveal panel
  // shortens them. Rendering must therefore leave the compiled function, the
  // syntax tree it came from, and the trajectory it produces untouched.
  const source = '0.06908110911 * x + 0.0007123456 * x^2';
  const parsed = parseEquation(source, math);
  const origin = { x: 200, y: 400 };
  const bounds = makeBounds(1200, 720);
  const trace = () => buildCurvePlan(parsed, origin, bounds, null, { math })
    .paths[0].map((point) => `${point.x},${point.y}`).join('|');

  const values = [1, 37, 113, 400].map((x) => parsed.evaluateLocal(x, 0));
  const tree = parsed.node.toString();
  const path = trace();

  equationToLatex(parsed, math, { significantDigits: 2 });

  assert.deepEqual([1, 37, 113, 400].map((x) => parsed.evaluateLocal(x, 0)), values);
  assert.equal(parsed.node.toString(), tree, 'the syntax tree was mutated');
  assert.equal(parsed.expression, source);
  assert.equal(trace(), path, 'the traced trajectory changed');
  assert.equal(values[0], 0.069095356022);
});

test('firing the shortened numbers would miss, which is why it is display-only', () => {
  // Guards the premise: if the rounding ever leaked into the shot, this is
  // the error it would introduce, so the assertion above is worth having.
  const exact = parseEquation('0.06908110911 * x + 0.0007123456 * x^2', math);
  const shown = parseEquation('0.069 * x + 0.00071 * x^2', math);
  assert.notEqual(shown.evaluateLocal(400, 0), exact.evaluateLocal(400, 0));
});

test('omitting the option renders exactly as before', () => {
  const parsed = parseEquation(BOT_CUBIC, math);
  assert.equal(equationToLatex(parsed, math), equationToLatex(parsed, math, {}));
  assert.match(equationToLatex(parsed, math), /13\.90836547/);
});
