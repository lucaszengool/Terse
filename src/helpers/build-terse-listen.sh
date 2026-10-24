#!/bin/bash
# 编译 terse-listen(通用二进制:Apple Silicon + Intel)。和 terse-hands 一样:产物随仓库提交,
# 由 tauri.conf.json 的 bundle.resources 打进 Terse.app/Contents/Resources/。
set -e
cd "$(dirname "$0")"
# 把 Info.plist 嵌进二进制 —— 没有 NSMicrophoneUsageDescription / NSSpeechRecognitionUsageDescription
# 的裸命令行程序会被系统不弹框直接拒绝。
PL="-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker terse-listen-Info.plist"
swiftc -O -target arm64-apple-macosx12.0 terse-listen.swift -o /tmp/terse-listen-arm64 -framework AVFoundation -framework Speech $PL
swiftc -O -target x86_64-apple-macosx12.0 terse-listen.swift -o /tmp/terse-listen-x86_64 -framework AVFoundation -framework Speech $PL
lipo -create /tmp/terse-listen-arm64 /tmp/terse-listen-x86_64 -output terse-listen
rm -f /tmp/terse-listen-arm64 /tmp/terse-listen-x86_64
codesign --force --sign - terse-listen
lipo -info terse-listen
