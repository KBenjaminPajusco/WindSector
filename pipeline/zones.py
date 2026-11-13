"""Zone definitions shared with the web app (src/zones.json) and the 3×3 sampling grid."""
import json
import math
import os

ZONES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "src", "zones.json"), encoding="utf-8"))


def zone_grid(z: dict, n: int = 3) -> tuple[list[float], list[float]]:
    """Same grid as zoneGrid() in src/forecast.ts (row-major from south-west)."""
    lats, lons = [], []
    for j in range(n):
        for i in range(n):
            dx = -z["halfKm"] + 2 * z["halfKm"] * i / (n - 1)
            dy = -z["halfKm"] + 2 * z["halfKm"] * j / (n - 1)
            lons.append(round(z["lon"] + dx / (111.32 * math.cos(math.radians(z["lat"]))), 4))
            lats.append(round(z["lat"] + dy / 110.57, 4))
    return lats, lons
