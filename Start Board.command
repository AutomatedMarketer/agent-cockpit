#!/bin/bash
# Starts the board on this computer. Finds Node by its full path and works from a folder that holds
# nothing of the board's, so nothing that happens to sit in the board's folder can run in its place.

BOARD_DIR="${0%/*}"
case "$BOARD_DIR" in /*) ;; *) BOARD_DIR="$(cd "$BOARD_DIR" 2>/dev/null && pwd)" ;; esac
cd "$HOME" 2>/dev/null || cd /
# A double-click gives Terminal a short PATH; these are where Node usually lives on a Mac.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

pause_if_terminal() {
  if [ -t 0 ]; then read -r -p "Press Enter to close this window. " _; fi
}

NODE="$(command -v node)"
case "$NODE" in
  /*) ;;
  *)
    echo
    echo "The board needs Node, and it is not installed on this computer."
    echo "Install the current LTS version from https://nodejs.org , then double-click Start Board again."
    if [ -z "$BOARD_NO_OPEN" ]; then /usr/bin/open "https://nodejs.org/en/download"; fi
    pause_if_terminal
    exit 1
    ;;
esac

"$NODE" "$BOARD_DIR/local/check-node.cjs" || { pause_if_terminal; exit 1; }
"$NODE" "$BOARD_DIR/local/start.mjs" || {
  echo
  echo "The board stopped. Read the message above, then double-click Start Board to try again."
  pause_if_terminal
  exit 1
}
