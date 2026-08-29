import test from 'node:test';
import assert from 'node:assert/strict';
import * as math from 'mathjs';

import { parseEquation, equationToLatex } from '../src/equation-engine.js';

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
  const parsed = parseEquation('0.06908110911 * x', math);
  const before = parsed.evaluateLocal(100, 0);
  equationToLatex(parsed, math, { significantDigits: 2 });
  assert.equal(parsed.evaluateLocal(100, 0), before);
  assert.equal(before, 6.908110911);
});

test('omitting the option renders exactly as before', () => {
  const parsed = parseEquation(BOT_CUBIC, math);
  assert.equal(equationToLatex(parsed, math), equationToLatex(parsed, math, {}));
  assert.match(equationToLatex(parsed, math), /13\.90836547/);
});
