const test = require('node:test');
const assert = require('node:assert/strict');
const { validateChatMessage } = require('./live-chat');

test('live chat trims messages and rejects empty or oversized content', () => {
  assert.equal(validateChatMessage('  Hello class  '), 'Hello class');
  assert.throws(() => validateChatMessage('   '), /1-1,000 characters/);
  assert.throws(() => validateChatMessage('x'.repeat(1001)), /1-1,000 characters/);
});
