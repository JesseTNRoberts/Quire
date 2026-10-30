<p align="center"><img src="public/icons/logo.svg" width="96" alt="Quire logo"></p>

# Quire

**Write your novel beat by beat, on any device.** Quire is a beat-board writing app that works
equally well on a phone, a tablet and a desktop. It's the Gale House Storyboard rebuilt to live on the
web: no Scrivener, no Dropbox, no Mac required.

- **Never press save.** Every keystroke is stored on the device at once and reaches the server within
  a couple of seconds. Offline edits wait on the device and go up when you're back.
- **Live across devices.** Type on the phone and the open laptop updates. If two devices edit the same
  beat, the changes merge line by line. A real clash asks you to choose instead of losing words.
- **Plain text forever.** Every ~30 minutes, and shortly after you stop writing, Quire commits the book
  to a GitHub repo as plain Markdown files. That's your archive and history.
- **Any beat-novel repo.** It imports Quire repos and Scrivener external-sync folders in the Gale House
  layout (`Draft/`, `Notes/`, `*board.json`).

```
 phone / tablet / laptop        Cloudflare (your account, free tier)          GitHub
 ┌───────────────────┐  edits  ┌─────────────────────────────────────┐  every ~30 min  ┌──────────────┐
 │ Quire web app     │ ──────► │ Worker  →  one Durable Object per   │ ──────────────► │ book repo    │
 │ copy on device    │ ◄────── │            book (SQLite live store) │   one commit    │ plain .md    │
 │ (IndexedDB)       │  live   │ Cloudflare Access = sign-in         │ ◄────────────── │ (archive)    │
 └───────────────────┘         └─────────────────────────────────────┘  import/restore └──────────────┘
```

---

## Try it first

Open `public/index.html` from any static server with `?demo` (or just open the preview link). The demo
runs the whole server inside your browser with a sample novel. Open it in **two tabs** to watch two
"devices" sync. Settings has buttons to go offline and to simulate an edit from your Mac.

---

## Set it up (about 30 minutes, once)

You need a Cloudflare account (free), a GitHub account and Node 20 or newer.

### 1. Get the code

```bash
cd quire
npm install
```

### 2. Turn Gale House into a book repo

Close Scrivener (or sync it) so the sync folder is current. The script **only reads** the sync folder.

```bash
node scripts/migrate.mjs "$HOME/Documents/Scrivener/Gale House Sync Claude" ~/gale-house --title "Gale House"
```

It prints how many beats it found and checks that **every beat round-trips exactly**. It brings across
the beats (retired `TO DELETE` beats go to `beats/_retired/`), the board (positions, acts, streams, tags,
arrows, dates), `Notes/`, `Claude/` and `Claude chats/`. Backups, the generated digest and the
Storyboard HTML are left behind.

Create a **private** repo on GitHub called `gale-house` (empty, no README), then:

```bash
cd ~/gale-house
git init -b main && git add . && git commit -m "Gale House, migrated to Quire"
git remote add origin https://github.com/JesseTNRoberts/gale-house.git
git push -u origin main
```

*Starting a different book?* `node scripts/migrate.mjs --new "My Next Novel" ~/my-next-novel`, then push it the same way.

### 3. Make a GitHub token for Quire

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- Repository access: **Only select repositories** → `gale-house` (add future books here later)
- Permissions → Repository → **Contents: Read and write** (Metadata: Read is added automatically)
- Expiration: up to a year. Put a reminder in your calendar to renew it.

### 4. Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler deploy                     # prints https://quire.<your-subdomain>.workers.dev
npx wrangler secret put GITHUB_TOKEN    # paste the token from step 3
```

At this point the API **refuses every request**. That's deliberate: it won't serve your book until
sign-in is set up.

### 5. Lock it to you with Cloudflare Access

1. Cloudflare dashboard → **Workers & Pages** → `quire` → Settings → **Domains & Routes** → on the
   `workers.dev` row choose **Enable Cloudflare Access**. (If you've never used Zero Trust, it asks you
   to pick a team name and the Free plan first.)
2. Open **Zero Trust → Access → Applications → quire**. Under Policies, make sure there's an
   **Allow** policy that includes **Emails: `jesse.tn.roberts@gmail.com`**. Login method: One-time PIN
   (a code by email) works out of the box; Google login is a nice upgrade.
3. On the application's overview, copy the **Application Audience (AUD) Tag**. Your team domain is
   `https://<team-name>.cloudflareaccess.com`.
4. Put both in `wrangler.toml`:

   ```toml
   ACCESS_TEAM_DOMAIN = "https://<team-name>.cloudflareaccess.com"
   ACCESS_AUD = "<the AUD tag>"
   ```

5. `npx wrangler deploy` again.

### 6. Open it and import the book

1. On your phone, open `https://quire.<your-subdomain>.workers.dev` and sign in.
2. **Settings → Import a beat-novel repo** → Owner `JesseTNRoberts`, Repo `gale-house` → **Import**.
3. The GitHub archive is set to the same repo automatically. **Snapshot now** checks the round trip.
4. iPhone: Safari → Share → **Add to Home Screen**. It opens full screen and works offline.

