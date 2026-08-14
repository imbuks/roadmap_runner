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
docker compose up --build
```

Then open [http://localhost:4000](http://localhost:4000) — a single port this time, because
the server serves the built bundle itself rather than the two-port dev split.

The first build takes several minutes and produces a large image: it installs Chromium,
which browser sign-in cannot do without.

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

## Excel Format

The Excel file must contain a sheet named `RoadmapInput` (or the first sheet) with columns:
- Category (text)
- Feature (text)
- StartDate (date)
- EndDate (date)
- ColorHex (hex code, e.g. `#7E57C2`)

Save the file as `.xlsx` and upload via the file input in the app.
