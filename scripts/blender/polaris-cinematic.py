"""Original P-76 explorer, physically lit and rendered in Blender Cycles.
blender -b -t 6 --python scripts/blender/polaris-cinematic.py -- --output .verification/polaris-v2
"""
import argparse
import json
import math
import os
import random
import sys
import bpy
from mathutils import Vector, noise

p = argparse.ArgumentParser()
p.add_argument('--output', required=True)
p.add_argument('--frame', type=int, default=96)
p.add_argument('--animation', action='store_true')
p.add_argument('--samples', type=int, default=64)
p.add_argument('--width', type=int, default=1280)
p.add_argument('--start', type=int, default=1)
p.add_argument('--end', type=int, default=192)
cfg = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
out = os.path.abspath(cfg.output)
os.makedirs(out, exist_ok=True)
random.seed(81)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = cfg.samples
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.cycles.volume_bounces = 1
scene.cycles.transparent_max_bounces = 4
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'CUDA'
prefs.get_devices()
gpu = False
for device in prefs.devices:
    device.use = device.type == 'CUDA'
    gpu |= device.use
scene.cycles.device = 'GPU' if gpu else 'CPU'
scene.render.resolution_x = cfg.width
scene.render.resolution_y = round(cfg.width * 9 / 16)
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 192
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.world.use_nodes = True
world = scene.world.node_tree.nodes.get('Background')
world.inputs[0].default_value = (.13, .19, .29, 1)
world.inputs[1].default_value = .28

def material(name, color, rough=.5, metal=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m

def noise_bump(m, scale, strength, distance):
    nodes, links = m.node_tree.nodes, m.node_tree.links
    n = nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = 4
    geo = nodes.new('ShaderNodeNewGeometry')
    links.new(geo.outputs['Position'], n.inputs['Vector'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = strength
    bump.inputs['Distance'].default_value = distance
    links.new(n.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])
    return n

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from future_rover import build_rover
rover = build_rover()

for frame, y in [(1, .4), (192, -.6)]:
    # 0.57 m axle minus 0.55 m tread radius meets the lane at -0.018 m.
    rover.location = (0, y, -.038)
    rover.keyframe_insert(data_path='location', frame=frame)

ice = material('Wind-carved blue ice and powdered frost', (.27, .34, .40), .43, .12)
n = noise_bump(ice, 95, .65, .027)
nodes, links = ice.node_tree.nodes, ice.node_tree.links
large = nodes.new('ShaderNodeTexNoise')
large.inputs['Scale'].default_value = 1.7
large.inputs['Detail'].default_value = 5
geo = nodes.new('ShaderNodeNewGeometry')
links.new(geo.outputs['Position'], large.inputs['Vector'])
ramp = nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = .22
ramp.color_ramp.elements[0].color = (.028, .055, .080, 1)
ramp.color_ramp.elements[1].position = .78
ramp.color_ramp.elements[1].color = (.56, .65, .71, 1)
links.new(large.outputs['Fac'], ramp.inputs[0])
links.new(ramp.outputs[0], nodes.get('Principled BSDF').inputs['Base Color'])
snow = material('Distant glacial granite with frost', (.31, .38, .43), .78)
noise_bump(snow, 27, .85, .16)

def ground_z(x, y):
    # Fine physical relief; the wheel lanes remain nearly level for contact.
    lane = min(abs(x - 1.47), abs(x + 1.47))
    flat = min(1, max(0, lane - .2) * 2)
    return -.018 + flat * (.036 * noise.fractal(Vector((x*2, y*2, .4)), .8, 2, 4))

def terrain():
    size, count = 40, 260
    verts, faces = [], []
    for j in range(count+1):
        for i in range(count+1):
            x, y = -size/2 + i*size/count, -size/2+j*size/count
            verts.append((x,y,ground_z(x,y)))
    for j in range(count):
        for i in range(count):
            a=j*(count+1)+i
            faces.append((a,a+1,a+count+2,a+count+1))
    mesh=bpy.data.meshes.new('Ice shelf microrelief'); mesh.from_pydata(verts,[],faces); mesh.update()
    obj=bpy.data.objects.new('Ice shelf',mesh); scene.collection.objects.link(obj); obj.data.materials.append(ice)
    for poly in mesh.polygons: poly.use_smooth=True
terrain()
# The detailed foreground joins a continuous horizon shelf; no exposed mesh edge.
bpy.ops.mesh.primitive_plane_add(size=2000, location=(0,0,-.08))
bpy.context.object.name='Continuous polar shelf to horizon'
bpy.context.object.data.materials.append(ice)

# One continuous, eroded mountain wall avoids the old geometric crystal silhouettes.
verts, faces = [], []
nx, ny = 240, 100
for j in range(ny+1):
    for i in range(nx+1):
        x, y = -140+i*280/nx, 40+j*100/ny
        falloff = math.sin(math.pi*j/ny)**.7
        ridge = noise.ridged_multi_fractal(Vector((x*.046,y*.05,1.7)), 1, 2, 6, 1, 2)
        h = -.2 + falloff * (2 + ridge*4)
        verts.append((x,y,h))
for j in range(ny):
    for i in range(nx):
        a=j*(nx+1)+i; faces.append((a,a+1,a+nx+2,a+nx+1))
mesh=bpy.data.meshes.new('Eroded massif');mesh.from_pydata(verts,[],faces);mesh.update()
mountain=bpy.data.objects.new('Polar escarpment',mesh);scene.collection.objects.link(mountain);mesh.materials.append(snow)
for poly in mesh.polygons: poly.use_smooth=True

rock = material('Dark mineral inclusions', (.055,.068,.073), .69)
noise_bump(rock, 36, .7, .065)
for i in range(100):
    x,y=random.uniform(-13,13),random.uniform(-10,12)
    if abs(x)<1.65 and -3<y<3: continue
    r=random.uniform(.025,.18)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=r,location=(x,y,r*.22))
    o=bpy.context.object; o.name='Eroded ice debris';o.scale=(1.6,1,.5);o.rotation_euler=(random.random(),random.random(),random.random()*6)
    o.data.materials.append(rock)
    for poly in o.data.polygons: poly.use_smooth=True

track = material('Compressed wheel impressions', (.065,.09,.11), .6)
for x in [-1.47,1.47]:
    for i in range(85):
        y=.9+i*.11
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x,y,-.006))
        obj=bpy.context.object;obj.name='Shallow tread imprint';obj.scale=(.29,.014,.004)
        obj.rotation_euler.z=.23 if i%2 else -.23
        obj.data.materials.append(track)

