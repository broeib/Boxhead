import assert from 'node:assert/strict';

/**
 * Ordinary keyboard pilot for the UI checkpoint test. No native writes,
 * callbacks, RNG changes, event injection, or replacement simulation.
 * Extracted from original-invitation-e2e.mjs solo-sector-route-v2 and the
 * campaign's existing predictFireBall steering heuristic. Differences:
 * - caller owns fresh read-only observations and all trusted key events;
 * - nonblocking FIRE-off barrier; a later actual ACK permits replanning;
 * - campaign projectile-risk terms supplement the old zombie-only scorer.
 * These heuristics do not establish survival with damage/devils enabled.
 * CI/CD must qualify this helper with the real UI scenario.
 *
 * tick(state): state has own, peer, enemies, hazards, objects, pickups,
 * weapons, weapon, speed, invincible, nativeTick, enemyTick;
 * map={width,height,cells} or geometry={width,height}+grid (native string).
 * wire={frames:[{tick,p1,p2}], frameTick,ackTick} must be passive real wire
 * observations. Keep at least128 recent frames; no extra native calls.
 * setKeys(names) sends trusted keyboard releases first, movement downs next,
 * FIRE last. It must resolve only after all requested physical events finish.
 */
export function createCheckpointPilot({ slot = 1, setKeys, onTrace = async () => {} }) {
  assert(slot === 1 || slot === 2);
  assert.equal(typeof setKeys, 'function');
  const index = slot - 1;
  const profiles = [0, 1].map(() => ({ keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyE', 'KeyQ'] }));
  const held = [new Set(), new Set()], pilotWire = [null, null];
  const pilot = { combat: true, target: null, solo: null, fire: false,
    firePressedAfter: null, fireReleasedAfter: null, fireBarrierAfter: null };
  let stopped = false, inTick = false, lastTick = -1;
  async function applySoloKeys(unusedIndex, names) {
    const wanted = [...new Set(names)];
    assert(wanted.every(key => profiles[index].keys.includes(key) || /^Digit[123]$/.test(key)));
    await setKeys(wanted);
    held[index] = new Set(wanted);
  }
  return {
    async tick(observation) {
      assert(!inTick, 'Checkpoint pilot ticks must be serialized');
      if (stopped) return;
      inTick = true;
      try {
        const wire = observation.wire;
        assert(wire && Array.isArray(wire.frames) && Number.isSafeInteger(wire.frameTick)
          && Number.isSafeInteger(wire.ackTick), 'Missing passive native frame/ACK history');
        pilotWire[index] = wire;
        if (!observation.own || observation.own.life <= 0 || observation.complete
          || observation.own.state !== 'State_PlayerControl') {
          await applySoloKeys(index, []);
          await onTrace({ kind: 'control-unavailable', slot, tick: observation.nativeTick,
            life: observation.own?.life, state: observation.own?.state, complete: observation.complete });
          return;
        }
        assert(Number.isSafeInteger(observation.nativeTick) && observation.nativeTick <= wire.ackTick,
          'Pilot must use an ACKed native observation');
        if (observation.nativeTick === lastTick) return;
        assert(observation.nativeTick > lastTick, 'Native observation went backwards');
        if (pilot.fireBarrierAfter !== null) {
          const field = index ? 'p2' : 'p1';
          if (!wire.frames.some(frame => frame.tick > pilot.fireBarrierAfter
            && !(frame[field] & 16) && wire.ackTick >= frame.tick)) return;
          await onTrace({ kind: 'fire-release-barrier-ack', slot, tick: observation.nativeTick });
          pilot.fireBarrierAfter = null;
        }
        const geometry = observation.map ?? observation.geometry;
        const cells = observation.map?.cells ?? (typeof observation.grid === 'string'
          ? observation.grid.split('|').map(cell => Number(cell.split(';', 1)[0]) & 3) : observation.grid);
        assert(geometry && Number.isInteger(geometry.width) && Number.isInteger(geometry.height)
          && cells?.length === geometry.width * geometry.height, 'Actual original collision grid missing');
        const state = { ...observation, tick: observation.nativeTick,
          enemies: [...(observation.enemies ?? [])], hazards: [...(observation.hazards ?? [])],
          objects: [...(observation.objects ?? [])], pickups: [...(observation.pickups ?? [])] };
        const map = { width: geometry.width, height: geometry.height, cells, objects: state.objects };
        assert(Number.isFinite(state.speed) && state.speed > 0, 'Actual player speed missing');
        lastTick = state.nativeTick;
        await driveSoloPilot(index, pilot, state, map);
      } finally { inTick = false; }
    },
    async stop() { stopped = true; await applySoloKeys(index, []); },
  };

function directionKeys(index, dx, dy) {
  const keys = profiles[index].keys, result = [];
  if (Math.abs(dx) > Math.abs(dy) * .4143) result.push(keys[dx < 0 ? 2 : 3]);
  if (Math.abs(dy) > Math.abs(dx) * .4143) result.push(keys[dy < 0 ? 0 : 1]);
  return result;
}
function pilotPathClear(map, own, peer, dx, dy, length, includeCardinalLegs = false) {
  if (!dx && !dy) return true;
  // Two trusted keys can be sampled separately on either edge of a pulse.
  // Check both possible cardinal legs as well as the combined swept footprint.
  if (includeCardinalLegs && dx && dy
    && (!pilotPathClear(map, own, peer, dx, 0, length)
      || !pilotPathClear(map, own, peer, 0, dy, length))) return false;
  // Original Coop KeepDistance skips only a missing or DEAD-flagged peer and
  // clips increasing axis gaps beyond 19/13. This planner still vetoes the
  // whole swept candidate, not a simulation of native axis sliding or safety.
  const peerDistanceBoundApplies = peer && !(Number.isInteger(peer.flags) && (peer.flags & 32));
  const steps = Math.ceil(length / .2);
  for (let step = 1; step <= steps; step++) {
    const x = own.x + dx * length * step / steps, y = own.y + dy * length * step / steps;
    if (peerDistanceBoundApplies && ((Math.abs(x - peer.x) > 19 && Math.abs(x - peer.x) > Math.abs(own.x - peer.x)) ||
      (Math.abs(y - peer.y) > 13 && Math.abs(y - peer.y) > Math.abs(own.y - peer.y)))) return false;
    // PlayerCollide uses the original .45 radius with a .85 map factor.
    // Check the swept footprint, not just the destination on the other side
    // of a wall. This reads the retained native grid and sends no game state.
    for (const object of map.objects ?? []) {
      if (Math.hypot(x - object.xy[0], y - object.xy[1]) < .45 + (object.radius ?? .45)) return false;
    }
    if (peer?.life > 0 && Math.hypot(x - peer.x, y - peer.y) < .85 && Math.hypot(x - peer.x, y - peer.y) < Math.hypot(own.x - peer.x, own.y - peer.y)) return false;
    for (const ox of [-.39, .39]) for (const oy of [-.39, .39]) {
      const cx = Math.floor(x + ox), cy = Math.floor(y + oy);
      if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height || map.cells[cy * map.width + cx]) return false;
    }
  }
  return true;
}

function pilotGunLine(own, target, angle, muzzle, range, margin = .08) {
  if (!target || !muzzle) return null;
  assert(Number.isFinite(target.radius) && target.radius > 0, 'Actual native target radius is absent');
  // XSI offsets already use world axes. Original GetWeaponPosition adds them
  // directly; rotating them again or projecting muzzle Z would mis-aim.
  const x = own.x + muzzle.x, y = own.y + muzzle.y;
  const dx = target.xy[0] - x, dy = target.xy[1] - y;
  const along = dx * Math.cos(angle) + dy * Math.sin(angle);
  const across = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const tolerance = Math.max(0, target.radius - margin);
  return { x, y, along, across, radius: target.radius, tolerance,
    intersects: along >= 0 && along <= range && Math.abs(across) < tolerance };
}
// The solo cold-join pilot uses the V24 campaign's ordinary eight-sector
// fire/keyboard discipline and bounded map planning. These are steering
// heuristics over observed state, not a replacement simulation or hit proof.
function sectorAngleDifference(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}
function sectorVector(sector) {
  const angle = sector * Math.PI / 4;
  return [Math.round(Math.cos(angle)), Math.round(Math.sin(angle))];
}

function segmentDistance(ax, ay, bx, by, x, y) {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
  const along = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - ax - along * dx, y - ay - along * dy);
}

function wallMargin(map, x, y) {
  return Math.min(x - 1, y - 1, map.width - 2 - x, map.height - 2 - y);
}
function planEscape(map, state, escapingWall) {
  // A bounded plan over the actual original grid finds the open side of a
  // crowd. V1's 1.8-unit endpoint gradient oscillated along an occupied wall.
  const size = map.width * map.height;
  assert(size <= 4096, 'Escape planning exceeds its bounded native grid');
  const allowed = new Uint8Array(size), done = new Uint8Array(size);
  const cost = new Float64Array(size).fill(Infinity), previous = new Int32Array(size).fill(-1);
  const xOf = id => id % map.width + .5, yOf = id => Math.floor(id / map.width) + .5;
  const start = Math.floor(state.own.y) * map.width + Math.floor(state.own.x);
  if (start < 0 || start >= size) return null;
  for (let id = 0; id < size; id++) allowed[id] = Number(pilotPathClear(map,
    { x: xOf(id), y: yOf(id) }, null, 1, 0, .01));
  allowed[start] = 1; cost[start] = 0;
  const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let goal = -1, goalScore = -Infinity;
  for (let count = 0; count < size; count++) {
    let current = -1, cheapest = Infinity;
    for (let id = 0; id < size; id++) if (!done[id] && cost[id] < cheapest) { current = id; cheapest = cost[id]; }
    if (current < 0) break;
    done[current] = 1;
    const x = xOf(current), y = yOf(current);
    const zombieDistance = Math.min(8, ...state.enemies.filter(e => e.kind === 'CThing_Creature_Zombie')
      .map(e => Math.hypot(x - e.xy[0], y - e.xy[1])));
    const enemyDistance = Math.min(8, ...state.enemies.map(e => Math.hypot(x - e.xy[0], y - e.xy[1])));
    const margin = wallMargin(map, x, y), travel = Math.hypot(x - state.own.x, y - state.own.y);
    const peerDistance = state.peer?.life > 0 ? Math.hypot(x - state.peer.x, y - state.peer.y) : 0;
    const score = 2 * Math.min(zombieDistance, 6) + .35 * Math.min(enemyDistance, 5.5)
      + 1.1 * Math.min(margin, 4) - .12 * cheapest - .04 * Math.max(0, peerDistance - 9) ** 2;
    // A wall-escape goal must lie beyond the release margin, including the
    // .6-unit waypoint arrival tolerance. V2 could select margin 3.5 while
    // requiring >3.5 to release, so arrival did not end the firing restriction.
    if (travel >= 2.5 && margin >= (escapingWall ? 4.2 : 1.01) && score > goalScore) {
      goal = current; goalScore = score;
    }
    for (const [dx, dy] of directions) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const next = Math.floor(ny) * map.width + Math.floor(nx);
      if (!allowed[next] || done[next] || !pilotPathClear(map, { x, y }, state.peer, dx, dy, 1)) continue;
      let risk = 0;
      for (const enemy of state.enemies) {
        const d = segmentDistance(x, y, nx, ny, enemy.xy[0], enemy.xy[1]);
        if (d < 4) risk += (enemy.kind === 'CThing_Creature_Zombie' ? 4 : 1.5) / (d * d + .2);
        if (d < 1.25) risk += 50;
      }
      const nextCost = cheapest + Math.hypot(dx, dy) * (1 + risk);
      if (nextCost < cost[next]) { cost[next] = nextCost; previous[next] = current; }
    }
  }
  if (goal < 0) return null;
  const route = [];
  for (let id = goal, count = 0; id !== start && id >= 0 && count < size; id = previous[id], count++)
    route.push([xOf(id), yOf(id)]);
  return { plannedTick: state.tick, goal: [xOf(goal), yOf(goal)], path: route.reverse() };
}

function sectorLineOfSight(map, own, target) {
  const dx = target.xy[0] - own.x, dy = target.xy[1] - own.y, length = Math.hypot(dx, dy);
  for (let distance = .3; distance < length - .3; distance += .3) {
    const x = Math.floor(own.x + dx * distance / length), y = Math.floor(own.y + dy * distance / length);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height || (map.cells[y * map.width + x] & 1)) return false;
  }
  return true;
}
function sectorFireSafe(state, angle, range) {
  // A deliberately broad body-origin exclusion envelope, not an assertion
  // that a standing muzzle is the exact muzzle of a future walking shot.
  // Original friendly-fire, barrel explosions and all collisions stay active.
  const dx = Math.cos(angle), dy = Math.sin(angle), own = state.own;
  const spread = own.weapon === 'shotgun' ? (state.weapon?.mWideShot ? .15 : .07) : .02;
  const lateral = 1.25 + 2 * state.speed;
  if (state.peer?.life > 0) {
    const px = state.peer.x - own.x, py = state.peer.y - own.y;
    const along = px * dx + py * dy, across = Math.abs(-px * dy + py * dx);
    if (along > -1.25 && along < range + 1.5 && across < lateral + Math.max(0, along) * spread) return false;
  }
  for (const object of state.objects) {
    if (!object.kind.includes('Barrel')) continue;
    const px = object.xy[0] - own.x, py = object.xy[1] - own.y;
    const along = px * dx + py * dy, across = Math.abs(-px * dy + py * dx);
    if (along > -1 && along < range + 1 && across < lateral + Math.max(0, along) * spread
      && (Math.hypot(px, py) < 6 || (state.peer?.life > 0
        && Math.hypot(object.xy[0] - state.peer.x, object.xy[1] - state.peer.y) < 6))) return false;
  }
  return true;
}
function sectorMembers(state, map, angle, range) {
  return state.enemies.filter(enemy => {
    const dx = enemy.xy[0] - state.own.x, dy = enemy.xy[1] - state.own.y;
    return Math.hypot(dx, dy) <= range + .5 && sectorAngleDifference(Math.atan2(dy, dx), angle) <= Math.PI / 6
      && sectorLineOfSight(map, state.own, enemy);
  });
}
function chooseFireSector(state, map, previous, range) {
  const options = [];
  for (let sector = 0; sector < 8; sector++) {
    const angle = sector * Math.PI / 4;
    if (!sectorFireSafe(state, angle, range)) continue;
    const members = sectorMembers(state, map, angle, range);
    let score = 0;
    for (const enemy of members) {
      const dx = enemy.xy[0] - state.own.x, dy = enemy.xy[1] - state.own.y;
      const distance = Math.hypot(dx, dy), difference = sectorAngleDifference(Math.atan2(dy, dx), angle);
      score += (enemy.kind === 'CThing_Creature_Zombie' ? 3 : 1.6)
        * (1 - .75 * difference / (Math.PI / 6)) / (1 + distance * .35);
      if (distance < 2.5) score += 1.5;
    }
    options.push({ sector, angle, score, members });
  }
  options.sort((a, b) => b.score - a.score);
  const best = options[0], retained = options.find(option => option.sector === previous);
  // Keep pressure on an approaching group; a different individual becoming
  // slightly nearer does not trigger another stop/aim/weapon-selection cycle.
  const chosen = retained?.score > 0 && retained.score >= (best?.score ?? 0) * .6 ? retained : best;
  return chosen?.score > 0 ? chosen : null;
}
function sectorTransitionAngles(index, state, movement) {
  const old = profiles[index].keys.slice(0, 4).filter(key => held[index].has(key));
  if (old.length === movement.length && old.every(key => movement.includes(key))) {
    return [state.own.angle, ...(movement.length ? [Math.atan2(
      Number(movement.includes(profiles[index].keys[1])) - Number(movement.includes(profiles[index].keys[0])),
      Number(movement.includes(profiles[index].keys[3])) - Number(movement.includes(profiles[index].keys[2])))] : [])];
  }
  // Real key transitions are not atomic. Include each cardinal leg that can
  // remain while old keys are released or new diagonal keys are pressed.
  const angles = [state.own.angle];
  for (const key of new Set([...old, ...movement])) {
    const direction = profiles[index].keys.indexOf(key);
    angles.push([Math.PI * 1.5, Math.PI * .5, Math.PI, 0][direction]);
  }
  if (movement.length) angles.push(Math.atan2(
    Number(movement.includes(profiles[index].keys[1])) - Number(movement.includes(profiles[index].keys[0])),
    Number(movement.includes(profiles[index].keys[3])) - Number(movement.includes(profiles[index].keys[2]))));
  return angles;
}

