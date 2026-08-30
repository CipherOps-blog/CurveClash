import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SURVIVAL_BONUS_COEFFICIENT,
  findLastSurvivor,
  rankPlayers,
  survivalBonusPoints,
  survivalBonusUnits
} from '../src/scoring.js';

test('the bonus is 1000 × the square root of the rounds survived', () => {
  assert.equal(SURVIVAL_BONUS_COEFFICIENT, 1000);
  const expected = { 1: 1000, 2: 1414, 3: 1732, 4: 2000, 6: 2449, 8: 2828, 16: 4000 };
  for (const [rounds, points] of Object.entries(expected)) {
    assert.equal(survivalBonusPoints(Number(rounds)), points);
    assert.equal(survivalBonusUnits(Number(rounds)), points * 100);
  }
});

test('a match too short or too odd to count still pays one round', () => {
  assert.equal(survivalBonusPoints(0), 1000);
  assert.equal(survivalBonusPoints(-4), 1000);
  assert.equal(survivalBonusPoints(undefined), 1000);
  assert.equal(survivalBonusPoints(2.9), survivalBonusPoints(2));
});

test('stretching a match out pays less than shooting after the first round', () => {
  for (const rounds of [2, 3, 5, 9, 20]) {
    const marginal = survivalBonusPoints(rounds + 1) - survivalBonusPoints(rounds);
    assert.ok(marginal > 0, `round ${rounds + 1} must still be worth something`);
    assert.ok(marginal < 400, `round ${rounds + 1} paid ${marginal}, less than a kill expected`);
  }
});

test('only a single survivor collects the bonus', () => {
  const alive = { id: 'bot-1', alive: true };
  assert.equal(findLastSurvivor([{ id: 'human', alive: false }, alive]), alive);
  assert.equal(findLastSurvivor([{ id: 'human', alive: true }, alive]), null);
  assert.equal(findLastSurvivor([{ id: 'human', alive: false }]), null);
  assert.equal(findLastSurvivor([]), null);
});

test('the bonus can lift the last player alive over a higher-scoring corpse', () => {
  const human = { id: 'human', name: 'You', alive: false, kills: 3, scoreUnits: 42000 };
  const bot = { id: 'bot-1', name: 'Bot', alive: true, kills: 1, scoreUnits: 1500 };
  const turnOrder = ['human', 'bot-1'];

  assert.equal(rankPlayers([human, bot], turnOrder)[0].player.id, 'human');

  findLastSurvivor([human, bot]).scoreUnits += survivalBonusUnits(4);
  const ranking = rankPlayers([human, bot], turnOrder);
  assert.equal(ranking[0].player.id, 'bot-1');
  assert.equal(ranking[0].player.scoreUnits, 201500);
});
