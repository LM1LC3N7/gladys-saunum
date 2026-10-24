// -----------------------------------------------------------------------------
// A fake Saunum panel behind the socket factory: it parses the Modbus TCP
// frames the client writes, answers from its holding registers (values made
// up, never captured from a real panel), applies the writes like the panel is
// expected to (register 0 = 1 starts a session, 0 stops it), and lets a test
// change its behaviour per request. No network: every socket is an in-memory
// EventEmitter. It counts the sockets open at once (one connection at most).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.80';
export const NOW = Date.UTC(2026, 9, 24, 18, 0, 0);

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** A panel at rest: off, 22 °C, door closed, no alarm, newer firmware. */
export function panelRegisters() {
  return {
    0: 0, // session
    1: 0, // sauna type
    2: 120, // duration
    3: 10, // fan duration
    4: 85, // setpoint
    5: 2, // fan speed
    6: 0, // light
    100: 22, // temperature
    101: 0,
    102: 3600,
    103: 0, // heater elements
    104: 0, // door closed
    105: 30, // humidity
    106: 0,
    107: 0,
    108: 0,
    109: 1, // standby
    110: 0,
    111: 0,
    112: 0,
    113: 0,
    114: 0,
    115: 0,
    116: 0,
    117: 0,
    118: 0,
    200: 0,
    201: 0,
    202: 0,
    203: 0,
    204: 0,
    205: 0,
  };
}

/**
 * `extended: false`: an older firmware, registers 105-118 refused
 * (exception 2). `behave(request, panel)`: per request, return undefined
 * (answer normally), `'silent'` (no answer), `{ exception: code }`, `'close'`
 * (drop the connection) or, for a write, `'silent-applied'` (applied, no
 * answer) or `'echo-only'` (answered, not applied). `connectDelay`: ms before
 * a connection is established (setTimeout, mocked clock). `delay`: ms before each answer (setTimeout, mocked clock).
 */
export function fakePanel({
  registers = panelRegisters(),
  extended = true,
  behave,
  delay = 0,
  connectDelay = 0,
  onStart,
} = {}) {
  const panel = {
    holding: new Map(Object.entries(registers).map(([k, v]) => [Number(k), v])),
    /** Every request received: { fn, address, count?, value?, tid, unit, at }. */
    requests: [],
    connects: [],
    sockets: [],
    open: 0,
    maxOpen: 0,
    down: false,
    extended,
    behave,
    delay,
    connectDelay,
    /** Called after a start (register 0 = 1) is applied: a test may change what the panel keeps. */
    onStart,
  };

  const later = (fn) => {
    if (panel.delay > 0) {
      setTimeout(fn, panel.delay);
    } else {
      setImmediate(fn);
    }
  };

  const answer = (socket, buffer) => {
    later(() => {
      if (!socket.destroyed) {
        socket.emit('data', buffer);
      }
    });
  };

  const frame = (tid, unit, pdu) => {
    const out = Buffer.alloc(7 + pdu.length);
    out.writeUInt16BE(tid, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt16BE(pdu.length + 1, 4);
    out.writeUInt8(unit, 6);
    pdu.copy(out, 7);
    return out;
  };

  /** What a write does to the panel. */
  const apply = (address, value) => {
    panel.holding.set(address, value);
    if (address === 0) {
      panel.holding.set(109, value === 1 ? 3 : 1);
      panel.holding.set(103, value === 1 ? 3 : 0);
      panel.holding.set(107, value === 1 ? (panel.holding.get(2) || 120) * 60 : 0);
      panel.holding.set(106, value === 1 ? panel.holding.get(2) || 120 : 0);
      if (value === 1) {
        panel.onStart?.(panel);
      }
    }
  };

  const handle = (socket, data) => {
    const tid = data.readUInt16BE(0);
    const unit = data.readUInt8(6);
    const fn = data.readUInt8(7);
    const address = data.readUInt16BE(8);
    const request = { fn, address, tid, unit, at: Date.now() };
    if (fn === 6) {
      request.value = data.readUInt16BE(10);
    } else {
      request.count = data.readUInt16BE(10);
    }
    panel.requests.push(request);
    const rule = panel.behave?.(request, panel);
    if (rule === 'silent') {
      return;
    }
    if (rule === 'close') {
      socket.destroy();
      return;
    }
    if (rule?.exception !== undefined) {
      answer(socket, frame(tid, unit, Buffer.from([fn | 0x80, rule.exception])));
      return;
    }
    if (fn === 6) {
      if (rule !== 'echo-only') {
        apply(address, request.value);
      }
      if (rule === 'silent-applied') {
        return;
      }
      answer(socket, frame(tid, unit, Buffer.from(data.subarray(7, 12))));
      return;
    }
    if (!panel.extended && address <= 118 && address + request.count - 1 >= 105) {
      answer(socket, frame(tid, unit, Buffer.from([fn | 0x80, 2])));
      return;
    }
    const pdu = Buffer.alloc(2 + request.count * 2);
    pdu[0] = fn;
    pdu[1] = request.count * 2;
    for (let i = 0; i < request.count; i += 1) {
      pdu.writeUInt16BE(panel.holding.get(address + i) ?? 0, 2 + i * 2);
    }
    answer(socket, frame(tid, unit, pdu));
  };

  panel.connect = ({ host, port }) => {
    panel.connects.push({ host, port });
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        if (socket.counted) {
          panel.open -= 1;
        }
        setImmediate(() => socket.emit('close'));
      }
    };
    socket.write = (data) => {
      if (!socket.destroyed) {
        handle(socket, Buffer.from(data));
      }
      return true;
    };
    panel.sockets.push(socket);
    const established = () => {
      if (socket.destroyed) {
        return;
      }
      if (panel.down) {
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        );
        socket.destroyed = true;
        socket.emit('close');
      } else {
        socket.counted = true;
        panel.open += 1;
        panel.maxOpen = Math.max(panel.maxOpen, panel.open);
        socket.emit('connect');
      }
    };
    if (panel.connectDelay > 0) {
      setTimeout(established, panel.connectDelay);
    } else {
      setImmediate(established);
    }
    return socket;
  };

  /** The writes received: [address, value]. */
  panel.writes = () => panel.requests.filter((r) => r.fn === 6).map((r) => [r.address, r.value]);
  panel.set = (address, value) => panel.holding.set(address, value);
  return panel;
}
