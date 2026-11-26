#!/usr/bin/env python3
"""Build sets.json: every Grand Exchange item set and the pieces it packs/unpacks into.

Reads the set pages on the OSRS Wiki (the {{CostLine|...}} rows of each set's
Components table) and keeps only sets whose pieces are all tradeable.
Run by hand when the game adds a new set:  python3 scripts/build_sets.py
"""
import json, re, sys, time, urllib.parse, urllib.request, pathlib

UA = "ge-flip-dashboard/1.0 (item set list builder)"
ROOT = pathlib.Path(__file__).resolve().parent.parent

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def main():
    mapping = get("https://prices.runescape.wiki/api/v1/osrs/mapping")
    by_name = {m["name"]: m for m in mapping}
    cands = [m["name"] for m in mapping if re.search(r"\bset\b", m["name"], re.I)]
    sets, skipped = [], []
    for i in range(0, len(cands), 40):
        batch = cands[i:i + 40]
        q = urllib.parse.urlencode({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                                    "titles": "|".join(batch), "format": "json", "formatversion": "2", "redirects": "1"})
        d = get("https://oldschool.runescape.wiki/api.php?" + q)
        back = {}
        for k in ("normalized", "redirects"):
            for r in d["query"].get(k, []):
                back[r["to"]] = back.get(r["from"], r["from"])
        for page in d["query"]["pages"]:
            name = back.get(page["title"], page["title"])
            if name not in by_name:
                name = page["title"]
            if "revisions" not in page or name not in by_name:
                skipped.append((name, "no page")); continue
            text = page["revisions"][0]["slots"]["main"]["content"]
            if "Grand Exchange clerk" not in text and "item set" not in text.lower():
                skipped.append((name, "not an item set")); continue
            parts = []
            for row in re.findall(r"\{\{CostLine\|([^}]*)\}\}", text):
                args = [a.strip() for a in row.split("|")]
                pos = [a for a in args if "=" not in a]
                kw = dict(a.split("=", 1) for a in args if "=" in a)
                qty = 1
                for cand in pos[1:2] + [kw.get("quantity", ""), kw.get("qty", "")]:
                    if cand.replace(",", "").isdigit():
                        qty = int(cand.replace(",", ""))
                parts.append((pos[0], qty))
            if len(parts) < 2:
                skipped.append((name, "no components table")); continue
            missing = [p for p, _ in parts if p not in by_name]
            if missing:
                skipped.append((name, "untradeable or unknown piece: " + ", ".join(missing))); continue
            sets.append({"id": by_name[name]["id"], "name": name,
                         "parts": [{"id": by_name[p]["id"], "name": p, "qty": q} for p, q in parts]})
        time.sleep(0.5)
    sets.sort(key=lambda s: s["name"])
    (ROOT / "sets.json").write_text(json.dumps(sets, indent=1) + "\n")
    print(f"{len(sets)} sets written, {len(skipped)} skipped", file=sys.stderr)
    for s in skipped:
        print("  skipped:", *s, file=sys.stderr)

if __name__ == "__main__":
    main()
