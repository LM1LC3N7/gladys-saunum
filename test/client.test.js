// -----------------------------------------------------------------------------
// The Modbus TCP client: frames, attribution of the answers, bounds, one
// request at a time, timeouts and `sent`. A scripted socket stands for the
// panel; the last test runs the real node:net transport on a loopback server.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { ERROR_KINDS, Gate, ModbusClient, ModbusError, PRIORITY } from '../src/modbus/client.js';
import { settle } from './fixtures/fakePanel.js';

/** A socket the test answers by hand: `written` holds the frames sent. */
function scripted({ refuse = false } = {}) {
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.written = [];
    socket.destroyed = false;
    socket.setNoDelay = () => {};
    socket.write = (data) => socket.written.push(Buffer.from(data));
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        setImmediate(() => socket.emit('close'));
      }
    };
    sockets.push(socket);
    setImmediate(() => {
      if (refuse) {
        socket.emit('error', new Error('ECONNREFUSED'));
        socket.emit('close');
      } else {
        socket.emit('connect');
      }
    });
    return socket;
  };
  return { sockets, connect };
}

const frame = (tid, unit, pdu) => {
  const out = Buffer.alloc(7 + pdu.length);
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(pdu.length + 1, 4);
  out.writeUInt8(unit, 6);
  Buffer.from(pdu).copy(out, 7);
  return out;
};

const client = (connect, options = {}) =>
  new ModbusClient({ host: '10.0.0.5', port: 502, unitId: 1, connect, spacing: 0, ...options });

async function sentFrame(sockets) {
  await settle();
  const socket = sockets.at(-1);
  return { socket, frame: socket.written.at(-1) };
}

test('an answer that is not the one of the request is refused and the connection dropped', async () => {
  const cases = [
    ['another transaction', (tid) => frame(tid + 1, 1, [3, 2, 0, 1])],
    ['another unit', (tid) => frame(tid, 2, [3, 2, 0, 1])],
    ['another function', (tid) => frame(tid, 1, [4, 2, 0, 1])],
    ['a wrong byte count', (tid) => frame(tid, 1, [3, 4, 0, 1, 0, 2])],
    ['a protocol id', (tid) => Buffer.concat([frame(tid, 1, [3, 2, 0, 1])]).fill(1, 2, 3)],
    ['trailing bytes', (tid) => Buffer.concat([frame(tid, 1, [3, 2, 0, 1]), Buffer.from([0])])],
    ['a frame too long', (tid) => frame(tid, 1, [3, 254, ...new Array(260).fill(0)])],
  ];
  for (const [name, build] of cases) {
    const { sockets, connect } = scripted();
    const c = client(connect);
    const read = c.readHolding(1500, 1);
    const { socket, frame: sent } = await sentFrame(sockets);
    socket.emit('data', build(sent.readUInt16BE(0)));
    await assert.rejects(read, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent, name);
    await settle();
    assert.equal(socket.destroyed, true, name);
    // The next request opens a new connection.
    const next = c.readHolding(1500, 1);
    const again = await sentFrame(sockets);
    assert.notEqual(again.socket, socket, name);
    again.socket.emit('data', frame(again.frame.readUInt16BE(0), 1, [3, 2, 0, 7]));
    assert.deepEqual(await next, [7], name);
    c.close();
  }
});

test('an answer split over several chunks is put back together', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  const answer = frame(sent.readUInt16BE(0), 1, [3, 2, 0, 3]);
  socket.emit('data', answer.subarray(0, 4));
  socket.emit('data', answer.subarray(4));
  assert.deepEqual(await read, [3]);
  c.close();
});

test('data with no request in flight drops the connection', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [3, 2, 0, 3]));
  await read;
  socket.emit('data', frame(99, 1, [3, 2, 0, 3]));
  await settle();
  assert.equal(socket.destroyed, true);
  c.close();
});

