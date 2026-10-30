"""Post-process a Meshy-rigged, Meshy-animated soldier into a Frontline unit model.

    blender -b --factory-startup -P tools/blender/infantry.py -- tools/blender/<id>.json [--preview <dir>]

Steps, driven by the JSON config (see tools/blender/rifleman.json):
  1. import `input` (Meshy's merged animation GLB: skinned mesh + armature + one action per clip)
  2. decimate to `triangles` (skin weights survive the collapse)
  3. split the uniform (everything but `uniform.gear` colors) into a `TeamPaint` material (same texture) the
     renderer tints toward the team color; skin, boots, gloves and goggles keep the Meshy texture as `Gear`
  4. build the rifle from boxes and hang it on the right hand bone, lined up from the right hand to the left
     hand in the `aim` pose, so it sits in both hands
  5. clips: rename per `clips`; `holdArms` bakes the aim pose into the arm bones of the listed clips (Meshy's
     idle lets the arms hang); `Fire` is built here as a short upper-body kick from the aim pose
  6. export `output` (relative to the generated folder)
"""

import math
import os
import sys

import bpy
import bmesh
from bpy_extras import anim_utils
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

cfg = common.load_config()
common.reset()
common.import_glb(cfg['input'])
for o in list(bpy.data.objects):
    if o.type == 'MESH' and (not o.parent or o.parent.type != 'ARMATURE'):
        bpy.data.objects.remove(o)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
body = next(o for o in bpy.data.objects if o.type == 'MESH')
# The importer stacks every clip in NLA tracks; keep the actions, drop the tracks so only one clip plays at a time.
for a in bpy.data.actions:
    a.use_fake_user = True
for t in list(arm.animation_data.nla_tracks):
    arm.animation_data.nla_tracks.remove(t)
FPS = 24
scene = bpy.context.scene
scene.render.fps = FPS

# 2. Triangle budget: decimate must run before the armature modifier.
bpy.context.view_layer.objects.active = body
mod = body.modifiers.new('decimate', 'DECIMATE')
mod.decimate_type = 'COLLAPSE'
tris = sum(len(p.vertices) - 2 for p in body.data.polygons)
mod.ratio = min(1.0, cfg['triangles'] / tris)
mod.use_collapse_triangulate = True
bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
bpy.ops.object.modifier_apply(modifier=mod.name)
print('triangles:', sum(len(p.vertices) - 2 for p in body.data.polygons))

# 3. Team uniform.
gear = body.data.materials[0]
gear.name = 'Gear'
common.matte(gear, 0.9)
# `gear` lists what is NOT uniform (skin, tan boots, black gloves and goggles); everything else is uniform.
gear_faces = common.smooth_selection(body, common.classify_faces(body, cfg['uniform']['gear']), cfg['uniform'].get('smooth', 1))
faces = set(range(len(body.data.polygons))) - gear_faces
# Team accent on the helmet and vest only (rest pose, meters); the rest of the uniform gets a faint tint.
acc = cfg['uniform'].get('accent', {'helmetAbove': 1.55, 'vest': [-0.28, 0.28, 1.0, 1.5]})
vx0, vx1, vz0, vz1 = acc['vest']


def is_accent(i):
    c = body.matrix_world @ body.data.polygons[i].center
    # Rest pose faces -y (Blender), so `vestBack` keeps backpacks behind the torso out of the accent.
    return c.z >= acc['helmetAbove'] or (vx0 <= c.x <= vx1 and vz0 <= c.z <= vz1 and c.y <= acc.get('vestBack', 0.1))


accent = {i for i in faces if is_accent(i)}
common.assign_material(body, faces - accent, common.team_paint(gear))
common.assign_material(body, accent, common.team_paint(gear, 'TeamAccent'))
print(f'uniform: {len(faces)}/{len(body.data.polygons)} faces, accent {len(accent)}')

# Clips by their Meshy names.
actions = {a.name: a for a in bpy.data.actions}
arm.animation_data_create()


def use(action, frame=0):
    arm.animation_data.action = action
    if arm.animation_data.action_slot is None and action.slots:
        arm.animation_data.action_slot = action.slots[0]
    scene.frame_set(int(frame))
    bpy.context.view_layer.update()


def bone_world(name):
    # Imported bone tails are meaningless (glTF has no bone length); heads are the joints.
    return arm.matrix_world @ arm.pose.bones[name].head


# 4. Rifle, lined up in the aim pose.
aim = cfg['aim']
use(actions[aim['clip']], aim['frame'])
r = cfg['rifle']
bm = bmesh.new()
for size, at, *shape in r['boxes']:
    # Weapon space: x right, y up, z forward (toward the support hand); `cyl` makes a tube along z.
    if shape and shape[0] == 'cyl':
        m = Matrix.Translation(Vector((at[0], -at[2], at[1]))) @ Matrix.Rotation(math.radians(90), 4, 'X')
        bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=size[0] / 2, radius2=size[0] / 2, depth=size[2], matrix=m)
    else:
        m = Matrix.Translation(Vector((at[0], -at[2], at[1]))) @ Matrix.Diagonal((size[0], size[2], size[1], 1))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
