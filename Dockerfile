# syntax=docker/dockerfile:1

# ---------- Stage 1: build the React bundle ----------
FROM node:22-bookworm AS ui
WORKDIR /app

# This stage only compiles the bundle, so skip the browser download npm would otherwise
# do for Playwright — the runtime stage is the one that needs a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY src ./src
# An empty API base means same-origin requests. The server below serves this bundle
# itself, so the calls follow whatever host and port the container was published on
# rather than being pinned to localhost:4000.
ENV REACT_APP_API_BASE=""
RUN npm run build


# ---------- Stage 2: the proxy, the UI it serves, and a screen for the sign-in browser ----------
FROM node:22-bookworm AS runtime
WORKDIR /app

# Jira here sits behind an SSO gateway that no API token can satisfy, so signing in means
# opening a real browser window — and a container has no screen to open it on. Xvfb
# supplies one, x11vnc exports it, and noVNC turns that into a web page, so the sign-in
# window shows up in a tab on the host instead of vanishing into a headless void.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      x11-utils \
      novnc \
      websockify \
      tini \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --with-deps pulls in the shared libraries Chromium needs; npm ci has already fetched
# the browser itself, at the exact build this project's Playwright expects
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY server ./server
COPY --from=ui /app/build ./build
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_UI=1 \
    DISPLAY=:99 \
    SCREEN=1600x1000x24

# Kept off the shared session volume: a Chromium profile written on one platform is not
# safe to reopen with another platform's build
ENV ROADMAP_BROWSER_PROFILE=/var/lib/roadmap-runner/browser-profile

# The sign-in window opens on the virtual screen above, where nothing pops up on the
# user's desk. Telling the UI where to watch it is the difference between a sign-in that
# looks hung and one the user can actually complete. Override if you publish 6080
# elsewhere; compose binds it to loopback on the same port.
ENV ROADMAP_SIGNIN_VIEWER_URL=http://localhost:6080/vnc.html

# 4000 serves the app and the API; 6080 is the sign-in browser over noVNC
EXPOSE 4000 6080

# tini as PID 1, so Xvfb, x11vnc and websockify are reaped when the container stops
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
