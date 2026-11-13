#!/usr/bin/env python3
"""Pre-build the fine-mesh historical archive used for analogs, one file per zone.

Source: Open-Meteo "Historical Forecast API", which archives every run of the Météo-France
AROME GRIB2 output (AROME HD 0.01° ≈ 1.5 km, fallback AROME 0.025°) as a continuous hourly series.
Writes public/data/analogs/<zone>.json in the format read by src/forecast.ts (WindSeries).
Without these files the web app fetches the same data live and caches it in the browser.

Usage: python3 pipeline/build_analog_db.py [--start 2023-01-01] [--zones rade-sud,frioul]
Standard library only. Respect Open-Meteo's fair use (≈ 10 000 calls/day, 600/min).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta

from zones import ZONES, zone_grid

API = "https://historical-forecast-api.open-meteo.com/v1/forecast"
MODELS = ["meteofrance_arome_france_hd", "meteofrance_arome_france"]
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "analogs")


def get(url: str, tries: int = 5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            wait = 20 * (i + 1)
            print(f"  {e} — retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed: {url[:120]}")


def fetch(lats, lons, model, start, end):
    q = urllib.parse.urlencode({
        "latitude": ",".join(map(str, lats)), "longitude": ",".join(map(str, lons)),
        "hourly": "wind_speed_10m,wind_direction_10m", "models": model, "wind_speed_unit": "kn",
        "timeformat": "unixtime", "cell_selection": "sea", "start_date": start, "end_date": end,
    })
    res = get(f"{API}?{q}")
    return res if isinstance(res, list) else [res]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2023-01-01")
    ap.add_argument("--zones", default="")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    end = (date.today() - timedelta(days=2)).isoformat()
    wanted = set(filter(None, args.zones.split(",")))
    for z in ZONES:
        if wanted and z["id"] not in wanted:
            continue
        lats, lons = zone_grid(z)
        for model in MODELS:
            times, speed, dirs = [], [[] for _ in lats], [[] for _ in lats]
            y0, y1 = int(args.start[:4]), int(end[:4])
            for y in range(y0, y1 + 1):
                s = args.start if y == y0 else f"{y}-01-01"
                e = end if y == y1 else f"{y}-12-31"
                print(f"{z['id']} {model} {s}..{e}", file=sys.stderr)
                res = fetch(lats, lons, model, s, e)
                times += [t * 1000 for t in res[0]["hourly"]["time"]]
                for p, r in enumerate(res):
                    speed[p] += r["hourly"]["wind_speed_10m"]
                    dirs[p] += r["hourly"]["wind_direction_10m"]
                time.sleep(2)
            mid = speed[len(speed) // 2]
            if sum(v is None for v in mid) > len(mid) / 2:
                print(f"  {model}: mostly empty, trying next model", file=sys.stderr)
                continue
            data = {"times": times, "speed": speed, "dir": dirs, "gust": [], "model": model,
                    "grid": {"lats": lats, "lons": lons}}
            with open(os.path.join(OUT, f"{z['id']}.json"), "w") as f:
                json.dump(data, f, separators=(",", ":"))
            break


if __name__ == "__main__":
    main()
