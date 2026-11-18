import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/game/simulation';
import { helicopterGunPose, helicopterTarget, updatePoliceHelicopter } from '../src/game/policeHelicopter';
import { damagePlayer } from '../src/game/combat';
import type { PoliceHelicopter } from '../src/game/types';

function scene() {
  const sim = new Simulation();
  sim.world.buildings = []; sim.world.obstacles = [];
  sim.state.vehicles.forEach(car => { car.active = false; });
  sim.state.pedestrians = []; sim.state.officers = [];
  Object.assign(sim.state.player, { x: 0, z: 0, yaw: 0, vehicleId: null });
  sim.state.police.wanted = 5;
  return sim;
}
function advance(sim: Simulation, seconds: number, heal = false) {
  for (let tick = 0; tick < Math.round(seconds * 90); tick++) {
    if (heal) sim.state.combat.health = 100;
    sim.state.time += 1 / 90;
    updatePoliceHelicopter(sim.world, sim.state, 1 / 90);
  }
}
function overhead(): PoliceHelicopter {
  return { x: 0, y: 34, z: 27, yaw: Math.PI, rotor: 0, fireCooldown: 0, burst: 0,
    spawnedAt: 0, lastFireAt: -10, visible: false };
}

test('air support appears only at five stars and approaches without teleporting', () => {
  const sim = scene();
  for (const level of [0, 1, 2, 3, 4]) {
    sim.state.police.wanted = level; advance(sim, .02);
    assert.equal(sim.state.police.helicopter, null);
  }
  sim.state.police.wanted = 5; advance(sim, .02);
  const helicopter = sim.state.police.helicopter!;
  assert.ok(Math.hypot(helicopter.x, helicopter.z) > 125);
  const previous = { ...helicopter };
  advance(sim, .02);
  assert.equal(sim.state.police.helicopter, helicopter);
  assert.ok(Math.hypot(helicopter.x - previous.x, helicopter.z - previous.z) < 1);
  assert.equal(sim.state.combat.health, 100);
});

test('helicopter fire has an arrival delay, visible rifle traces and spaced bursts', () => {
  const sim = scene();
  advance(sim, 3.7);
  assert.equal(sim.state.combat.shots.length, 0);
  advance(sim, 2);
  const shots = sim.state.combat.shots;
  assert.ok(shots.length >= 3);
  assert.ok(shots.every(shot => shot.owner === 'police' && shot.weapon === 'rifle' && shot.from.y > 25));
  assert.ok(sim.state.combat.health < 100 && sim.state.combat.health >= 86);
  assert.ok(shots[1].time - shots[0].time >= .15);
  assert.ok(shots[2].time - shots[1].time >= .15);
  if (shots[3]) assert.ok(shots[3].time - shots[2].time >= 1.79);
});

test('the turret muzzle agrees with its downward aim at every helicopter heading', () => {
  const target = { x: 8, y: 1.3, z: -12 };
  for (const yaw of [0, .7, Math.PI, -2.4]) {
    const helicopter = { ...overhead(), yaw };
    const pose = helicopterGunPose(helicopter, target);
    assert.ok(pose.pitch > 0 && pose.pitch < Math.PI / 2);
    assert.ok(Math.abs(Math.hypot(pose.muzzle.x - pose.base.x, pose.muzzle.y - pose.base.y, pose.muzzle.z - pose.base.z) - 1.4) < 1e-10);
    const toTarget = { x: target.x - pose.muzzle.x, y: target.y - pose.muzzle.y, z: target.z - pose.muzzle.z };
    const distance = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
    for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(toTarget[axis] / distance - pose.direction[axis]) < 1e-10);
  }
});

test('solid overhead cover prevents sightings and bullets, even during a ready burst', () => {
  const sim = scene();
  sim.state.police.helicopter = overhead();
  sim.world.buildings.push({ id: 'covered-position', kind: 'building', x: 0, z: 0, width: 18, depth: 18, height: 28, yaw: 0, color: '#888888', style: 0 });
  advance(sim, 2);
  assert.equal(sim.state.police.helicopter?.visible, false);
  assert.equal(sim.state.combat.health, 100);
  assert.equal(sim.state.combat.shots.length, 0);
  sim.world.buildings = [];
  advance(sim, .02);
  assert.equal(sim.state.police.helicopter?.visible, true);
  assert.ok(sim.state.combat.shots.length > 0);
  assert.ok(sim.state.combat.health < 100);
});

test('air support tracks a moving driver and can damage the occupied car player', () => {
  const sim = scene();
  const car = sim.state.vehicles.find(vehicle => vehicle.kind === 'mission')!;
  Object.assign(car, { x: 0, z: 0, speed: 20, active: true });
  sim.state.player.vehicleId = car.id;
  sim.state.police.helicopter = overhead();
  advance(sim, .02);
  assert.equal(helicopterTarget(sim.state).y, 1.5);
  assert.ok(sim.state.combat.health < 100);
  for (let frame = 0; frame < 12 * 90; frame++) {
    car.z += 20 / 90; sim.state.player.z = car.z;
    advance(sim, 1 / 90, true);
  }
  const helicopter = sim.state.police.helicopter!;
  assert.ok(Math.hypot(helicopter.x - car.x, helicopter.z - car.z) < 55);
  assert.ok(helicopter.z > 190);
});

test('helicopter pursues between opposite map edges and stays above every roof', () => {
  const sim = scene();
  sim.world.buildings.push({ id: 'high-rise', kind: 'building', x: 120, z: 80, width: 20, depth: 20, height: 45, yaw: 0, color: '#aaaaaa', style: 0 });
  const edge = sim.world.size / 2 - 10;
  Object.assign(sim.state.player, { x: -edge, z: -edge });
  advance(sim, 5, true);
  const heli = sim.state.police.helicopter!;
  assert.ok(heli.y >= 52);
  Object.assign(sim.state.player, { x: edge, z: edge });
  const before = { ...heli };
  advance(sim, 1 / 90, true);
  assert.ok(Math.hypot(heli.x - before.x, heli.z - before.z) < .48, 'the helicopter must fly to the new position');
  advance(sim, sim.world.size * Math.SQRT2 / 42 + 8, true);
  assert.ok(Math.hypot(heli.x - edge, heli.z - edge) < 40);
  assert.ok(Math.abs(heli.x) <= sim.world.size / 2 - 8 && Math.abs(heli.z) <= sim.world.size / 2 - 8);
  assert.ok(heli.y >= 52);
});

test('wanted clear and player death remove air support; a later pursuit starts fresh', () => {
  const sim = scene();
  advance(sim, 4);
  const old = sim.state.police.helicopter;
  sim.state.police.wanted = 0; advance(sim, .02);
  assert.equal(sim.state.police.helicopter, null);
  sim.state.police.wanted = 5; advance(sim, .02);
  assert.notEqual(sim.state.police.helicopter, old);
  assert.ok(sim.state.police.helicopter!.fireCooldown > 3.7);
  damagePlayer(sim.state, 100); advance(sim, .02);
  assert.equal(sim.state.police.helicopter, null);
  assert.equal(sim.state.combat.dead, true);
});
