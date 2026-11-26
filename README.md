# GE Flip Planner

A small site that answers "I have this much cash and this many free Grand
Exchange slots, what do I buy?" for Old School RuneScape, with exact offer
prices.

It looks for three kinds of trade and ranks whatever fits your cash and slots:

- **Packing a set**: bid for the pieces, pack them at a GE clerk, sell the set.
- **Unpacking a set**: buy the set, unpack it, sell the pieces.
- **Plain flips**: buy at the instant-sell price, sell at the instant-buy price.

The "How it works" tab on the site explains the checks each option has to pass.

## How it stays current

- `scripts/scrape.py` pulls 24 hours of hourly prices and 10 days of daily
  prices for every item from the [OSRS Wiki prices API](https://prices.runescape.wiki)
  and writes `site/data.json`. A GitHub Actions workflow
  (`.github/workflows/refresh.yml`) runs it every 4 hours.
- The page also fetches live prices from the same API each time it is opened,
  so the offer prices are current even between runs.

## Layout

| Path | What it is |
|---|---|
| `site/core.js` | All the trade maths: tax, offer prices, the checks, the planner |
| `site/app.js`, `site/index.html`, `site/style.css` | The page |
| `scripts/scrape.py` | Builds `site/data.json` (Python standard library only) |
| `scripts/build_sets.py` | Rebuilds `sets.json`, the list of sets and their pieces, from the Wiki |
| `scripts/preview.js` | Prints the planner's picks in a terminal |

## Running it yourself

```bash
python3 scripts/scrape.py
python3 -m http.server 8765 --directory site
```

Then open http://localhost:8765. To see the picks without a browser:

```bash
node scripts/preview.js 46m 2 8
```

The arguments are cash, free slots, and hours between check-ins.

When the game adds a new item set, run `python3 scripts/build_sets.py` and
commit the updated `sets.json`.

## Notes

- Nothing typed into the page leaves the browser. Cash, slots and hidden
  options are stored on that device only.
- The site only suggests trades. Offers are placed by hand in game.
