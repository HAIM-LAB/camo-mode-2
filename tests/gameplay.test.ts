import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { PLAYER_SPAWN, ROOM_BOUNDS } from '../src/config';
import {
  NearbyEntity,
  PlayerController,
  dropPosition,
  entitiesByProximity,
  nearestPickup,
  promptFor,
  readMovementIntent,
} from '../src/gameplay';

const entities: NearbyEntity[] = [
  { id: 'camo', label: 'Camo', kind: 'camo', position: new Vector3(-3, 0, -2) },
  { id: 'friend-a', label: 'Friend A', kind: 'friend', position: new Vector3(2, 0, -1) },
  { id: 'friend-b', label: 'Friend B', kind: 'friend', position: new Vector3(3.5, 0, -1) },
  { id: 'ball', label: 'Ball', kind: 'ball', position: new Vector3(-1, 0, 1) },
  { id: 'block', label: 'Building block', kind: 'block', position: new Vector3(0.5, 0, 1) },
];

describe('movement controls', () => {
  it('supports arrows and WASD with normalized diagonal movement', () => {
    const arrows = readMovementIntent(new Set(['arrowup', 'arrowright']));
    const wasd = readMovementIntent(new Set(['w', 'd']));

    expect(arrows.x).toBeCloseTo(Math.SQRT1_2);
    expect(arrows.y).toBeCloseTo(-Math.SQRT1_2);
    expect(wasd.equals(arrows)).toBe(true);
  });

  it('smoothly accelerates and remains constrained to the room footprint', () => {
    const controller = new PlayerController(PLAYER_SPAWN);
    controller.update(new Set(['arrowright']), 1 / 60);

    expect(controller.velocity.x).toBeGreaterThan(0);
    expect(controller.velocity.x).toBeLessThan(2.75);

    for (let frame = 0; frame < 1000; frame += 1) {
      controller.update(new Set(['arrowright', 'arrowdown']), 1 / 60);
    }

    expect(controller.position.x).toBeLessThanOrEqual(ROOM_BOUNDS.maxX);
    expect(controller.position.z).toBeLessThanOrEqual(ROOM_BOUNDS.maxZ);
    expect(controller.position.y).toBe(0);
  });

  it('decelerates instead of stopping abruptly', () => {
    const controller = new PlayerController(PLAYER_SPAWN);
    for (let frame = 0; frame < 30; frame += 1) {
      controller.update(new Set(['arrowup']), 1 / 60);
    }
    const movingSpeed = controller.velocity.length();
    controller.update(new Set(), 1 / 60);

    expect(controller.velocity.length()).toBeGreaterThan(0);
    expect(controller.velocity.length()).toBeLessThan(movingSpeed);
  });
});

describe('proximity and prompts', () => {
  it('sorts nearby scene anchors by planar distance', () => {
    const nearby = entitiesByProximity(new Vector3(-1, 0, 0.8), entities);
    expect(nearby.map((item) => item.id).slice(0, 2)).toEqual(['ball', 'block']);
  });

  it.each([
    ['camo', 'guide'],
    ['friend-a', 'friend'],
    ['friend-b', 'friend'],
    ['ball', 'pick up'],
    ['block', 'pick up'],
  ])('provides a readable proximity prompt for %s', (id, expectedText) => {
    const entity = entities.find((item) => item.id === id)!;
    const prompt = promptFor(entity.position.clone().add(new Vector3(0.2, 0, 0.2)), entities);
    expect(`${prompt.kicker} ${prompt.text}`.toLowerCase()).toContain(expectedText);
  });
});

describe('pickup and drop', () => {
  it('selects the nearest eligible object and excludes characters', () => {
    const player = new Vector3(-1.15, 0, 1);
    expect(nearestPickup(player, entities)?.id).toBe('ball');
    expect(nearestPickup(new Vector3(-3, 0, -2), entities)).toBeUndefined();
  });

  it('offers a drop action while an object is carried', () => {
    const ball = { ...entities[3], carried: true };
    const prompt = promptFor(new Vector3(), entities, ball);
    expect(prompt.action).toBe(true);
    expect(prompt.text).toContain('drop the ball');
  });

  it('drops in front of the player without leaving room bounds', () => {
    const dropped = dropPosition(
      new Vector3(ROOM_BOUNDS.maxX - 0.1, 0, ROOM_BOUNDS.maxZ - 0.1),
      new Vector3(1, 0, 1),
    );
    expect(dropped.x).toBeLessThanOrEqual(ROOM_BOUNDS.maxX);
    expect(dropped.z).toBeLessThanOrEqual(ROOM_BOUNDS.maxZ);
    expect(dropped.y).toBe(0);
  });
});
