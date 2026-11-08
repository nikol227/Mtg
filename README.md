# Bulk Commander Builder (MTG)

Turn your pile of extra Magic: The Gathering cards into Commander decks, in the spirit of BuiltFromBulk.
Import your collection, and the app ranks commanders by how much of their deck you already own. It then builds a 100-card deck from your free cards and explains every pick. It also writes a game plan and finds combos you can assemble.

It is a static site with no build step and no server. Your collection and decks stay in your browser (IndexedDB).

## Data sources

| Source | Used for | How |
|---|---|---|
| [Scryfall](https://scryfall.com) | Card data, images, prices, Game Changers list | Live, from the browser (cached) |
| [EDHREC](https://edhrec.com) | Which cards each commander's decks play (inclusion %, synergy), strategies, power-bracket pages | Live, from the browser (cached 7 days). The ~900 most popular commanders are also summarized weekly in `data/commanders.json`, so ranking against your collection is instant |
| [Commander Spellbook](https://commanderspellbook.com) | ~117,000 Commander-legal combos | Downloaded weekly into `data/combos.json`. Spellbook's API doesn't accept requests from other websites, so the browser can't call it directly |

`scripts/update-data.mjs` builds the `data/` files. The **Update combo & commander data** GitHub Action (`.github/workflows/update-data.yml`) runs it every Monday and commits any changes. You can also run it by hand from the Actions tab.

## Features

- **Import:** ManaBox CSV (matched by Scryfall ID). Most other scanner CSVs work too, and so does a pasted list (`1 Sol Ring`, `1x Sol Ring (C21) 263`, `Sol Ring`). Large piles (10k+) are fine.
- **Commander finder:** 900 popular commanders plus every legend you own. Each tile shows:
  - how many **eligible spells** you have for it (free, Commander-legal non-land cards within its colors) out of the 63 a deck needs, with a warning when the pile is too thin ("needs ~40 more BG spells");
  - how many of its 100 most-played cards on EDHREC you own;
  - whether you own the commander itself.

  Commanders your pile can actually fill rank higher.
- **Strategy and power bracket:** pick one of the EDHREC strategies for that commander (Tokens, +1/+1 Counters…) and a bracket from 1 (Exhibition) to 5 (cEDH). The bracket controls:
  - how many Game Changers can be included (none in brackets 1–2, up to 3 in bracket 3);
  - how many combos are added on purpose, and how strong they can be (using Spellbook's own bracket tags);
  - whether mass land denial and extra-turn cards are allowed.
- **Before you build:**
  - brackets your collection probably can't reach are flagged ⚠, based on the Game Changers and combos you own;
  - a one-line summary rates your support for the chosen strategy and bracket ("thin / some / steady / strong");
  - "Strong fits from your bulk" previews your best cards for that build.
- **Optional build settings:** fill gaps with recommended cards to buy or with basic lands; set the most you'd pay per card to buy; choose a land count from 33 to 38. Settings are saved with the deck and reused by Rebuild and Auto-fill.
- **Deck builder:** cards are scored mainly by EDHREC inclusion and synergy for that commander (or that strategy or bracket page). The builder also:
  - adds combos that fit the bracket;
  - balances the mana curve and the counts of ramp, card draw, removal and board wipes;
  - picks on-color nonbasic lands and fills the rest with basics.
- **Filling gaps:** if your collection runs out of usable spells, the remaining slots are filled with the commander's top EDHREC recommendations you don't own, not with extra basic lands. Cheaper cards are preferred. Those cards are marked **Buy** with a price, and a **To buy** tab shows the total, a TCGplayer link and a copyable list. Your own cards are always used first.
- **Deck editor:**
  - **Images / List / Strategy views.** Strategy groups cards by role: combo pieces, win conditions, synergy, ramp, draw, removal and wipes. Each card shows role chips, and a **⇄ swap** button suggests owned cards in the same role.
  - **Game plan:** a one-paragraph plan naming real cards ("Develop Mice and tokens, then use Mabel and … Keep cards coming with …, and finish through combat with …"), with a detailed "How to play this deck" guide below it.
  - **Try an opening hand:** draw 7, mulligan or draw for the turn, with a keep or mulligan verdict and the odds of a 2–4 land hand.
  - **Synergies:** groups of cards that work together, found from rules text (creature-type teams, tokens, valiant/targeting, equipment, +1/+1 counters, lifegain, sacrifice, spells, graveyard, landfall, artifacts). Each group lists what it needs and what to watch for. Below them, deck-wide cautions: tight colored mana, restricted-mana lands, few draw engines, sweeper exposure, light removal and a top-heavy curve.
  - **Optimize (Deck Care):** choose *Smoother mana*, *More card draw* or *Better answers* to get in/out swaps from your own cards, then apply the ones you like. It also lists EDHREC cards for that goal that you don't own.
- **Builder targets come from EDHREC's average deck** for the commander (or the chosen strategy or bracket page): land count, creature share and mana curve. The ramp target scales with the curve, so aggro commanders aren't padded with mana rocks.
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
