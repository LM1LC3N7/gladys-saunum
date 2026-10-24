// -----------------------------------------------------------------------------
// The sauna -> one Gladys device and its states (pure).
//
// `ext:<selector>:saunum:panel`: one panel per integration (one address in
// the configuration), a frozen key: a new address (a new DHCP lease, a
// replaced panel) keeps the same device and its history. The feature roles
// (the last part of their external ids) are published forever: never rename
// them. A republished device keeps every feature of the device already
// created.
//
// A sauna must never be turned on by an "everything on" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes): no switch, no writable binary for the
// session. The session state is read only (`unknown/binary`); turning on and
// turning off are two `button/push` features. The setpoint
// (`thermostat/target-temperature`) is writable, behind the same option as
// turning on. The light is a plain light (harmless).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on temperature-sensor and
// thermostat; % on humidity-sensor; minutes on duration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_KEY, DOOR_STATE, FEATURES, TEMPERATURE } from './constants.js';
import { DEVICE_NAME, FEATURE_NAMES, stateText, word } from './i18n.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

/** The features, by role, in display order. */
export const DEFINITIONS = {
  [FEATURES.SESSION]: binary,
  [FEATURES.STATE]: sensor({
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    keep_history: false,
  }),
  [FEATURES.TEMPERATURE]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -50,
    max: 200,
  }),
  [FEATURES.HUMIDITY]: sensor({
    category: C.HUMIDITY_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.PERCENT,
    min: 0,
    max: 100,
  }),
  [FEATURES.DOOR]: sensor({ category: C.OPENING_SENSOR, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [FEATURES.HEATERS]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 16 }),
  [FEATURES.ALARM]: binary,
  [FEATURES.TARGET]: {
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: TEMPERATURE.min,
    max: TEMPERATURE.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [FEATURES.REMAINING]: sensor({
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.MINUTES,
    min: 0,
    max: 100_000,
  }),
  [FEATURES.LIGHT]: {
    category: C.LIGHT,
    type: T.LIGHT.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [FEATURES.HEAT_ON]: button,
  [FEATURES.HEAT_OFF]: button,
};

export const ROLES = Object.keys(DEFINITIONS);
/** The writable roles. */
export const COMMAND_ROLES = [FEATURES.HEAT_ON, FEATURES.HEAT_OFF, FEATURES.TARGET, FEATURES.LIGHT];
/** The roles served by the registers 105-118 of a newer firmware only. */
const EXTENDED_ROLES = [FEATURES.HUMIDITY, FEATURES.REMAINING];

export const panelIds = (gladys) => gladys.externalIds('saunum', DEVICE_KEY);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:saunum:panel:([a-z0-9-]+)$/.exec(externalId);
  return match && ROLES.includes(match[1]) ? match[1] : undefined;
}

/**
 * The roles of the device: those every panel has, the extended ones when
 * the panel serves them, plus those of the device already created.
 */
export function rolesOf(data, created = new Set()) {
  return ROLES.filter(
    (role) => !EXTENDED_ROLES.includes(role) || data.extended || created.has(role),
  );
}

/** The Gladys device of the panel. */
export function buildDevice(gladys, data, { language, created }) {
  const ids = panelIds(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: ids.device,
    model: 'Saunum Leil',
    should_poll: false,
    features: rolesOf(data, created).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
    })),
  };
}

/**
 * The current values of the sauna: `[{ role, state }]` or `[{ role, text }]`.
 * A value unknown or outside the bounds of its feature is dropped (Gladys
 * keeps the last one). Never undefined, never NaN.
 */
export function statesOf(data, { language }) {
  const states = [];
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const bit = (value) => (value === undefined ? undefined : value ? 1 : 0);
  states.push({ role: FEATURES.STATE, text: word(stateText(data), language) });
  add(FEATURES.SESSION, bit(data.sessionActive));
  add(FEATURES.TEMPERATURE, data.temperature);
  add(FEATURES.HUMIDITY, data.humidity);
  if (data.doorOpen !== undefined) {
    add(FEATURES.DOOR, data.doorOpen ? DOOR_STATE.OPEN : DOOR_STATE.CLOSED);
  }
  add(FEATURES.HEATERS, data.heaters);
  add(FEATURES.ALARM, bit(data.alarm));
  // 0: the preset's setpoint (or a cooldown): not a temperature, not published.
  add(FEATURES.TARGET, data.target === 0 ? undefined : data.target);
  if (data.remainingSeconds !== undefined) {
    add(FEATURES.REMAINING, data.sessionActive ? Math.ceil(data.remainingSeconds / 60) : 0);
  }
  add(FEATURES.LIGHT, bit(data.light));
  return states;
}
