import * as THREE from 'three';

const NEUTRAL_COLOR = new THREE.Color(0xc8c8c0);

/**
 * A capture point: a ground ring in the owner's color whose arc fills with the capturing player's
 * color, and a flagpole whose flag shows the owner. Uses the sim's capture radius.
 */
export class CapturePointView {
  readonly root = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly flag: THREE.Mesh;
  private readonly uniforms: {
    uOwner: { value: THREE.Color };
    uCapture: { value: THREE.Color };
    uProgress: { value: number };
    uTime: { value: number };
  };
  private radius = 0;
  private readonly flagMat: THREE.MeshStandardMaterial;

  constructor(
    readonly id: number,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.uniforms = {
      uOwner: { value: NEUTRAL_COLOR.clone() },
      uCapture: { value: NEUTRAL_COLOR.clone() },
      uProgress: { value: 0 },
      uTime: { value: 0 },
    };
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 96, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.renderOrder = 4;
    this.root.add(this.ring);

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 9, 8).translate(0, 4.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.4, metalness: 0.8 }),
    );
    pole.castShadow = true;
    this.flagMat = new THREE.MeshStandardMaterial({ color: NEUTRAL_COLOR, roughness: 0.8, side: THREE.DoubleSide });
    this.flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.8, 8, 1).translate(1.5, 7.9, 0), this.flagMat);
    this.flag.castShadow = true;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.8, 0.8, 10),
      new THREE.MeshStandardMaterial({ color: 0x55534d, roughness: 0.95 }),
    );
    base.position.y = 0.2;
    base.receiveShadow = true;
    this.root.add(pole, this.flag, base);
    this.root.userData.entityId = id;
  }

  update(x: number, z: number, radius: number, owner: THREE.Color | null, capturer: THREE.Color | null, progress: number, time: number): void {
    const y = this.heightAt(x, z);
    this.root.position.set(x, y, z);
    if (radius !== this.radius) {
      this.radius = radius;
      this.ring.scale.setScalar(radius);
    }
    this.ring.position.y = 0.35;
    this.uniforms.uOwner.value.copy(owner ?? NEUTRAL_COLOR);
    this.uniforms.uCapture.value.copy(capturer ?? owner ?? NEUTRAL_COLOR);
    this.uniforms.uProgress.value = capturer ? progress : 0;
    this.uniforms.uTime.value = time;
    this.flagMat.color.copy(owner ?? NEUTRAL_COLOR);
    // Flag flutters; it climbs the pole with capture progress for the capturer.
    this.flag.rotation.y = Math.sin(time * 1.7 + this.id) * 0.25;
    this.flag.position.y = capturer && progress < 1 && !owner ? -6.5 * (1 - progress) : 0;
    if (capturer && !owner) this.flagMat.color.copy(capturer);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
  }
}

const RING_VERT = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uOwner;
uniform vec3 uCapture;
uniform float uProgress;
uniform float uTime;
varying vec2 vPos;
void main() {
  // Clockwise from north: the part of the ring already taken shows the capturer's color.
  float a = atan(vPos.x, -vPos.y) / 6.2831853 + 0.5;
  vec3 c = a < uProgress ? uCapture : uOwner;
  // Dashes around the rim, gently rotating.
  float dash = step(0.35, fract(a * 48.0 - uTime * 0.15));
  float alpha = mix(0.35, 0.85, dash) * (a < uProgress ? 1.0 : 0.8);
  gl_FragColor = vec4(c, alpha);
}
`;
