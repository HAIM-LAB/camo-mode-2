import {
  ACESFilmicToneMapping,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';

/**
 * The playroom, the character preview, and the guessing game's stage share one
 * renderer setup and one lighting rig, so a look chosen in the menu reads the
 * same wherever it is drawn.
 */
export function createRenderer(canvas: HTMLCanvasElement, options: { alpha?: boolean } = {}): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: options.alpha ?? false,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  return renderer;
}

/** Warm sky fill plus a shadow-casting sun whose shadow covers ±halfWidth × ±halfHeight. */
export function createPlayroomLights(halfWidth: number, halfHeight: number): [HemisphereLight, DirectionalLight] {
  const hemisphere = new HemisphereLight(0xfff5df, 0x536971, 2.3);

  const sun = new DirectionalLight(0xffe9cf, 3.5);
  sun.position.set(3.8, 7.5, 5.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -halfWidth;
  sun.shadow.camera.right = halfWidth;
  sun.shadow.camera.top = halfHeight;
  sun.shadow.camera.bottom = -halfHeight;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 22;
  // Smooth-shaded characters would otherwise shade themselves in a moire of stripes.
  sun.shadow.normalBias = 0.03;
  return [hemisphere, sun];
}

/**
 * The round platform a character stands on where there is no room around it:
 * `radius` meters across the top, which lies on the floor.
 */
export function createPlatform(radius: number): Mesh {
  const platform = new Mesh(
    new CylinderGeometry(radius, radius + 0.04, 0.06, 56),
    new MeshStandardMaterial({ color: 0x8fcfae, roughness: 0.92, metalness: 0.02 }),
  );
  platform.position.y = -0.03;
  platform.receiveShadow = true;
  return platform;
}

/**
 * A soft light for a close-up of an avatar's face. The playroom's sun stands
 * high and to one side, which leaves a face seen from the front flat and, on
 * darker skin, too dark to read an expression from. This one shines from in
 * front of the face, a little above and across from the sun, and casts no
 * shadow.
 *
 * Add the light and its `target` to the avatar's root (its origin on the
 * floor, facing +Z), so the light turns with the avatar; `face` is where the
 * middle of the face is in that space. Remove both when the close-up ends.
 */
export function createFaceLight(face: Vector3): DirectionalLight {
  const light = new DirectionalLight(0xfff3e4, 2.1);
  light.position.copy(face).add(new Vector3(-0.9, 0.55, 2));
  light.target.position.copy(face);
  return light;
}