You can also import the raw Scrivener sync folder pushed to GitHub as it is. In that case set the
archive to a *new* repo, since the snapshot is written in Quire's format.

---

## Using Quire

| | Phone | Tablet | Desktop |
|---|---|---|---|
| Navigation | bottom tabs | side rail | labelled sidebar |
| Editing a beat | full-screen editor | list and editor side by side | list or board, with editor beside it |
| Board | swipe to pan, **hold** a card to drag it | drag cards, pinch to zoom | drag cards, trackpad pinch or ⌃-scroll to zoom |
| Keyboard | — | if attached | `N` new beat · `/` search · `↑↓` move through beats · `↵` into text · `Esc` close · `1–4` views |

- **Book**: every beat in book order, grouped by act. Filters for Claude adjusts, empty beats, not-yet-synced and retired beats.
- **Editor**: the same four tabs as the Storyboard (**Beat**, **Synopsis**, **Claude adjust**, **Notes**), the same file layout, the yellow adjust tab. The ⋯ menu moves a beat earlier or later, changes its stream or tags, inserts a beat after it, or retires it (never deletes).
- **Board**: acts as columns, streams as lanes, dates, sticky notes and arrows, as in the Storyboard.
- **Notes**: characters, plot spine, Claude instructions, chat transcripts.
- **Status pill** (top right): *Synced*, *Saving*, *Offline · 3 waiting*, or *Needs your choice*. Tap it for details or to retry. If edits sit unsynced for 10 minutes while you're online, Quire tells you.
- **Export**: the manuscript or an outline of synopses as Markdown, or the whole book as a repo `.zip`, straight from Settings. For Word or EPUB, run **Actions → Compile manuscript** in the book repo.

---

## The beat-novel repo format

```
quire.json         {"format": "quire-1", "title": "...", "titles": {id: exact title}}
board.json         acts, lanes (streams), topics (tags), beats {id: {x, y, tags}}, notes, links, days, trash
beats/Title ~id.md one file per beat; retired beats in beats/_retired/
notes/  claude/  chats/   everything else, as plain text
.github/workflows/compile.yml, .quire/   the compile action
```

Each beat file uses exactly the Gale House layout, so the rules in `claude/Claude instructions.md`
still apply word for word:

```
Synopsis: <one or two sentences>

Claude adjust:

<instructions to Claude; usually absent>

---

<the beat>

=== Notes ===

<notes>
```

Book order comes from the board: by act, then left to right, then top to bottom. A beat's ID never
changes, so renaming a beat is just a new file name in the next snapshot.

---

## Working with Claude on the desktop

Two routes:

1. **Through the GitHub repo (simplest).** Claude reads the latest snapshot and proposes changes. To
   bring repo edits into Quire, use **Import** with "Replace" ticked. Quire snapshots first, so
   nothing is lost. Best for big restructures.
2. **Through the API (live).** Create an Access **service token** (Zero Trust → Access → Service
   auth), add it to the Quire application's policy with a **Service Auth** rule, and give Claude the
   client ID and secret. Requests carry `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers:

   | | |
   |---|---|
   | `GET /api/book/<id>/state?since=0` | the whole book (beats, files, board) |
   | `POST /api/book/<id>/ops` | `{"client":"claude","ops":[{"type":"beat","id":"s10","baseRev":3,"fields":{"synopsis":"..."}}]}`; a stale `baseRev` returns `conflict` with the current version, never overwrites |
   | `POST /api/book/<id>/snapshot` | commit to GitHub now |

   Edits appear on every open device within seconds, as in the Storyboard.

---

## Costs and limits

All of this fits Cloudflare's free plan. A whole novel is about 1 MB, and a heavy writing day is a few
thousand requests against a free limit of 100,000 a day. On the free plan, hitting a limit makes
writes fail until midnight UTC rather than costing money. Your words stay on the device and sync
afterwards. The $5 a month Workers Paid plan removes that ceiling.

---

## Developing

```bash
npm test                                   # format + migration tests
node test/mock-github.mjs <repo folder> &  # fake GitHub on :8799
npm run dev                                # http://127.0.0.1:8787, sign-in off (see .dev.vars)
node test/ui.test.cjs                      # phone + tablet + desktop, live sync, offline merge
```

`.dev.vars` (not committed) for local work:

```
DEV_NO_AUTH=1
SNAPSHOT_MINUTES=1
GITHUB_API=http://127.0.0.1:8799
GITHUB_TOKEN=test-token
```

Code map: `public/format.js` (file format, book order, merges; shared by everything),
`public/sync.js` (device storage and sync), `public/app.js` and `app.css` (the UI),
`public/backend.js` (live API and in-browser demo), `worker/` (Worker, Durable Objects, GitHub,
Access), `scripts/migrate.mjs`.

## Not in this first version

- Editing acts, streams and dates from the UI. They come across from the Storyboard; change them in
  `board.json` and re-import for now.
- Claude inside the app (the Storyboard's stage 1–3 panel). The Worker is the right home for the API
  key when it comes.
- Sticky notes and arrows show on the board but can't be edited yet.
