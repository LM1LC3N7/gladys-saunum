// -----------------------------------------------------------------------------
// A minimal Modbus TCP client on node:net: read holding registers (function
// 3) and write one register (6), the only two functions the Saunum control
// panel needs. Taken from the reviewed client of gladys-stiebel-eltron (same
// author, Apache-2.0) and adapted to the rules of the Saunum panel, as
// pysaunum documents them: at least 500 ms between two requests, one
// connection at a time, an idle connection closed by the panel after 20 s.
//
//   - ONE connection at a time: never two sockets, a new client (another
//     address) waits until the previous one is closed (`after`);
//   - one request at a time (the Gate), never two on the wire, 500 ms apart;
//     jobs by priority: PROTECT (turn off) before COMMAND before READ,
//     first in first out inside a priority; a turn off only ever waits for
//     the one request already on the wire, never for a queued read or command;
//   - every answer is attributed to its request: transaction id, protocol id
//     0, unit id and function code must all match, the byte count must be
//     the one asked, a write must echo its address and value exactly;
//     anything else is a PROTOCOL error and the connection is dropped;
//   - bounded: a frame is 260 bytes at most, a read 125 registers at most;
//     a byte beyond the frame, or arriving with no request in flight, drops
//     the connection;
//   - a request that times out drops the connection too, so a late answer
//     can never be taken for the answer of the next request;
//   - the connection is closed by us after 10 s without a request, before
//     the panel closes it (a write never goes into a connection closing);
//   - `sent` says whether the request reached the socket: a write that may
//     have left is never reported "not sent".
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** No TCP connection could be opened: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time (the connection is dropped). */
  TIMEOUT: 'timeout',
  /** The connection closed while a request was in flight, or the client was closed. */
  CLOSED: 'closed',
  /** An answer that does not belong to the request (the connection is dropped). */
  PROTOCOL: 'protocol',
  /** A Modbus exception answer (code 1 to 11): the panel refused the request. */
  EXCEPTION: 'exception',
  /** Still waiting for its turn (or its connection) at its deadline: nothing was sent. */
  LATE: 'late',
};

/** Modbus exception code 2: the register is not served by this panel (older firmware). */
export const ILLEGAL_DATA_ADDRESS = 2;

export const PRIORITY = { PROTECT: 0, COMMAND: 1, READ: 2 };

export class ModbusError extends Error {
  constructor(kind, { code, sent = false, detail } = {}) {
    super(code === undefined ? kind : `${kind} ${code}`);
    this.name = 'ModbusError';
    this.kind = kind;
    this.code = code;
    this.sent = sent;
    this.detail = detail;
  }
}

/** A short reason for the logs and the messages: our own words only. */
export function errorReason(err) {
  if (err instanceof ModbusError) {
    return err.kind === ERROR_KINDS.EXCEPTION ? `Modbus exception ${err.code}` : err.kind;
  }
  return 'error';
}

const FUNCTION = { READ_HOLDING: 3, WRITE_SINGLE: 6 };
const HEADER = 7;

const isWord = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffff;

/**
 * One job at a time, at least `spacing` ms after the end of the previous
 * one (`spacing`: a number, or a function of the priority of the next job);
 * by priority, then in order; never cuts the job running. A job still
 * queued at `startBy` leaves the queue, rejected LATE (never run). `close()`
 * rejects the queued jobs except the PROTECT ones, which still run.
 */
export class Gate {
  constructor({ timers = globalThis, now = Date.now, spacing = 0 } = {}) {
    this.timers = timers;
    this.now = now;
    this.spacing = spacing;
    this.queue = [];
    this.running = false;
    this.lastEnd = -Infinity;
    this.wake = undefined;
    this.closing = false;
    this.idleWaiters = [];
  }

