"""Post-process a Meshy vehicle into a Frontline unit model.

    blender -b --factory-startup -P tools/blender/vehicle.py -- tools/blender/<id>.json [--preview <dir>]

Steps, driven by the JSON config (see tools/blender/tank_mbt.json):
  1. import `input` (relative to ~/Downloads/frontline-generated or FRONTLINE_GENERATED_SRC), join meshes
  2. `rotateY` so it faces +Z, scale to `length` (longest horizontal side, m), center on x/z, sit on y=0
  3. decimate to `triangles`
  4. split the paint (texture color matching `paint`) into `TeamPaint` (faint team tint) and, for upward-facing
     paint above `accent.minHeight` x height, `TeamAccent` (team color); same texture, so weathering stays;
     the rest keeps the Meshy texture as `Detail`
  5. cut moving parts out by box (`parts`, game coords) into named nodes with their pivot at `pivot`;
     `cap` fills the hole a turret leaves in the hull deck
  6. clips: `Fire` (barrel recoil), `TurretScan` (keeps P_turret a separate animated node in the renderer),
     `Death` (turret lifts off), `Idle` (parts with `spin`, e.g. radar dishes, which need a name the renderer
     keeps animated, like `turret_radar`)
  7. export `output` (relative to the generated folder)
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

cfg = common.load_config()
common.reset()
common.import_glb(cfg['input'])
for o in list(bpy.data.objects):
    if o.type != 'MESH' or len(o.data.polygons) < 200:
        bpy.data.objects.remove(o)
meshes = common.mesh_objects()
bpy.context.view_layer.objects.active = meshes[0]
for o in meshes:
    o.select_set(True)
if len(meshes) > 1:
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = 'hull'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# 2. Orientation and size.
common.apply_transform(body, Matrix.Rotation(math.radians(cfg.get('rotateY', 0)), 4, 'Z'))
mn, mx = common.bounds([body])
size = mx - mn
# `fit: [w, d]` (structures): the largest uniform scale that fits the footprint (game x by z).
s = min(cfg['fit'][0] / size.x, cfg['fit'][1] / size.y) if 'fit' in cfg else cfg['length'] / max(size.x, size.y)
common.apply_transform(body, Matrix.Scale(s, 4))
mn, mx = common.bounds([body])
common.apply_transform(body, Matrix.Translation(Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -mn.z))))
mn, mx = common.bounds([body])
print('size (game x, y, z):', [round(v, 2) for v in common.game(mx - mn)])

# Stray geometry from the generator: `remove` boxes (game coords) delete the faces centered inside them.
for box in cfg.get('remove', []):
    bm = bmesh.new()
    bm.from_mesh(body.data)
    gone = [f for f in bm.faces if all(box[2 * k] <= common.game(f.calc_center_median())[k] <= box[2 * k + 1] for k in range(3))]
    bmesh.ops.delete(bm, geom=gone, context='FACES')
    bm.to_mesh(body.data)
    bm.free()
    print(f'removed {len(gone)} faces in {box}')

# 3. Triangle budget.
print('triangles:', common.decimate(body, cfg['triangles']))

# 4. Team paint.
detail = body.data.materials[0]
detail.name = 'Detail'
common.matte(detail)
paint_faces = common.smooth_selection(body, common.classify_faces(body, cfg['paint']), cfg['paint'].get('smooth', 2))
# Running gear (road wheels, tracks) stays textured: faces centered below `detailBelow` meters.
low = cfg['paint'].get('detailBelow', 0)
paint_faces = {i for i in paint_faces if body.data.polygons[i].center.z >= low}
# Team accent: upward-facing paint high on the model (turret roof, upper deck, cab roof) carries the team
# color; the rest of the paint only gets a faint tint (see TEAM_PAINT/TEAM_ACCENT in src/render/materials.ts).
acc = cfg.get('accent', {})
height = common.bounds([body])[1].z
accent_faces = {i for i in paint_faces
                if body.data.polygons[i].normal.z >= acc.get('normalZ', 0.65)
                and body.data.polygons[i].center.z >= acc.get('minHeightM', acc.get('minHeight', 0.62) * height)}
common.assign_material(body, paint_faces - accent_faces, common.team_paint(detail))
common.assign_material(body, accent_faces, common.team_paint(detail, 'TeamAccent'))
print(f'paint: {len(paint_faces)}/{len(body.data.polygons)} faces, accent {len(accent_faces)}')


# 5. Moving parts.
def inside(p, box):
    g = common.game(p)  # p is in world space
    return all(box[2 * k] <= g[k] <= box[2 * k + 1] for k in range(3))


def separate(src, name, box):
    bm = bmesh.new()
    bm.from_mesh(src.data)
    bm.transform(src.matrix_world)
    keep = [f for f in bm.faces if not inside(f.calc_center_median(), box)]
    take = [f for f in bm.faces if inside(f.calc_center_median(), box)]
    part_bm = bm.copy()
    bmesh.ops.delete(bm, geom=take, context='FACES')
    bm.transform(src.matrix_world.inverted())
    bm.to_mesh(src.data)
    bm.free()
    part_bm.faces.ensure_lookup_table()
    drop = [f for f in part_bm.faces if not inside(f.calc_center_median(), box)]
    bmesh.ops.delete(part_bm, geom=drop, context='FACES')
    me = bpy.data.meshes.new(name)
    part_bm.to_mesh(me)
    part_bm.free()
    for m in src.data.materials:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if me.vertices:
        lo = [min(v.co[k] for v in me.vertices) for k in range(3)]
        hi = [max(v.co[k] for v in me.vertices) for k in range(3)]
        mid = common.game(Vector([(a + b) / 2 for a, b in zip(lo, hi)]))
        print(f'{name}: {len(me.polygons)} faces, {len(keep)} left in {src.name}, bounds center (game) {[round(v, 2) for v in mid]}')
    return obj


nodes = {'hull': body}
for part in cfg.get('parts', []):
    parent = nodes[part.get('from', 'hull')]
    bpy.context.view_layer.update()
    obj = separate(parent, part['name'], part['box'])
    pivot = common.blender(part['pivot'])
    common.apply_transform(obj, Matrix.Translation(-pivot))
    obj.location = pivot
    nodes[part['name']] = obj
bpy.context.view_layer.update()
for part in cfg.get('parts', []):
    obj = nodes[part['name']]
    parent = nodes.get(part.get('parent', 'hull'))
    if parent is not body:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world

cap = cfg.get('cap')
if cap:
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=24, radius=cap['radius'])
    me = bpy.data.meshes.new('ring')
    bm.to_mesh(me)
    bm.free()
    me.transform(Matrix.Translation(common.blender(cap['center'])))
    for m in body.data.materials:
        me.materials.append(m)
    ring = bpy.data.objects.new('ring', me)
    bpy.context.scene.collection.objects.link(ring)
    common.assign_material(ring, range(len(me.polygons)), common.flat_material('Metal_ring', '#2c2d28', 0.7, 0.3))
    for o in (ring,):
        o.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()

# Root node at the origin so the hull mesh isn't the scene root (keeps the hierarchy the renderer expects).
bpy.context.view_layer.update()
root = bpy.data.objects.new(cfg.get('root', 'frontline'), None)
bpy.context.scene.collection.objects.link(root)
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' and o.parent is None:
        world = o.matrix_world.copy()
        o.parent = root
        o.matrix_world = world

# 6. Clips (24 fps).
FPS = 24
bpy.context.scene.render.fps = FPS


def clip(name, keys):
    """keys: list of (object, data_path, [(seconds, value), ...]). One action per object, grouped by name."""
    for obj, path, frames in keys:
        if obj.animation_data is None:
            obj.animation_data_create()
        rest = getattr(obj, path).copy()
        for t, value in frames:
            setattr(obj, path, value)
            obj.keyframe_insert(path, frame=1 + t * FPS)
        setattr(obj, path, rest)
        action = obj.animation_data.action
        action.name = f'{name}'
        track = obj.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        obj.animation_data.action = None


turret = nodes.get('P_turret')
barrel = nodes.get('P_barrel')
if barrel and 'recoil' in cfg:
    r = cfg['recoil']
    loc = barrel.location.copy()
    back = loc + Vector((0, r, 0))  # game -z (backwards) is Blender +y
    clip('Fire', [(barrel, 'location', [(0, loc), (0.06, back), (0.5, loc)])])
if turret:
    q = turret.rotation_euler.copy()
    scan = [(t, q.copy()) for t in (0, 3)]
    for t, a in ((1, 0.35), (2, -0.35)):
        e = q.copy()
        e.z += a
        scan.insert(-1, (t, e))
    clip('TurretScan', [(turret, 'rotation_euler', sorted(scan, key=lambda k: k[0]))])
    loc = turret.location.copy()
if turret and cfg.get('death', True):
    # Ships set `death: false`: they sink (renderer) instead of popping a turret.
    clip('Death', [(turret, 'location', [(0, loc), (0.25, loc + Vector((0, 0.2, cfg.get('deathLift', 0.5)))), (0.6, loc + Vector((0, 0.3, 0.12)))])])
# `spin` parts (radar dishes, rotors) turn in looping clips (`spinClips`, default Idle). `spinAxis` is the
# game axis: y (vertical, default) or x (sideways, a tail rotor). All spinners share one period so the loop
# is seamless: the slowest completes one turn, faster ones a whole number of turns.
spinners = [(nodes[p['name']], p['spin'], p.get('spinAxis', 'y')) for p in cfg.get('parts', []) if p.get('spin')]
if spinners:
    period = 2 * math.pi / min(abs(r) for _, r, _ in spinners)
    for name in cfg.get('spinClips', ['Idle']):
        keys = []
        for obj, rate, axis in spinners:
            turns = max(1, round(abs(rate) * period / (2 * math.pi)))
            steps = 8 * turns
            idx = {'y': 2, 'x': 0}[axis]
            e0 = obj.rotation_euler.copy()
            frames = []
            for k in range(steps + 1):
                e = e0.copy()
                e[idx] += math.copysign(2 * math.pi * turns, rate) * k / steps
                frames.append((period * k / steps, e))
            keys.append((obj, 'rotation_euler', frames))
        clip(name, keys)
# `crash`: aircraft roll over and drop the nose while the renderer makes them fall.
if cfg.get('crash'):
    body.rotation_mode = 'XYZ'  # the glTF importer leaves imported objects in quaternion mode
    e0 = body.rotation_euler.copy()
    roll = e0.copy()
    roll.y += 0.9
    roll.x -= 0.35
    clip('Crash', [(body, 'rotation_euler', [(0, e0), (1.6, roll)])])

common.downscale_images(cfg.get('textureSize', 1024))

if cfg['_preview']:
    name = os.path.splitext(os.path.basename(cfg['output']))[0]
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            o.color = {'hull': (0.5, 0.5, 0.45, 1), 'P_turret': (0.9, 0.5, 0.2, 1), 'P_barrel': (0.2, 0.6, 0.9, 1)}.get(o.name, (0.6, 0.6, 0.6, 1))
    common.render_preview(cfg['_preview'], name, common.mesh_objects())
    for m in bpy.data.materials:
        m.diffuse_color = (0.8, 0.15, 0.1, 1) if m.name == 'TeamAccent' else (0.55, 0.5, 0.35, 1) if m.name == 'TeamPaint' else (0.25, 0.25, 0.25, 1)
    common.render_preview(cfg['_preview'], name + '_mat', common.mesh_objects(), views=('persp', 'top'), color='MATERIAL')

common.export_glb(common.src(cfg['output']))
