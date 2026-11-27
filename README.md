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

- `scripts/scrape.py` pulls the last 24 complete hours of prices and 10 days of
  daily prices for every item from the [OSRS Wiki prices API](https://prices.runescape.wiki)
  and writes `site/data.json`. A GitHub Actions workflow
  (`.github/workflows/refresh.yml`) runs it every hour.
- GitHub starts scheduled runs late and sometimes skips one, so the page does
  not depend on that. Whenever `data.json` stops short of the last complete
  hour, the page fetches the missing hours from the API itself and works out
  the same summary (`addHour` and `summarise` in `site/core.js`).
- Live prices are checked every minute while the page is on screen, and again
  whenever you return to it.

## How the rules were tested

`scripts/backtest.js` replays the planner against real hourly trading. For every
4 hours in the downloaded history it rebuilds exactly what the site would have
known, asks `site/core.js` for its plan, then walks forward hour by hour to see
what would have filled and sold.

```bash
python3 scripts/fetch_history.py hist 21
```

```bash
node scripts/backtest.js hist
```

Run it again with `SHARE=0.25` in front to assume you catch a quarter of the
market's flow instead of half. Over 5-26 November 2026 plans at the default 8%
minimum return made 55-80% of the all-fills profit figure and lost money in
about 1 round in 20. Options that fail the checks lost money overall. The 5%
return floor, the conservative profit figure and the type weights in
`site/core.js` all come from this replay, so re-run it before changing them.

## Layout

| Path | What it is |
|---|---|
| `site/core.js` | All the trade maths: tax, offer prices, the checks, the planner |
| `site/app.js`, `site/index.html`, `site/style.css` | The page |
| `scripts/scrape.py` | Builds `site/data.json` (Python standard library only) |
| `scripts/build_sets.py` | Rebuilds `sets.json`, the list of sets and their pieces, from the Wiki |
| `scripts/preview.js` | Prints the planner's picks in a terminal |
| `scripts/fetch_history.py`, `scripts/backtest.js` | Download past prices and replay the planner against them |

## Running it yourself

```bash
python3 scripts/scrape.py
python3 -m http.server 8765 --directory site
```

Then open http://localhost:8765. To see the picks without a browser:

```bash
node scripts/preview.js 46m 2 8
```

The arguments are cash, free slots, hours between check-ins, and optionally the minimum return in percent.

When the game adds a new item set, run `python3 scripts/build_sets.py` and
commit the updated `sets.json`.

## Notes

- Nothing typed into the page leaves the browser. Cash, slots and hidden
  options are stored on that device only.
- The site only suggests trades. Offers are placed by hand in game.
