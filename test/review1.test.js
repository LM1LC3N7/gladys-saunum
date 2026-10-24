// -----------------------------------------------------------------------------
// The fixes of review 1, one scenario (or more) per point of the review.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaunumApp } from '../src/app.js';
import { MINUTE, SECOND } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, fakePanel, settle } from './fixtures/fakePanel.js';
import { CFG, HEAT_CFG, feature, outcome, setup } from './fixtures/harness.js';

const status = (gladys) => gladys.fake.connectionStatus.message?.fr ?? '';
const stops = (panel) => panel.writes().filter(([a, v]) => a === 0 && v === 0).length;

// --- 1. A start is checked on the reads ----------------------------------------

for (const [name, onStart] of [
  [
    'the preset applied at the start',
    (p) => {
      p.set(4, 100);
      p.set(2, 0);
      p.set(107, 720 * 60);
      p.set(106, 720);
    },
  ],
  ['the duration back to 0', (p) => p.set(2, 0)],
  ['a setpoint above the highest one', (p) => p.set(4, 95)],
]) {
  test(`1. a start not kept as written is turned off: ${name}`, async (t) => {
    const panel = fakePanel({ onStart });
    const { press, advance, gladys } = await setup(t, { config: HEAT_CFG, panel });
    assert.deepEqual(await press('heat-on'), { ok: true });
    await advance(10 * SECOND);
    assert.ok(stops(panel) >= 1, 'turned off');
    assert.equal(panel.holding.get(0), 0);
    assert.match(status(gladys), /Attention : la séance lancée depuis Gladys/);
  });
}

test('1. a start kept as written: verified, never turned off', async (t) => {
  const { press, advance, panel, gladys } = await setup(t, { config: HEAT_CFG });
  assert.deepEqual(await press('heat-on'), { ok: true });
  await advance(2 * MINUTE);
  assert.equal(stops(panel), 0);
  assert.equal(panel.holding.get(0), 1);
  assert.doesNotMatch(status(gladys), /Attention/);
});

test('1. a start no read can check within a minute is turned off', async (t) => {
  const { press, advance, panel, gladys } = await setup(t, { config: HEAT_CFG });
  assert.deepEqual(await press('heat-on'), { ok: true });
  // The reads get no answer from now on; the writes still do.
  panel.behave = (r) => (r.fn === 3 ? 'silent' : undefined);
  await advance(70 * SECOND);
  assert.ok(stops(panel) >= 1);
  assert.match(status(gladys), /pas pu être vérifiée/);
});

// --- 2. The fingerprint of the panel --------------------------------------------