function sectorWeaponChoice(state) {
  const choices = (state.weapons ?? []).filter(weapon => weapon.active && weapon.properties?.mAmmo > 0
    && ['pistol', 'uzi', 'shotgun'].includes(weapon.name)).map(weapon => {
    const props = weapon.properties;
    // Original shotgun FastFire is earned at multiplier 18 (own personal peak
    // 17). An unselected instance can still report mAuto=false until its next
    // native Weapon.Update. Use the earned mode ONLY for ranking; never change
    // the observed properties or the actual FIRE cadence/availability checks.
    const earnedShotgunFastFire = weapon.name === 'shotgun' && Number.isFinite(state.own.level) && state.own.level >= 17;
    const rankAuto = props.mAuto === true || earnedShotgunFastFire;
    const cycle = Math.max(1, props.mFireRate ?? 8) + (rankAuto ? 0 : 2);
    // Original Shotgun.Fire emits three bullets, or five with Wide/WiderShot,
    // for one ammo. This is projectile POTENTIAL, not expected or proven hits.
    // Keep the original broad-sector tactic and allow lawful shots that miss.
    const potentialProjectiles = weapon.name === 'shotgun' ? (props.mWideShot ? 5 : 3) : 1;
    const score = Math.max(1, props.mDamage ?? 26) / cycle * (rankAuto ? 1.15 : 1) * potentialProjectiles;
    return { ...weapon, score, rankAuto, earnedShotgunFastFire, potentialProjectiles };
  });
  choices.sort((a, b) => b.score - a.score || Number(b.name === state.own.weapon) - Number(a.name === state.own.weapon));
  return { choices, preferred: choices[0], current: choices.find(weapon => weapon.name === state.own.weapon) };
}
function sectorPhysicalFire(index, pilot, state, allowed) {
  if (!allowed) return false;
  if (state.weapon?.mAuto === true) return true;
  const wire = pilotWire[index], field = index ? 'p2' : 'p1';
  if (held[index].has(profiles[index].keys[4])) {
    // A semi-automatic shot needs a real down edge followed by a real release.
    // Do not pulse faster than the actual outgoing frame/ACK can sample it.
    return !wire.frames.some(frame => frame.tick > (pilot.firePressedAfter ?? wire.frameTick)
      && (frame[field] & 16) && wire.ackTick >= frame.tick);
  }
  if (pilot.fireReleasedAfter !== null && !wire.frames.some(frame => frame.tick > pilot.fireReleasedAfter
    && !(frame[field] & 16) && wire.ackTick >= frame.tick)) return false;
  return (state.weapon?.mFireRateCount ?? 0) <= 1;
}


