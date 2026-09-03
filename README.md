# Roadmap React App

This React application allows you to upload an Excel file with the following columns:

- Category
- Feature
- StartDate
- EndDate
- ColorHex

It then renders a Gantt-style roadmap using Vis Timeline.

## Getting Started

1. Install dependencies:
   ```
   npm install
   ```
2. Install the browser used for Jira sign-in. `npm install` does **not** do this for you —
   Playwright downloads its browsers separately:
   ```
   npx playwright install chromium
   ```
   Only needed if you use "Sign in with browser" (see [Jira behind an SSO gateway](#jira-behind-an-sso-gateway)).
3. Start the app and the Jira proxy together:
   ```
   npm run dev
   ```
   Or separately: `npm start` for the UI, `npm run server` for the proxy on port 4000.
4. Open [http://localhost:3000](http://localhost:3000) in your browser.
5. Upload your Excel file to see the roadmap.

## Jira behind an SSO gateway

Some Jira instances are published through an access gateway (F5 BIG-IP APM) that
authenticates you *before* the request reaches Jira. `jiraagile.emirates.com` is one of
them: it is a SAML Service Provider fronting Microsoft Entra ID, and it discards the
`Authorization` header entirely — a request with a Personal Access Token and one with no
credentials at all get byte-identical redirects to `/my.policy`. **No API token can reach
Jira through it.**

The only thing that satisfies such a policy is a real browser, so the connection dialog
offers **Sign in with browser**. The server opens a Chromium window, you complete SSO and
any MFA prompt, and the cookies that result are lifted into the server's cookie jar.

**Fill in a Personal Access Token as well.** The gateway and Jira authenticate separately —
getting past the gateway lands you on Jira's *own* login page, which would otherwise be a
second sign-in every time. Supplying a token answers that layer instead: the browser only
has to satisfy the gateway, and the window closes as soon as it does. The token was never
the problem; the gateway was, and it rejected the token before Jira could see it. Generate
one in Jira under **Profile → Personal Access Tokens**.

Two things keep this from becoming a nuisance:

- **A keepalive ping** every 5 minutes stops the gateway's inactivity timeout from firing
  while you are working. Sessions idle for more than 2 hours are left to lapse rather than
  holding a corporate SSO session open on an unattended machine. Both intervals are tunable
  with `JIRA_KEEPALIVE_MS` and `JIRA_KEEPALIVE_MAX_IDLE_MS`.
- **A persistent browser profile** at `~/.roadmap-runner/browser-profile` means the identity
  provider remembers you, so re-signing-in is usually a window that opens and closes by
  itself. Gateways also enforce a maximum session lifetime that nothing can extend, so
  expect one genuine prompt every day or so.

If Jira stops responding and you want to know whether it is the gateway or something else:

```
npm run diagnose
```

This probes the Jira URL from your stored session with and without credentials, follows the
redirect chain, and reports what actually answered. It never prints your token.

### Files it keeps

Both live in `~/.roadmap-runner/`, created with owner-only permissions, and neither belongs
in the repo:

| Path | Contents |
| --- | --- |
| `sessions.json` | Jira credentials and session cookies (`0600`) |
| `browser-profile/` | The sign-in browser's profile, including your Entra session (`0700`) |

Signing out through the app clears the Jira session. To also make the browser forget who you
are, delete `browser-profile/`.

## Running in Docker

One container serves the UI, the Jira proxy, and the sign-in browser:

```
docker compose up -d --build
```

`-d` detaches, so the container keeps running after you close the terminal and comes back
by itself when Docker restarts (`restart: unless-stopped`). Drop `-d` only when you want the
log in the foreground; `--build` is needed the first time and after any code change.

Then open [http://localhost:4000](http://localhost:4000) — a single port this time, because
the server serves the built bundle itself rather than the two-port dev split.

The first build takes several minutes and produces a large image: it installs Chromium,
which browser sign-in cannot do without.

Once detached, the container is managed from outside:

| Command | What it does |
| --- | --- |
| `docker compose logs -f` | Follow the log (`Ctrl-C` leaves the container running) |
| `docker compose ps` | Check it is up |
| `docker compose restart` | Restart without rebuilding |
| `docker compose stop` | Stop it, keeping the container and its volumes |
| `docker compose down` | Stop and remove it; the session and profile volumes survive |
| `docker compose up -d --build` | Rebuild and replace it after a code change |

Nothing is lost on a restart: sessions live in the mounted `~/.roadmap-runner`, so a
detached container that is stopped and started again picks the Jira session back up.

### Signing in from inside a container

The catch is that browser sign-in needs a *visible* browser, and a container has no screen.
The image supplies one — Xvfb, exported through noVNC — so when the app opens the sign-in
window it appears at **[http://localhost:6080/vnc.html](http://localhost:6080/vnc.html)**.
Open that tab, complete SSO and MFA there, and the window closes on its own.

Most of the time you will not need it. `~/.roadmap-runner` is mounted from your home
directory, so a session you already earned on the host is picked up by the container as it
starts, and the gateway keepalive holds it open from there. Run one at a time, though: the
host and the container both rewrite the whole `sessions.json`, and the last writer wins.

The container keeps its own `browser-profile/` in a named volume rather than sharing yours,
since a Chromium profile written by macOS is not safe to reopen with a Linux build. That is
the one thing the container cannot inherit, so a sign-in inside it always starts cold.

### What the config does

| File | Role |
| --- | --- |
| `Dockerfile` | Builds the bundle, then an image with the server, Chromium, and the X/noVNC stack |
| `docker-compose.yml` | Ports, the session mount, and Chromium's shared-memory bump |
| `docker/entrypoint.sh` | Starts the display and noVNC, then hands off to the server |

Both ports are published on `127.0.0.1` on purpose. The app carries live Jira credentials
and has no authentication of its own, and the noVNC screen has no password, so neither
should be reachable from the network. Publishing them more widely is not a change to make
casually.

Two environment variables are worth knowing about, beyond the keepalive ones above:
`SERVE_UI=1` is what makes the server serve `build/` (off by default, so `npm run server`
alongside the dev server never answers with a stale bundle), and `REACT_APP_API_BASE`
is baked in empty at image build time so API calls stay same-origin.

## Wiring in the story assistant

The story editor has a chat rail that refines one story and harmonizes it to the canonical
format. Out of the box it runs against a local stand-in — the rail works and says **mock**,
but nothing is being asked. Pointing it at the real agent is configuration, not code.

**If the story logic lives in your Copilot Studio agent** (the usual case), talk to the agent:

1. In Copilot Studio, open **Channels → Custom website** (or **Mobile app**) and copy the
   **Token Endpoint URL**.
2. Check **Settings → Security → Authentication**. This has to be **No authentication** for
   the token endpoint to be usable on its own. "Authenticate with Microsoft" means an Entra
   app registration and user tokens, which this does not yet do.
3. Set the endpoint and restart the server:

   ```
   AGENT_MODE=directline
   AGENT_TOKEN_ENDPOINT=https://…/directline/token?api-version=…
   ```

Treat that URL as a secret: anyone holding it can talk to your agent. It belongs in the
environment or in `.env`, never in the bundle — which is why the browser never sees it and
every call goes through the proxy.

**If you have no Copilot Studio credits** — or would rather the story text never left the
machine — run a model locally with [Ollama](https://ollama.com) instead:

```
AGENT_MODE=ollama AGENT_OLLAMA_MODEL=llama3.1 npm run server
```

Note the shape of that: the proxy reads its configuration from the **environment**, not from
`.env`. Nothing here loads that file — `docker compose` substitutes it into the compose file,
which is why the Docker instructions below can say "in your `.env`", but `npm run server`
never sees it. Export the variables in your shell if you would rather not retype them.

(Adding `dotenv` to the server would be the obvious tidy-up and is a trap: `.env` sets
`PORT=4040` for the CRA dev server, and the proxy reading that would move it off 4000 —
which is where `API_BASE` points by default.)

Nothing else is needed: no key, no endpoint, no account. `ollama serve` has to be running
and the model pulled (`ollama pull llama3.1`), and the rail hides itself when it isn't
rather than offering a button that only errors.

`AGENT_OLLAMA_MODEL` names the model the assistant *opens* on, not the only one it can use:
every model installed on the host is listed, and the chip naming the current one in the
assistant's header is a picker. Switching it changes which model answers the next turn and
the next Magic Format — the transcript is resent whole each turn, so a conversation can
change model mid-way — and the choice is remembered in that browser. There is nothing to
restart, though the list is read once when the page loads: pull a model and reload. An 8B model holds the story format well —
what it costs you is a first request that waits for the model to load (about 45s here) and
roughly 12s a turn after that. A smaller model is faster and asks more clarifying
questions instead of inventing detail, which is not the worst trait in a story assistant.

Format drift is the thing to expect from a small model, and it is handled rather than
hoped away: a reply that breaks the format is re-requested once with the specific failures
named, criteria that come back misnumbered are renumbered, and anything the model invents
about the Epic, Team or Sprint is dropped before you see it.

**Want Ollama in Docker too?** There is an opt-in profile for it, so the container carries
its own model rather than depending on one installed on the host:

```
docker compose --profile ollama up -d --build
```

with `AGENT_MODE=ollama` and `AGENT_OLLAMA_URL=http://ollama:11434` in your `.env` (this is
the Docker path, where compose does read that file). The app
reaches it by service name over the compose network, so none of the host-networking
awkwardness below applies. Your existing `~/.ollama` is mounted in, so the models you have
already pulled are reused rather than downloaded again — but run one Ollama at a time.
Nothing new is published: only the app can reach it. To pull a model into it:

```
docker compose exec ollama ollama pull llama3.1
```

The reason not to, on a Mac: containers get no Metal, so this runs on the CPU and a model
that answers in seconds natively will take substantially longer. Give Docker Desktop enough
memory for the model too — an 8B model at Q4 wants ~6 GB, and the container is simply killed
if it cannot have it. On a Linux host with an NVIDIA card there is no penalty: uncomment the
`deploy` block in `docker-compose.yml` and it runs on the GPU.

**Running the app in Docker and Ollama on the host?** Two things bite. `localhost` inside
the container is the container, so the URL has to be `http://host.docker.internal:11434`
(the compose file already defaults to it). And Ollama listens on `127.0.0.1` by default,
which refuses that connection — start it as `OLLAMA_HOST=0.0.0.0 ollama serve`, or set the
same variable in the Ollama app's settings.

**If the logic lives in a Power Automate flow instead**, use its HTTP-trigger URL:

```
AGENT_MODE=flow
AGENT_URL=https://prod-…/workflows/…/triggers/manual/paths/invoke?…&sig=…
```

The flow is handed `{ system, messages, story, context }` and should answer with the reply
text, either bare or as JSON under `reply`, `text`, `output` or `result`.

**Magic Format** is the one-press version: it reshapes the description into the template
without opening the chat. A story that already parses is reformatted by the parser alone —
instant, free, and no model involved — so the button only waits when the text genuinely has
to be restructured. It applies straight away; **Undo format** stays in the dialog footer
until you do something else.

The badge under the editor says where the description stands at all times: *Matches
template*, *N tidy-ups* (it parses, but something like criterion numbering is off), or *N
template issues*. That check is pure parsing, so it costs nothing and needs no agent.

Either way the agent is asked for the canonical story format and its answer is checked
against it before it reaches the grid: acceptance criteria are renumbered if they drift, an
over-long title is truncated, a reply missing a required section is asked for again, and
anything the agent tries to say about the Epic, Team or Sprint is dropped. Those fields stay
yours to choose. Nothing is written to a story without you pressing **Apply**.

If the agent takes its time, `AGENT_REPLY_TIMEOUT_MS` (60s) and `AGENT_REPLY_QUIET_MS` (2s —
how long a reply must stay finished before it counts as complete) are both tunable.

## Turning the noise up

By default the log carries only what you would want to see on a normal day: sign-ins,
session expiry, warnings, and errors. The per-request tracing — the JQL actually sent, the
custom-field values that came back — is what you need when Jira returns something in an
unexpected shape, and is off until you ask for it.

Server side, in Docker or natively:

```
DEBUG=1 docker compose up -d
DEBUG=1 npm run server
```

The browser console has its own switch, because by then the bundle is already built and a
build-time flag would be no use against a running container. In devtools:

```js
localStorage.debug = '1'        // reload to trace the import epic by epic
localStorage.removeItem('debug')  // back to quiet
```

For a dev session, `REACT_APP_DEBUG=1 npm start` does the same thing at build time.

## Excel Format

The Excel file must contain a sheet named `RoadmapInput` (or the first sheet) with columns:
- Category (text)
- Feature (text)
- StartDate (date)
- EndDate (date)
- ColorHex (hex code, e.g. `#7E57C2`)

Save the file as `.xlsx` and upload via the file input in the app.
