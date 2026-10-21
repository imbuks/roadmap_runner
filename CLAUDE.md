# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # UI + Jira proxy, concurrently. The tracked .env sets PORT=4040, which CRA
                   # reads (UI on :4040); the server has no dotenv, so it stays on :4000 —
                   # which is what API_BASE defaults to.
npm start          # UI only (CRA dev server)
npm run server     # proxy only
npm run build      # production bundle into build/
npm run diagnose   # probe the stored Jira session through the gateway (server/diagnose-gateway.js)
npx playwright install chromium   # one-off; npm install does NOT fetch the browser

docker compose up -d --build      # single container on :4000 (UI + proxy), :6080 (sign-in browser over noVNC)
```

There is no test suite (`npm test` runs CRA's runner over zero test files) and no linter beyond
`react-scripts`' build-time ESLint. Verify server changes with `node --check server/index.js` plus a
manual run; verify UI changes in the browser.

Turning on tracing (off by default — the log otherwise carries only sign-ins, session lifecycle,
warnings, and errors):

- server: `DEBUG=1 npm run server` or `DEBUG=1 docker compose up -d`
- browser: `localStorage.debug = '1'` then reload, or `REACT_APP_DEBUG=1 npm start`

`build/` is **committed to the repo**. A UI change that should ship in the checked-in bundle needs
`npm run build` before committing; the Docker image builds its own copy and ignores the tracked one.

## Architecture

A CRA front end plus an Express proxy (`server/index.js` for the routes, with sessions and the
gateway in `server/session-manager.js`). Nothing in the
browser talks to Jira directly — every call goes to `POST /api/jira/<endpoint>` with a `sessionId`
in the JSON body, and the proxy holds the credentials and cookie jar.

### Routes (React Router, defined in `src/App.js`)

| Path | Component | Purpose |
| --- | --- | --- |
| `/` | `App.js` + `Timeline.js` | Excel-driven Gantt roadmap (vis-timeline), rows kept in `localStorage` under `roadmapData` |
| `/jiraminator` | `JiraMinator.js` | The main workhorse: a DataGrid for authoring, importing, bulk-editing and publishing Jira issues |
| `/pi-planner` | `PIPlanner.js` | PI planning views over the Feature → Epic → Story hierarchy |
| `/sprint-planner` | `SprintPlanner.js` | Sprints as buckets or as a list: create sprints, move issues between them, peek at one |
| `/confluence-sync` | `ConfluenceSync.js` | Publish a page bundle (manifest + storage-format XML + images) to a Confluence space |

`src/components/SharePointLists.js` is empty.

### Auth: three methods, one gateway problem

`src/hooks/useJiraAuth.js` is the only place the front end reaches the API. `jiraAuthService.apiCall`
injects the stored `sessionId`; `uploadAttachments` bypasses it because attachments are multipart.
`API_BASE` is `http://localhost:4000` in dev and empty (same-origin) in the Docker build.

Sessions carry an `authType` that decides the Authorization header (`buildAuthHeader`):
`basic` (user + token), `pat` (Bearer, Jira DC), and `sso` (browser sign-in; the header is a token if
one was supplied, otherwise *null* — `jiraFetch` drops empty headers).

The dominant complication in this codebase is that the target Jira sits behind an **F5 BIG-IP APM
gateway** that strips `Authorization` and answers intercepted requests with HTML under arbitrary
status codes. Everything that deals with it lives in
[server/session-manager.js](server/session-manager.js), the session handler: the store and its
copy on disk, `makeJiraFetch` and its recovery, the keepalive, and each session's state. Routes
only ask it for a session by id (`getSession(id, product)`) and a fetch for it. Consequences that
shape the server:

- `classifyInterception` treats *any* HTML body on a `/rest/` call as an interception (Jira's REST API
  never returns HTML), classifying it `'sso'` (needs a real browser) or `'apm'` (recoverable).
- `makeJiraFetch(jar, jiraUrl, auth)` wraps every outbound call: it buffers the body to inspect it
  (call sites get `{ ok, status, statusText, text() }`, not a live `Response`), and on interception
  re-establishes the gateway session and retries. Recovery is shared per cookie jar via a `WeakMap`
  + generation counter, so a burst of failing requests produces **one** recovery, not one each —
  critical because the gateway rejects concurrent policy evaluations, and because for `sso` a
  recovery means opening a browser window.
