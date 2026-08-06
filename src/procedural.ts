import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';

const palette = Object.freeze({
  ink: 0x172033,
  cream: 0xf8eddc,
  mint: 0x79d6a3,
  mintDark: 0x318567,
  coral: 0xff8f78,
  yellow: 0xf6cb58,
  blue: 0x76a9f8,
  violet: 0xa68af4,
  wood: 0xb97855,
  wall: 0xe8e5df,
  floor: 0xd8b995,
});

function material(color: number, roughness = 0.78): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function mesh(geometry: BufferGeometry, color: number): Mesh<BufferGeometry, MeshStandardMaterial> {
  const result = new Mesh(geometry, material(color));
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function addEyes(parent: Group, height: number, spread: number, forward = 0.31): void {
  const eyeMaterial = material(palette.ink, 0.45);
  for (const x of [-spread, spread]) {
    const eye = new Mesh(new SphereGeometry(0.055, 12, 8), eyeMaterial);
    eye.position.set(x, height, forward);
    eye.scale.z = 0.45;
    eye.castShadow = true;
    parent.add(eye);
  }
}

function addGroundRing(parent: Group, color: number, radius = 0.55): void {
  const ring = mesh(new TorusGeometry(radius, 0.024, 8, 48), color);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.025;
  ring.material.transparent = true;
  ring.material.opacity = 0.68;
  parent.add(ring);
}

export function createPlayerFallback(): Group {
  const avatar = new Group();
  avatar.name = 'procedural-player';

  const shadow = mesh(new CircleGeometry(0.43, 32), 0x75806f);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  shadow.material.transparent = true;
  shadow.material.opacity = 0.25;
  shadow.castShadow = false;
  avatar.add(shadow);

  const body = mesh(new CapsuleGeometry(0.32, 0.52, 8, 16), palette.yellow);
  body.position.y = 0.59;
  avatar.add(body);

  const scarf = mesh(new TorusGeometry(0.27, 0.055, 8, 24), palette.coral);
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.86;
  avatar.add(scarf);

  addEyes(avatar, 0.68, 0.11, 0.292);

  const cap = mesh(new SphereGeometry(0.3, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), palette.blue);
  cap.position.y = 0.93;
  avatar.add(cap);

  return avatar;
}

export function createCamoFallback(): Group {
  const camo = new Group();
  camo.name = 'procedural-camo';
  addGroundRing(camo, palette.mintDark, 0.62);

  const body = mesh(new CapsuleGeometry(0.36, 0.48, 8, 16), palette.mint);
  body.position.y = 0.63;
  camo.add(body);

  const belly = mesh(new SphereGeometry(0.24, 18, 12), palette.cream);
  belly.scale.set(0.83, 1.2, 0.25);
  belly.position.set(0, 0.55, 0.33);
  camo.add(belly);

  const crest = mesh(new SphereGeometry(0.13, 14, 10), palette.mintDark);
  crest.scale.set(0.65, 1.3, 0.45);
  crest.position.set(0, 1.13, 0.02);
  camo.add(crest);

  addEyes(camo, 0.82, 0.13, 0.325);
  return camo;
}

export function createFriendFallback(color: number, accent: number, name: string): Group {
  const friend = new Group();
  friend.name = `procedural-${name}`;
  addGroundRing(friend, accent, 0.52);

  const body = mesh(new CapsuleGeometry(0.3, 0.45, 8, 16), color);
  body.position.y = 0.55;
  friend.add(body);

  const accentBand = mesh(new TorusGeometry(0.26, 0.04, 8, 22), accent);
  accentBand.rotation.x = Math.PI / 2;
  accentBand.position.y = 0.76;
  friend.add(accentBand);
  addEyes(friend, 0.67, 0.1, 0.278);
  return friend;
}

export function createBallFallback(): Group {
  const group = new Group();
  group.name = 'procedural-ball';
  const ball = mesh(new SphereGeometry(0.27, 24, 16), palette.coral);
  ball.position.y = 0.27;
  group.add(ball);

  const stripe = mesh(new TorusGeometry(0.274, 0.025, 8, 28), palette.cream);
  stripe.rotation.x = Math.PI / 2;
  stripe.position.y = 0.27;
  group.add(stripe);
  addGroundRing(group, palette.coral, 0.38);
  return group;
}

export function createBlockFallback(): Group {
  const group = new Group();
  group.name = 'procedural-block';
  const block = mesh(new BoxGeometry(0.55, 0.55, 0.55, 2, 2, 2), palette.violet);
  block.position.y = 0.275;
  group.add(block);

  const inset = mesh(new BoxGeometry(0.25, 0.25, 0.01), palette.cream);
  inset.position.set(0, 0.3, 0.281);
  group.add(inset);
  addGroundRing(group, palette.violet, 0.4);
  return group;
}

export function createRoomFallback(): Group {
  const room = new Group();
  room.name = 'procedural-living-room';

  const floor = mesh(new PlaneGeometry(12, 9), palette.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;
  floor.receiveShadow = true;
  room.add(floor);

  const backWall = mesh(new BoxGeometry(12, 2.6, 0.15), palette.wall);
  backWall.position.set(0, 1.3, -4.5);
  room.add(backWall);
  const leftWall = mesh(new BoxGeometry(0.15, 2.6, 9), 0xf1eee7);
  leftWall.position.set(-6, 1.3, 0);
  room.add(leftWall);

  const rug = mesh(new PlaneGeometry(4.2, 3.05), 0xc5dece);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0.4, 0.014, -0.35);
  rug.castShadow = false;
  room.add(rug);

  const sofa = new Group();
  const sofaBase = mesh(new BoxGeometry(2.35, 0.48, 0.82), 0x5f87a5);
  sofaBase.position.y = 0.38;
  sofa.add(sofaBase);
  const sofaBack = mesh(new BoxGeometry(2.35, 0.78, 0.26), 0x6f9ab8);
  sofaBack.position.set(0, 0.82, -0.32);
  sofa.add(sofaBack);
  for (const x of [-0.78, 0, 0.78]) {
    const cushion = mesh(new BoxGeometry(0.7, 0.13, 0.56), x === 0 ? palette.yellow : 0x83a9c3);
    cushion.position.set(x, 0.67, 0.06);
    sofa.add(cushion);
  }
  sofa.position.set(1.5, 0, -3.72);
  room.add(sofa);

  const tableTop = mesh(new CylinderGeometry(0.63, 0.68, 0.11, 24), palette.wood);
  tableTop.position.set(3.85, 0.58, 2.35);
  room.add(tableTop);
  const tableLeg = mesh(new CylinderGeometry(0.1, 0.18, 0.55, 16), palette.wood);
  tableLeg.position.set(3.85, 0.285, 2.35);
  room.add(tableLeg);

  const plantPot = mesh(new CylinderGeometry(0.32, 0.24, 0.5, 16), 0xe7a77f);
  plantPot.position.set(-5.25, 0.25, -3.75);
  room.add(plantPot);
  for (const [index, rotation] of [-0.55, 0, 0.55].entries()) {
    const leaf = mesh(new CapsuleGeometry(0.1, 0.45, 5, 10), index === 1 ? palette.mintDark : palette.mint);
    leaf.position.set(-5.25 + rotation * 0.25, 0.78, -3.75);
    leaf.rotation.z = -rotation;
    room.add(leaf);
  }

  const frame = mesh(new BoxGeometry(1.6, 1.15, 0.08), palette.yellow);
  frame.position.set(-2.2, 1.65, -4.39);
  room.add(frame);
  const frameArt = mesh(new BoxGeometry(1.35, 0.9, 0.04), palette.coral);
  frameArt.position.set(-2.2, 1.65, -4.33);
  room.add(frameArt);

  return room;
}

export const fallbackColors = Object.freeze({
  friendA: palette.blue,
  friendAAccent: palette.yellow,
  friendB: palette.violet,
  friendBAccent: palette.coral,
});

export function colorToCss(color: number): string {
  return `#${new Color(color).getHexString()}`;
}
