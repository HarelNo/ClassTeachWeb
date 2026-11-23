const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStudents, validateTeachers } = require('./import-rosters');

test('roster import validates and normalizes teacher and student domain data', () => {
  const teachers = validateTeachers([{ 'full name': ' Ada Teacher ', password: 'secret' }]);
  const students = validateStudents([{ 'full name': ' Sam Student ', 'email address': 'sam@example.edu' }]);

  assert.deepEqual(teachers, [{ fullName: 'Ada Teacher', password: 'secret' }]);
  assert.deepEqual(students, [{ fullName: 'Sam Student', email: 'sam@example.edu' }]);
});

test('roster import rejects duplicate identities and invalid student emails', () => {
  assert.throws(() => validateTeachers([
    { 'full name': 'Ada Teacher', password: 'one' },
    { 'full name': 'ada teacher', password: 'two' },
  ]), /duplicate name/i);
  assert.throws(() => validateStudents([
    { 'full name': 'Sam One', 'email address': 'sam@example.edu' },
    { 'full name': 'Sam Two', 'email address': 'SAM@example.edu' },
  ]), /duplicate email/i);
  assert.throws(() => validateStudents([
    { 'full name': 'Sam Student', 'email address': 'invalid' },
  ]), /valid email address/i);
});
