# Bulk Deck Builder (MTG)

Turn your pile of extra Magic: The Gathering cards into playable decks.
Import a CSV from your scanner app (ManaBox first), and the builder suggests colors, themes and commanders your pile can support. It then drafts a deck that you can edit.

It is a static site: plain HTML, CSS and JavaScript with no build step and no server.
Your collection and decks are saved in your browser (IndexedDB).

## Features

- **ManaBox CSV import.** Cards are matched by Scryfall ID, so you get the exact printings and images. Other CSVs (Delver Lens, TCGplayer, Moxfield, Deckbox and similar) are auto-detected by their column names. Lookups go 75 cards at a time through Scryfall's `/cards/collection` endpoint, with a progress bar. Card data is cached, so re-importing is instant. Large piles (10k+) are fine.
- **Four formats:** 60-card casual, 40-card limited, Commander (100-card singleton) and Pauper (commons only).
- **Auto-suggest, then edit:**
  - *Colors*: ranks every mono-color and two-color pairing by how strong a deck your pile supports.
  - *Themes*: tribes (Elves, Zombies…) and mechanics (+1/+1 counters, tokens, sacrifice, graveyard…) with enough cards behind them, or type your own.
  - *Commanders*: your legendary creatures ranked by how deep a deck their color identity allows and how many cards match their themes.
  - *Deck drafting*: aims for a sensible mana curve, the right creature count, and enough removal, card draw and ramp. It adds on-color dual lands from your pile and splits basic lands by color requirements.
- **Physical copy tracking.** A copy used in one deck is not available to the others. Basic lands are treated as unlimited.
- **Editor** with card images (or a list view), +/- buttons, a ranked "add cards" panel, mana curve, color requirements compared with land sources, role counts, and legality and shortage warnings. *Auto-fill* tops up a deck you have trimmed, and *Rebuild* starts it over.
- **Export** decklists in the `4 Card Name (SET) 123` format, which Moxfield, Archidekt and MTG Arena accept. **Backup and restore** your collection and decks as JSON.

## Run it

Any static file server works. Opening `index.html` straight from disk won't work, because ES modules need `http://`.

```sh
npm start            # python3 -m http.server 8080 → http://localhost:8080
```

### Host it on GitHub Pages

In the repository, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, pick the branch and `/ (root)`, and save.

## Exporting from ManaBox

Collection (or a binder) → **⋮** → **Export** → **CSV**. Then drop the file on the Collection page.

## How the builder scores cards

Each card gets a quality score from its EDHREC popularity rank, which comes with the Scryfall data. Efficient creature stats and keywords add a little, and theme matches add a lot. The deck is filled greedily. Copies after the first count for less. Each pick is weighted against a target mana curve, a creature ratio and role minimums (removal, draw, ramp) for the format. The logic lives in `js/builder.js` and `js/cards.js`.

## Project layout

```
index.html, css/style.css
js/app.js            router, backup dialog
js/views/*.js        Collection, Build, My decks, Deck editor, card dialog
js/builder.js        formats, suggestions, deck construction, validation, stats, export
js/cards.js          Scryfall card trimming, mana parsing, roles, themes, scoring
js/csv.js            CSV parsing and scanner-format detection
js/scryfall.js       batched Scryfall client with retry and backoff
js/store.js, db.js   state and IndexedDB persistence
tests/               unit tests (node --test) and a Playwright end-to-end test
```

## Tests

```sh
npm test             # unit tests
node tests/e2e.mjs   # browser test with Scryfall mocked (needs Playwright + Chromium)
```

Card data and images © Wizards of the Coast, served by [Scryfall](https://scryfall.com). This project is not affiliated with Wizards of the Coast.
