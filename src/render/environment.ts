import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** Sky, sun, ambient light, fog and a placeholder ground. Terrain/water replace the ground later. */
export function buildEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, mapSize: number): THREE.Mesh {
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(215));

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6;
  u.rayleigh.value = 1.4;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

  // Image-based lighting from the sky so PBR materials pick up a believable ambient.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  scene.fog = new THREE.FogExp2(0xb9c4c9, 0.0018);

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.copy(sunDir).multiplyScalar(300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const half = mapSize / 2;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 900 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);

  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a5236, 0.5));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(mapSize * 3, mapSize * 3).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95, metalness: 0 }),
  );
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);
  return ground;
}

/** Procedural grass/dirt texture so the placeholder ground isn't a flat color. */
function groundTexture(): THREE.Texture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5b6b3c';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 9000; i++) {
    const shade = Math.random();
    g.fillStyle = shade < 0.5 ? `rgba(70,84,44,${0.25 + shade * 0.4})` : `rgba(120,108,72,${0.08 + (shade - 0.5) * 0.3})`;
    const r = 1 + Math.random() * 7;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
