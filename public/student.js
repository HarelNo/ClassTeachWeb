(() => {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const liveSession = document.body.dataset.liveSession;
  const studentId = document.body.dataset.studentId;
  const queueKey = `classteachweb-offline-outbox-${liveSession}-${studentId}`;
  const lastCheckinKey = `classteachweb-last-checkin-${liveSession}-${studentId}`;
  const openDetailsKey = `classteachweb-open-details-${liveSession}-${studentId}`;
  const checkinStatus = document.getElementById('checkin-status');
  const configuredMaxAccuracy = Number(document.body.dataset.gpsMaxAccuracyMeters);
  const maximumAccuracyMeters = Number.isFinite(configuredMaxAccuracy) && configuredMaxAccuracy > 0
    ? configuredMaxAccuracy : 100;
  let checkinInFlight = false;
  let checkinRequestPollInFlight = false;
  let pendingGpsRequestId = null;
  let sessionStorageAvailable = true;

  try {
    sessionStorage.setItem(`${lastCheckinKey}-test`, '1');
    sessionStorage.removeItem(`${lastCheckinKey}-test`);
  } catch {
    sessionStorageAvailable = false;
  }
  try {
    const openDetails = JSON.parse(sessionStorage.getItem(openDetailsKey) || '[]');
    if (Array.isArray(openDetails)) {
      document.querySelectorAll('details[id]').forEach((details) => {
        details.open = openDetails.includes(details.id);
      });
    }
  } catch {
    sessionStorageAvailable = false;
  }

  function rememberOpenDetails() {
    try {
      const openDetails = [...document.querySelectorAll('details[id][open]')].map((details) => details.id);
      sessionStorage.setItem(openDetailsKey, JSON.stringify(openDetails));
    } catch {
      sessionStorageAvailable = false;
    }
  }
  window.addEventListener('pagehide', rememberOpenDetails);

  async function send(url, payload) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, csrfToken }),
      });
    } catch (error) {
      error.retryable = true;
      throw error;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || 'The server did not accept the request.');
      error.retryable = response.status >= 500;
      throw error;
    }
    return result;
  }

  function readQueue() {
    const queue = JSON.parse(localStorage.getItem(queueKey) || '[]');
    const allowedUrl = (url) => url === '/student/questions' || url === '/student/votes'
      || /^\/student\/assignments\/\d+\/submissions$/.test(url);
    if (!Array.isArray(queue) || queue.some((item) => !item || !allowedUrl(item.url)
      || !item.payload || typeof item.payload !== 'object')) {
      throw new Error('The saved offline queue is invalid. Copy any drafts before clearing this browser data.');
    }
    return queue;
  }

  function writeQueue(queue) {
    try {
      localStorage.setItem(queueKey, JSON.stringify(queue));
    } catch (error) {
      console.error('Could not save an offline submission.', error);
      throw new Error('This device could not save the offline draft. Copy it before leaving this page.');
    }
  }

  function rememberCheckin() {
    try {
      sessionStorage.setItem(lastCheckinKey, String(Date.now()));
    } catch {
      sessionStorageAvailable = false;
    }
  }

  function finishCheckin() {
    checkinInFlight = false;
    if (pendingGpsRequestId) {
      const nextRequestId = pendingGpsRequestId;
      pendingGpsRequestId = null;
      window.setTimeout(() => checkLocation(true, nextRequestId), 0);
    }
  }

  async function flushQueue() {
    if (!navigator.onLine) return;
    let queue;
    try {
      queue = readQueue();
    } catch (error) {
      console.error('Could not read the offline submission queue.', error);
      document.querySelectorAll('[data-submit-status]').forEach((status) => {
        status.textContent = error.message;
      });
      return;
    }
    const remaining = [];
    for (const item of queue) {
      try {
        await send(item.url, item.payload);
        const status = document.getElementById(item.statusId);
        if (status) status.textContent = 'Submitted and saved.';
      } catch (error) {
        if (error.retryable) remaining.push(item);
        else {
          const status = document.getElementById(item.statusId);
          if (status) status.textContent = error.message;
        }
      }
    }
    writeQueue(remaining);
  }

  document.querySelectorAll('form[data-queue]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-submit-status]');
      const payload = Object.fromEntries(new FormData(form).entries());
      payload.idempotencyKey = crypto.randomUUID();
      if (!navigator.onLine) {
        try {
          const queue = readQueue();
          queue.push({ url: form.dataset.queue, payload, statusId: status?.id });
          writeQueue(queue);
          form.reset();
          if (status) status.textContent = 'Saved on this device; waiting for a connection.';
        } catch (error) {
          if (status) status.textContent = error.message;
        }
        return;
      }
      try {
        await send(form.dataset.queue, payload);
        form.reset();
        if (status) status.textContent = 'Submitted and saved.';
      } catch (error) {
        if (status) status.textContent = error.message;
      }
    });
  });

  document.querySelectorAll('form[data-local-datetime]').forEach((form) => {
    form.addEventListener('submit', () => {
      const input = form.elements.namedItem('dueAt');
      if (!input?.value) return;
      const offset = form.elements.namedItem('dueAtOffsetMinutes')
        || Object.assign(document.createElement('input'), {
          type: 'hidden',
          name: 'dueAtOffsetMinutes',
        });
      offset.value = String(new Date(input.value).getTimezoneOffset());
      if (!offset.isConnected) form.append(offset);
    });
  });

  document.querySelectorAll('form[data-ai-processing]').forEach((form) => {
    form.addEventListener('submit', () => {
      const status = form.querySelector('[data-ai-status]');
      const button = form.querySelector('button[type="submit"], button:not([type])');
      if (status) status.textContent = 'Processing with OpenAI. Keep this page open.';
      if (button) button.disabled = true;
    });
  });

  document.getElementById('leave-class')?.addEventListener('submit', (event) => {
    if (!navigator.onLine) {
      event.preventDefault();
      const status = document.getElementById('leave-status');
      if (status) status.textContent = 'Reconnect before leaving so this device can safely clear class drafts.';
      return;
    }
    if (!window.confirm('Leave this class and discard any offline drafts saved on this device?')) {
      event.preventDefault();
      return;
    }
    localStorage.removeItem(queueKey);
    sessionStorage.removeItem(lastCheckinKey);
  });

  async function checkLocation(force = false, requestId = null) {
    if (!checkinStatus || document.body.dataset.checkinsEnabled !== 'true') return;
    if (!navigator.onLine || document.visibilityState !== 'visible') {
      if (requestId) pendingGpsRequestId = requestId;
      return;
    }
    if (checkinInFlight) {
      if (requestId) pendingGpsRequestId = requestId;
      return;
    }
    let lastCheckin = 0;
    try {
      lastCheckin = Number(sessionStorage.getItem(lastCheckinKey) || 0);
    } catch {
      sessionStorageAvailable = false;
    }
    if (!force && Date.now() - lastCheckin < 10 * 60 * 1000) return;
    checkinInFlight = true;
    let pulseId = requestId;
    if (!pulseId) {
      try {
        const pulse = await send('/student/checkin/start', {
          source: force ? 'student-manual' : 'automatic',
        });
        if (!pulse.pulseId) throw new Error('The server did not create a GPS pulse. Reload and try again.');
        pulseId = pulse.pulseId;
      } catch (error) {
        checkinStatus.textContent = error.message;
        finishCheckin();
        return;
      }
    }
    if (sessionStorageAvailable) rememberCheckin();
    checkinStatus.textContent = 'Checking GPS location…';
    const saveStatus = async (payload) => {
      payload.requestId = pulseId;
      try {
        const result = await send('/student/checkin', payload);
        const accuracy = result.accuracyMeters === null ? ''
          : ` — GPS accuracy ${result.accuracyMeters} m`;
        const detailMessages = {
          'accuracy-too-low': `Accuracy is too low. Enable precise location; this check requires ${Math.round(maximumAccuracyMeters)} m or better.`,
          'permission-denied': 'Allow location access in your browser and device settings.',
          timeout: 'Location request timed out. Try again near a window or outdoors.',
          unavailable: 'The browser could not determine a location.',
          'location-or-accuracy-unavailable': 'The browser could not determine a reliable location.',
        };
        const detail = result.detail ? ` — ${detailMessages[result.detail] || result.detail.replaceAll('-', ' ')}` : '';
        checkinStatus.textContent = `${result.status}${accuracy}${detail} — checked at ${result.recordedAt}`;
        if (sessionStorageAvailable) rememberCheckin();
      } catch (error) {
        checkinStatus.textContent = error.message;
      } finally {
        finishCheckin();
      }
    };
    if (!navigator.geolocation) {
      await saveStatus({ reason: 'unavailable' });
      return;
    }
    let bestPosition = null;
    let watchId = null;
    let acquisitionTimeout = null;
    let locationResolved = false;
    const stopWatching = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (acquisitionTimeout !== null) window.clearTimeout(acquisitionTimeout);
    };
    const submitPosition = (position) => {
      if (locationResolved) return;
      locationResolved = true;
      stopWatching();
      saveStatus({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
      });
    };
    const submitLocationError = (error) => {
      if (locationResolved) return;
      locationResolved = true;
      stopWatching();
      const reason = error.code === error.PERMISSION_DENIED
        ? 'permission-denied'
        : error.code === error.TIMEOUT ? 'timeout' : 'unavailable';
      saveStatus({ reason });
    };
    try {
      watchId = navigator.geolocation.watchPosition((position) => {
        if (locationResolved) return;
        if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
          bestPosition = position;
        }
        if (position.coords.accuracy <= maximumAccuracyMeters) {
          submitPosition(position);
        } else {
          checkinStatus.textContent = `Waiting for a more accurate GPS fix — current accuracy ${Math.round(position.coords.accuracy)} m; target ${Math.round(maximumAccuracyMeters)} m or better.`;
        }
      }, (error) => {
        if (bestPosition && error.code !== error.PERMISSION_DENIED) submitPosition(bestPosition);
        else submitLocationError(error);
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      acquisitionTimeout = window.setTimeout(() => {
        if (bestPosition) submitPosition(bestPosition);
        else submitLocationError({ code: 3, TIMEOUT: 3 });
      }, 30000);
    } catch (error) {
      await saveStatus({ reason: 'unavailable' });
    }
  }

  async function checkForTeacherGpsRequest() {
    if (document.body.dataset.checkinsEnabled !== 'true'
      || !liveSession || !navigator.onLine || document.visibilityState !== 'visible'
      || checkinRequestPollInFlight) return;
    checkinRequestPollInFlight = true;
    try {
      const response = await fetch('/student/checkin-request', { credentials: 'same-origin' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not check for a teacher GPS request.');
      if (result.requestId) checkLocation(true, result.requestId);
    } catch (error) {
      if (checkinStatus) checkinStatus.textContent = error.message;
    } finally {
      checkinRequestPollInFlight = false;
    }
  }

  flushQueue();
  window.addEventListener('online', () => {
    flushQueue();
    checkLocation();
    checkForTeacherGpsRequest();
  });
  if (liveSession && (!checkinStatus || sessionStorageAvailable)) {
    window.setInterval(() => {
      if (!navigator.onLine || document.visibilityState !== 'visible' || checkinInFlight) return;
      const focused = document.activeElement;
      if (focused && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName)) return;
      rememberOpenDetails();
      window.location.reload();
    }, 10000);
  }
  if (checkinStatus) {
    checkLocation();
    window.setInterval(checkLocation, 10 * 60 * 1000);
    document.getElementById('check-location')?.addEventListener('click', () => checkLocation(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkLocation();
        checkForTeacherGpsRequest();
      }
    });
  }
  if (liveSession && document.body.dataset.checkinsEnabled === 'true') {
    checkForTeacherGpsRequest();
    window.setInterval(checkForTeacherGpsRequest, 5000);
  }
})();
