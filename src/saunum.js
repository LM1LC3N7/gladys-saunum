// -----------------------------------------------------------------------------
// The Saunum panel over Modbus: what is read, and how its registers become
// the state of the sauna (pure parser). A port of `SaunumClient.async_get_data`
// of pysaunum (MIT, see THIRD_PARTY_NOTICES.md): registers 0-6 (session
// parameters), 100-104 (status; 100-118 on newer firmware, with the humidity,
// the time left and the controller state) and 200-205 (alarms).
//
// Strict: a value outside what the panel documents is UNKNOWN (undefined),
// never coerced (a register 2 is not "on"). A read where the session or the
// door is unknown is refused as a whole (not a Saunum panel, or a damaged
// answer): nothing is published, no command decides on it.
// -----------------------------------------------------------------------------

import { COUNT, DURATION, REG, STATE, TEMPERATURE } from './constants.js';
import { ERROR_KINDS, ILLEGAL_DATA_ADDRESS, ModbusError } from './modbus/client.js';

/** A Modbus answer that does not look like a Saunum panel. */
export class InvalidDataError extends Error {
  constructor(detail) {
    super('invalid data');
    this.kind = 'invalid';
    this.detail = detail;
  }
}

const flag = (word) => (word === 0 ? false : word === 1 ? true : undefined);
const int16 = (word) => (word >= 0x8000 ? word - 0x10000 : word);
const within = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/**
 * The state of the sauna from the raw words: `control` (7 words from 0),
 * `status` (5 or 19 words from 100), `alarms` (6 words from 200).
 */
export function parsePanel({ control, status, alarms }) {
  if (
    !Array.isArray(control) ||
    control.length !== COUNT.CONTROL ||
    !Array.isArray(status) ||
    (status.length !== COUNT.STATUS && status.length !== COUNT.STATUS_FULL) ||
    !Array.isArray(alarms) ||
    alarms.length !== COUNT.ALARMS
  ) {
    throw new InvalidDataError('length');
  }
  const sessionActive = flag(control[0]);
  const doorOpen = flag(status[4]);
  if (sessionActive === undefined || doorOpen === undefined) {
    throw new InvalidDataError('session or door');
  }
  const target = control[4] === 0 ? 0 : within(control[4], TEMPERATURE.min, TEMPERATURE.max);
  const duration = control[2] === 0 ? 0 : within(control[2], DURATION.min, 1080);
  const temperature = within(int16(status[0]), -50, 200);
  const alarmFlags = alarms.map(flag);
  const data = {
    sessionActive,
    saunaType: control[1],
    /** Session duration in minutes, 0: the preset's; undefined: not a documented value. */
    duration,
    /** Setpoint in °C, 0: the preset's or a cooldown; undefined: not a documented value. */
    target,
    light: flag(control[6]),
    temperature,
    heaters: within(status[3], 0, 16),
    doorOpen,
    /** True when one alarm is on; undefined when one alarm word is not 0 or 1. */
    alarm: alarmFlags.some((a) => a === true)
      ? true
      : alarmFlags.every((a) => a === false)
        ? false
        : undefined,
    alarms: alarmFlags,
    extended: status.length === COUNT.STATUS_FULL,
    humidity: undefined,
    /** Register 106: the duration of the active session in minutes (0 when inactive). */
    activeDuration: undefined,
    remainingSeconds: undefined,
    state: undefined,
    startBlock: undefined,
    /** Whether every register read holds a value a Saunum panel documents. */
    fingerprint: false,
  };
  if (data.extended) {
    data.humidity = within(status[5], 0, 100);
    data.activeDuration = within(status[6], 0, 1080);
    data.remainingSeconds = within(status[7], 0, 0xffff);
    data.state = within(status[9], STATE.STANDBY, STATE.WAITING_FOR_DOOR);
    // A 32-bit mask (high word first): 0 means nothing blocks a start.
    data.startBlock = status[17] * 0x10000 + status[18];
  }
  data.fingerprint = fingerprintOk(control, status, data);
  return data;
}

/**
 * The strict fingerprint of a Saunum panel, required before any write but a
 * turn off: every register read within the range pysaunum documents (fan
 * duration up to 30 min: the range of pysaunum 0.7.0, 20 on the main branch;
 * sauna type: a preset index, bounded to 0-31 here).
 */
function fingerprintOk(control, status, data) {
  const ok =
    within(control[1], 0, 31) !== undefined &&
    data.duration !== undefined &&
    within(control[3], 0, 30) !== undefined &&
    data.target !== undefined &&
    within(control[5], 0, 3) !== undefined &&
    data.light !== undefined &&
    data.temperature !== undefined &&
    data.heaters !== undefined &&
    data.alarms.every((a) => a !== undefined);
  if (!ok || !data.extended) {
    return ok;
  }
  return (
    data.state !== undefined &&
    data.humidity !== undefined &&
    data.activeDuration !== undefined &&
    flag(status[10]) !== undefined &&
    flag(status[11]) !== undefined
  );
}

/**
 * Whether the panel is cooling down: register 109 says so (newer firmware),
 * or, without it, the session is on with a setpoint of 0 (pysaunum).
 */
export function coolingDown(data) {
  if (data.state !== undefined) {
    return data.state === STATE.COOLDOWN;
  }
  return data.sessionActive === true && data.target === 0;
}

/** Whether the sauna heats or is ready (a session on, not cooling down). */
export function heatingOn(data) {
  if (!data.sessionActive) {
    return false;
  }
  if (data.state !== undefined) {
    return data.state !== STATE.COOLDOWN;
  }
  return data.target !== 0;
}

/**
 * Reads the panel: three requests, each its own job in the queue (a turn
 * off passes between them). `extended`: whether to ask registers 100-118
 * (false on an older firmware that refused them). Returns the words and
 * whether the extended block was refused.
 */
export async function readPanel(client, { extended = true, ...options } = {}) {
  const control = await client.readHolding(REG.SESSION_ACTIVE, COUNT.CONTROL, options);
  let status;
  let refusedExtended = false;
  if (extended) {
    try {
      status = await client.readHolding(REG.STATUS, COUNT.STATUS_FULL, options);
    } catch (err) {
      if (
        !(err instanceof ModbusError) ||
        err.kind !== ERROR_KINDS.EXCEPTION ||
        err.code !== ILLEGAL_DATA_ADDRESS
      ) {
        throw err;
      }
      refusedExtended = true;
    }
  }
  if (!status) {
    status = await client.readHolding(REG.STATUS, COUNT.STATUS, options);
  }
  const alarms = await client.readHolding(REG.ALARMS, COUNT.ALARMS, options);
  return { words: { control, status, alarms }, refusedExtended };
}
