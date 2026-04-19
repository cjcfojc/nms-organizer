# Publishing to GitHub — step-by-step

Walkthrough for when you want to put this online as a public repo. Nothing in this file is auto-executed; you pick when to run each step.

## Before anything hits GitHub

Make sure personal data is gone:

```bash
# Check there's nothing in the gitignore-listed folders you're worried about
ls applied/ backups/ logs/ extracted/ test_save/ 2>/dev/null

# Confirm nmsorganizer.config.json is gone (it has your specific paths in it)
test -f nmsorganizer.config.json && echo "DELETE THIS before publishing" || echo "clean"

# Confirm the extracted icons folder is gone (it's 125MB of HelloGames assets)
test -d app/assets/icons && ls app/assets/icons | head -3
```

The `.gitignore` keeps all of this out of git, but they exist on your disk and git sometimes leaks things via stash/branch operations. Cleanest path: delete the folders manually before `git init`.

## 1. Initialize the repo

```bash
cd path/to/nms_organizer
git init
git add .
git status       # review what's about to be committed
git commit -m "Initial commit"
```

The `git status` output should list around 60 files — no saves, no backups, no logs, no icons. Three launchers (`start-windows.bat`, `start-macos.command`, `start-linux.sh`) at the root, one for each OS.

## 2. Create the GitHub repo

On [github.com/new](https://github.com/new):

- Repository name: `nms-organizer` (or whatever you want).
- Public.
- **Do NOT** initialize with a README, .gitignore, or license — we already have all three.

GitHub shows you the `git remote add` commands. Copy them, paste locally:

```bash
git remote add origin git@github.com:<your-username>/nms-organizer.git
git branch -M main
git push -u origin main
```

## 3. Verify the publish

Go to the repo URL. Check:

- README renders.
- No `.bak` files, no `logs/`, no `save.hg`, no `nmsorganizer.config.json`, no `app/assets/icons/*.png` — if any of these show up, `git rm --cached <file>` them, commit, push.
- LICENSE is detected (GitHub shows it in the right sidebar).

## 4. Enable the wiki (optional)

GitHub repos get a free wiki. In your repo → Settings → Features → Wikis (check the box).

The `docs/` folder in this repo has the content that would make sensible wiki pages:

- `SETUP.md` → "Setup" wiki page
- `USAGE.md` → "Usage" wiki page
- `TROUBLESHOOTING.md` → "Troubleshooting"
- `FORMAT.md` → "Save file format"

Either:
- Link to the `docs/*.md` from the README (simplest — works without a separate wiki).
- Or copy each file's contents into a new wiki page via GitHub's web UI.

## 5. Release packaging (optional)

When you want to tag a version:

```bash
git tag -a v0.1.0 -m "first public release"
git push origin v0.1.0
```

On GitHub, the repo's "Releases" tab will show the tag. You can attach a zip — GitHub auto-builds one from the tagged commit, so usually no manual upload is needed.

## 6. Issue template (optional)

Create `.github/ISSUE_TEMPLATE/bug.md`:

```markdown
---
name: Bug report
about: Something broke
---

**NMS save version:** (from the load menu's bottom-left)
**Platform:** (Windows / macOS / Linux)
**Node version:** (run `node --version`)

**What happened:**

**What I expected:**

**Steps to reproduce:**
1.
2.
3.

**Session log:** attach `logs/session.<latest>.jsonl` — the one from the session where the bug happened.
```

That way users share logs without being asked.