- A streamed body (a file upload) can only be sent once, and a redirect cannot be followed while
  one is in flight — so the attach route hands `jiraFetch` a `newBody` factory instead of a `body`,
  and the multipart form (with its boundary headers) is rebuilt for each attempt. A streamed
  request takes its redirects by hand (`redirect: 'manual'`), logs where the gateway sent it,
  and asks `probeInterception` what is in the way. The gateway sometimes bounces a request
  through `/my.policy` and straight back, which every other call follows without noticing — so
  when the probe finds the session fine, the upload is simply sent again, with no recovery at
  all. A call site that passes a plain stream is still recovered but not retried; the caller is
  told to try again.
- Recovery never clears a browser session's cookies (they are the credential), and when the
  gentle `apm` recovery finds a sign-in page in the way, an `sso` session escalates to the
  browser rather than failing with the token-oriented message.
- `server/browser-login.js` drives Playwright Chromium against a persistent profile
  (`~/.roadmap-runner/browser-profile`, or `ROADMAP_BROWSER_PROFILE`) so the IdP remembers the user
  and re-sign-in is usually silent. It also clears stale `SingletonLock` files.
- A keepalive pings `sso` sessions every 5 min (`JIRA_KEEPALIVE_MS`) while they've been used within
  2 h (`JIRA_KEEPALIVE_MAX_IDLE_MS`), using the *raw* cookie fetch — never `jiraFetch`, so a
  background ping can never pop a sign-in window.

Sessions are mirrored to `~/.roadmap-runner/sessions.json` (`0600`, 30-day TTL) including the whole
cookie jar, because for SSO the cookies *are* the credential.

**One session per site.** Every sign-in mints a fresh `sessionId` (the id is the bearer secret,
so it is never handed out any other way — the server has no auth of its own), but all ids for the
same product + URL point at one shared record: one jar, one credential, so one gateway recovery and
one sign-in window across tabs. Signing in again refreshes the session for ids issued earlier;
signing out signs the whole site out. `sessions.json` keeps its old one-entry-per-id shape (so the
Docker copy and older builds still read it) and ids are regrouped by site on load.

A gateway failure is thrown as a `GatewayError` (`status: 502`, `code`: `sso-required` |
`gateway` | `retry`), and routes answer with `errorStatus(err)` — so a 502 means "the gateway is
in the way" and a 500 means the server itself failed. `POST /api/session/status` reports what a
session's last request found (`unchecked` | `signed-in` | `recovering` | `signing-in` |
`needs-sign-in`, plus `lastError`) without sending anything to the gateway, so it is safe to poll.

A **Personal Access Token can be saved** ("Remember this token", Jira and Confluence alike;
[server/credentials.js](server/credentials.js)), so a session that ends — the 30-day TTL, a
`sessions.json` rewritten by another copy of the server — is quietly replaced rather than asking
for the token again. The token is kept AES-GCM-encrypted in `~/.roadmap-runner/credentials.json`;
the key is random bytes the browser made and keeps in `localStorage` (`roadmapVaultKey`) and sends
with the requests that use it. The split is deliberate: the dev server listens on every interface
with no auth of its own, so a server-only "sign in with the saved token" would sign in anyone on
the network. The token never goes back to the browser, only its last four characters. Sign-in
routes take `remember` (true saves, false forgets, absent leaves alone) and `useSaved` (stands in
for a blank token field). Passwords are never saved.

Both connections are managed in one place: [src/components/Connections.js](src/components/Connections.js),
the app-bar pill (a status dot each for Jira and Confluence) and its dialog, one section per product
since each needs its own PAT. At launch it settles both connections (`jiraAuthService.check()`,
`confluenceService.check()`: validate the stored session, else try the saved token) and opens the
dialog only for what is still missing. "Skip for now" holds it off for the tab (`sessionStorage`),
not for good. Pages open it with `openConnections()` rather than carrying sign-in forms of their own.
Confluence's state lives in a small store in `confluenceApi.js` (`useConfluenceAuth`), because the
header, the dialog and the sync page all show it. Statuses start as `'unknown'`, and the prompt waits
for the check, or it would open over a session that is about to turn out fine. An explicit sign-out
sets `signedOut` on the stored credentials, so the saved token does not sign straight back in. The
URL is kept, so the form reopens on the same site.

On the client, `withSession` (Jira) and `postWithSession` (Confluence) re-sign-in with the saved
token and retry once when the server answers "Invalid or missing … session". Only a `pat` session
is restored unattended. A browser session needs the user, and a password is not kept. Concurrent
failures share one re-sign-in. `validateSession` treats *only* that answer as signed out. Jira
being unreachable at page load used to sign people out of a session that was fine.

