import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { normalizeModelPlacement } from '../src/assets';

describe('optional asset placement', () => {
  it('does not alter scale or placement for a contract-compliant model', () => {
    const model = new Group();
    const geometry = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    geometry.position.y = 0.5;
    model.add(geometry);

    normalizeModelPlacement(model);

    expect(model.position.toArray()).toEqual([0, 0, 0]);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('centers malformed placement at floor contact without rescaling', () => {
    const model = new Group();
    const geometry = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    geometry.position.set(2, 2, -3);
    model.add(geometry);

    normalizeModelPlacement(model);
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());

    expect(bounds.min.y).toBeCloseTo(0);
    expect(center.x).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
  });
});