test('2. another device at the address: turn on, setpoint and light refused; turn off written', async (t) => {
  const panel = fakePanel();
  panel.set(5, 77);
  const { press } = await setup(t, { config: HEAT_CFG, panel });
  for (const [role, value] of [
    ['heat-on', 1],
    ['target-temperature', 70],
    ['light', 1],
  ]) {
    assert.match((await press(role, value)).error, /ne ressemble pas à un panneau Saunum/, role);
  }
  assert.deepEqual(panel.writes(), []);
  assert.deepEqual(await press('heat-off'), { ok: true });
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

test('2. a newer panel that stops serving 105-118 is not downgraded: heating refused', async (t) => {
  const panel = fakePanel();
  const { press } = await setup(t, { config: HEAT_CFG, panel });
  panel.extended = false;
  assert.match((await press('heat-on')).error, /ne sert plus les registres 105 à 118/);
  assert.deepEqual(panel.writes(), []);
});

// --- 3. One connection at a time ------------------------------------------------

test('3. a connection still being opened is destroyed and awaited before the next client connects', async (t) => {
  const panel = fakePanel();
  const { app, gladys, advance, fire } = await setup(t, { config: HEAT_CFG, panel });
  // A slow connection: the idle one closed, the next one takes 2.5 s.
  await advance(11 * SECOND);
  panel.connectDelay = 2500;
  const ack = fire('heat-on').then(outcome);
  await advance(500);
  const updating = gladys.fake.configUpdated({ ...HEAT_CFG, unit_id: 2 });
  await advance(10 * SECOND);
  await updating;
  await ack;
  assert.equal(panel.maxOpen, 1);
  void app;
});

// --- 4. "Sent" only when it left ------------------------------------------------

test('4. a turn off behind a write on the wire and a slow reconnection: "not sent yet", then it leaves', async (t) => {
  const panel = fakePanel();
  const { fire, advance } = await setup(t, { config: HEAT_CFG, panel });
  // A setpoint whose write gets no answer: the turn off waits for it (a write is never cut).
  panel.behave = (r) => (r.fn === 6 && r.address === 4 ? 'silent' : undefined);
  const setpoint = fire('target-temperature', 70).then(outcome);
  for (let i = 0; i < 100 && !panel.requests.some((r) => r.fn === 6); i += 1) {
    await advance(50);
  }
  panel.connectDelay = 2500;
  const ack = fire('heat-off').then(outcome);
  await advance(4500);
  assert.match((await ack).error, /Pas encore envoyée/);
  assert.equal(stops(panel), 0);
  await advance(5 * SECOND);
  assert.equal(stops(panel), 1);
  assert.match((await setpoint).error, /sans confirmation/);
});

test('4. a turn off to a panel refusing connections: "not sent", check the sauna', async (t) => {
  const panel = fakePanel();
  const { press, advance } = await setup(t, { panel });
  await advance(11 * SECOND);
  panel.down = true;
  const ack = await press('heat-off');
  assert.match(ack.error, /Non envoyée \(unreachable\)/);
  assert.match(ack.error, /Vérifiez le sauna/);
});

// --- 5. A turn off verified by the reads ----------------------------------------

test('5. an echo without effect: sent again (3 at most), warning in the status', async (t) => {
  const panel = fakePanel({
    behave: (r) => (r.fn === 6 && r.address === 0 && r.value === 0 ? 'echo-only' : undefined),
  });
  panel.set(0, 1);
  panel.set(109, 3);
  const { press, advance, gladys } = await setup(t, { panel });
  assert.deepEqual(await press('heat-off'), { ok: true });
  await advance(2 * MINUTE);
  assert.equal(stops(panel), 4, 'the turn off and 3 more');
  assert.match(status(gladys), /extinction n’a pas pris effet/);
});

test('5. a turn off that took effect: the guard is lifted by the read, heating allowed again', async (t) => {
  const panel = fakePanel();
  const { press, advance } = await setup(t, { config: HEAT_CFG, panel });
  assert.deepEqual(await press('heat-off'), { ok: true });
  await advance(3 * SECOND);
  assert.deepEqual(await press('heat-on'), { ok: true });
});

// --- 6. The sticky guard acts after a restart, whatever the interval -------------

test('6. a sticky guard restored from /data: reads within its lifetime (interval 600 s)', async (t) => {
  const panel = fakePanel();
  panel.set(0, 1);
  panel.set(109, 3);
  const store = memoryStore({
    lastAttemptAt: NOW - 5 * SECOND,
    stopGuard: { until: NOW + 100 * SECOND, reasserts: 0, target: `${HOST}:502/1` },
  });
  const { advance } = await setup(t, {
    config: { ...CFG, poll_interval: 600 },
    panel,
    store,
    create: false,
  });
  assert.equal(stops(panel), 0);
  await advance(60 * SECOND);
  assert.ok(stops(panel) >= 1, 'sent again before the end of the guard');
});

// --- 7. Never a stale value ------------------------------------------------------

test('7. 65 min of failed reads: no state published', async (t) => {
  const { panel, advance, gladys } = await setup(t);
  const count = gladys.fake.states.length;
  panel.down = true;
  panel.sockets.at(-1)?.destroy();
  await advance(65 * MINUTE, 1000);
  assert.equal(gladys.fake.states.length, count);
});

// --- 8. The setpoint follows register 109 ---------------------------------------

test('8. setpoint refused while cooling down or waiting with the door open, register 0 at 0', async (t) => {
  const panel = fakePanel();
  const { press } = await setup(t, { config: HEAT_CFG, panel });
  panel.set(109, 5);
  assert.match((await press('target-temperature', 70)).error, /refroidit/);
  panel.set(109, 6);
  panel.set(104, 1);
  assert.match((await press('target-temperature', 70)).error, /porte du sauna est ouverte/);
  assert.deepEqual(panel.writes(), []);
});

// --- 9. The configuration loaded again; a turn off waits for it -------------------

test('9. a configuration that fails to load is tried again; a turn off waits for it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const panel = fakePanel();
  const gladys = createFakeGladys({ config: CFG });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new SaunumApp({
    gladys,
    logger,
    connect: panel.connect,
    now: () => Date.now(),
    mono: () => Date.now(),
    store: memoryStore(),
  });
  t.after(() => app.stop());
  let fails = 1;
  const load = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('Gladys busy');
    }
    return { address: HOST };
  };
  const advance = async (ms) => {
    for (let e = 0; e < ms; e += 50) {
      t.mock.timers.tick(50);
      await settle(5);
    }
  };
  await app.onConnected(load);
  assert.equal(app.ready, false);
  // A turn off arriving now waits; the configuration comes 5 s later: too late for it.
  const early = app.setValue(undefined, { external_id: feature('heat-off') }, 1).catch((e) => e);
  await advance(4 * SECOND);
  assert.match((await early).message, /pas encore chargée/);
  await advance(2 * SECOND);
  assert.equal(app.ready, true);
  // Arriving just before it loads: it waits, then leaves.
  assert.deepEqual(panel.writes(), []);
  const late = app.setValue(undefined, { external_id: feature('heat-off') }, 1);
  await advance(5 * SECOND);
  await late;
  assert.deepEqual(panel.writes(), [[0, 0]]);
});

