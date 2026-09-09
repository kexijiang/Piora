"""Prepare the locally downloaded Blendkit Jinx for Piora (Blender 5.2).

Run with --background --factory-startup --disable-autoexec --python this_file.
Source asset is intentionally local; see docs/jinx-3d-companion.md for attribution.
"""
import bpy
import json
import math
from pathlib import Path
from mathutils import Euler, Vector, Quaternion

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'local-pets/jinx-3d'
bpy.ops.wm.open_mainfile(filepath=str(OUTPUT / 'source/jinx-anime-1k.blend'), load_ui=False, use_scripts=False)
scene = bpy.context.scene
scene.frame_set(1)
rig = bpy.data.objects['Armature']
base = {b.name: (b.location.copy(), b.matrix_basis.to_quaternion(), b.scale.copy()) for b in rig.pose.bones}
world_rotations = {b.name: (rig.matrix_world @ b.matrix).to_quaternion() for b in rig.pose.bones}
rig.animation_data_clear()
rig.hide_set(False)
rig.hide_render = False

# Keep character geometry; the heavy gun is unnecessary for a desktop companion.
gun = bpy.data.objects.get('POW POW')
if gun:
    bpy.data.objects.remove(gun, do_unlink=True)
before = sum(len(o.data.polygons) for o in scene.objects if o.type == 'MESH')
for obj in list(scene.objects):
    if obj.type != 'MESH':
        continue
    obj.hide_set(False)
    if obj.data.uv_layers:
        named = {node.uv_map for mat in obj.data.materials if mat and mat.node_tree for node in mat.node_tree.nodes if node.type == 'UVMAP'}
        chosen = next((layer for layer in obj.data.uv_layers if layer.name in named), obj.data.uv_layers.active)
        for layer in list(obj.data.uv_layers):
            if layer != chosen:
                obj.data.uv_layers.remove(layer)
        chosen.name = 'UVMap'
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    count = len(obj.data.vertices)
    if count > 600:
        decimate = obj.modifiers.new('Desktop polygon budget', 'DECIMATE')
        decimate.ratio = 0.025 if obj.name == 'HAIR' else 0.4 if 'main_body' in obj.name else 0.13 if count > 2000 else 0.55
        # Simplify before skinning, so the rest mesh and its weights remain valid.
        bpy.ops.object.modifier_move_to_index(modifier=decimate.name, index=0)
        bpy.ops.object.modifier_apply(modifier=decimate.name)
    if not any(m.type == 'ARMATURE' for m in obj.modifiers):
        world = obj.matrix_world.copy()
        obj.parent = rig
        obj.parent_type = 'BONE'
        obj.parent_bone = 'mixamorig:Head'
        bpy.context.view_layer.update()
        obj.matrix_world = world

