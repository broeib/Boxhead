import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Exact four source changes; restoring them must recover the complete
// actual v22 server before the older pacing reversal is applied.
const changes = [
  [
    "  function endRoom(room, reason, tick = room?.tick) {\n    const members = retireRoom(room, 'paused', reason);\n    for (const peer of members) {\n      send(peer, { type: 'paused', reason, tick, p1: 0, p2: 0 });\n      if (reason === 'peer_disconnected' && !peer.rejected && peer.ws.readyState === WebSocket.OPEN) {\n        // The room has been irreversibly retired. Another browser can still\n        // have a native ACK or key-release input in flight while receiving\n        // paused. Close this session normally and discard only its remaining\n        // transport data; no late message is accepted as verified gameplay.\n        peer.retiredClosing = true;\n        peer.ws.close(1000, 'peer_disconnected');\n        peer.closeTimer = setTimeout(() => peer.ws.terminate(), config.shutdownGraceMs);\n        peer.closeTimer.unref();\n      }\n    }\n  }\n",
    "  function endRoom(room, reason, tick = room?.tick) {\n    const members = retireRoom(room, 'paused', reason);\n    for (const peer of members) {\n      send(peer, { type: 'paused', reason, tick, p1: 0, p2: 0 });\n    }\n  }\n"
  ],
  [
    "    if (peer.rejected || peer.retiredClosing || stopping) return;",
    "    if (peer.rejected || stopping) return;"
  ],
  [
    "      ws, room: null, slot: 0, lastSequence: -1, lastAckTick: 0, completed: false, rejected: false, retiredClosing: false,",
    "      ws, room: null, slot: 0, lastSequence: -1, lastAckTick: 0, completed: false, rejected: false,"
  ],
  [
    "    for (const peer of peers) {\n      if (peer.retiredClosing) continue;\n      if (!peer.room && peer.browseHash) {",
    "    for (const peer of peers) {\n      if (!peer.room && peer.browseHash) {"
  ]
];

export function restorePeerDisconnectClosingSource(source) {
  let restored = source;
  for (const [current, previous] of changes) {
    const at = restored.indexOf(current);
    assert.notEqual(at, -1, 'Missing peer-disconnect closing source change');
    assert.equal(restored.indexOf(current, at + current.length), -1, 'Repeated closing source change');
    restored = restored.slice(0, at) + previous + restored.slice(at + current.length);
  }
  assert.equal(Buffer.byteLength(restored), 59509);
  assert.equal(createHash('sha256').update(restored).digest('hex'),
    'e79128c59042055a86788ff13a12003b6bd2271feaccf853c117ee5b2c19e86f');
  return restored;
}