// --- 11. A slow panel: refused before the first write (review 2: estimate fixed) ---

for (const delay of [100, 150]) {
  test(`11. a panel answering in ${delay} ms: the start with 3 writes goes`, async (t) => {
    const panel = fakePanel({ delay });
    const { press } = await setup(t, { config: HEAT_CFG, panel });
    assert.deepEqual(await press('heat-on'), { ok: true });
    assert.deepEqual(panel.writes(), [
      [4, 80],
      [2, 60],
      [0, 1],
    ]);
  });
}

test('11. pressed while a read is going (0 ms): the start goes', async (t) => {
  const { app, fire, advance, panel } = await setup(t, { config: HEAT_CFG });
  await advance(2 * SECOND);
  const reading = app.tick();
  await advance(50);
  const ack = fire('heat-on').then(outcome);
  await advance(5 * SECOND);
  await reading;
  assert.deepEqual(await ack, { ok: true });
  assert.deepEqual(panel.writes().at(-1), [0, 1]);
});

test('11. a panel answering in 350 ms: refused before any write', async (t) => {
  const panel = fakePanel({ delay: 350 });
  const { press } = await setup(t, { config: HEAT_CFG, panel });
  const ack = await press('heat-on');
  assert.match(ack.error, /répond trop lentement pour tout écrire dans les 3,5 s/);
  assert.match(ack.error, /Rien envoyé/);
  assert.deepEqual(panel.writes(), []);
});

// --- 12. A turn off during an address change goes to the new address -------------

test('12. a turn off during an address change goes to the new address', async (t) => {
  const panel = fakePanel();
  const { gladys, advance, fire } = await setup(t, { panel });
  const updating = gladys.fake.configUpdated({ address: '192.168.1.81' });
  const ack = fire('heat-off').then(outcome);
  await advance(6 * SECOND);
  await updating;
  assert.deepEqual(await ack, { ok: true });
  const write = panel.requests.findIndex((r) => r.fn === 6);
  assert.ok(write >= 0);
  assert.deepEqual(panel.connects.at(-1), { host: '192.168.1.81', port: 502 });
});

// --- 14. True reasons --------------------------------------------------------------

test('14. an invalid unit id says so; a busy panel gets one more try on a turn off', async (t) => {
  const bad = await setup(t, { config: { ...CFG, unit_id: 0 } });
  assert.match((await bad.press('heat-off')).error, /identifiant d’unité Modbus/);
});

