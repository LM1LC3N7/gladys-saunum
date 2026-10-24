// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Saunum panel, with
// the exact wiring of the container (src/handlers.js) and a mocked clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SaunumApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, fakePanel, settle } from './fakePanel.js';

export const CFG = { address: HOST };
export const HEAT_CFG = { ...CFG, allow_heating: true };
export const DEVICE = 'ext:test-integration:saunum:panel';
export const feature = (role) => `${DEVICE}:${role}`;

/** The ack of a command: { ok: true } or { error }. */
export const outcome = (ack) => (ack.success ? { ok: true } : { error: String(ack.error) });

export async function setup(
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
  let connected = false;
  const connecting = gladys.connect().then(() => (connected = true));
  await settle();
  await advance(3 * SECOND);
  // A slow panel: the first read may take longer.
  for (let i = 0; i < 100 && !connected; i += 1) {
    await advance(100);
  }
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
