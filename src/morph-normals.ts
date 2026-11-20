import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';

/**
 * Gives a geometry's morph targets their normals, when its file carries only
 * their positions.
 *
 * A face that changes shape has to be lit as the shape it has become: without
 * a target's normals the renderer lights a lifted cheek or a furrowed brow
 * with the resting face's normals, and the expression shows as a hard-edged
 * patch of the wrong brightness. The models leave the normals out because
 * they would double the size of every face, and they can be worked out here
 * from the positions in a few milliseconds.
 *
 * Each target's normals are stored as the change from the resting normals, as
 * the positions are, so the model's own authored normals stay as they are and
 * only move by what the expression changes.
 */
export function addMorphNormals(geometry: BufferGeometry): void {
  const targets = geometry.morphAttributes.position;
  if (!targets || targets.length === 0 || geometry.morphAttributes.normal) return;
  const position = geometry.getAttribute('position');
  // Positions woven into a shared buffer with other attributes are not read here; the models' are not.
  if (!(position instanceof BufferAttribute)) return;
  const stands = sharedVertices(position);
  const resting = smoothNormals(geometry, position.array, stands);
  const relative = geometry.morphTargetsRelative;

  geometry.morphAttributes.normal = targets.map((target) => {
    const moved = new Float32Array(position.count * 3);
    for (let index = 0; index < moved.length; index += 1) {
      moved[index] = relative ? position.array[index] + target.array[index] : target.array[index];
    }
    const normals = smoothNormals(geometry, moved, stands);
    for (let index = 0; index < normals.length; index += 1) normals[index] -= resting[index];
    if (!relative) {
      // Targets that hold whole shapes hold whole normals too.
      const authored = geometry.getAttribute('normal').array;
      for (let index = 0; index < normals.length; index += 1) normals[index] += authored[index];
    }
    return new Float32BufferAttribute(normals, 3);
  });
}

/**
 * For each vertex, the first vertex found at the same resting position. A
 * file repeats a vertex wherever its texture has a seam; the copies share a
 * normal, so the seam does not show in the light.
 */
function sharedVertices(resting: BufferAttribute): Uint32Array {
  const stands = new Uint32Array(resting.count);
  const seen = new Map<string, number>();
  for (let vertex = 0; vertex < resting.count; vertex += 1) {
    const key = `${resting.getX(vertex)},${resting.getY(vertex)},${resting.getZ(vertex)}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, vertex);
    stands[vertex] = first ?? vertex;
  }
  return stands;
}

/** Smooth vertex normals for a geometry's triangles at the given positions. */
function smoothNormals(geometry: BufferGeometry, positions: ArrayLike<number>, stands: Uint32Array): Float32Array {
  const count = stands.length;
  const sums = new Float32Array(count * 3);
  const index = geometry.getIndex();
  const corners = index ? index.count : count;
  for (let corner = 0; corner < corners; corner += 3) {
    const a = index ? index.getX(corner) : corner;
    const b = index ? index.getX(corner + 1) : corner + 1;
    const c = index ? index.getX(corner + 2) : corner + 2;
    const abX = positions[b * 3] - positions[a * 3];
    const abY = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abZ = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acX = positions[c * 3] - positions[a * 3];
    const acY = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acZ = positions[c * 3 + 2] - positions[a * 3 + 2];
    // The cross product's length is twice the triangle's area, so larger triangles count for more.
    const x = abY * acZ - abZ * acY;
    const y = abZ * acX - abX * acZ;
    const z = abX * acY - abY * acX;
    for (const vertex of [a, b, c]) {
      const shared = stands[vertex] * 3;
      sums[shared] += x;
      sums[shared + 1] += y;
      sums[shared + 2] += z;
    }
  }

  const normals = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const shared = stands[vertex] * 3;
    const length = Math.hypot(sums[shared], sums[shared + 1], sums[shared + 2]) || 1;
    normals[vertex * 3] = sums[shared] / length;
    normals[vertex * 3 + 1] = sums[shared + 1] / length;
    normals[vertex * 3 + 2] = sums[shared + 2] / length;
  }
  return normals;
}
