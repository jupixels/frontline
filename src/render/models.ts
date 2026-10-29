import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene, true);
  return { scene, animations: gltf.animations, bounds, primaryMaterial, skinned };
}

/**
 * Merge non-animated meshes that share a material into one mesh per rigid group, cutting draw calls
 * (the IFV alone ships ~50 meshes). A "rigid group" is the nearest animated ancestor, so animation
 * still moves exactly what it did before.
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
  root.updateMatrixWorld(true);
  const groups = new Map<THREE.Object3D, Map<THREE.Material, THREE.Mesh[]>>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(mesh.material)) return;
    if (animated.has(mesh.name) || mesh.morphTargetInfluences) return;
    let anchor: THREE.Object3D = root;
    for (let p = mesh.parent; p && p !== root; p = p.parent) {
      if (animated.has(p.name)) {
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

  const inv = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  for (const [anchor, byMat] of groups) {
    inv.copy(anchor.matrixWorld).invert();
    for (const [material, meshes] of byMat) {
      if (meshes.length < 2) continue;
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
      anchor.add(mesh);
      for (const x of meshes) replaceWithEmpty(x);
    }
  }
}

function toFloat32(attr: THREE.BufferAttribute): THREE.BufferAttribute {
  if (attr.array instanceof Float32Array && !attr.normalized) return attr;
  const out = new Float32Array(attr.count * attr.itemSize);
  const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = get[c].call(attr, i);
  return new THREE.BufferAttribute(out, attr.itemSize);
}

/** Swap a mesh for a plain Object3D with the same name/transform/children so the hierarchy survives. */
function replaceWithEmpty(mesh: THREE.Mesh): void {
  const parent = mesh.parent;
  if (!parent) return;
  const empty = new THREE.Object3D();
  empty.name = mesh.name;
  empty.position.copy(mesh.position);
  empty.quaternion.copy(mesh.quaternion);
  empty.scale.copy(mesh.scale);
  for (const c of [...mesh.children]) empty.add(c);
  parent.children[parent.children.indexOf(mesh)] = empty;
  empty.parent = parent;
  mesh.parent = null;
}

/** Clone with skeletons rebound (plain clone() shares bones between copies). */
export function cloneModel(model: PreparedModel): THREE.Object3D {
  return SkeletonUtils.clone(model.scene);
}

/**
 * Bake the skinned model at `time` seconds into `clipName` into one static geometry in model space.
 * Used for instanced far-LOD infantry.
 */
export function bakePose(model: PreparedModel, clipName: string, time: number): THREE.BufferGeometry {
  const clone = cloneModel(model);
  const clip = model.animations.find((c) => c.name === clipName);
  if (clip) {
    const mixer = new THREE.AnimationMixer(clone);
    mixer.clipAction(clip).play();
    mixer.setTime(time);
  }
  clone.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const v = new THREE.Vector3();
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
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
    if (src.index) g.setIndex(src.index.clone());
    parts.push(g);
  });
  const allIndexed = parts.every((g) => g.index);
  const merged = mergeGeometries(allIndexed ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g)), false) ?? new THREE.BufferGeometry();
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}
