import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, InterleavedBufferAttribute, Mesh } from 'three';
import { addMorphNormals } from '../src/morph-normals';
import { loadCastModel } from './helpers/player-model';

/** A flat square in the XY plane facing +Z, as two triangles, with one target that lifts its +X edge. */
function square(lift: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.morphAttributes.position = [new Float32BufferAttribute([0, 0, 0, 0, 0, lift, 0, 0, lift, 0, 0, 0], 3)];
  geometry.morphTargetsRelative = true;
  return geometry;
}

/** The normals a geometry's targets were given. */
function targetNormals(geometry: BufferGeometry): (BufferAttribute | InterleavedBufferAttribute)[] {
  const normals = geometry.morphAttributes.normal;
  if (!normals) throw new Error('The geometry\'s targets have no normals');
  return normals;
}

describe('morph normals', () => {
  it('turns a target\'s normals with the surface it tilts', () => {
    const geometry = square(1);
    addMorphNormals(geometry);
    const [normals] = targetNormals(geometry);
    // Lifted by its own width, the square faces halfway between +Z and -X.
    for (let vertex = 0; vertex < 4; vertex += 1) {
      expect(normals.getX(vertex)).toBeCloseTo(-Math.SQRT1_2, 5);
      expect(normals.getY(vertex)).toBeCloseTo(0, 5);
      // Stored as the change from the resting normal, which faces +Z.
      expect(normals.getZ(vertex)).toBeCloseTo(Math.SQRT1_2 - 1, 5);
    }
  });

  it('leaves the normals of a target that moves nothing as they rest', () => {
    const geometry = square(0);
    addMorphNormals(geometry);
    expect(Array.from(targetNormals(geometry)[0].array).every((value) => Math.abs(value) < 1e-6)).toBe(true);
  });

  it('gives the copies of a vertex on a texture seam one normal', () => {
    // Two squares side by side that repeat the vertices of the edge they share.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const lifted = new Float32Array(24);
    lifted[5 * 3 + 2] = 1;
    lifted[6 * 3 + 2] = 1;
    geometry.morphAttributes.position = [new Float32BufferAttribute(lifted, 3)];
    geometry.morphTargetsRelative = true;
    addMorphNormals(geometry);
    const [normals] = targetNormals(geometry);
    for (const [one, other] of [[1, 4], [2, 7]]) {
      expect(normals.getX(one)).toBeCloseTo(normals.getX(other), 6);
      expect(normals.getZ(one)).toBeCloseTo(normals.getZ(other), 6);
    }
    // The shared edge leans toward the lifted square, by less than that square does.
    expect(normals.getX(1)).toBeLessThan(-0.1);
    expect(normals.getX(1)).toBeGreaterThan(normals.getX(5));
  });

  it('keeps normals a file already carries, and does nothing without targets', () => {
    const carried = square(1);
    const own = [new Float32BufferAttribute(new Float32Array(12), 3)];
    carried.morphAttributes.normal = own;
    addMorphNormals(carried);
    expect(carried.morphAttributes.normal).toBe(own);

    const plain = new BufferGeometry();
    plain.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    addMorphNormals(plain);
    expect(plain.morphAttributes.normal).toBeUndefined();
  });

  it('gives every face of a real model normals for each of its targets', async () => {
    const model = await loadCastModel('friendA', 'realistic');
    let faces = 0;
    model.traverse((child) => {
      if (!(child instanceof Mesh) || !child.morphTargetDictionary) return;
      faces += 1;
      addMorphNormals(child.geometry);
      const targets = child.geometry.morphAttributes.position ?? [];
      const normals = child.geometry.morphAttributes.normal ?? [];
      expect(normals.length, child.name).toBe(targets.length);
      for (const normal of normals) {
        expect(normal.count, child.name).toBe(child.geometry.getAttribute('position').count);
        expect(Array.from(normal.array).every(Number.isFinite), child.name).toBe(true);
      }
    });
    expect(faces).toBeGreaterThan(0);
  });
});
