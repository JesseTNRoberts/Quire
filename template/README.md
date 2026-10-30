# {{TITLE}}

This is a **Quire** beat-novel repository. The Quire app is where the book is written; this repo is
its plain-text archive. Quire snapshots the book here automatically (about every 30 minutes while
you write, and shortly after you stop).

- `beats/` one Markdown file per beat: `Title ~id.md`. Retired beats live in `beats/_retired/`.
- `board.json` the board: acts, streams, tags, positions (which set book order), arrows, dates.
- `notes/` characters, plot spine, style notes and anything else.
- `claude/` instructions shared with Claude.
- `quire.json` format version and exact titles.

Each beat file has the layout:

```
Synopsis: <one or two sentences>

Claude adjust:

<instructions to Claude; usually empty>

---

<the beat itself>

=== Notes ===

<notes>
```

**Compile:** Actions tab → *Compile manuscript* → *Run workflow*. It builds `manuscript.md`,
`.docx` and `.epub` in book order and attaches them to the run.

Edit in the app, not here: edits pushed straight to this repo are overwritten by the next snapshot
unless you re-import them from the app's Settings.
