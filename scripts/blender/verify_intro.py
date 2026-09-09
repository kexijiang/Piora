"""Validate the generated Blender scene, in addition to test_numerics.py.
blender -b <scene.blend> --python-exit-code 1 --python scripts/blender/verify_intro.py
"""
import json
import math
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
from mathutils.bvhtree import BVHTree

scene = next(s for s in bpy.data.scenes if s.name.startswith('PIORA_Polaris expedition'))
hud = next(s for s in bpy.data.scenes if s.name.startswith('PIORA_Brand overlay'))
if bpy.context.window:
    bpy.context.window.scene = scene
assert scene.frame_end == 240 and scene.render.fps == 30
ground = next(o for o in scene.objects if o.name.startswith('PIORA_Fictional ice world'))
vertices = [ground.matrix_world @ vertex.co for vertex in ground.data.vertices]
bvh = BVHTree.FromPolygons(vertices, [tuple(p.vertices) for p in ground.data.polygons])
carriers = [o for o in scene.objects if o.name.startswith('PIORA_Suspension carrier')]
assert len(carriers) == 6
rover = bpy.data.collections['PIORA_Rover']
root = next(o for o in rover.objects if o.name.startswith('PIORA_Rover chassis'))
badges = [o for o in rover.objects if o.name.startswith('PIORA_piora body badge')]
serials = [o for o in rover.objects if o.name.startswith('PIORA_Vehicle serial')]
assert len(badges) == len(serials) == 2
for badge, serial in zip(sorted(badges, key=lambda o: o.name), sorted(serials, key=lambda o: o.name)):
    badge_bottom = min((badge.matrix_local @ Vector(v)).z for v in badge.bound_box)
    serial_top = max((serial.matrix_local @ Vector(v)).z for v in serial.bound_box)
    assert badge_bottom > serial_top + .004, ('Overlapping vehicle lettering', badge.name)
max_contact_error = 0
screen_margin = 1
for frame in range(1, 241):
    scene.frame_set(frame)
    for carrier in carriers:
        center = carrier.matrix_world.translation
        hit, *_ = bvh.ray_cast(Vector((center.x, center.y, 100)), Vector((0, 0, -1)))
        assert hit is not None, (frame, carrier.name)
        error = abs(center.z - .68 - hit.z)
        max_contact_error = max(max_contact_error, error)
        assert error < .003, (frame, carrier.name, error)
    if frame in (1, 30, 60, 90, 118, 150, 180, 210, 240):
        for obj in rover.objects:
            if obj.type not in ('MESH', 'FONT', 'CURVE'):
                continue
            for corner in obj.bound_box:
                point = world_to_camera_view(scene, scene.camera, obj.matrix_world @ Vector(corner))
                assert all(math.isfinite(v) for v in point)
                margin = min(point.x, point.y, 1-point.x, 1-point.y)
                screen_margin = min(screen_margin, margin)
                assert point.z > 0 and margin > -.01, (frame, obj.name, tuple(point))
    if frame == 181:
        parked = root.matrix_world.translation.copy()
    if frame > 181:
        assert (root.matrix_world.translation-parked).length < .0001
hud.frame_set(240)
title = next(o for o in hud.objects if o.type == 'FONT' and o.data.body == 'piora')
subtitle = next(o for o in hud.objects if o.type == 'FONT' and o.data.body == 'The Operating System for Personal AI Agents')
for obj in (title, subtitle):
    assert obj.data.materials[0].node_tree.nodes['Visibility'].outputs[0].default_value == 1
scene.frame_set(118)
hud.frame_set(118)
report = {
    'blender': bpy.app.version_string,
    'framesChecked': 240,
    'wheelContactChecks': 240 * 6,
    'maximumWheelContactErrorMeters': max_contact_error,
    'minimumRoverCameraMargin': screen_margin,
    'parkedFinalTwoSeconds': True,
    'closingTitleAndSubtitleVisible': True,
    'vehicleBadgeAndSerialDoNotOverlap': True,
}
Path(bpy.data.filepath).with_name('blender-validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
