const test = require('node:test');
const assert = require('node:assert/strict');
const { attendanceStatus } = require('./attendance');

test('attendance view distinguishes missing, stale, and recent GPS evidence', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.equal(attendanceStatus({}, now).status, 'unavailable');
  assert.equal(attendanceStatus({
    recorded_at: '2026-11-23T11:44:59Z',
    event_status: 'inside',
  }, now).status, 'stale');
  assert.equal(attendanceStatus({
    recorded_at: '2026-11-23T11:45:01Z',
    event_status: 'outside',
  }, now).status, 'outside');
});

test('teacher correction wins over earlier or same-time GPS evidence', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const row = {
    recorded_at: '2026-11-23T11:59:00Z',
    event_status: 'outside',
    adjustment_at: '2026-11-23T11:59:00Z',
    adjustment_status: 'inside',
  };
  assert.deepEqual(attendanceStatus(row, now), {
    status: 'inside',
    at: row.adjustment_at,
    adjusted: true,
  });
});
