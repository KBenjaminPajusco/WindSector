#!/usr/bin/env python3
"""Ingest raw fine-mesh GRIB2 files (e.g. Météo-France AROME 0.01° "SP1" package, or any GRIB with
10 m wind u/v) into the per-zone analog archive used by the web app.

Use this to build your own long archive from GRIB files you download over time (Météo-France public
API https://portail-api.meteofrance.fr — free key — or meteo.data.gouv.fr), instead of / in addition to
the Open-Meteo archive. Each GRIB step becomes one hourly sample; the analysis step (+1 h…+6 h) of
successive runs is kept, later runs overwrite earlier ones for the same valid time.

  pip install xarray cfgrib numpy
  python3 pipeline/grib_to_analogdb.py path/to/*.grib2 [--max-lead 6]

The output (public/data/analogs/<zone>.json) is merged with any existing file.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

from zones import ZONES, zone_grid

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "analogs")
MS_TO_KT = 1.943844


def open_wind(path: str):
    import xarray as xr  # noqa: PLC0415

    for flt in ({"typeOfLevel": "heightAboveGround", "level": 10}, {"shortName": "10u"}, {}):
        try:
            ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"filter_by_keys": flt, "indexpath": ""})
        except Exception:  # noqa: BLE001
            continue
        u = next((ds[k] for k in ("u10", "u", "10u") if k in ds), None)
        v = next((ds[k] for k in ("v10", "v", "10v") if k in ds), None)
        if u is not None and v is not None:
            return ds, u, v
    raise ValueError(f"no 10 m wind in {path}")


def main():
    import numpy as np  # noqa: PLC0415

    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--max-lead", type=int, default=6, help="keep forecast steps <= N hours")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)

    # zone -> {valid_ms: (lead_h, [speed...], [dir...])}
    acc: dict[str, dict[int, tuple]] = {z["id"]: {} for z in ZONES}
    for path in args.files:
        try:
            ds, u, v = open_wind(path)
        except Exception as e:  # noqa: BLE001
            print(f"skip {path}: {e}", file=sys.stderr)
            continue
        lat = ds["latitude"].values
        lon = ds["longitude"].values
        lon = np.where(lon > 180, lon - 360, lon)
        steps = ds["step"].values if "step" in ds.dims else [ds["step"].values]
        run = ds["time"].values
        for si, step in enumerate(np.atleast_1d(steps)):
            lead_h = int(np.timedelta64(step, "h").astype(int))
            if lead_h > args.max_lead:
                continue
            valid = int((run + step).astype("datetime64[ms]").astype(np.int64))
            uu = u.isel(step=si).values if "step" in u.dims else u.values
            vv = v.isel(step=si).values if "step" in v.dims else v.values
            for z in ZONES:
                lats, lons = zone_grid(z)
                sp, dd = [], []
                for la, lo in zip(lats, lons):
                    if lat.ndim == 1:  # regular lat/lon grid (AROME 0.01°/0.025°)
                        idx = (int(np.abs(lat - la).argmin()), int(np.abs(lon - lo).argmin()))
                    else:  # projected grid with 2-D coordinates
                        d2 = (lat - la) ** 2 + ((lon - lo) * math.cos(math.radians(la))) ** 2
                        idx = np.unravel_index(int(d2.argmin()), d2.shape)
                    a, b = float(uu[idx]), float(vv[idx])
                    if math.isnan(a) or math.isnan(b):
                        sp.append(None)
                        dd.append(None)
                        continue
                    sp.append(round(math.hypot(a, b) * MS_TO_KT, 1))
                    dd.append(round((math.degrees(math.atan2(-a, -b)) + 360) % 360))
                prev = acc[z["id"]].get(valid)
                if prev is None or lead_h <= prev[0]:
                    acc[z["id"]][valid] = (lead_h, sp, dd)
        print(f"read {path}", file=sys.stderr)

    for z in ZONES:
        new = acc[z["id"]]
        if not new:
            continue
        path = os.path.join(OUT, f"{z['id']}.json")
        merged: dict[int, tuple] = {}
        if os.path.exists(path):
            old = json.load(open(path))
            for k, t in enumerate(old["times"]):
                merged[t] = ([s[k] for s in old["speed"]], [d[k] for d in old["dir"]])
        for t, (_, sp, dd) in new.items():
            merged[t] = (sp, dd)
        ts = sorted(merged)
        # Fill hourly gaps with nulls so the series stays regular.
        full = list(range(ts[0], ts[-1] + 1, 3600_000))
        P = len(zone_grid(z)[0])
        speed = [[merged[t][0][p] if t in merged else None for t in full] for p in range(P)]
        dirs = [[merged[t][1][p] if t in merged else None for t in full] for p in range(P)]
        lats, lons = zone_grid(z)
        json.dump({"times": full, "speed": speed, "dir": dirs, "gust": [], "model": "grib_local",
                   "grid": {"lats": lats, "lons": lons}}, open(path, "w"), separators=(",", ":"))
        print(f"{z['id']}: {len(full)} h", file=sys.stderr)


if __name__ == "__main__":
    main()