function predictFireBall(hazard, map, playerX, playerY, moveX = 0, moveY = 0, playerSpeed = .16, motionPath = null) {
  let [vx, vy] = hazard.delta ?? [], [hx, hy] = hazard.xy;
  const radius = Number.isFinite(hazard.radius) && hazard.radius > 0
    ? hazard.radius : hazard.damageMultiply ? 1 : .25;
  const nearDistance = hazard.damageMultiply ? 2.5 : 2;
  let px = playerX, py = playerY;
  const currentDistance = Math.hypot(hx - px, hy - py);
  const horizonTicks = motionPath ? motionPath.horizonTicks : 18;
  const result = { horizonTicks, inputDelayTicks: motionPath ? null : 2, currentDistance,
    minimumFlightDistance: currentDistance, minimumDistance: currentDistance,
    firstThreatStep: currentDistance < nearDistance ? 0 : null,
    wallImpact: null, terminatedByStaticWall: false,
    dynamicCollisionsModelled: false, unknownVelocity: false };
  if (motionPath) Object.assign(result, { motionEndTick: motionPath.endTick,
    endDistance: null, completedHorizon: false, playerMotion: 'bounded-observed-mask-path' });
  if (![vx, vy].every(Number.isFinite)) {
    result.unknownVelocity = true;
    return result;
  }
  const hasMap = Number.isInteger(map?.width) && Number.isInteger(map?.height)
    && map.width > 2 && map.height > 2 && map.cells?.length === map.width * map.height;
  const staticCollision = (x, y) => {
    // QCollide_Map uses GetCellBounds_Min: floor bounds, inclusive cells.
    const left = Math.max(0, Math.floor(x - radius));
    const right = Math.min(map.width - 1, Math.floor(x + radius));
    const top = Math.max(0, Math.floor(y - radius));
    const bottom = Math.min(map.height - 1, Math.floor(y + radius));
    for (let cy = top; cy <= bottom; cy++) for (let cx = left; cx <= right; cx++)
      if (map.cells[cy * map.width + cx] & 3) return true;
    return false;
  };
  for (let step = 1; step <= horizonTicks; step++) {
    vx *= 1.02; vy *= 1.02;
    const nextHX = hx + vx, nextHY = hy + vy;
    const nextPX = motionPath ? motionPath.points[step].x : px + (step > 2 ? moveX * playerSpeed : 0);
    const nextPY = motionPath ? motionPath.points[step].y : py + (step > 2 ? moveY * playerSpeed : 0);
    // The original outermost cells carry EdgeOfMap, where Collide_Map exits
    // before QCollide_Map. Cached static bits alone must not claim a stop there.
    const inside = hasMap && Math.floor(hx) > 0 && Math.floor(hx) < map.width - 1
      && Math.floor(hy) > 0 && Math.floor(hy) < map.height - 1;
    if (inside && staticCollision(nextHX, nextHY)) {
      // GenericCollide returns before FireBall.Move. The effect is centered
      // at PRE-MOVE (hx,hy), not the proposed next center or a wall intersection.
      // AffectArea uses the wider GetCellBounds (round - 1), then affects any
      // eligible resident whose center/mapwho cell is in this rectangle.
      const cells = { left: Math.max(0, Math.round(hx - radius) - 1),
        right: Math.min(map.width - 1, Math.round(hx + radius)),
        top: Math.max(0, Math.round(hy - radius) - 1),
        bottom: Math.min(map.height - 1, Math.round(hy + radius)) };
      // Include the complete one-step cell envelope, also at diagonal corner
      // crossings; either player/shot processing order is covered conservatively.
      const playerCells = [];
      for (let y = Math.floor(Math.min(py, nextPY)); y <= Math.floor(Math.max(py, nextPY)); y++)
        for (let x = Math.floor(Math.min(px, nextPX)); x <= Math.floor(Math.max(px, nextPX)); x++)
          playerCells.push([x, y]);
      const threatensPlayer = playerCells.some(([x, y]) => x >= cells.left && x <= cells.right
        && y >= cells.top && y <= cells.bottom);
      result.wallImpact = { step, x: hx, y: hy, nextX: nextHX, nextY: nextHY,
        radius, cells, playerCells, threatensPlayer };
      result.terminatedByStaticWall = true;
      if (threatensPlayer) {
        result.minimumDistance = 0;
        result.firstThreatStep ??= step;
      }
      return result;
    }
    const distance = segmentDistance(hx - px, hy - py, nextHX - nextPX, nextHY - nextPY, 0, 0);
    result.minimumFlightDistance = Math.min(result.minimumFlightDistance, distance);
    result.minimumDistance = result.minimumFlightDistance;
    if (distance < nearDistance) result.firstThreatStep ??= step;
    hx = nextHX; hy = nextHY; px = nextPX; py = nextPY;
  }
  // This is a bounded steering forecast, not a second world simulation.
  // A creature/object may cause an EARLIER native impact; it is not predicted
  // as harmless, and no future position or health is written back to the game.
  if (motionPath) { result.endDistance = Math.hypot(hx - px, hy - py); result.completedHorizon = true; }
  return result;
}


