#!/usr/bin/env python3
"""Pull Grand Exchange price history from the OSRS Wiki prices API and boil it
down to site/data.json, the one file the site reads.

`hours` holds the last 24 complete hours, newest first. Each is a map of
item id -> [avg instant-sell price, avg instant-buy price, sold-into-bids count, bought-from-asks count].
`lastHour` is when the newest of them ended. The page adds any later hours
itself, straight from the API, so it does not depend on this script running on time.

What it collects for every traded item:
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
import json, pathlib, sys, time, urllib.request

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


def main():
    now = int(time.time())
    mapping = get("mapping")
    latest = get("latest")["data"]

    last_hour = (now // 3600) * 3600 - 3600          # start of the last complete hour
    newest = get(f"1h?timestamp={last_hour}")["data"]
    if len(newest) < 500:                             # just after the hour, before the API has published it
        last_hour -= 3600
        newest = get(f"1h?timestamp={last_hour}")["data"]
    hourly = [newest]                                 # newest first
    for i in range(1, HOURS):
        time.sleep(0.25)
        hourly.append(get(f"1h?timestamp={last_hour - i * 3600}")["data"])

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
        ds = [d.get(sid) or {} for d in daily]
        week = ds[-7:]
        lt = latest.get(sid) or {}
        items[sid] = {
            "n": m["name"],
            "l": m.get("limit"),
            "d": [d.get("avgHighPrice") or 0 for d in ds],
            "e": [d.get("avgLowPrice") or 0 for d in ds],
            "dv": [round(sum(d.get("lowPriceVolume") or 0 for d in week) / 7),
                   round(sum(d.get("highPriceVolume") or 0 for d in week) / 7)],
            "p": [lt.get("high") or 0, lt.get("highTime") or 0, lt.get("low") or 0, lt.get("lowTime") or 0],
        }

    sets = json.loads((ROOT / "sets.json").read_text())
    sets = [s for s in sets if str(s["id"]) in items and all(str(p["id"]) in items for p in s["parts"])]

    hours = [{sid: [h.get("avgLowPrice") or 0, h.get("avgHighPrice") or 0, h.get("lowPriceVolume") or 0, h.get("highPriceVolume") or 0]
              for sid, h in hour.items() if sid in items} for hour in hourly]

    out = {"generated": now, "lastHour": last_hour + 3600, "lastDay": last_day, "hours": hours, "items": items, "sets": sets}
    dest = ROOT / "site" / "data.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(items)} items, {len(sets)} sets, {dest.stat().st_size / 1e6:.2f} MB -> {dest}", file=sys.stderr)
    if len(items) < 3000 or len(sets) < 100:
        sys.exit("data looks incomplete; refusing to publish it")


if __name__ == "__main__":
    main()
