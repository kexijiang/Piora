"""Original 2076 unmanned polar explorer. All geometry is authored here."""
import bpy
import math
from mathutils import Vector


def build_rover():
    collection = bpy.data.collections.new('PIORA / P-76 — original expedition vehicle')
    bpy.context.scene.collection.children.link(collection)
    objects = []

    def keep(o, name, mat=None):
        o.name = name
        for c in list(o.users_collection): c.objects.unlink(o)
        collection.objects.link(o)
        if mat: o.data.materials.append(mat)
        objects.append(o)
        return o

    def mat(name, color, metal, rough, grain=0):
        m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
        ns,ls=m.node_tree.nodes,m.node_tree.links;b=ns.get('Principled BSDF')
        b.inputs['Base Color'].default_value=(*color,1);b.inputs['Metallic'].default_value=metal;b.inputs['Roughness'].default_value=rough
        if grain:
            tex=ns.new('ShaderNodeTexNoise');tex.inputs['Scale'].default_value=160;tex.inputs['Detail'].default_value=2
            geo=ns.new('ShaderNodeNewGeometry');ls.new(geo.outputs['Position'],tex.inputs['Vector'])
            bump=ns.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.2;bump.inputs['Distance'].default_value=grain
            ls.new(tex.outputs['Fac'],bump.inputs['Height']);ls.new(bump.outputs['Normal'],b.inputs['Normal'])
        return m
    ceramic=mat('P76 | warm off-white sintered ceramic',(.38,.42,.44),.42,.34,.001)
    titanium=mat('P76 | bead-blasted titanium',(.12,.145,.16),.88,.34,.001)
    dark=mat('P76 | carbon silicon carbide',(.019,.025,.031),.45,.4,.002)
    silver=mat('P76 | actuator chrome',(.42,.49,.52),.95,.19)
    black=mat('P76 | compliant metallic tread',(.021,.025,.028),.58,.55,.004)
    orange=mat('P76 | muted copper insulation',(.34,.12,.035),.75,.32,.002)
    glass=mat('P76 | sapphire optics',(.006,.023,.036),.72,.10)
    light=mat('P76 | instrument light',(.39,.75,.85),.2,.22)
    b=light.node_tree.nodes.get('Principled BSDF');b.inputs['Emission Color'].default_value=(.44,.8,1,1);b.inputs['Emission Strength'].default_value=2.8
    amber=mat('P76 | amber status',(.8,.29,.025),.2,.2)
    b=amber.node_tree.nodes.get('Principled BSDF');b.inputs['Emission Color'].default_value=(1,.22,.025,1);b.inputs['Emission Strength'].default_value=1.5

    def bevel(o, width=.035, segments=3):
        m=o.modifiers.new('Manufactured edge radii','BEVEL');m.width=width;m.segments=segments
        m=o.modifiers.new('Face weighted normals','WEIGHTED_NORMAL')
        return o

    def box(name, pos, scale, m, radius=.035):
        bpy.ops.mesh.primitive_cube_add(size=1,location=pos)
        o=keep(bpy.context.object,name,m);o.scale=scale
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        if radius: bevel(o,radius)
        return o

    def rod(name, a, b, radius, m, vertices=16):
        a,b=Vector(a),Vector(b)
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=(b-a).length,location=(a+b)/2)
        o=keep(bpy.context.object,name,m);o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
        for f in o.data.polygons:f.use_smooth=True
        bevel(o,.008,2)
        return o

    def path(name, points, radius, m):
        curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.bevel_depth=radius;curve.bevel_resolution=3
        s=curve.splines.new('BEZIER');s.bezier_points.add(len(points)-1)
        for p,c in zip(s.bezier_points,points):p.co=c;p.handle_left_type='AUTO';p.handle_right_type='AUTO'
        o=bpy.data.objects.new(name,curve);collection.objects.link(o);curve.materials.append(m);objects.append(o)
        return o

    def hull(name, stations, m):
        # Width, y, lower and upper edges form a sculpted chamfered hull.
        verts=[]
        for width,y,bottom,top in stations:
            verts += [(-width*.84,y,bottom),(-width,y,bottom+.13),(-width*.92,y,top-.08),(-width*.73,y,top),
                      (width*.73,y,top),(width*.92,y,top-.08),(width,y,bottom+.13),(width*.84,y,bottom)]
        faces=[tuple(range(7,-1,-1))]
        for j in range(len(stations)-1):
            for k in range(8):faces.append((j*8+k,j*8+(k+1)%8,(j+1)*8+(k+1)%8,(j+1)*8+k))
        faces.append(tuple((len(stations)-1)*8+k for k in range(8)))
        mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
        o=bpy.data.objects.new(name,mesh);collection.objects.link(o);mesh.materials.append(m);objects.append(o);bevel(o,.035)
        return o

    hull('Pressure cell / shadow undercut',[(.65,-2.04,.78,1.09),(1.0,-1.35,.67,1.4),(1.0,1.38,.69,1.4),(.73,1.9,.85,1.23)],dark)
    hull('Continuous arrowhead ceramic shell',[(.62,-2.18,1.01,1.14),(1.02,-1.24,1.11,1.68),(.98,.73,1.15,1.83),(.72,1.78,1.02,1.43)],ceramic)
    hull('Recessed central instrument spine',[(.22,-1.91,1.1,1.27),(.25,-.9,1.62,1.74),(.24,.9,1.71,1.9),(.18,1.58,1.37,1.55)],dark)

    # Long top panel gaps follow the shell rather than relying on a smooth toy body.
    for sign in [-1,1]:
        path('Flush ceramic panel division',[(sign*.40,-1.85,1.33),(sign*.64,-.88,1.711),(sign*.61,.72,1.861),(sign*.42,1.50,1.58)],.009,dark)
        path('Titanium sill rail',[(sign*.71,-1.95,.93),(sign*1.035,-1.25,.97),(sign*1.035,1.25,.97),(sign*.7,1.78,1.04)],.055,titanium)
        for y in [-.85,-.15,.6,1.15]:
            z=1.56 if y<1 else 1.42
            rod('Recessed shell fastener',(sign*.9,y,z),(sign*.912,y,z),.022,silver,12)
        # Side ventilation is set into a distinct dark cassette.
        box('Recessed heat exchange cassette',(sign*.995,.4,1.3),(.028,1.35,.28),dark,.018)
        for i in range(14):
            o=box('Metal heat exchanger louver',(sign*1.016,-.18+i*.085,1.31),(.022,.024,.20),titanium,.004)
            o.rotation_euler.x=.3

    # No windshield or face: sensor windows are thin, flush functional apertures.
    box('Forward sapphire sensor ribbon',(0,-2.18,1.092),(1.0,.026,.082),glass,.012)
    for sign in [-1,1]:
        box('Recessed road illuminator',(sign*.46,-2.204,1.088),(.18,.018,.018),light,.004)
        rod('Flush navigation objective',(sign*.24,-2.20,1.10),(sign*.24,-2.22,1.10),.026,glass,32)
    box('Forward titanium impact lip',(0,-2.18,.90),(1.15,.09,.10),titanium,.025)
    for sign in [-1,1]:
        path('Tow loop',[(sign*.44,-2.19,.86),(sign*.44,-2.3,.82),(sign*.29,-2.3,.82),(sign*.29,-2.19,.86)],.023,silver)

    # Six individually sprung, airless metallic wheels with segmented grousers.
    wheel_rigs=[]
    for sign in [-1,1]:
        for index,y in enumerate([-1.36,0,1.36]):
            x=sign*1.47;z=.57
            rod('Upper wishbone',(sign*.84,y-.23,1.12),(x,y,.59),.090,titanium)
            rod('Lower wishbone',(sign*.83,y+.29,.85),(x,y,.56),.090,dark)
            rod('Secondary load-bearing link',(sign*.86,y+.29,1.16),(x,y,.65),.075,titanium)
            rod('Hydraulic damper barrel',(sign*.88,y+.1,1.27),(sign*1.18,y+.055,.94),.094,orange)
            rod('Hydraulic damper polished ram',(sign*1.18,y+.055,.94),(x,y,.59),.048,silver)
            rod('Steering knuckle bearing',(x-.16,y,.62),(x+.16,y,.62),.17,titanium,32)
            path('Armoured actuator umbilical',[(sign*.96,y+.2,1.13),(sign*1.16,y+.25,1.1),(sign*1.4,y+.14,.7)],.025,dark)
            # Rotating components share a rig about the wheel axle.
            start=len(objects)
            rod('Airless tire barrel',(x-.18,y,z),(x+.18,y,z),.53,black,80)
            for side in [-1,1]:
                face=x+side*.195
                rod('Outer titanium rim',(face-side*.018,y,z),(face,y,z),.445,titanium,80)
                rod('Recessed hub shadow',(face,y,z),(face+side*.008,y,z),.363,dark,64)
                rod('Sealed independent motor',(face,y,z),(face+side*.05,y,z),.18,ceramic,64)
                rod('Axle socket',(face+side*.05,y,z),(face+side*.06,y,z),.077,titanium,32)
                for k in range(10):
                    angle=k*math.tau/10
                    a=(face+side*.01,y+math.sin(angle)*.2,z+math.cos(angle)*.2)
                    b=(face+side*.01,y+math.sin(angle+.22)*.40,z+math.cos(angle+.22)*.40)
                    rod('Tension spoke',a,b,.024,silver,10)
                for k in range(6):
                    angle=k*math.tau/6
                    rod('Motor cover bolt',(face+side*.05,y+.13*math.sin(angle),z+.13*math.cos(angle)),(face+side*.065,y+.13*math.sin(angle),z+.13*math.cos(angle)),.014,dark,6)
            for k in range(42):
                angle=k*math.tau/42
                o=box('Replaceable chevron grouser',(x,y+.535*math.sin(angle),z+.535*math.cos(angle)),(.40,.028,.030),titanium,.009)
                o.rotation_euler.x=-angle
            bpy.ops.object.empty_add(location=(x,y,z))
            rig=keep(bpy.context.object,'Wheel rotation / independent motor')
            for o in objects[start:-1]:
                matrix=o.matrix_world.copy();o.parent=rig;o.matrix_world=matrix
            wheel_rigs.append(rig)
            # Ceramic wheel shoulder / fender is fixed to suspension, with generous clearance.
            o=box('Armoured wheel shoulder',(x,y,1.30),(.65,1.05,.18),ceramic,.065)
            o.rotation_euler.y=sign*.10
            box('Outer wheel armour skirt',(x+sign*.31,y,1.21),(.13,.86,.29),titanium,.045)
            box('Replaceable shoulder armour insert',(x+sign*.386,y,1.25),(.025,.51,.13),ceramic,.018)
            box('Fender edge status',(x+sign*.404,y-.16,1.26),(.014,.12,.014),amber,.003)
            for offset in [-.3,.3]:
                rod('Armour locking bolt',(x+sign*.37,y+offset,1.22),(x+sign*.40,y+offset,1.22),.026,silver,6)
            rod('Load-bearing fender strut',(sign*.97,y,1.10),(x,y,1.24),.064,titanium)

    # Low-profile deployable mapping array and equipment mounted along the spine.
    box('Mapping array pedestal',(0,.35,1.94),(.29,.46,.15),titanium)
    hull('Swept lidar radome',[(.17,-.1,1.94,2.02),(.29,.32,1.94,2.18),(.22,.68,1.94,2.12)],dark)
    box('Lidar scanning slit',(0,-.104,1.996),(.27,.014,.022),glass,.005)
    rod('Comms monopole',(0,1.16,1.80),(0,1.22,2.26),.014,titanium)
    rod('Comms monopole tip',(0,1.22,2.26),(0,1.23,2.33),.022,dark)
    # Rear reactor radiator, finned and shielded; restrained copper detail.
    box('Shielded isotope power module',(0,1.58,1.34),(.78,.65,.49),titanium,.06)
    for k in range(13):box('Radiator fin',(-.38+k*.063,1.69,1.35),(.019,.54,.44),dark,.008)
    for sign in [-1,1]:
        rod('Radiator coolant line',(sign*.44,1.44,1.20),(sign*.44,1.93,1.20),.028,orange)
        box('Rear navigation light',(sign*.54,1.86,1.16),(.10,.014,.025),amber,.004)
    # Stowed scientific manipulator on the upper left shoulder.
    for a,b in [((-.55,.82,1.8),(-.55,-.35,1.87)),((-.55,-.35,1.87),(-.55,.48,1.97))]:
        rod('Stowed sampling arm',a,b,.055,titanium)
        rod('Manipulator joint',(a[0]-.07,a[1],a[2]),(a[0]+.07,a[1],a[2]),.105,dark,32)
    box('Core sampler head',(-.55,.52,1.98),(.16,.28,.16),ceramic,.025)

    # Heavy expedition package: sacrificial armour, lifting points and service modules.
    hull('Armoured underbody keel',[(.50,-2.09,.61,.89),(.86,-1.25,.54,.83),(.86,1.26,.56,.85),(.56,1.92,.74,.98)],titanium)
    box('Front structural bumper',(0,-2.22,.84),(1.5,.23,.20),dark,.06)
    box('Winch fairlead',(0,-2.35,.85),(.40,.10,.13),titanium,.025)
    box('Winch aperture',(0,-2.409,.85),(.29,.012,.06),dark,.016)
    for sign in [-1,1]:
        box('Front sacrificial impact block',(sign*.55,-2.29,.91),(.30,.18,.23),ceramic,.035)
        rod('Front bumper fastener',(sign*.57,-2.38,.92),(sign*.57,-2.399,.92),.031,dark,6)
        # Three replaceable side-armour segments with exposed fasteners.
        for i,y in enumerate([-.92,-.24,.44]):
            o=box('Segmented pressure-cell armour',(sign*.984,y,1.36),(.12,.56,.28),ceramic,.025)
            o.rotation_euler.y=sign*.13
            for dy in [-.205,.205]:
                rod('Pressure-cell armour bolt',(sign*1.046,y+dy,1.42),(sign*1.061,y+dy,1.42),.019,dark,6)
        path('External protected coolant trunk',[(sign*.93,-1.56,1.07),(sign*1.10,-.87,1.05),(sign*1.10,.69,1.05),(sign*.78,1.69,1.13)],.042,orange)
        for y in [-1.2,-.55,.15,.85]:
            box('Coolant trunk retaining clamp',(sign*1.102,y,1.05),(.035,.062,.12),titanium,.008)
        # Top armour panels lie on the sloped frontal shell.
        o=box('Sloped frontal applique plate',(sign*.47,-1.35,1.61),(.46,.57,.075),ceramic,.022)
        o.rotation_euler.x=math.radians(28)
        for x in [sign*.30,sign*.63]:
            rod('Flush top armour lock',(x,-1.37,1.655),(x,-1.37,1.67),.022,dark,8)
        # Distinct rear storage pods are recessed behind the primary hull.
        box('Sealed equipment pannier',(sign*.67,1.30,1.59),(.43,.55,.35),dark,.055)
        box('Equipment pannier lid',(sign*.67,1.30,1.78),(.44,.56,.07),ceramic,.025)
        for dy in [-.15,.15]:
            box('Pannier quick-release latch',(sign*.903,1.30+dy,1.63),(.036,.07,.12),silver,.012)
        path('Recessed lifting eye',[(sign*.83,.97,1.80),(sign*.83,1.01,1.88),(sign*.83,1.11,1.88),(sign*.83,1.15,1.8)],.021,titanium)
    # Beefier rotary actuator and bundled service hoses on the folded sampling boom.
    for y,z in [(.82,1.8),(-.35,1.87)]:
        rod('Sampling boom rotary actuator',(-.69,y,z),(-.41,y,z),.14,titanium,32)
        rod('Sampling boom actuator cap',(-.71,y,z),(-.69,y,z),.10,orange,32)
    path('Manipulator hydraulic bundle',[(-.59,.86,1.82),(-.63,.34,1.97),(-.61,-.32,1.94),(-.54,-.36,2.04),(-.50,.43,2.03)],.026,dark)

    def label(text, loc, size, rot):
        curve=bpy.data.curves.new('Laser-etched designation','FONT');curve.body=text;curve.size=size;curve.extrude=.0005;curve.align_x='CENTER'
        o=bpy.data.objects.new('Marking / '+text,curve);collection.objects.link(o);o.location=loc;o.rotation_euler=rot;curve.materials.append(dark);objects.append(o)
    label('P I O R A',(0,-1.36,1.64),.105,(math.radians(25),0,0))
    label('P—76',(.56,-.35,1.809),.13,(0,0,math.pi/2))
    bpy.ops.object.empty_add()
    root=keep(bpy.context.object,'P-76 / travel rig')
    for o in objects:
        if o != root and not o.parent:
            matrix=o.matrix_world.copy();o.parent=root;o.matrix_world=matrix
    for rig in wheel_rigs:
        for frame, angle in [(1,0),(192,1/.55)]:
            rig.rotation_euler.x=angle;rig.keyframe_insert(data_path='rotation_euler',frame=frame)
    return root
