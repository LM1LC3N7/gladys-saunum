// -----------------------------------------------------------------------------
// The pure parts: configuration, register parser, device and states, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, targetKey, usable } from '../src/config.js';
import { STATE, TIMINGS } from '../src/constants.js';
import { statesOf } from '../src/devices.js';
import { coolingDown, heatingOn, parsePanel } from '../src/saunum.js';
import { normalizeMemory } from '../src/store.js';
import { panelRegisters } from './fixtures/fakePanel.js';

const words = (registers = panelRegisters(), { extended = true } = {}) => {
  const at = (from, count) => Array.from({ length: count }, (_, i) => registers[from + i] ?? 0);
  return { control: at(0, 7), status: at(100, extended ? 19 : 5), alarms: at(200, 6) };
};

test('the address: IPv4 or host name, optional port; never broadcast or multicast', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress(' Sauna.local:1502 '), { host: 'sauna.local', port: 1502 });
  assert.deepEqual(parseAddress('modbus://10.0.0.2/'), { host: '10.0.0.2', port: 502 });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '1.2.3',
    'a b',
    'host:0',
    'host:70000',
    'user@host',
    'sauna\n.local',
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
});

test('the configuration: heating off by default, bounds, strict values', () => {
  const c = normalizeConfig({ address: '10.0.0.2' });
  assert.equal(c.allowHeating, false);
  assert.equal(c.maxTemperature, 90);
  assert.equal(c.startTemperature, 80);
  assert.equal(c.sessionDuration, 60);
  assert.equal(c.pollInterval, 30);
  assert.equal(c.unitId, 1);
  assert.ok(usable(c));
  assert.equal(targetKey(c), '10.0.0.2:502/1');
  assert.equal(normalizeConfig({ allow_heating: 'yes' }).allowHeating, false);
  assert.equal(normalizeConfig({ allow_heating: 'true' }).allowHeating, true);
  const high = normalizeConfig({
    max_temperature: 150,
    start_temperature: 120,
    session_duration: 5000,
    poll_interval: 1,
  });
  assert.equal(high.maxTemperature, 100);
  assert.equal(high.startTemperature, 100);
  assert.equal(high.sessionDuration, 720);
  assert.equal(high.pollInterval, 10);
  const capped = normalizeConfig({ max_temperature: 70, start_temperature: 95 });
  assert.equal(capped.startTemperature, 70, 'never above the highest setpoint');
  assert.equal(normalizeConfig({ max_temperature: '' }).maxTemperature, 90, "'' is not 0");
  assert.equal(normalizeConfig({ unit_id: 0, address: '10.0.0.2' }).unitId, undefined);
  assert.equal(usable(normalizeConfig({ unit_id: 300, address: '10.0.0.2' })), false);
  assert.equal(normalizeConfig({ address: 'not valid!' }).invalidAddress, true);
});

test('the parser: a panel at rest, newer firmware', () => {
  const data = parsePanel(words());
  assert.equal(data.sessionActive, false);
  assert.equal(data.doorOpen, false);
  assert.equal(data.temperature, 22);
  assert.equal(data.humidity, 30);
  assert.equal(data.target, 85);
  assert.equal(data.duration, 120);
  assert.equal(data.state, STATE.STANDBY);
  assert.equal(data.alarm, false);
  assert.equal(data.startBlock, 0);
  assert.equal(heatingOn(data), false);
});

test('the parser: strict values; unknown is never a value', () => {
  const r = panelRegisters();
  r[100] = 0xfff6; // -10 °C
  r[4] = 120; // not a setpoint the panel documents
  r[6] = 3;
  r[109] = 9;
  r[117] = 1;
  r[118] = 2;
  r[201] = 7;
  const data = parsePanel(words(r));
  assert.equal(data.temperature, -10);
  assert.equal(data.target, undefined);
  assert.equal(data.light, undefined);
  assert.equal(data.state, undefined);
  assert.equal(data.startBlock, 0x10002);
  assert.equal(data.alarm, undefined, 'an alarm word of 7 is unknown, not "no alarm"');
  for (const [address, value] of [
    [0, 2],
    [104, 5],
  ]) {
    const bad = panelRegisters();
    bad[address] = value;
    assert.throws(() => parsePanel(words(bad)), { kind: 'invalid' });
  }
  assert.throws(() => parsePanel({ control: [], status: [], alarms: [] }), { kind: 'invalid' });
});

test('cooldown and heating, with and without the register 109', () => {
  const r = panelRegisters();
  r[0] = 1;
  r[109] = STATE.COOLDOWN;
  assert.equal(coolingDown(parsePanel(words(r))), true);
  assert.equal(heatingOn(parsePanel(words(r))), false);
  r[109] = STATE.HEATING;
  assert.equal(heatingOn(parsePanel(words(r))), true);
  const old = panelRegisters();
  old[0] = 1;
  old[4] = 0;
  const data = parsePanel(words(old, { extended: false }));
  assert.equal(data.extended, false);
  assert.equal(coolingDown(data), true, 'session on with a setpoint of 0');
  old[4] = 80;
  assert.equal(heatingOn(parsePanel(words(old, { extended: false }))), true);
});

test('the states: never undefined nor NaN; setpoint 0 not published', () => {
  const r = panelRegisters();
  r[4] = 0;
  r[0] = 1;
  r[107] = 125;
  const states = statesOf(parsePanel(words(r)), { language: 'en' });
  for (const s of states) {
    assert.ok(s.text !== undefined || Number.isFinite(s.state), JSON.stringify(s));
  }
  assert.ok(!states.some((s) => s.role === 'target-temperature'));
  assert.equal(states.find((s) => s.role === 'remaining').state, 3);
  assert.equal(states.find((s) => s.role === 'door').state, 1);
});

test('/data: repaired and bounded; a guard never longer than 2 min', () => {
  const now = 1_000_000;
  const empty = { lastAttemptAt: null, stopGuard: null, launch: null };
  assert.deepEqual(normalizeMemory(null, now), empty);
  assert.deepEqual(normalizeMemory('garbage', now), empty);
  const m = normalizeMemory(
    {
      lastAttemptAt: now + 5000,
      stopGuard: { until: now + 10 * TIMINGS.guard, reasserts: 99, target: '10.0.0.2:502/1' },
    },
    now,
  );
  assert.equal(m.lastAttemptAt, now);
  assert.equal(m.stopGuard.until, now + TIMINGS.guard);
  assert.equal(m.stopGuard.reasserts, TIMINGS.stopReasserts);
  assert.equal(
    normalizeMemory({ stopGuard: { until: now + 1000, target: 'a\nb' } }, now).stopGuard,
    null,
  );
  assert.equal(
    normalizeMemory({ stopGuard: { until: now - 1, target: 'x' } }, now).stopGuard,
    null,
  );
});
