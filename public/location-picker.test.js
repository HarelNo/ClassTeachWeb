const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('classroom location picker accepts map clicks and precise browser GPS', async () => {
  const listeners = {};
  const mapInstances = [];
  const clearedWatchIds = [];
  const latitudeInput = { value: '', addEventListener() {} };
  const longitudeInput = { value: '', addEventListener() {} };
  const gpsButton = { disabled: false, addEventListener(event, callback) { listeners.gps = callback; } };
  const locationStatus = { textContent: '' };
  const mapStatus = { textContent: '' };
  const mapElement = {};
  const form = {
    querySelector(selector) {
      return selector === 'input[name="latitude"]' ? latitudeInput : longitudeInput;
    },
  };
  const root = {
    closest: () => form,
    querySelector(selector) {
      return ({
        '[data-use-current-location]': gpsButton,
        '[data-location-status]': locationStatus,
        '[data-map-status]': mapStatus,
        '[data-classroom-map]': mapElement,
      })[selector];
    },
  };
  class FakeMap {
    constructor(element, options) {
      this.options = options;
      this.listeners = {};
      mapInstances.push(this);
    }
    addListener(event, callback) { this.listeners[event] = callback; }
    setCenter(position) { this.center = position; }
    setZoom(zoom) { this.zoom = zoom; }
  }
  class FakeMarker {
    constructor(options) { this.options = options; this.listeners = {}; }
    addListener(event, callback) { this.listeners[event] = callback; }
    setPosition(position) { this.position = position; }
    setVisible(visible) { this.visible = visible; }
  }
  const window = {
    google: { maps: { Map: FakeMap, Marker: FakeMarker } },
    setTimeout,
    clearTimeout,
  };
  const document = {
    body: { dataset: { gpsMaxAccuracyMeters: '100', googleMapsApiKey: 'test-key' } },
    querySelectorAll: () => [root],
    createElement: () => ({}),
    head: { appendChild() {} },
  };
  const navigator = {
    geolocation: {
      watchPosition(success) {
        setTimeout(() => success({
          coords: { latitude: 32.0853, longitude: 34.7818, accuracy: 18 },
        }), 0);
        return 12;
      },
      clearWatch(id) { clearedWatchIds.push(id); },
    },
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'location-picker.js'), 'utf8'),
    { document, window, navigator, encodeURIComponent },
  );

  assert.equal(mapInstances.length, 1);
  mapInstances[0].listeners.click({ latLng: { lat: () => 40.7128, lng: () => -74.006 } });
  assert.equal(latitudeInput.value, '40.712800');
  assert.equal(longitudeInput.value, '-74.006000');

  listeners.gps();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(latitudeInput.value, '32.085300');
  assert.equal(longitudeInput.value, '34.781800');
  assert.match(locationStatus.textContent, /accuracy 18 m/);
  assert.deepEqual(clearedWatchIds, [12]);
});
