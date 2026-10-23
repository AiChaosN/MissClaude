#!/usr/bin/env bash
# Build the Windows release zip: Electron runtime + app/, exe icon and version set.
#
#   tools/build_release.sh [VERSION]      (default: the version in package.json)
#
# Output: dist/MissClaude-win32-x64-v<VERSION>.zip and its .sha256. The staging dir
# lives on the Windows side so rcedit.exe (icon/version resource editor) can run on
# the exe through WSL interop; nothing has to be installed on Windows.
set -euo pipefail

ELECTRON_VERSION=44.9.3
ELECTRON_SHA256=41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c
RCEDIT_URL=https://github.com/electron/rcedit/releases/latest/download/rcedit-x64.exe

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=${1:-$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")}
NAME=MissClaude-win32-x64-v$VERSION
CMD=/mnt/c/Windows/System32/cmd.exe
win() { (cd /mnt/c && "$CMD" /c "$@" 2>/dev/null | tr -d '\r'); }
TEMP_WIN=$(win "echo %TEMP%")
STAGE_PARENT=$(wslpath -u "$TEMP_WIN")/missclaude-release
STAGE=$STAGE_PARENT/$NAME
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/missclaude
ZIP=$CACHE/electron-v$ELECTRON_VERSION-win32-x64.zip
DIST=$ROOT/dist

mkdir -p "$CACHE" "$DIST"
if [ ! -f "$ZIP" ]; then
  echo "downloading Electron $ELECTRON_VERSION (win32-x64)..."
  curl -fL --progress-bar -o "$ZIP.part" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-x64.zip"
  mv "$ZIP.part" "$ZIP"
fi
echo "$ELECTRON_SHA256  $ZIP" | sha256sum -c --quiet - || { echo "checksum mismatch: $ZIP" >&2; exit 1; }
if [ ! -f "$CACHE/rcedit-x64.exe" ]; then
  echo "downloading rcedit..."
  curl -fL -o "$CACHE/rcedit-x64.exe" "$RCEDIT_URL"
fi

echo "staging $NAME ..."
rm -rf "$STAGE_PARENT"
mkdir -p "$STAGE"
unzip -q "$ZIP" -d "$STAGE"
mv "$STAGE/electron.exe" "$STAGE/MissClaude.exe"
rm -f "$STAGE/resources/default_app.asar"
mkdir -p "$STAGE/resources/app"
rsync -a --exclude '__pycache__' "$ROOT/app/" "$STAGE/resources/app/"
cp "$CACHE/rcedit-x64.exe" "$STAGE_PARENT/rcedit-x64.exe"
cat > "$STAGE/README.txt" <<EOF
MissClaude $VERSION - Claude as a desktop pet (Windows x64)

Run MissClaude.exe. She stands on the taskbar; right-click her (or the tray icon)
for the menu. Settings, rules.json and main.log live in %APPDATA%\\MissClaude.
Local API for other programs: http://127.0.0.1:27826/v1 (see docs/API.md in the
repository). Source: https://github.com/AiChaosN/MissClaude
EOF

echo "setting icon and version on MissClaude.exe ..."
# rcedit is a Windows program: run it straight through WSL interop (no cmd.exe quoting),
# with Windows paths as its arguments
EXE_WIN=$(wslpath -w "$STAGE/MissClaude.exe")
ICON_WIN=$(wslpath -w "$STAGE/resources/app/assets/icon.ico")
(cd /mnt/c && "$STAGE_PARENT/rcedit-x64.exe" "$EXE_WIN" --set-icon "$ICON_WIN" \
  --set-file-version "$VERSION" --set-product-version "$VERSION" \
  --set-version-string ProductName MissClaude --set-version-string FileDescription "MissClaude desktop pet" \
  --set-version-string CompanyName AiChaosN --set-version-string OriginalFilename MissClaude.exe)
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \
  "(Get-Item '$EXE_WIN').VersionInfo | Select-Object FileVersion, ProductName | Format-List" 2>/dev/null | tr -d '\r' | grep -v '^$' || true

echo "zipping ..."
rm -f "$DIST/$NAME.zip"
(cd "$STAGE_PARENT" && python3 - "$NAME" "$DIST/$NAME.zip" <<'PY'
import os, sys, zipfile
name, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, _dirs, files in os.walk(name):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, p)
PY
)
(cd "$DIST" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
rm -rf "$STAGE_PARENT"
ls -la "$DIST/$NAME.zip"
cat "$DIST/$NAME.zip.sha256"
