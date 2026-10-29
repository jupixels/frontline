import * as THREE from 'three';

const PAN_SPEED = 1.1; // fraction of view distance per second
const EDGE = 12; // px
const MIN_DIST = 25;
const MAX_DIST = 320;

/** Classic RTS camera: arrows/edge pan, wheel zoom, middle-drag (or PageUp/PageDown) rotate. */
export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  private distance = 110;
  private yaw = Math.PI / 4;
  private pitch = 0.95;
  private keys = new Set<string>();
  private mouse = { x: -1, y: -1, inside: false };
  private rotating = false;
  private bounds = 300;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
    addEventListener('keydown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.001), MIN_DIST, MAX_DIST);
    }, { passive: false });
    dom.addEventListener('pointermove', (e) => {
      if (this.rotating) {
        this.yaw -= e.movementX * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.004, 0.45, 1.35);
      }
      this.mouse = { x: e.clientX, y: e.clientY, inside: true };
    });
    dom.addEventListener('pointerleave', () => (this.mouse.inside = false));
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        this.rotating = true;
        e.preventDefault();
      }
    });
    addEventListener('pointerup', (e) => {
      if (e.button === 1) this.rotating = false;
    });
  }

  setBounds(halfSize: number): void {
    this.bounds = halfSize;
  }

  lookAt(x: number, z: number): void {
    this.target.set(x, 0, z);
  }

  update(dt: number): void {
    const k = this.keys;
    let fx = 0;
    let fz = 0;
    // Letter keys are unit hotkeys (A attack-move, S stop, H hold...), so panning uses arrows.
    if (k.has('ArrowUp')) fz -= 1;
    if (k.has('ArrowDown')) fz += 1;
    if (k.has('ArrowLeft')) fx -= 1;
    if (k.has('ArrowRight')) fx += 1;
    if (k.has('PageUp')) this.yaw += dt * 1.5;
    if (k.has('PageDown')) this.yaw -= dt * 1.5;
    const m = this.mouse;
    if (m.inside && !this.rotating && document.pointerLockElement === null) {
      if (m.x <= EDGE) fx -= 1;
      if (m.x >= innerWidth - EDGE) fx += 1;
      if (m.y <= EDGE) fz -= 1;
      if (m.y >= innerHeight - EDGE) fz += 1;
    }
    if (fx || fz) {
      const speed = this.distance * PAN_SPEED * dt;
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      // Screen-forward on the ground is -Z rotated by yaw.
      this.target.x += (fx * c + fz * s) * speed;
      this.target.z += (-fx * s + fz * c) * speed;
      this.target.x = THREE.MathUtils.clamp(this.target.x, -this.bounds, this.bounds);
      this.target.z = THREE.MathUtils.clamp(this.target.z, -this.bounds, this.bounds);
    }
    const horiz = this.distance * Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
