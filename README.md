# Bulk Commander Builder (MTG)

Turn your pile of extra Magic: The Gathering cards into Commander decks, in the spirit of BuiltFromBulk.
Import your collection, and the app ranks commanders by how much of their deck you already own. It then builds a 100-card deck from your free cards and explains every pick. It also writes a game plan and finds combos you can assemble.

It is a static site with no build step and no server. Your collection and decks stay in your browser (IndexedDB).

## Data sources

| Source | Used for | How |
|---|---|---|
| [Scryfall](https://scryfall.com) | Card data, images, prices, Game Changers list | Live, from the browser (cached) |
| [EDHREC](https://edhrec.com) | Which cards each commander's decks play (inclusion %, synergy), strategies, power-bracket pages | Live, from the browser (cached 7 days). The 1,000 most popular commanders are also summarized weekly in `data/commanders.json`, so ranking against your collection is instant |
| [Commander Spellbook](https://commanderspellbook.com) | ~117,000 Commander-legal combos | Downloaded weekly into `data/combos.json`. Spellbook's API doesn't accept requests from other websites, so the browser can't call it directly |

`scripts/update-data.mjs` builds the `data/` files. The **Update combo & commander data** GitHub Action (`.github/workflows/update-data.yml`) runs it every Monday and commits any changes. You can also run it by hand from the Actions tab.

## Features

- **Import:** ManaBox CSV (matched by Scryfall ID). Most other scanner CSVs work too, and so does a pasted list (`1 Sol Ring`, `1x Sol Ring (C21) 263`, `Sol Ring`). Large piles (10k+) are fine.
- **Commander finder:** 1,000 popular commanders plus every legend you own, ranked by how many of each commander's 100 most-played cards (on EDHREC) you have free. Each tile also shows whether you own the commander itself.
- **Strategy and power bracket:** pick one of the EDHREC strategies for that commander (Tokens, +1/+1 Counters…) and a bracket from 1 (Exhibition) to 5 (cEDH). The bracket controls:
  - how many Game Changers can be included (none in brackets 1–2, up to 3 in bracket 3);
  - how many combos are added on purpose, and how strong they can be (using Spellbook's own bracket tags);
  - whether mass land denial and extra-turn cards are allowed.
- **Deck builder:** cards are scored mainly by EDHREC inclusion and synergy for that commander (or that strategy or bracket page). The builder also:
  - adds combos that fit the bracket;
  - balances the mana curve and the counts of ramp, card draw, removal and board wipes;
  - picks on-color nonbasic lands and fills the rest with basics.
- **Explanations:** every card says why it's in the deck. For example: "Played in 64% of 46,165 Atraxa decks on EDHREC (synergy +22%). Role: Ramp. Combo with Basalt Monolith: Infinite colorless mana."
- **Game plan:** a short guide to the deck's idea, early turns, engine cards, how it wins (combo or closers) and interaction, built from the deck's own cards.
- **Combos page:** every combo you can build from your collection, and every combo you're one card away from, with the missing card's price. You can filter by colors, bracket and text.
- **Upgrade a deck or precon:** paste a decklist. You get swaps (cut a rarely played card, add a free card from your bulk that many decks play), then save the upgraded deck.
- **Physical copy tracking:** a copy used in one deck isn't available to other decks. Cards from a pasted deck count as that deck's own cards, not your bulk's.
- **Export** as `1 Card Name (SET) 123` (Moxfield, Archidekt, Arena), and **back up or restore** everything as JSON.

## Run it

```sh
npm start            # python3 -m http.server 8080 → http://localhost:8080
```

Opening `index.html` straight from disk won't work, because ES modules need `http://`.

**GitHub Pages:** Settings → Pages → *Deploy from a branch*, then pick the branch and `/ (root)`. Pages compresses the 9 MB combo file to about 2 MB, and it's loaded only when needed.

**Refresh data:** `node scripts/update-data.mjs` takes about 15 minutes. Behind a proxy, use `NODE_USE_ENV_PROXY=1`.

## Project layout

```
index.html, css/style.css
js/app.js              router, backup dialog
js/views/*.js          Collection, Build, Combos, Upgrade, My decks, Deck editor, card dialog
js/builder.js          Commander rules, brackets, scoring, deck construction, explanations, game plan, upgrades
js/edhrec.js           EDHREC client (live, cached)
js/data.js             loads data/*.json; combo matching; collection coverage
js/engine.js           glue: loads EDHREC/combos/Game Changers and runs the builder
js/cards.js            card trimming, mana parsing, roles, themes, name keys
js/csv.js              CSV and pasted-list parsing
js/scryfall.js         batched Scryfall client
js/store.js, db.js     state and IndexedDB persistence
scripts/update-data.mjs  weekly data download
tests/                 unit tests (node --test) and a Playwright end-to-end test
```

## Tests

```sh
npm test             # unit tests
npm run test:e2e     # browser test with Scryfall, EDHREC and data files mocked (needs Playwright + Chromium)
```

Card data and images © Wizards of the Coast, served by Scryfall. EDHREC and Commander Spellbook data belong to their owners, and this project links back to them. This project is not affiliated with Wizards of the Coast, EDHREC, Commander Spellbook or BuiltFromBulk.
