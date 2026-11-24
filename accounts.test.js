const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAccountPassword } = require('./accounts');

test('new account passwords require at least 12 characters', () => {
  assert.throws(() => validateAccountPassword('short'), /at least 12 characters/);
  assert.equal(validateAccountPassword('twelve-chars'), 'twelve-chars');
});

test('new account passwords respect bcrypt byte limits', () => {
  assert.throws(() => validateAccountPassword('é'.repeat(37)), /72-byte limit/);
  assert.equal(validateAccountPassword('é'.repeat(12)), 'é'.repeat(12));
});
