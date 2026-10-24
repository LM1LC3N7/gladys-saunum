// -----------------------------------------------------------------------------
// Saunum constants: Modbus registers, limits and timings.
//
// The control panel of a Saunum Leil sauna answers Modbus TCP on the local
// network (port 502, unit 1, no authentication), as the `pysaunum` Python
// library (MIT, mettolen/pysaunum, the library of the Saunum integration of
// Home Assistant) reads and writes it. The register map below is a port of
// its `const.py` (see THIRD_PARTY_NOTICES.md).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;
export const DEFAULT_UNIT = 1;

/** Holding registers (read / write): the session parameters. */
export const REG = {
  /** 0 off, 1 on: the sauna session (heating). */
  SESSION_ACTIVE: 0,
  SAUNA_TYPE: 1,
  /** Session duration in minutes (60 to 720 on a private sauna), 0: the preset's. */
  SAUNA_DURATION: 2,
  FAN_DURATION: 3,
  /** Setpoint in °C (40 to 100), 0: the preset's (or a cooldown). */
  TARGET_TEMPERATURE: 4,
  FAN_SPEED: 5,
  /** 0 off, 1 on. */
  LIGHT: 6,
  /** Status: temperature, on time (2 words), heater elements, door. */
  STATUS: 100,
  /** Newer firmware: humidity ... start-block reasons (105 to 118). */
  STATUS_EXTENDED: 105,
  /** Alarms: door open while heating, door open too long, thermal cutoff, internal overheating, sensor short, sensor open. */
  ALARMS: 200,
};

/** How many registers each block holds. */
export const COUNT = {
  CONTROL: 7,
  STATUS: 5,
  STATUS_FULL: 19,
  ALARMS: 6,
};

/** Register 109 (newer firmware): the controller state. */
export const STATE = {
  STANDBY: 1,
  SCHEDULED: 2,
  HEATING: 3,
  READY: 4,
  COOLDOWN: 5,
  WAITING_FOR_DOOR: 6,
};

/**
 * The setpoints the panel accepts (pysaunum MIN_TEMPERATURE,
 * MAX_TEMPERATURE), in °C. The integration never asks for more than the
 * "Highest setpoint" of the configuration (90 °C by default).
 */
export const TEMPERATURE = {
  min: 40,
  max: 100,
  defaultStart: 80,
  defaultMax: 90,
};

/**
 * The session duration written by the "Turn on" button, in minutes: 60 to
 * 720 (the private sauna range of pysaunum), 60 by default.
 */
export const DURATION = {
  min: 60,
  max: 720,
  default: 60,
};

/** Feature roles (the last part of the feature external ids): frozen forever. */
export const FEATURES = {
  SESSION: 'session',
  STATE: 'state',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  DOOR: 'door',
  HEATERS: 'heaters',
  ALARM: 'alarm',
  TARGET: 'target-temperature',
  REMAINING: 'remaining',
  LIGHT: 'light',
  HEAT_ON: 'heat-on',
  HEAT_OFF: 'heat-off',
};

/** The one device of the integration (one panel per integration): frozen forever. */
export const DEVICE_KEY = 'panel';

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** OPENING_SENSOR_STATE of the core: 0 open, 1 closed. */
export const DOOR_STATE = { OPEN: 0, CLOSED: 1 };

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 10,
  max: 600,
  default: 30,
};

export const LIMITS = {
  /** Gladys: 300 states per minute, for the whole integration (some room kept). */
  statesPerMinute: 280,
  statesPerRequest: 100,
  /** Modbus TCP: 7 bytes of MBAP header + a PDU of 253 bytes at most. */
  frameBytes: 260,
  /** Registers in one read (Modbus: 125 at most). */
  registersPerRead: 125,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** Opening the TCP connection to the panel. */
  connectTimeout: 3 * SECOND,
  /** One Modbus request of the polling (pysaunum: at least 2 s). */
  requestTimeout: 3 * SECOND,
  /** pysaunum: at least 500 ms between two Modbus requests. */
  requestSpacing: 500,
  /** The panel closes an idle connection after 20 s: we close it first. */
  idleClose: 10 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** An older firmware without the registers 105 to 118: asked again this often. */
  extendedRetry: 30 * MINUTE,
  /** The time of the last read is written to /data at most this often. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the writes
   * of a heating command must leave by 3.5 s after the click, or the command
   * is refused (the session never started); every answer is awaited until
   * 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** A turn off keeps going after the ack, this long at most. */
  protectTimeout: 15 * SECOND,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command that may still land (sent, no answer) keeps its guard this long. */
  guard: 2 * MINUTE,
  /** A turn off sent again at most this often while a start may land after it. */
  stopReasserts: 3,
  /** A setpoint is refused this long after a turn off. */
  setpointAfterStop: 2 * MINUTE,
  /** "Nothing to send" may be decided on a read this recent (never a decision to send). */
  recentRead: 5 * SECOND,
};
