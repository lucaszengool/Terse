#!/bin/bash
# package-dmg.sh — re-package the Tauri DMG with a bilingual install guide and a
# Terminal shortcut, so users of an UNSIGNED build are not left to figure out
# Gatekeeper on their own.
#
# Terse ships without an Apple Developer signature, so macOS quarantines it and
# shows "damaged and can't be opened". The fix is two commands, but a user who
# has to find them on their own usually just deletes the app instead. This puts
# the instructions and a one-click Terminal right in the disk image.
#
#   ./scripts/package-dmg.sh [path/to/Terse_x.y.z_x64.dmg]
#
# Re-runnable: always rebuilds from the source DMG, never edits it in place.
set -euo pipefail

SRC="${1:-src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Terse_1.3.3_x64.dmg}"
[ -f "$SRC" ] || { echo "no such dmg: $SRC" >&2; exit 1; }

APP_NAME="Terse.app"
WORK="$(mktemp -d)"
MNT="$WORK/mnt"
RW="$WORK/rw.dmg"
OUT="${SRC%.dmg}-guided.dmg"
trap 'hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$WORK"' EXIT

# Eject any Terse volume still mounted from an earlier build FIRST. A stale one
# keeps the "Terse" volume name, so the freshly built image mounts as "Terse 1"
# and double-clicking shows the OLD contents under the expected title — which
# reads exactly like the new files failed to make it into the image.
for v in /Volumes/Terse*; do
  [ -d "$v" ] && hdiutil detach "$v" -force -quiet 2>/dev/null && echo "→ ejected stale volume: $v"
done

echo "→ converting to a writable image"
hdiutil convert "$SRC" -format UDRW -o "$RW" -quiet

echo "→ mounting"
mkdir -p "$MNT"
hdiutil attach "$RW" -nobrowse -noverify -noautoopen -mountpoint "$MNT" -quiet

VOL="$MNT"
[ -d "$VOL/$APP_NAME" ] || { echo "$APP_NAME not found in the image" >&2; exit 1; }

echo "→ adding the bilingual install guide"
# CRLF: the file is opened in TextEdit by users on both macOS and (occasionally)
# Windows; LF-only renders as one long line in some viewers.
cat > "$VOL/安装说明 Install Guide.txt" <<'GUIDE'
Terse — 安装说明 / Install Guide
========================================

【中文】

第一步
将 Terse 拖入右侧的 Applications 文件夹。

第二步
双击本窗口里的「终端」图标打开终端，粘贴以下命令后按回车：

codesign --force --deep --sign - /Applications/Terse.app && xattr -dr com.apple.quarantine /Applications/Terse.app

完成后即可正常打开 Terse。

为什么需要这一步？
Terse 目前没有 Apple 开发者签名，macOS 会拦截未签名的应用并提示「已损坏」。
上面的命令用你自己的电脑给它做一次本地签名，并移除下载隔离标记。
这不会修改应用内容，也不会降低系统安全设置。

----------------------------------------

【English】

Step 1
Drag Terse into the Applications folder on the right.

Step 2
Double-click the "Terminal" icon in this window, then paste this command and
press Return:

codesign --force --deep --sign - /Applications/Terse.app && xattr -dr com.apple.quarantine /Applications/Terse.app

Terse will then open normally.

Why is this needed?
Terse is not yet signed with an Apple Developer certificate, so macOS blocks it
and reports that it is "damaged". The command above signs it locally on your
own machine and clears the download quarantine flag. It does not modify the
app's contents and does not weaken any system security setting.

----------------------------------------

官网 / Website:  https://www.terseai.org
支持 / Support:  support@terseai.org
GUIDE

# Strip extended attributes and normalise the mode. Files written here inherit
# com.apple.provenance from this process, and a sandboxed reader (TextEdit is
# the one users will double-click with) refuses such a file with "你没有权限"
# even though the POSIX bits are 644 on a noowners volume.
xattr -c "$VOL/安装说明 Install Guide.txt" 2>/dev/null || true
chmod 644 "$VOL/安装说明 Install Guide.txt"

echo "→ adding the Terminal shortcut"
# Symlink so it carries Terminal's own icon with an alias badge, exactly like a
# Finder alias, without needing to build an .alias resource.
if [ -d /System/Applications/Utilities/Terminal.app ]; then
  ln -sf /System/Applications/Utilities/Terminal.app "$VOL/终端 Terminal"
elif [ -d /Applications/Utilities/Terminal.app ]; then
  ln -sf /Applications/Utilities/Terminal.app "$VOL/终端 Terminal"
else
  echo "  ! Terminal.app not found — skipping the shortcut" >&2
fi

echo "→ laying out the window"
# Tauri ships its own .DS_Store that fixes the window geometry for exactly two
# icons. Anything added afterwards is placed outside the visible area, so the
# guide and the Terminal shortcut were IN the image but invisible in Finder —
# which is the same as not shipping them. Position all four deliberately.
#
# Finder automation (Apple Events) is used here; note this is NOT the System
# Events accessibility permission, which is a separate grant.
rm -f "$VOL/.DS_Store"
osascript <<OSA >/dev/null 2>&1 || echo "  ! Finder layout skipped (automation not permitted)" >&2
tell application "Finder"
  tell folder (POSIX file "$VOL" as alias)
    open
    set theWindow to container window
    set current view of theWindow to icon view
    set toolbar visible of theWindow to false
    set statusbar visible of theWindow to false
    set the bounds of theWindow to {200, 120, 900, 600}
    set opts to the icon view options of theWindow
    set arrangement of opts to not arranged
    set icon size of opts to 96
    set position of item "安装说明 Install Guide.txt" to {120, 90}
    set position of item "Terse.app" to {250, 250}
    set position of item "Applications" to {540, 250}
    set position of item "终端 Terminal" to {120, 370}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
sync

echo "→ unmounting"
hdiutil detach "$MNT" -quiet
trap 'rm -rf "$WORK"' EXIT

echo "→ compressing"
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" -quiet

# ── Verify, then claim success ────────────────────────────────────────────────
# "done" has to mean the image really contains all four items. Two of the steps
# above fail SOFTLY — Terminal.app may not be where we look for it, and the
# AppleScript layout can be refused — so without this the script would happily
# print "done" over a disk image missing the very thing it exists to add. That
# is exactly how nine builds went out with no install guide at all.
echo "→ verifying the finished image"
VERIFY="$WORK/verify"
mkdir -p "$VERIFY"
hdiutil attach "$OUT" -nobrowse -readonly -noautoopen -mountpoint "$VERIFY" -quiet
MISSING=""
for item in "$APP_NAME" "Applications" "安装说明 Install Guide.txt" "终端 Terminal"; do
  [ -e "$VERIFY/$item" ] || MISSING="$MISSING\n  · $item"
done
hdiutil detach "$VERIFY" -quiet
if [ -n "$MISSING" ]; then
  echo "FAILED — the image is missing:$(printf "$MISSING")" >&2
  rm -f "$OUT"
  exit 1
fi

echo
echo "done: $OUT"
echo "  contains: $APP_NAME · Applications · 安装说明 Install Guide.txt · 终端 Terminal"
ls -lh "$OUT"
