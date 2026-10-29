import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { assetUrl } from '../shared/view';

/** A loaded unit model, optimized once and cloned per unit. */
export interface PreparedModel {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** Model-space bounds (meters). */
  bounds: THREE.Box3;
  /** The material covering the most triangles that isn't glass/lights/tyres: gets team camo. */
  primaryMaterial?: THREE.Material;
  skinned: boolean;
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<PreparedModel>>();

export function loadModel(path: string): Promise<PreparedModel> {
  let p = cache.get(path);
  if (!p) {
    p = loader.loadAsync(assetUrl(path)).then(prepare);
    cache.set(path, p);
  }
  return p;
}

function prepare(gltf: GLTF): PreparedModel {
  const scene = gltf.scene;
  mergeStaticMeshes(scene, gltf.animations);
  let skinned = false;
  const triCount = new Map<THREE.Material, number>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const tris = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    for (const m of mats) {
      if (/glass|window|light|wheel|tyre|tire|black|metal|barrel|bolt/i.test(m.name)) continue;
      triCount.set(m, (triCount.get(m) ?? 0) + tris);
    }
  });
  let primaryMaterial: THREE.Material | undefined;
  let best = -1;
  for (const [m, n] of triCount) {
    if (n > best) {
      best = n;
      primaryMaterial = m;
    }
  }
  // Unnamed, untextured white materials on vehicles are default-material running gear (road wheels,
  // idlers); paint them dark steel instead of glowing white.
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material === primaryMaterial) return;
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (m.name === '' && !m.map && m.color?.getHex() === 0xffffff) m.color.setHex(0x2a2a28);
  });
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene, true);
  return { scene, animations: gltf.animations, bounds, primaryMaterial, skinned };
}

/** Nodes whose own animation is worth keeping per unit: turrets, guns, rotors, the hull (recoil, death). */
const KEEP_ANIMATED = /turret|barrel|gun|cannon|rotor|propel|body|hull/i;

/**
 * Flatten a vehicle into a handful of meshes: every mesh is merged, per material, into its nearest
 * ancestor-or-self that is an animated turret/gun/rotor/hull node (or the model root). Animation of
 * small parts like individual road wheels is dropped: invisible at RTS zoom, and it was costing one
 * draw call per wheel plus mixer time. The tank goes from ~50 draws to ~8.
 */
