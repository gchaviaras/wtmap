"""Synthetic map payloads for the fixture server.

These are invented, not captured from the game: just enough contacts to exercise
every code path in the userscript (all three aircraft glyphs, both teams, all
ground unit kinds, capture zones, respawn bases, airfields). Real payloads
dropped into test/asset/ by test/capture.py take precedence over these.

Shapes follow the live endpoints:
  /map_info.json   map bounds and grid
  /map_obj.json    contacts, positions normalised to 0..1, dx/dy as unit heading
  /mission.json    capture point objectives
  /indicators      vehicle instrument values, valid flag first
  /state           flight parameters, keys carry their unit after a comma
  /gamechat        chat lines, /hudmsg event and damage messages
"""

MAP_INFO = {
    'grid_size': [1700.0, 1700.0],
    'grid_steps': [225.0, 225.0],
    'grid_zero': [186.2, 1904.35],
    'hud_type': 1,
    'map_generation': 3,
    'map_max': [2048.0, 2048.0],
    'map_min': [0.0, 0.0],
    'valid': True,
}

BLUE = '#174DFF'
RED = '#fa0C00'
GREEN = '#67D756'   # the second friendly team
GOLD = '#faC81E'    # the player marker


def _contact(kind, icon, x, y, color, rgb, **extra):
    obj = {
        'type': kind,
        'color': color,
        'color[]': rgb,
        'blink': 0,
        'icon': icon,
        'icon_bg': 'none',
        'x': x,
        'y': y,
    }
    obj.update(extra)
    return obj


MAP_OBJ = [
    # Aircraft: heading vectors are unit length, y grows southwards.
    _contact('aircraft', 'Fighter', 0.30, 0.28, BLUE, [23, 77, 255], dx=0.0, dy=-1.0),
    _contact('aircraft', 'Bomber', 0.52, 0.34, BLUE, [23, 77, 255], dx=1.0, dy=0.0),
    _contact('aircraft', 'Assault', 0.68, 0.62, RED, [250, 12, 0], dx=0.7071, dy=0.7071),
    _contact('aircraft', 'Fighter', 0.74, 0.30, RED, [250, 12, 0], dx=-0.5, dy=-0.87),
    _contact('aircraft', 'Assault', 0.24, 0.62, GREEN, [103, 215, 86], dx=0.87, dy=0.5),

    # Ground units, both teams, every icon kind the summary knows.
    _contact('ground_model', 'Player', 0.50, 0.50, GOLD, [250, 200, 30], dx=0.0, dy=-1.0),
    _contact('ground_model', 'LightTank', 0.46, 0.44, BLUE, [23, 77, 255]),
    _contact('ground_model', 'MediumTank', 0.54, 0.46, BLUE, [23, 77, 255]),
    _contact('ground_model', 'MediumTank', 0.56, 0.52, BLUE, [23, 77, 255]),
    _contact('ground_model', 'HeavyTank', 0.44, 0.52, RED, [250, 12, 0]),
    _contact('ground_model', 'HeavyTank', 0.40, 0.56, RED, [250, 12, 0]),
    _contact('ground_model', 'TankDestroyer', 0.48, 0.58, GREEN, [103, 215, 86]),
    _contact('ground_model', 'SPAA', 0.58, 0.40, BLUE, [23, 77, 255]),
    _contact('ground_model', 'SPAA', 0.62, 0.44, RED, [250, 12, 0]),
    _contact('ground_model', 'Airdefence', 0.42, 0.36, RED, [250, 12, 0]),
    _contact('ground_model', 'Structure', 0.38, 0.32, BLUE, [23, 77, 255]),

    # Static scenery.
    {'type': 'airfield', 'color': RED, 'color[]': [250, 12, 0], 'blink': 0,
     'icon': 'none', 'icon_bg': 'none',
     'sx': -1.087846, 'sy': -3.270975, 'ex': -0.719214, 'ey': -2.562839},
    {'type': 'airfield', 'color': BLUE, 'color[]': [23, 77, 255], 'blink': 0,
     'icon': 'none', 'icon_bg': 'none',
     'sx': 0.19, 'sy': 0.81, 'ex': 0.33, 'ey': 0.83},
    _contact('capture_zone', 'capture_zone', 0.5, 0.5, RED, [250, 12, 0],
             zone_id=0, zone_label='A', zone_label_code=65),
    _contact('respawn_base_tank', 'respawn_base_tank', 0.2, 0.2, RED, [250, 12, 0]),
    _contact('respawn_base_tank', 'respawn_base_tank', 0.8, 0.8, BLUE, [23, 77, 255]),
    _contact('respawn_base_fighter', 'respawn_base_fighter', 0.1, 0.9, RED, [250, 12, 0],
             dx=153.67, dy=257.65),
]

MISSION = {
    'objectives': [
        {'primary': True, 'status': 'in_progress',
         'text': 'Capture and maintain superiority over the points ╸,╹,╺'},
        {'primary': False, 'status': 'in_progress',
         'text': 'Destroy the enemy armoured column'},
    ],
    'status': 'running',
}

INDICATORS = {
    'valid': True,
    'army': 'tank',
    'type': 'tankModels/us_m4a2_sherman',
    'stabilizer': 1.0,
    'gear': 6.0,
    'gear_neutral': 1.0,
    'speed': 40.0,
    'has_speed_warning': 0.0,
    'rpm': 2475.0,
    'driving_direction_mode': 0.0,
    'cruise_control': 3.0,
    'lws': -1.0,
    'ircm': -1.0,
    'crew_total': 5.0,
    'crew_current': 5.0,
    'crew_distance': 1.0,
    'gunner_state': 1.0,
    'driver_state': 1.0,
}

STATE = {
    'valid': True,
    'H, m': 3240.5,
    'TAS, km/h': 412.0,
    'IAS, km/h': 388.0,
    'M': 0.42,
    'AoA, deg': 3.1,
    'throttle 1, %': 100.0,
    'RPM 1': 2750.0,
    'fuel, kg': 1840.0,
}

CHAT = [
    {'id': 1, 'msg': 'Air Alert! Azimuth 330, the altitude is about 1000',
     'sender': 'usatij_xren', 'enemy': False, 'mode': 'Team', 'time': 268},
    {'id': 14, 'msg': 'Air Alert! Azimuth 330, the altitude is about 400',
     'sender': 'usatij_xren', 'enemy': False, 'mode': 'Team', 'time': 305},
    {'id': 15, 'msg': 'Enemy spotted in sector C', 'sender': 'KRI3G',
     'enemy': False, 'mode': 'All', 'time': 412},
    {'id': 16, 'msg': 'Going for the capture point', 'sender': 'veenG_10',
     'enemy': False, 'mode': 'Squad', 'time': 505},
]

DAMAGE = [
    {'id': 225, 'msg': '[KRI3G] RCT1D (F6F-5) has achieved "Shadow strike streak: x5!"',
     'sender': '', 'enemy': False, 'mode': '', 'time': 522},
    {'id': 226, 'msg': 'Farioso (Churchill III) has achieved "Teamwork: x5"',
     'sender': '', 'enemy': False, 'mode': '', 'time': 522},
    {'id': 227, 'msg': 'RCT1D (F6F-5) shot down KZD veenG_10 (He 112 B)',
     'sender': '', 'enemy': False, 'mode': '', 'time': 900},
]

EVENTS = [
    {'id': 40, 'msg': 'Enemy aircraft detected', 'sender': '', 'enemy': True,
     'mode': '', 'time': 300},
    {'id': 41, 'msg': 'Ground target destroyed', 'sender': '', 'enemy': True,
     'mode': '', 'time': 480},
]