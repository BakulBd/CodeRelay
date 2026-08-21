/**
 * SSE framing.
 *
 * The property that matters here is not "parses valid streams" but "never
 * invents an event that was not fully received". A half-arrived tool call that
 * the parser dispatched anyway would defeat everything the ledger does
 * downstream, because the side effect would be real while the intent was
 * guessed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SseParser, parseSse } from '../../src/providers/sse.js';

test('a complete event is dispatched on the blank line', () => {
  const { events, end } = parseSse('event: message\ndata: hello\n\n');

  assert.deepEqual(events, [{ event: 'message', data: 'hello', id: null, retryMs: null }]);
  assert.equal(end.truncated, false);
});

test('repeated data fields are joined with newlines', () => {
  const { events } = parseSse('data: line one\ndata: line two\n\n');
  assert.equal(events[0]?.data, 'line one\nline two');
});

test('exactly one leading space after the colon is stripped', () => {
  const { events } = parseSse('data:  two spaces\n\n');
  assert.equal(events[0]?.data, ' two spaces');
});

test('a field with no colon has an empty value', () => {
  const { events } = parseSse('data\n\n');
  assert.equal(events[0]?.data, '');
});

test('comment lines are ignored, so keep-alive pings do not emit events', () => {
  const { events, end } = parseSse(': ping\n: ping\n\ndata: real\n\n');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, 'real');
  assert.equal(end.truncated, false);
});

test('unknown fields are ignored rather than breaking the parse', () => {
  const { events } = parseSse('weird: value\ndata: still fine\n\n');
  assert.equal(events[0]?.data, 'still fine');
});

test('id and retry are captured, and a non-numeric retry is discarded', () => {
  const { events } = parseSse('id: 42\nretry: 3000\ndata: a\n\nretry: soon\ndata: b\n\n');

  assert.equal(events[0]?.id, '42');
  assert.equal(events[0]?.retryMs, 3000);
  assert.equal(events[1]?.retryMs, null, 'an unparseable retry must not become a number');
});

test('an id containing NUL is ignored, as the specification requires', () => {
  const { events } = parseSse('id: bad\u0000id\ndata: a\n\n');
  assert.equal(events[0]?.id, null);
});

test('all three line terminators are accepted', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const { events, end } = parseSse(`data: x${eol}${eol}`);
    assert.equal(events.length, 1, `failed for ${JSON.stringify(eol)}`);
    assert.equal(events[0]?.data, 'x');
    assert.equal(end.truncated, false);
  }
});

test('an event split across chunks is only dispatched once complete', () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push('event: mes'), [], 'nothing is complete yet');
  assert.deepEqual(parser.push('sage\ndata: par'), []);
  assert.deepEqual(parser.push('tial\n'), [], 'the blank line has not arrived');

  const events = parser.push('\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, 'message');
  assert.equal(events[0]?.data, 'partial');
  assert.equal(parser.end().truncated, false);
});

test('a CRLF split across two chunks is one terminator, not two blank lines', () => {
  const parser = new SseParser();
  parser.push('data: x\r');
  // If the LF opened a new line, this would dispatch early with empty data.
  const events = parser.push('\ndata: y\n\n');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.data, 'x\ny');
});

// The failure this project exists for: the socket dies mid-response.
test('a stream that stops mid-event reports truncation and dispatches nothing', () => {
  const parser = new SseParser();
  const events = parser.push('event: content_block_delta\ndata: {"partial":');

  assert.deepEqual(events, [], 'a half-received event must never be dispatched');

  const end = parser.end();
  assert.equal(end.truncated, true);
  assert.match(end.remainder, /partial/);
});

test('a stream that stops after a complete event but with no trailing blank line is truncated', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: complete\n'), []);
  assert.equal(parser.end().truncated, true, 'the event never terminated');
});

test('a stream that ends cleanly reports no truncation and no remainder', () => {
  const parser = new SseParser();
  parser.push('data: a\n\ndata: b\n\n');

  assert.deepEqual(parser.end(), { truncated: false, remainder: '' });
});

test('trailing whitespace after the final event is not mistaken for truncation', () => {
  const { end } = parseSse('data: a\n\n\n');
  assert.equal(end.truncated, false);
});

test('a blank line with no fields dispatches nothing', () => {
  const { events, end } = parseSse('\n\n\n');
  assert.deepEqual(events, []);
  assert.equal(end.truncated, false);
});

test('an event carrying only a name and no data is still dispatched', () => {
  // Anthropic sends message_stop this way, so dropping it would lose the stop.
  const { events } = parseSse('event: message_stop\n\n');
  assert.deepEqual(events, [{ event: 'message_stop', data: '', id: null, retryMs: null }]);
});

test('end() resets the parser so a reused instance cannot leak state', () => {
  const parser = new SseParser();
  parser.push('data: leftover');
  assert.equal(parser.end().truncated, true);

  const events = parser.push('data: fresh\n\n');
  assert.equal(events[0]?.data, 'fresh', 'the discarded remainder must not reappear');
  assert.equal(parser.end().truncated, false);
});

test('one byte at a time parses identically to one whole chunk', () => {
  const body = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: two\ndata: lines\n\n';

  const whole = parseSse(body);
  const parser = new SseParser();
  const drip = body.split('').flatMap((ch) => parser.push(ch));

  assert.deepEqual(drip, whole.events);
  assert.equal(parser.end().truncated, false);
});