`process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` is set at the top of `server/index.js` for corporate
TLS interception.

### Jira field mapping

Custom field IDs differ per instance, so they are resolved **by field name** at request time in
`findTableFields` — `epic link`, `story points`, `sprint`, `application ci (as per cmdb)`, `team`.
Everything downstream (`mapIssueToRow`, `toTableRows`, `buildIssueFields`) is keyed off that result,
and a field that isn't found is silently skipped rather than failing the request.

`buildIssueFields` is the single write path shared by `create-story` and `update-story`. Only
non-empty values are written, except `description` and `labels`, which are sent even when blank so
clearing them in the UI clears them in Jira. Sprint is special: the field wants a numeric id, so
`resolveSprintId` looks the name up on the selected board — or, when no board is selected, across
every board on the project.

JQL differs by Jira version too, so parent lookups go through `searchWithFallback`, which tries a
list of candidate queries and moves past any rejected with a 400. `searchAllIssues` follows paging.

Rows key people and teams by the identifier Jira accepts on write (`name`, option id) while carrying
the display label alongside (`reporterName`, `teamName`) so the grid can render users outside the
loaded lists.

### The story agent

`POST /api/agent/chat` ([server/agent.js](server/agent.js)) backs the assistant rail in the story editor.
It is deliberately outside `/api/jira`: it needs no Jira session, and the keepalive middleware on that
prefix has nothing to do for it. Four transports live behind `AGENT_MODE`: `mock`
(the default, answering locally so the path works with nothing configured), `flow` (one POST to an
endpoint that replies in the same response), `directline` (the Copilot Studio agent itself), and
`ollama` (a model on this machine — no credentials, and the story text never leaves the host).

Direct Line creates a conversation per turn and discards it. That is what keeps the route stateless —
nothing to remember between requests, no way for two tabs to collide — at the price of one handshake
per message, which is nothing against a person typing. The watermark taken before posting is what
stops the agent's greeting being mistaken for the reply.

The conversation is stateless server-side. The browser holds the transcript and posts all of it each
turn, alongside the *current* story read fresh from the row — so a description the user hand-edited is
what the next turn builds on, and the transcript itself carries only the agent's prose.

A reply with more than one title line is a **split**. It is cut apart by those title lines, not by
its ``` fences (`splitByTitles`): with several stories, models fence the first and forget the rest,
or put them all in one block, and pairing fences blindly lost stories or cut one off before its
criteria. A broken story is named and left out rather than sinking the reply. Each is validated on its own and
they come back as `stories` rather than `patch`, which the grid adds as new draft rows (inheriting
epic, team, sprint and people from the row being split). The same route also backs the page-level
**Brainstorm** drawer on `/jiraminator`, sent with `intent: 'brainstorm'`: there is no story in
hand, so the prompt is about breaking an idea down, the "story as it stands" block is left out,
and even a single story comes back in `stories`. Because a brainstorm's proposals *are* the subject
of the conversation, the browser posts each assistant turn's `stories` back and the server folds the
**latest** set into that turn (`withLatestProposals`) — without it "make the second one smaller"
had no second one, and the model rebuilt everything or answered with nothing. The prompt makes a
revision resend the whole set, since what comes back replaces what was there. The brainstorm takes images too (attach, paste,
drop): scaled to 1280px in the browser, sent inline as data URLs on user turns — which is why
`/api/agent` has its own 25mb JSON limit ahead of the global parser — and capped at the newest six
per transcript. Ollama gets them per message; `/api/agent/status` reports `visionModels` from each
model's `/api/show` capabilities, and a model without vision is refused up front rather than left
to answer without having looked. Direct Line refuses images; `flow` is sent them as data URLs.

Two routes need no model at all. `/api/agent/validate` is pure parsing, so the editor can show
where a description stands against the template on every keystroke for free. `/api/agent/format`
(the dialog's Magic Format) tries the parser first and only calls a model when the text does not
already parse — a conforming story reformats in ~20ms instead of ~14s, and cannot drift.

[server/story-template.js](server/story-template.js) is where the canonical formats are enforced,
because a model asked nicely for a format drifts. It parses the reply, repairs what is safe to repair
(renumbering ACs, truncating an over-long title), and reports every deviation to the UI rather than
fixing things silently; a document missing a required section is re-requested once. Three things it
strips before anything reaches Jira: the template's instruction comment, the `**Field:** value`
metadata lines (they map to Jira *fields*, not description text), and the Notes section. `toPatch`
allowlists the result to the authored fields only, so a hallucinated epic key, team or sprint is
dropped rather than trusted — the same split the dialog's two columns draw.

The formats themselves live in `server/templates/<type>/<variant>.md` — `story/detailed.md`,
`story/simple.md`, `bug/default.md`, `task/default.md` today. **Nothing in the JS names a section**:
the level-2 headings in the file are the format, in the file's own order, and a heading marked
`(Optional)` is the only kind a document may leave out. Adding, renaming or reordering a section is
therefore a text edit in one file, with no code change and no restart — templates are re-read when
their mtime changes, since a stale in-memory copy looks exactly like the edit not having worked.
Two names the code does know: `Acceptance Criteria`, whose `### ACn:` headings the parser pulls
apart, and `Notes`, which is never published.

