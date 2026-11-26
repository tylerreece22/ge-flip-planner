#!/usr/bin/env python3
"""Download hourly and daily price history for the replay in scripts/backtest.js.

    python3 scripts/fetch_history.py hist 21

saves one file per hour for the last 21 days (plus the daily files the 7-day
checks need) into ./hist, which is ignored by git. It skips files it already
has, so it can be re-run to top the folder up. About 550 requests, a few minutes.
"""
import pathlib, sys, time, urllib.request

API = "https://prices.runescape.wiki/api/v1/osrs"
UA = "ge-flip-dashboard/1.0 (one-off history download for a backtest)"


def get(path):
    for attempt in range(5):
        try:
            req = urllib.request.Request(f"{API}/{path}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:
            print(f"retry {path}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise SystemExit("gave up on " + path)


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "hist")
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 21
    out.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    last_hour = (now // 3600) * 3600 - 3600
    last_day = (now // 86400) * 86400 - 86400
    (out / "mapping.json").write_bytes(get("mapping"))
    wanted = [(f"24h_{last_day - i * 86400}.json", f"24h?timestamp={last_day - i * 86400}") for i in range(days + 14)]
    wanted += [(f"1h_{last_hour - i * 3600}.json", f"1h?timestamp={last_hour - i * 3600}") for i in range(days * 24)]
    fetched = 0
    for name, path in wanted:
        f = out / name
        if f.exists():
            continue
        f.write_bytes(get(path))
        fetched += 1
        if fetched % 100 == 0:
            print(f"{fetched} files", file=sys.stderr)
        time.sleep(0.25)
    print(f"done: {fetched} new files in {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
