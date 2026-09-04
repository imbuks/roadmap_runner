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

A CRA front end plus an Express proxy (`server/index.js`, ~1900 lines, one file). Nothing in the
browser talks to Jira directly — every call goes to `POST /api/jira/<endpoint>` with a `sessionId`
in the JSON body, and the proxy holds the credentials and cookie jar.

### Routes (React Router, defined in `src/App.js`)

| Path | Component | Purpose |
| --- | --- | --- |
| `/` | `App.js` + `Timeline.js` | Excel-driven Gantt roadmap (vis-timeline), rows kept in `localStorage` under `roadmapData` |
| `/jiraminator` | `JiraMinator.js` | The main workhorse: a DataGrid for authoring, importing, bulk-editing and publishing Jira issues |
| `/pi-planner` | `PIPlanner.js` | PI planning views over the Feature → Epic → Story hierarchy |

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
status codes. Consequences that shape the server:

- `classifyInterception` treats *any* HTML body on a `/rest/` call as an interception (Jira's REST API
  never returns HTML), classifying it `'sso'` (needs a real browser) or `'apm'` (recoverable).
- `makeJiraFetch(jar, jiraUrl, auth)` wraps every outbound call: it buffers the body to inspect it
  (call sites get `{ ok, status, statusText, text() }`, not a live `Response`), and on interception
  re-establishes the gateway session and retries. Recovery is shared per cookie jar via a `WeakMap`
  + generation counter, so a burst of failing requests produces **one** recovery, not one each —
  critical because the gateway rejects concurrent policy evaluations, and because for `sso` a
  recovery means opening a browser window.
- Non-replayable bodies (file uploads) are recovered but not retried; the caller is told to try again.
- `server/browser-login.js` drives Playwright Chromium against a persistent profile
  (`~/.roadmap-runner/browser-profile`, or `ROADMAP_BROWSER_PROFILE`) so the IdP remembers the user
  and re-sign-in is usually silent. It also clears stale `SingletonLock` files.
- A keepalive pings `sso` sessions every 5 min (`JIRA_KEEPALIVE_MS`) while they've been used within
  2 h (`JIRA_KEEPALIVE_MAX_IDLE_MS`), using the *raw* cookie fetch — never `jiraFetch`, so a
  background ping can never pop a sign-in window.

Sessions are mirrored to `~/.roadmap-runner/sessions.json` (`0600`, 30-day TTL) including the whole
cookie jar, because for SSO the cookies *are* the credential.

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
