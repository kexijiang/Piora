"""Original Piora cinematic. Blender 4.5+ / 5.x, no downloaded scene assets.
blender -b -t 6 --python scripts/blender/polaris-rover.py -- --output .verification/polaris --preview
Remove --preview to render 192 frames (8 seconds at 24 fps).
"""
import argparse
import bpy
import math
import os
import random
import sys
from mathutils import Vector

args = argparse.ArgumentParser()
args.add_argument('--output', required=True)
args.add_argument('--preview', action='store_true')
args.add_argument('--start', type=int, default=1)
args.add_argument('--end', type=int, default=192)
cfg = args.parse_args(sys.argv[sys.argv.index('--') + 1:])
out = os.path.abspath(cfg.output)
os.makedirs(out, exist_ok=True)
random.seed(47)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT' if bpy.app.version < (4, 2, 0) else 'BLENDER_EEVEE'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 192
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.render.film_transparent = False
if hasattr(scene, 'eevee') and hasattr(scene.eevee, 'taa_render_samples'):
    scene.eevee.taa_render_samples = 32
scene.world.color = (0.003, 0.007, 0.02)
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.008, 0.018, 0.045, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0.22
scene.view_settings.view_transform = 'AgX'

def material(name, color, metallic=0, roughness=.4, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Emission Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Strength'].default_value = emission
    return mat

white = material('Ceramic | pearl titanium', (.65, .76, .85), .7, .26)
dark = material('Carbon | graphite', (.014, .024, .039), .65, .35)
rubber = material('Wheels | textured carbon', (.012, .018, .023), .12, .77)
gold = material('Foil | expedition gold', (.95, .29, .046), .72, .3)
cyan = material('Telemetry | glacial cyan', (.025, .7, 1), .3, .2, 4)
amber = material('Beacon | amber', (1, .17, .022), .2, .25, 6)
solar = material('Solar cells | sapphire', (.014, .05, .15), .8, .22)
ice = material('Regolith | blue obsidian', (.024, .064, .095), .4, .34)
snow = material('Frost | mineral silver', (.16, .29, .34), .28, .56)
frost = material('Ground | subtle frost', (.038, .084, .12), .32, .54)

def attach(obj, mat, parent=None):
    obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    return obj

def cube(name, loc, scale, mat, bevel=.07, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Machined edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        obj.modifiers.new('Corner normals', 'WEIGHTED_NORMAL')
    return attach(obj, mat, parent)

def cylinder(name, loc, radius, depth, mat, rotation=(0,0,0), parent=None, vertices=40):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    for face in obj.data.polygons:
        face.use_smooth = True
    bevel = obj.modifiers.new('Edge highlights', 'BEVEL')
    bevel.width = .025
    bevel.segments = 2
    return attach(obj, mat, parent)

def beam(name, a, b, radius, mat, parent=None):
    delta = Vector(b) - Vector(a)
    obj = cylinder(name, (Vector(a) + Vector(b))/2, radius, delta.length, mat, parent=parent, vertices=12)
    obj.rotation_euler = delta.to_track_quat('Z','Y').to_euler()
    return obj

def curve(name, points, radius, mat):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.bevel_depth = radius
    data.bevel_resolution = 2
    line = data.splines.new('POLY')
    line.points.add(len(points)-1)
    for point, co in zip(line.points, points):
        point.co = (*co, 1)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return attach(obj, mat)

rover = bpy.data.objects.new('PIORA | expedition rover', None)
bpy.context.collection.objects.link(rover)
cube('Monocoque chassis', (0,0,1.25), (3.5,1.95,.66), white, .17, rover)
cube('Lower thermal enclosure', (0,0,.92), (2.9,1.65,.4), gold, .1, rover)
cube('Upper instrument deck', (-.24,0,1.68), (2.65,1.74,.26), dark, .09, rover)
cube('Power pack', (-.8,0,1.98), (.85,1.4,.45), white, .09, rover)
for side in [-1,1]:
    cube('Side cyan identification strip', (.13,side*.997,1.3), (2.5,.026,.045), cyan, .012, rover)
    for x in [-1.25,0,1.25]:
        wheel = cylinder('Wheel hub', (x,side*1.26,.57), .55, .38, rubber, (math.pi/2,0,0), rover, 48)
        wheel.rotation_euler[2] = 0
        wheel.keyframe_insert('rotation_euler',frame=1)
        wheel.rotation_euler[1] = -6/.55
        wheel.keyframe_insert('rotation_euler',frame=192)
        cylinder('Titanium wheel rim', (x,side*1.48,.57), .34, .046, white, (math.pi/2,0,0), rover)
        cylinder('Amber hub bearing', (x,side*1.514,.57), .12, .057, gold, (math.pi/2,0,0), rover)
        for n in range(16):
            a = n*math.tau/16
            tread = cube('Grouser tread', (math.sin(a)*.55,math.cos(a)*.55,0), (.11,.09,.42), dark,.018,wheel)
            tread.rotation_euler[2] = -a
        beam('Rocker suspension', (x,side*1.24,.62), (x*.68,side*.82,1.22), .067, gold, rover)
    for i in range(7):
        cube('Side radiator fin', (-.92+i*.27,side*1.025,1.1), (.06,.065,.19),dark,.01,rover)
    cube('Front headlamp', (1.77,side*.65,1.27), (.035,.35,.095),cyan,.02,rover)

# Deployable twin solar wings, each with individually inset cells.
for side in [-1,1]:
    cube('Solar wing backing', (-.65,side*1.57,2.16), (1.95,1.35,.07), white,.025,rover)
    for i in range(6):
        for j in range(4):
            cube('Photovoltaic cell', (-1.43+i*.31,side*1.57-.49+j*.32,2.205), (.28,.29,.012),solar,.01,rover)
beam('Mast', (.55,0,1.75), (.55,0,3.1), .075,white,rover)
cube('Stereo navigation head', (.66,0,3.13), (.42,.72,.3),white,.08,rover)
for y in [-.22,.22]:
    cylinder('Stereo optics', (.903,y,3.15),.098,.042,dark,(0,math.pi/2,0),rover)
    cylinder('Optical glass', (.932,y,3.15),.059,.012,cyan,(0,math.pi/2,0),rover)
beam('Antenna',(-1.2,.54,2.18),(-1.35,.54,2.95),.024,dark,rover)
cylinder('Signal lamp',(-1.35,.54,2.99),.044,.07,amber,parent=rover)
# Robotic sampling arm at the forward edge.
beam('Arm shoulder',(1.55,.2,1.02),(2.04,.22,.89),.095,dark,rover)
beam('Arm forearm',(2.04,.22,.89),(2.34,.4,.47),.075,white,rover)
cylinder('Sample drill',(2.34,.4,.36),.10,.23,gold,parent=rover)
bpy.ops.object.text_add(location=(-.65,-1.033,1.4),rotation=(math.pi/2,0,0))
label=bpy.context.object;label.data.body='PIORA / 01';label.data.size=.16;label.data.extrude=.002;attach(label,dark,rover)
rover.location=(-3,0,0)
rover.keyframe_insert('location',frame=1)
rover.location=(3,0,0)
rover.keyframe_insert('location',frame=192)

# Flat drivable corridor, ridged crystalline terrain farther from the wheel path.
verts=[]; faces=[]
for j in range(71):
    y=-22+j*.8
    for i in range(101):
        x=-40+i*.8
        height=(math.sin(x*.63+y*.2)*.12+random.random()*.16)*min(1,max(0,(abs(y)-2)/4))-.05
        verts.append((x,y,height))
for j in range(70):
    for i in range(100):
        k=j*101+i
        faces.extend([(k,k+1,k+102),(k,k+102,k+101)])
mesh=bpy.data.meshes.new('Faceted basalt ice');mesh.from_pydata(verts,[],faces);mesh.update()
ground=bpy.data.objects.new('POLARIS | regolith',mesh);bpy.context.collection.objects.link(ground);attach(ground,ice)
ground.data.materials.append(frost)
for poly in ground.data.polygons:
    if random.random()<.13: poly.material_index=1
for i in range(85):
    x=random.uniform(-26,27);y=random.choice([-1,1])*random.uniform(3.7,21)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=(x,y,.2))
    rock=bpy.context.object;rock.name='Glacial shard';rock.scale=(random.uniform(.15,.7),random.uniform(.2,.55),random.uniform(.25,1.4));attach(rock,snow if i%4 else ice)
for i in range(22):
    x=-38+i*3.8;y=random.uniform(28,39);h=random.uniform(1.5,4.8)
    bpy.ops.mesh.primitive_cone_add(vertices=random.randint(4,7),radius1=random.uniform(2,4.5),radius2=.1,depth=h,location=(x,y,h*.45))
    attach(bpy.context.object,ice if i%3 else snow)
for band in [-1,1]:
    for i in range(4):
        pts=[(-30+j*.9,band*(4.5+i*2)+math.sin(j*.4+i)*.4,.075) for j in range(75)]
        curve('Subsurface luminous fracture',pts,.014,cyan)
# Wheel impressions behind the rover, with staggered raised ice edges.
for x in range(60):
    for side in [-1,1]:
        cube('Expedition tracks',(-18+x*.24,side*1.3,.005),(.1,.46,.022),dark,.005)

# Aurora curtains and a distant polar beacon, staged well behind the mountains.
for ribbon in range(4):
    aurora=material('Aurora '+str(ribbon),(.03,.6-ribbon*.1,.42+ribbon*.17),0,.5,.6)
    nodes=aurora.node_tree.nodes;links=aurora.node_tree.links
    nodes.clear()
    output=nodes.new('ShaderNodeOutputMaterial');mix=nodes.new('ShaderNodeMixShader')
    transparent=nodes.new('ShaderNodeBsdfTransparent');glow=nodes.new('ShaderNodeEmission')
    glow.inputs['Color'].default_value=(.015,.42-ribbon*.055,.26+ribbon*.12,1);glow.inputs['Strength'].default_value=2.3
    tex=nodes.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=1.3;tex.inputs['Detail'].default_value=3
    coord=nodes.new('ShaderNodeTexCoord');mapping=nodes.new('ShaderNodeVectorMath');mapping.operation='MULTIPLY';mapping.inputs[1].default_value=(7,1,.24)
    links.new(coord.outputs['Generated'],mapping.inputs[0]);links.new(mapping.outputs['Vector'],tex.inputs['Vector'])
    ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.28;ramp.color_ramp.elements[1].position=.72
    ramp.color_ramp.elements[1].color=(.24,.24,.24,1)
    separate=nodes.new('ShaderNodeSeparateXYZ');links.new(coord.outputs['UV'],separate.inputs[0])
    inverse=nodes.new('ShaderNodeMath');inverse.operation='SUBTRACT';inverse.inputs[0].default_value=1;links.new(separate.outputs['Y'],inverse.inputs[1])
    fade=nodes.new('ShaderNodeMath');fade.operation='MULTIPLY';links.new(separate.outputs['Y'],fade.inputs[0]);links.new(inverse.outputs[0],fade.inputs[1])
    opacity=nodes.new('ShaderNodeMath');opacity.operation='MULTIPLY';links.new(ramp.outputs['Color'],opacity.inputs[0]);links.new(fade.outputs[0],opacity.inputs[1])
    links.new(tex.outputs['Fac'],ramp.inputs[0]);links.new(opacity.outputs[0],mix.inputs[0]);links.new(transparent.outputs[0],mix.inputs[1]);links.new(glow.outputs[0],mix.inputs[2]);links.new(mix.outputs[0],output.inputs[0])
    if hasattr(aurora,'surface_render_method'): aurora.surface_render_method='BLENDED'
    vs=[];fs=[]
    for j in range(81):
        x=-100+j*2.5;z=8+math.sin(j*.07+ribbon)*1.7+ribbon*.6
        vs.extend([(x,37+ribbon*2,z),(x,37+ribbon*2,z+1.6+math.sin(j*.32)*.5)])
        if j: fs.append((j*2-2,j*2-1,j*2+1,j*2))
    mesh=bpy.data.meshes.new('Aurora ribbon');mesh.from_pydata(vs,[],fs);mesh.update()
    uv=mesh.uv_layers.new(name='Curtain UV')
    for face in mesh.polygons:
        for loop in face.loop_indices:
            index=mesh.loops[loop].vertex_index;uv.data[loop].uv=(index//2/80,index%2)
    ob=bpy.data.objects.new('Aurora curtain',mesh);bpy.context.collection.objects.link(ob);attach(ob,aurora)
star=material('Starlight',(.55,.78,1),0,.4,5)
for i in range(180):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=random.uniform(.012,.046),location=(random.uniform(-65,65),50,random.uniform(7,43)))
    attach(bpy.context.object,star)
bpy.ops.mesh.primitive_uv_sphere_add(segments=48,ring_count=24,radius=2.1,location=(-12,39,9.6))
attach(bpy.context.object,material('Polaris beacon',(.24,.62,1),0,.25,5))

def area(name,loc,power,color,size,target):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.color=color;data.shape='DISK';data.size=size
    ob=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(ob);ob.location=loc;ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
area('Arctic key',(2,-7,11),2100,(.44,.7,1),8,(0,0,0))
area('Amber rim',(-7,4,7),2500,(1,.35,.085),6,(0,0,1))
area('Icy rim',(6,6,6),2600,(.14,.65,1),7,(0,0,1))
area('Face softbox',(8,-4,4),650,(.8,.9,1),5,(0,0,1))

bpy.ops.object.camera_add(location=(7,-11,5.6))
camera=bpy.context.object;scene.camera=camera;camera.data.lens=39
camera.data.clip_end=250
for frame,position,target in [(1,(4,-11,4.3),(-3.5,2.8,2.1)),(96,(7.5,-11,3.8),(-.8,2.8,2.3)),(192,(10,-10,3.4),(2.3,2.8,2.5))]:
    camera.location=position;camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler();camera.keyframe_insert('location',frame=frame);camera.keyframe_insert('rotation_euler',frame=frame)
# Bloom catches the headlamps and glacial fractures without obscuring the rover.
try:
    if bpy.app.version >= (5,0,0):
        tree=bpy.data.node_groups.new('Piora cinematic finish','CompositorNodeTree');scene.compositing_node_group=tree
        tree.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
        output=tree.nodes.new('NodeGroupOutput')
    else:
        scene.use_nodes=True;tree=scene.node_tree;tree.nodes.clear();output=tree.nodes.new('CompositorNodeComposite')
    layers=tree.nodes.new('CompositorNodeRLayers');glare=tree.nodes.new('CompositorNodeGlare')
    tree.links.new(layers.outputs['Image'],output.inputs['Image'])
    if 'Type' in glare.inputs:
        glare.inputs['Type'].default_value='Fog Glow'
        glare.inputs['Quality'].default_value='Medium'
        glare.inputs['Strength'].default_value=.38
    else:
        glare.glare_type='FOG_GLOW';glare.quality='MEDIUM'
    tree.links.new(layers.outputs['Image'],glare.inputs['Image']);tree.links.new(glare.outputs['Image'],output.inputs['Image'])
except Exception as error:
    print('Compositor fallback:',error)

scene.frame_set(96)
bpy.data.orphans_purge(do_recursive=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,'polaris-rover.blend'))
if cfg.preview:
    scene.render.filepath=os.path.join(out,'preview.png');bpy.ops.render.render(write_still=True)
else:
    scene.frame_start=cfg.start;scene.frame_end=cfg.end
    scene.render.filepath=os.path.join(out,'frame-');bpy.ops.render.render(animation=True)
