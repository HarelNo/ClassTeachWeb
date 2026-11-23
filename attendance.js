const STALE_AFTER_MS = 15 * 60 * 1000;

function attendanceStatus(row, now = Date.now()) {
  const eventTime = row.recorded_at ? new Date(row.recorded_at).getTime() : null;
  const adjustmentTime = row.adjustment_at ? new Date(row.adjustment_at).getTime() : null;
  if (adjustmentTime && (!eventTime || adjustmentTime >= eventTime)) {
    return { status: row.adjustment_status, at: row.adjustment_at, adjusted: true };
  }
  if (!eventTime) return { status: 'unavailable', at: null, adjusted: false };
  if (now - eventTime > STALE_AFTER_MS) {
    return { status: 'stale', at: row.recorded_at, adjusted: false };
  }
  return { status: row.event_status, at: row.recorded_at, adjusted: false };
}

module.exports = { attendanceStatus };
