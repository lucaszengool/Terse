#!/bin/bash
# Build the live engine's two native helpers as universal binaries (Apple Silicon + Intel). They ship inside
# Terse.app (Resources/gf-live, see tauri.conf.json); the models never do — setup.sh downloads those per Mac.
#   terse-gf-lipsync  wav2lip (Core ML) on every GPU of the Mac
#   terse-gf-video    idle clip -> raw frames + Vision face boxes (no ffmpeg)
#   terse-gf-duix     DUIX face2face (DINet, Core ML) pinned to the discrete GPU — HD reply mode
#   terse-gf-omnifast OmniVoice fast mode: models A + B with the prefix KV cache kept on the runner side
#   terse-gf-coreml   any Core ML model pinned to the discrete GPU (diagnostics / fallback)
set -e
cd "$(dirname "$0")"
for t in lipsync:lipsync-runner.swift video:gf-video.swift duix:duix-runner.swift omnifast:omnifast-runner.swift coreml:coreml-runner.swift; do
  name="terse-gf-${t%%:*}"; src="${t#*:}"
  swiftc -O -target arm64-apple-macosx13.0 "$src" -o "/tmp/$name-arm64"
  swiftc -O -target x86_64-apple-macosx13.0 "$src" -o "/tmp/$name-x86_64"
  lipo -create "/tmp/$name-arm64" "/tmp/$name-x86_64" -output "$name"
  rm -f "/tmp/$name-arm64" "/tmp/$name-x86_64"
  codesign --force --sign - "$name"
  lipo -info "$name"
done