test('14. a turn off refused by a busy panel (exception 6) is tried once more', async (t) => {
  let refused = 0;
  const panel = fakePanel({
    behave: (r) => (r.fn === 6 && refused++ === 0 ? { exception: 6 } : undefined),
  });
  panel.set(0, 1);
  const { press, advance } = await setup(t, { panel });
  const ack = await press('heat-off');
  assert.match(ack.error, /nouvel essai/);
  await advance(2 * SECOND);
  assert.equal(panel.holding.get(0), 0);
});

// --- Review 2 ---------------------------------------------------------------------

test('r2-2. a read connecting while a turn off waits gives way: nothing sent', async (t) => {
  const panel = fakePanel();
  const { app, fire, advance } = await setup(t, { panel });
  await advance(11 * SECOND); // the idle connection is closed
  panel.connectDelay = 2000;
  panel.requests.length = 0;
  const reading = app.tick();
  await advance(100);
  const ack = fire('heat-off').then(outcome);
  await advance(5 * SECOND);
  await reading;
  assert.deepEqual(await ack, { ok: true });
  assert.deepEqual(
    panel.requests.slice(0, 1).map((r) => [r.fn, r.address]),
    [[6, 0]],
    'the turn off is the first request on the new connection',
  );
});

test('r2-3. a start the panel ignores: "the panel did not start the session"', async (t) => {
  const panel = fakePanel({
    behave: (r) => (r.fn === 6 && r.address === 0 && r.value === 1 ? 'echo-only' : undefined),
  });
  const { press, advance, gladys } = await setup(t, { config: HEAT_CFG, panel });
  assert.deepEqual(await press('heat-on'), { ok: true });
  await advance(70 * SECOND);
  assert.match(status(gladys), /n’a pas lancé la séance/);
  assert.ok(stops(panel) >= 1);
});

test('r2-4. repeated turn offs never extend a sticky guard', async (t) => {
  const { app, advance } = await setup(t);
  app.guardStop(Date.now(), { sticky: true });
  const until = app.stopGuard.until;
  await advance(60 * SECOND);
  app.guardStop(Date.now());
  assert.equal(app.stopGuard.until, until);
});

test('r2-5. a highest setpoint raised during the session: the new cap applies', async (t) => {
  const { press, advance, gladys, panel } = await setup(t, {
    config: { ...HEAT_CFG, max_temperature: 90 },
  });
  assert.deepEqual(await press('heat-on'), { ok: true });
  const updating = gladys.fake.configUpdated({ ...HEAT_CFG, max_temperature: 95 });
  await advance(SECOND);
  await updating;
  panel.set(4, 95);
  await advance(30 * SECOND);
  assert.equal(stops(panel), 0);
});

test('r2-6. a shorter duration set at the panel does not turn the sauna off', async (t) => {
  const panel = fakePanel({ onStart: (p) => p.set(2, 60) });
  const { press, advance } = await setup(t, {
    config: { ...HEAT_CFG, session_duration: 90 },
    panel,
  });
  assert.deepEqual(await press('heat-on'), { ok: true });
  await advance(30 * SECOND);
  assert.equal(stops(panel), 0);
});

test('r2-7. a session duration of 30 min is still a Saunum panel', async (t) => {
  const panel = fakePanel();
  panel.set(2, 30);
  const { press } = await setup(t, { panel });
  assert.deepEqual(await press('light', 1), { ok: true });
});

// --- Review 3 ---------------------------------------------------------------------

test('r3-1. turn on then turn off at once: no second turn off, no warning', async (t) => {
  const { press, advance, panel, gladys } = await setup(t, { config: HEAT_CFG });
  assert.deepEqual(await press('heat-on'), { ok: true });
  assert.deepEqual(await press('heat-off', 1, SECOND), { ok: true });
  await advance(90 * SECOND);
  assert.equal(stops(panel), 1);
  assert.doesNotMatch(status(gladys), /Attention/);
});
