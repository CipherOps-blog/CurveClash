import test from 'node:test';
import assert from 'node:assert/strict';
import * as math from 'mathjs';

import { parseEquation, assertPlayableFunctionZero } from '../src/equation-engine.js';

test('equations must pass through the origin at x = 0', () => {
  assert.doesNotThrow(() => {
    assertPlayableFunctionZero(parseEquation('x^2', math), -200, 200);
    assertPlayableFunctionZero(parseEquation('2 * x', math), -200, 200);
    assertPlayableFunctionZero(parseEquation('x^2 + 3 * x', math), -200, 200);
  });

  assert.throws(() => {
    assertPlayableFunctionZero(parseEquation('x^2 + 1', math), -200, 200);
  }, /NO_ORIGIN_ZERO|x = 0/);
});
