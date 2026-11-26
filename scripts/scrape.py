#!/usr/bin/env python3
"""Pull Grand Exchange price history from the OSRS Wiki prices API and boil it
down to site/data.json, the one file the site reads.

What it collects for every traded item:
  w   three time windows (last 4h, 4-12h ago, 12-24h ago), each
      [avg instant-sell price, avg instant-buy price, sold-into-bids count, bought-from-asks count]
  m   [median hourly instant-buy price, median hourly instant-sell price] over the last 6 trading hours
  r   24h range of hourly prices [min buy, max buy, min sell, max sell]
  v   24h volume [sold into bids, bought from asks]
  d   10 daily average instant-buy prices, oldest first (0 = no trades that day)
  e   10 daily average instant-sell prices, oldest first
  dv  7-day average daily volume [sold into bids, bought from asks]
  p   latest trade [buy price, buy time, sell price, sell time] at scrape time

"Instant-buy price" (the API's `high`) is what impatient buyers pay, so it is
where a sell offer fills. "Instant-sell price" (`low`) is what impatient
sellers accept, so it is where a buy offer fills.

No scoring happens here. The site does all trade maths in site/core.js so the
rules live in one place.

Standard library only:  python3 scripts/scrape.py
"""
import json, pathlib, statistics, sys, time, urllib.request

API = "https://prices.runescape.wiki/api/v1/osrs"
UA = "ge-flip-dashboard/1.0 (scheduled price summary)"
ROOT = pathlib.Path(__file__).resolve().parent.parent
HOURS, DAYS = 24, 10


def get(path, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(f"{API}/{path}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # network hiccup: back off and retry
            if attempt == tries - 1:
                raise
            print(f"retry {path}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))


def vwap(buckets, price_key, vol_key):
    vol = sum(b.get(vol_key) or 0 for b in buckets)
    if not vol:
        return 0, 0
    total = sum((b.get(price_key) or 0) * (b.get(vol_key) or 0) for b in buckets)
    return round(total / vol), vol


def main():
    now = int(time.time())
    mapping = get("mapping")
    latest = get("latest")["data"]

    last_hour = (now // 3600) * 3600 - 3600          # start of the last complete hour
    hourly = []                                       # newest first
    for i in range(HOURS):
        hourly.append(get(f"1h?timestamp={last_hour - i * 3600}")["data"])
        time.sleep(0.25)

    last_day = (now // 86400) * 86400 - 86400         # start of the last complete UTC day
    daily = []                                        # oldest first
    for i in range(DAYS - 1, -1, -1):
        daily.append(get(f"24h?timestamp={last_day - i * 86400}")["data"])
        time.sleep(0.25)

    items = {}
    for m in mapping:
        sid = str(m["id"])
        hs = [h.get(sid) or {} for h in hourly]
        if not any(hs) and sid not in latest:
            continue
        windows = []
        for a, b in ((0, 4), (4, 12), (12, 24)):
            lo, lv = vwap(hs[a:b], "avgLowPrice", "lowPriceVolume")
            hi, hv = vwap(hs[a:b], "avgHighPrice", "highPriceVolume")
            windows.append([lo, hi, lv, hv])
        his = [h["avgHighPrice"] for h in hs if h.get("avgHighPrice")]
        los = [h["avgLowPrice"] for h in hs if h.get("avgLowPrice")]
        ds = [d.get(sid) or {} for d in daily]
        week = ds[-7:]
        lt = latest.get(sid) or {}
        items[sid] = {
            "n": m["name"],
            "l": m.get("limit"),
            "w": windows,
            "m": [round(statistics.median(his[:6])) if his else 0, round(statistics.median(los[:6])) if los else 0],
            "r": [min(his) if his else 0, max(his) if his else 0, min(los) if los else 0, max(los) if los else 0],
            "v": [sum(h.get("lowPriceVolume") or 0 for h in hs), sum(h.get("highPriceVolume") or 0 for h in hs)],
            "d": [d.get("avgHighPrice") or 0 for d in ds],
            "e": [d.get("avgLowPrice") or 0 for d in ds],
            "dv": [round(sum(d.get("lowPriceVolume") or 0 for d in week) / 7),
                   round(sum(d.get("highPriceVolume") or 0 for d in week) / 7)],
            "p": [lt.get("high") or 0, lt.get("highTime") or 0, lt.get("low") or 0, lt.get("lowTime") or 0],
        }

    sets = json.loads((ROOT / "sets.json").read_text())
    sets = [s for s in sets if str(s["id"]) in items and all(str(p["id"]) in items for p in s["parts"])]

    out = {"generated": now, "lastHour": last_hour + 3600, "lastDay": last_day, "items": items, "sets": sets}
    dest = ROOT / "site" / "data.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(items)} items, {len(sets)} sets, {dest.stat().st_size / 1e6:.2f} MB -> {dest}", file=sys.stderr)
    if len(items) < 3000 or len(sets) < 100:
        sys.exit("data looks incomplete; refusing to publish it")


if __name__ == "__main__":
    main()