me = bpy.data.meshes.new(r.get('name', 'Rifle'))
bm.to_mesh(me)
bm.free()
me.materials.append(common.flat_material('Weapon_metal', r['color'], 0.6, 0.3))
rifle = bpy.data.objects.new(r.get('name', 'Rifle'), me)
scene.collection.objects.link(rifle)
# Rifle space: grip at the origin, barrel toward -y (Blender's "forward" for a game +z model).
wrist = bone_world('RightHand')
support = bone_world('LeftHand')
forward = (support - wrist).normalized()
grip = wrist + forward * r.get('gripForward', 0.05)
side = forward.cross(Vector((0, 0, 1))).normalized()
up = side.cross(forward).normalized()
basis = Matrix((side, -forward, up)).transposed().to_4x4()
rifle.matrix_world = Matrix.Translation(grip + Vector(r.get('gripOffset', (0, 0, 0)))) @ basis
world = rifle.matrix_world.copy()
rifle.parent = arm
rifle.parent_type = 'BONE'
rifle.parent_bone = 'RightHand'
bpy.context.view_layer.update()
rifle.matrix_world = world
print('grip to support hand:', round((support - grip).length, 3), 'm')

# 5. Clips.
ARM_BONES = cfg.get('armBones', ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'])
use(actions[aim['clip']], aim['frame'])
hold = {b: (arm.pose.bones[b].rotation_quaternion.copy(), arm.pose.bones[b].location.copy()) for b in ARM_BONES}


def channelbag(action):
    return anim_utils.action_get_channelbag_for_slot(action, action.slots[0])


def set_constant(action, bones, pose):
    """Replace the bones' channels in `action` with the given (rotation, location) held for the whole clip."""
    cb = channelbag(action)
    for fc in list(cb.fcurves):
        if any(fc.data_path.startswith(f'pose.bones["{b}"]') for b in bones):
            cb.fcurves.remove(fc)
    start, end = action.frame_range
    use(action, start)
    for b in bones:
        pb = arm.pose.bones[b]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion, pb.location = pose[b]
        for f in (start, end):
            pb.keyframe_insert('rotation_quaternion', frame=f)


for name in cfg.get('holdArms', []):
    set_constant(actions[name], ARM_BONES, hold)

# Fire: aim pose, kick back on the spine and shoulders, settle.
fire = bpy.data.actions.new('Fire')
fire_slot = fire.slots.new('OBJECT', arm.name)
arm.animation_data.action = fire
arm.animation_data.action_slot = fire_slot
kick = cfg.get('fireKick', {})
for b in ARM_BONES + list(kick):
    pb = arm.pose.bones[b]
    pb.rotation_mode = 'QUATERNION'
    base = hold[b][0] if b in hold else Quaternion()
    for t, k in ((0, 0), (0.05, 1), (0.25, 0)):
        axis_angle = kick.get(b, [1, 0, 0, 0])
        pb.rotation_quaternion = base @ Quaternion(Vector(axis_angle[:3]), math.radians(axis_angle[3]) * k)
        pb.keyframe_insert('rotation_quaternion', frame=t * FPS)
for src, dst in cfg['clips'].items():
    actions[src].name = dst
for a in list(bpy.data.actions):
    if a.name not in list(cfg['clips'].values()) + ['Fire']:
        bpy.data.actions.remove(a)
use(bpy.data.actions[cfg['clips'][cfg.get('restClip', aim['clip'])]], 0)
arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.rotation_quaternion = Quaternion()
    pb.location = Vector()

common.downscale_images(cfg.get('textureSize', 512))

if cfg['_preview']:
    name = os.path.splitext(os.path.basename(cfg['output']))[0]
    for m in bpy.data.materials:
        m.diffuse_color = {'TeamAccent': (0.8, 0.15, 0.1, 1), 'TeamPaint': (0.55, 0.5, 0.35, 1), 'Weapon_metal': (0.1, 0.1, 0.1, 1)}.get(m.name, (0.75, 0.7, 0.6, 1))
    for clip, frame in cfg.get('previewFrames', {}).items():
        use(bpy.data.actions[clip], frame)
        common.render_preview(cfg['_preview'], f'{name}_{clip}', [body, rifle], views=('persp', 'side'), color='MATERIAL')
    arm.animation_data.action = None

# Export every clip (actions are exported by slot; none stays assigned so the rest pose is the bind pose).
os.makedirs(os.path.dirname(common.src(cfg['output'])), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=common.src(cfg['output']),
    export_format='GLB',
    export_yup=True,
    export_apply=False,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_force_sampling=True,
    export_image_format='JPEG',
    export_image_quality=90,
)
print('wrote', common.src(cfg['output']), os.path.getsize(common.src(cfg['output'])) // 1024, 'KB')
