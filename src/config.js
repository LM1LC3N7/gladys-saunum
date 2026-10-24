// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. Nothing here is
// secret (the Saunum panel takes no password over Modbus).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, DEFAULT_UNIT, DURATION, POLL_INTERVAL, TEMPERATURE } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  unit_id: DEFAULT_UNIT,
  allow_heating: false,
  start_temperature: TEMPERATURE.defaultStart,
  max_temperature: TEMPERATURE.defaultMax,
  session_duration: DURATION.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of the panel typed by the user: an IPv4 address or a host
 * name, with an optional port (502 by default). A pasted URL is reduced to
 * its host and port.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  text = text.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    // Never a broadcast, multicast or "any" address.
    const first = Number(host.split('.')[0]);
    if (host === '0.0.0.0' || host === '255.255.255.255' || (first >= 224 && first <= 239)) {
      return undefined;
    }
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A whole number within [min, max], else `fallback`. */
function bounded(value, min, max, fallback) {
  const n = numberOf(value);
  if (n === undefined) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(DEFAULT_CONFIG, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  const unit = numberOf(c.unit_id);
  const maxTemperature = bounded(
    c.max_temperature,
    TEMPERATURE.min,
    TEMPERATURE.max,
    TEMPERATURE.defaultMax,
  );
  return {
    /** `{ host, port }`, or undefined while empty or invalid. */
    address,
    /** An address was typed but is not valid (never shown back: only said). */
    invalidAddress: typed !== '' && !address,
    /** The Modbus unit id, 1 to 247 (1 by default); an invalid one refuses the address. */
    unitId: Number.isInteger(unit) && unit >= 1 && unit <= 247 ? unit : undefined,
    allowHeating: strictTrue(c.allow_heating),
    /** The highest setpoint ever sent, 40 to 100 °C (90 by default). */
    maxTemperature,
    /** The setpoint of the "Turn on" button, never above the highest one. */
    startTemperature: Math.min(
      bounded(c.start_temperature, TEMPERATURE.min, TEMPERATURE.max, TEMPERATURE.defaultStart),
      maxTemperature,
    ),
    /** The session duration of the "Turn on" button, 60 to 720 min (60 by default). */
    sessionDuration: bounded(c.session_duration, DURATION.min, DURATION.max, DURATION.default),
    pollInterval: bounded(
      c.poll_interval,
      POLL_INTERVAL.min,
      POLL_INTERVAL.max,
      POLL_INTERVAL.default,
    ),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** Whether the configuration can be used to reach the panel. */
export const usable = (config) => Boolean(config.address && config.unitId !== undefined);

/** What identifies the panel connection, to tell a change. */
export const targetKey = (config) =>
  usable(config) ? `${config.address.host}:${config.address.port}/${config.unitId}` : '';
