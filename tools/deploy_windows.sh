#!/usr/bin/env bash
# Install / update MissClaude on the Windows side from WSL and (re)start it.
#
#   tools/deploy_windows.sh [--no-start] [--start-anyway] [--shortcut]
#
# Puts an Electron runtime (renamed MissClaude.exe) plus app/ into
# %LOCALAPPDATA%\MissClaude. Nothing needs to be installed on Windows itself.
# --shortcut also adds a Start Menu entry.
#
# A pet that is already running is updated in place and asked to restart itself
# (POST /v1/admin/restart), so it comes back in the session it was running in.
# If nothing runs and this WSL instance lives in Windows session 0 (started by a
# service, e.g. a remote/daemon setup), anything it launches gets no desktop: the
# pet would run invisibly and hold the API port. Then it is not started unless
# --start-anyway (useful for API-only tests); start it from the Start Menu instead.
set -euo pipefail

ELECTRON_VERSION=44.9.3
ELECTRON_SHA256=41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c

START=1
FORCE_START=0
SHORTCUT=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --start-anyway) FORCE_START=1 ;;
    --shortcut) SHORTCUT=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CMD=/mnt/c/Windows/System32/cmd.exe
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
# run Windows commands from a Windows directory (cmd.exe rejects UNC working dirs)
win() { (cd /mnt/c && "$CMD" /c "$@" 2>/dev/null | tr -d '\r'); }

LOCALAPPDATA_WIN=$(win "echo %LOCALAPPDATA%")
DEST=$(wslpath -u "$LOCALAPPDATA_WIN")/MissClaude
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/missclaude
ZIP=$CACHE/electron-v$ELECTRON_VERSION-win32-x64.zip

if [ ! -f "$ZIP" ]; then
  mkdir -p "$CACHE"
  echo "downloading Electron $ELECTRON_VERSION (win32-x64)..."
  curl -fL --progress-bar -o "$ZIP.part" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-x64.zip"
  mv "$ZIP.part" "$ZIP"
fi
echo "$ELECTRON_SHA256  $ZIP" | sha256sum -c --quiet - || { echo "checksum mismatch: $ZIP" >&2; exit 1; }

API=http://127.0.0.1:27826/v1
RUNNING=0
curl -s -m 2 "$API/health" >/dev/null 2>&1 && RUNNING=1
NEW_RUNTIME=0
[ "$(cat "$DEST/.electron-version" 2>/dev/null || true)" != "$ELECTRON_VERSION" ] && NEW_RUNTIME=1
if [ "$NEW_RUNTIME" = 1 ]; then
  # the runtime files are locked while it runs
  echo "stopping a running MissClaude (if any)..."
  win "taskkill /IM MissClaude.exe /F" >/dev/null || true
  for _ in $(seq 20); do  # wait until it is really gone (it holds the API port)
    win "tasklist /FI \"IMAGENAME eq MissClaude.exe\" /NH" | grep -qi missclaude || break
    sleep 0.5
  done
  RUNNING=0
fi

if [ "$(cat "$DEST/.electron-version" 2>/dev/null || true)" != "$ELECTRON_VERSION" ]; then
  echo "installing Electron runtime into $LOCALAPPDATA_WIN\\MissClaude ..."
  rm -rf "$DEST.new"
  mkdir -p "$DEST.new"
  unzip -q "$ZIP" -d "$DEST.new"
  mv "$DEST.new/electron.exe" "$DEST.new/MissClaude.exe"
  rm -f "$DEST.new/resources/default_app.asar"
  # keep user-visible files like logs out of the way: only the runtime is replaced
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
  echo "$ELECTRON_VERSION" > "$DEST/.electron-version"
fi

echo "syncing app/ ..."
mkdir -p "$DEST/resources/app"
rsync -a --delete "$ROOT/app/" "$DEST/resources/app/"

EXE_WIN=$(wslpath -w "$DEST/MissClaude.exe")
if [ "$SHORTCUT" = 1 ]; then
  ICON_WIN=$(wslpath -w "$DEST/resources/app/assets/icon.ico")
  (cd /mnt/c && "$PS" -NoProfile -Command "\$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\"\$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\MissClaude.lnk\"); \$s.TargetPath = '$EXE_WIN'; \$s.IconLocation = '$ICON_WIN'; \$s.Description = 'MissClaude desktop pet'; \$s.Save()") \
    && echo "Start Menu shortcut created"
fi

if [ "$RUNNING" = 1 ]; then
  # a running pet restarts itself, in its own desktop session (works from session 0 too)
  if curl -s -m 3 -X POST "$API/admin/restart" | grep -q restarting; then
    echo "running pet is restarting with the update"
  else
    echo "updated; this running version cannot restart itself: right-click her (or the tray icon) > 退出, then start MissClaude again"
  fi
  START=0
fi

if [ "$START" = 1 ]; then
  SESSION=$(cd /mnt/c && "$PS" -NoProfile -Command '(Get-Process -Id $PID).SessionId' | tr -d '\r')
  if [ "$SESSION" = 0 ] && [ "$FORCE_START" = 0 ]; then
    echo "not starting: this WSL runs in Windows session 0 (no desktop), the pet would be invisible."
    echo "start it from the Start Menu (MissClaude) or $EXE_WIN"
  else
    # Start-Process does not hand our interop pipes to the child, so this returns at
    # once (cmd /c start would wait for as long as the pet runs)
    (cd /mnt/c && "$PS" -NoProfile -Command "Start-Process -FilePath '$EXE_WIN'")
    echo "started $EXE_WIN (session $SESSION)"
  fi
fi
