#!/usr/bin/env python3
"""Build static JSON for Météo-France public anemometers around Marseille.

Source: "Données climatologiques de base - horaires" (Météo-France, Licence Ouverte),
https://www.data.gouv.fr/fr/datasets/donnees-climatologiques-de-base-horaires/
The "latest" file is refreshed daily (values up to the current morning UTC).
The S3 bucket does not send CORS headers, so the browser cannot read it directly:
this script runs at build time (GitHub Action) and writes:

  public/data/mf/stations.json          station list + last 72 h of wind
  public/data/mf/history/<id>.json      hourly wind since 2020 (analog "vécu")

Usage:  python3 pipeline/fetch_meteofrance.py [--cache DIR] [--no-history]
Only the Python standard library is required.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

BASE = "https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BASE/HOR"
DEPARTMENTS = ["13", "83"]
# Bounding box of interest (Marseille + neighbouring coast).
BBOX = (42.95, 4.80, 43.65, 6.00)  # lat_min, lon_min, lat_max, lon_max
HISTORY_START = "2020010100"
RECENT_HOURS = 72
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "mf")


def download(name: str, cache: str, refresh: bool) -> str:
    path = os.path.join(cache, name)
    if os.path.exists(path) and not refresh:
        return path
    url = f"{BASE}/{name}"
    print(f"download {url}", file=sys.stderr)
    tmp = path + ".part"
    try:
        with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    except OSError as e:
        if os.path.exists(path):
            print(f"  failed ({e}); using cached copy", file=sys.stderr)
            return path
        raise
    os.replace(tmp, path)
    return path


def num(v: str):
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def hour_index(stamp: str) -> int:
    """AAAAMMJJHH (UTC) -> hours since epoch."""
    dt = datetime(int(stamp[0:4]), int(stamp[4:6]), int(stamp[6:8]), int(stamp[8:10]), tzinfo=timezone.utc)
    return int(dt.timestamp() // 3600)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.environ.get("MF_CACHE", "/tmp/mf"))
    ap.add_argument("--no-history", action="store_true", help="skip the 2020-2024 archive")
    ap.add_argument("--refresh-archive", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(os.path.join(OUT, "history"), exist_ok=True)

    files = []
    for d in DEPARTMENTS:
        if not args.no_history:
            files.append(download(f"H_{d}_previous-2020-2024.csv.gz", args.cache, args.refresh_archive))
        files.append(download(f"H_{d}_latest-2025-2026.csv.gz", args.cache, True))

    start_h = hour_index(HISTORY_START)
    stations: dict[str, dict] = {}
    series: dict[str, dict[int, tuple]] = {}
    for path in files:
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f, delimiter=";")
            head = next(reader)
            ix = {k: head.index(k) for k in ("NUM_POSTE", "NOM_USUEL", "LAT", "LON", "ALTI", "AAAAMMJJHH", "FF", "DD", "FXI", "FXY", "DXI")}
            for row in reader:
                ff = row[ix["FF"]]
                if ff == "":
                    continue
                lat, lon = float(row[ix["LAT"]]), float(row[ix["LON"]])
                if not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
                    continue
                stamp = row[ix["AAAAMMJJHH"]]
                if stamp < HISTORY_START:
                    continue
                sid = row[ix["NUM_POSTE"]]
                stations.setdefault(sid, {
                    "id": sid, "name": row[ix["NOM_USUEL"]].title(), "lat": lat, "lon": lon,
                    "alt": int(float(row[ix["ALTI"]] or 0)), "source": "meteofrance",
                })
                fxi = num(row[ix["FXI"]])
                if fxi is None:
                    fxi = num(row[ix["FXY"]])
                series.setdefault(sid, {})[hour_index(stamp)] = (num(ff), num(row[ix["DD"]]), fxi)

    out_list = []
    for sid, st in stations.items():
        ser = series[sid]
        hours = sorted(ser)
        last_h = hours[-1]
        recent = [[h, *ser[h]] for h in hours if h > last_h - RECENT_HOURS]
        st["last"] = {"t": last_h * 3600, "ff": ser[last_h][0], "dd": ser[last_h][1], "fxi": ser[last_h][2]}
        # Values: m/s with 1 decimal; direction in degrees.
        st["recent"] = recent
        st["units"] = {"speed": "m/s", "time": "hours since epoch (UTC)"}
        first_h = max(hours[0], start_h)
        n = last_h - first_h + 1
        ff, dd, fx = [None] * n, [None] * n, [None] * n
        for h in hours:
            if h < first_h:
                continue
            a, b, c = ser[h]
            i = h - first_h
            ff[i] = None if a is None else round(a * 10)
            dd[i] = None if b is None else int(b)
            fx[i] = None if c is None else round(c * 10)
        st["history"] = {"from": first_h, "to": last_h, "count": len(hours)}
        with open(os.path.join(OUT, "history", f"{sid}.json"), "w") as f:
            json.dump({"id": sid, "t0": first_h, "scale": {"ff": 0.1, "fxi": 0.1}, "unit": "m/s",
                       "ff": ff, "dd": dd, "fxi": fx}, f, separators=(",", ":"))
        out_list.append(st)

    out_list.sort(key=lambda s: s["lon"])
    with open(os.path.join(OUT, "stations.json"), "w") as f:
        json.dump({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "source": "Météo-France — Données climatologiques de base horaires (Licence Ouverte)",
                   "stations": out_list}, f, separators=(",", ":"))
    print(f"{len(out_list)} stations written to {os.path.abspath(OUT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
