import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SURVIVAL_BONUS_POINTS,
  SURVIVAL_BONUS_UNITS,
  findLastSurvivor,
  rankPlayers
} from '../src/scoring.js';

test('the bonus is 1000 points, held in the same hundredths as every score', () => {
  assert.equal(SURVIVAL_BONUS_POINTS, 1000);
  assert.equal(SURVIVAL_BONUS_UNITS, 100000);
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

  const survivor = findLastSurvivor([human, bot]);
  survivor.scoreUnits += SURVIVAL_BONUS_UNITS;
  const ranking = rankPlayers([human, bot], turnOrder);
  assert.equal(ranking[0].player.id, 'bot-1');
  assert.equal(ranking[0].player.scoreUnits, 101500);
});
