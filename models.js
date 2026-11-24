class Teacher {
  constructor({ id, fullName, passwordHash }) {
    this.id = id;
    this.fullName = Teacher.validateName(fullName);
    this.passwordHash = passwordHash;
  }

  static validateName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 120) throw new Error('Teacher name must be 1-120 characters.');
    return name;
  }
}

class Manager {
  constructor({ id, fullName, passwordHash }) {
    this.id = id;
    this.fullName = Manager.validateName(fullName);
    this.passwordHash = passwordHash;
  }

  static validateName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 120) throw new Error('Manager name must be 1-120 characters.');
    return name;
  }
}

class Student {
  constructor({ id, fullName, email }) {
    this.id = id;
    this.fullName = Student.validateName(fullName);
    this.email = Student.validateEmail(email);
  }

  static validateName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 120) throw new Error('Student name must be 1-120 characters.');
    return name;
  }

  static validateEmail(value) {
    const email = typeof value === 'string' ? value.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('A valid student email address is required.');
    }
    return email;
  }
}

class Subject {
  constructor({ id, teacherId, name, classroomLatitude, classroomLongitude, geofenceRadiusMeters = 100 }) {
    this.id = id;
    this.teacherId = teacherId;
    this.name = Subject.validateName(name);
    this.classroomLatitude = classroomLatitude;
    this.classroomLongitude = classroomLongitude;
    this.geofenceRadiusMeters = Subject.validateRadius(geofenceRadiusMeters);
  }

  static validateName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 100) throw new Error('Subject name must be 1-100 characters.');
    return name;
  }

  static validateRadius(value) {
    const radius = Number(value);
    if (!Number.isInteger(radius) || radius < 10 || radius > 5000) {
      throw new Error('Geofence radius must be between 10 and 5000 meters.');
    }
    return radius;
  }
}

function distanceMeters(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(secondLatitude - firstLatitude);
  const longitudeDelta = toRadians(secondLongitude - firstLongitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(firstLatitude))
    * Math.cos(toRadians(secondLatitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, a));
  return 6371000 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

function evaluateLocation(subject, latitude, longitude, accuracyMeters, maximumAccuracyMeters = 100) {
  const coordinatesAreValid = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (!coordinatesAreValid || !Number.isFinite(accuracyMeters) || accuracyMeters < 0
    || accuracyMeters > maximumAccuracyMeters
    || subject.classroomLatitude === null || subject.classroomLatitude === undefined
    || subject.classroomLongitude === null || subject.classroomLongitude === undefined) {
    return { status: 'unavailable', distanceMeters: null };
  }
  const distance = distanceMeters(
    subject.classroomLatitude,
    subject.classroomLongitude,
    latitude,
    longitude,
  );
  return {
    status: distance <= subject.geofenceRadiusMeters ? 'inside' : 'outside',
    distanceMeters: Math.round(distance),
  };
}

module.exports = { Manager, Teacher, Student, Subject, distanceMeters, evaluateLocation };