An optional frontmatter block (`label:`, `default:`) carries the picker's label and which variant a
type opens on. `resolveTemplate` falls back type-first — `<type>/<variant>` → the type's default →
`story` — so an issue type nobody has written a template for is still formatted as a story rather
than failing, and a Bug is formatted as a bug even when the chosen variant does not exist for it.
Every agent route takes `issueType` and `templateVariant` and resolves per request; `GET
/api/agent/templates` is what the dialog's picker is built from, and the chosen variant is remembered
per issue type in `localStorage` under `jiraMinatorTemplateVariants`.

Validation checks substance, not only shape. A model told firmly enough not to invent will return
the template's headings with every field blank, which passes any structural check; `validateStoryDoc`
treats empty criteria and a contentless User Story as hard failures, which triggers the one re-ask.
`buildSystemPrompt({ intent })` is why: formatting and refining are different jobs, and the format
prompt has to say what "don't invent" does not mean or a small model empties the story.

The dialog's three columns are toggled and resized from the title bar and remembered in
`localStorage` under `jiraMinatorPanels`, next to the grid's own column preferences. The description
editor is one source field plus one preview pane whatever the format — wiki is converted through
`jiraToMarkdown` for display — with a format-aware toolbar driven by the `MARKERS` table.

Two sizing rules in that block are load-bearing. Its `minHeight` must clear its own chrome
(metadata row + toolbar + a usable editor + footer, ~340px) or the editor spills over the Labels
field beneath it. And it must *shrink* rather than grow: a block sized to its content makes the
authoring column scroll and the preview pane never does, which leaves the sticky outline with
nothing to scroll. `jumpTo` measures with `getBoundingClientRect` rather than `offsetTop` — the
latter is relative to the nearest positioned ancestor, and mixing the two frames yields a negative
scroll that clamps to the top and looks like a jump list that does nothing.

One undo, in the dialog footer, for the last applied change from either Magic Format or the
assistant. The chat bubble deliberately does not carry its own: it scrolls out of sight.

### The sprint planner

A column per sprint plus one for the backlog, issues moved between them, and a peek panel
for the issue under the cursor. The same sprints are shown two ways — a **bucket view** of
draggable columns and a **list view**, one table with a section per sprint, chosen from the
title bar and remembered in `localStorage` under `sprintPlannerView`. They share their data,
their filters and the peek; what dragging does on the board, the Sprint cell on each row does
in the list, through the same `moveIssue`. Five routes back it, and they speak `/rest/agile/1.0`
throughout rather than the platform API that the rest of the server uses: writing the Sprint
custom field to move an issue is rejected on some instances and silently ignored on others,
while `POST /sprint/{id}/issue` is the operation Jira actually means. `sprint-issues`,
`create-sprint`, `move-issues` and `sprint-state` are new; `sprints` grew an `includeClosed`
flag and now carries dates and the goal alongside the `{id, name, state}` its older callers read.

- **The backlog is a column.** `'backlog'` stands in for a sprint id everywhere — the client
  sends it, `sprint-issues` reads `/board/{id}/backlog` for it and `move-issues` posts to
  `/backlog/issue`. One code path covers "into a sprint" and "out of every sprint".
- **Sub-tasks are left out** of a sprint's issues. They follow their parent's sprint in Jira,
  so a card for one would offer a move that cannot be made.
- `agileGetAll` honours both of the agile API's ways of announcing the last page (`isLast` on
  some collections, only a `total` on others) — a board with a long history of closed sprints
  otherwise stops silently at the first fifty.
