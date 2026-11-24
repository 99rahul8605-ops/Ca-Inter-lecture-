# EduBot update: Study tab, multi-select lectures, new backend

## Update 8: pages now follow the design boards (not just the colours)
The earlier "Focus" theme only re-coloured the old layout. These pages were rebuilt to match the design file:
* **Home** (`home-ui.js`, `home-ui.css`): header (profile · Namaste · streak chip · bell), headline "Aaj kya padhna hai, CA Inter?",
  "Today's goal" card (ring = % of today's study target; title + "Open lecture" = the chapter you opened last),
  search icon + chips (All / Free / Premium / Saved), bento batch tiles (1 big + 2 small, alternating), lime "Spin & earn" strip with
  the live access timer. Every old batch feature is kept inside the tiles: save (heart), lock, Buy, Free Redeem, View Demo,
  reward-access timer, draft badge, % done. Old Home ids are kept (hidden) so no old code breaks.
* **Chapters page:** small label above a big title, dark progress card (% · "X of Y lectures"), 01/02 pastel number tiles.
  Same header style on Subjects / Units / Lectures pages.
* **Lectures / Notes popup:** big dark "Lectures" and mint "Notes" cards, design card states, one full-width button
  "Send 3 lectures to bot" (label follows what you picked).
* **Spin & Earn:** header with label + access timer pill, "Watch an ad" row, "Dost ko invite karo" card (code + Copy).
* **Admin panel:** dashboard first (big Add Lecture tile, 2x2 Batch/Subject/Chapter/Unit, Manage rows), a tile opens the
  original form with a back arrow. Tiles the admin has no permission for are not shown. Old tabs stay in the DOM.
* **Study > Timer** is dark focus mode like the design.
Intentional differences from the boards: a heart (save) on tiles, a "Saved" chip, no batch cover image on tiles,
the dock is Home / Study / Rewards / Profile (the app has no Library page).

## Update 7: chat layout, reply, support button
* **Messenger layout for group chat:** header + messages fill the screen and the write box is pinned to the bottom
  (it used to float in the middle). The page title and main tabs are hidden in chat to save room.
* **Keyboard:** while any text field is focused (`body.kb-open`, set app-wide by `rewards-ui.js`) the bottom dock is hidden,
  so it no longer rides up above the keyboard. Send no longer steals focus, so the keyboard stays open between messages.
* **Reply:** swipe a message sideways (either direction, 56px) or tap it and choose Reply. The reply bar shows above the box;
  the sent message shows a quote (tap it to jump to the original). Backend: `POST /groups/:id/messages` accepts `replyTo`
  (same-group, non-deleted, non-system messages only) and stores a snapshot of author + first 100 chars.
* **Tag:** tap a sender's name to insert `@Name`; `@tags` are highlighted.
* **Floating support (💬) button** is hidden on the Study and Profile tabs (Profile has "Contact support"). To remove it
  everywhere, delete the `#contactBtn` block in `index.html`.

## Update 6: remaining pages (new look applied everywhere)
* **Bottom nav** is now Home | Study | Rewards | Profile. Rewards = the old Access / Refer / Earn pages behind one tab with a
  segmented switch at the top of each (pages + logic unchanged; the old three nav buttons stay in the DOM, hidden, because
  `switchNavTab()` toggles them by id). The access status dot moved onto the Rewards tab.
* **Ads paused (moderation) mode** is respected: Rewards then opens Refer only, the switch is hidden and Profile hides "Access".
* **Profile page (new)** takes the Admin button and the theme toggle out of the Home topbar (same DOM nodes + ids, just moved).
* **Admin panel:** tabs became a 3-column tile grid (+ Lecture highlighted), rounded 28px sheet, new inputs/buttons.
* **Spin wheel / Access / Refer / forms / popups** restyled via `theme-focus.css`; text on accent2 backgrounds flips with the theme.
* New file: `public/rewards-ui.js`.

## Update 5: invisible text in the Study tab
`#page-study button{color:inherit}` outranked every component class (an #id beats classes), so active tabs, Start/Save
buttons, chips etc. got dark text on dark fills. The default is now wrapped in `:where()` (zero specificity), so each
component's own colour wins. Needs a WebView that supports `:where()` (Chrome/WebView 88+, Safari 14+).

## Update 4: the bot's video limits now apply to multi-select
The bot allows at most **3 lecture videos in a chat at once** (a 4th deletes the oldest immediately; owner exempt) and
**10 videos/day** (owner / admins with "bypass" exempt). Notes (documents) are not counted. Without handling this,
selecting 10 lectures would have deleted 7 of them instantly and used up the daily quota.
* Picker: the 4th lecture can't be selected ("Select first 3"), notes stay unlimited, owner is exempt.
* `/api/lectures/send` checks before building anything: videos > 3 -> 400 `too_many_videos`; more than today's remaining
  quota -> 400 `daily_limit`; and returns `replaces` (old videos in the chat that would be removed) so the app asks
  "N purane lecture video hat jayenge. Continue?" before opening the bot. A bulk-batch lecture counts as all its videos.
* `server.js` passes the real `MAX_ACTIVE_VIDEOS` / `DAILY_VIDEO_LIMIT` to the route (`courseRoutes.setLimits`) and
  exposes them in `/api/config`, so changing the constants in one place updates everything.

## Update 3: lectures not reaching the bot / notes opening a URL
Root cause: lecture and notes values are stored as a **bare code** (`RbZUHU`) or a legacy t.me link (the app's own
`openLecLink()` handles both). The new multi-select only understood full `https://t.me/...` links, so bare codes were
rejected by the server ("unsupported link") and bare-code notes were treated as external URLs and opened directly.
Fix: server and picker now accept bare codes, t.me / telegram.me links (with or without `https://`, any bot name),
use the bot's lookup order (stored file first, then a `B...` bulk batch), and external notes open through `openLecLink`.
Skipped items are logged as `[lectures/send] user <id> skipped: [...]` and the app shows a specific message.

## Update 2
* **Chat fixes:** the message box was rebuilt every 4s poll (typed text vanished), it sat behind the bottom nav,
  and load errors were silent. Now: the box is only rebuilt when your "can I write?" state changes, it sits above
  the nav, and an error message is shown if the chat can't load.
* **New look ("Focus")** via `public/theme-focus.css` (loaded last): cream/ink/lime tokens for light + dark,
  pastel bento batch tiles, segmented tabs, floating dock navigation, rounded rows, chapter progress bars,
  and a "Today's study" card on Home (daily target ring from the Study backend).
  Light (cream) is now the default for people who never picked a theme. To turn the new look off, delete the
  `<link href="/theme-focus.css">` line in `public/index.html`.

## New files
| File | What it is |
|---|---|
| `models/Study.js` | MongoDB models: profile, subjects, tasks, sessions, groups, group chat |
| `routes/study.js` | Backend for `/api/study/*` (timer, live room, stats, groups, roles, chat) |
| `public/study.js` | Study tab UI: timer, plan (target / subjects / to-do), stats |
| `public/study-social.js` | Groups, Global Room, group timers + chat, admin/co-admin management |
| `public/study.css` | Study tab styles (uses the app's existing theme variables) |
| `public/theme-focus.css` | The new visual theme (tokens + component overrides) |
| `public/lecture-picker.js/.css` | Lectures / Notes big buttons + multi-select popup |

## Changed files
* `server.js`: mounts `/api/study`, `studyRoutes.setBot(bot)`, group invite deep link `?start=grp_<CODE>`,
  and shutdown now saves running study timers before exit.
* `routes/course.js`: new `POST /api/lectures/send` (+ bot username cache).
* `public/index.html`: 5th nav tab "Study", `#page-study`, `switchNavTab('study')` hook,
  lecture rows replaced by `_lecPickerHtml(...)` (3 call sites), asset tags.

## How it works
**Multi-send.** The popup posts `{batchId, items:[{lectureId,type}]}` to `/api/lectures/send`.
The server re-checks premium access, resolves each lecture/notes link to its stored Telegram file, packs them
into a temporary bulk batch (`user_id = ms_<id>`, purged after 24h) and returns ONE `t.me/<bot>?start=BS...` link.
The bot's existing batch delivery sends everything (daily limit, 6h auto-delete, ban check unchanged).
Notes that are not Telegram links (e.g. Drive) open directly instead.

**Study timer.** The app sends a heartbeat every 30s. The server counts only *focus* time (breaks / pauses are
ignored), keeps live users in memory and saves a `StudySession` when the timer stops (or no heartbeat for 2 min).
Study days use IST. Sessions under 30s are discarded.

**Groups.** Roles: Admin (creator) > Co-admin (max 3) > Member. Co-admin can delete messages, pin, mute, remove
members and change chat settings. Only Admin can appoint co-admins, rename, change goal, delete the group.
A moderator can only act on someone of lower rank. Chat is polled every 4s, messages auto-delete after 30 days.
Group invite link: `https://t.me/<bot>?start=grp_<CODE>` -> bot sends a "Join Study Group" Mini App button.

## Deploy checklist
1. No new npm packages. No new env vars needed (`BOT_TOKEN`, `WEB_URL`, `MONGO_URI` already used).
   Optional: `BOT_USERNAME` (otherwise read from `bot.getMe()` at startup).
2. Deploy as ONE Node process. Live timers are in memory, so don't run several instances behind a load balancer.
3. First start creates the MongoDB collections and indexes automatically (incl. the 30-day chat TTL).
4. Open the app once in Telegram and test: start a timer, create a group, join with a second account.

## Known limits
* Global Room has no chat (spam risk); only live timers + today's leaderboard.
* A crash (not a normal restart/deploy) loses the running session's unsaved time.
* Deleted chat messages disappear for other people on their next full reload (incremental polling only adds new ones).