  run(fn, { priority = PRIORITY.READ, startBy } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closing && priority !== PRIORITY.PROTECT) {
        reject(new ModbusError(ERROR_KINDS.CLOSED));
        return;
      }
      const job = { fn, resolve, reject, priority, timer: undefined };
      if (startBy !== undefined) {
        job.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new ModbusError(ERROR_KINDS.LATE));
              this.idle();
            }
          },
          Math.max(0, startBy - this.now()),
        );
      }
      const at = this.queue.findIndex((queued) => queued.priority > priority);
      this.queue.splice(at === -1 ? this.queue.length : at, 0, job);
      this.pump();
    });
  }

  /** Whether a job of this priority is queued or running. */
  has(priority) {
    return this.queue.some((job) => job.priority === priority);
  }

  pump() {
    if (this.running || this.queue.length === 0) {
      this.idle();
      return;
    }
    if (this.wake) {
      // Recomputed: the head of the queue may have changed (a turn off arrived).
      this.timers.clearTimeout(this.wake);
      this.wake = undefined;
    }
    const spacing =
      typeof this.spacing === 'function' ? this.spacing(this.queue[0].priority) : this.spacing;
    const wait = this.lastEnd + spacing - this.now();
    if (wait > 0) {
      this.wake = this.timers.setTimeout(() => {
        this.wake = undefined;
        this.pump();
      }, wait);
      return;
    }
    const job = this.queue.shift();
    if (job.timer !== undefined) {
      this.timers.clearTimeout(job.timer);
    }
    this.running = true;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running = false;
        this.lastEnd = this.now();
        this.pump();
      });
  }

  /** Rejects the queued jobs but the PROTECT ones; resolves once nothing is left. */
  close() {
    this.closing = true;
    for (const job of [...this.queue]) {
      if (job.priority !== PRIORITY.PROTECT) {
        this.queue.splice(this.queue.indexOf(job), 1);
        if (job.timer !== undefined) {
          this.timers.clearTimeout(job.timer);
        }
        job.reject(new ModbusError(ERROR_KINDS.CLOSED));
      }
    }
    const done = new Promise((resolve) => this.idleWaiters.push(resolve));
    this.idle();
    return done;
  }

  idle() {
    if (!this.running && this.queue.length === 0 && this.idleWaiters.length > 0) {
      for (const resolve of this.idleWaiters.splice(0)) {
        resolve();
      }
    }
  }
}

