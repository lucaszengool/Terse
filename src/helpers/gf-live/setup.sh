#!/bin/bash
# setup.sh — one-click setup for the live digital human (AI 女友 实时模式). Run by Terse (girlfriend.rs gf_live_setup).
#
# Installs everything into $GF_HOME (default ~/.terse/gf-live); the app bundle ships none of it:
#   bin/uv, venv/ (Python + light runtime deps), bin/llama/ (llama.cpp server), models/ (lip-sync Core ML pair,
#   voice, brain, DUIX), qwentts/ (her designed voice), presets/char_mia/ (her clips — the app carries only her manifest +
#   poster; GF_ONLY=mia runs just that step, e.g. for the 4K twins). Idempotent and resumable: every step checks what is already
#   there; downloads resume; every downloaded model is sha256-checked. Terse writes setup.wanted when a setup starts
#   and resumes it at the next launch until this script removes it (girlfriend.rs gf_live_autoresume).
#
# Output protocol (stdout, one line each — Terse turns them into a progress bar; users never see the items):
#   P <done_bytes> <total_bytes>        progress (bytes-weighted across all steps)
#   S <phase>                           download | install | optimize | verify
#   OK                                  finished
#   ERR <message>                       failed (Terse shows a generic retry)
set -uo pipefail

HOME_DIR="${GF_HOME:-$HOME/.terse/gf-live}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# the Mac's own CPU, not this process's: under Rosetta (Terse started as x86_64 on Apple silicon) `uname -m` says x86_64 and
# every download below would be the Intel build, running translated — no Metal, slow, no AVX. hw.optional.arm64 is 1 on
# Apple silicon whatever the process is (Apple: "About the Rosetta translation environment"; CMake / Homebrew do the same)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then ARCH=arm64; else ARCH=x86_64; fi
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/models" "$HOME_DIR/tmp"
LOCK="$HOME_DIR/setup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # a lock whose setup is gone (app quit, Mac shut down, crash — the lock outlives the process) is stale
  OLD=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null && ps -p "$OLD" -o command= 2>/dev/null | grep -q "setup.sh"; then
    echo "ERR already running"; exit 1
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || { echo "ERR lock"; exit 1; }
fi
echo $$ > "$LOCK/pid"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$LOCK"' EXIT     # never leave a curl writing behind us
trap 'exit 143' TERM INT HUP                    # run the EXIT trap on a kill too

say() { echo "$@"; }
fail() { say "ERR $*"; exit 1; }

# ── this Mac (10-21, user: "自动识别任何用户的mac电脑配置"): written to hw.json, read by the engine and Terse to pick the
# brain's GPU offload and which DUIX draws her mouth ──
OSV="$(sw_vers -productVersion 2>/dev/null)"; OSMAJ="${OSV%%.*}"
[ "${OSMAJ:-0}" -ge 12 ] 2>/dev/null || fail "macOS 12 or later is needed (this Mac: ${OSV:-unknown})"
RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1073741824 ))
PCORES=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null || echo 4)
GPUS="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2}' | paste -sd'|' -)"
if [ "$ARCH" = arm64 ]; then GPU_CLASS=apple                      # Apple GPU + Neural Engine: Metal / Core ML for everything
elif echo "$GPUS" | grep -qiE "radeon|amd|nvidia|geforce"; then GPU_CLASS=dgpu   # Intel + discrete GPU: full DUIX on it
else GPU_CLASS=igpu; fi                                            # Intel graphics only: the small real-time DUIX
printf '{"arch":"%s","macos":"%s","ram_gb":%d,"perf_cores":%d,"gpu":"%s","gpu_class":"%s"}\n' \
  "$ARCH" "$OSV" "$RAM_GB" "$PCORES" "$(echo "$GPUS" | tr -d '"\\')" "$GPU_CLASS" > "$HOME_DIR/hw.json"

