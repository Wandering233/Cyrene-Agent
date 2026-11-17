#!/usr/bin/env python3
"""Generate real relative motion at a verified test surface, without buttons."""
import json
import subprocess
import sys
import time
import evdev
from evdev import ecodes as e

target_x, target_y = map(int, sys.argv[1:])
with evdev.UInput({e.EV_REL: [e.REL_X, e.REL_Y], e.EV_KEY: [e.BTN_LEFT]},
                  name="Cyrene pointer motion regression") as mouse:
    time.sleep(0.4)
    for _ in range(80):
        pos = json.loads(subprocess.check_output(["hyprctl", "-i", __import__("os").environ["HYPRLAND_INSTANCE_SIGNATURE"], "-j", "cursorpos"], text=True))
        dx, dy = target_x - pos["x"], target_y - pos["y"]
        if abs(dx) <= 2 and abs(dy) <= 2:
            # Even a warp to the same point must be followed by a real motion event.
            mouse.write(e.EV_REL, e.REL_X, 1)
            mouse.syn()
            time.sleep(0.03)
            mouse.write(e.EV_REL, e.REL_X, -1)
            mouse.syn()
            break
        mouse.write(e.EV_REL, e.REL_X, max(-12, min(12, dx)))
        mouse.write(e.EV_REL, e.REL_Y, max(-12, min(12, dy)))
        mouse.syn()
        time.sleep(0.02)
    time.sleep(0.1)
