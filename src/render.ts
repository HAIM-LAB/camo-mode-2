import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';

/**
 * The playroom and the character preview share one renderer setup and one
 * lighting rig, so a look chosen in the menu reads the same in the room.
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
  return [hemisphere, sun];
}
