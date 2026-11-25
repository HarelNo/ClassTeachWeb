(() => {
  const pickers = [...document.querySelectorAll('[data-location-picker]')].map((root) => {
    const form = root.closest('form');
    return {
      root,
      form,
      latitudeInput: form?.querySelector('input[name="latitude"]'),
      longitudeInput: form?.querySelector('input[name="longitude"]'),
      gpsButton: root.querySelector('[data-use-current-location]'),
      locationStatus: root.querySelector('[data-location-status]'),
      mapStatus: root.querySelector('[data-map-status]'),
      mapElement: root.querySelector('[data-classroom-map]'),
      map: null,
      marker: null,
      pendingCenter: null,
      cancelGps: null,
    };
  }).filter((picker) => picker.form && picker.latitudeInput && picker.longitudeInput
    && picker.gpsButton && picker.locationStatus && picker.mapStatus && picker.mapElement);

  if (!pickers.length) return;

  const configuredMaxAccuracy = Number(document.body.dataset.gpsMaxAccuracyMeters);
  const maximumAccuracyMeters = Number.isFinite(configuredMaxAccuracy) && configuredMaxAccuracy > 0
    ? configuredMaxAccuracy : 100;
  const apiKey = document.body.dataset.googleMapsApiKey;
  const manualLocationOption = apiKey
    ? 'select the exact point on the map'
    : 'enter the coordinates manually or use a device with precise GPS';

  function readCoordinates(picker) {
    if (!picker.latitudeInput.value.trim() || !picker.longitudeInput.value.trim()) return null;
    const latitude = Number(picker.latitudeInput.value);
    const longitude = Number(picker.longitudeInput.value);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    return { lat: latitude, lng: longitude };
  }

  function centerMap(picker, position, zoom = 18) {
    picker.pendingCenter = { position, zoom };
    if (!picker.map) return;
    picker.map.setCenter(position);
    picker.map.setZoom(zoom);
  }

  function setCoordinates(picker, position) {
    picker.latitudeInput.value = position.lat.toFixed(6);
    picker.longitudeInput.value = position.lng.toFixed(6);
    if (picker.marker) {
      picker.marker.setPosition(position);
      picker.marker.setVisible(true);
    }
  }

  function setMapError(message) {
    pickers.forEach((picker) => {
      picker.mapStatus.textContent = message;
    });
  }

  function initializeMaps() {
    if (!window.google || !window.google.maps) {
      setMapError('Google Maps could not be initialized. Check the API key and Maps JavaScript API access.');
      return;
    }
    pickers.forEach((picker) => {
      const savedPosition = readCoordinates(picker);
      const initialCenter = picker.pendingCenter
        ? picker.pendingCenter.position : savedPosition || { lat: 0, lng: 0 };
      const initialZoom = picker.pendingCenter ? picker.pendingCenter.zoom : savedPosition ? 17 : 2;
      picker.map = new window.google.maps.Map(picker.mapElement, {
        center: initialCenter,
        zoom: initialZoom,
        mapTypeControl: true,
        streetViewControl: false,
      });
      picker.marker = new window.google.maps.Marker({
        map: picker.map,
        position: initialCenter,
        draggable: true,
        visible: Boolean(savedPosition),
      });
      picker.map.addListener('click', (event) => {
        if (!event.latLng) return;
        if (picker.cancelGps) picker.cancelGps();
        const position = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        setCoordinates(picker, position);
        picker.locationStatus.textContent = 'Classroom point selected on the map.';
      });
      picker.marker.addListener('dragend', (event) => {
        if (!event.latLng) return;
        if (picker.cancelGps) picker.cancelGps();
        const position = { lat: event.latLng.lat(), lng: event.latLng.lng() };
        setCoordinates(picker, position);
        picker.locationStatus.textContent = 'Classroom point updated.';
      });
      if (savedPosition) {
        picker.marker.setPosition(savedPosition);
        picker.mapStatus.textContent = 'Drag the marker or click the map to change the classroom point.';
      } else {
        picker.mapStatus.textContent = 'Click the map to place the classroom marker. Use GPS to center the map near you.';
      }
    });
  }

  function useCurrentLocation(picker) {
    if (!navigator.geolocation) {
      picker.locationStatus.textContent = `This browser does not provide GPS location. Please ${manualLocationOption}.`;
      return;
    }

    picker.gpsButton.disabled = true;
    picker.locationStatus.textContent = 'Finding a precise GPS location…';
    let bestPosition = null;
    let watchId = null;
    let acquisitionTimeout = null;
    let finished = false;

    function stopWatching() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (acquisitionTimeout !== null) window.clearTimeout(acquisitionTimeout);
      picker.gpsButton.disabled = false;
      picker.cancelGps = null;
    }

    function finishWithError(message, position = null) {
      if (finished) return;
      finished = true;
      stopWatching();
      if (position) centerMap(picker, { lat: position.coords.latitude, lng: position.coords.longitude });
      picker.locationStatus.textContent = message;
    }

    function acceptPosition(position) {
      if (finished) return;
      finished = true;
      stopWatching();
      const coordinates = { lat: position.coords.latitude, lng: position.coords.longitude };
      setCoordinates(picker, coordinates);
      centerMap(picker, coordinates);
      picker.locationStatus.textContent = `GPS location set (accuracy ${Math.round(position.coords.accuracy)} m).`;
    }

    picker.cancelGps = () => {
      if (finished) return;
      finished = true;
      stopWatching();
    };

    try {
      watchId = navigator.geolocation.watchPosition((position) => {
        if (finished) return;
        if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) {
          bestPosition = position;
        }
        if (position.coords.accuracy <= maximumAccuracyMeters) {
          acceptPosition(position);
        } else {
          centerMap(picker, { lat: position.coords.latitude, lng: position.coords.longitude });
          picker.locationStatus.textContent = `GPS accuracy is ${Math.round(position.coords.accuracy)} m; this needs ${Math.round(maximumAccuracyMeters)} m or better. The map is centered nearby so you can select the point manually.`;
        }
      }, (error) => {
        if (error.code === 1 || error.code === error.PERMISSION_DENIED) {
          finishWithError(`Location permission was denied. Allow location access or ${manualLocationOption}.`);
        } else if (bestPosition) {
          finishWithError(`GPS accuracy did not reach ${Math.round(maximumAccuracyMeters)} m. Please ${manualLocationOption}.`, bestPosition);
        } else if (error.code === 3 || error.code === error.TIMEOUT) {
          finishWithError(`GPS timed out. Try again outdoors or ${manualLocationOption}.`);
        } else {
          finishWithError(`GPS location is unavailable. Please ${manualLocationOption}.`);
        }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      acquisitionTimeout = window.setTimeout(() => {
        if (bestPosition) {
          finishWithError(`GPS accuracy did not reach ${Math.round(maximumAccuracyMeters)} m. Please ${manualLocationOption}.`, bestPosition);
        } else {
          finishWithError(`GPS timed out. Try again outdoors or ${manualLocationOption}.`);
        }
      }, 30000);
    } catch {
      finishWithError(`GPS could not be started. Check browser location permissions or ${manualLocationOption}.`);
    }
  }

  pickers.forEach((picker) => {
    picker.gpsButton.addEventListener('click', () => useCurrentLocation(picker));
    [picker.latitudeInput, picker.longitudeInput].forEach((input) => {
      input.addEventListener('change', () => {
        if (picker.cancelGps) picker.cancelGps();
        const position = readCoordinates(picker);
        if (!position) return;
        setCoordinates(picker, position);
        centerMap(picker, position);
        picker.locationStatus.textContent = 'Classroom coordinates updated.';
      });
    });
    if (!apiKey) {
      picker.mapStatus.textContent = 'Google Maps is not configured yet. Add GOOGLE_MAPS_API_KEY to the service settings; GPS and coordinate entry still work.';
    }
  });

  if (!apiKey) return;
  window.classTeachMapsReady = initializeMaps;
  window.gm_authFailure = () => setMapError('Google rejected the Maps API key. Check its restrictions, billing, and Maps JavaScript API access.');
  if (window.google && window.google.maps) {
    initializeMaps();
    return;
  }
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=classTeachMapsReady&loading=async`;
  script.async = true;
  script.onload = () => {
    if (!window.google || !window.google.maps) {
      setMapError('Google Maps loaded without its API. Check API enablement and billing.');
    }
  };
  script.onerror = () => setMapError('Google Maps could not be loaded. Check network access and the API key configuration.');
  document.head.appendChild(script);
})();