- **A move is optimistic**, and a rejection puts the card back where it came from. The row
  being moved is read out of state *before* the update rather than inside the updater: React
  runs an updater on its own schedule, so a variable it assigns is not there yet on the next
  line — and the board would move the card while never telling Jira.
- Columns load a few at a time (`forEachWithLimit`), because each one is its own request and
  the gateway is happier with four than with a dozen.
- The planner's routes report **Jira's own words** on a rejection (`jiraErrorMessage` digs
  `errorMessages` out of the body): the browser only ever sees `error`, and "Jira API error"
  tells nobody why a sprint would not start.
- The peek edits through the same `update-story` path the grid publishes with, so the field
  mapping stays in one place. Moving is the exception — it happens on the spot through
  `move-issues`, not on save, since that is what dragging the card does too.
- **Filtering is by person as well as by text.** The assignee list is built from who actually
  holds an issue on this board rather than from the project's assignable users, since that is
  both shorter and the only list that can narrow anything. A column's points follow the filter
  — filtering to one person is how you find out what that person is carrying.

[src/utils/sprintPlan.js](src/utils/sprintPlan.js) is what the create dialog opens on, and it
is deliberately a separate module: it is pure arithmetic over the sprints a board already has,
and the only part of this page that can be checked without a browser.

- **The cadence is read, not assumed.** `inferCadenceDays` takes the *median* span of dated
  sprints, so one sprint left open for three months does not stretch every sprint planned
  after it; spans outside 1–90 days teach nothing and are ignored. Two weeks is the fallback
  for a board with nothing dated. The same number prefills the Start-sprint dialog.
- **The name is the next one in the series.** The trailing number counts up, zero padding and
  any suffix kept — `Sprint 24` → `Sprint 25`, `PI 2025.3 S2` → `PI 2025.3 S3` — skipping
  names already taken.
- **A new sprint starts when the last one ends**, which is what keeps a cadence unbroken. When
  the last sprint has already finished there is a gap rather than a chain, so it starts at the
  next occurrence of the weekday and hour the team usually starts on.
- The dialog says in words what it worked out and from where, because a guess that cannot be
  seen cannot be disagreed with. Moving the start carries the end with it: the cycle length is
  the thing being preserved.

### Confluence sync

A port of `cst-confluence-sync/push_to_confluence.py` (a stdlib Python script that publishes a
Notion export to Confluence DC). The engine is [server/confluence-sync.js](server/confluence-sync.js)
and knows nothing about HTTP routes or sessions; [server/confluence.js](server/confluence.js) holds
the routes under `/api/confluence`. It is **interchangeable with the script on purpose**: same
bundle, same `cst-sync` label, and the version comment `cst-sync:<hash>` is computed over the same
bytes, so a space the script published shows as unchanged here rather than republished. Matching
the hash means copying two Python behaviours: `json.dumps` of the labels (`", "` separators,
non-ASCII escaped as `\uXXXX`, surrogate pairs included) and `str(None)` for a page with no parent,
plus `read_text()` folding `\r\n` to `\n`. Change any of that and every page republishes.

- **A Confluence session is an entry in the Jira session store**, with `auth.product: 'confluence'`
  and its base URL in the `jiraUrl` field. That is how it gets the gateway recovery, persistence and
  keepalive for free. `identityPath(auth)` is the one thing that differs: the gateway helpers, the
  keepalive and the browser sign-in probe `/rest/api/user/current` for Confluence, because
  Confluence's HTML 404 for `/rest/api/2/myself` would read as an interception. `forProduct`
  rewrites "Jira" in the gateway's error messages. The `/api/jira` middleware refuses Confluence
  sessions so one can never reach a Jira route.
- Confluence answers bad or missing credentials as the **anonymous user** (200, `type:
  'anonymous'`), not with a 401, so sign-in, `current-user` and the browser probe all check for that.
- The folder is **read in the browser** ([src/utils/confluenceBundle.js](src/utils/confluenceBundle.js)
  `readLocalBundle`), so the page list, the bundle's problems and the preview all work before
  anything is sent, or even with Confluence not connected. The page uploads it only when a preview or
  publish needs it, once per folder. A server restarted since is answered by sending it again. The
  server validates it again regardless.
