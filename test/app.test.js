// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Saunum panel, with
// the exact wiring of the container (src/handlers.js) and a mocked clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaunumApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, fakePanel, settle } from './fixtures/fakePanel.js';

const CFG = { address: HOST };
const HEAT_CFG = { ...CFG, allow_heating: true };
const DEVICE = 'ext:test-integration:saunum:panel';
const feature = (role) => `${DEVICE}:${role}`;

/** The ack of a command: { ok: true } or { error }. */
const outcome = (ack) => (ack.success ? { ok: true } : { error: String(ack.error) });

async function setup(
  t,
  { config = CFG, panel = fakePanel(), store = memoryStore(), create = true, now = NOW } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const gladys = createFakeGladys({ config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => logs.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new SaunumApp({
    gladys,
    logger,
    connect: panel.connect,
    now: () => Date.now(),
    mono: () => Date.now(),
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 50) => {
    for (let e = 0; e < ms; e += step) {
      t.mock.timers.tick(Math.min(step, ms - e));
      await settle(5);
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(3 * SECOND);
  await connecting;
  t.after(() => app.stop());
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const fire = (role, value = 1) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE) ?? {
      external_id: DEVICE,
    };
    return gladys.fake.setValue(device, { external_id: feature(role) }, value);
  };
  /** Presses and lets the clock run: the ack ({ ok } or { error }). */
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = fire(role, value).then(outcome);
    await advance(wait);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  return { gladys, app, panel, advance, logs, fire, press, store, state };
}

test('discovery: one device, the extended features, its states once created', async (t) => {
  const { gladys, state, panel } = await setup(t);
  const device = gladys.fake.discoveredDevices[0];
  assert.equal(device.external_id, DEVICE);
  const roles = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(roles, [
    'session',
    'state',
    'temperature',
    'humidity',
    'door',
    'heaters',
    'alarm',
    'target-temperature',
    'remaining',
    'light',
    'heat-on',
    'heat-off',
  ]);
  // No switch, no writable binary for the session.
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch');
    if (f.read_only === false) {
      assert.ok(['button', 'thermostat', 'light'].includes(f.category), f.external_id);
    }
  }
  assert.equal(state('temperature').state, 22);
  assert.equal(state('humidity').state, 30);
  assert.equal(state('door').state, 1);
  assert.equal(state('session').state, 0);
  assert.equal(state('target-temperature').state, 85);
  assert.equal(state('state').text, 'En veille');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: DEVICE,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
  // Three requests, 500 ms apart at least, one connection.
  const reads = panel.requests;
  assert.deepEqual(
    reads.map((r) => [r.address, r.count]),
    [
      [0, 7],
      [100, 19],
      [200, 6],
    ],
  );
  for (let i = 1; i < reads.length; i += 1) {
    assert.ok(reads[i].at - reads[i - 1].at >= 500, 'spacing');
  }
  assert.equal(panel.maxOpen, 1);
});

test('an older firmware: registers 100-104 only, no humidity nor time left', async (t) => {
  const panel = fakePanel({ extended: false });
  const { gladys, state } = await setup(t, { panel });
  const roles = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(!roles.includes('humidity') && !roles.includes('remaining'));
  assert.equal(state('state').text, 'Arrêté');
  assert.deepEqual(
    panel.requests.map((r) => [r.address, r.count]),
    [
      [0, 7],
      [100, 19],
      [100, 5],
      [200, 6],
    ],
  );
});

test('turn on is refused while heating is not allowed: nothing written', async (t) => {
  const { panel, press } = await setup(t);
  const ack = await press('heat-on');
  assert.match(ack.error, /chauffage depuis Gladys est désactivé/);
  assert.match(ack.error, /Rien envoyé/);
  assert.deepEqual(panel.writes(), []);
});

test('turn on: fresh read, setpoint and duration of the configuration, then the start', async (t) => {
  const { panel, press, state, advance } = await setup(t, { config: HEAT_CFG });
  const before = panel.requests.length;
  const ack = await press('heat-on');
  assert.deepEqual(ack, { ok: true });
  const after = panel.requests.slice(before);
  assert.deepEqual(
    after.slice(0, 6).map((r) => [r.fn, r.address, r.value ?? r.count]),
    [
      [3, 0, 7],
      [3, 100, 19],
      [3, 200, 6],
      [6, 4, 80],
      [6, 2, 60],
      [6, 0, 1],
    ],
  );
  await advance(6 * SECOND);
  assert.equal(state('session').state, 1);
});

test('turn on refused when the door is open, when an alarm is on, or a start is blocked', async (t) => {
  const { panel, press } = await setup(t, { config: HEAT_CFG });
  panel.set(104, 1);
  assert.match((await press('heat-on')).error, /porte du sauna est ouverte/);
  panel.set(104, 0);
  panel.set(202, 1);
  assert.match((await press('heat-on')).error, /alarme est active/);
  panel.set(202, 2);
  assert.match((await press('heat-on')).error, /incomplet/);
  panel.set(202, 0);
  panel.set(118, 0x40);
  assert.match((await press('heat-on')).error, /0x40/);
  assert.deepEqual(panel.writes(), []);
});

test('the setpoint: bounded by the highest one, written alone', async (t) => {
  const { panel, press } = await setup(t, { config: { ...HEAT_CFG, max_temperature: 90 } });
  assert.match((await press('target-temperature', 95)).error, /de 40 à 90 °C/);
  assert.match((await press('target-temperature', '')).error, /de 40 à 90 °C/);
  assert.deepEqual(panel.writes(), []);
  assert.deepEqual(await press('target-temperature', 75), { ok: true });
  assert.deepEqual(panel.writes(), [[4, 75]]);
});

test('turn off: never held back (option off), one write ahead of the queued reads', async (t) => {
  const panel = fakePanel({ delay: 200 });
  const { app, fire, advance, press } = await setup(t, { panel });
  panel.set(0, 1);
  panel.requests.length = 0;
  // A read starts; the turn off arrives while its first request is on the wire.
  const reading = app.tick();
  await advance(100);
  const ack = fire('heat-off').then(outcome);
  await advance(5 * SECOND);
  await reading;
  assert.deepEqual(await ack, { ok: true });
  assert.deepEqual(
    panel.requests.slice(0, 2).map((r) => [r.fn, r.address]),
    [
      [3, 0],
      [6, 0],
    ],
    'only the request already on the wire went before it',
  );
  assert.equal(panel.holding.get(0), 0);
  const second = await press('heat-off');
  assert.deepEqual(second, { ok: true });
  assert.equal(panel.writes().length, 2, 'never "already off": always written');
});

test('turn off works before the first read after a restart', async (t) => {
  const panel = fakePanel();
  panel.down = true;
  const { press, gladys } = await setup(t, { panel, create: false });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  panel.down = false;
  const ack = await press('heat-off');
  assert.deepEqual(ack, { ok: true });
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

test('a turn off during the fresh read of a start: the start gives way', async (t) => {
  const panel = fakePanel({ delay: 300 });
  const { fire, advance } = await setup(t, { config: HEAT_CFG, panel });
  const start = fire('heat-on').then(outcome);
  await advance(200);
  const stop = fire('heat-off');
  await advance(6 * SECOND);
  assert.match(
    (await start).error,
    /extinction a été demandée entre-temps|extinction est en cours/,
  );
  await stop;
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

test('a start without answer, then a turn off: sent again when the sauna heats', async (t) => {
  const panel = fakePanel({
    behave: (r) => (r.fn === 6 && r.address === 0 && r.value === 1 ? 'silent' : undefined),
  });
  panel.set(4, 80);
  panel.set(2, 60);
  const { fire, advance, store } = await setup(t, { config: HEAT_CFG, panel });
  const start = fire('heat-on').then(outcome);
  await advance(5 * SECOND);
  assert.match((await start).error, /sans confirmation/);
  // The start landed late (the panel applied it without answering).
  panel.set(0, 1);
  panel.set(109, 3);
  panel.behave = undefined;
  const stop = fire('heat-off');
  await advance(4 * SECOND);
  await stop;
  assert.ok(store.data.stopGuard, 'the sticky guard is kept in /data');
  // The start lands after the turn off: the next read sends the turn off again.
  panel.set(0, 1);
  panel.set(109, 3);
  await advance(30 * SECOND);
  const stops = panel.writes().filter(([a, v]) => a === 0 && v === 0);
  assert.ok(stops.length >= 2, `turn offs: ${stops.length}`);
  assert.equal(panel.holding.get(0), 0);
});

test('the light: a plain write; strict values', async (t) => {
  const { panel, press } = await setup(t);
  assert.match((await press('light', 'on')).error, /0 ou 1/);
  assert.deepEqual(await press('light', 1), { ok: true });
  assert.deepEqual(panel.writes(), [[6, 1]]);
});

test('read-only features and other devices refuse', async (t) => {
  const { gladys } = await setup(t);
  const readOnly = await gladys.fake.setValue(
    { external_id: DEVICE },
    { external_id: feature('temperature') },
    1,
  );
  assert.match(outcome(readOnly).error, /ne peut pas être commandée/);
  const other = await gladys.fake.setValue(
    { external_id: 'ext:other:saunum:panel' },
    { external_id: 'ext:other:saunum:panel:heat-off' },
    1,
  );
  assert.match(outcome(other).error, /pas le panneau/);
});

test('not a Saunum panel (a session register of 2): nothing published, read failed', async (t) => {
  const panel = fakePanel();
  panel.set(0, 2);
  const { gladys } = await setup(t, { panel });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /invalid data/);
});

test('a restart never reads sooner than the interval after the last read', async (t) => {
  const store = memoryStore({ lastAttemptAt: NOW - 10 * SECOND });
  const panel = fakePanel();
  const { advance } = await setup(t, { store, panel, create: false });
  assert.equal(panel.requests.length, 0);
  // Kept at most once a minute: the last read may have left up to a minute later.
  await advance(20 * SECOND);
  assert.equal(panel.requests.length, 0);
  await advance(10 * SECOND);
  assert.ok(panel.requests.length > 0);
});

test('the test button never reads sooner than the interval', async (t) => {
  const { app, panel } = await setup(t);
  const count = panel.requests.length;
  const message = await app.testConnection();
  assert.equal(panel.requests.length, count);
  assert.match(message.fr ?? message, /Prochaine lecture/);
});

test('a new address: the old connection closes before the new one opens', async (t) => {
  const { gladys, panel, advance } = await setup(t);
  panel.requests.length = 0;
  const updating = gladys.fake.configUpdated({ address: '192.168.1.81' });
  await advance(5 * SECOND);
  await updating;
  assert.equal(panel.maxOpen, 1);
  assert.deepEqual(panel.connects.at(-1), { host: '192.168.1.81', port: 502 });
});

test('the idle connection is closed before the panel closes it (20 s)', async (t) => {
  const { panel, advance } = await setup(t);
  assert.equal(panel.open, 1);
  await advance(11 * SECOND);
  assert.equal(panel.open, 0);
});

test('a failing panel: backoff, unreachable badge, turn off still sent', async (t) => {
  const { panel, gladys, advance, press } = await setup(t);
  panel.down = true;
  panel.sockets.at(-1)?.destroy();
  await advance(31 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /ne répond pas/);
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  panel.down = false;
  assert.deepEqual(await press('heat-off'), { ok: true });
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

test('a sticky turn off guard kept in /data still acts after a restart (same panel only)', async (t) => {
  const panel = fakePanel();
  panel.set(0, 1);
  panel.set(109, 3);
  const store = memoryStore({
    stopGuard: { until: NOW + MINUTE, reasserts: 0, target: `${HOST}:502/1` },
  });
  await setup(t, { panel, store });
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

test('a guard of another panel is ignored', async (t) => {
  const panel = fakePanel();
  panel.set(0, 1);
  panel.set(109, 3);
  const store = memoryStore({
    stopGuard: { until: NOW + MINUTE, reasserts: 0, target: '10.9.9.9:502/1' },
  });
  await setup(t, { panel, store });
  assert.deepEqual(panel.writes(), []);
});