test('a silence times out, sent; the connection is dropped so a late answer is never taken', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(1500, 1, { timeoutMs: 1000 });
  const { socket, frame: sent } = await sentFrame(sockets);
  t.mock.timers.tick(1000);
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true);
  await settle();
  assert.equal(socket.destroyed, true);
  // The late answer arrives on the dropped socket: ignored.
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [3, 2, 0, 9]));
  const next = c.readHolding(1500, 1);
  const again = await sentFrame(sockets);
  assert.notEqual(again.socket, socket);
  again.socket.emit('data', frame(again.frame.readUInt16BE(0), 1, [3, 2, 0, 1]));
  assert.deepEqual(await next, [1]);
  c.close();
});

test('nothing listening: unreachable, not sent', async () => {
  const { connect } = scripted({ refuse: true });
  const c = client(connect);
  await assert.rejects(
    c.writeRegister(1500, 3, {}),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && err.sent === false,
  );
});

test('beforeSend runs once connected, right before the bytes; what it throws leaves nothing sent', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const refusal = new Error('option off');
  const write = c.writeRegister(1500, 3, {
    beforeSend: () => {
      throw refusal;
    },
  });
  await assert.rejects(write, (err) => err === refusal && err.beforeSend === true);
  await settle();
  assert.equal(sockets[0].written.length, 0);
  c.close();
});

test('requests out of bounds are refused before the wire', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  await assert.rejects(c.readHolding(0, 126), RangeError);
  await assert.rejects(c.readHolding(65535, 2), RangeError);
  await assert.rejects(c.writeRegister(1500, 70000, {}), RangeError);
  await assert.rejects(c.writeRegister(1500, 1.5, {}), RangeError);
  assert.equal(sockets.length, 0);
});

test('the real transport on a loopback server', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const tid = data.readUInt16BE(0);
      socket.write(frame(tid, 1, [3, 2, 0x01, 0x87]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const c = new ModbusClient({ host: '127.0.0.1', port: server.address().port, unitId: 1 });
  try {
    assert.deepEqual(await c.readHolding(5001, 1), [391]);
    assert.deepEqual(await c.readHolding(5001, 1), [391]);
  } finally {
    c.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a read of holding registers: the frame on the wire, then the words', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(100, 2);
  const { socket, frame: sent } = await sentFrame(sockets);
  assert.deepEqual([...sent], [0, 1, 0, 0, 0, 6, 1, 3, 0, 100, 0, 2]);
  socket.emit('data', frame(1, 1, [3, 4, 0x00, 0x16, 0xff, 0xfe]));
  assert.deepEqual(await read, [22, 0xfffe]);
  c.close();
});

test('a Modbus exception is a refusal: the connection stays', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(100, 19);
  const { socket, frame: sent } = await sentFrame(sockets);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [0x83, 2]));
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.EXCEPTION && err.code === 2);
  assert.equal(socket.destroyed, false);
  c.close();
});

test('a write: its echo exactly, else a protocol error, sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sockets, connect } = scripted();
  const c = client(connect);
  const write = c.writeRegister(0, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  assert.deepEqual([...sent.subarray(6)], [1, 6, 0, 0, 0, 1]);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [6, 0, 0, 0, 1]));
  assert.equal(await write, 1);
  const bad = c.writeRegister(0, 0);
  t.mock.timers.tick(500);
  const second = await sentFrame(sockets);
  second.socket.emit('data', frame(second.frame.readUInt16BE(0), 1, [6, 0, 0, 0, 1]));
  await assert.rejects(bad, (err) => err.kind === ERROR_KINDS.PROTOCOL && err.sent === true);
  c.close();
});