function soloStep(state, map, pilot, goal, urgent) {
  const solo = pilot.solo, own = state.own;
  const range = own.weapon === 'pistol' ? 8 : state.weapon?.mRange ?? 8;
  const candidates = [];
  for (const length of [Math.max(.8, state.speed * 5), .32]) {
    for (let sector = 0; sector < 8; sector++) {
      const [dx, dy] = sectorVector(sector);
      if (!pilotPathClear(map, own, null, dx, dy, length, true)) continue;
      const x = own.x + dx * length, y = own.y + dy * length;
      let score = Math.min(4, wallMargin(map, x, y)) * .8;
      if (goal) score -= 2.5 * Math.hypot(x - goal[0], y - goal[1]);
      for (const enemy of state.enemies) {
        const before = Math.hypot(enemy.xy[0] - own.x, enemy.xy[1] - own.y);
        const after = Math.hypot(enemy.xy[0] - x, enemy.xy[1] - y);
        const swept = segmentDistance(own.x, own.y, x, y, enemy.xy[0], enemy.xy[1]);
        if (after < 5) score -= 5 / (after * after + .3);
        if (swept < 1.3 && swept < before - .1) score -= 35;
        if (urgent && before < 3) score += 3 * Math.max(-1, Math.min(1, after - before));
      }
      // Existing campaign forecast; ranking only, never a native hit claim.
      for (const hazard of state.hazards ?? []) {
        const predicted = predictFireBall(hazard, map, own.x, own.y, dx, dy, state.speed);
        if (predicted.firstThreatStep !== null && predicted.firstThreatStep <= 6) score -= 40;
        score -= 8 / (predicted.minimumDistance * predicted.minimumDistance + .3);
      }
      if ((solo.blockedUntil[sector] ?? -1) > state.tick) score -= 60;
      if (solo.direction === sector) score += .1;
      const angle = sector * Math.PI / 4;
      if (sectorFireSafe(state, angle, range) && sectorMembers(state, map, angle, range).length) score += .5;
      candidates.push({ sector, dx, dy, score, length });
    }
    if (candidates.length) break;
  }
  candidates.sort((a, b) => b.score - a.score);
  return { choice: candidates[0] ?? null, candidates };
}
async function driveSoloPilot(index, pilot, state, map) {
  const own = state.own, wire = pilotWire[index], field = index ? 'p2' : 'p1';
  const solo = pilot.solo ??= {
    route: null, escapingWall: false, evading: false, blockedUntil: Array(8).fill(-1),
    previous: null, stuckTicks: 0, direction: null, sector: null,
    lastPlanTick: -100, selection: null, selectionAfter: -100, lastKills: own.kills,
    lastKillTick: state.tick, nextNudgeAt: -1, nudge: null,
  };
  map.objects = state.objects;
  state.enemies.sort((a, b) => Math.hypot(a.xy[0] - own.x, a.xy[1] - own.y)
    - Math.hypot(b.xy[0] - own.x, b.xy[1] - own.y));
  const nearest = state.enemies[0];
  const distance = enemy => Math.hypot(enemy.xy[0] - own.x, enemy.xy[1] - own.y);
  const nearestDistance = nearest ? distance(nearest) : Infinity;
  const range = own.weapon === 'pistol' ? 8 : state.weapon?.mRange ?? 8;
  const margin = wallMargin(map, own.x, own.y), protectedNow = state.invincible > 12;
  const appliedMask = wire.frames.find(frame => frame.tick === state.nativeTick)?.[field] ?? 0;
  const previous = solo.previous;
  if (previous && state.tick > previous.tick && own.state === 'State_PlayerControl'
    && previous.state === 'State_PlayerControl' && (appliedMask & 15) && (previous.mask & 15)) {
    solo.stuckTicks = Math.hypot(own.x - previous.x, own.y - previous.y) < .025
      ? solo.stuckTicks + state.tick - previous.tick : 0;
  } else solo.stuckTicks = 0;
  if (solo.stuckTicks >= 4 && solo.direction !== null) {
    // A repeatedly ineffective chord is a rejected candidate, rather than
    // a small detour preference that can keep choosing the same blocked axis.
    solo.blockedUntil[solo.direction] = state.tick + 24;
    solo.route = null; solo.stuckTicks = 0; solo.lastPlanTick = -100;
  }
  if (own.kills !== solo.lastKills) {
    solo.lastKills = own.kills; solo.lastKillTick = state.tick; solo.nudge = null;
  }
  let choice = chooseFireSector(state, map, solo.sector, range);
  // Survival takes priority over retaining a distant firing group. The old
  // pilot could retain a target four units away with a biting enemy at .9.
  if (nearest && nearestDistance < 3.2 && sectorLineOfSight(map, own, nearest)) {
    const nearAngle = Math.atan2(nearest.xy[1] - own.y, nearest.xy[0] - own.x);
    const nearSectors = Array.from({ length: 8 }, (_, sector) => {
      const angle = sector * Math.PI / 4;
      return { sector, angle, members: sectorMembers(state, map, angle, range),
        difference: sectorAngleDifference(angle, nearAngle), score: 0 };
    }).filter(value => value.members.some(enemy => enemy.id === nearest.id)
      && sectorFireSafe(state, value.angle, range)).sort((a, b) => a.difference - b.difference);
    choice = nearSectors[0] ?? choice;
  }
  if (choice) solo.sector = choice.sector;
  pilot.target = choice?.members[0]?.id ?? nearest?.id ?? null;
  const aligned = choice && sectorAngleDifference(own.angle, choice.angle) <= Math.PI / 12;
  const behindThreat = state.enemies.some(enemy => distance(enemy) < 2.8
    && sectorAngleDifference(Math.atan2(enemy.xy[1] - own.y, enemy.xy[0] - own.x), own.angle) > Math.PI / 3);
  if (protectedNow || (aligned && nearestDistance > 2.6)) solo.evading = false;
  else if (nearestDistance < 2.1 || behindThreat) solo.evading = true;
  else if (nearestDistance > 4.2) solo.evading = false;
  if (margin < 3 && nearestDistance < 7) solo.escapingWall = true;
  if (margin > 4.2) solo.escapingWall = false;
  const projectileDanger = !protectedNow && (state.hazards ?? []).some(hazard => {
    const forecast = predictFireBall(hazard, map, own.x, own.y);
    return forecast.firstThreatStep !== null && forecast.firstThreatStep <= 10;
  });
  const urgent = !protectedNow && (nearestDistance < 1.5 || behindThreat || projectileDanger);
  const needsRoute = solo.escapingWall || solo.evading;
  if (needsRoute && (!solo.route || state.tick - solo.route.plannedTick >= 40)
    && state.tick - solo.lastPlanTick >= 12) {
    solo.route = planEscape(map, state, solo.escapingWall); solo.lastPlanTick = state.tick;
  }
  if (!needsRoute) solo.route = null;
  while (solo.route?.path.length && Math.hypot(own.x - solo.route.path[0][0], own.y - solo.route.path[0][1]) < .6)
    solo.route.path.shift();
  if (solo.route && !solo.route.path.length) {
    solo.route = null;
    if (margin >= 3.6) solo.escapingWall = false;
  }
  let movement = [], movementReason = 'hold-defensive-sector', plan = null;
  if (needsRoute || urgent) {
    plan = soloStep(state, map, pilot, solo.route?.path[0] ?? null, urgent);
    if (plan.choice) {
      movement = directionKeys(index, plan.choice.dx, plan.choice.dy);
      movementReason = solo.escapingWall ? 'leave-wall-route' : 'contact-escape';
    }
  }
  // A bounded ordinary lateral nudge prevents broad-sector fire from waiting
  // forever on a parallel missed ray. It never authorizes a guaranteed hit.
  if (!movement.length && !urgent && !needsRoute && aligned && state.muzzle
    && nearestDistance > 3.5 && state.tick - solo.lastKillTick >= 24
    && state.tick >= solo.nextNudgeAt) {
    const ray = choice.members.map(target => ({ target,
      line: pilotGunLine(own, target, choice.angle, state.muzzle, range) }))
      .filter(value => value.line?.along > .5 && value.line.along <= range)
      .sort((a, b) => Math.abs(a.line.across) - Math.abs(b.line.across))[0];
    if (ray && !ray.line.intersects) {
      const sign = Math.sign(ray.line.across);
      const dx = Math.round(-Math.sin(choice.angle) * sign), dy = Math.round(Math.cos(choice.angle) * sign);
      if (pilotPathClear(map, own, null, dx, dy, .5, true)
        && state.enemies.every(enemy => segmentDistance(own.x, own.y, own.x + dx * .5, own.y + dy * .5,
          enemy.xy[0], enemy.xy[1]) > 2)) {
        solo.nudge = { dx, dy, until: state.tick + 2, target: ray.target.id };
        solo.nextNudgeAt = state.tick + 24;
      }
    } else solo.nextNudgeAt = state.tick + 12;
  }
  if (!movement.length && solo.nudge && state.tick < solo.nudge.until && !urgent && !needsRoute) {
    movement = directionKeys(index, solo.nudge.dx, solo.nudge.dy); movementReason = 'ordinary-lateral-nudge';
  } else if (solo.nudge && (state.tick >= solo.nudge.until || urgent || needsRoute)) solo.nudge = null;
  if (!movement.length && !urgent && choice && !aligned) {
    const [dx, dy] = sectorVector(choice.sector);
    if (pilotPathClear(map, own, null, dx, dy, Math.max(.4, state.speed * 3), true)) {
      movement = directionKeys(index, dx, dy); movementReason = 'face-nearest-sector';
    }
  }
  const pickups = state.pickups.filter(pickup => distance(pickup) < 6
    && state.enemies.every(enemy => Math.hypot(enemy.xy[0] - pickup.xy[0], enemy.xy[1] - pickup.xy[1]) > 3));
  const needsPickup = own.life < 150 || (state.weapon?.mAmmo ?? 1) <= 10;
  if (!movement.length && !urgent && !needsRoute && needsPickup && nearestDistance > 4 && pickups.length) {
    pickups.sort((a, b) => distance(a) - distance(b));
    if (distance(pickups[0]) > .25) {
      plan = soloStep(state, map, pilot, pickups[0].xy, false);
      if (plan.choice) { movement = directionKeys(index, plan.choice.dx, plan.choice.dy); movementReason = 'ordinary-pickup'; }
    }
  }
  if (!movement.length && !choice && !urgent) {
    const goal = nearest && nearestDistance > range - 1 ? nearest.xy : [map.width / 2, map.height / 2];
    if (Math.hypot(own.x - goal[0], own.y - goal[1]) > .8) {
      plan = soloStep(state, map, pilot, goal, false);
      if (plan.choice) { movement = directionKeys(index, plan.choice.dx, plan.choice.dy); movementReason = 'open-sector'; }
    }
  }
  const moveX = Number(movement.includes(profiles[index].keys[3])) - Number(movement.includes(profiles[index].keys[2]));
  const moveY = Number(movement.includes(profiles[index].keys[1])) - Number(movement.includes(profiles[index].keys[0]));
  const fireAngle = movement.length ? Math.atan2(moveY, moveX) : own.angle;
  const transitionSafe = sectorTransitionAngles(index, state, movement).every(angle => sectorFireSafe(state, angle, range));
  const currentMovement = profiles[index].keys.slice(0, 4).filter(key => held[index].has(key));
  const movementChanged = currentMovement.length !== movement.length || currentMovement.some(key => !movement.includes(key));
  if (movementChanged && !transitionSafe && (held[index].has(profiles[index].keys[4]) || (appliedMask & 16))) {
    const after = wire.frameTick, fireKey = profiles[index].keys[4];
    await applySoloKeys(index, [...held[index]].filter(key => key !== fireKey));
    pilot.fire = false; pilot.fireReleasedAfter = after; pilot.fireBarrierAfter = after;
    // The next tick must observe the real FIRE-off ACK, then replan afresh.
    // No await loop consumes time without refreshing the native observation.
    solo.route = null; solo.nudge = null;
    await onTrace({ kind: 'fire-release-barrier-requested', slot, tick: state.nativeTick, after });
    return;
  }
  // Select only an actually earned weapon through its real number key. A
  // held selection is released only after a native frame sampled the bit.
  if (solo.selection?.phase === 'pressed' && wire.frames.some(frame =>
    frame.tick > solo.selection.after && (frame[field] & solo.selection.bit) && wire.ackTick >= frame.tick)) {
    solo.selection.phase = 'released'; solo.selection.releasedAfter = wire.frameTick;
  }
  if (solo.selection?.phase === 'released' && wire.frames.some(frame =>
    frame.tick > solo.selection.releasedAfter && !(frame[field] & solo.selection.bit) && wire.ackTick >= frame.tick)) {
    await onTrace({ kind: 'weapon-selection-observed', slot, requestedTick: solo.selection.tick,
      observedTick: state.tick, desired: solo.selection.name, actual: own.weapon });
    solo.selection = null; solo.selectionAfter = state.tick;
  }
  if (solo.selection && state.tick - solo.selection.tick > 40) {
    await onTrace({ kind: 'weapon-selection-observed', slot, requestedTick: solo.selection.tick,
      observedTick: state.tick, desired: solo.selection.name, actual: own.weapon, expired: true });
    solo.selection = null; solo.selectionAfter = state.tick;
  }
  const weapons = sectorWeaponChoice(state);
  if (!solo.selection && own.state === 'State_PlayerControl' && (protectedNow || nearestDistance > 4)
    && state.tick - solo.selectionAfter >= 200 && own.level >= 4) {
    const preferred = weapons.preferred, current = weapons.current;
    if (preferred && preferred.name !== own.weapon && (!current || preferred.score > current.score * 1.5)) {
      const number = { pistol: 1, uzi: 2, shotgun: 3 }[preferred.name];
      solo.selection = { name: preferred.name, key: 'Digit' + number, bit: 1 << (number + 6),
        tick: state.tick, after: wire.frameTick, phase: 'pressed' };
    }
  }
  const productive = sectorMembers(state, map, fireAngle, range).length > 0;
  const fire = sectorPhysicalFire(index, pilot, state, pilot.combat && productive && transitionSafe
    && own.state === 'State_PlayerControl' && (state.weapon?.mAmmo ?? 0) > 0 && !solo.selection);
  const wanted = [...movement, ...(fire ? [profiles[index].keys[4]] : []),
    ...(solo.selection?.phase === 'pressed' ? [solo.selection.key] : [])];
  const row = { client: index + 1, policy: 'solo-sector-route-v2', tick: state.tick, nativeTick: state.nativeTick,
    enemyTick: state.enemyTick, x: own.x, y: own.y, angle: own.angle, state: own.state, life: own.life,
    score: own.score, kills: own.kills, level: own.level, weapon: own.weapon, ammo: own.ammo,
    target: pilot.target, nearest: nearest?.id, nearestDistance, wallMargin: margin,
    invincible: state.invincible, protectedNow, evading: solo.evading, escapingWall: solo.escapingWall,
    movementReason, routeGoal: solo.route?.goal, routeNext: solo.route?.path[0],
    candidates: plan?.candidates, blockedUntil: [...solo.blockedUntil], stuckTicks: solo.stuckTicks,
    sector: choice?.sector, productive, transitionSafe, fireAngle, nativeAppliedMask: appliedMask,
    weaponAuto: state.weapon?.mAuto, weaponCooldown: state.weapon?.mFireRateCount,
    pendingSelection: solo.selection && { ...solo.selection }, keys: wanted,
    nearestEnemies: state.enemies.slice(0, 8), nearbyObjects: state.objects.filter(object => distance(object) < 4).slice(0, 8) };
  await onTrace(row);
  const wasFire = held[index].has(profiles[index].keys[4]), requestedAfter = wire.frameTick;
  await applySoloKeys(index, wanted);
  if (fire && !wasFire) pilot.firePressedAfter = requestedAfter;
  if (!fire && wasFire) pilot.fireReleasedAfter = requestedAfter;
  pilot.fire = fire; pilot.movementSettled = !movement.length && !(appliedMask & 15);
  pilot.firingReleased = !fire && !(appliedMask & 16);
  if (movement.length) solo.direction = (Math.round(fireAngle / (Math.PI / 4)) + 8) % 8;
  solo.previous = { x: own.x, y: own.y, tick: state.tick, state: own.state, mask: appliedMask };
}

}