function mergeStaticMeshes(root: THREE.Object3D, clips: THREE.AnimationClip[]): void {
  // Rigged characters attach props to bones that may be driven by constraints rather than tracks;
  // they have few meshes anyway, so leave them untouched.
  let rigged = false;
  root.traverse((o) => (rigged ||= (o as THREE.Bone).isBone === true));
  if (rigged) return;
  const animated = new Set<string>();
  for (const clip of clips) {
    for (const track of clip.tracks) animated.add(THREE.PropertyBinding.parseTrackName(track.name).nodeName);
  }
  const keep = new Set([...animated].filter((n) => KEEP_ANIMATED.test(n)));
  root.updateMatrixWorld(true);

  const groups = new Map<THREE.Object3D, Map<THREE.Material, THREE.Mesh[]>>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(mesh.material) || mesh.morphTargetInfluences) return;
    let anchor: THREE.Object3D = root;
    for (let p: THREE.Object3D | null = mesh; p && p !== root; p = p.parent) {
      if (keep.has(p.name)) {
        anchor = p;
        break;
      }
    }
    let byMat = groups.get(anchor);
    if (!byMat) groups.set(anchor, (byMat = new Map()));
    const list = byMat.get(mesh.material) ?? [];
    list.push(mesh);
    byMat.set(mesh.material, list);
  });

  // Build merged geometry while every transform is still the original hierarchy.
  const pending: { anchor: THREE.Object3D; mesh: THREE.Mesh }[] = [];
  const replaced = new Set<THREE.Mesh>();
  const inv = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  for (const [anchor, byMat] of groups) {
    inv.copy(anchor.matrixWorld).invert();
    for (const [material, meshes] of byMat) {
      if (meshes.length === 1 && meshes[0] === anchor) continue;
      const hasUv = meshes.every((x) => x.geometry.attributes.uv);
      const indexed = meshes.every((x) => x.geometry.index);
      const geos = meshes.map((x) => {
        let g = x.geometry.clone();
        for (const name of Object.keys(g.attributes)) {
          if (name !== 'position' && name !== 'normal' && !(hasUv && name === 'uv')) g.deleteAttribute(name);
        }
        g.morphAttributes = {};
        // meshopt ships quantized (normalized int16/int8) attributes with the scale in the node
        // transform; baking a transform into them would clamp to [-1, 1], so expand to float first.
        for (const name of Object.keys(g.attributes)) g.setAttribute(name, toFloat32(g.attributes[name] as THREE.BufferAttribute));
        if (!indexed && g.index) g = g.toNonIndexed();
        if (!g.attributes.normal) g.computeVertexNormals();
        g.applyMatrix4(m.multiplyMatrices(inv, x.matrixWorld));
        return g;
      });
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${anchor.name || 'root'}_merged_${material.name}`;
      pending.push({ anchor, mesh });
      for (const x of meshes) replaced.add(x);
    }
  }
  const swap = new Map<THREE.Object3D, THREE.Object3D>();
  for (const x of replaced) swap.set(x, replaceWithEmpty(x));
  for (const { anchor, mesh } of pending) (swap.get(anchor) ?? anchor).add(mesh);

  // Drop tracks for parts that no longer move on their own.
  for (const clip of clips) {
    clip.tracks = clip.tracks.filter((t) => keep.has(THREE.PropertyBinding.parseTrackName(t.name).nodeName));
    clip.resetDuration();
  }
  pruneEmpty(root, keep);
}

/** Remove nodes with no meshes below them (left over from merging); every node costs matrix updates per unit per frame. */
function pruneEmpty(node: THREE.Object3D, keep: Set<string>): boolean {
  let hasContent = (node as THREE.Mesh).isMesh === true || keep.has(node.name);
  for (const child of [...node.children]) {
    if (pruneEmpty(child, keep)) hasContent = true;
    else node.remove(child);
  }
  return hasContent;
}

function toFloat32(attr: THREE.BufferAttribute): THREE.BufferAttribute {
  if (attr.array instanceof Float32Array && !attr.normalized) return attr;
  const out = new Float32Array(attr.count * attr.itemSize);
  const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = get[c].call(attr, i);
  return new THREE.BufferAttribute(out, attr.itemSize);
}

/** Swap a mesh for a plain Object3D with the same name/transform/children so the hierarchy survives. */
function replaceWithEmpty(mesh: THREE.Mesh): THREE.Object3D {
  const parent = mesh.parent;
  const empty = new THREE.Object3D();
  empty.name = mesh.name;
  empty.position.copy(mesh.position);
  empty.quaternion.copy(mesh.quaternion);
  empty.scale.copy(mesh.scale);
  for (const c of [...mesh.children]) empty.add(c);
  if (parent) {
    parent.children[parent.children.indexOf(mesh)] = empty;
    empty.parent = parent;
    mesh.parent = null;
  }
  return empty;
}

/** Clone with skeletons rebound (plain clone() shares bones between copies). */
export function cloneModel(model: PreparedModel): THREE.Object3D {
  return SkeletonUtils.clone(model.scene);
}

export interface BakeOptions {
  clip?: string;
  time?: number;
  /** Keep this fraction of triangles (meshoptimizer simplifier). 1 = no simplification. */
  detail?: number;
  /** Faceted normals (hard-surface vehicles) instead of smooth (soldiers). */
  flat?: boolean;
}

/**
 * Bake the model (optionally posed at `time` into `clip`) into static model-space geometry, one per
 * source material, simplified for far-LOD instancing.
 */
export async function bakeModel(model: PreparedModel, opts: BakeOptions = {}): Promise<Map<THREE.Material, THREE.BufferGeometry>> {
  const clone = cloneModel(model);
  const clip = opts.clip ? model.animations.find((c) => c.name === opts.clip) : undefined;
  if (clip) {
    const mixer = new THREE.AnimationMixer(clone);
    mixer.clipAction(clip).play();
    mixer.setTime(opts.time ?? 0);
  }
  clone.updateMatrixWorld(true);
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const v = new THREE.Vector3();
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const src = mesh.geometry;
    const pos = src.attributes.position;
    const out = new Float32Array(pos.count * 3);
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    skinned?.skeleton.update();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (skinned) skinned.applyBoneTransform(i, v);
      v.applyMatrix4(mesh.matrixWorld);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const idx = src.index ? Array.from(src.index.array as ArrayLike<number>) : Array.from({ length: pos.count }, (_, i) => i);
    g.setIndex(idx);
    const list = parts.get(mesh.material) ?? [];
    list.push(g);
    parts.set(mesh.material, list);
  });
  const detail = opts.detail ?? 1;
  if (detail < 1) await MeshoptSimplifier.ready;
  const result = new Map<THREE.Material, THREE.BufferGeometry>();
  for (const [mat, list] of parts) {
    let g = mergeGeometries(list, false);
    if (!g) continue;
    if (detail < 1) g = simplify(g, detail);
    if (opts.flat) g = g.toNonIndexed();
    g.computeVertexNormals();
    g.computeBoundingSphere();
    result.set(mat, g);
  }
  return result;
}

function simplify(geo: THREE.BufferGeometry, detail: number): THREE.BufferGeometry {
  const welded = mergeVertices(geo, 1e-4);
  const positions = welded.attributes.position.array as Float32Array;
  const indices = new Uint32Array(welded.index!.array as ArrayLike<number>);
  const target = Math.max(12, Math.floor((indices.length * detail) / 3) * 3);
  // Far LOD is seen from 100 m+, so a few percent of the model's extent is well under a couple of pixels.
  const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.08, ['Prune']);
  welded.setIndex(new THREE.BufferAttribute(simplified, 1));
  return welded;
}
