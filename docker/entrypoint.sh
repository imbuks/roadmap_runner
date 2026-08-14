#!/bin/sh
# Bring up a screen for the Jira sign-in browser, publish it over noVNC, then hand off
# to the server. Nothing is drawn on that screen unless you actually sign in, so the X
# stack idles at nearly no cost for the rest of the container's life.
set -e

DISPLAY="${DISPLAY:-:99}"
export DISPLAY

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
  echo "Xvfb did not come up on $DISPLAY — browser sign-in will not work" >&2
fi

# -localhost keeps the raw VNC port inside the container, so noVNC on 6080 is the only
# way in and the password-less display is never exposed on its own
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -localhost -rfbport 5900 &
websockify --web=/usr/share/novnc 6080 localhost:5900 &

echo "Sign-in browser: http://localhost:6080/vnc.html"
exec node server/index.js