export class ModbusClient {
  constructor({
    host,
    port,
    unitId,
    connect = (options) => net.createConnection(options),
    timers = globalThis,
    now = Date.now,
    after = Promise.resolve(),
    spacing = (priority) =>
      priority === PRIORITY.READ ? TIMINGS.readSpacing : TIMINGS.requestSpacing,
  }) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.connect = connect;
    this.timers = timers;
    this.now = now;
    /** The previous client: no connection is opened before it is closed. */
    this.after = after;
    this.gate = new Gate({ timers, now, spacing });
    this.socket = undefined;
    this.connecting = undefined;
    this.pending = undefined;
    this.transaction = 0;
    this.closed = false;
    this.idleTimer = undefined;
    /** Resolved once the client is closed and its sockets gone. */
    this.done = undefined;
    /** Every socket created and not closed yet (connecting included): its 'close' promise. */
    this.live = new Map();
    /** Sockets whose connection is not established yet. */
    this.dialing = new Set();
  }

  // --- Public, through the gate ------------------------------------------------

  /** Reads `count` holding registers; options: priority, startBy, timeoutMs, answerBy. */
  readHolding(address, count, { priority = PRIORITY.READ, startBy, ...options } = {}) {
    return this.gate.run(
      () => this.read(FUNCTION.READ_HOLDING, address, count, { ...options, startBy }),
      {
        priority,
        startBy,
      },
    );
  }

  /** Writes one register; options: priority, startBy, timeoutMs, answerBy, beforeSend. */
  writeRegister(address, value, { priority = PRIORITY.COMMAND, startBy, ...options } = {}) {
    return this.gate.run(() => this.write(address, value, { ...options, startBy }), {
      priority,
      startBy,
    });
  }

  /** Whether a turn off (PROTECT job) is queued. */
  get protectQueued() {
    return this.gate.has(PRIORITY.PROTECT);
  }

  /**
   * A turn off arrives: a READ on the wire is cut (the connection dropped)
   * so the turn off never waits for its answer. A write on the wire is
   * never cut. The read fails with CLOSED, `preempted`.
   */
  preemptRead() {
    const pending = this.pending;
    if (pending && pending.fn === FUNCTION.READ_HOLDING) {
      const err = new ModbusError(ERROR_KINDS.CLOSED, { sent: true, detail: 'preempted' });
      err.preempted = true;
      this.fail(pending, err, true);
    }
  }

  /** Resolves once every socket of this client has emitted 'close'. */
  async gone() {
    while (this.live.size > 0) {
      await Promise.all([...this.live.values()]);
    }
  }

  /**
   * Closes the client: the queued reads and commands are rejected, the
   * queued turn offs still go; then the connection is closed. Resolves once
   * the socket is gone (the next client may connect then).
   */
  close() {
    if (!this.done) {
      this.done = this.gate.close().then(async () => {
        this.closed = true;
        this.clearIdle();
        this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
        // A connection still being opened is destroyed too, and awaited:
        // the next client never connects while one of ours exists.
        for (const socket of this.dialing) {
          socket.destroy();
        }
        await this.gone();
      });
    }
    return this.done;
  }

  clearIdle() {
    if (this.idleTimer !== undefined) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Closes the connection after a while without a request (the panel would close it at 20 s). */
  armIdle() {
    this.clearIdle();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.pending && !this.gate.running) {
        this.drop(new ModbusError(ERROR_KINDS.CLOSED));
      } else if (this.socket && !this.closed) {
        // Between two jobs: counted again from now.
        this.armIdle();
      }
    }, TIMINGS.idleClose);
  }

  // --- Requests ----------------------------------------------------------------

  read(fn, address, count, options) {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(count) ||
      address < 0 ||
      count < 1 ||
      count > LIMITS.registersPerRead ||
      address + count > 0x10000
    ) {
      return Promise.reject(new RangeError('Invalid Modbus read'));
    }
    const pdu = Buffer.from([fn, address >> 8, address & 0xff, count >> 8, count & 0xff]);
    return this.transact(pdu, options, (answer) => {
      const bytes = answer[1];
      if (answer.length < 2 || bytes !== count * 2 || answer.length !== 2 + bytes) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'byte count' });
      }
      const words = [];
      for (let i = 0; i < count; i += 1) {
        words.push(answer.readUInt16BE(2 + i * 2));
      }
      return words;
    });
  }

  write(address, value, options) {
    if (!isWord(address) || !isWord(value)) {
      return Promise.reject(new RangeError('Invalid Modbus write'));
    }
    const pdu = Buffer.from([
      FUNCTION.WRITE_SINGLE,
      address >> 8,
      address & 0xff,
      value >> 8,
      value & 0xff,
    ]);
    // The answer of a write is its own echo: anything else is not ours.
    return this.transact(pdu, options, (answer) => {
      if (!answer.equals(pdu)) {
        throw new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail: 'echo' });
      }
      return value;
    });
  }

  /**
   * One request and its answer. `timeoutMs`: the whole request (connection
   * included); or `startBy` (the last moment the request may leave) and
   * `answerBy` (the last moment to wait for its answer). `beforeSend`: a
   * last check run once connected, right before the bytes leave; what it
   * throws is rethrown with `beforeSend: true`, nothing sent.
   */
  async transact(
    pdu,
    { timeoutMs = TIMINGS.requestTimeout, startBy, answerBy, beforeSend, onAnswer },
    check,
  ) {
    if (this.closed) {
      throw new ModbusError(ERROR_KINDS.UNREACHABLE);
    }
    this.clearIdle();
    const end = answerBy ?? this.now() + timeoutMs;
    const leaveBy = Math.min(startBy ?? end, end);
    await this.open(leaveBy);
    if (this.now() > leaveBy) {
      throw new ModbusError(ERROR_KINDS.LATE);
    }
    if (pdu[0] === FUNCTION.READ_HOLDING && this.gate.has(PRIORITY.PROTECT)) {
      // Connected while a turn off waits: the read gives way, nothing sent.
      const err = new ModbusError(ERROR_KINDS.CLOSED, { detail: 'preempted' });
      err.preempted = true;
      throw err;
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    const socket = this.socket;
    if (!socket || this.pending) {
      throw new ModbusError(ERROR_KINDS.UNREACHABLE);
    }
    this.transaction = (this.transaction % 0xffff) + 1;
    const tid = this.transaction;
    const frame = Buffer.alloc(HEADER + pdu.length);
    frame.writeUInt16BE(tid, 0);
    frame.writeUInt16BE(0, 2);
    frame.writeUInt16BE(pdu.length + 1, 4);
    frame.writeUInt8(this.unitId, 6);
    pdu.copy(frame, HEADER);
    return new Promise((resolve, reject) => {
      const pending = {
        tid,
        fn: pdu[0],
        check,
        buffer: Buffer.alloc(0),
        sentAt: this.now(),
        onAnswer,
        resolve,
        reject,
        timer: undefined,
      };
      pending.timer = this.timers.setTimeout(
        () => this.fail(pending, new ModbusError(ERROR_KINDS.TIMEOUT, { sent: true }), true),
        Math.max(0, end - this.now()),
      );
      this.pending = pending;
      // From here the request may reach the panel: `sent` in every error.
      socket.write(frame);
    });
  }

  /** The connection, opened when needed; gives up at `by` (nothing sent). */
  async open(by) {
    if (this.socket && (this.socket.destroyed || this.socket.writable === false)) {
      // Closed by the panel, its 'close' not seen yet: never write into it
      // (a write lost there would be reported "sent").
      this.drop(new ModbusError(ERROR_KINDS.CLOSED));
    }
    if (this.socket) {
      return;
    }
    if (!this.connecting) {
      // One connection at a time: the previous client first lets its sockets
      // go, and so does a connection of ours that was dropped.
      this.connecting = Promise.resolve(this.after)
        .then(() => this.gone())
        .then(() => this.dial())
        .finally(() => {
          this.connecting = undefined;
        });
    }
    let timer;
    const late = new Promise((_, reject) => {
      timer = this.timers.setTimeout(
        () => reject(new ModbusError(ERROR_KINDS.LATE)),
        Math.max(0, by - this.now()),
      );
    });
    try {
      await Promise.race([this.connecting, late]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  dial() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      const timer = this.timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          socket?.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE, { detail: 'connect timeout' }));
        }
      }, TIMINGS.connectTimeout);
      try {
        socket = this.connect({ host: this.host, port: this.port });
      } catch {
        settled = true;
        this.timers.clearTimeout(timer);
        reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        return;
      }
      this.dialing.add(socket);
      this.live.set(
        socket,
        new Promise((done) =>
          socket.once('close', () => {
            this.live.delete(socket);
            this.dialing.delete(socket);
            done();
          }),
        ),
      );
      socket.on('error', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
      socket.once('connect', () => {
        if (settled) {
          return;
        }
        settled = true;
        this.timers.clearTimeout(timer);
        this.dialing.delete(socket);
        if (this.closed) {
          socket.destroy();
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
          return;
        }
        socket.setNoDelay?.(true);
        this.socket = socket;
        socket.on('data', (chunk) => this.receive(socket, chunk));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.drop(new ModbusError(ERROR_KINDS.CLOSED, { sent: true }));
          }
        });
        // A connection nobody uses (its request gave up meanwhile) is closed when idle.
        this.armIdle();
        resolve();
      });
      socket.once('close', () => {
        if (!settled) {
          settled = true;
          this.timers.clearTimeout(timer);
          reject(new ModbusError(ERROR_KINDS.UNREACHABLE));
        }
      });
    });
  }

  receive(socket, chunk) {
    if (socket !== this.socket) {
      return;
    }
    const pending = this.pending;
    if (!pending) {
      // Nothing was asked: not an answer of ours.
      this.drop(new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true }));
      return;
    }
    pending.buffer = Buffer.concat([pending.buffer, chunk]);
    const fail = (detail) =>
      this.fail(pending, new ModbusError(ERROR_KINDS.PROTOCOL, { sent: true, detail }), true);
    if (pending.buffer.length > LIMITS.frameBytes) {
      fail('too long');
      return;
    }
    if (pending.buffer.length < HEADER) {
      return;
    }
    const buffer = pending.buffer;
    const length = buffer.readUInt16BE(4);
    if (buffer.readUInt16BE(2) !== 0 || length < 2 || length > LIMITS.frameBytes - 6) {
      fail('header');
      return;
    }
    const total = 6 + length;
    if (buffer.length < total) {
      return;
    }
    if (buffer.length > total) {
      fail('trailing bytes');
      return;
    }
    if (buffer.readUInt16BE(0) !== pending.tid || buffer.readUInt8(6) !== this.unitId) {
      fail('transaction');
      return;
    }
    const answer = buffer.subarray(HEADER, total);
    if (answer[0] === (pending.fn | 0x80)) {
      if (answer.length !== 2) {
        fail('exception');
        return;
      }
      // A well-formed refusal: the connection stays.
      this.fail(pending, new ModbusError(ERROR_KINDS.EXCEPTION, { code: answer[1], sent: true }));
      return;
    }
    if (answer[0] !== pending.fn) {
      fail('function');
      return;
    }
    let value;
    try {
      value = pending.check(answer);
    } catch (err) {
      this.fail(pending, err, true);
      return;
    }
    this.settle(pending);
    // The answer time of this request, to its caller only (a command estimates its writes with it).
    pending.onAnswer?.(this.now() - pending.sentAt);
    pending.resolve(value);
  }

  settle(pending) {
    this.timers.clearTimeout(pending.timer);
    if (this.pending === pending) {
      this.pending = undefined;
      if (this.socket && !this.closed) {
        this.armIdle();
      }
    }
  }

  fail(pending, err, dropConnection = false) {
    if (this.pending !== pending) {
      return;
    }
    this.settle(pending);
    pending.reject(err);
    if (dropConnection) {
      this.drop(err);
    }
  }

  /** Closes the connection; a request in flight fails with `err`. */
  drop(err) {
    const socket = this.socket;
    this.socket = undefined;
    const pending = this.pending;
    if (pending) {
      this.settle(pending);
      pending.reject(err);
    }
    socket?.destroy();
  }
}