# ── sizes (bytes) for the progress bar; refined from Content-Length when a download starts ──
SZ_UV=20000000; SZ_PY=130000000; SZ_TORCH=$([ "$ARCH" = arm64 ] && echo 90000000 || echo 170000000)
SZ_W2L=214670409; SZ_KOKORO=364816464; SZ_LLAMA=12000000; SZ_BRAIN=2497280256
# 10-19: her designed voice (qwentts.cpp + Qwen3-TTS 0.6B Base) and HD replies (DUIX face2face)
SZ_EXTRA=60000000; SZ_QBIN=2693982; SZ_QTALK=628905056; SZ_QCODEC=291150624; SZ_DUIX=394492416
# 10-20 real time (user: "≤ 1 s"): brain = Hunyuan-1.8B (~4x faster than Qwen3-4B here; Tencent Hunyuan Community License,
# territory excludes EU / UK / South Korea — Terse is not offered there), voice = MeloTTS + sweet.py (pyworld)
SZ_BRAIN2=1133084864; SZ_MELO=167006755; SZ_EXTRA3=8000000
# 10-20 fast DUIX (user: "DUIX 要更快,每句都有 match 的口型"): the same DUIX model split in two — optional add-on
SZ_FAST=200776704; FAST_SHA=8d0eef81081f112074243c5437bd155669bf23c0e82ab42f746cc1edc1401ed5
BRAIN2_SHA=558ae86fc4251fd73cd54685319a83e7550997537e3ad41043ad5c0b5a2a26d4
MELO_SHA=e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514
# 10-21 her voice: MediaTek Research Breeze2-VITS (Taiwanese Mandarin, sherpa-onnx; in MediaTek's Apache-2.0 BreezeApp) from HF
SZ_BREEZE2=123600935
# 10-21 voice input the repo's way (beiyege-01/dsh-voice-ai-girlfriend /api/stt = FunASR Paraformer-large): k2-fsa's sherpa-onnx
# export of the same ModelScope model (int8), unpacked to models/asr/paraformer/<name>/ — only the model + tokens kept.
# ⚠ weights = FunASR Model License (attribution + keep the model name; silent on commercial use, "reference and learning"
# disclaimer) — confirm with Alibaba / a lawyer before a paid release, like Breeze2 (NOTICE.md)
SZ_PARAFORMER=234051698; PARAFORMER_SHA=9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03
PARAFORMER_NAME=sherpa-onnx-paraformer-zh-2023-09-14
BREEZE2_FILES="breeze2-vits.onnx:13c5d190f911e8ab78db460749b5216663ea0b9497d4d4a2f35800b86fa4d6cf
lexicon.txt:fee63cb838fd0fb295292df8e42fcf5470204b4ced1f4fea8a9a01ef6cc1255e
tokens.txt:34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402"
# Terse-hosted builds (a static qwentts.cpp tts-server, the DUIX models converted to Core ML); the GGUFs come from HF.
ASSETS="${GF_ASSETS:-https://github.com/lucaszengool/Terse/releases/download/gf-live-assets-1}"
QBIN_SHA=95e0ee5c2b37a77ca37fcdff7f47d4263a5194814259bbfda3679e43703f3112
DUIX_SHA=62ad3aedd5456ac66c548a3e583b796051ffbf7420d338cb65753e5fe0ac4740
QTALK_SHA=4b468ec7b1f62b90ef4ca316c0aa57deadfd54b2cf9651703ea753cedaf04226
QCODEC_SHA=1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94
# her clips (10-22, user: "模型、素材这些都应该是用户在 AI 女友页点一键配置时才下载"): the app carries only her manifest + a
# poster — mia-pack = everything she plays and talks on, mia-4k = the 4K twins, fetched once the user picks 4K
# (presets/want-4k, girlfriend.rs gf_live_fetch_4k). Built by scripts/make-mia-pack.sh.
SZ_MIA=44037120; MIA_SHA=065eea4ed2909e7b3e4e0d7b87193ccc432b6cb5267ae6d7382302532549b92e
SZ_MIA4K=23199232; MIA4K_SHA=e1de2f7b1004854774f55602ee13f9e7e229a9938fde29bebd617ad46394f88b
MIA_DIR="$HOME_DIR/presets/char_mia"
need() { [ -e "$1" ] && echo 0 || echo "$2"; }
TOTAL=0; DONE=0
add_total() { TOTAL=$((TOTAL + $1)); }
add_total "$(need "$HOME_DIR/bin/uv" $SZ_UV)"
add_total "$(need "$HOME_DIR/venv/.ok" $SZ_PY)"
add_total "$(need "$HOME_DIR/models/w2l256_dec_fp16.mlpackage/Manifest.json" $((SZ_W2L + SZ_TORCH)))"
add_total "$(need "$HOME_DIR/bin/llama/llama-server" $SZ_LLAMA)"
add_total "$(need "$HOME_DIR/models/.brain-hunyuan-1.8b" $SZ_BRAIN2)"
add_total "$(need "$HOME_DIR/venv/.ok2" $SZ_EXTRA)"
add_total "$(need "$HOME_DIR/qwentts/build/.v2" $SZ_QBIN)"
add_total "$(need "$HOME_DIR/qwentts/models/qwen-talker-0.6b-base-Q4_K_M.gguf" $SZ_QTALK)"
add_total "$(need "$HOME_DIR/qwentts/models/qwen-tokenizer-12hz-Q8_0.gguf" $SZ_QCODEC)"
add_total "$(need "$HOME_DIR/models/duix/.ok" $SZ_DUIX)"
add_total "$(need "$HOME_DIR/venv/.ok3" $SZ_EXTRA3)"
add_total "$(need "$HOME_DIR/models/vits-melo-tts-zh_en/model.onnx" $SZ_MELO)"
add_total "$(need "$HOME_DIR/models/breeze2-vits/.ok" $SZ_BREEZE2)"
add_total "$(need "$HOME_DIR/models/asr/paraformer/$PARAFORMER_NAME/model.int8.onnx" $SZ_PARAFORMER)"
add_total "$(need "$HOME_DIR/models/duix/.fast1" $SZ_FAST)"
add_total "$(need "$MIA_DIR/.pack1" $SZ_MIA)"
if [ -e "$HOME_DIR/presets/want-4k" ]; then add_total "$(need "$MIA_DIR/.4k1" $SZ_MIA4K)"; fi
if [ "${GF_ONLY:-}" = "mia" ]; then                             # just her clips (the 4K choice in settings): progress over those
  TOTAL=$(need "$MIA_DIR/.pack1" $SZ_MIA)
  if [ -e "$HOME_DIR/presets/want-4k" ]; then TOTAL=$((TOTAL + $(need "$MIA_DIR/.4k1" $SZ_MIA4K))); fi
fi
[ $TOTAL -eq 0 ] && TOTAL=1
# room for what is still missing + unpacking / the Python runtime (~3 GB) — fail now with a clear reason, not halfway
FREE_KB=$(df -Pk "$HOME_DIR" 2>/dev/null | awk 'NR==2{print $4}')
if [ "$TOTAL" -gt 1 ] && [ -n "$FREE_KB" ] && [ $(( FREE_KB / 1024 )) -lt $(( TOTAL / 1048576 + 3072 )) ]; then
  fail "disk: need about $(( TOTAL / 1073741824 + 3 )) GB free, $(( FREE_KB / 1048576 )) GB left"
fi
progress() { say "P $((DONE + ${1:-0})) $TOTAL"; }
progress