test('the gate: one job at a time, 500 ms apart; a turn off before commands before reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = new Gate({ spacing: 500 });
  const order = [];
  let release;
  const running = gate.run(() => new Promise((resolve) => (release = resolve)));
  const read = gate.run(async () => order.push(['read', Date.now()]));
  const command = gate.run(async () => order.push(['command', Date.now()]), {
    priority: PRIORITY.COMMAND,
  });
  const stop = gate.run(async () => order.push(['stop', Date.now()]), {
    priority: PRIORITY.PROTECT,
  });
  const late = gate.run(async () => order.push(['late']), {
    priority: PRIORITY.COMMAND,
    startBy: Date.now() + 100,
  });
  t.mock.timers.tick(100);
  await assert.rejects(late, (err) => err instanceof ModbusError && err.kind === ERROR_KINDS.LATE);
  release();
  await settle();
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(500);
  await Promise.all([running, read, command, stop]);
  assert.deepEqual(
    order.map(([name]) => name),
    ['stop', 'command', 'read'],
  );
  assert.equal(order[1][1] - order[0][1], 500);
  assert.equal(order[2][1] - order[1][1], 500);
});

test('closing: queued reads and commands are dropped (not sent), a queued turn off still runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gate = new Gate({ spacing: 500 });
  const order = [];
  let release;
  const running = gate.run(() => new Promise((resolve) => (release = resolve)));
  const read = gate.run(async () => order.push('read'));
  const stop = gate.run(async () => order.push('stop'), { priority: PRIORITY.PROTECT });
  let closed = false;
  const closing = gate.close().then(() => (closed = true));
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.CLOSED && err.sent === false);
  await assert.rejects(
    gate.run(async () => order.push('after')),
    (err) => err.kind === ERROR_KINDS.CLOSED,
  );
  release();
  await settle();
  assert.equal(closed, false);
  t.mock.timers.tick(500);
  await Promise.all([running, stop, closing]);
  assert.deepEqual(order, ['stop']);
  assert.equal(closed, true);
});

test('one connection at a time: a new client connects only once the previous one is closed', async () => {
  const { sockets, connect } = scripted();
  const first = client(connect);
  const read = first.readHolding(0, 7);
  const one = await sentFrame(sockets);
  let done;
  const after = new Promise((resolve) => (done = resolve));
  const second = client(connect, { after });
  const next = second.readHolding(0, 7);
  await settle();
  assert.equal(sockets.length, 1);
  one.socket.emit('data', frame(one.frame.readUInt16BE(0), 1, [3, 14, ...new Array(14).fill(0)]));
  await read;
  await first.close();
  assert.equal(one.socket.destroyed, true);
  done();
  const two = await sentFrame(sockets);
  assert.equal(sockets.length, 2);
  two.socket.emit('data', frame(two.frame.readUInt16BE(0), 1, [3, 14, ...new Array(14).fill(0)]));
  assert.equal((await next).length, 7);
  second.close();
});

test('an idle connection is closed after 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(0, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [3, 2, 0, 0]));
  await read;
  await settle();
  t.mock.timers.tick(9_999);
  assert.equal(socket.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(socket.destroyed, true);
  c.close();
});

test('close(): a connection still being opened is destroyed and awaited', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = () => true;
    socket.destroy = () => {
      if (!socket.destroyed) {
        socket.destroyed = true;
        setImmediate(() => socket.emit('close'));
      }
    };
    sockets.push(socket);
    return socket; // never connects by itself
  };
  const c = client(connect);
  const read = c.readHolding(0, 7, { startBy: Date.now() + 100 });
  await settle();
  t.mock.timers.tick(100);
  await assert.rejects(read, (err) => err.kind === ERROR_KINDS.LATE && err.sent === false);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyed, false, 'still connecting after the LATE');
  let closed = false;
  const closing = c.close().then(() => (closed = true));
  await settle();
  assert.equal(sockets[0].destroyed, true);
  await closing;
  assert.equal(closed, true);
});

test('a READ on the wire is cut for a turn off; a write never is', async () => {
  const { sockets, connect } = scripted();
  const c = client(connect);
  const read = c.readHolding(0, 7);
  await sentFrame(sockets);
  c.preemptRead();
  await assert.rejects(read, (err) => err.preempted === true && err.sent === true);
  const write = c.writeRegister(0, 1);
  const { socket, frame: sent } = await sentFrame(sockets);
  c.preemptRead();
  socket.emit('data', frame(sent.readUInt16BE(0), 1, [6, 0, 0, 0, 1]));
  assert.equal(await write, 1);
  c.close();
});
