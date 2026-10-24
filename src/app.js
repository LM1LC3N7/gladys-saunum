// -----------------------------------------------------------------------------
// The integration: the Saunum panel at the address typed in the
// configuration (Modbus TCP on the local network), one read every poll
// interval, its Gladys device and states, the transport badge, the "Test the
// connection" button, and the four commands. index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart of the container (the time of the last
//     read is kept in /data, written BEFORE the read, at most once a
//     minute); a reconnection during a read reads nothing more;
//   - a read for an old configuration (generation) publishes nothing and
//     sets no status; a read begun before a command left is not applied;
//   - ONE Modbus connection at a time (src/modbus/client.js): a new address
//     waits until the previous connection is closed.
//
// Commands:
//   - TURN ON and the SETPOINT are sensitive: refused unless "Allow heating
//     from Gladys" is on, checked on arrival and again right before each
//     write; decided on a fresh read of the panel only (never on the state in
//     memory); refused when a value they need is unknown, the door is open,
//     an alarm is on, the panel reports a reason not to start, or a turn off
//     is in flight or unconfirmed; the setpoint never above the "Highest
//     setpoint" (90 °C by default, 100 °C at most), the session duration the
//     one of the configuration (60 to 720 min); every write leaves within
//     3.5 s of the click or the command is refused; one at a time, never
//     retried;
//   - TURN OFF protects: never held back by the option, a heating command, a
//     failed read or the first read after a restart (the device id is
//     fixed); one write of register 0 = 0, no read before it, ahead of every
//     queued read and command (it only waits for the request already on the
//     wire); a heating write not sent yet gives way to it. When a start may
//     still land after it (sent without answer), the reads of the next 2 min
//     send it again if the sauna heats (3 times at most, kept in /data);
//   - the LIGHT is a plain write (harmless), once the panel has been read;
//   - the ack never waits for a publication to Gladys.
// -----------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, targetKey, usable } from './config.js';
import { FEATURES, PRESSED, REG, SECOND, STATE, TEMPERATURE, TIMINGS } from './constants.js';
import { COMMAND_ROLES, buildDevice, panelIds, parseFeatureId, statesOf } from './devices.js';
import { ERRORS, OUTCOME, STATE_NAMES, T, age, join, stateText, word } from './i18n.js';
import { ERROR_KINDS, ModbusClient, PRIORITY, errorReason } from './modbus/client.js';
import { StatePublisher } from './publisher.js';
import { coolingDown, heatingOn, parsePanel, readPanel } from './saunum.js';
import { fileStore, normalizeMemory } from './store.js';