# Collapse the many clothing pieces into one skinned object to reduce scene cost.
skinned = [o for o in scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
bpy.ops.object.select_all(action='DESELECT')
for obj in skinned:
    obj.select_set(True)
bpy.context.view_layer.objects.active = next(o for o in skinned if 'main_body' in o.name)
bpy.ops.object.join()
bpy.context.object.name = 'Jinx Body'
body = bpy.context.object
decimate = body.modifiers.new('Final desktop budget', 'DECIMATE')
decimate.ratio = 0.32
bpy.ops.object.modifier_move_to_index(modifier=decimate.name, index=0)
bpy.ops.object.modifier_apply(modifier=decimate.name)

# Convert nonportable procedural metal/leather shading to explicit PBR values.
palette = {'Buckkel_Belt': (0.16, 0.12, 0.10, 1), 'Bullet Brass': (0.48, 0.26, 0.065, 1), 'HAIR': (0.008, 0.24, 0.52, 1)}
for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for node in nodes:
        if node.type == 'UVMAP':
            node.uv_map = 'UVMap'
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        continue
    for name, default in [('Roughness', 0.7), ('Metallic', 0.08), ('Specular IOR Level', 0.28)]:
        socket = bsdf.inputs.get(name)
        if socket:
            for link in list(socket.links):
                links.remove(link)
            socket.default_value = default
    if mat.name in palette:
        for link in list(bsdf.inputs['Base Color'].links):
            links.remove(link)
        bsdf.inputs['Base Color'].default_value = palette[mat.name]
    for link in list(bsdf.inputs['Normal'].links):
        links.remove(link)

def restore():
    for bone in rig.pose.bones:
        loc, quat, scale = base[bone.name]
        bone.rotation_mode = 'QUATERNION'
        bone.location = loc
        bone.rotation_quaternion = quat
        bone.scale = scale

def rotate(name, x=0, y=0, z=0):
    bone = rig.pose.bones['mixamorig:' + name]
    bone.rotation_quaternion = base[bone.name][1] @ Euler((x,y,z), 'XYZ').to_quaternion()

def rotate_world(name, axis, angle):
    bone = rig.pose.bones['mixamorig:' + name]
    world = world_rotations[bone.name]
    bone.rotation_quaternion = base[bone.name][1] @ world.inverted() @ Quaternion(axis,angle) @ world

clips = [('Idle', 97), ('Walk', 33), ('Wave', 65), ('Celebrate', 49), ('Sleep', 97), ('Drag', 49), ('Think', 97)]
scene.render.fps = 24
rig.animation_data_create()
for name, end in clips:
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    for frame in sorted(set(range(1, end+1, 3)) | {end}):
        restore()
        u = (frame-1)/(end-1)
        phase = u*math.tau
        breathe = math.sin(phase)
        rotate('Spine2', x=0.012*breathe)
        rotate('Head', y=0.025*breathe, z=0.02*breathe)
        if name == 'Walk':
            for side, sign in [('Left',1),('Right',-1)]:
                swing = math.sin(phase)*sign
                rotate_world(side+'UpLeg', (1,0,0), 0.24*swing)
                rotate_world(side+'Leg', (1,0,0), -max(0,swing)*0.30)
                rotate_world(side+'Arm', (1,0,0), -0.20*swing)
            rig.pose.bones['mixamorig:Hips'].location.z += abs(math.sin(phase))*0.035
        elif name == 'Wave':
            envelope = math.sin(math.pi*u)**0.65
            rotate_world('RightArm', (0,1,0), 1.05*envelope)
            rotate_world('RightForeArm', (0,1,0), 1.1*envelope)
            rotate_world('RightHand', (0,1,0), 0.28*math.sin(phase*3)*envelope)
            rotate('Head', z=0.10*envelope)
        elif name == 'Celebrate':
            hop = max(0,math.sin(phase))
            rig.pose.bones['mixamorig:Hips'].location.z += 0.22*hop
            rotate('LeftArm', z=0.5*hop)
            rotate('RightArm', z=-0.5*hop)
            rotate('LeftLeg', x=0.15*hop)
            rotate('RightLeg', x=0.15*hop)
        elif name == 'Sleep':
            rotate('Head', x=0.16+0.035*breathe, z=0.13)
            rotate('Spine2', x=0.035+0.012*breathe)
        elif name == 'Drag':
            rotate('LeftArm', z=0.25, x=0.06*breathe)
            rotate('RightArm', z=-0.25, x=-0.06*breathe)
            rotate('LeftLeg', x=0.15+0.10*breathe)
            rotate('RightLeg', x=0.15-0.10*breathe)
            rotate('Head', z=0.08*breathe)
        elif name == 'Think':
            rotate('Head', y=0.12+0.025*breathe, z=-0.09)
            rotate('RightForeArm', x=-0.25)
        for bone in rig.pose.bones:
            bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)
            bone.keyframe_insert('location', frame=frame, group=bone.name)
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, action)
    strip.action_slot = rig.animation_data.action_slot
    track.mute = True
    rig.animation_data.action = None

restore()
scene.frame_start, scene.frame_end = 1, 97
scene.frame_set(1)
bpy.context.view_layer.update()
meshes = [o for o in scene.objects if o.type=='MESH']
deps = bpy.context.evaluated_depsgraph_get()
points = [o.matrix_world @ Vector(p) for o in meshes for p in o.evaluated_get(deps).bound_box]
low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
center = (low+high)/2

# Camera and soft studio lighting are saved for further Blender editing.
bpy.ops.object.camera_add(location=center+Vector((0,-5,0.12)))
camera=bpy.context.object
camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO'; camera.data.ortho_scale=(high.z-low.z)*1.12
scene.camera=camera
for location, power, size in [((3,-4,5),350,5),((-3,-2,3),250,4),((1,3,4),450,3)]:
    bpy.ops.object.light_add(type='AREA',location=location)
    light=bpy.context.object; light.data.energy=power; light.data.shape='DISK'; light.data.size=size
    light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
scene.world=bpy.data.worlds.new('Soft studio'); scene.world.color=(0.3,0.3,0.3)
scene.view_settings.view_transform='AgX'
scene.render.engine='CYCLES'; scene.cycles.samples=24
scene.render.film_transparent=True
scene.render.resolution_x=600; scene.render.resolution_y=700; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath=str(OUTPUT / 'preview.png')

for obj in scene.objects:
    obj.select_set(obj.type in {'MESH','ARMATURE','EMPTY'})
bpy.context.view_layer.objects.active=rig
for track in rig.animation_data.nla_tracks:
    track.mute=False
bpy.ops.export_scene.gltf(filepath=str(OUTPUT/'model.glb'), export_format='GLB', use_selection=True,
    export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True,
    export_skins=True, export_morph=False, export_cameras=False, export_lights=False,
    export_extras=False, export_yup=True)
for track in rig.animation_data.nla_tracks:
    track.mute=True
restore()
scene.frame_set(1)
rig.animation_data.action=bpy.data.actions['Idle']
if rig.animation_data.action.slots:
    rig.animation_data.action_slot=rig.animation_data.action.slots[0]
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'
            area.spaces.active.shading.type='MATERIAL'
bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT/'jinx-companion.blend'))
bpy.ops.render.render(write_still=True)
after = sum(len(o.data.polygons) for o in meshes)
(OUTPUT/'processing.json').write_text(json.dumps({'sourcePolygons':before,'outputPolygons':after,'clips':[n for n,_ in clips],'glbBytes':(OUTPUT/'model.glb').stat().st_size},indent=2))
print('JINX_READY',before,after)