- The **preview** (`renderStorage`) turns storage format into HTML: callouts, the Page Properties
  box, expand, code, page links that open the linked page in the preview, and images from the
  folder as object URLs. The browser's HTML parser needs two things done first: CDATA
  becomes escaped text, and self-closed `ac:`/`ri:` tags are opened and closed, because an unknown
  `<ri:page/>` otherwise swallows its siblings. The output is built from an allowlist of tags,
  attributes and URL schemes (no `on*`, no `javascript:`, images only from `blob:`/`https:`), so it
  is safe to set as innerHTML. Keep it that way when adding a macro.
- **Selection** starts at everything, and everything selected sends no `only`, so it is the whole-bundle
  run the script does. The Select menu picks a section (a page and all its descendants). With a
  partial selection the preflight checks that each selected page's parent is selected or already in
  Confluence (by state id, or by title with the `cst-sync` label), and fails up front with the
  parents to add, marking the pages `blocked`.
- The bundle arrives as the files of a folder picked in the browser (`webkitdirectory`), with their
  paths in a separate `paths` field, because multipart filenames lose their directories. Its root
  is wherever `manifest.json` is. If the folder around it holds the script's
  `.cst-sync-state-<SPACE>.json`, those page ids seed a space this app has not published to yet.
  Bundles are held in memory (6 h, newest five).
- State (key → page id) lives in `~/.roadmap-runner/confluence-sync/state-<host>-<SPACE>.json`, in
  the script's own format, and is written after every page so a run that dies halfway still
  remembers what it created.
- A run is a **job the browser polls** (`sync-status` with `since`, so each poll carries only new
  log lines), one per space at a time. A first full publish is a few hundred requests. Stop takes
  effect between pages. The job id is kept in `sessionStorage`, so a reload picks the run back up.
- Attachments are uploaded as one prebuilt multipart `Buffer`, not a form-data stream, so a
  bounced upload is simply retried like any other call. Every write sends
  `X-Atlassian-Token: no-check`, which cookie-authenticated (browser) sessions need.
- The preflight's lookups are reused by the main pass. The script asks Confluence twice per page.
- The parent page can be given as an ID, a link, or a **title** (`resolvePage`). A
  `/display/SPACE/Title` link carries no ID at all. A title has to match exactly, but a hyphen also
  tries the en and em dash, since Confluence titles are often typed with a hyphen and stored with a
  dash. A miss says why: the page is in another space (CQL `title =`), or here are close titles
  (CQL `title ~`). Both the target check and the sync resolve the field the same way.
- The field itself is a search box (`ParentPagePicker`, backed by `/api/confluence/search-pages`
  and `searchPages`). It runs CQL `title ~` over the space with the last word as a prefix, falls
  back to the plain words if the wildcard finds nothing, and lists recently modified pages when
  empty. Each result carries its ancestors' titles, because a space can hold several "Features"
  pages. Picked or typed, the parent is stored as `{ parentId, parentTitle }` once resolved: kept
  by ID and shown by title. It is `freeSolo` so an ID or link can still be pasted, and since
  freeSolo suppresses MUI's no-options and loading text, an empty list shows one disabled line
  saying why.

The page's buttons are deliberately **not** disabled while the space and parent are being checked.
Leaving a field to click Preview starts that check, and a button that becomes disabled (or moves
because the summary above it changed height) between mouse-down and mouse-up never gets the
click. The old summary stays in place, dimmed, until the new one arrives.

### Descriptions

Jira REST v2 renders **wiki markup**, not Markdown. `src/utils/markdownToJira.js` converts on the way
out and `jiraToMarkdown.js` on the way back, as deliberate mirror images; rows carry a
`descriptionFormat` so already-wiki text is passed through untouched.

### Docker

One image serves everything on `:4000` (`SERVE_UI=1` makes the server host `build/`; off by default
so a dev `npm run server` never answers with a stale bundle). Because a container has no screen, the
image runs Xvfb + x11vnc + noVNC (`docker/entrypoint.sh`) and sets `ROADMAP_SIGNIN_VIEWER_URL` so the
UI can point at `http://localhost:6080/vnc.html` when a sign-in window opens.

Both ports are bound to `127.0.0.1` deliberately: the app holds live Jira credentials, has no
authentication of its own, and the noVNC screen has no password. Do not widen this casually.

`~/.roadmap-runner` is mounted from the host so a session earned either place works in the other —
but run only one at a time, since both rewrite the whole `sessions.json`. The browser profile is
*not* shared (a Chromium profile written on macOS isn't safe to reopen on Linux).
