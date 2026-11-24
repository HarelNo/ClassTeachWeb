const test = require('node:test');
const assert = require('node:assert/strict');
const { Manager, Teacher, Student, Subject, distanceMeters, evaluateLocation } = require('./models');

test('domain classes validate and normalize their identifying fields', () => {
  const manager = new Manager({ id: 4, fullName: '  Morgan Manager ', passwordHash: 'hash' });
  const teacher = new Teacher({ id: 1, fullName: '  Ada Teacher  ', passwordHash: 'hash' });
  const student = new Student({ id: 2, fullName: '  Sam Student ', email: 'sam@example.edu' });
  const subject = new Subject({ id: 3, teacherId: 1, name: '  Biology ', geofenceRadiusMeters: 100 });

  assert.equal(manager.fullName, 'Morgan Manager');
  assert.equal(teacher.fullName, 'Ada Teacher');
  assert.equal(student.fullName, 'Sam Student');
  assert.equal(subject.name, 'Biology');
  assert.throws(() => new Manager({ fullName: '' }), /Manager name must be 1-120 characters/);
  assert.throws(() => new Student({ fullName: 'Sam', email: 'not-an-email' }), /valid student email/);
  assert.throws(() => new Subject({ name: 'Biology', geofenceRadiusMeters: 5 }), /between 10 and 5000/);
});

test('geofence evaluates distance and rejects unreliable or missing GPS', () => {
  const subject = new Subject({
    id: 3,
    teacherId: 1,
    name: 'Biology',
    classroomLatitude: 32.0853,
    classroomLongitude: 34.7818,
    geofenceRadiusMeters: 100,
  });

  assert.equal(evaluateLocation(subject, 32.0853, 34.7818, 8).status, 'inside');
  assert.equal(evaluateLocation(subject, 32.09, 34.7818, 8).status, 'outside');
  assert.equal(evaluateLocation(subject, 32.0853, 34.7818, 101).status, 'unavailable');
  assert.equal(evaluateLocation(subject, NaN, 34.7818, 8).status, 'unavailable');
  assert.equal(evaluateLocation(new Subject({ name: 'No room' }), 0, 0, 8).status, 'unavailable');
});

test('distance calculation is symmetric and zero at the same point', () => {
  const first = distanceMeters(32.0853, 34.7818, 32.09, 34.7818);
  const reverse = distanceMeters(32.09, 34.7818, 32.0853, 34.7818);
  assert.equal(distanceMeters(0, 0, 0, 0), 0);
  assert.ok(Math.abs(first - reverse) < 0.001);
});