const freshPanel = () => ({
  /** The last state read (src/saunum.js parsePanel), else undefined. */
  data: undefined,
  /** When a polling or command read last succeeded (monotonic). */
  readAt: -Infinity,
  /** undefined: not read yet since the start; false: the last read failed. */
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

/** A refusal: its message is shown by Gladys. */
class Refusal extends Error {}

/** Whether an error says the request never left (nothing written). */
const notSent = (err) =>
  err?.kind === ERROR_KINDS.LATE || err?.kind === ERROR_KINDS.UNREACHABLE || err?.sent === false;

export class SaunumApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'saunum' }),
    connect,
    now = Date.now,
    mono = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    /** Wall clock: /data only. */
    this.now = now;
    /** Monotonic clock: every deadline, guard and interval in memory. */
    this.mono = mono;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: mono, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    this.panel = freshPanel();
    this.client = undefined;
    this.clientKey = '';
    this.generation = 0;
    this.started = false;
    /** Whether the panel serves the registers 105-118 (undefined: not known yet). */
    this.extended = undefined;
    this.extendedRetryAt = -Infinity;
    /** The time of the last read sent (monotonic; /data keeps it within a minute). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.dirty = false;
    /** Turn offs in flight, on any client (every heating command waits for them). */
    this.stopsInFlight = 0;
    this.resetGuards();
  }

  /** The guards of the commands: they belong to the panel they were set for. */
  resetGuards() {
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** When the last start (register 0 = 1) left. */
    this.lastStartAt = -Infinity;
    /** Until then, a start sent without answer may still land. */
    this.unconfirmedStartUntil = -Infinity;
    /** The heating command in progress: { seq, sentAt, answered }. */
    this.startEntry = undefined;
    /** Counts the turn offs: a heating command that sees it change gives way. */
    this.protectSeq = 0;
    /** A turn off to confirm or reaffirm: { sentAt, until, reasserts, sticky, target }. */
    this.stopGuard = undefined;
    /** When the last turn off left. */
    this.lastStopAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    await this.panel.running;
    const generation = this.generation;
    const previousKey = targetKey(this.config);
    this.config = normalizeConfig(raw);
    const key = targetKey(this.config);
    if (key !== previousKey) {
      this.resetGuards();
      this.extended = undefined;
      this.extendedRetryAt = -Infinity;
    }
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (generation !== this.generation) {
      return;
    }
    if (this.memory.lastAttemptAt !== null) {
      // Written at most once a minute: the read may have left up to a minute later.
      const ago =
        this.now() - Math.min(this.now(), this.memory.lastAttemptAt + TIMINGS.attemptWriteEvery);
      this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - ago);
    }
    this.restoreStopGuard(key);
    this.useClient(key);
    this.panel = freshPanel();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!usable(this.config)) {
      // The device already created is shown unreachable; the status says why.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The Modbus client of the address: a new one waits until the previous one is closed. */
  useClient(key) {
    if (this.client && this.clientKey === key) {
      return;
    }
    const previous = this.client;
    // Its queued reads and commands are dropped; a turn off already queued still goes.
    const after = previous ? previous.close() : Promise.resolve();
    this.client = undefined;
    this.clientKey = key;
    if (usable(this.config)) {
      this.client = new ModbusClient({
        host: this.config.address.host,
        port: this.config.address.port,
        unitId: this.config.unitId,
        connect: this.connect,
        timers: this.timers,
        now: this.mono,
        after,
      });
    }
  }

  /** The guard of a turn off kept in /data, for this panel only. */
  restoreStopGuard(key) {
    const kept = this.memory.stopGuard;
    if (!kept || kept.target !== key || this.stopGuardActive()) {
      return;
    }
    this.stopGuard = {
      sentAt: -Infinity,
      until: this.mono() + Math.max(0, kept.until - this.now()),
      reasserts: kept.reasserts,
      sticky: true,
      target: key,
    };
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    return Math.min(this.interval, Math.max(0, this.due - this.mono()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.panel.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.panel.followUps.clear();
    this.publisher.stop();
  }

  /** The container stops: the timers, then the connection (a queued turn off still goes). */
  async shutdown() {
    this.stop();
    await this.client?.close();
  }

  clearTimer() {
    if (this.panel.timer) {
      this.timers.clearTimeout(this.panel.timer);
      this.panel.timer = undefined;
    }
  }

  /** Only a new address (or unit) restarts; an interval only reschedules. */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      targetKey(next) !== targetKey(this.config) ||
      next.invalidAddress !== this.config.invalidAddress
    );
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * last states, without reading the panel.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { reconnected: true });
  }

  async configUpdated(raw = {}, { reconnected = false } = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (reconnected || this.config.language !== previous.language) {
      this.published = undefined;
    }
    if (reconnected) {
      this.badge = undefined;
      this.lastStatus = undefined;
    }
    if (
      this.config.pollInterval !== previous.pollInterval &&
      usable(this.config) &&
      !this.panel.running &&
      this.panel.online !== false &&
      this.panel.timer
    ) {
      this.schedule();
    }
    if (this.config.allowHeating !== previous.allowHeating) {
      this.logger.info(
        `Saunum: heating from Gladys ${this.config.allowHeating ? 'allowed' : 'off'}`,
      );
    }
    await this.publishAll();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async saveMemory() {
    this.dirty = false;
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval. */
  schedule(delay) {
    const p = this.panel;
    this.clearTimer();
    if (!usable(this.config)) {
      return;
    }
    let wait = delay ?? (p.online === false ? p.wait : this.interval);
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    p.timer = this.timers.setTimeout(() => {
      p.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('Saunum refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const p = this.panel;
    if (!p.running) {
      p.running = this.run().finally(() => {
        p.running = undefined;
      });
    }
    return p.running;
  }

  /** Keeps the time of this read; when the write of the minute is due, in /data BEFORE the read. */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  /** Whether to ask the registers 105-118 (an older firmware refused them: again every 30 min). */
  wantExtended() {
    return this.extended !== false || this.mono() >= this.extendedRetryAt;
  }

  /** The words of a read, with what the panel said about the registers 105-118. */
  async readWords(options) {
    const result = await readPanel(this.client, { extended: this.wantExtended(), ...options });
    if (result.refusedExtended) {
      if (this.extended !== false) {
        this.logger.info('Saunum: registers 105-118 not served (older firmware)');
      }
      this.extended = false;
      this.extendedRetryAt = this.mono() + TIMINGS.extendedRetry;
    } else if (result.words.status.length > 5) {
      this.extended = true;
    }
    return parsePanel(result.words);
  }

  async run() {
    const generation = this.generation;
    if (!usable(this.config) || !this.client) {
      return;
    }
    let delay;
    const startedAt = this.mono();
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    try {
      const data = await this.readWords({ priority: PRIORITY.READ });
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('Saunum: read begun before a command, not applied');
        this.panel.online = true;
        this.panel.failures = 0;
      } else {
        this.applyRead(data);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      delay = this.failed(err);
    }
    if (this.dirty) {
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** A read of the panel (polling, or the fresh read of a command). */
  applyRead(data, { fromCommand = false } = {}) {
    const p = this.panel;
    p.online = true;
    p.failures = 0;
    p.wait = undefined;
    p.error = undefined;
    p.readAt = this.mono();
    p.data = data;
    this.observe(data, { fromCommand });
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const p = this.panel;
    const reason = err?.kind === 'invalid' ? 'invalid data' : errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(p.failures, TIMINGS.backoff.length - 1)],
    );
    p.failures += 1;
    p.online = false;
    p.wait = wait;
    p.error = reason;
    this.logger.warn(`Saunum: read failed (${reason}); next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** `[connected, message]` of the configuration screen. */
  status() {
    const p = this.panel;
    const c = this.config;
    if (!c.address) {
      return [false, c.invalidAddress ? T.badAddress : T.noAddress];
    }
    if (c.unitId === undefined) {
      return [false, T.badUnit];
    }
    if (p.online === false) {
      return [false, T.unreachable(p.error ?? 'error', age(p.wait ?? this.interval))];
    }
    if (p.online === undefined || !p.data) {
      return [false, p.timer ? T.waiting(age(Math.max(0, this.due - this.mono()))) : T.connecting];
    }
    return [true, T.connected(T.summary(p.data))];
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  // --- Gladys ----------------------------------------------------------------

  /** The roles of the device already created in Gladys. */
  createdRoles() {
    const ids = panelIds(this.gladys);
    const device = (this.gladys.devices ?? []).find((d) => d.external_id === ids.device);
    const roles = new Set();
    for (const f of device?.features ?? []) {
      const role = parseFeatureId(f?.external_id);
      if (role && ids.feature(role) === f.external_id) {
        roles.add(role);
      }
    }
    return roles;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const data = this.panel.data;
    if (!data) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, data, {
        language: this.config.language,
        created: this.createdRoles(),
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const data = this.panel.data;
    if (!data) {
      return;
    }
    const ids = panelIds(this.gladys);
    for (const { role, ...value } of statesOf(data, { language: this.config.language })) {
      const id = ids.feature(role);
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  /** The badge of the panel device, when created. */
  async publishBadge() {
    const id = panelIds(this.gladys).device;
    if (!(this.gladys.devices ?? []).some((d) => d.external_id === id)) {
      return;
    }
    const reachable = usable(this.config) && this.panel.online === true;
    const entries = [
      {
        external_id: id,
        transport: reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!usable(this.config)) {
      return this.status()[1];
    }
    const p = this.panel;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status()[1];
    if (p.running) {
      await p.running;
      return current();
    }
    if (this.mono() < this.due) {
      const last = this.status()[1];
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && p.online !== undefined
        ? join(join(last, T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : join(last, waited);
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------

  get lang() {
    return this.config.language === 'en' ? 'en' : 'fr';
  }

  /** A refusal: the reason, then what was (not) written. */
  refusal(text, outcome) {
    const message = outcome ? join(text, outcome) : text;
    return new Refusal(word(message, this.lang));
  }

  /** A setpoint from Gladys: a whole number of °C (75 or "75"), else undefined. */
  static setpointOf(value) {
    let n;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'string' && /^\s*\d{1,3}(?:\.0+)?\s*$/.test(value)) {
      n = Number(value);
    }
    return Number.isInteger(n) ? n : undefined;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    if (!role || !COMMAND_ROLES.includes(role)) {
      throw this.refusal(ERRORS.readOnly, OUTCOME.nothing);
    }
    if (panelIds(this.gladys).feature(role) !== feature.external_id) {
      throw this.refusal(ERRORS.unknownDevice, OUTCOME.nothing);
    }
    if (!usable(this.config) || !this.client) {
      throw this.refusal(ERRORS.noConfig, OUTCOME.nothing);
    }
    if (role === FEATURES.TARGET) {
      const temperature = SaunumApp.setpointOf(value);
      if (
        temperature === undefined ||
        temperature < TEMPERATURE.min ||
        temperature > this.config.maxTemperature
      ) {
        throw this.refusal(
          ERRORS.badSetpoint(TEMPERATURE.min, this.config.maxTemperature),
          OUTCOME.nothing,
        );
      }
      return this.heat(received, { setpoint: true, temperature });
    }
    if (role === FEATURES.LIGHT) {
      // Strictly 0 or 1: null, '', true or "on" never switch the light.
      const on = value === 1 || value === '1' ? 1 : value === 0 || value === '0' ? 0 : undefined;
      if (on === undefined) {
        throw this.refusal(ERRORS.badLight, OUTCOME.nothing);
      }
      return this.setLight(received, on);
    }
    // Strictly 1: null, '', true, 0 or "on" never press a button.
    if (value !== PRESSED && value !== String(PRESSED)) {
      throw this.refusal(ERRORS.badButton, OUTCOME.nothing);
    }
    if (role === FEATURES.HEAT_OFF) {
      return this.turnOff(received);
    }
    return this.heat(received, { setpoint: false });
  }

  /**
   * The checks of a heating command, on the latest configuration: on
   * arrival, after the fresh read, and right before each write
   * (beforeSend). A turn off in flight, queued or not confirmed yet (its
   * guard) refuses every heating command; a setpoint is also refused for
   * 2 min after a turn off.
   */
  checkHeat(generation, entry, order) {
    if (!this.config.allowHeating) {
      return ERRORS.heatingDisabled;
    }
    if (generation !== this.generation || !usable(this.config)) {
      return ERRORS.unknownDevice;
    }
    if (entry && entry.seq !== this.protectSeq) {
      return ERRORS.stopMeanwhile;
    }
    if (this.stopsInFlight > 0 || this.client?.protectQueued || this.stopGuardActive()) {
      return ERRORS.stopPending;
    }
    if (order.setpoint && this.mono() - this.lastStopAt < TIMINGS.setpointAfterStop) {
      return ERRORS.justStopped;
    }
    return undefined;
  }

  /** Turn on, or a new setpoint: one at a time. */
  async heat(received, order) {
    const generation = this.generation;
    const reason = this.checkHeat(generation, undefined, order);
    if (reason) {
      throw this.refusal(reason, OUTCOME.nothing);
    }
    if (this.startEntry) {
      throw this.refusal(ERRORS.busy, OUTCOME.nothing);
    }
    const entry = { seq: this.protectSeq, sentAt: undefined, answered: false };
    this.startEntry = entry;
    try {
      return await this.sendHeat(received, generation, entry, order);
    } finally {
      entry.answered = true;
      if (this.startEntry === entry) {
        this.startEntry = undefined;
      }
    }
  }

  /** What the fresh read says about a heating command: a refusal text, 'nothing', or undefined (go). */
  decideHeat(data, order) {
    if (data.alarm !== false) {
      return data.alarm === undefined ? ERRORS.missing : ERRORS.alarm;
    }
    if (order.setpoint) {
      if (data.target === undefined) {
        return ERRORS.missing;
      }
      if (data.sessionActive) {
        if (coolingDown(data)) {
          return ERRORS.coolingDown;
        }
        if (data.doorOpen) {
          return ERRORS.doorOpen;
        }
      }
      return data.target === order.temperature ? 'nothing' : undefined;
    }
    if (data.sessionActive) {
      // On already (nothing to send), or cooling down (a start would do nothing).
      return coolingDown(data)
        ? ERRORS.cannotStart(STATE_NAMES[STATE.COOLDOWN])
        : heatingOn(data)
          ? 'nothing'
          : ERRORS.missing;
    }
    if (data.doorOpen) {
      return ERRORS.doorOpen;
    }
    if (data.extended) {
      if (data.state === undefined) {
        return ERRORS.missing;
      }
      if (data.state !== STATE.STANDBY) {
        return ERRORS.cannotStart(stateText(data));
      }
      if (data.startBlock !== 0) {
        return ERRORS.startBlocked(data.startBlock.toString(16));
      }
    }
    return undefined;
  }

  async sendHeat(received, generation, entry, order) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const readStart = this.mono();
    let data;
    try {
      data = await this.readWords({
        priority: PRIORITY.COMMAND,
        startBy: sendBy,
        answerBy: sendBy,
      });
    } catch (err) {
      if (err?.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow, OUTCOME.nothing);
      }
      const reason = err?.kind === 'invalid' ? 'invalid data' : errorReason(err);
      throw this.refusal(ERRORS.unknownState(reason), OUTCOME.nothing);
    }
    if (generation !== this.generation) {
      throw this.refusal(ERRORS.unknownDevice, OUTCOME.nothing);
    }
    if (readStart > this.lastSentAt) {
      this.applyRead(data, { fromCommand: true });
      // Shown in the background: the ack never waits for Gladys.
      this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    }
    // Decided on the fresh read only, never on the state in memory.
    const decision = this.decideHeat(data, order);
    const again = this.checkHeat(generation, entry, order);
    if (again) {
      throw this.refusal(again, OUTCOME.nothing);
    }
    if (decision === 'nothing') {
      return undefined;
    }
    if (decision) {
      throw this.refusal(decision, OUTCOME.nothing);
    }
    if (this.startMayLand) {
      throw this.refusal(ERRORS.inProgress, OUTCOME.nothing);
    }
    // The writes: a setpoint alone, or the setpoint and duration of the session, then the start.
    const writes = order.setpoint
      ? [[REG.TARGET_TEMPERATURE, order.temperature]]
      : [
          ...(data.target === this.config.startTemperature
            ? []
            : [[REG.TARGET_TEMPERATURE, this.config.startTemperature]]),
          ...(data.duration === this.config.sessionDuration
            ? []
            : [[REG.SAUNA_DURATION, this.config.sessionDuration]]),
          [REG.SESSION_ACTIVE, 1],
        ];
    let wrote = 0;
    const outcome = () => (order.setpoint || wrote === 0 ? OUTCOME.nothing : OUTCOME.notStarted);
    for (const [address, value] of writes) {
      const last = address === REG.SESSION_ACTIVE;
      // The checks again right before the first byte of each write.
      const lastChecks = () => {
        const reason =
          this.checkHeat(generation, entry, order) ??
          (address === REG.TARGET_TEMPERATURE && value > this.config.maxTemperature
            ? ERRORS.badSetpoint(TEMPERATURE.min, this.config.maxTemperature)
            : undefined) ??
          (this.mono() > sendBy ? ERRORS.tooSlow : undefined);
        if (reason) {
          throw this.refusal(reason, outcome());
        }
        this.lastSentAt = this.mono();
        if (last) {
          this.lastStartAt = this.mono();
          entry.sentAt = this.mono();
          this.logger.info(
            `Saunum: start at ${this.config.startTemperature} °C for ${this.config.sessionDuration} min`,
          );
        } else if (order.setpoint) {
          this.logger.info(`Saunum: setpoint ${value} °C`);
        }
      };
      try {
        await this.client.writeRegister(address, value, {
          priority: PRIORITY.COMMAND,
          startBy: sendBy,
          answerBy,
          beforeSend: lastChecks,
        });
        wrote += 1;
      } catch (err) {
        if (err instanceof Refusal) {
          // Refused by the last checks: this write never left.
          throw err;
        }
        const reason = errorReason(err);
        this.logger.warn(`Saunum: heating command failed (${reason})`);
        this.followUp();
        if (notSent(err)) {
          throw this.refusal(
            err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason),
            outcome(),
          );
        }
        if (err.kind === ERROR_KINDS.EXCEPTION) {
          throw this.refusal(ERRORS.refused(reason), outcome());
        }
        // Sent, no clean answer: it may have reached the panel.
        if (last) {
          this.unconfirmedStartUntil = this.mono() + TIMINGS.guard;
        }
        throw this.refusal(ERRORS.sentUnconfirmed(reason));
      }
    }
    // Every write echoed by the panel: the reads that follow show the result.
    this.followUp();
    return undefined;
  }

  /** A start may still land: in flight (sent, not answered), or sent without answer. */
  get startMayLand() {
    return (
      (this.startEntry?.sentAt !== undefined && !this.startEntry.answered) ||
      this.mono() < this.unconfirmedStartUntil
    );
  }

  stopGuardActive() {
    if (this.stopGuard && this.mono() >= this.stopGuard.until) {
      this.stopGuard = undefined;
    }
    return Boolean(this.stopGuard);
  }

  /**
   * Sets (or keeps) the guard of a turn off sent at `sentAt`. `sticky`: a
   * start may land after it; lifted by time only, kept in /data.
   */
  guardStop(sentAt, { sticky = false } = {}) {
    const key = targetKey(this.config);
    if (this.stopGuardActive() && this.stopGuard.target === key) {
      this.stopGuard.sticky ||= sticky;
      this.stopGuard.sentAt = Math.max(this.stopGuard.sentAt, sentAt);
    } else {
      this.stopGuard = {
        sentAt,
        until: this.mono() + TIMINGS.guard,
        reasserts: 0,
        sticky,
        target: key,
      };
    }
    if (this.stopGuard.sticky) {
      this.persistStopGuard();
    }
  }

  persistStopGuard() {
    const g = this.stopGuard;
    this.memory.stopGuard = g
      ? {
          until: this.now() + Math.max(0, g.until - this.mono()),
          reasserts: g.reasserts,
          target: g.target,
        }
      : null;
    this.saveMemory().catch(() => {});
  }

  /** One write of register 0 = 0, ahead of every queued read and command. */
  sendStop({ background = false } = {}) {
    this.stopsInFlight += 1;
    const sentAt = this.mono();
    this.lastSentAt = sentAt;
    this.lastStopAt = sentAt;
    const sending = this.client.writeRegister(REG.SESSION_ACTIVE, 0, {
      priority: PRIORITY.PROTECT,
      answerBy: sentAt + TIMINGS.protectTimeout,
      beforeSend: () => {
        // Counted from the moment it leaves: a read begun before it is not applied.
        this.lastSentAt = this.mono();
      },
    });
    sending
      .finally(() => {
        this.stopsInFlight -= 1;
      })
      .catch(() => {});
    if (background) {
      sending
        .then(() => this.followUp())
        .catch((err) => this.logger.warn(`Saunum: turn off again failed (${errorReason(err)})`));
    }
    return sending;
  }

  /**
   * TURN OFF: never held back, one write, no read before it (it decides
   * nothing: it is always sent, never answered "already off"). Confirmed by
   * the echo of the panel; when it may have left without that, or a start
   * may land after it, a guard: the reads of the next 2 min send it again if
   * the sauna heats.
   */
  async turnOff(received) {
    // A heating write not sent yet gives way.
    this.protectSeq += 1;
    const generation = this.generation;
    const sentAt = this.mono();
    if (this.startMayLand) {
      this.guardStop(sentAt, { sticky: true });
    }
    this.logger.info('Saunum: turn off');
    const sending = this.sendStop();
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let late;
    const result = await new Promise((resolve) => {
      late = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      sending.then(
        () => resolve({ ok: true }),
        (err) => resolve({ err }),
      );
    });
    this.timers.clearTimeout(late);
    this.followUp();
    if (result.late) {
      // Still going after the ack (bounded by its own deadline): logged when it ends.
      if (generation === this.generation) {
        this.guardStop(sentAt);
      }
      sending.catch((err) =>
        this.logger.warn(`Saunum: turn off failed after the ack (${errorReason(err)})`),
      );
      throw this.refusal(ERRORS.sentUnconfirmed(ERRORS.noAnswerYet[this.lang]));
    }
    if (result.err) {
      const err = result.err;
      const reason = errorReason(err);
      this.logger.warn(`Saunum: turn off failed (${reason})`);
      if (notSent(err)) {
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.EXCEPTION) {
        throw this.refusal(ERRORS.refused(reason));
      }
      // Sent, no clean answer: it may have reached the panel.
      if (generation === this.generation) {
        this.guardStop(sentAt);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    return undefined;
  }

  /**
   * A read through the guards: a start sent without answer is seen landed
   * (heating); a turn off is confirmed (off, nothing in flight, not sticky),
   * or sent again if the sauna heats while a start may have landed after it.
   */
  observe(data, { fromCommand = false } = {}) {
    if (heatingOn(data) && this.mono() < this.unconfirmedStartUntil) {
      // The start landed: it cannot land any more.
      this.unconfirmedStartUntil = -Infinity;
    }
    if (!this.stopGuardActive()) {
      return;
    }
    const guard = this.stopGuard;
    if (guard.target !== targetKey(this.config)) {
      this.stopGuard = undefined;
      return;
    }
    if (!heatingOn(data)) {
      if (!guard.sticky && this.stopsInFlight === 0 && !this.startMayLand) {
        // Off, and nothing may land any more: the turn off is confirmed.
        this.stopGuard = undefined;
      }
      return;
    }
    const startInFlight = this.startEntry?.sentAt !== undefined && !this.startEntry.answered;
    if (
      !fromCommand &&
      this.lastStartAt <= guard.sentAt &&
      !startInFlight &&
      this.stopsInFlight === 0 &&
      guard.reasserts < TIMINGS.stopReasserts
    ) {
      guard.reasserts += 1;
      if (guard.sticky) {
        this.persistStopGuard();
      }
      this.logger.warn('Saunum: the sauna heats again after a turn off, turn off sent again');
      this.sendStop({ background: true }).catch(() => {});
    }
  }

  /** The light: a plain write, once the panel has been read. */
  async setLight(received, on) {
    if (this.panel.online !== true) {
      throw this.refusal(ERRORS.notRead, OUTCOME.nothing);
    }
    const sendBy = received + TIMINGS.commandSendBy;
    try {
      await this.client.writeRegister(REG.LIGHT, on, {
        priority: PRIORITY.COMMAND,
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        beforeSend: () => {
          this.lastSentAt = this.mono();
        },
      });
    } catch (err) {
      const reason = errorReason(err);
      this.followUp();
      if (notSent(err)) {
        throw this.refusal(
          err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason),
          OUTCOME.nothing,
        );
      }
      if (err.kind === ERROR_KINDS.EXCEPTION) {
        throw this.refusal(ERRORS.refused(reason));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.followUp();
    return undefined;
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const p = this.panel;
    for (const handle of p.followUps) {
      this.timers.clearTimeout(handle);
    }
    p.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        p.followUps.delete(handle);
        if (generation === this.generation) {
          Promise.resolve(p.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Saunum refresh failed'));
        }
      }, delay);
      p.followUps.add(handle);
    }
  }
}