def light(name, kind, loc, energy, color, size, target):
    data=bpy.data.lights.new(name,kind);data.energy=energy;data.color=color
    if kind=='AREA': data.shape='DISK';data.size=size
    if kind=='SUN': data.angle=size
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=loc
    obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
    return obj
light('Distant star | hard warm rim','SUN',(8,7,5),4.0,(1,.79,.57),.035,(0,0,0))
light('Cold sky bounce','AREA',(-4,-2,7),550,(.46,.66,1),8,(0,0,1))
light('Ice reflection | soft frontal fill','AREA',(1,-6,3),230,(.69,.81,1),6,(0,0,1))
light('Grazing stellar rim through a ridge opening','AREA',(-4,6,4),2100,(1,.73,.45),4,(0,0,1))

# Thin real volumetric haze catches the rim light without masking the machinery.
fog=bpy.data.materials.new('Low drifting ice haze');fog.use_nodes=True
fn=fog.node_tree.nodes;fl=fog.node_tree.links;fn.clear()
output=fn.new('ShaderNodeOutputMaterial');volume=fn.new('ShaderNodeVolumePrincipled')
volume.inputs['Color'].default_value=(.58,.68,.78,1)
volume.inputs['Density'].default_value=.016
volume.inputs['Anisotropy'].default_value=.35
tex=fn.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=1.8;tex.inputs['Detail'].default_value=2
mul=fn.new('ShaderNodeMath');mul.operation='MULTIPLY';mul.inputs[1].default_value=.032
fl.new(tex.outputs['Fac'],mul.inputs[0]);fl.new(mul.outputs[0],volume.inputs['Density']);fl.new(volume.outputs['Volume'],output.inputs['Volume'])
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,3,.24))
haze=bpy.context.object;haze.name='Ground-hugging suspended ice';haze.scale=(24,30,.48);haze.data.materials.append(fog)
for f,x in [(1,-.6),(192,.8)]:
    haze.location.x=x;haze.keyframe_insert(data_path='location',frame=f)

bpy.ops.object.empty_add(location=(0,-.1,.86))
focus=bpy.context.object;focus.name='Camera focus | rover chassis'
bpy.ops.object.camera_add()
camera=bpy.context.object;camera.name='Low tracking camera';scene.camera=camera
camera.data.lens=47
camera.data.dof.use_dof=True;camera.data.dof.focus_object=focus;camera.data.dof.aperture_fstop=5.6
for frame,pos,target in [(1,(5.8,-8.5,1.65),(0,0,1.02)),(96,(5.2,-8.3,1.75),(0,-.1,1.08)),(192,(4.9,-8.0,1.85),(0,-.5,1.12))]:
    camera.location=pos;camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
    camera.keyframe_insert(data_path='location',frame=frame);camera.keyframe_insert(data_path='rotation_euler',frame=frame)

tree=bpy.data.node_groups.new('Subtle photographic bloom','CompositorNodeTree')
scene.compositing_node_group=tree
tree.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
render=tree.nodes.new('CompositorNodeRLayers');output=tree.nodes.new('NodeGroupOutput')
glare=tree.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value='Fog Glow';glare.inputs['Threshold'].default_value=2.5;glare.inputs['Strength'].default_value=.12
tree.links.new(render.outputs['Image'],glare.inputs['Image']);tree.links.new(glare.outputs['Image'],output.inputs[0])
scene.frame_set(cfg.frame)
bpy.ops.file.pack_all()
bpy.data.orphans_purge(do_recursive=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,'polaris-rover.blend'),compress=True)
with open(os.path.join(out, 'scene-metadata.json'), 'w', encoding='utf-8') as metadata:
    json.dump({
        'design': 'P-76 / 2076 heavy polar expedition rover',
        'geometry': 'Original procedural geometry; no downloaded vehicle or terrain assets',
        'blender': bpy.app.version_string,
        'engine': scene.render.engine,
        'samples': scene.cycles.samples,
        'width': scene.render.resolution_x,
        'height': scene.render.resolution_y,
        'fps': 24,
        'frames': 192,
        'meshObjects': sum(o.type == 'MESH' for o in scene.objects),
    }, metadata, indent=2)
if cfg.animation:
    scene.frame_start = max(1, cfg.start)
    scene.frame_end = min(192, cfg.end)
    scene.render.filepath=os.path.join(out,'frame-')
    bpy.ops.render.render(animation=True)
else:
    scene.render.filepath=os.path.join(out,'preview.png')
    bpy.ops.render.render(write_still=True)
