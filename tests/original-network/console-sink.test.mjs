import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createConsoleSink } from '../../apps/original-server/telemetry.mjs';

class ConsoleStream extends EventEmitter {
  writes = [];
  writable = true;
  write(text, callback) {
    this.writes.push({ text, callback });
    return this.writable;
  }
  complete(index, error) { this.writes[index].callback(error); }
}

test('console backpressure waits for drain and preserves accepted line order', async () => {
  const stream = new ConsoleStream();
  stream.writable = false;
  let dropped = 0;
  const sink = createConsoleSink(stream, { onDrop: count => { dropped += count; } });
  sink.write('BOXHEAD PLAYER_JOIN userid=a username=A');
  sink.write('BOXHEAD METRICS example');
  sink.write('BOXHEAD PLAYER_LEAVE userid=a username=A');
  assert.equal(stream.writes.length, 1, 'write(false) accepts one line but blocks further writes');
  stream.complete(0);
  assert.equal(stream.writes.length, 1, 'write callback alone is not a drain signal');
  stream.writable = true;
  stream.emit('drain');
  assert.deepEqual(stream.writes.map(row => row.text), [
    'BOXHEAD PLAYER_JOIN userid=a username=A\n',
    'BOXHEAD METRICS example\n',
    'BOXHEAD PLAYER_LEAVE userid=a username=A\n',
  ]);
  stream.complete(1); stream.complete(2);
  sink.close();
  await nextTurn();
  assert.equal(dropped, 0);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('drain'), 0);
});

test('console byte and line limits include in-flight writes and count rejected lines once', async () => {
  const stream = new ConsoleStream();
  stream.writable = false;
  let dropped = 0;
  const sink = createConsoleSink(stream, { maxBytes: 12, maxLines: 2,
    onDrop: count => { dropped += count; } });
  assert.equal(sink.write('abcde'), true); // Six bytes including newline, in flight.
  assert.equal(sink.write('abcde'), true); // Six bytes waiting for drain.
  assert.equal(sink.write('x'), false);
  assert.equal(dropped, 1);
  stream.complete(0);
  assert.equal(sink.write('x'), true, 'completed writes release the bounded capacity');
  assert.equal(sink.write('z'), false, 'line cap applies even below the byte cap');
  stream.writable = true;
  stream.emit('drain');
  stream.complete(1); stream.complete(2);
  assert.equal(sink.write('123456789012'), false, 'one oversized line cannot bypass the bound');
  sink.close();
  await nextTurn();
  assert.equal(dropped, 3);
  assert.deepEqual(stream.writes.map(row => row.text), ['abcde\n', 'abcde\n', 'x\n']);
});

test('async write failure and its following error event count buffered lines once during stop', async () => {
  const stream = new ConsoleStream();
  stream.writable = false;
  let dropped = 0;
  const sink = createConsoleSink(stream, { onDrop: count => { dropped += count; } });
  sink.write('first'); sink.write('second');
  sink.close();
  const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  stream.complete(0, error);
  assert.doesNotThrow(() => stream.emit('error', error));
  assert.equal(dropped, 2);
  assert.equal(sink.write('after close'), false);
  assert.equal(dropped, 3);
  stream.emit('drain');
  assert.equal(stream.writes.length, 1);
  await nextTurn();
  assert.equal(stream.listenerCount('error'), 0);
});

test('an error event before write callbacks drops each pending or queued line once', async () => {
  const stream = new ConsoleStream();
  let dropped = 0;
  const sink = createConsoleSink(stream, { onDrop: count => { dropped += count; } });
  sink.write('first'); sink.write('second');
  const error = new Error('console unavailable');
  assert.doesNotThrow(() => stream.emit('error', error));
  stream.complete(0, error); stream.complete(1, error);
  assert.equal(dropped, 2);
  assert.equal(sink.write('third'), false);
  assert.equal(dropped, 3);
  sink.close();
  await nextTurn();
});

test('synchronous stream errors and close cannot escape the console sink', async () => {
  const stream = new ConsoleStream();
  stream.write = () => { throw new Error('unavailable'); };
  let dropped = 0;
  const sink = createConsoleSink(stream, { onDrop: count => { dropped += count; } });
  assert.equal(sink.write('first'), false);
  assert.doesNotThrow(() => stream.emit('close'));
  assert.equal(sink.write('second'), false);
  assert.equal(dropped, 2);
  sink.close();
  await nextTurn();
});
