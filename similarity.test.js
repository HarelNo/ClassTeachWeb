const test = require('node:test');
const assert = require('node:assert/strict');
const { similarityDetails } = require('./similarity');

test('similarity highlights shared five-word excerpts for teacher review', () => {
  const first = 'A careful student explains that water changes state when heat is added to it.';
  const second = 'A careful student explains that water changes state when heat is removed from it.';
  const result = similarityDetails(first, second);

  assert.ok(result.percent >= 35);
  assert.ok(result.excerpts.length > 0);
  assert.match(result.excerpts[0].excerpt, /careful student explains/);
  assert.match(result.excerpts[0].comparisonExcerpt, /careful student explains/);
});

test('short submissions do not produce misleading similarity matches', () => {
  assert.deepEqual(similarityDetails('yes indeed', 'yes indeed'), { percent: 0, excerpts: [] });
  assert.deepEqual(similarityDetails('completely different words in this work', ''), { percent: 0, excerpts: [] });
});
