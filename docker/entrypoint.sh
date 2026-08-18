#!/bin/sh
# Bring up a screen for the Jira sign-in browser, publish it over noVNC, then hand off
# to the server. Nothing is drawn on that screen unless you actually sign in, so the X
# stack idles at nearly no cost for the rest of the container's life.
set -e

DISPLAY="${DISPLAY:-:99}"
export DISPLAY

# A restart reuses the container's filesystem, so an X server killed along with the previous
# boot leaves its lock file behind. Xvfb reads that as "already active", refuses to start,
# and the sign-in browser is left without a screen for the rest of the container's life.
# Nothing else in here owns the display, so a lock nobody answers on is always stale.
DISPLAY_NUM=$(echo "$DISPLAY" | sed -n 's/^:\([0-9][0-9]*\).*/\1/p')
if [ -n "$DISPLAY_NUM" ] && ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
fi

Xvfb "$DISPLAY" -screen 0 "${SCREEN:-1600x1000x24}" -nolisten tcp &

# Wait for X to accept connections; starting x11vnc against a display that is not up yet
# makes it exit rather than retry
i=0
while [ "$i" -lt 100 ]; do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 0.1
done
if [ "$i" -ge 100 ]; then
  # The proxy and the UI are still worth serving without a screen, so carry on — but say
  # so plainly here, because the alternative is x11vnc's page of advice followed much
  # later by Chromium failing to launch, with nothing tying the two together.
  echo "Xvfb did not come up on $DISPLAY — browser sign-in will not work" >&2
else
  # -localhost keeps the raw VNC port inside the container, so noVNC on 6080 is the only
  # way in and the password-less display is never exposed on its own
  x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -localhost -rfbport 5900 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 &
  echo "Sign-in browser: http://localhost:6080/vnc.html"
fi

exec node server/index.js
