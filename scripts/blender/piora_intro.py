# -*- coding: utf-8 -*-
"""
PIORA / POLARIS EXPEDITION / 2076
Procedural Blender startup film — no external models, textures or add-ons.

使用：Blender → Scripting → Open 此文件 → Run Script。
先用 PREVIEW + BUILD 检查构图；FINAL + ANIMATION 输出完整影片。
实测版本：Blender 5.2.1 LTS；保留 Blender 4.5 兼容分支，4.5 尚未实机验证。
本脚本新建场景，不删除现有场景；输出写入每次运行的独立目录。
所有运动烘焙为关键帧，无需开启 Auto Run Python Scripts。
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import random
import sys
from datetime import datetime
from pathlib import Path

try:
    import bpy
    from mathutils import Vector, Matrix
except ImportError:
    bpy = None  # Allows the pure numerical functions to be tested outside Blender.

# ============================================================================
# 用户配置：通常只需修改这里
# ============================================================================
CONFIG = {
    "brand": "piora",                       # 车身两侧 + 片尾的真实文字
    "subtitle": "The Operating System for Personal AI Agents",
    "year": 2076,
    "duration": 8.0,                         # 秒；可改为 4.0，动作会整体压缩
    "fps": 30,
    "resolution": (1920, 1080),
    "quality": "PREVIEW",                    # PREVIEW=50%分辨率；FINAL=100%
    "engine": "EEVEE",                       # EEVEE 或 CYCLES
    "render_mode": "BUILD",                  # BUILD / FRAME / ANIMATION
    "output_format": "MP4",                  # MP4 或 PNG_SEQUENCE
    "output_dir": "",                        # 留空：用户主目录/Piora_Animation
    "font_path": "",                         # 留空用 Blender 内置字体
    "save_blend": True,
    "dust": True,
    "tracks": True,
    "scan_effect": True,
    "show_moon": True,
    "show_metadata": True,
    "motion_blur": True,
    "seed": 2076,
}

# 颜色为设计值，不是天体实测值。避免高饱和霓虹、过度赛博朋克。
PALETTE = {
    "ceramic": "CBD1D8",
    "ceramic_dark": "939BA9",
    "graphite": "202532",
    "rubber": "131821",
    "metal": "667181",
    "dark_metal": "353F50",
    "glass": "111D33",
    "violet": "9585D8",
    "ice_blue": "B5CADC",
    "white": "E8ECF5",
    "ground_dark": "171E2C",
    "ground_light": "566274",
    "frost": "9AABB9",
    "background": "060912",
}
WHEEL_RADIUS = 0.68
WHEEL_X = (-1.55, 0.0, 1.55)
WHEEL_Y = (-1.22, 1.22)
START_X = -5.4
END_X = 1.35
PREFIX = "PIORA_"
SCENE = None
HUD = None
COLLECTIONS = {}
MATERIALS = {}
MESH_CACHE = {}
AXIS_COORDS = []
CFG = {}
RNG = None
OUT = None

# ============================================================================
# 纯数学函数；可以不依赖 Blender 进行测试
# ============================================================================
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smooth(x):
    x = clamp(x)
    return x * x * (3.0 - 2.0 * x)


def smoother(x):
    x = clamp(x)
    return x * x * x * (x * (6.0 * x - 15.0) + 10.0)


def lerp(a, b, t):
    return a + (b - a) * t


def drive_x(u):
    """Smooth acceleration/braking; stopped for the final 25% of the film."""
    return lerp(START_X, END_X, smoother(u / 0.75))


def terrain_height(x, y):
    """A continuous invented ice/regolith landscape, not an astronomical map."""
    low = (1.30 * math.sin(x * 0.032 + 0.4) * math.cos(y * 0.046 - 0.3)
           + 0.70 * math.sin(x * 0.082 + y * 0.061)
           + 0.31 * math.sin(x * 0.21 - y * 0.17)
           + 0.10 * math.sin(x * 0.57 + y * 0.41))
    route = 0.075 * math.sin(x * 0.67) + 0.022 * math.sin(1.8 * x + 0.4 * y)
    corridor = math.exp(-((y / 4.0) ** 4))
    ridges = smooth((abs(y) - 13.0) / 34.0) * (
        2.4 + 4.0 * abs(math.sin(0.043 * x + 0.025 * y)) ** 3
        + 2.3 * abs(math.sin(0.12 * x - 0.042 * y)) ** 5)
    crater_r = math.hypot(x - 18.0, y - 18.0)
    crater = (1.4 * math.exp(-((crater_r - 7.0) / 1.1) ** 2)
              - 1.1 * math.exp(-(crater_r / 5.8) ** 4))
    return lerp(low + ridges + crater, route, corridor)


def make_axis(preview):
    """Dense around the rover, coarser toward the horizon; no overlapping grids."""
    n = 110 if preview else 174
    center = [lerp(-28.0, 28.0, i / n) for i in range(n + 1)]
    outer_n = 32 if preview else 44
    positive = [28.0 + 455.0 * (i / outer_n) ** 1.85
                for i in range(1, outer_n + 1)]
    return [-v for v in reversed(positive)] + center + positive


def surface_height(x, y):
    """Interpolate the ACTUAL triangle surface used by the generated terrain."""
    if not AXIS_COORDS:
        return terrain_height(x, y)
    xs = AXIS_COORDS
    i = min(len(xs) - 2, max(0, bisect.bisect_right(xs, x) - 1))
    j = min(len(xs) - 2, max(0, bisect.bisect_right(xs, y) - 1))
    a, b = xs[i], xs[i + 1]
    c, d = xs[j], xs[j + 1]
    tx, ty = clamp((x - a) / (b - a)), clamp((y - c) / (d - c))
    h00, h10 = terrain_height(a, c), terrain_height(b, c)
    h11, h01 = terrain_height(b, d), terrain_height(a, d)
    # Matching diagonal: (00,10,11) and (00,11,01).
    if ty <= tx:
        return (1.0 - tx) * h00 + (tx - ty) * h10 + ty * h11
    return (1.0 - ty) * h00 + tx * h11 + (ty - tx) * h01


def camera_pose(u):
    """Continuous single take: approach → side branding → gentle pull-back."""
    nodes = [
        (0.00, (6.8, -10.8, 2.8), (0.10, 0.0, 1.20), 40.0),
        (0.25, (4.7, -8.5, 2.35), (0.15, 0.0, 1.30), 40.0),
        (0.55, (3.35, -7.6, 2.42), (0.25, -0.05, 1.28), 38.0),
        (0.75, (5.2, -10.2, 3.0), (0.35, 0.0, 1.45), 38.0),
        (1.00, (7.0, -13.8, 4.0), (0.30, 0.0, 1.55), 33.0),
    ]
    for left, right in zip(nodes, nodes[1:]):
        if u <= right[0]:
            t = smooth((u - left[0]) / (right[0] - left[0]))
            pos = tuple(lerp(a, b, t) for a, b in zip(left[1], right[1]))
            target = tuple(lerp(a, b, t) for a, b in zip(left[2], right[2]))
            return pos, target, lerp(left[3], right[3], t)
    return nodes[-1][1], nodes[-1][2], nodes[-1][3]


def rgba(hex_string, alpha=1.0):
    """sRGB design hex -> linear scene values."""
    s = hex_string.lstrip("#")
    def lin(v):
        v = int(v, 16) / 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return tuple(lin(s[i:i + 2]) for i in (0, 2, 4)) + (alpha,)


def F(u):
    return 1 + round(clamp(u) * (SCENE.frame_end - 1))


def set_input(node, name, value):
    socket = node.inputs.get(name)
    if socket is not None:
        socket.default_value = value
        return True
    return False


def obj_new(name, data, group="Rover", parent=None):
    ob = bpy.data.objects.new(PREFIX + name, data)
    COLLECTIONS[group].objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def empty(name, parent=None, group="Rover"):
    ob = obj_new(name, None, group, parent)
    ob.empty_display_size = 0.15
    return ob


def mesh_data(name, verts, faces):
    me = bpy.data.meshes.new(PREFIX + name)
    me.from_pydata(verts, [], faces)
    me.update()
    return me


def mesh_obj(name, verts, faces, mat, group="Rover", parent=None, bevel=0.0):
    me = mesh_data(name, verts, faces)
    if mat:
        me.materials.append(mat)
    ob = obj_new(name, me, group, parent)
    if bevel:
        mod = ob.modifiers.new("Manufactured edge radii", "BEVEL")
        mod.width = bevel
        mod.segments = 3
        mod.limit_method = "ANGLE"
        mod = ob.modifiers.new("Panel normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
        mod.weight = 40
    return ob


def smooth_mesh(ob):
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


BOX_FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def box_geometry(dim):
    x, y, z = (d / 2.0 for d in dim)
    return [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
            (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]


def box(name, loc, dim, mat, bevel=0.02, parent=None, group="Rover", rot=None):
    ob = mesh_obj(name, box_geometry(dim), BOX_FACES, mat, group, parent, bevel)
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    return ob


def cylinder(name, loc, radius, depth, mat, parent=None, rot=None,
             group="Rover", segments=40):
    key = ("cyl", radius, depth, segments, mat.name)
    if key not in MESH_CACHE:
        v = [(radius * math.cos(i * math.tau / segments),
              radius * math.sin(i * math.tau / segments), z)
             for z in (-depth / 2, depth / 2) for i in range(segments)]
        f = [tuple(reversed(range(segments))), tuple(range(segments, 2 * segments))]
        for i in range(segments):
            k = (i + 1) % segments
            f.append((i, k, k + segments, i + segments))
        me = mesh_data("Cylinder", v, f)
        me.materials.append(mat)
        for p in list(me.polygons)[2:]:
            p.use_smooth = True
        MESH_CACHE[key] = me
    ob = obj_new(name, MESH_CACHE[key], group, parent)
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    return ob


def torus(name, loc, major, minor, mat, parent=None, rot=None, group="Rover"):
    key = ("torus", major, minor, mat.name)
    if key not in MESH_CACHE:
        a, b = 56, 10
        v, f = [], []
        for i in range(a):
            u = math.tau * i / a
            for j in range(b):
                w = math.tau * j / b
                r = major + minor * math.cos(w)
                v.append((r * math.cos(u), r * math.sin(u), minor * math.sin(w)))
        for i in range(a):
            for j in range(b):
                f.append((i*b+j, ((i+1)%a)*b+j,
                          ((i+1)%a)*b+(j+1)%b, i*b+(j+1)%b))
        me = mesh_data("Torus", v, f)
        me.materials.append(mat)
        for p in me.polygons:
            p.use_smooth = True
        MESH_CACHE[key] = me
    ob = obj_new(name, MESH_CACHE[key], group, parent)
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    return ob


def sphere_data(name, rings=16, segments=32):
    v = [(0, 0, -1)]
    for j in range(1, rings):
        lat = -math.pi/2 + math.pi*j/rings
        for i in range(segments):
            ang = math.tau*i/segments
            v.append((math.cos(lat)*math.cos(ang), math.cos(lat)*math.sin(ang),
                      math.sin(lat)))
    top = len(v)
    v.append((0, 0, 1))
    f = []
    for i in range(segments):
        f.append((0, 1+(i+1)%segments, 1+i))
    for j in range(rings-2):
        for i in range(segments):
            a = 1+j*segments+i
            b = 1+j*segments+(i+1)%segments
            f.append((a, b, b+segments, a+segments))
    last = 1+(rings-2)*segments
    for i in range(segments):
        f.append((last+i, last+(i+1)%segments, top))
    return mesh_data(name, v, f)


def sphere(name, loc, scale, mat, group="Environment", parent=None, detail=16):
    key = ("sphere", detail, mat.name)
    if key not in MESH_CACHE:
        me = sphere_data("Sphere", detail, detail*2)
        me.materials.append(mat)
        for p in me.polygons:
            p.use_smooth = True
        MESH_CACHE[key] = me
    ob = obj_new(name, MESH_CACHE[key], group, parent)
    ob.location = loc
    ob.scale = (scale, scale, scale) if isinstance(scale, (int, float)) else scale
    return ob


def rod(name, start, end, radius, mat, parent=None, group="Rover"):
    ob = cylinder(name, (0, 0, 0), radius, 1.0, mat, parent, group=group, segments=20)
    update_rod(ob, Vector(start), Vector(end))
    return ob


def update_rod(ob, start, end):
    delta = end - start
    ob.location = (start + end) / 2
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(delta.normalized())
    ob.scale = (1, 1, max(delta.length, 0.0001))


def curve_line(name, points, mat, radius=0.012, parent=None, group="Rover"):
    cu = bpy.data.curves.new(PREFIX + name, "CURVE")
    cu.dimensions = "3D"
    cu.resolution_u = 1
    cu.bevel_depth = radius
    cu.bevel_resolution = 2
    sp = cu.splines.new("POLY")
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (*co, 1)
    cu.materials.append(mat)
    return obj_new(name, cu, group, parent)


def text(name, body, loc, size, mat, parent=None, group="Rover",
         rot=None, align="CENTER", tracking=1.0):
    cu = bpy.data.curves.new(PREFIX + name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.space_character = tracking
    cu.extrude = 0.0015 if group == "Rover" else 0
    cu.bevel_depth = 0.0005 if group == "Rover" else 0
    cu.resolution_u = 12
    if CFG["font_path"]:
        cu.font = MATERIALS["font"]
    cu.materials.append(mat)
    ob = obj_new(name, cu, group, parent)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    return ob


def principled(name, color, metallic=0.0, roughness=0.45, coat=0.0):
    ma = bpy.data.materials.new(PREFIX + name)
    ma.diffuse_color = rgba(color)
    ma.use_nodes = True
    bs = ma.node_tree.nodes.get("Principled BSDF")
    set_input(bs, "Base Color", rgba(color))
    set_input(bs, "Metallic", metallic)
    set_input(bs, "Roughness", roughness)
    set_input(bs, "Coat Weight", coat)
    return ma


def emissive(name, color, strength=1.0, fade=False):
    ma = bpy.data.materials.new(PREFIX + name)
    ma.diffuse_color = rgba(color)
    ma.use_nodes = True
    ns, ls = ma.node_tree.nodes, ma.node_tree.links
    ns.clear()
    out = ns.new("ShaderNodeOutputMaterial")
    em = ns.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = rgba(color)
    em.inputs["Strength"].default_value = strength
    if fade:
        trans = ns.new("ShaderNodeBsdfTransparent")
        mix = ns.new("ShaderNodeMixShader")
        val = ns.new("ShaderNodeValue")
        val.name = "Visibility"
        val.outputs[0].default_value = 0.0
        ls.new(val.outputs[0], mix.inputs[0])
        ls.new(trans.outputs[0], mix.inputs[1])
        ls.new(em.outputs[0], mix.inputs[2])
        ls.new(mix.outputs[0], out.inputs["Surface"])
        if hasattr(ma, "surface_render_method"):
            ma.surface_render_method = "DITHERED"
        elif hasattr(ma, "blend_method"):
            ma.blend_method = "BLEND"
    else:
        ls.new(em.outputs[0], out.inputs["Surface"])
    return ma


def animate_value(socket, keys):
    for frame, value in keys:
        socket.default_value = value
        socket.keyframe_insert("default_value", frame=frame)


def build_materials():
    for key, metal, rough, coat in [
        ("ceramic", .28, .32, .23), ("ceramic_dark", .32, .4, .12),
        ("graphite", .6, .38, .08), ("rubber", .12, .84, 0),
        ("metal", .85, .28, .05), ("dark_metal", .72, .4, 0),
        ("glass", .60, .12, .6)]:
        MATERIALS[key] = principled(key, PALETTE[key], metal, rough, coat)
    MATERIALS["lettering"] = principled("Ceramic inlay lettering", "F4F5F8", .2, .35)
    MATERIALS["small_print"] = principled("Service markings", "4B5666", .2, .6)
    MATERIALS["violet"] = emissive("Low power violet status light", PALETTE["violet"], 2.1)
    MATERIALS["headlamp"] = emissive("Headlamp diffuser", "DAE8F6", 5.0)
    MATERIALS["lens"] = principled("Coated optic", "172C43", .78, .13, .7)
    MATERIALS["tracks"] = principled("Compressed wheel regolith", "141B29", .05, .98)
    MATERIALS["rock"] = principled("Fractured basalt", "343B4A", .17, .92)
    MATERIALS["ice"] = principled("Exposed mineral ice", "748FA7", .22, .27, .34)
    ma = principled("Ice regolith procedural ground", "4B5667", .14, .8)
    ns, ls = ma.node_tree.nodes, ma.node_tree.links
    bs = ns.get("Principled BSDF")
    tex = ns.new("ShaderNodeTexCoord")
    broad = ns.new("ShaderNodeTexNoise")
    broad.inputs["Scale"].default_value = .39
    broad.inputs["Detail"].default_value = 4
    broad.inputs["Roughness"].default_value = .72
    ls.new(tex.outputs["Object"], broad.inputs["Vector"])
    ramp = ns.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = .23
    ramp.color_ramp.elements[0].color = rgba(PALETTE["ground_dark"])
    ramp.color_ramp.elements[1].position = .79
    ramp.color_ramp.elements[1].color = rgba(PALETTE["ground_light"])
    ramp.color_ramp.elements.new(.64).color = rgba("738293")
    ls.new(broad.outputs["Fac"], ramp.inputs[0])
    ls.new(ramp.outputs["Color"], bs.inputs["Base Color"])
    micro = ns.new("ShaderNodeTexNoise")
    micro.inputs["Scale"].default_value = 42
    micro.inputs["Detail"].default_value = 3
    ls.new(tex.outputs["Object"], micro.inputs["Vector"])
    bump = ns.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = .55
    bump.inputs["Distance"].default_value = .05
    ls.new(micro.outputs["Fac"], bump.inputs["Height"])
    ls.new(bump.outputs["Normal"], bs.inputs["Normal"])
    MATERIALS["terrain"] = ma
    if CFG["font_path"]:
        fp = Path(CFG["font_path"]).expanduser()
        if not fp.is_file():
            raise FileNotFoundError("找不到字体文件：" + str(fp))
        MATERIALS["font"] = bpy.data.fonts.load(str(fp), check_existing=True)


def build_terrain():
    global AXIS_COORDS
    AXIS_COORDS = make_axis(CFG["quality"] == "PREVIEW")
    n = len(AXIS_COORDS)
    verts = [(x, y, terrain_height(x, y)) for y in AXIS_COORDS for x in AXIS_COORDS]
    faces = []
    for j in range(n - 1):
        for i in range(n - 1):
            a = j*n+i
            faces.extend(((a, a+1, a+n+1), (a, a+n+1, a+n)))
    smooth_mesh(mesh_obj("Fictional ice world", verts, faces, MATERIALS["terrain"], "Environment"))
    templates = []
    for k in range(8):
        me = sphere_data("Basalt template", 5, 9)
        for v in me.vertices:
            v.co *= RNG.uniform(.72, 1.20)
            v.co.x += .12 * v.co.z
        me.materials.append(MATERIALS["rock"])
        templates.append(me)
    for i in range(130 if CFG["quality"] == "PREVIEW" else 240):
        x, y = RNG.uniform(-30, 32), RNG.uniform(-19, 36)
        if abs(y) < 2.4 and -11 < x < 6:
            continue  # Keep all six wheels' swept volume clear.
        radius = RNG.uniform(.075, .5) if i % 7 else RNG.uniform(.5, 1.2)
        ob = obj_new("Basalt fragment %03d" % i, templates[i % len(templates)], "Environment")
        ob.location = (x, y, surface_height(x, y) + .20*radius)
        ob.scale = (radius*RNG.uniform(.8, 1.6), radius, radius*RNG.uniform(.45, .95))
        ob.rotation_euler = (RNG.uniform(-.25, .25), RNG.uniform(-.3, .3), RNG.uniform(0, math.tau))
    # Angular, non-emissive ice outcrops. Not giant glowing fantasy crystals.
    for i, (x, y, sx, sy, sz) in enumerate([
            (-9, 7, 1.5, .65, 1.3), (4, 9, 2.2, .7, 1.55),
            (11, 16, 1.2, .8, 2.2), (-16, 18, 2.1, .9, 2.5),
            (17, -9, 1.2, .5, .9), (-12, -6, 1.0, .55, .8)]):
        v = [(-sx, -sy, 0), (sx, -sy, 0), (sx, sy, 0), (-sx, sy, 0),
             (-.55*sx, -.5*sy, sz), (.25*sx, -.35*sy, sz*1.12),
             (.50*sx, .35*sy, sz*.7), (-.4*sx, .5*sy, sz*.88)]
        ob = mesh_obj("Fractured ice shelf %02d" % i, v, BOX_FACES,
                      MATERIALS["ice"], "Environment", bevel=.035)
        ob.location = (x, y, surface_height(x, y)-.05)
        ob.rotation_euler.z = RNG.uniform(-1, 1)


def build_world():
    world = bpy.data.worlds.new(PREFIX + "Deep space")
    world.use_nodes = True
    SCENE.world = world
    ns, ls = world.node_tree.nodes, world.node_tree.links
    ns.clear()
    out = ns.new("ShaderNodeOutputWorld")
    bg = ns.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = .32
    tex = ns.new("ShaderNodeTexCoord")
    xyz = ns.new("ShaderNodeSeparateXYZ")
    ls.new(tex.outputs["Normal"], xyz.inputs[0])
    ramp = ns.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = rgba("263149")
    ramp.color_ramp.elements[1].position = .6
    ramp.color_ramp.elements[1].color = rgba("030611")
    ls.new(xyz.outputs["Z"], ramp.inputs[0])
    vor = ns.new("ShaderNodeTexVoronoi")
    vor.feature = "F1"
    vor.inputs["Scale"].default_value = 155
    ls.new(tex.outputs["Normal"], vor.inputs["Vector"])
    stars = ns.new("ShaderNodeValToRGB")
    stars.color_ramp.elements[0].position = .008
    stars.color_ramp.elements[0].color = (8, 8.5, 10, 1)
    stars.color_ramp.elements[1].position = .033
    stars.color_ramp.elements[1].color = (0, 0, 0, 1)
    ls.new(vor.outputs["Distance"], stars.inputs[0])
    add = ns.new("ShaderNodeMixRGB")
    add.blend_type = "ADD"
    add.inputs[0].default_value = 1.0
    ls.new(ramp.outputs["Color"], add.inputs[1])
    ls.new(stars.outputs["Color"], add.inputs[2])
    ls.new(add.outputs[0], bg.inputs["Color"])
    ls.new(bg.outputs[0], out.inputs[0])
    if CFG["show_moon"]:
        ma = principled("Fictional distant moon", "708098", .08, .95)
        ns, ls = ma.node_tree.nodes, ma.node_tree.links
        bs = ns.get("Principled BSDF")
        tex = ns.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = 7
        tex.inputs["Detail"].default_value = 5
        ra = ns.new("ShaderNodeValToRGB")
        ra.color_ramp.elements[0].color = rgba("1B233A")
        ra.color_ramp.elements[1].color = rgba("8792A5")
        ls.new(tex.outputs["Fac"], ra.inputs[0])
        ls.new(ra.outputs[0], bs.inputs["Base Color"])
        bu = ns.new("ShaderNodeBump")
        bu.inputs["Strength"].default_value = .38
        bu.inputs["Distance"].default_value = .3
        ls.new(tex.outputs["Fac"], bu.inputs["Height"])
        ls.new(bu.outputs["Normal"], bs.inputs["Normal"])
        sphere("Fictional companion moon", (-118, 267, 48), 34, ma, detail=48)
    st = emissive("Polaris cinematic beacon", "E4E3FF", 12)
    sphere("Distant navigation star (artistic)", (4, 325, 37), .30, st, detail=10)


def make_light(name, kind, loc, energy, color, size=3.0, target=(0, 0, 1), parent=None):
    data = bpy.data.lights.new(PREFIX + name, kind)
    data.energy = energy
    data.color = rgba(color)[:3]
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    elif kind == "SUN":
        data.angle = math.radians(7)
    elif kind == "SPOT":
        data.spot_size = math.radians(size)
        data.spot_blend = .65
        data.shadow_soft_size = .08
    ob = obj_new(name, data, "Lighting", parent)
    ob.location = loc
    ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return ob


def build_lighting():
    make_light("Polar stellar rim", "SUN", (-9, 12, 16), 2.2, "D0D7ED")
    make_light("Soft ceramic key", "AREA", (0, -5, 8), 1350, "DEE5F5", 8)
    make_light("Quiet violet rim", "AREA", (-4, 6, 6), 1550, "A399CF", 7)
    make_light("Logo legibility fill", "AREA", (5, -7, 3.8), 550, "C0D0E1", 5)


def octagon(length, width, z, corner):
    x, y, c = length/2, width/2, corner
    return [(-x+c, -y, z), (x-c, -y, z), (x, -y+c, z), (x, y-c, z),
            (x-c, y, z), (-x+c, y, z), (-x, y-c, z), (-x, -y+c, z)]


def hull(name, rings, mat, parent, bevel=.035):
    v = [pt for ring in rings for pt in ring]
    f = [tuple(reversed(range(8))), tuple(range(len(v)-8, len(v)))]
    for j in range(len(rings)-1):
        for i in range(8):
            f.append((j*8+i, j*8+(i+1)%8, (j+1)*8+(i+1)%8, (j+1)*8+i))
    return mesh_obj(name, v, f, mat, parent=parent, bevel=bevel)


def batch_boxes(name, records, mat, parent):
    verts, faces = [], []
    for center, dims, basis in records:
        k = len(verts)
        verts.extend(tuple(Vector(center) + basis @ Vector(v)) for v in box_geometry(dims))
        faces.extend(tuple(k+i for i in face) for face in BOX_FACES)
    return mesh_obj(name, verts, faces, mat, parent=parent, bevel=0)


def wheel_band(name, outer, inner, width, mat, parent):
    n = 64
    verts = []
    for y, r in [(-width/2, outer), (width/2, outer),
                 (-width/2, inner), (width/2, inner)]:
        verts.extend((r*math.cos(math.tau*i/n), y, r*math.sin(math.tau*i/n))
                     for i in range(n))
    faces = []
    for i in range(n):
        j = (i+1)%n
        faces.extend(((i, n+i, n+j, j),
                      (2*n+i, 2*n+j, 3*n+j, 3*n+i),
                      (i, j, 2*n+j, 2*n+i),
                      (n+i, 3*n+i, 3*n+j, n+j)))
    return smooth_mesh(mesh_obj(name, verts, faces, mat, parent=parent))


def build_wheel(parent, tag):
    m = MATERIALS
    wheel_band("Airless outer belt " + tag, .645, .565, .39, m["rubber"], parent)
    for side in (-1, 1):
        torus("Titanium belt hoop " + tag, (0, side*.205, 0), .594, .028,
              m["metal"], parent, (math.pi/2, 0, 0))
        torus("Inner support hoop " + tag, (0, side*.18, 0), .355, .026,
              m["dark_metal"], parent, (math.pi/2, 0, 0))
        cylinder("Wheel center " + tag, (0, side*.20, 0), .205, .10,
                 m["graphite"], parent, (math.pi/2, 0, 0))
        cylinder("Axle cap " + tag, (0, side*.259, 0), .115, .025,
                 m["metal"], parent, (math.pi/2, 0, 0))
    spokes, treads = [], []
    for i in range(24):
        a = math.tau*i/24
        radial = Vector((math.cos(a), 0, math.sin(a)))
        tangent = Vector((-math.sin(a), 0, math.cos(a)))
        axial = Vector((0, 1, 0))
        basis = Matrix((radial, axial, tangent)).transposed()
        spokes.append((radial*.397, (.39, .31, .024), basis))
    for i in range(32):
        a = math.tau*i/32
        radial = Vector((math.cos(a), 0, math.sin(a)))
        tangent = Vector((-math.sin(a), 0, math.cos(a)))
        axial = Vector((0, 1, 0))
        for side in (-1, 1):
            angle = side*.24
            t = tangent*math.cos(angle) + axial*math.sin(angle)
            w = -tangent*math.sin(angle) + axial*math.cos(angle)
            basis = Matrix((t, w, -radial)).transposed()
            # Max radial face .68. Contact includes a tiny corner tolerance.
            treads.append((radial*.6625 + axial*side*.093,
                           (.068, .203, .035), basis))
    batch_boxes("Compliant lattice " + tag, spokes, m["dark_metal"], parent)
    batch_boxes("Chevron traction shoes " + tag, treads, m["metal"], parent)


def build_fender(carrier, tag):
    n = 24
    verts, faces = [], []
    for y in (-.265, .265):
        for i in range(n+1):
            a = lerp(math.radians(22), math.radians(158), i/n)
            verts.append((.775*math.cos(a), y, .775*math.sin(a)))
    for i in range(n):
        faces.append((i, n+1+i, n+2+i, i+1))
    ob = mesh_obj("Carbon wheel guard " + tag, verts, faces, MATERIALS["graphite"], parent=carrier)
    sol = ob.modifiers.new("Guard thickness", "SOLIDIFY")
    sol.thickness = .035
    return ob


def star_mark(name, loc, size, mat, group, parent=None, rot=None):
    p = [(0, size), (.13*size, .18*size), (.65*size, 0),
         (.13*size, -.18*size), (0, -size), (-.13*size, -.18*size),
         (-.65*size, 0), (-.13*size, .18*size)]
    verts = [(0, 0, 0)] + [(x, y, 0) for x, y in p]
    faces = [(0, 1+(i+1)%8, 1+i) for i in range(8)]
    ob = mesh_obj(name, verts, faces, mat, group, parent)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    return ob


def build_rover():
    m = MATERIALS
    root = empty("Rover chassis — baked terrain pose")
    hull("Structural keel", [octagon(3.88, 1.58, 1.05, .22),
         octagon(4.28, 1.85, 1.36, .28)], m["graphite"], root)
    hull("Continuous ceramic shell", [octagon(4.06, 1.78, 1.30, .20),
         octagon(4.46, 1.98, 1.65, .31), octagon(4.02, 1.68, 2.02, .31)],
         m["ceramic"], root, .055)
    hull("Dark roof insert", [octagon(2.94, 1.36, 2.015, .18),
         octagon(2.80, 1.30, 2.075, .18)], m["graphite"], root, .018)
    for side in (-1, 1):
        box("Recessed side badge", (0, side*.984, 1.705), (2.58, .10, .37),
            m["graphite"], .025, root)
        # Readable on BOTH sides: rotations have outward normals, not mirrored text.
        rot = (math.pi/2, 0, 0) if side < 0 else (math.pi/2, 0, math.pi)
        # Keep the descender of "p" clear of the separate serial-number line.
        text("piora body badge", CFG["brand"], (.04, side*1.037, 1.766), .35,
             m["lettering"], root, rot=rot)
        star_mark("Navigation badge", (.97*side, side*1.038, 1.717),
                  .105, m["violet"], "Rover", root, rot)
        box("Status strip housing", (.25, side*.982, 1.491), (1.76, .118, .056),
            m["graphite"], .012, root)
        box("Quiet side status strip", (.25, side*1.043, 1.494), (1.65, .012, .015),
            m["violet"], .004, root)
        text("Vehicle serial", "PX-06 / AUTONOMOUS EXPLORER", (0, side*1.037, 1.550),
             .055, m["small_print"], root, rot=rot, tracking=1.1)
    # Low, unmanned forward sensor fascia — no cockpit, no humanoid face.
    box("Front sensor fascia", (2.17, 0, 1.62), (.09, 1.36, .27), m["graphite"], .035, root)
    for side in (-1, 1):
        box("Headlight strip", (2.222, side*.45, 1.659), (.012, .35, .042),
            m["headlamp"], .008, root)
        cylinder("Forward proximity optic", (2.229, side*.16, 1.607), .056, .035,
                 m["lens"], root, (0, math.pi/2, 0))
        rod("Front tow bracket", (1.86, side*.64, 1.21), (2.18, side*.64, 1.24),
            .055, m["metal"], root)
        torus("Recovery eye", (2.21, side*.64, 1.25), .067, .018,
              m["metal"], root, (0, math.pi/2, 0))
        make_light("Terrain headlamp", "SPOT", (2.24, side*.46, 1.65), 35,
                   "D7E3EF", 42, (6.5, side*.5, .05), root)
    # Roof power/thermal tiles, separated panel seams and recessed fasteners.
    box("Photovoltaic substrate", (-.60, 0, 2.10), (1.55, 1.11, .05), m["dark_metal"], .025, root)
    for i in range(5):
        for j in range(4):
            box("Energy collection tile", (-1.2+i*.299, -.40+j*.265, 2.135),
                (.275, .235, .024), m["glass"], .006, root)
    box("Thermal management pod", (-1.69, 0, 2.0), (.49, 1.22, .23),
        m["ceramic_dark"], .065, root)
    for i in range(9):
        box("Radiator fin", (-1.76+i*.023, 0, 2.137), (.012, .93, .08),
            m["dark_metal"], .003, root)
    for x in (-1.44, 1.37):
        for y in (-.63, .63):
            cylinder("Flush roof fastener", (x, y, 2.075), .032, .014,
                     m["metal"], root, segments=12)
    # Multi-modal perception head on a compact articulated mast.
    cylinder("Mast footing", (.83, 0, 2.105), .23, .095, m["metal"], root)
    rod("Mast spar", (.82, 0, 2.15), (.91, 0, 2.76), .087, m["graphite"], root)
    rod("Mast cable conduit", (.73, .075, 2.17), (.83, .075, 2.74), .023,
        m["dark_metal"], root)
    sensor = empty("Perception head yaw", root)
    sensor.location = (.91, 0, 2.76)
    box("Perception head", (0, 0, .08), (.66, .78, .27), m["ceramic"], .078, sensor)
    box("Optical rail", (.326, 0, .083), (.035, .61, .155), m["graphite"], .035, sensor)
    for y, radius in [(-.21, .060), (0, .082), (.21, .060)]:
        cylinder("Multi spectral lens rim", (.36, y, .083), radius, .033,
                 m["metal"], sensor, (0, math.pi/2, 0))
        cylinder("Multi spectral glass", (.381, y, .083), radius*.81, .014,
                 m["lens"], sensor, (0, math.pi/2, 0))
    cylinder("Lidar wafer", (0, 0, .237), .15, .066, m["graphite"], sensor)
    cylinder("Lidar optical edge", (0, 0, .24), .153, .014, m["violet"], sensor)
    # Flat-panel comms instead of a retro dish.
    rod("Antenna support", (-1.28, .50, 2.10), (-1.32, .50, 2.55), .022, m["metal"], root)
    box("Phased array antenna", (-1.32, .5, 2.57), (.42, .07, .28),
        m["ceramic_dark"], .035, root, rot=(0, -.20, 0))
    for z in (2.50, 2.56, 2.62):
        box("Antenna slots", (-1.32, .46, z), (.30, .005, .012),
            m["graphite"], .002, root)
    # Folded sampling manipulator, kept off the hero side so the logo stays clear.
    for j, (a, b) in enumerate([
            ((.95, .9, 1.5), (.25, 1.05, 1.34)),
            ((.25, 1.05, 1.34), (1.18, 1.09, 1.22))]):
        rod("Stowed sample arm %d" % j, a, b, .064, m["metal"], root)
        cylinder("Sample arm joint", a, .104, .12, m["graphite"], root, (math.pi/2, 0, 0))
    box("Sample tool cassette", (1.24, 1.09, 1.22), (.28, .16, .14), m["graphite"], .028, root)
    wheels = []
    for x in WHEEL_X:
        for y in WHEEL_Y:
            tag = "%+.2f_%+.2f" % (x, y)
            carrier = empty("Suspension carrier " + tag, root)
            carrier.location = (x, y, WHEEL_RADIUS)
            carrier.rotation_mode = "QUATERNION"
            spin = empty("Wheel roll " + tag, carrier)
            build_wheel(spin, tag)
            build_fender(carrier, tag)
            arms = []
            for dx in (-.36, .36):
                anchor = Vector((x+dx, y*.63, 1.17))
                arm = rod("Articulated wishbone " + tag, anchor, carrier.location,
                          .052, m["dark_metal"], root)
                arms.append((arm, anchor, "arm"))
            anchor = Vector((x-.24, y*.64, 1.44))
            outer = rod("Suspension damper barrel " + tag, anchor, carrier.location,
                        .067, m["ceramic_dark"], root)
            piston = rod("Suspension damper piston " + tag, anchor, carrier.location,
                         .030, m["metal"], root)
            arms.extend(((outer, anchor, "barrel"), (piston, anchor, "piston")))
            wheels.append({"x": x, "y": y, "carrier": carrier, "spin": spin,
                           "arms": arms, "angle": 0.0, "last_center": None})
    return root, sensor, wheels


def build_camera():
    data = bpy.data.cameras.new(PREFIX + "Cinematic camera")
    cam = obj_new("Cinematic camera", data, "Cameras")
    data.sensor_width = 36
    data.sensor_fit = "HORIZONTAL"
    data.clip_start, data.clip_end = .08, 1500
    data.dof.use_dof = True
    data.dof.aperture_fstop = 7.1  # Preserve the side logo and landscape together.
    data.dof.aperture_blades = 7
    focus = empty("Camera focus", group="Cameras")
    data.dof.focus_object = focus
    SCENE.camera = cam
    return cam, focus


def key_transform(ob, f, scale=False):
    ob.keyframe_insert("location", frame=f)
    ob.keyframe_insert("rotation_quaternion" if ob.rotation_mode == "QUATERNION"
                       else "rotation_euler", frame=f)
    if scale:
        ob.keyframe_insert("scale", frame=f)


def bake_motion(root, sensor, wheels, cam, focus):
    for f in range(1, SCENE.frame_end + 1):
        u = (f-1)/(SCENE.frame_end-1)
        x = drive_x(u)
        hs = [surface_height(x+w["x"], w["y"]) for w in wheels]
        avg = sum(hs)/len(hs)
        front = sum(h for h, w in zip(hs, wheels) if w["x"] > 1)/2
        back = sum(h for h, w in zip(hs, wheels) if w["x"] < -1)/2
        left = sum(h for h, w in zip(hs, wheels) if w["y"] < 0)/3
        right = sum(h for h, w in zip(hs, wheels) if w["y"] > 0)/3
        root.location = (x, 0, avg)
        root.rotation_euler = (math.atan2(right-left, 2.44),
                               -math.atan2(front-back, 3.10), 0)
        key_transform(root, f)
        inv = root.rotation_euler.to_matrix().transposed()
        qinv = root.rotation_euler.to_quaternion().conjugated()
        for w, h in zip(wheels, hs):
            center = Vector((x+w["x"], w["y"], h+WHEEL_RADIUS))
            local = inv @ (center - root.location)
            w["carrier"].location = local
            w["carrier"].rotation_quaternion = qinv
            key_transform(w["carrier"], f)
            if w["last_center"] is not None:
                w["angle"] += (center-w["last_center"]).length/WHEEL_RADIUS
            w["last_center"] = center.copy()
            w["spin"].rotation_euler.y = w["angle"]
            w["spin"].keyframe_insert("rotation_euler", frame=f)
            for arm, anchor, kind in w["arms"]:
                if kind == "barrel":
                    a, b = anchor, anchor.lerp(local, .58)
                elif kind == "piston":
                    a, b = anchor.lerp(local, .47), local
                else:
                    a, b = anchor, local
                update_rod(arm, a, b)
                key_transform(arm, f, scale=True)
        scan = smooth((u-.56)/.19)
        sensor.rotation_euler.z = lerp(-.12, .24, scan)
        sensor.rotation_euler.y = -.035 * math.sin(scan*math.pi)
        sensor.keyframe_insert("rotation_euler", frame=f)
        offset, aim, lens = camera_pose(u)
        cam.location = (x+offset[0], offset[1], avg+offset[2])
        target = Vector((x+aim[0], aim[1], avg+aim[2]))
        cam.rotation_euler = (target-cam.location).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        key_transform(cam, f)
        cam.data.keyframe_insert("lens", frame=f)
        focus.location = (x+.15, -.35, avg+1.65)
        focus.keyframe_insert("location", frame=f)


def scale_visibility(ob, on, off=None, scale=(1, 1, 1)):
    ob.scale = (0, 0, 0)
    ob.keyframe_insert("scale", frame=1)
    if on > 1:
        ob.keyframe_insert("scale", frame=on-1)
    ob.scale = scale
    ob.keyframe_insert("scale", frame=on)
    if off is not None:
        ob.keyframe_insert("scale", frame=off-1)
        ob.scale = (0, 0, 0)
        ob.keyframe_insert("scale", frame=off)


def build_tracks():
    samples = [drive_x((f-1)/(SCENE.frame_end-1)) for f in range(1, SCENE.frame_end+1)]
    # Visible marks trail the REAR wheel, never appear in front of the vehicle.
    start, end = START_X-4.5, END_X-1.55
    count = int((end-start)/.17)
    for j in range(count+1):
        x = lerp(start, end, j/count)
        on = 1 if x <= START_X-1.55 else 1+bisect.bisect_left(samples, x+1.55)
        on = min(on, SCENE.frame_end)
        for y in WHEEL_Y:
            verts, faces = [], []
            for side in (-1, 1):
                # Individual flat chevrons following all four terrain corners.
                local = [(-.052, side*.014), (.018, side*.014),
                         (.083, side*.188), (.013, side*.188)]
                k = len(verts)
                for dx, dy in local:
                    px, py = x+dx, y+dy
                    verts.append((px, py, surface_height(px, py)+.004))
                face = tuple(range(k, k+4))
                faces.append(face if side > 0 else tuple(reversed(face)))
            ob = mesh_obj("Compressed tread", verts, faces, MATERIALS["tracks"], "Effects")
            scale_visibility(ob, on)


def dust_material(i):
    ma = bpy.data.materials.new(PREFIX + "Local dust %02d" % i)
    ma.use_nodes = True
    ns, ls = ma.node_tree.nodes, ma.node_tree.links
    ns.clear()
    out = ns.new("ShaderNodeOutputMaterial")
    vol = ns.new("ShaderNodeVolumeScatter")
    vol.inputs["Color"].default_value = rgba("798492")
    vol.inputs["Anisotropy"].default_value = .18
    tex = ns.new("ShaderNodeTexCoord")
    dist = ns.new("ShaderNodeVectorMath")
    dist.operation = "DISTANCE"
    dist.inputs[1].default_value = (.5, .5, .5)
    ls.new(tex.outputs["Generated"], dist.inputs[0])
    ramp = ns.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = .1
    ramp.inputs["From Max"].default_value = .5
    ramp.inputs["To Min"].default_value = 1.0
    ramp.inputs["To Max"].default_value = 0.0
    ramp.clamp = True
    ls.new(dist.outputs["Value"], ramp.inputs["Value"])
    noise = ns.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 6
    ls.new(tex.outputs["Generated"], noise.inputs["Vector"])
    mul = ns.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    ls.new(ramp.outputs["Result"], mul.inputs[0])
    ls.new(noise.outputs["Fac"], mul.inputs[1])
    density = ns.new("ShaderNodeValue")
    density.name = "Density envelope"
    gain = ns.new("ShaderNodeMath")
    gain.operation = "MULTIPLY"
    ls.new(mul.outputs[0], gain.inputs[0])
    ls.new(density.outputs[0], gain.inputs[1])
    ls.new(gain.outputs[0], vol.inputs["Density"])
    ls.new(vol.outputs[0], out.inputs["Volume"])
    return ma, density.outputs[0]


def build_dust():
    n = 14 if CFG["quality"] == "PREVIEW" else 26
    for i in range(n):
        u = lerp(.15, .65, i/max(1, n-1))
        birth = F(u)
        life = max(8, round(SCENE.frame_end*.17))
        side = -1 if i % 2 else 1
        x, y = drive_x(u)-1.8, side*1.22
        z = surface_height(x, y)+.12
        ma, density = dust_material(i)
        ob = sphere("Fine displaced powder", (x, y, z), .001, ma, "Effects", detail=10)
        ob.scale = (.001,)*3
        ob.keyframe_insert("scale", frame=1)
        ob.keyframe_insert("scale", frame=max(1, birth-1))
        animate_value(density, [(1, 0), (max(1, birth-1), 0)])
        for j in range(9):
            q = j/8
            frame = min(SCENE.frame_end, birth+round(q*life))
            size = lerp(.08, .62, q)
            ob.location = (x-.7*q, y+side*.21*q, z+.44*q-.15*q*q)
            ob.scale = (size*1.4, size*.72, size*.7)
            key_transform(ob, frame, scale=True)
            animate_value(density, [(frame, 1.7*math.sin(math.pi*q)**1.5)])
        death = min(SCENE.frame_end, birth+life+1)
        ob.scale = (.001,)*3
        ob.keyframe_insert("scale", frame=death)
        animate_value(density, [(death, 0)])
    grain = principled("Ballistic ice grains", "8D9AA8", .18, .75)
    for i in range(32):
        u = RNG.uniform(.16, .63)
        birth, life = F(u), max(8, round(.11*SCENE.frame_end))
        side = RNG.choice((-1, 1))
        start = Vector((drive_x(u)-1.9, side*1.22, 0))
        start.z = surface_height(start.x, start.y)+.10
        ob = sphere("Ballistic grain", start, .001, grain, "Effects", detail=4)
        ob.scale = (.00001,)*3
        ob.keyframe_insert("scale", frame=1)
        ob.keyframe_insert("scale", frame=max(1, birth-1))
        r = RNG.uniform(.008, .02)
        for j in range(9):
            q = j/8
            f = min(SCENE.frame_end, birth+round(q*life))
            ob.location = start+Vector((-.52*q, side*.18*q, .7*q*(1-q)))
            ob.scale = (r*math.sin(math.pi*q),)*3
            ob.keyframe_insert("location", frame=f)
            ob.keyframe_insert("scale", frame=f)


def build_scan():
    mat = emissive("Surface survey arc", "A6A0DD", 1.8, fade=True)
    a, b = F(.60), F(.81)
    animate_value(mat.node_tree.nodes["Visibility"].outputs[0],
                  [(1, 0), (a, 0), (F(.66), .40), (F(.76), .28), (b, 0)])
    ob = curve_line("Ground conforming survey arc", [(0, 0, 0)]*49,
                    mat, .006, group="Effects")
    pts = ob.data.splines[0].points
    # Baked curve coordinates: the arc hugs the actual triangular ground mesh.
    for f in range(a, b+1):
        q = (f-a)/max(1, b-a)
        radius = lerp(.6, 3.7, q)
        cx = drive_x(.60)+2.0
        for i, p in enumerate(pts):
            ang = lerp(-.8, .8, i/(len(pts)-1))
            x, y = cx+radius*math.cos(ang), radius*math.sin(ang)
            p.co = (x, y, surface_height(x, y)+.028, 1)
            p.keyframe_insert("co", frame=f)


def configure_scene(scene, hud=False):
    engine_id = "BLENDER_EEVEE_NEXT" if CFG["engine"] == "EEVEE" or hud else "CYCLES"
    try:
        scene.render.engine = engine_id
    except (TypeError, ValueError):
        if engine_id == "BLENDER_EEVEE_NEXT":
            scene.render.engine = "BLENDER_EEVEE"
        else:
            raise
    scene.render.resolution_x, scene.render.resolution_y = CFG["resolution"]
    scene.render.resolution_percentage = 50 if CFG["quality"] == "PREVIEW" else 100
    scene.render.fps = CFG["fps"]
    scene.frame_start = 1
    scene.frame_end = max(2, round(CFG["duration"] * CFG["fps"]))
    scene.render.film_transparent = hud
    scene.render.image_settings.color_mode = "RGBA" if hud else "RGB"
    scene.render.use_file_extension = True
    if hasattr(scene.render, "use_motion_blur"):
        scene.render.use_motion_blur = CFG["motion_blur"] and not hud
        scene.render.motion_blur_shutter = .28
    eevee = getattr(scene, "eevee", None)
    if eevee and hasattr(eevee, "taa_render_samples"):
        eevee.taa_render_samples = 48 if CFG["quality"] == "PREVIEW" else 128
    if eevee and hasattr(eevee, "volumetric_samples"):
        eevee.volumetric_samples = 32 if CFG["quality"] == "PREVIEW" else 64
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 40 if CFG["quality"] == "PREVIEW" else 160
        scene.cycles.use_denoising = True
        scene.cycles.max_bounces = 6
        scene.cycles.volume_bounces = 1
        scene.cycles.device = "CPU"  # Safe unless a usable GPU is discovered.
        addon = bpy.context.preferences.addons.get("cycles")
        if addon:
            prefs = addon.preferences
            original = prefs.compute_device_type
            for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
                try:
                    prefs.compute_device_type = backend
                    prefs.get_devices()
                    devices = [d for d in prefs.devices if d.type == backend]
                    if devices:
                        for d in prefs.devices:
                            d.use = d in devices
                        scene.cycles.device = "GPU"
                        print("[Piora] Cycles GPU:", backend)
                        break
                except (TypeError, ValueError, RuntimeError):
                    continue
            else:
                prefs.compute_device_type = original
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except (TypeError, ValueError):
        pass
    scene.view_settings.exposure = .35
    scene.view_settings.gamma = 1.0
    if not hud:
        set_output(scene)


def set_output(scene):
    if CFG["output_format"] == "MP4":
        if CFG["quality"] == "PREVIEW":
            scene.render.resolution_x += (-scene.render.resolution_x) % 4
            scene.render.resolution_y += (-scene.render.resolution_y) % 4
        if hasattr(scene.render.image_settings, "media_type"):
            scene.render.image_settings.media_type = "VIDEO"
        else:
            scene.render.image_settings.file_format = "FFMPEG"
        scene.render.image_settings.color_mode = "RGB"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        scene.render.ffmpeg.ffmpeg_preset = "GOOD"
        scene.render.ffmpeg.gopsize = CFG["fps"]*2
        scene.render.ffmpeg.audio_codec = "NONE"
        scene.render.filepath = str(OUT / "piora_intro.mp4")
    else:
        (OUT / "frames").mkdir(exist_ok=True)
        if hasattr(scene.render.image_settings, "media_type"):
            scene.render.image_settings.media_type = "IMAGE"
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGB"
        scene.render.image_settings.color_depth = "8"
        scene.render.filepath = str(OUT / "frames" / "frame_")


def build_hud():
    global HUD
    HUD = bpy.data.scenes.new(PREFIX + "Brand overlay")
    col = bpy.data.collections.new(PREFIX + "Brand overlay")
    HUD.collection.children.link(col)
    COLLECTIONS["HUD"] = col
    configure_scene(HUD, hud=True)
    HUD.render.resolution_x = SCENE.render.resolution_x
    HUD.render.resolution_y = SCENE.render.resolution_y
    world = bpy.data.worlds.new(PREFIX + "Overlay world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0
    HUD.world = world
    data = bpy.data.cameras.new(PREFIX + "Overlay orthographic")
    data.type = "ORTHO"
    data.ortho_scale = 16.0
    camera = obj_new("Overlay camera", data, "HUD")
    camera.location = (0, 0, 10)
    HUD.camera = camera  # Default camera -Z points directly at the XY typography.
    white = emissive("Brand title", "EEF0F8", 1.8, fade=True)
    subtitle = emissive("Brand subtitle", "BDC3D4", 1.4, fade=True)
    violet = emissive("Brand navigation star", "A396D6", 1.65, fade=True)
    for ma, start, finish in ((white, .78, .92), (violet, .76, .90),
                             (subtitle, .84, .98)):
        animate_value(ma.node_tree.nodes["Visibility"].outputs[0],
                      [(1, 0), (F(start), 0), (F(finish), 1)])
    title = text("Closing brand", CFG["brand"], (0, .12, 0), 1.42,
                 white, group="HUD", tracking=1.04)
    star_mark("Closing north star", (0, 1.80, 0), .34, violet, "HUD")
    sub = text("Closing promise", CFG["subtitle"], (0, -.91, 0), .227,
               subtitle, group="HUD", tracking=1.02)
    # The wording is editable. Fit long custom names instead of clipping them.
    bpy.context.view_layer.update()
    if title.dimensions.x > 10:
        title.scale *= 10/title.dimensions.x
    if sub.dimensions.x > 12.5:
        sub.scale *= 12.5/sub.dimensions.x
    if CFG["show_metadata"]:
        meta = emissive("Expedition metadata", "B2BDCF", 1.2, fade=True)
        animate_value(meta.node_tree.nodes["Visibility"].outputs[0],
                      [(1, 0), (F(.10), .76), (F(.64), .76), (F(.75), 0)])
        aspect = CFG["resolution"][0]/CFG["resolution"][1]
        half_h = 8/aspect
        text("Mission annotation", "POLARIS EXPEDITION  /  " + str(CFG["year"]),
             (-7.05, -half_h+.62, 0), .15, meta, group="HUD", align="LEFT", tracking=1.15)
        text("Mission phase", "AUTONOMOUS EXPLORATION", (7.05, -half_h+.62, 0),
             .125, meta, group="HUD", align="RIGHT", tracking=1.12)
    return HUD


def build_compositor():
    # Blender 5 moved scene compositor trees into compositing_node_group.
    if bpy.app.version >= (5, 0, 0):
        tree = bpy.data.node_groups.new(PREFIX + "Film composite", "CompositorNodeTree")
        tree.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        SCENE.compositing_node_group = tree
        output = tree.nodes.new("NodeGroupOutput")
    else:
        SCENE.use_nodes = True
        tree = SCENE.node_tree
        tree.nodes.clear()
        output = tree.nodes.new("CompositorNodeComposite")
    SCENE.render.use_compositing = True
    ns, ls = tree.nodes, tree.links
    beauty = ns.new("CompositorNodeRLayers")
    beauty.scene = SCENE
    beauty.location = (-620, 100)
    glow = ns.new("CompositorNodeGlare")
    if glow.inputs.get("Type") is not None:
        set_input(glow, "Type", "Fog Glow")
        set_input(glow, "Quality", "High")
    else:
        glow.glare_type = "FOG_GLOW"
        glow.quality = "HIGH"
    if not set_input(glow, "Threshold", 1.6) and hasattr(glow, "threshold"):
        glow.threshold = 1.6
    if not set_input(glow, "Strength", .22) and hasattr(glow, "mix"):
        glow.mix = -.78
    if not set_input(glow, "Size", .27) and hasattr(glow, "size"):
        glow.size = 7
    glow.location = (-380, 100)
    ls.new(beauty.outputs["Image"], glow.inputs["Image"])
    fade = ns.new("ShaderNodeMixRGB" if bpy.app.version >= (5, 2, 0) else "CompositorNodeMixRGB")
    fade.blend_type = "MIX"
    fade.inputs[1].default_value = rgba(PALETTE["background"])
    ls.new(glow.outputs["Image"], fade.inputs[2])
    visibility = ns.new("ShaderNodeValue" if bpy.app.version >= (5, 2, 0) else "CompositorNodeValue")
    visibility.label = "Scene fade — holds the final brand frame"
    animate_value(visibility.outputs[0], [(1, .015), (F(.075), 1),
                  (F(.735), 1), (F(.94), .035), (SCENE.frame_end, .035)])
    ls.new(visibility.outputs[0], fade.inputs[0])
    overlay = ns.new("CompositorNodeRLayers")
    overlay.scene = HUD
    overlay.location = (-150, -150)
    over = ns.new("CompositorNodeAlphaOver")
    if over.inputs.get("Background") is not None:
        over.inputs["Factor"].default_value = 1
        ls.new(fade.outputs[0], over.inputs["Background"])
        ls.new(overlay.outputs["Image"], over.inputs["Foreground"])
    else:
        over.inputs[0].default_value = 1
        ls.new(fade.outputs[0], over.inputs[1])
        ls.new(overlay.outputs["Image"], over.inputs[2])
    ls.new(over.outputs["Image"], output.inputs["Image"])
    fade.location = (-100, 100)
    over.location, output.location = (160, 100), (380, 100)


def linearize_actions():
    """Supports legacy and layered actions. No interpolation overshoot in bakes."""
    ids = list(SCENE.objects) + list(HUD.objects)
    ids += [o.data for o in ids if o.data is not None]
    ids += [m.node_tree for m in bpy.data.materials
            if m.name.startswith(PREFIX) and m.use_nodes]
    ids += [SCENE.compositing_node_group if bpy.app.version >= (5, 0, 0) else SCENE.node_tree]
    seen = set()
    for owner in ids:
        ad = getattr(owner, "animation_data", None)
        action = ad.action if ad else None
        if action is None or action.as_pointer() in seen:
            continue
        seen.add(action.as_pointer())
        curves = []
        # 4.4+ uses slotted actions; prefer channelbags rather than action.fcurves.
        for layer in getattr(action, "layers", []):
            for strip in getattr(layer, "strips", []):
                bags = getattr(strip, "channelbags", [])
                for bag in bags:
                    curves.extend(list(bag.fcurves))
        if not curves:
            try:
                curves = list(action.fcurves)
            except AttributeError:
                pass
        for fc in curves:
            for key in fc.keyframe_points:
                key.interpolation = "LINEAR"


def setup_workspace():
    if bpy.context.window:
        bpy.context.window.scene = SCENE
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                space.region_3d.view_perspective = "CAMERA"
                space.overlay.show_overlays = False
                space.shading.type = "MATERIAL"
    for name, u in [("01 / ARRIVAL", .02), ("02 / PIORA BADGE", .45),
                    ("03 / SURVEY", .67), ("04 / BRAND", .93)]:
        SCENE.timeline_markers.new(name, frame=F(u))
    SCENE.frame_set(F(.49))
    HUD.frame_set(F(.49))


def get_config():
    cfg = dict(CONFIG)
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--")+1:]
        p = argparse.ArgumentParser(description="Generate the Piora startup animation")
        p.add_argument("--mode", choices=["BUILD", "FRAME", "ANIMATION"])
        p.add_argument("--quality", choices=["PREVIEW", "FINAL"])
        p.add_argument("--engine", choices=["EEVEE", "CYCLES"])
        p.add_argument("--format", choices=["MP4", "PNG_SEQUENCE"])
        p.add_argument("--out")
        p.add_argument("--seconds", type=float)
        opts = p.parse_args(args)
        for src, dst in (("mode", "render_mode"), ("quality", "quality"),
                         ("engine", "engine"), ("format", "output_format"),
                         ("out", "output_dir"), ("seconds", "duration")):
            value = getattr(opts, src)
            if value is not None:
                cfg[dst] = value
    for key, allowed in (("quality", {"PREVIEW", "FINAL"}),
                         ("engine", {"EEVEE", "CYCLES"}),
                         ("render_mode", {"BUILD", "FRAME", "ANIMATION"}),
                         ("output_format", {"MP4", "PNG_SEQUENCE"})):
        cfg[key] = str(cfg[key]).upper()
        if cfg[key] not in allowed:
            raise ValueError("Invalid %s: %r" % (key, cfg[key]))
    if not (2 <= cfg["duration"] <= 60):
        raise ValueError("duration 必须在 2–60 秒之间。")
    if not (12 <= cfg["fps"] <= 120):
        raise ValueError("fps 必须在 12–120 之间。")
    if len(cfg["resolution"]) != 2 or min(cfg["resolution"]) < 320:
        raise ValueError("resolution 必须为有效的 (宽, 高)。")
    if cfg["resolution"][0] < cfg["resolution"][1]:
        raise ValueError("这版镜头针对横屏设计，请使用宽度 >= 高度的分辨率。")
    if cfg["output_format"] == "MP4" and any(n % 2 for n in cfg["resolution"]):
        raise ValueError("H.264 MP4 的宽高请使用偶数。")
    if not str(cfg["brand"]).strip():
        raise ValueError("brand 不能为空。")
    return cfg


def main():
    global CFG, RNG, SCENE, OUT
    if bpy is None:
        raise RuntimeError("此文件必须在 Blender 中运行，不能用普通 Python 生成场景。")
    if bpy.app.version < (4, 5, 0):
        raise RuntimeError("本脚本以 Blender 4.5 LTS 为基线，请使用 4.5 或更新版本。")
    CFG = get_config()
    RNG = random.Random(CFG["seed"])
    base = Path(CFG["output_dir"]).expanduser() if CFG["output_dir"] else Path.home()/"Piora_Animation"
    OUT = base / datetime.now().strftime("run_%Y%m%d_%H%M%S_%f")
    OUT.mkdir(parents=True, exist_ok=False)
    MESH_CACHE.clear()
    MATERIALS.clear()
    COLLECTIONS.clear()
    SCENE = bpy.data.scenes.new(PREFIX + "Polaris expedition 2076")
    if bpy.context.window:
        bpy.context.window.scene = SCENE
    for name in ("Rover", "Environment", "Lighting", "Cameras", "Effects"):
        col = bpy.data.collections.new(PREFIX + name)
        SCENE.collection.children.link(col)
        COLLECTIONS[name] = col
    configure_scene(SCENE)
    print("[Piora] Building procedural materials and ice world...")
    build_materials()
    build_terrain()
    build_world()
    build_lighting()
    print("[Piora] Building six-wheel autonomous rover...")
    root, sensor, wheels = build_rover()
    cam, focus = build_camera()
    print("[Piora] Baking ground contact, wheel rotation and camera...")
    bake_motion(root, sensor, wheels, cam, focus)
    if CFG["tracks"]:
        build_tracks()
    if CFG["dust"]:
        build_dust()
    if CFG["scan_effect"]:
        build_scan()
    build_hud()
    build_compositor()
    linearize_actions()
    setup_workspace()
    (OUT / "render_config.json").write_text(json.dumps(CFG, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        source = Path(__file__)
        if source.is_file():
            block = bpy.data.texts.new("piora_intro_source.py")
            block.write(source.read_text(encoding="utf-8"))
    except (NameError, OSError):
        pass
    if CFG["save_blend"]:
        # copy=True does not overwrite/switch the user's original .blend filepath.
        bpy.ops.wm.save_as_mainfile(filepath=str(OUT / "piora_polaris_2076.blend"), copy=True, compress=True)
    print("[Piora] Scene:", SCENE.name)
    print("[Piora] Output:", OUT)
    print("[Piora] The current frame is the side-logo hero view. F12 previews it.")
    if CFG["render_mode"] == "FRAME":
        old_format, old_path = SCENE.render.image_settings.file_format, SCENE.render.filepath
        old_media = getattr(SCENE.render.image_settings, "media_type", None)
        if old_media is not None:
            SCENE.render.image_settings.media_type = "IMAGE"
        SCENE.render.image_settings.file_format = "PNG"
        SCENE.render.filepath = str(OUT / "piora_preview.png")
        try:
            bpy.ops.render.render(write_still=True, scene=SCENE.name)
        finally:
            if old_media is not None:
                SCENE.render.image_settings.media_type = old_media
            if old_media != "VIDEO":
                SCENE.render.image_settings.file_format = old_format
            SCENE.render.filepath = old_path
    elif CFG["render_mode"] == "ANIMATION":
        bpy.ops.render.render(animation=True, scene=SCENE.name)
    print("[Piora] Done. Existing scenes were preserved.")


if __name__ == "__main__":
    main()
