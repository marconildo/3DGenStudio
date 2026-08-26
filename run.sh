#!/usr/bin/env bash
# Launch 3D Gen Studio on Linux / macOS (the cross-platform counterpart of
# run.bat). Starts the Vite dev server + Node backend, the Python mesh-tools
# service, the SkinTokens rigging service and the MoCapAnything video-to-motion
# service (both Linux only — they self-skip on macOS), each logging to its own
# file, then opens the app in the browser.
#
# First launch is slow: the Python services build their uv virtual environments
# and download dependencies + model checkpoints in the background.
set -u
cd "$(dirname "$0")"

echo "Starting dev server (npm run dev) -> dev.log"
npm run dev > dev.log 2>&1 &

echo "Starting Python mesh-tools service -> python-server/python-server.log"
( cd python-server && bash run.sh > python-server.log 2>&1 ) &

echo "Starting SkinTokens rigging service -> thirdparty/skintokens/rig-server.log"
( cd thirdparty/skintokens && bash run_server.sh > rig-server.log 2>&1 ) &

echo "Starting MoCapAnything video-to-motion service -> thirdparty/mocapanything/mocap-server.log"
( cd thirdparty/mocapanything && bash run_server.sh > mocap-server.log 2>&1 ) &

# Give Vite + the backend a moment to come up.
sleep 3

URL="http://localhost:5173"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 &
else
  echo "Open $URL in your browser."
fi

echo
echo "3D Gen Studio is starting. Logs: dev.log, python-server/python-server.log, thirdparty/skintokens/rig-server.log, thirdparty/mocapanything/mocap-server.log"
echo "Press Ctrl+C to stop the dev server (background services keep running; close their windows/processes to stop them)."
wait