# fetch <url...> -- <dest> <expected_size>: resumable download that rotates mirrors.
# A mirror that stops sending without closing the connection is the failure that matters (10-17: one sat at
# 1.56/2.5 GB for two hours) — curl's own speed limit never fires if no data arrives at all, so a watchdog
# here kills any attempt whose file hasn't grown for 45 s and moves on, always resuming the same .part.
fetch() {
  local urls=() dest size
  while [ "$1" != "--" ]; do urls+=("$1"); shift; done; shift
  dest="$1"; size="$2"
  local tries=0 max=$(( ${#urls[@]} * 4 ))
  while [ $tries -lt $max ]; do
    local u="${urls[$((tries % ${#urls[@]}))]}"; tries=$((tries + 1))
    # a tiny leftover (an error page from a failed try, a cut first packet) is not worth resuming — resuming it glues the real
    # file behind "Not Found" and the checksum fails; start over
    if [ "$size" -ge 1000000 ] && [ -e "$dest.part" ] && [ "$(stat -f %z "$dest.part" 2>/dev/null || echo 0)" -lt 65536 ]; then rm -f "$dest.part"; fi
    pkill -f -- "-o $dest.part" 2>/dev/null       # a curl orphaned by a killed run would append to the same .part
    curl -sL -C - --connect-timeout 15 --speed-limit 50000 --speed-time 30 -o "$dest.part" "$u" &
    local pid=$! last=-1 still=0
    while kill -0 $pid 2>/dev/null; do
      local cur; cur=$(stat -f %z "$dest.part" 2>/dev/null || echo 0)
      if [ "$cur" -eq "$last" ]; then still=$((still + 1)); else still=0; last=$cur; fi
      [ $still -ge 90 ] && { kill $pid 2>/dev/null; break; }          # 90 x 0.5 s = 45 s without a byte
      [ "$cur" -gt "$size" ] && cur=$size
      progress "$cur"; sleep 0.5
    done
    wait $pid 2>/dev/null; local rc=$?
    local got; got=$(stat -f %z "$dest.part" 2>/dev/null || echo 0)
    if { [ $rc -eq 0 ] || [ $rc -eq 33 ]; } && [ "$got" -gt 0 ]; then
      # a mirror that answers with an HTML error page is not the file
      if [ "$size" -lt 1000000 ] || [ "$got" -ge $((size * 3 / 10)) ]; then mv "$dest.part" "$dest"; DONE=$((DONE + size)); progress; return 0; fi
      head -c 300 "$dest.part" 2>/dev/null | grep -qiE "<html|<!doctype|not found|error" && rm -f "$dest.part"
    fi
    sleep 1
  done
  return 1
}

# sha_ok <file> <sha256>: the file is there and intact (a resumed or mirrored download can be wrong)
sha_ok() { [ -e "$1" ] && [ "$(shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1)" = "$2" ]; }

# fetch_v <sha256> <url...> -- <dest> <size>: fetch, then verify; a corrupt file is deleted (the next run, or Terse's
# automatic retry, downloads it again) instead of being trusted
fetch_v() {
  local sha="$1"; shift
  local args=("$@") dest="${args[$((${#args[@]} - 2))]}"
  if sha_ok "$dest" "$sha"; then return 0; fi
  rm -f "$dest"
  fetch "$@" || return 1
  say "S verify"
  sha_ok "$dest" "$sha" && return 0
  rm -f "$dest" "$dest.part"; return 1
}

# pick the fastest of a few mirrors for the big brain file (2 MB probe each)
fastest() {
  local best="" bestspeed=0
  for u in "$@"; do
    local sp; sp=$(curl -sL -m 8 -r 0-2000000 -o /dev/null -w "%{speed_download}" "$u" 2>/dev/null | cut -d. -f1)
    [ -n "$sp" ] && [ "$sp" -gt "$bestspeed" ] && { bestspeed=$sp; best="$u"; }
  done
  echo "${best:-$1}"
}

# ── 0. her clips: unpacked next to everything else, swapped in whole (a half-unpacked folder is never what Terse lists);
#        4K twins already fetched survive a newer pack ──
mia_step() {
  mkdir -p "$HOME_DIR/presets" "$HOME_DIR/tmp"; rm -f "$HOME_DIR/tmp/mia.unpublished"
  if [ ! -e "$MIA_DIR/.pack1" ]; then
    say "S download"
    local t="$HOME_DIR/tmp/mia-pack-1.tar"
    # GitHub answers 404 right away when the file isn't published: say so in seconds (000 = GitHub unreachable from here:
    # the mirrors below still work)
    local code; code=$(curl -s -o /dev/null -I -L -m 12 -w "%{http_code}" "$ASSETS/mia-pack-1.tar" 2>/dev/null)
    [ "$code" = "404" ] && { touch "$HOME_DIR/tmp/mia.unpublished"; fail "her clips not on the server yet"; }
    local u=("$ASSETS/mia-pack-1.tar" "https://ghfast.top/$ASSETS/mia-pack-1.tar" "https://gh-proxy.com/$ASSETS/mia-pack-1.tar")
    [ "$code" = "000" ] && u=("${u[1]}" "${u[2]}" "${u[0]}")       # GitHub didn't answer from here: the mirrors first
    fetch_v "$MIA_SHA" "${u[@]}" -- "$t" $SZ_MIA || fail "her clips"
    say "S install"
    rm -rf "$MIA_DIR.new" && mkdir -p "$MIA_DIR.new" && tar xf "$t" -C "$MIA_DIR.new" || fail "her clips unpack"
    [ -f "$MIA_DIR.new/idle_calm.mp4" ] && [ -f "$MIA_DIR.new/manifest.json" ] || fail "her clips check"
    if [ -d "$MIA_DIR/4k" ]; then mv "$MIA_DIR/4k" "$MIA_DIR.new/4k"; [ -e "$MIA_DIR/.4k1" ] && touch "$MIA_DIR.new/.4k1"; fi
    rm -rf "$MIA_DIR" && mv "$MIA_DIR.new" "$MIA_DIR" && touch "$MIA_DIR/.pack1" || fail "her clips install"
    rm -f "$t"
    say "S clips"; progress                          # Terse shows her now (silent, gestures) — the rest of setup keeps going
  fi
  if [ -e "$HOME_DIR/presets/want-4k" ] && [ ! -e "$MIA_DIR/.4k1" ]; then
    say "S download"
    local t4="$HOME_DIR/tmp/mia-4k-1.tar"
    fetch_v "$MIA4K_SHA" "$ASSETS/mia-4k-1.tar" "https://ghfast.top/$ASSETS/mia-4k-1.tar" "https://gh-proxy.com/$ASSETS/mia-4k-1.tar" \
      -- "$t4" $SZ_MIA4K || fail "her 4K clips"
    say "S install"
    tar xf "$t4" -C "$MIA_DIR" && touch "$MIA_DIR/.4k1" || fail "her 4K clips unpack"
    rm -f "$t4"
  fi
}
if [ "${GF_ONLY:-}" = "mia" ]; then mia_step; say "P $TOTAL $TOTAL"; say "OK"; exit 0; fi
# in the full setup her clips failing (offline, the release not reachable) must not stop the models: a subshell, so its
# `fail` only ends this step; step 11 reports the missing clips and Terse's automatic retry fetches just them
( mia_step ) || say "S download"

# ── 1. uv (Python manager — users don't need Python or Xcode) ──
if [ ! -x "$HOME_DIR/bin/uv" ]; then
  say "S download"
  UV_ASSET=$([ "$ARCH" = arm64 ] && echo uv-aarch64-apple-darwin.tar.gz || echo uv-x86_64-apple-darwin.tar.gz)
  fetch "https://github.com/astral-sh/uv/releases/latest/download/$UV_ASSET" \
        "https://ghfast.top/https://github.com/astral-sh/uv/releases/latest/download/$UV_ASSET" -- "$HOME_DIR/tmp/uv.tgz" $SZ_UV || fail "uv"
  tar xzf "$HOME_DIR/tmp/uv.tgz" -C "$HOME_DIR/tmp" && mv "$HOME_DIR"/tmp/uv-*/uv "$HOME_DIR/bin/uv" && chmod +x "$HOME_DIR/bin/uv" || fail "uv unpack"
  rm -rf "$HOME_DIR"/tmp/uv*
fi
UV="$HOME_DIR/bin/uv"
export UV_PYTHON_INSTALL_DIR="$HOME_DIR/python" UV_CACHE_DIR="$HOME_DIR/tmp/uv-cache"

# ── 2. runtime venv (light: no torch) ──
if [ ! -e "$HOME_DIR/venv/.ok" ]; then
  say "S install"
  progress $((SZ_PY / 5))
  "$UV" venv --python 3.11 "$HOME_DIR/venv" -q >/dev/null 2>&1 \
    || UV_PYTHON_INSTALL_MIRROR="https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download" \
       "$UV" venv --python 3.11 "$HOME_DIR/venv" -q >/dev/null 2>&1 || fail "python"
  progress $((SZ_PY / 2))
  NP=$([ "$ARCH" = x86_64 ] && echo "numpy<2" || echo "numpy")
  "$UV" pip install -q --python "$HOME_DIR/venv/bin/python" "$NP" pillow fastapi "uvicorn[standard]" websockets sherpa-onnx >/dev/null 2>&1 \
    || "$UV" pip install -q --python "$HOME_DIR/venv/bin/python" --index-url https://pypi.tuna.tsinghua.edu.cn/simple "$NP" pillow fastapi "uvicorn[standard]" websockets sherpa-onnx >/dev/null 2>&1 \
    || fail "python packages"
  touch "$HOME_DIR/venv/.ok"; DONE=$((DONE + SZ_PY)); progress
fi
PY="$HOME_DIR/venv/bin/python"

# ── 3. lip-sync model: download the checkpoint, convert to Core ML on this Mac, drop the converter ──
if [ ! -e "$HOME_DIR/models/w2l256_dec_fp16.mlpackage/Manifest.json" ]; then
  say "S download"
  W2L="$HOME_DIR/tmp/w2l.pth"
  [ -e "$W2L" ] || fetch "https://huggingface.co/CherryOnes/LiveTalking/resolve/main/wav2lip.pth" \
                         "https://hf-mirror.com/CherryOnes/LiveTalking/resolve/main/wav2lip.pth" \
                         "https://huggingface.co/yiliAST/livetalking-assets/resolve/main/models/wav2lip.pth" -- "$W2L" $SZ_W2L || fail "lip model"
  say "S optimize"
  CV="$HOME_DIR/tmp/convert-venv"
  if [ "$ARCH" = arm64 ]; then TORCH="torch==2.5.1"; CT="coremltools==8.2"; NPC="numpy<2"; else TORCH="torch==2.2.2"; CT="coremltools==7.2"; NPC="numpy<2"; fi
  "$UV" venv --python 3.11 "$CV" -q >/dev/null 2>&1 || fail "converter python"
  progress $((SZ_TORCH / 4))
  "$UV" pip install -q --python "$CV/bin/python" "$TORCH" "$CT" "$NPC" >/dev/null 2>&1 \
    || "$UV" pip install -q --python "$CV/bin/python" --index-url https://pypi.tuna.tsinghua.edu.cn/simple "$TORCH" "$CT" "$NPC" >/dev/null 2>&1 \
    || fail "converter packages"
  progress $((SZ_TORCH * 3 / 4))
  "$CV/bin/python" "$HERE/convert_w2l.py" "$W2L" "$HOME_DIR/models" >"$HOME_DIR/tmp/convert.log" 2>&1 || fail "convert"
  rm -rf "$CV" "$W2L"                            # ~1 GB of converter we never need again
  DONE=$((DONE + SZ_TORCH)); progress
fi

# ── 4. (Kokoro is no longer installed: her voice is MeloTTS 甜妹 (step 8b) / the designed voices (step 8);
#        an older install keeps its Kokoro, the engine only uses it if asked to) ──

# ── 5. brain server (llama.cpp prebuilt release for this CPU; picks AVX2 etc. at run time) ──
if [ ! -x "$HOME_DIR/bin/llama/llama-server" ]; then
  say "S download"
  PAT=$([ "$ARCH" = arm64 ] && echo "bin-macos-arm64.tar.gz" || echo "bin-macos-x64.tar.gz")
  PINNED="https://github.com/ggml-org/llama.cpp/releases/download/b11706/llama-b11706-$PAT"     # tested 10-17
  NEWEST=$(curl -sL -m 20 "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10" | grep -o "https://[^\"]*$PAT" | head -1)
  fetch "$PINNED" "https://ghfast.top/$PINNED" ${NEWEST:+"$NEWEST"} -- "$HOME_DIR/tmp/llama.tgz" $SZ_LLAMA || fail "brain server"
  rm -rf "$HOME_DIR/tmp/llama" && mkdir -p "$HOME_DIR/tmp/llama" && tar xzf "$HOME_DIR/tmp/llama.tgz" -C "$HOME_DIR/tmp/llama" || fail "brain unpack"
  SRV=$(find "$HOME_DIR/tmp/llama" -name llama-server -type f | head -1)
  [ -n "$SRV" ] || fail "brain server missing"
  rm -rf "$HOME_DIR/bin/llama" && mv "$(dirname "$SRV")" "$HOME_DIR/bin/llama" && chmod +x "$HOME_DIR/bin/llama/llama-server"
  xattr -dr com.apple.quarantine "$HOME_DIR/bin/llama" 2>/dev/null
  rm -rf "$HOME_DIR/tmp/llama" "$HOME_DIR/tmp/llama.tgz"
fi

# ── 6. brain model: Hunyuan-1.8B-Instruct Q4_K_M (≈ 20 tok/s on an Intel i9 vs 4–9 for Qwen3-4B — her first clause in
#        ~0.5 s). An install that still has the older Qwen3-4B brain.gguf is switched over (and the old file removed). ──
if [ ! -e "$HOME_DIR/models/.brain-hunyuan-1.8b" ]; then
  say "S download"
  F=tencent_Hunyuan-1.8B-Instruct-Q4_K_M.gguf
  fetch_v "$BRAIN2_SHA" "https://huggingface.co/bartowski/tencent_Hunyuan-1.8B-Instruct-GGUF/resolve/main/$F" \
                        "https://hf-mirror.com/bartowski/tencent_Hunyuan-1.8B-Instruct-GGUF/resolve/main/$F" -- "$HOME_DIR/tmp/brain2.gguf" $SZ_BRAIN2 || fail "brain"
  mv -f "$HOME_DIR/tmp/brain2.gguf" "$HOME_DIR/models/brain.gguf" && touch "$HOME_DIR/models/.brain-hunyuan-1.8b" || fail "brain install"
fi

# ── 7. runtime extras for HD replies (DUIX: ONNX Runtime for WeNet / SCRFD / PFLD, OpenCV for the face crops) ──
if [ ! -e "$HOME_DIR/venv/.ok2" ]; then
  say "S install"
  CVP=$([ "$ARCH" = x86_64 ] && echo "opencv-python-headless<4.11" || echo "opencv-python-headless")
  "$UV" pip install -q --python "$PY" onnxruntime "$CVP" >/dev/null 2>&1 \
    || "$UV" pip install -q --python "$PY" --index-url https://pypi.tuna.tsinghua.edu.cn/simple onnxruntime "$CVP" >/dev/null 2>&1 \
    || fail "hd packages"
  touch "$HOME_DIR/venv/.ok2"; DONE=$((DONE + SZ_EXTRA)); progress
fi
# 10-20 real-time DUIX (duix/duix_mobile.py): ncnn runs her mouth model on the CPU. --no-deps: ncnn's wheel would pull a
# second, GUI OpenCV next to the headless one (both own cv2/). Pinned to a build tested here.
if [ ! -e "$HOME_DIR/venv/.ok4" ]; then
  say "S install"
  "$UV" pip install -q --python "$PY" --no-deps "ncnn==1.0.20260526" >/dev/null 2>&1 \
    || "$UV" pip install -q --python "$PY" --no-deps --index-url https://pypi.tuna.tsinghua.edu.cn/simple "ncnn==1.0.20260526" >/dev/null 2>&1 \
    || fail "duix runtime"
  "$PY" -c "import ncnn" 2>/dev/null || fail "duix runtime check"
  touch "$HOME_DIR/venv/.ok4"
fi

# ── 8. her voice: qwentts.cpp tts-server (static universal, CPU-only) + Qwen3-TTS 0.6B Base + 12 Hz codec ──
# v2 = CPU-only build: v1 carried Metal, whose library compile made the first start take ~50–90 s on Intel Macs
# (the engine gave up at 60 s and her voice fell back, user 10-19). An install without the .v2 marker is upgraded.
mkdir -p "$HOME_DIR/qwentts/build" "$HOME_DIR/qwentts/models"
if [ ! -e "$HOME_DIR/qwentts/build/.v2" ]; then
  say "S download"
  T="$HOME_DIR/tmp/tts-server.tgz"
  fetch_v "$QBIN_SHA" "$ASSETS/tts-server-macos-universal-2.tgz" "https://ghfast.top/$ASSETS/tts-server-macos-universal-2.tgz" -- "$T" $SZ_QBIN || fail "voice server"
  tar xzf "$T" -C "$HOME_DIR/qwentts/build" && chmod +x "$HOME_DIR/qwentts/build/tts-server" || fail "voice server unpack"
  xattr -dr com.apple.quarantine "$HOME_DIR/qwentts" 2>/dev/null
  rm -f "$T"; touch "$HOME_DIR/qwentts/build/.v2"
fi
QM="$HOME_DIR/qwentts/models"
for spec in "qwen-talker-0.6b-base-Q4_K_M.gguf:$QTALK_SHA:$SZ_QTALK" "qwen-tokenizer-12hz-Q8_0.gguf:$QCODEC_SHA:$SZ_QCODEC"; do
  F="${spec%%:*}"; rest="${spec#*:}"; SHA="${rest%%:*}"; SZ="${rest#*:}"
  [ -e "$QM/$F" ] && continue
  say "S download"
  fetch_v "$SHA" "https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF/resolve/main/$F" \
                 "https://hf-mirror.com/Serveurperso/Qwen3-TTS-GGUF/resolve/main/$F" -- "$QM/$F" "$SZ" || fail "voice model"
done

# ── 8b. her real-time voice: MeloTTS (sherpa-onnx, Mandarin + English, MIT) + pyworld for sweet.py ──
if [ ! -e "$HOME_DIR/venv/.ok3" ]; then
  say "S install"
  "$UV" pip install -q --python "$PY" pyworld "setuptools<81" >/dev/null 2>&1 \
    || "$UV" pip install -q --python "$PY" --index-url https://pypi.tuna.tsinghua.edu.cn/simple pyworld "setuptools<81" >/dev/null 2>&1 \
    || fail "voice packages"
  touch "$HOME_DIR/venv/.ok3"; DONE=$((DONE + SZ_EXTRA3)); progress
fi
if [ ! -e "$HOME_DIR/models/vits-melo-tts-zh_en/model.onnx" ]; then
  say "S download"
  M="$HOME_DIR/tmp/melo.tar.bz2"; MU="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2"
  fetch_v "$MELO_SHA" "$MU" "https://ghfast.top/$MU" -- "$M" $SZ_MELO || fail "voice model"
  say "S install"
  tar xjf "$M" -C "$HOME_DIR/models" && rm -f "$M" || fail "voice model unpack"
fi
# barge-in (打断): Silero VAD v4, the official v4.0 release (MIT) — the model beiyege-01/dsh-voice-ai-girlfriend interrupts with
if [ ! -e "$HOME_DIR/models/silero-vad/silero_vad_v4.onnx" ]; then
  mkdir -p "$HOME_DIR/models/silero-vad"
  VU="https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx"
  fetch_v a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28 "$VU" "https://ghfast.top/$VU" -- "$HOME_DIR/models/silero-vad/silero_vad_v4.onnx" 1807522 || fail "barge-in model"
fi
# voice input (engine /stt): Paraformer-large, the repo's speech recogniser — one pass per utterance the page cuts itself
if [ ! -e "$HOME_DIR/models/asr/paraformer/$PARAFORMER_NAME/model.int8.onnx" ]; then
  say "S download"
  P="$HOME_DIR/tmp/paraformer.tar.bz2"; PU="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$PARAFORMER_NAME.tar.bz2"
  fetch_v "$PARAFORMER_SHA" "$PU" "https://ghfast.top/$PU" -- "$P" $SZ_PARAFORMER || fail "voice input model"
  say "S install"
  mkdir -p "$HOME_DIR/models/asr/paraformer" \
    && tar xjf "$P" -C "$HOME_DIR/models/asr/paraformer" "$PARAFORMER_NAME/model.int8.onnx" "$PARAFORMER_NAME/tokens.txt" "$PARAFORMER_NAME/README.md" \
    && rm -f "$P" || fail "voice input model unpack"
fi
# her voice (Breeze2-VITS 台湾腔): three files, each checked; MeloTTS above stays (its jieba dictionary + number / date
# normalisers serve Breeze2 too, and it is the fallback voice)
if [ ! -e "$HOME_DIR/models/breeze2-vits/.ok" ]; then
  say "S download"
  mkdir -p "$HOME_DIR/models/breeze2-vits"
  while IFS=: read -r f h; do
    BU="https://huggingface.co/MediaTek-Research/Breeze2-VITS-onnx/resolve/main/$f"
    fetch_v "$h" "$BU" "https://hf-mirror.com/MediaTek-Research/Breeze2-VITS-onnx/resolve/main/$f" -- "$HOME_DIR/models/breeze2-vits/$f" \
      $([ "$f" = breeze2-vits.onnx ] && echo 121082293 || echo 2600000) || fail "voice model"
  done <<< "$BREEZE2_FILES"
  touch "$HOME_DIR/models/breeze2-vits/.ok"; DONE=$((DONE + SZ_BREEZE2)); progress
fi

# ── 9. HD replies: DUIX face2face models (DUIX.COM Community License — see duix/LICENSE-DUIX.COM.txt) ──
# already on this Mac (every file intact)? then only mark it; no download
DUIX_FILES="wenet_bnf.onnx:e95a0a0322cbf595f87c22390336d285f6b5b730035afe46a353647a8bbef2a6
scrfd_500m_bnkps_shape640x640.onnx:b467f878e26ff1e7ee05cd9936fdff63fa2a5af5d732ed17ee231f2dd5cc07ae
pfpld_robust_sim_bs1_8003.onnx:8bd9913817152831562cccde7e51ed431d1cf4547d8f21e0876b58a0d82baa55
dinet_v1_meta.npz:9f8670243d4915ba6371ad2a6fcad9440befdb414aa244041071b222d516fb6a
mel_16k_1024_80.npy:50f72dcd637c02334f1f41110b5ec017091c2213763fcc00cbbaf7a02f1d136e
dinet_v1_fp16.mlpackage/Manifest.json:32bdc98629d8df3cae791fd1d09fa98e386a1db4788fb53934360859d3ed922a
dinet_v1_fp16.mlpackage/Data/com.apple.CoreML/model.mlmodel:6caa69efe0d629011e78fcdf092df52c79f35d85b7b659a7e9033620b939c18d
dinet_v1_fp16.mlpackage/Data/com.apple.CoreML/weights/weight.bin:efd83156857e596fa9227e77112d3170aab03dd1104e629c1789fad325a62120"
if [ ! -e "$HOME_DIR/models/duix/.ok" ]; then
  have=1
  while IFS=: read -r f h; do sha_ok "$HOME_DIR/models/duix/$f" "$h" || { have=0; break; }; done <<< "$DUIX_FILES"
  [ $have = 1 ] && { touch "$HOME_DIR/models/duix/.ok"; DONE=$((DONE + SZ_DUIX)); progress; }
fi
if [ ! -e "$HOME_DIR/models/duix/.ok" ]; then
  say "S download"
  D="$HOME_DIR/tmp/duix-models.tar"
  fetch_v "$DUIX_SHA" "$ASSETS/duix-models-1.tar" "https://ghfast.top/$ASSETS/duix-models-1.tar" -- "$D" $SZ_DUIX || fail "hd model"
  say "S install"
  mkdir -p "$HOME_DIR/models/duix" && tar xf "$D" -C "$HOME_DIR/models/duix" || fail "hd model unpack"
  while IFS=: read -r f h; do sha_ok "$HOME_DIR/models/duix/$f" "$h" || { rm -f "$D"; fail "hd model check"; }; done <<< "$DUIX_FILES"
  cp "$HERE/duix/LICENSE-DUIX.COM.txt" "$HOME_DIR/models/duix/" 2>/dev/null
  touch "$HOME_DIR/models/duix/.ok"; rm -f "$D"
fi

# ── 9b. fast DUIX: the model above split in two — the per-base-frame half (reference encoder + alignment) computed once
#        per frame of her clips and kept on disk, and the per-spoken-frame half with its decoder cropped to the lower-face
#        band the blend uses (same pixels there) — about 2× faster on the Radeon. Optional: without it the whole model
#        is used, so a missing / unreachable asset never blocks setup.
FAST_FILES="duix_p_fp16.mlpackage/Manifest.json:a3d710cc693fc5f05ee961ed3acec29485e36f19d4d0782bba7b6f024ddd39f9
duix_d_fp16.mlpackage/Manifest.json:1ca7b2f4c58b9e267587ac2da58263e286fb1dcc3b5d697b79ca4911a786d2e7
duix_p_fp16.mlpackage/Data/com.apple.CoreML/model.mlmodel:2bbc44dbb0f9251e30e1ec6609af4552638e4b64a3020ac8d082210a6b9b5ec0
duix_d_fp16.mlpackage/Data/com.apple.CoreML/model.mlmodel:cc52dbee73dd95d11c9b0c5daa888f6f2b1b6aa0e4a46dd09c86ccfd0e719d62
duix_p_fp16.mlpackage/Data/com.apple.CoreML/weights/weight.bin:be1139fc7fc621428741179ffd37dc2e2d10aa5423f83b21400b707a67abdb57
duix_d_fp16.mlpackage/Data/com.apple.CoreML/weights/weight.bin:820ac45283023c728e7c381360033e71f6dad356e327a4bb19bf0393606b78bc"
fast_ok() { while IFS=: read -r f h; do sha_ok "$HOME_DIR/models/duix/$f" "$h" || return 1; done <<< "$FAST_FILES"; }
if [ -e "$HOME_DIR/models/duix/.ok" ] && [ ! -e "$HOME_DIR/models/duix/.fast1" ]; then
  if fast_ok; then touch "$HOME_DIR/models/duix/.fast1"; DONE=$((DONE + SZ_FAST)); progress
  elif curl -sfIL -m 20 -o /dev/null "$ASSETS/duix-fast-1.tar" || curl -sfIL -m 20 -o /dev/null "https://ghfast.top/$ASSETS/duix-fast-1.tar"; then
    say "S download"
    D="$HOME_DIR/tmp/duix-fast.tar"
    if fetch_v "$FAST_SHA" "$ASSETS/duix-fast-1.tar" "https://ghfast.top/$ASSETS/duix-fast-1.tar" -- "$D" $SZ_FAST; then
      say "S install"
      ( cd "$HOME_DIR/models/duix" && rm -rf duix_p_fp16.mlpackage duix_d_fp16.mlpackage duix_p_fp16.mlmodelc duix_d_fp16.mlmodelc \
        && tar xf "$D" ) && fast_ok && touch "$HOME_DIR/models/duix/.fast1"
      rm -f "$D"
    fi
    [ -e "$HOME_DIR/models/duix/.fast1" ] || echo "fast DUIX not installed (the whole model is used)" >&2
  fi
fi

# ── 9c. real-time DUIX (10-20, user: "DUIX 必须要有,对口型实时,不消耗太多 RAM,电脑不卡"): Mia's own mouth model,
#        duix.com-mia-mouth (Duix-Mobile's interface, ~5 MB, trained by distillation from the DUIX model above), run on
#        the CPU by duix/duix_mobile.py — no GPU, a few hundred MB of RAM. Optional like 9b: without it the engine uses
#        the big DUIX model. Powered by Duix.com (DUIX.COM Community License).
MOB_SHA=e244c8b5546791ab826f16dc85ca0ada6bf0ad75e4ba6e40e95e5baac87e6cd8; SZ_MOB=5066240
MOB_FILES="duix.com-mia-mouth.ncnn.param:7f7b10e65a84cf7cf69da324f960dc32450724868c0b36a3ae1c3233c5f9aad5
duix.com-mia-mouth.ncnn.bin:4d6520425da9943e56f2feed25f6441e136f44863311164c9b3889a704d152cc
duix.com-mia-mouth.json:ec1179bac40cb15e6b056ceff711702b9c2a40736f8c4b5982ad413c35920ac8
duix.com-mia-mouth.alpha.npy:4f235cbb27ae55319f75b7f1c9e0b81d7adc7e60bc0ee978205d6b42bf3710cd"
mob_ok() { while IFS=: read -r f h; do [ -n "$f" ] || continue; sha_ok "$HOME_DIR/models/duix/mobile/$f" "$h" || return 1; done <<< "$MOB_FILES"; }
if [ -e "$HOME_DIR/models/duix/.ok" ] && [ ! -e "$HOME_DIR/models/duix/mobile/.ok1" ]; then
  if mob_ok; then touch "$HOME_DIR/models/duix/mobile/.ok1"
  elif curl -sfIL -m 20 -o /dev/null "$ASSETS/duix-mobile-mia-1.tar" || curl -sfIL -m 20 -o /dev/null "https://ghfast.top/$ASSETS/duix-mobile-mia-1.tar"; then
    say "S download"
    D="$HOME_DIR/tmp/duix-mobile.tar"
    if fetch_v "$MOB_SHA" "$ASSETS/duix-mobile-mia-1.tar" "https://ghfast.top/$ASSETS/duix-mobile-mia-1.tar" -- "$D" $SZ_MOB; then
      say "S install"
      mkdir -p "$HOME_DIR/models/duix/mobile" && tar xf "$D" -C "$HOME_DIR/models/duix/mobile" && mob_ok \
        && cp "$HERE/duix/LICENSE-DUIX.COM.txt" "$HOME_DIR/models/duix/mobile/" 2>/dev/null; mob_ok && touch "$HOME_DIR/models/duix/mobile/.ok1"
      rm -f "$D"
    fi
    [ -e "$HOME_DIR/models/duix/mobile/.ok1" ] || echo "real-time DUIX model not installed (the big DUIX model is used)" >&2
  fi
fi

# ── 10. optimize: her clips' face crops, so the first live start is ~1 min instead of ~8 (engine.py --prepare);
#        v2 (10-20) also face-tracks every clip for DUIX and fills the fast-DUIX cache of her mood clips ──
#        v4 (10-22): the clips she plays now — the calm idle and the 数字人 base — from her downloaded pack (step 0)
CHAR="$MIA_DIR"
if [ -f "$CHAR/idle_calm.mp4" ] && [ ! -e "$HOME_DIR/cache/w2l/.prepared-mia-v4" ]; then
  say "S optimize"
  mkdir -p "$HOME_DIR/cache/w2l"
  GF_HOME="$HOME_DIR" GF_VIDEO_BIN="$HERE/terse-gf-video" GF_DUIX_BIN="$HERE/terse-gf-duix" GF_DUIX_MODELS="$HOME_DIR/models/duix" "$PY" "$HERE/engine.py" --prepare \
    "$CHAR/idle_calm.mp4" "$CHAR/my_avatar.mp4" >"$HOME_DIR/tmp/prepare.log" 2>&1 \
    && touch "$HOME_DIR/cache/w2l/.prepared-mia-v4"     # not fatal: the engine builds the same caches on first start
fi

# ── 11. verify ──
say "S verify"
"$PY" -c "import numpy, PIL, fastapi, uvicorn, websockets, sherpa_onnx" 2>/dev/null || { rm -f "$HOME_DIR/venv/.ok"; fail "runtime check"; }
"$PY" -c "import cv2, onnxruntime" 2>/dev/null || { rm -f "$HOME_DIR/venv/.ok2"; fail "hd runtime check"; }
"$PY" -c "import pyworld" 2>/dev/null || { rm -f "$HOME_DIR/venv/.ok3"; fail "voice runtime check"; }
"$HOME_DIR/bin/llama/llama-server" --version >/dev/null 2>&1 || fail "brain server check"
"$HOME_DIR/qwentts/build/tts-server" --help >/dev/null 2>&1; [ $? -le 1 ] || { rm -f "$HOME_DIR/qwentts/build/tts-server"; fail "voice server check"; }
for f in models/w2l256_enc_fp16.mlpackage models/w2l256_dec_fp16.mlpackage models/brain.gguf \
         models/.brain-hunyuan-1.8b models/vits-melo-tts-zh_en/model.onnx models/breeze2-vits/breeze2-vits.onnx \
         qwentts/models/qwen-talker-0.6b-base-Q4_K_M.gguf qwentts/models/qwen-tokenizer-12hz-Q8_0.gguf \
         models/duix/dinet_v1_fp16.mlpackage models/duix/wenet_bnf.onnx models/duix/scrfd_500m_bnkps_shape640x640.onnx \
         models/duix/pfpld_robust_sim_bs1_8003.onnx models/duix/dinet_v1_meta.npz models/duix/mel_16k_1024_80.npy; do
  [ -e "$HOME_DIR/$f" ] || { rm -f "$HOME_DIR/models/duix/.ok"; fail "missing after setup"; }
done
[ -e "$HOME_DIR/tmp/mia.unpublished" ] && fail "her clips not on the server yet"        # the precise reason, not "missing"
for f in idle_calm.mp4 my_avatar.mp4 manifest.json; do [ -f "$MIA_DIR/$f" ] || { rm -f "$MIA_DIR/.pack1"; fail "her clips missing"; }; done
printf '{"version":3,"arch":"%s","at":"%s"}\n' "$ARCH" "$(date -u +%FT%TZ)" > "$HOME_DIR/ready.json"
rm -rf "$HOME_DIR/tmp" "$HOME_DIR/setup.wanted"                # finished: nothing to resume at the next launch
say "P $TOTAL $TOTAL"
say "OK"
