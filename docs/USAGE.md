# Usage

## Loading a save

Click `OPEN SAVE` in the top bar. A modal lists every save slot the server found in your NMS folder, with the in-game location summary and the timestamp of the most recent save.

Click a slot. The app reads both `save<N>.hg` and `mf_save<N>.hg` together (they're a pair — one is the data, one is the integrity manifest), auto-backs up the bytes to `backups/`, decodes the LZ4 chunks, parses the JSON, walks every container.

If you want to load a save from somewhere else (a backup, a friend's save), click `Open from disk instead` in the modal. That falls back to the OS file picker. Select both files at once (Ctrl-click).

## The five tabs

### Audit (read-only)
A grid of every container in your save: 10 storage containers, freighter inventory + cargo, every owned ship, exocrafts, exosuit. Each cell is colored by its bucket (Raw, Components, Trade, etc.). Click any cell → the right pane shows the full taxonomy record for that item.

The text input filters by item ID. Useful for spot-checking specific items before/after applying.

### Layout
The main config screen. Pick a preset on the left ("The Vault" is the default), or tweak per-chest:
- **NAME** — the chest's in-game name. Free text.
- **BUCKETS** — which bucket(s) of items go in this chest. Multi-select; you can route two buckets into one chest.
- **CAP** — visible only; the chest's slot capacity.

Below that:
- **OPERATIONAL RESERVES** — items kept in their original location regardless of plan (e.g. fuel cells in your ship). Predefined common items in a dropdown; custom IDs welcome.
- **EXCLUSIONS** — ships you want left alone. Click to lock; the lock icon appears in the Sources tree on the left.

Click `▶ GENERATE PLAN` to build the plan. The validator runs immediately — `APPLY PLAN` is gated on it passing.

### Preview
Before/after grids per container, sorted by most-changed first. Diff colors:
- green = added
- red = removed
- amber = same item, different amount
- blue = different item at this position

Two view modes: **GRIDS** (the visual diff) and **TABLES** (a flat summary). Switch with the tab inside the Preview pane.

### Apply
Pre-flight checks: backup exists, validator passed, item totals balance. Three output buttons:

- **DOWNLOAD BOTH FILES** — emits `save.hg` + `mf_save.hg` as browser downloads. Always safe; you have to manually drop them into your NMS folder.
- **WRITE NEW SLOT** — finds the next empty NMS slot pair, encrypts the manifest with that slot's key, and writes both files directly into your NMS save folder. Your existing slots are untouched. NMS will show the new slot in its load menu.
- **OVERWRITE ORIGINAL** — replaces the loaded files in place. Modal asks you to type the filename to confirm. The pre-overwrite versions are backed up to `backups/` automatically.

After any apply, the result panel shows the file paths, byte counts, and SHA-256 of what was written. The same record goes into the apply audit log under `backups/<name>.<timestamp>.applied.json`.

### Settings (planned)
Re-run the setup wizard, browse session logs, regenerate icons after a game update.

## Logs

`logs/session.<timestamp>.<pid>.jsonl` — one file per server start. Both server actions AND browser events flow into this single file as JSON-per-line. To inspect:

```bash
cat logs/session.*.jsonl | jq .
```

Hit `http://localhost:8765/logs` for a list, or `http://localhost:8765/logs/<filename>` to download.

The in-app terminal pane at the bottom shows the same events live. Filter by level (debug/info/success/warn/error) and category.
