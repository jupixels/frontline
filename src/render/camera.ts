import * as THREE from 'three';

const PAN_SPEED = 1.1; // fraction of view distance per second
const EDGE = 12; // px
const MIN_DIST = 25;
const MAX_DIST = 420;

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
  /** Camera shake energy in [0, 1]; offset scales with its square. */
  private trauma = 0;
  private shakeTime = 0;
  /** Ground height lookup so the orbit target rides the terrain. */
  groundHeight: (x: number, z: number) => number = () => 0;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 4000);
    this.on(window, 'keydown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) this.keys.add(e.code);
    });
    this.on(window, 'keyup', (e) => this.keys.delete(e.code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(dom, 'wheel', (e) => {
      e.preventDefault();
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.001), MIN_DIST, MAX_DIST);
    }, { passive: false });
    this.on(dom, 'pointermove', (e) => {
      if (this.rotating) {
        this.yaw -= e.movementX * 0.005;
        this.pitch = THREE.MathUtils.clamp(this.pitch + e.movementY * 0.004, 0.45, 1.35);
      }
      this.mouse = { x: e.clientX, y: e.clientY, inside: true };
    });
    this.on(dom, 'pointerleave', () => (this.mouse.inside = false));
    this.on(dom, 'pointerdown', (e) => {
      if (e.button === 1) {
        this.rotating = true;
        e.preventDefault();
      }
    });
    this.on(window, 'pointerup', (e) => {
      if (e.button === 1) this.rotating = false;
    });
  }

  private readonly offs: (() => void)[] = [];

  private on<K extends keyof WindowEventMap>(
    target: Window | HTMLElement,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    const listener = fn as EventListener;
    target.addEventListener(type, listener, opts);
    this.offs.push(() => target.removeEventListener(type, listener, opts));
  }

  /** Remove every window/DOM listener this camera added. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.keys.clear();
  }

  /** Distance from the camera to its orbit target. */
  get viewDistance(): number {
    return this.distance;
  }

  /** 0 = fully zoomed in, 1 = fully zoomed out. */
  get zoom(): number {
    return (this.distance - MIN_DIST) / (MAX_DIST - MIN_DIST);
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  setBounds(halfSize: number): void {
    this.bounds = halfSize;
  }

  lookAt(x: number, z: number): void {
    this.target.set(x, this.groundHeight(x, z), z);
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
    this.target.y += (this.groundHeight(this.target.x, this.target.z) - this.target.y) * Math.min(1, dt * 6);
    const horiz = this.distance * Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
    if (this.trauma > 0) {
      this.shakeTime += dt;
      const s = this.trauma * this.trauma;
      const t = this.shakeTime * 32;
      const amp = s * this.distance * 0.012;
      this.camera.position.x += Math.sin(t * 1.1) * Math.sin(t * 0.37 + 1.3) * amp;
      this.camera.position.y += Math.sin(t * 0.93 + 2.1) * Math.sin(t * 0.51) * amp;
      this.camera.position.z += Math.sin(t * 1.27 + 4.2) * Math.sin(t * 0.29 + 0.6) * amp;
      this.camera.rotateZ(Math.sin(t * 0.8 + 3.3) * s * 0.012);
      this.trauma = Math.max(0, this.trauma - dt * 1.4);
    }
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
