import assert from 'node:assert/strict';

// Pure predicates over retained observations. They never step, pause, heal,
// alter or simulate the original world, and never erase an observed error.
export function checkpointAfterTarget(tick, target) {
  assert(Number.isSafeInteger(tick) && tick >= 0, 'Invalid observed native tick');
  assert(target === null || (Number.isSafeInteger(target) && target > 0), 'Invalid survival target');
  return target !== null && tick > target;
}

export function checkpointLifeScope(own, tick, target) {
  const afterTarget = checkpointAfterTarget(tick, target);
  if (!own) return { dead: false, afterTarget };
  assert(Number.isFinite(own.life), 'Invalid observed original player life');
  return { dead: own.life <= 0, afterTarget };
}

export function qualifyCheckpointSurvival(native, spawnTick, targetTick) {
  assert(Array.isArray(native) && native.length === 2);
  assert(Number.isSafeInteger(spawnTick) && spawnTick >= 3001);
  assert(Number.isSafeInteger(targetTick) && targetTick - spawnTick >= 400 && targetTick - spawnTick <= 1000,
    'The original 400-pair minimum must remain intact');
  const count = targetTick - spawnTick + 1;
  const prefixes = native.map(client => {
    assert(Array.isArray(client.steps));
    const rows = client.steps.filter(row => row.tick >= spawnTick && row.tick <= targetTick);
    assert.equal(rows.length, count, 'Missing or duplicated native survival state');
    for (let i = 0; i < count; i++) {
      const row = rows[i];
      assert.equal(row.tick, spawnTick + i, 'Native survival states are not contiguous');
      assert(row.error === undefined && !row.complete, 'Original game failed or completed inside the required window');
      assert(typeof row.digest === 'string' && row.digest.length > 0);
      assert(Array.isArray(row.players) && row.players.length === 2, 'Both original players must be present');
      for (const slot of [1, 2]) {
        const players = row.players.filter(player => player.slot === slot);
        assert.equal(players.length, 1, 'Missing or duplicate original player slot');
        assert(Number.isFinite(players[0].life) && players[0].life > 0,
          'Original player died inside the required native survival window');
      }
    }
    return rows;
  });
  for (let i = 0; i < count; i++) {
    assert.equal(prefixes[0][i].digest, prefixes[1][i].digest, 'Paired survival native digest differs');
    assert.deepEqual(prefixes[0][i].players, prefixes[1][i].players, 'Paired survival players differ');
  }
  return { schema: 'original-checkpoint-survival-prefix-v1', spawnTick, targetTick,
    pairedTransitions: count - 1, nativeStatesPerClient: count, aliveSlots: [1, 2],
    nativeAgreement: true, validated: true,
    scope: 'Every native state from spawn through the fixed target, inclusive; later collection time is outside survival qualification.' };
}

export function checkpointPostWindowDeaths(steps, client, targetTick) {
  assert(Array.isArray(steps) && (client === 1 || client === 2));
  const deaths = new Map();
  for (const step of steps) {
    if (!checkpointAfterTarget(step.tick, targetTick)) continue;
    for (const player of step.players ?? []) {
      assert(player.slot === 1 || player.slot === 2);
      if (!(player.life <= 0) || deaths.has(player.slot)) continue;
      deaths.set(player.slot, { kind: 'post-window-original-player-death', client, tick: step.tick,
        slot: player.slot, id: player.id, life: player.life, state: player.state,
        source: 'retained-native-Step', withinRequiredSurvivalWindow: false });
    }
  }
  return [...deaths.values()];
}

export function qualifyCheckpointPostWindowCompletion(message, witness, targetTick) {
  assert(message && message.type === 'completed' && checkpointAfterTarget(message.tick, targetTick));
  assert(typeof message.complete === 'string' && message.complete.length > 0 && message.complete.length <= 128);
  assert(witness && Array.isArray(witness.errors) && witness.errors.length === 0, 'Post-window native observer failed');
  assert.equal(witness.steps.length, 1, 'Post-window terminal lacks a unique native Step');
  assert.equal(witness.acks.length, 1, 'Post-window terminal lacks a unique actual ACK');
  assert.equal(witness.readbacks.length, 1, 'Post-window terminal lacks a unique verified receipt');
  assert.equal(witness.wireAcks.length, 1, 'Post-window terminal lacks a unique actual wire ACK');
  const step = witness.steps[0], ack = witness.acks[0], receipt = witness.readbacks[0], wireAck = witness.wireAcks[0];
  assert.equal(step.tick, message.tick); assert.equal(ack.tick, message.tick);
  assert.equal(receipt.tick, step.tick); assert.equal(step.worldTick, step.tick);
  assert(step.error === undefined && typeof step.digest === 'string' && step.digest.length > 0);
  assert.equal(step.complete, message.complete, 'Post-window completion differs from the native world');
  assert.equal(ack.complete, step.complete, 'Post-window ACK completion differs');
  assert.equal(ack.digest, step.digest, 'Post-window ACK digest differs');
  assert.equal(receipt.digest, step.digest); assert.deepEqual(receipt.players, step.players);
  assert.deepEqual(receipt.rng, step.rng);
  assert(typeof step.commandToken === 'string' && step.commandToken.length > 0 && step.commandToken.length <= 256);
  assert.equal(step.commandTick, step.tick); assert.equal(step.commandToken, receipt.receiptToken);
  assert.equal(ack.lastStepTick, step.tick); assert.equal(ack.receiptTick, step.tick);
  for (const key of ['tick', 'digest', 'complete']) assert.equal(wireAck[key], ack[key], 'Post-window wire ACK differs: ' + key);
  assert(Number.isSafeInteger(receipt.epoch) && receipt.epoch > 0); assert.equal(ack.receiptEpoch, receipt.epoch);
  assert.equal(ack.receiptCompletedAt, receipt.completedAt);
  assert(Number.isFinite(step.at) && Number.isFinite(step.elapsedMs) && step.elapsedMs >= 0
    && Number.isFinite(receipt.at) && step.at + step.elapsedMs <= receipt.at);
  assert(Number.isFinite(receipt.completedAt) && receipt.at <= receipt.completedAt,
    'Post-window receipt completion precedes its start');
  assert(Number.isFinite(ack.receiptCompletedAt) && Number.isFinite(ack.at) && ack.receiptCompletedAt <= ack.at);
  return { kind: 'post-window-original-completion', tick: step.tick, complete: step.complete,
    digest: step.digest, nativeAndAckVerified: true, withinRequiredSurvivalWindow: false };
}
