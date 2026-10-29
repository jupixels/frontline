// Drops animation channels that can't change what's on screen. The Kevin Iglesias soldiers carry
// a full Unity control rig (IK/FK helpers, pole targets) and animate T/R/S on every bone, so most
// channels are either on non-deforming helpers or hold the rest pose.

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
