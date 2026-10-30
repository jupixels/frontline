"""Shared helpers for the Blender post-processing scripts (run with `blender -b -P <script> -- <config.json>`).

Coordinates in the JSON configs are game/glTF space: meters, x right, y up, z forward (the way the model faces).
Blender is z-up with -y forward after glTF import, so `game()`/`blender()` convert.
"""

import colorsys
import json
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

GENERATED = os.environ.get('FRONTLINE_GENERATED_SRC') or os.path.join(os.path.expanduser('~'), 'Downloads', 'frontline-generated')


def load_config():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        raise SystemExit('usage: blender -b -P <script> -- <config.json> [--preview <dir>]')
    with open(argv[0], encoding='utf8') as f:
        cfg = json.load(f)
    cfg['_preview'] = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    return cfg


def src(path):
    return path if os.path.isabs(path) else os.path.join(GENERATED, path)


def blender(v):
    """Game (x, y up, z forward) -> Blender (x, -z, y)."""
    return Vector((v[0], -v[2], v[1]))


def game(v):
    return Vector((v[0], v[2], -v[1]))


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=src(path))
    return [o for o in bpy.data.objects if o not in before]


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def apply_transform(obj, matrix):
    """Bake `matrix` into the mesh data (the object keeps an identity transform)."""
    obj.data.transform(matrix)
    obj.data.update()


def bounds(objs):
    pts = [o.matrix_world @ v.co for o in objs for v in o.data.vertices]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return mn, mx


def decimate(obj, target_tris):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris <= target_tris:
        return tris
    mod = obj.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = target_tris / tris
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


class TextureSampler:
    """Reads a material's base color image once, then samples it at UVs."""

    def __init__(self, material):
        img = None
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image:
                img = node.image
                break
        if img is None:
            raise RuntimeError(f'{material.name}: no base color image')
        self.w, self.h = img.size
        self.px = list(img.pixels)  # RGBA floats as stored (sRGB for 8-bit PNG/JPEG), bottom row first

    def rgb(self, uv):
        x = min(self.w - 1, max(0, int((uv[0] % 1.0) * self.w)))
        y = min(self.h - 1, max(0, int((uv[1] % 1.0) * self.h)))
        i = (y * self.w + x) * 4
        return self.px[i], self.px[i + 1], self.px[i + 2]


def classify_faces(obj, rule):
    """Return the set of face indices whose texture color matches `rule` (sampled at a few points per face).

    rule: { vMin, vMax, sMin, sMax, hueMin, hueMax } in HSV (hue in degrees, s/v 0..1, sRGB-encoded values),
    or a list of such rules (a sample matches if any rule does). A face matches when most of its samples match.
    """
    rules = rule if isinstance(rule, list) else [rule]
    me = obj.data
    sampler = TextureSampler(me.materials[0])
    uv = me.uv_layers.active.data
    out = set()
    for poly in me.polygons:
        loops = list(poly.loop_indices)
        centroid = [sum(uv[i].uv[k] for i in loops) / len(loops) for k in (0, 1)]
        samples = [centroid] + [[(uv[i].uv[k] + centroid[k]) / 2 for k in (0, 1)] for i in loops]
        hits = 0
        for s in samples:
            r, g, b = sampler.rgb(s)
            h, sat, v = colorsys.rgb_to_hsv(r, g, b)
            h *= 360
            if any(matches(rl, h, sat, v) for rl in rules):
                hits += 1
        if hits * 2 > len(samples):
            out.add(poly.index)
    return out


def matches(rule, h, sat, v):
    return rule.get('vMin', 0) <= v <= rule.get('vMax', 1) and rule.get('sMin', 0) <= sat <= rule.get('sMax', 1)         and (sat < 0.04 or rule.get('hueMin', 0) <= h <= rule.get('hueMax', 360))


def smooth_selection(obj, faces, passes=2):
    """Majority filter over face neighbours, so paint/detail regions don't end up speckled."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    sel = set(faces)
    for _ in range(passes):
        nxt = set()
        for f in bm.faces:
            nb = {l2.face.index for e in f.edges for l2 in e.link_loops if l2.face is not f}
            if not nb:
                if f.index in sel:
                    nxt.add(f.index)
                continue
            votes = sum(1 for n in nb if n in sel) + (1 if f.index in sel else 0)
            if votes * 2 > len(nb) + 1:
                nxt.add(f.index)
        sel = nxt
    bm.free()
    return sel


def assign_material(obj, faces, material):
    me = obj.data
    if material.name not in [m.name for m in me.materials]:
        me.materials.append(material)
    idx = [m.name for m in me.materials].index(material.name)
    for i in faces:
        me.polygons[i].material_index = idx


def flat_material(name, hex_color, roughness=0.8, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    h = hex_color.lstrip('#')
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


def matte(material, roughness=0.85):
    """Meshy textures come without roughness maps; make sure the default isn't glossy."""
    bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf:
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Metallic'].default_value = 0.0


def downscale_images(size):
    for img in bpy.data.images:
        if img.size[0] > size:
            img.scale(size, size)


def export_glb(path, animations=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_animations=animations,
        export_image_format='JPEG',
        export_image_quality=90,
        export_materials='EXPORT',
    )
    print('wrote', path, os.path.getsize(path) // 1024, 'KB')


def render_preview(out_dir, name, objs, views=('side', 'top', 'persp'), color='OBJECT'):
    """Orthographic workbench renders for checking cuts (material colors, random per object)."""
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.color_type = color
    scene.display.shading.light = 'STUDIO'
    scene.render.resolution_x, scene.render.resolution_y = 1000, 700
    mn, mx = bounds(objs)
    c = (mn + mx) / 2
    size = max(mx - mn) * 1.15
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    for view in views:
        if view == 'side':
            cam_data.type = 'ORTHO'
            cam_data.ortho_scale = size
            cam.location = c + Vector((size * 2, 0, 0))
            cam.rotation_euler = (1.5708, 0, 1.5708)
        elif view == 'top':
            cam_data.type = 'ORTHO'
            cam_data.ortho_scale = size
            cam.location = c + Vector((0, 0, size * 2))
            cam.rotation_euler = (0, 0, 0)
        else:
            cam_data.type = 'PERSP'
            cam_data.lens = 50
            d = size * 1.6
            cam.location = c + Vector((d * 0.6, -d * 0.8, d * 0.75))
            direction = c - cam.location
            cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out_dir, f'{name}_{view}.png')
        bpy.ops.render.render(write_still=True)
