# Build spec: quest checklist with user accounts

Revision 3 (checklist imported, markers and typos settled), approved 2026-09-27; phases A-F done the same day. Same working rules as the earlier
specs: stop at every phase boundary for review, ask on anything this spec does not cover.

## 1. Goal

A per-user checklist of NPC interactions for the base game and Shadow of the Erdtree, built from the two imported
Reddit lists. Each bullet in those lists is one checklist item that the user marks done or not done. Each item
also works as a ready-made chat prompt ("tell me more about this step"): one click asks the guide how to do it
and where it is, and the answer cites book pages. Progress is saved per user and character, so users log in. An
admin screen creates and manages the accounts.

## 2. Source content

Imported 2026-09-27 from two Reddit posts by **u/Stellarwand**: "All NPC interactions in Elden Ring"
(r/Eldenring, tjmodv) and "All NPC interactions in Shadow of the Erdtree" (1dnw7dr). They are in
`docs/quest-checklist-main.md` and `docs/quest-checklist-dlc.md`, now `config/checklists/main.md` and `dlc.md`
(Phase A). The text belongs to the author. The repo has no
remote, so keeping it here is fine for personal use. The UI credits the author and links each post
(decision 12).

### 2.1 What is in the files

| | main | dlc |
|---|---|---|
| Bullets (after splitting the two merged ones, §2.2) | 199 | 82 |
| Sections (bold lines, in play order) | 22, two levels (Liurnia has 4 sub-areas; After the Final Boss > Frenzied Flame Ending > "To become" / "To remove") | 7 |
| Plain tasks | 184 | 56 |
| Collectibles (Deathroot #2-9, Seedbed Curse #1-5, Forager Brood Cookbook #1-6) | 13 | 7 |
| `(Optional)` items | 1 | 7 |
| Notes (bullets starting "Note:" / "Major Story Beat") | 1 | 4 |
| Outcome notes (Enir Ilim, one per NPC: "**Leda**: Leda will attack you...") | 0 | 8 + 1 intro |
| Loose lines that are not bullets (endings advice, "To become the Frenzied Flame:") | 4 | 0 |
| Words per item | median 20, max 115 | median 20, max 111 |

That is about **268 checkable items** (198 main, about 70 DLC). About 18 more are notes: info rows shown in
place with no checkbox.

**The order is a real play order.** Each list walks the game region by region, so the checklist is shown in file
order, section by section. This covers the "global order" the guides do not give (revision 1, §2 limits). The
guides are used to answer and cite, not as the source of the list.

### 2.2 Markers, cleanup and names (settled 2026-09-27)

1. **Markers.** Both are item prefixes, not bold. In Markdown they open bold text that never closes; the parser
   strips them before reading the bold NPC names.
   - `*****` (7 bullets, all Ranni quest steps, plus the `***** **Frenzied Flame Ending**` heading) is an
     asterisk footnote pointing to the Frenzied Flame Ending section. In the UI it becomes a "✱ Frenzied Flame"
     chip that jumps to that section.
   - `**` (13 bullets) binds activities that belong together. By the NPCs they share they form three chains:
     Goldmask & Corhyn (6 items, Altus to Capital of Ash), Dung Eater (5, including the Roundtable item that
     ends "with **D** and **Dung Eater**") and Fia (2: Ranni's cursemark, Deeproot Depths). These are the
     questlines behind the Age of Order, Blessing of Despair and Age of the Duskborn endings. The build script
     groups `**` items into chains by shared NPC (`chain` field). The UI shows a chain chip ("Goldmask & Corhyn
     2/6") that lists the other items in the chain. The chains are checked in the Phase A QA report.
2. **Fixed in the files** (2026-09-27, the user asked for all typos to be fixed; no diff in git because the files
   are untracked, the originals are kept in the session scratchpad):
   - two merged bullets split ("...talk to **Gostoc**" / "Talk to everyone in the Roundtable Hold again...", and
     "...East of **Corhyn**." / "Return to **Seluvis**..."); the lone `*` between them was the lost bullet;
   - `-If you become` without a space (2);
   - names: Milicent → Millicent (11), White-Faced Varre → White Mask Varré, Varre → Varré, Kale → Kalé,
     Isrvan → Istvan, Iron Fist, Alexander → Iron Fist Alexander, Witchhunter → Witch-Hunter Jerren, Selen /
     Selevus → Sellen / Seluvis, Margott → Morgott, Melania → Malenia (3), Nameless Whitemask → Nameless White
     Mask, Thiolier → Thiollier, St Trina → St. Trina, Jolan → Jolán (8);
   - places and items: Rountable, Storveil, Laskyar, Selia → Sellia (3), Moghwyn, Lyndell, Radhan, Shabiri /
     Shibiri → Shabriri Grape, Lake Facing Cliffs, Commander O-Neil → O'Neil, Mohg, Lord of Blood, Mohg, the
     Omen, Graveside → Gravesite Plain, High Cross → Highcross Road, Mesmer, Hinterlands → Hinterland, Finger
     Ruins of Myr → Miyr, Charo's Hidden Grove → Grave, Abyssal Woods;
   - spelling: vear, youin, ares, Tall to, walked back, attoning, engame (3), NPC's, Deathroot # 8, doubled
     periods, and 25 stray spaces before `.` `,` `)`.
3. **Still left for the parser:** section headings with a note attached (Nokron, Deeproot Depths, Consecrated
   Snowfield "Accessed by...") are split into the title and a section note.
4. **Names that stay as written** and resolve through normalizeName, accent folding and a small alias map:
   possessives (`Boc's`, `Patches'`, `D's`), short forms (`Queelign`, `Nataan`, `Anna`, `Polyanna`, `Kenneth`,
   `Blackguard`, `Varré`, `D`). Vol 2's OCR has "Milicent" too, so Millicent also matches there.
5. **Deathroot #1 has no item of its own.** It is the drop in the D, Hunter of the Dead step. Numbering of the
   other collectibles is complete (Seedbed 1-5, Cookbook 1-6; Cookbook #4 is mentioned twice, the second time
   as the hand-in to Moore).

### 2.3 Item text as the chat prompt

Tried with the retrieval harness on the raw bullet text:

| Item | Top pages | Verdict |
|---|---|---|
| Talk to Boc at the Coastal Cave... | vol1 367-370 (Boc's quest), 61 (Coastal Cave) | good |
| Seedbed Curse #4 From the Prayer Room Grace... | vol1 297, 295, 475 (Haligtree, Dung Eater) | good |
| Reload Manus Metyr... Speak to Jolan... Iris of Grace | vol3 366-369 (Jolán's quest) | good, found by embedding; the name did not match (accent) |
| Summon Melina to fight Margott (before the typo fix) | vol1 359-368 (Melina) | partly: the typo hid Morgott |

So the bullet text works as a prompt. It gets better with two things done once at build time, not per click:
canonical names in the prompt, and focus pages stored with each item.

## 3. Decisions (recommendation first)

1. **Content source.** The two imported lists are the checklist. The guides answer and cite. The per-NPC event
   parser from revision 1 is dropped, and so is its model pass, so building the checklist needs no model
   calls. The book NPC chapters are still used for linking (decision 5).
2. **Where the files live.** Move them to `config/checklists/main.md` and `dlc.md`. They are app input read by the
   indexer, like books.json, not documentation. A `checklists` block in config/books.json (or its own
   config/checklists.json) lists id, title, file, source URL and the default search scope (main: vol1, vol2;
   dlc: vol3). No checklist id in code, the same rule as book ids.
3. **Stable item ids.** The files have none, and progress must survive edits to the text. `checklist_build.py
   --assign-ids` adds a hidden `<!-- q:m042 -->` comment at the end of each bullet, once. Reruns keep existing
   ids and give new bullets new ids, and editing a bullet's text keeps its id. A removed id keeps its progress
   rows and shows as "retired" in the UI.
4. **Typos: settled.** Fixed in the files (§2.2 item 2). The build script still reports bold names it cannot
   resolve, so later edits get checked. `config/checklists/aliases.json` keeps only real alternate names (short
   forms, titles), which the chat prompt and NPC linking use.
5. **Links per item, made at build time.** For each item the script writes:
   - `npcs[]`: bold names resolved to guide NPC entities (normalize, then aliases, then trigram match; unresolved
     names go in the QA report);
   - `pages[]`: the top guide pages from the retrieval harness (embedding the item text, a fraction of a cent for
     all ~265 items), used for "Open page" and as chat focus;
   - `kind` (task, collectible, optional, note, outcome), `section` path, `footnote` (`frenzied-flame` for
     `*****`), `chain` (the `**` chain id, §2.2 item 1).

   Output goes to `out/checklists/<id>.json`. Hand corrections go in `out/checklists/<id>_overrides.json`, which
   the readers apply and the build never does (same pattern as the art overrides). `checklist_qa.py` writes
   `_qa.md`: items with no NPC match, no confident page, or pages in the wrong book.
6. **The prompt sent on "Ask".** The item text with canonical names, prefixed with its section:
   `[Liurnia of the Lakes > Central Liurnia] Talk to Patches on the Scenic Isle near the Laskyar Ruins Grace.`
   plus a fixed request: "Explain how to do this step and exactly where it is." POST /api/chat gets an optional
   `focus: {book, pages[]}`, and retrieval adds those pages as own pages. The composer is pre-filled and sent at
   once. The question stays visible in the chat so follow-ups work as usual.
7. **Accounts** (unchanged from revision 1). Local username and password only, no e-mail and no self sign-up.
   Passwords use `crypto.scrypt`; sessions are Postgres rows behind an httpOnly SameSite=Lax cookie that lasts
   30 days and renews on use. The cookie is `Secure` when COOKIE_SECURE=true. Roles are `admin` and `user`.
   Login attempts are rate-limited, and state-changing requests need JSON plus an `x-miriel` header.
8. **What needs a login.** AUTH_REQUIRED=false by default: reader and chat stay open, and checklist progress and
   admin need a login. The checklist itself can be read logged out, with its checkboxes disabled.
   AUTH_REQUIRED=true locks everything except `/api/health` and `/api/auth/*`. Use it when the stack is
   reachable from outside the LAN, because chat spends Anthropic credit.
9. **First admin.** `npm run user -- add <name> --admin` prints a one-time password. No default password is
   shipped.
10. **Admin UI.** `/admin/users` lets the admin:
    - list users with last login and items done;
    - create a user, with a temporary password shown once and changed at first login;
    - reset a password, disable or enable, promote or demote, and delete a user, which also deletes their
      progress.

    The last active admin cannot be removed.
11. **Characters ("runs").** Each user has one run by default ("Tarnished 1") and can add more for NG+ or a second
    character. Progress belongs to a run.
12. **Attribution: settled.** Each checklist header says "Checklist by u/Stellarwand" with a link to the Reddit
    post it comes from (author and URLs in the checklist config). The About text says the same.
13. **Retakes by users, approved by an admin.** The retake flow already separates the free steps from the one
    that costs money: upload and validation (folio check and photo match, no model call) cost nothing, and
    `confirm` spends the estimate and replaces the book PDF. So:

    | Action | user | admin |
    |---|---|---|
    | View queue, history, photos | yes | yes |
    | Upload photos (single, batch), set the page by hand | yes | yes |
    | Submit a validated job or batch for approval | yes (own jobs) | not needed |
    | Withdraw or discard a job that has not started | own jobs | any |
    | Approve (= confirm) or decline with a reason | no | yes |
    | Confirm directly, retry, rollback, mark accepted | no | yes |
    | Full PDF rebuild (`npm run rebuild-pdf`) | no | CLI only, as today |

    - New status `submitted` between `validated` and `confirmed`. Declining sets `declined` with the admin's
      reason, and the photo stays viewable. The worker picks up only `confirmed`, so it needs no change. The
      daily budget (RETAKE_DAILY_BUDGET_USD) still applies on top of approval.
    - Jobs record `uploaded_by`, `submitted_at`, `decided_by`, `decided_at` and `decision_note`. The page history
      shows who uploaded and who approved.
    - An admin's own uploads skip `submitted` and are confirmed as today.
    - Admins see "N waiting for approval" in the top bar and a filter in the queue. The approve view reuses
      the old / new photo comparison from Phase D of the retake spec, with the estimate and the folio check.
    - Limits per user: at most 50 open jobs (uploaded, validated or submitted) and the existing upload size cap,
      so one account cannot fill the uploads volume.
    - The guard: every retake POST needs a logged-in user, or RETAKE_TOKEN (full admin rights, for scripts).
      **This changes today's behaviour:** without RETAKE_TOKEN, retake POSTs are currently open to anyone who
      can reach the site. The token field in the retake UI goes away for logged-in users.
    - The spec for this is an addendum to docs/build-spec-retakes.md; this section is its summary.

## 4. Data model (migrations 0008-0010)

```
users             id uuid, username citext unique, password_hash, role ('admin'|'user'), must_change_password,
                  disabled_at, created_at, last_login_at
sessions          id (sha256 of a random 32-byte token), user_id, created_at, expires_at, last_seen_at
runs              id uuid, user_id, name, created_at
checklists        id text, title, author, source_url, sort
checklist_items   id text (the q: id), checklist_id, section text[], ord int, kind, footnote, chain, text (display
                  Markdown), prompt (canonical text), npcs text[] (name_norm), pages jsonb [{book,page}],
                  source_hash, retired_at
progress          run_id, item_id (no FK: retired and re-added items keep progress), done_at
retake_jobs       + uploaded_by, submitted_at, decided_by, decided_at, decision_note (users FK, ON DELETE SET
                  NULL); status + 'submitted', 'declined'                                   -- migration 0009
```

## 5. API

```
POST   /api/auth/login | /api/auth/logout      GET /api/auth/me      POST /api/auth/password
GET    /api/admin/users   POST /api/admin/users   PATCH /api/admin/users/:id   DELETE /api/admin/users/:id
GET    /api/runs   POST /api/runs   PATCH|DELETE /api/runs/:id
GET    /api/checklists                          lists + item counts
GET    /api/checklists/:id                      sections and items (no progress; public unless AUTH_REQUIRED)
GET    /api/runs/:id/progress                   PUT|DELETE /api/runs/:id/progress/:itemId
POST   /api/chat                                + optional focus {book, pages[]}
POST   /api/retakes/:id/submit | /api/retakes/batches/:batch/submit            user: validated -> submitted
POST   /api/retakes/:id/decline {note}                                          admin: submitted -> declined
POST   /api/retakes/:id/confirm, batches/:batch/confirm                         admin only (= approve)
```

## 6. Phases

**A. Checklist data.** Done 2026-09-27, pending review.
- The files were moved to `config/checklists/main.md` and `dlc.md`. The structure is now explicit: the bold section
  lines became `##` / `###` / `####` headings (Liurnia's sub-areas and the Frenzied Flame Ending are `###`, "To
  become / To remove the Frenzied Flame" `####`). Heading notes (Nokron, Deeproot Depths, Consecrated Snowfield,
  Jagged Peak) and note bullets (Note:, Major Story Beat, the two "If you become the Frenzied Flame" lines, the
  Enir Ilim outcomes) became plain paragraphs. The rule is now: `- ` bullet = item, other line = note. CRLF kept.
  One more typo fixed: "Ranni's rise".
- `config/checklists.json`: per checklist the title, label, file, author, source URL, books (main: vol1, vol2; dlc:
  vol3), id prefix and markers (`*****` -> footnote `frenzied-flame` to section "Frenzied Flame Ending"; `**` ->
  chain). `config/checklists/aliases.json`: `names` (bold name -> guide entity) and `chapters` (entity -> chapter
  title; one entry, Witch-Hunter Jerren -> Castellan Jerren).
- `scripts/checklist_build.py` (`--selftest`, `--assign-ids`, `--checklist`) writes `out/checklists/<id>.json`.
  Ids `m001`-`m196` and `d001`-`d069` are in the files as `<!-- q:... -->` comments.
  - NPCs: bold names are resolved against the guides' npc / merchant / boss entities (exact, accent-folded,
    chapter, word, close; whole comma spans like "D, Hunter of the Dead" first). Names bolded elsewhere in the same
    list are also found in unbolded text (`match: "text"`, not when a capitalised word follows: "Shabriri
    Grape", "Ranni's Rise").
  - Each NPC gets its guide chapter page range. "Event N" H1s continue a chapter, and all-caps H1s are group
    intros.
  - Result: all 251 (main) and 97 (dlc) names resolved. 3 chains: Dung Eater (5), Corhyn & Goldmask (6),
    Fia (2); 7 Frenzied Flame footnote items.
- `npm run checklist-pages` (packages/api/src/checklist-pages-cli.ts) runs retrieval per item within the
  checklist's books and writes `out/checklists/<id>_pages.json`: the top 3 chunk pages, anchors and a key. It is
  incremental: only changed prompts are looked up again. A full run takes 40 s and about 11,700 Voyage tokens.
- `scripts/checklist_qa.py` writes `out/checklists/<id>_qa.md`.

  | Rating | main | dlc |
  |---|---|---|
  | top page in the named NPC's chapter | 110 | 31 |
  | NPC chapter as 2nd or 3rd page | 40 | 14 |
  | top page mentions the NPC | 9 | 5 |
  | no NPC named | 20 | 5 |
  | check | 17 | 14 |

  The 31 "check" items were read against their pages. Nearly all point to the right walkthrough, map or boss
  page, and a few have a weak top page (d047 "recommended progression paths", d058 a build-path page, d063 the
  Count Ymir boss page before Metyr's).

*Review: the `**` chains and `*****` footnotes (in _qa.md), the check list, the 20-item samples. Open question
for Phase E: which page "Open page" opens. Suggestion: show the three pages as chips, with the NPC chapter page
marked, instead of a single link.*

**B. Accounts.** Migration 0008 (users, sessions, runs), auth and admin routes, the `user` CLI, the session hook
with AUTH_REQUIRED, and rate limit. Tests. Web: login and change-password
screens, a user menu in the top bar, and `/admin/users`.
*Review: create and disable users, session expiry, AUTH_REQUIRED on and off.*

Done 2026-09-27, pending review.
- `db/migrations/0008_accounts.sql`: users (username `^[a-z0-9][a-z0-9._-]{2,31}$`, role, must_change_password,
  disabled_at, last_login_at), sessions (sha256 of the cookie token as id, expires_at, last_seen_at, user agent),
  and runs (one "Tarnished 1" per new user).
- `packages/shared/src/users.ts` (`@miriel/shared/users`):
  - scrypt hashing (N=2^15, r=8, p=1);
  - one-time passwords (`xxxx-xxxx-xxxx-xxxx`, no look-alike characters);
  - the `AuthStore` interface with `pgAuthStore`;
  - account operations shared by the api and the CLI (`addUser`, `resetUserPassword`, `changeUser`,
    `removeUser`), with the guards: not on oneself, never the last active admin.
- `packages/api/src/auth.ts`:
  - session hook with a 15 s cache, renewing the expiry at most hourly;
  - `x-miriel` check on cookie-authenticated writes;
  - AUTH_REQUIRED gate (open: `/api/health`, `/api/auth/*`; a temporary password gets 403
    `password_change_required`);
  - `LoginLimiter`: 5 failures per username or 20 per address in 15 min, then 429 with Retry-After. The
    password is verified even for unknown usernames, so response times reveal nothing;
  - `/api/auth/login|logout|me|password`. A password change ends the user's other sessions.
- `packages/api/src/routes/admin.ts`: list, create (returns the one-time password), patch (role, disabled,
  resetPassword), delete. Disabling or resetting ends the user's sessions at once.
- `indexer user add|list|reset|role` = `npm run user -- ...` (indexer container; migrations run first).
- Compose: AUTH_REQUIRED, COOKIE_SECURE, TRUST_PROXY=true for the api (only nginx reaches it). Docs in .env.example
  and README (fresh install step 8, move, reset).
- Web (`packages/web/src/auth/`):
  - `AuthProvider` loads `/api/auth/me` first. With AUTH_REQUIRED it shows only the login page; a temporary
    password forces the change-password page (the only other way out is "Log out"). Otherwise "Log in" opens an
    overlay.
  - User menu (Change password, Users for admins, Log out) and `/admin/users`: create with the one-time password
    shown once plus Copy, and reset / make admin / disable / delete with the guards mirrored.
  - Any 401 makes the app re-read the session. Chat and retake writes send `x-miriel`.
  - On phones the top bar now wraps to two rows (it overflowed before, with the account button added).
- Tests: `packages/api/src/auth.test.ts`, 10 tests over an in-memory AuthStore (login, disabled, rate limit,
  CSRF, AUTH_REQUIRED + forced change, other sessions ending, admin create / reset / disable / delete / guards).
  All 90 repo tests pass.
- Checked on the dev database, with the migration applied and throwaway users that were deleted afterwards:
  - curl against the api on a spare port with AUTH_REQUIRED on and off;
  - headless Chrome over CDP: login page, wrong password, forced change, reader with the menu, Users, create,
    phone width (390 px, no horizontal scroll), login overlay without AUTH_REQUIRED.
- Not yet done on the running stack (`npm run up` rebuilds it; then create your admin with
  `npm run user -- add <name> --admin`).

**C. Retake approvals** (decision 13). Migration 0009, role checks on the retake routes, submit and decline
routes, `uploaded_by` on uploads, per-user open-job limit, and the addendum to docs/build-spec-retakes.md. Web:
Submit for approval replaces Confirm for users, and admins get the approval filter, top-bar count and
decline dialog. Tested on the sandbox copy (RETAKE_DATA / RETAKE_DATABASE_URL), like the retake phases.
*Review: user uploads, submits, the admin declines one and approves one, the worker runs only the approved one;
the token still works for scripts.*

Done 2026-09-27, pending review.
- Migration 0009: statuses `submitted` and `declined`, columns `uploaded_by`, `submitted_at`, `decided_by`,
  `decided_at`, `decision_note`. The spec addendum is docs/build-spec-retakes.md §11 (states, rights table,
  guard, limits, UI), and docs/retakes.md setup is updated.
- `packages/api/src/routes/retakes.ts`:
  - one actor check: logged-in user (admin or not), the RETAKE_TOKEN (admin rights), or open only when the api
    has no accounts;
  - ownership checks; `submit`, `decline` and their batch versions;
  - confirm takes `validated` or `submitted` and records who decided;
  - users discard only their own unconfirmed jobs; retry, rollback and accept are admin-only;
  - 50 open photos per user (429);
  - jobs carry `uploadedBy` / `decidedBy` with usernames; config reports `viewer {canUpload, canApprove}`,
    `accounts` and `awaitingApproval`;
  - a declined job no longer counts for a page's queue status.
- Worker: `submitted` added to its two same-page checks; nothing else changed.
- Web:
  - `AccessNote` replaces the bare token field: a Log in prompt, or a short note for users, or the token field on
    a stack without accounts;
  - page view: Submit for approval / Withdraw / Approve and process / Decline (with a note) / the declined
    reason; it looks again every 15 s while a photo waits;
  - batch view: submit or approve the batch, decline the submitted ones, uploader per row, a slow poll while
    waiting;
  - queue: "Waiting for approval (N)" for admins, and Mark accepted / Batch upload only for those allowed;
  - top bar: a green ✓ N for admins;
  - the retake config is read again after login or logout.
- Tests: `retakes.test.ts` has 4 approval tests (user submit, bob refused, admin decline with note, owner discard,
  approve; admin's own photo; batch submit and approve; token as admin; 50-photo limit). The in-memory AuthStore
  moved to `@miriel/shared/users` as `memoryAuthStore()`.
- Checked end to end on a sandbox (a copy of the database as `miriel_sandbox`, and a copy of Vol 1's PDF,
  photos and `out/vol1` in the scratchpad; the retake-worker image rebuilt and run with `--no-deps` on those
  mounts, `RETAKE_DAILY_BUDGET_USD=0`, so no model call could start):
  - an anonymous upload got 401;
  - alice uploaded pp. 100 and 101 (copies of their photos), and the worker validated both ($0.141 estimate
    each, "identical to the current photo");
  - alice's confirm got 403, and she submitted both;
  - in headless Chrome, alice saw "Waiting for an admin's approval" with Withdraw, and the admin saw the list,
    the ✓ 2 badge, and Approve on p. 101;
  - the admin approved p. 101 in the UI and declined p. 100 with a note;
  - the worker took only p. 101, which waits "daily budget ($0.00 spent + ~$0.14 > 0)"; p. 100 stayed declined
    and nothing was written to the sandbox data.

  The sandbox database, files and processes were removed afterwards. The real database is still at migration
  0008; `npm run up` applies 0009.

**D. Checklist index and API.** Migration 0010. `indexer ingest` reads `out/checklists/*.json` with the overrides
applied, checks hashes, and retires missing ids. Checklist, runs and progress routes, `focus` in chat and
retrieval. Tests.
*Review: editing a bullet and re-ingesting keeps its progress; Ask on the four §2.3 items cites the right pages
(Morgott included).*

Done 2026-09-27, pending review.
- Migration 0010: `checklists` (title, label, author, source_url, books, sort, outline = headings / notes / item
  ids in file order, chains, footnotes, source_hash), `checklist_items` (ord, section, path, text, prompt,
  optional, collectible, footnote, chain, npcs, pages, retired_at) and `progress (run_id, item_id, done_at)`
  (no FK on item_id).
- `packages/indexer/src/checklist-ingest.ts` and `indexer checklists` (also at the end of `ingest --all`):
  - joins the build, pages and overrides files;
  - checks that page links stay inside the list's books and that override ids exist;
  - one transaction per list: upsert by id, retire the missing items, and refuse an id that belongs to another
    list;
  - hash-checked, so an unchanged list is skipped (0.4 s for both lists).
- Overrides file `out/checklists/<id>_overrides.json`: `{"items": {"m042": {"pages": [...], "prompt": "...",
  "note": "..."}}}`, applied by the ingest and by checklist_qa.py.
- API: `packages/api/src/checklists.ts` (ChecklistStore, pgChecklistStore) and `routes/checklists.ts`:
  - checklists are public (unless AUTH_REQUIRED); the detail inlines each item into the outline and lists the
    retired items;
  - runs: a user sees only their own, names are unique per user, the last run cannot be deleted;
  - progress: PUT ticks (idempotent, keeps the first time), DELETE unticks; retired items can still be unticked;
    done counts include current items only.
  - The admin user list now shows items done.
- Chat `focus` (max 6 pages) -> `RetrieveOptions.focusPages`: the focus pages' chunks are a third ranked list and
  get the own-page boost (docs/retrieval.md, "Focus pages"). `npm run retrieve -- --focus` is the harness.
- Tests: `routes/checklists.test.ts` (3: public read and outline order; runs CRUD and guards; progress, other
  users' runs, x-miriel) and `checklist-ingest.test.ts` (2: join, overrides, hash, refusals). All repo tests
  pass.
- Checked on a sandbox copy of the database (removed afterwards):
  - migrations 0009 + 0010 applied; ingest put 196 + 69 items in, all with page links, and a rerun was a no-op;
  - through the api, a test user ticked m005, m010 and d003;
  - re-ingesting a copy with m005's text edited and m010 removed kept all three ticks and retired m010 (counts
    main 1, dlc 1); the original brought m010 back (main 2);
  - the four §2.3 items asked with their focus pages (4 answer calls): every answer cites its focus pages, and
    "Summon Melina to fight Morgott" now covers Morgott (Vol 2 p. 223, his boss page), which the misspelt name
    had hidden.
- The real database is at 0008; `npm run up` applies 0009 and 0010, and `npm run index` loads the checklists.

**E. Checklist UI.** A `/checklist` route (src/route.ts) with main and DLC tabs:
- sections as collapsible groups with done / total, and a sticky section header;
- notes as muted info rows;
- chips for `(Optional)`, the Frenzied Flame footnote (jumps to that section) and chains (done / total, lists the
  linked items);
- filters: hide done, NPC (from `npcs[]`), chain, text search;
- a run switcher;
- per item: checkbox, NPC names linked to their guide page, Open page, Ask.

The panel sits next to the reader the same way chat does, so Ask and Open page do not leave the view. Ticks are
optimistic and roll back if the request fails. Checked in headless Chrome over CDP, including phone width.

Done 2026-09-27, pending review.
- `packages/web/src/checklist/ChecklistPane.tsx` and `client.ts`. The route `/checklist[?list=<id>]` shows the
  pane where the chat is, next to the viewer. Both panes stay mounted, so switching (top-bar **Checklist** /
  **Chat**; on phones **List** / **Book**) keeps the chat history and the list's scroll and filters.
- Header:
  - tabs per list and "Checklist by u/Stellarwand (Reddit)" linked to the post;
  - a done / total bar;
  - the run picker (select, **+** new, **✎** rename, **✕** delete when there are several), or **Log in** when
    logged out (the list stays readable, the checkboxes are off);
  - Hide done (remembered), search, an NPC filter (one entry per guide chapter, so "D" and "D, Hunter of the
    Dead" are one), and a chain filter.
- Sections: `##` sections collapse (remembered per list) with a sticky header and done / total; `###` / `####`
  are sub-headings; notes are italic rows.
- Items:
  - a checkbox (optimistic; undone with a message if the save fails);
  - the text with bold NPC names linked to their guide chapter;
  - chips: optional, collectible, **✱ Frenzied Flame** (jumps to that section), and **⛓ chain done / total**
    (filters to the chain);
  - page buttons, with ◆ on a page inside a named NPC's quest chapter, opening the viewer (and the Book pane on
    phones);
  - **Ask**: `ask()` in src/state.tsx hands the item's prompt, focus pages and the list's books to the chat,
    which sends it (stopping an answer still streaming).
- Ticked items that were later retired are listed at the end of the list.
- Checked in headless Chrome over CDP against the running stack (Vite preview of this build, a throwaway account
  deleted afterwards):
  - logged out: 196 items with disabled checkboxes;
  - Ask on "Talk to Boc at the Coastal Cave": the chat opened and the answer cited Vol 1 pp. 369 and 61;
  - log in from the pane: run picker "Tarnished 1"; two ticks gave 2 / 196, and Limgrave 2/13 survived a
    reload;
  - a ◆ page button opened p. 373 in the viewer, the footnote chip jumped to After the Final Boss > Frenzied
    Flame Ending, and the chain chip filtered to the 5 Dung Eater steps;
  - the DLC tab showed 69 items and 14 notes, with ?list=dlc in the URL;
  - phone width 390 px: no horizontal scroll, List / Book toggle, and a page button switches to Book.
- The running stack's web image is older than this; `npm run up` rebuilds it.

**F. Docs and acceptance.** README (backup and move now covers users and progress in pg_dump; first-admin step),
CLAUDE.md, a docs/checklist.md runbook (editing the lists, rebuilding after a new book or retakes), and an
acceptance run on the real stack.

Done 2026-09-27, pending review.
- `docs/checklist.md` runbook: files, list format, the ids rule, rebuild steps in Docker, reading the QA report,
  overrides, retakes and new books, adding a list, accounts and progress. README (intro, what lives where, the
  database now holding accounts and progress, checklist commands), docs/adding-a-book.md (checklist books) and
  CLAUDE.md are updated.
- `npm run checklist-pages` is now a `docker compose run` of the api image with `./out` mounted writable (every
  npm shortcut is one compose command). `checklist_build.py` and `checklist_qa.py` write LF on every OS; before
  this fix a Windows build and a Docker build differed only in line endings, which made the index reload the
  lists.
- Acceptance on the real stack (after `npm run up`; throwaway accounts, the test retake job and its events deleted
  afterwards, so the database was left with no users, runs, progress or retake jobs as before):
  1. **Pipeline in Docker:** build, pages (0 to look up), QA, index. After the LF fix the host and Docker builds
     are byte-identical and `npm run index` reports both lists unchanged.
  2. **Accounts through nginx:**
     - `npm run user -- add` for an admin and a user; one-time passwords were refused on api routes (403) until
       changed;
     - cookie `HttpOnly; SameSite=Lax; Max-Age=2592000`;
     - 5 wrong logins then 429 (per username; TRUST_PROXY on);
     - the user got 403 on /api/admin/users, and the admin list showed runs and items done.
  3. **Retake approval** (no confirm):
     - the user uploaded a copy of Vol 1 p. 100's photo, and the real worker validated it;
     - the user's confirm got 403, and they submitted it;
     - the admin saw it waiting, declined it with a note, and the user discarded it;
     - the book PDF was untouched.
  4. **Checklist UI in the real web container** (headless Chrome):
     - logged out: 196 items with disabled checkboxes;
     - Ask on "Talk to Boc at the Coastal Cave": the answer cited Vol 1 pp. 61 and 369;
     - logged in: two ticks survived a reload, and the admin list showed 2 done;
     - the ◆ page button opened p. 373; the footnote chip put the Frenzied Flame Ending heading at the top of the
       list; the chain chip filtered to 5 Dung Eater steps; the DLC tab had 69 items;
     - at 390 px, no horizontal scroll.
  5. **AUTH_REQUIRED=true** (api restarted with it, then without): logged out, /api/health and /api/auth/me
     answered 200, and /api/books, /api/checklists and /api/chat 401; a logged-in user got 200. Off again
     afterwards.
  6. **Backup:** a `pg_dump -Fc` of the stack holds the data of users, sessions, runs, progress, checklists,
     checklist_items and retake_jobs.

## 7. Out of scope

OAuth or SSO, e-mail password reset, sharing progress between users, importing a save file, answers that take
the user's progress into account ("you have already done X"; possible later, since the run's done items are
known).
