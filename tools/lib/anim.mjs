// Drops animation channels that can't change what's on screen. The Kevin Iglesias soldiers carry
// a full Unity control rig (IK/FK helpers, pole targets) and animate T/R/S on every bone, so most
// channels are either on non-deforming helpers or hold the rest pose.

import { Matrix4, Quaternion, Vector3 } from 'three';

const TOL = { translation: 1e-3, rotation: 1e-3, scale: 1e-3 };

/**
 * @param {object} [opts]
 * @param {string} [opts.dropBones] regex of bones whose animation isn't worth shipping (fingers at RTS zoom)
 * @param {string} [opts.translateBones] regex of the only bones allowed to keep translation channels
 */
export function pruneAnimationChannels(doc, opts = {}) {
  const dropBones = opts.dropBones && new RegExp(opts.dropBones);
  const translateBones = opts.translateBones && new RegExp(opts.translateBones);
  const root = doc.getRoot();
  // Nodes whose motion is visible: skin joints, mesh nodes, and their ancestors.
  const parent = new Map();
  for (const n of root.listNodes()) for (const c of n.listChildren()) parent.set(c, n);
  const relevant = new Set();
  const mark = (n) => {
    for (; n && !relevant.has(n); n = parent.get(n)) relevant.add(n);
  };
  for (const skin of root.listSkins()) skin.listJoints().forEach(mark);
  for (const n of root.listNodes()) if (n.getMesh()) mark(n);

  let dropped = 0, total = 0;
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      total++;
      const node = ch.getTargetNode();
      const path = ch.getTargetPath();
      let drop = !node || !relevant.has(node) || !!dropBones?.test(node.getName());
      if (path === 'translation' && translateBones && !translateBones.test(node.getName())) drop = true;
      if (!drop && path in TOL) {
        const rest = path === 'translation' ? node.getTranslation() : path === 'rotation' ? node.getRotation() : node.getScale();
        const out = ch.getSampler().getOutput();
        const arr = out.getArray(), n = out.getElementSize();
        drop = true;
        for (let i = 0; i < arr.length && drop; i += n) {
          for (let k = 0; k < n; k++) {
            if (Math.abs(arr[i + k] - rest[k]) > TOL[path]) {
              drop = false;
              break;
            }
          }
        }
      }
      if (drop) {
        const s = ch.getSampler();
        ch.dispose();
        if (!s.listParents().some((p) => p.propertyType === 'AnimationChannel')) s.dispose();
        dropped++;
      }
    }
  }
  return { dropped, total };
}

/**
 * Moves a mesh node under another node without changing where it sits in the rest pose. Used to hang
 * the soldiers' weapons on the hand's deform bone instead of a separately animated rig helper.
 */
export function reparentKeepWorld(doc, nodeName, newParentName) {
  const nodes = doc.getRoot().listNodes();
  const node = nodes.find((n) => n.getName() === nodeName);
  const target = nodes.find((n) => n.getName() === newParentName);
  if (!node || !target) throw new Error(`reparent: missing ${node ? newParentName : nodeName}`);
  const world = new Matrix4().fromArray(node.getWorldMatrix());
  const local = new Matrix4().copy(new Matrix4().fromArray(target.getWorldMatrix())).invert().multiply(world);
  const t = new Vector3(), r = new Quaternion(), s = new Vector3();
  local.decompose(t, r, s);
  for (const p of node.listParents()) if (p.propertyType === 'Node' || p.propertyType === 'Scene') p.removeChild(node);
  target.addChild(node);
  node.setTranslation(t.toArray()).setRotation(r.toArray()).setScale(s.toArray());
}

/**
 * Replaces the channels of `bones` in each clip of `into` with the first frame of `clip`: a baked
 * upper-body layer. The Kevin Iglesias idle/locomotion clips let the weapon hang from one hand;
 * Unity layers WeaponHold_* over them, three.js can't, so we bake that pose in.
 */
export function bakeHoldPose(doc, { clip, into, bones }) {
  const root = doc.getRoot();
  const re = new RegExp(bones);
  const hold = root.listAnimations().find((a) => a.getName() === clip);
  if (!hold) throw new Error(`bakeHoldPose: no clip ${clip}`);
  const buffer = root.listBuffers()[0];
  for (const anim of root.listAnimations().filter((a) => into.includes(a.getName()))) {
    for (const ch of anim.listChannels()) {
      if (!re.test(ch.getTargetNode()?.getName() ?? '')) continue;
      const s = ch.getSampler();
      ch.dispose();
      if (!s.listParents().some((p) => p.propertyType === 'AnimationChannel')) s.dispose();
    }
    for (const ch of hold.listChannels()) {
      const node = ch.getTargetNode();
      if (!node || !re.test(node.getName())) continue;
      const src = ch.getSampler().getOutput();
      const value = src.getElement(0, []);
      const input = doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Float32Array([0]));
      const output = doc.createAccessor().setBuffer(buffer).setType(src.getType()).setArray(new Float32Array(value));
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('STEP');
      anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(sampler));
    }
  }
}
