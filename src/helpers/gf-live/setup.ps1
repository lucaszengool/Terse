# AI 女友 one-click setup — Windows. The macOS twin is setup.sh; this installs the same pipeline the Mac uses by default,
# with Windows builds where the Mac has macOS-only ones:
#
#   bin\uv.exe, venv\ (Python 3.11 + light runtime deps), bin\llama\ (llama.cpp server, CPU build — the brain stays off
#   the GPU, which her face uses), bin\ffmpeg\ (her talking video is encoded by ffmpeg), models\ (brain, voices, speech
#   recognition, DUIX), presets\char_mia\ (her clips).
#
#   Not on Windows: the wav2lip Core ML pair and the qwentts.cpp voice server (both macOS builds). DUIX — her face — runs
#   on ONNX Runtime (DirectML on any DirectX 12 GPU, else the CPU) from duix-win-1.tar instead of Core ML; the engine
#   then runs DUIX-only, as a Mac with DUIX installed does.
#
# Output (read by Terse, girlfriend.rs): "P <done> <total>" progress in bytes, "S <phase>", "OK", "ERR <reason>".
# Every download resumes, has mirrors, and is checked against a pinned SHA-256. Run again any time: finished steps are
# skipped by their marker files.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1        (GF_HOME, GF_ONLY=mia, GF_ASSETS as in setup.sh)

# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native program's stderr redirected with 2>&1 becomes error records,
# and under 'Stop' the first progress line uv prints would abort the install. Every step checks $LASTEXITCODE / its files.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
# Python reads and writes UTF-8 here whatever the Windows locale: her manifest, the lexicons and the engine's log lines are
# Chinese, and cp1252 (an English Windows) cannot hold them.
$env:PYTHONUTF8 = '1'
# Windows PowerShell's own module path. Started from PowerShell 7 (or with an edited environment) this 5.1 process
# inherits a PSModulePath whose first entries are 7's modules, which 5.1 cannot load — and then even built-in cmdlets
# are "not recognized" (CI: Get-FileHash, every download rejected as a bad checksum).
$env:PSModulePath = (@("$env:USERPROFILE\Documents\WindowsPowerShell\Modules", "$env:ProgramFiles\WindowsPowerShell\Modules",
                       "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules") -join ';')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$HOME_DIR = if ($env:GF_HOME) { $env:GF_HOME } else { Join-Path $env:USERPROFILE '.terse\gf-live' }
$ASSETS = if ($env:GF_ASSETS) { $env:GF_ASSETS } else { 'https://github.com/lucaszengool/Terse/releases/download/gf-live-assets-1' }
$CURL = Join-Path $env:SystemRoot 'System32\curl.exe'
$MIA_DIR = Join-Path $HOME_DIR 'presets\char_mia'

function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Fail([string]$s) { Say "ERR $s"; exit 1 }
function P([string]$rel) { Join-Path $HOME_DIR $rel }

New-Item -ItemType Directory -Force -Path (P 'bin'), (P 'models'), (P 'tmp'), (P 'presets') | Out-Null

# one setup at a time (a second one would write the same .part files)
$lock = P 'tmp\setup.lock'
try { $lockStream = [IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None') } catch { Fail 'setup already running' }

# ── this PC: written to hw.json, read by the engine to pick which DUIX draws her mouth ──
$major = [Environment]::OSVersion.Version.Major; $build = [Environment]::OSVersion.Version.Build
if ($major -lt 10 -or $build -lt 17763) { Fail "Windows 10 1809 or later is needed (this PC: $major.$build)" }
if (-not [Environment]::Is64BitOperatingSystem) { Fail '64-bit Windows is needed' }
$gpus = @()
try { $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) } catch {}
$gpuStr = ($gpus -join '|') -replace '["\\]', ''
# a discrete GPU runs full DUIX; integrated graphics only get the small real-time DUIX
$gpuClass = if ($gpuStr -match '(?i)nvidia|geforce|rtx|quadro|radeon rx|radeon pro|arc a') { 'dgpu' } else { 'igpu' }
$ramGb = 8; $cores = 4
try { $ramGb = [int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch {}
try { $cores = [int]((Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum) } catch {}
$hw = '{{"arch":"x86_64","os":"windows","windows":"{0}","ram_gb":{1},"perf_cores":{2},"gpu":"{3}","gpu_class":"{4}"}}' -f "$major.$build", $ramGb, $cores, $gpuStr, $gpuClass
[IO.File]::WriteAllText((P 'hw.json'), $hw)

# ── pinned downloads ──
$UV_URL = 'https://github.com/astral-sh/uv/releases/download/0.13.5/uv-x86_64-pc-windows-msvc.zip'
$UV_SHA = 'a38b8d1902b7cfbc76b423ba1bb456f623f42064cdc72628b6075b89afd1019a'; $SZ_UV = 15264056
$LLAMA_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b11706/llama-b11706-bin-win-cpu-x64.zip'   # same build as the Mac
$LLAMA_SHA = 'f426ae6d20afeb6970f51cc182dedc3b21cf23ec278192da1af262de43be6115'; $SZ_LLAMA = 19611156
$FF_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/2026-10-22-git-bf0e831606/ffmpeg-2026-10-22-git-bf0e831606-essentials_build.zip'
$FF_SHA = '07de5469e123c02e06959cbf7cc9e405c29f0530abde67f0721fe57dfe5e1fb4'; $SZ_FF = 115937199
$BRAIN_FILE = 'tencent_Hunyuan-1.8B-Instruct-Q4_K_M.gguf'
$BRAIN_SHA = '558ae86fc4251fd73cd54685319a83e7550997537e3ad41043ad5c0b5a2a26d4'; $SZ_BRAIN = 1133084864
$MELO_SHA = 'e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514'; $SZ_MELO = 167006755
$SILERO_SHA = 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28'; $SZ_SILERO = 1807522
$PARA_NAME = 'sherpa-onnx-paraformer-zh-2023-09-14'
$PARA_SHA = '9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03'; $SZ_PARA = 234051698
$BREEZE = @(@('breeze2-vits.onnx', '13c5d190f911e8ab78db460749b5216663ea0b9497d4d4a2f35800b86fa4d6cf'),
            @('lexicon.txt', 'fee63cb838fd0fb295292df8e42fcf5470204b4ced1f4fea8a9a01ef6cc1255e'),
            @('tokens.txt', '34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402')); $SZ_BREEZE = 123600935
$MIA_SHA = '065eea4ed2909e7b3e4e0d7b87193ccc432b6cb5267ae6d7382302532549b92e'; $SZ_MIA = 44037120
$MIA4K_SHA = 'e1de2f7b1004854774f55602ee13f9e7e229a9938fde29bebd617ad46394f88b'; $SZ_MIA4K = 23199232
$DUIX_SHA = '2a72dd704dbee9d1980768e795ef3edf5f8d07d5924075d58ee1f5c57c403b86'; $SZ_DUIX = 604664320
$DUIX_FILES = @(@('duix_p.onnx', 'ca646af33beec9ee26570a9890a58903cd9391830184f0c638b6e2edd01f5fd9'),
                @('duix_d.onnx', '14131fe0fd0d625bc608936d88c5da41cfa8606933a5386113f1af199ab80e67'),
                @('wenet_bnf.onnx', 'e95a0a0322cbf595f87c22390336d285f6b5b730035afe46a353647a8bbef2a6'),
                @('scrfd_500m_bnkps_shape640x640.onnx', 'b467f878e26ff1e7ee05cd9936fdff63fa2a5af5d732ed17ee231f2dd5cc07ae'),
                @('pfpld_robust_sim_bs1_8003.onnx', '8bd9913817152831562cccde7e51ed431d1cf4547d8f21e0876b58a0d82baa55'),
                @('dinet_v1_meta.npz', '9f8670243d4915ba6371ad2a6fcad9440befdb414aa244041071b222d516fb6a'),
                @('mel_16k_1024_80.npy', '50f72dcd637c02334f1f41110b5ec017091c2213763fcc00cbbaf7a02f1d136e'),
                @('mobile\duix.com-mia-mouth.ncnn.param', '7f7b10e65a84cf7cf69da324f960dc32450724868c0b36a3ae1c3233c5f9aad5'),
                @('mobile\duix.com-mia-mouth.ncnn.bin', '4d6520425da9943e56f2feed25f6441e136f44863311164c9b3889a704d152cc'),
                @('mobile\duix.com-mia-mouth.json', 'ec1179bac40cb15e6b056ceff711702b9c2a40736f8c4b5982ad413c35920ac8'),
                @('mobile\duix.com-mia-mouth.alpha.npy', '4f235cbb27ae55319f75b7f1c9e0b81d7adc7e60bc0ee978205d6b42bf3710cd'))
$SZ_PY = 130000000; $SZ_EXTRA = 80000000

function Mirrors([string]$u) {
    # GitHub through the same mirrors setup.sh uses (users in China); Hugging Face through hf-mirror.com
    if ($u -like 'https://huggingface.co/*') { return @($u, ($u -replace '^https://huggingface.co/', 'https://hf-mirror.com/')) }
    if ($u -like 'https://github.com/*' -or $u -like 'https://raw.githubusercontent.com/*') { return @($u, "https://ghfast.top/$u", "https://gh-proxy.com/$u") }
    return @($u)
}

# ── progress: the bytes still to fetch, weighted as setup.sh weighs them ──
$TOTAL = [int64]0; $DONE = [int64]0
function Need([string]$marker, [int64]$bytes) { if (-not (Test-Path (P $marker))) { $script:TOTAL += $bytes } }
if ($env:GF_ONLY -ne 'mia') {
    Need 'bin\uv.exe' $SZ_UV; Need 'venv\.ok' $SZ_PY; Need 'venv\.ok2' $SZ_EXTRA; Need 'bin\llama\llama-server.exe' $SZ_LLAMA
    Need 'bin\ffmpeg\ffmpeg.exe' $SZ_FF; Need 'models\.brain-hunyuan-1.8b' $SZ_BRAIN; Need 'models\vits-melo-tts-zh_en\model.onnx' $SZ_MELO
    Need 'models\silero-vad\silero_vad_v4.onnx' $SZ_SILERO; Need "models\asr\paraformer\$PARA_NAME\model.int8.onnx" $SZ_PARA
    Need 'models\breeze2-vits\.ok' $SZ_BREEZE; Need 'models\duix\.ok' $SZ_DUIX
}
Need 'presets\char_mia\.pack1' $SZ_MIA
if ((Test-Path (P 'presets\want-4k')) -and -not (Test-Path (P 'presets\char_mia\.4k1'))) { $TOTAL += $SZ_MIA4K }
if ($TOTAL -le 0) { $TOTAL = 1 }
function Progress([int64]$extra = 0) { Say ("P {0} {1}" -f [Math]::Min($script:DONE + $extra, $script:TOTAL), $script:TOTAL) }

function ShaOk([string]$f, [string]$sha) {
    # .NET's SHA-256 directly: no module to load, nothing that can be "not recognized"
    if (-not (Test-Path $f)) { return $false }
    $st = [IO.File]::OpenRead($f)
    try { $h = [Security.Cryptography.SHA256]::Create().ComputeHash($st) } finally { $st.Close() }
    return ((-join ($h | ForEach-Object { $_.ToString('x2') })) -eq $sha)
}

# Fetch-Verified: one of the urls → $dest, resumed from $dest.part, then checked against $sha. Progress while it runs.
function Fetch-Verified([string[]]$urls, [string]$dest, [string]$sha, [int64]$size) {
    if (ShaOk $dest $sha) { $script:DONE += $size; Progress; return $true }
    $part = "$dest.part"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    foreach ($u0 in $urls) {
        foreach ($u in (Mirrors $u0)) {
            if (ShaOk $part $sha) { break }
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = $CURL
            $psi.Arguments = "-sL -C - --connect-timeout 15 --speed-limit 50000 --speed-time 30 --retry 2 -o `"$part`" `"$u`""
            $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
            $p = [Diagnostics.Process]::Start($psi)
            while (-not $p.HasExited) {
                Start-Sleep -Milliseconds 700
                $have = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
                Progress ([Math]::Min($have, $size))
            }
            if (ShaOk $part $sha) { break }
            # a wrong or truncated file must not poison the next mirror's resume
            if ((Test-Path $part) -and (Get-Item $part).Length -ge $size) { Remove-Item -Force $part }
        }
        if (ShaOk $part $sha) { break }
    }
    if (-not (ShaOk $part $sha)) { return $false }
    Move-Item -Force $part $dest
    $script:DONE += $size; Progress
    return $true
}

function Extract-Zip([string]$zip, [string]$to) {
    if (Test-Path $to) { Remove-Item -Recurse -Force $to }
    New-Item -ItemType Directory -Force -Path $to | Out-Null
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $zip -C $to
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Force -Path $zip -DestinationPath $to }
}

# ── 0. her clips (same packs as the Mac) ──
function Mia-Step {
    if (-not (Test-Path (Join-Path $MIA_DIR '.pack1'))) {
        Say 'S download'
        $t = P 'tmp\mia-pack-1.tar'
        if (-not (Fetch-Verified @("$ASSETS/mia-pack-1.tar") $t $MIA_SHA $SZ_MIA)) { throw 'her clips' }
        Say 'S install'
        $new = "$MIA_DIR.new"
        if (Test-Path $new) { Remove-Item -Recurse -Force $new }
        New-Item -ItemType Directory -Force -Path $new | Out-Null
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $t -C $new
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $new 'idle_calm.mp4')) -or -not (Test-Path (Join-Path $new 'manifest.json'))) { throw 'her clips check' }
        if (Test-Path (Join-Path $MIA_DIR '4k')) {
            Move-Item (Join-Path $MIA_DIR '4k') (Join-Path $new '4k')
            if (Test-Path (Join-Path $MIA_DIR '.4k1')) { New-Item -ItemType File -Force -Path (Join-Path $new '.4k1') | Out-Null }
        }
        if (Test-Path $MIA_DIR) { Remove-Item -Recurse -Force $MIA_DIR }
        Move-Item $new $MIA_DIR
        New-Item -ItemType File -Force -Path (Join-Path $MIA_DIR '.pack1') | Out-Null
        Remove-Item -Force $t -ErrorAction SilentlyContinue
        Say 'S clips'; Progress
    }
    if ((Test-Path (P 'presets\want-4k')) -and -not (Test-Path (Join-Path $MIA_DIR '.4k1'))) {
        Say 'S download'
        $t4 = P 'tmp\mia-4k-1.tar'
        if (-not (Fetch-Verified @("$ASSETS/mia-4k-1.tar") $t4 $MIA4K_SHA $SZ_MIA4K)) { throw 'her 4K clips' }
        Say 'S install'
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $t4 -C $MIA_DIR
        if ($LASTEXITCODE -ne 0) { throw 'her 4K clips unpack' }
        New-Item -ItemType File -Force -Path (Join-Path $MIA_DIR '.4k1') | Out-Null
        Remove-Item -Force $t4 -ErrorAction SilentlyContinue
    }
}
if ($env:GF_ONLY -eq 'mia') {
    try { Mia-Step } catch { Fail $_.Exception.Message }
    Say "P $TOTAL $TOTAL"; Say 'OK'; exit 0
}
# in the full setup a failure here must not stop the models: step 11 names it and Terse's retry fetches just the clips
try { Mia-Step } catch { Say 'S download' }

# ── 1. uv (Python manager — users need no Python of their own) ──
$UV = P 'bin\uv.exe'
if (-not (Test-Path $UV)) {
    Say 'S download'
    $z = P 'tmp\uv.zip'
    if (-not (Fetch-Verified @($UV_URL) $z $UV_SHA $SZ_UV)) { Fail 'uv' }
    Extract-Zip $z (P 'tmp\uv')
    $exe = Get-ChildItem -Recurse -Filter uv.exe (P 'tmp\uv') | Select-Object -First 1
    if (-not $exe) { Fail 'uv unpack' }
    Move-Item -Force $exe.FullName $UV
    Remove-Item -Recurse -Force (P 'tmp\uv'), $z -ErrorAction SilentlyContinue
}
$PY = P 'venv\Scripts\python.exe'
# Python and uv's cache live with everything else, as on the Mac
$env:UV_PYTHON_INSTALL_DIR = (P 'python'); $env:UV_CACHE_DIR = (P 'tmp\uv-cache')
function UvPip([string[]]$pkgs) {
    & $UV pip install -q --python $PY @pkgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { & $UV pip install -q --python $PY --index-url https://pypi.tuna.tsinghua.edu.cn/simple @pkgs 2>&1 | Out-Null }
    return ($LASTEXITCODE -eq 0)
}

# ── 2. runtime venv (no torch) — the versions the Mac runs ──
if (-not (Test-Path (P 'venv\.ok'))) {
    Say 'S install'
    & $UV venv --python 3.11 (P 'venv') -q 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $env:UV_PYTHON_INSTALL_MIRROR = 'https://ghfast.top/https://github.com/astral-sh/python-build-standalone/releases/download'
        & $UV venv --python 3.11 (P 'venv') -q 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'python' }
    }
    if (-not (UvPip @('numpy==1.26.4', 'pillow', 'fastapi', 'uvicorn[standard]', 'websockets', 'sherpa-onnx==1.13.8'))) { Fail 'python packages' }
    New-Item -ItemType File -Force -Path (P 'venv\.ok') | Out-Null; $DONE += $SZ_PY; Progress
}
# ── 7. DUIX runtime: ONNX Runtime with DirectML (the GPU path on Windows; also runs on the CPU) + OpenCV ──
if (-not (Test-Path (P 'venv\.ok2'))) {
    Say 'S install'
    if (-not (UvPip @('onnxruntime-directml', 'opencv-python-headless<4.11'))) { Fail 'hd runtime' }
    New-Item -ItemType File -Force -Path (P 'venv\.ok2') | Out-Null; $DONE += $SZ_EXTRA; Progress
}
# small real-time DUIX (ncnn) — optional: without it the big DUIX model draws every mouth
if (-not (Test-Path (P 'venv\.ok4'))) {
    & $UV pip install -q --python $PY --no-deps 'ncnn==1.0.20260526' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { New-Item -ItemType File -Force -Path (P 'venv\.ok4') | Out-Null }
}
# sweet.py's optional 'world' voice style — optional too (the default style needs nothing extra)
if (-not (Test-Path (P 'venv\.ok3'))) {
    if (UvPip @('pyworld==0.3.5', 'setuptools<81')) { New-Item -ItemType File -Force -Path (P 'venv\.ok3') | Out-Null }
}

function Py-Untar([string]$archive, [string]$to, [string[]]$members) {
    # .tar.bz2 through Python (Windows' tar.exe is not guaranteed to have bzip2)
    $m = if ($members) { ($members | ForEach-Object { "'" + $_ + "'" }) -join ',' } else { '' }
    $code = "import tarfile,sys; t=tarfile.open(sys.argv[1]); ms=[$m]; t.extractall(sys.argv[2], members=[t.getmember(x) for x in ms] if ms else None)"
    & $PY -c $code $archive $to
    return ($LASTEXITCODE -eq 0)
}

# ── 5. brain server: llama.cpp b11706, the Windows CPU build (picks AVX2 etc. at run time) ──
if (-not (Test-Path (P 'bin\llama\llama-server.exe'))) {
    Say 'S download'
    $z = P 'tmp\llama.zip'
    if (-not (Fetch-Verified @($LLAMA_URL) $z $LLAMA_SHA $SZ_LLAMA)) { Fail 'brain server' }
    Extract-Zip $z (P 'tmp\llama')
    $srv = Get-ChildItem -Recurse -Filter llama-server.exe (P 'tmp\llama') | Select-Object -First 1
    if (-not $srv) { Fail 'brain unpack' }
    if (Test-Path (P 'bin\llama')) { Remove-Item -Recurse -Force (P 'bin\llama') }
    Move-Item $srv.DirectoryName (P 'bin\llama')
    Remove-Item -Recurse -Force (P 'tmp\llama'), $z -ErrorAction SilentlyContinue
}
# ── ffmpeg: her talking video (DUIX frames + voice → H.264) is encoded by it ──
if (-not (Test-Path (P 'bin\ffmpeg\ffmpeg.exe'))) {
    Say 'S download'
    $z = P 'tmp\ffmpeg.zip'
    if (-not (Fetch-Verified @($FF_URL) $z $FF_SHA $SZ_FF)) { Fail 'video encoder' }
    Extract-Zip $z (P 'tmp\ffmpeg')
    $ff = Get-ChildItem -Recurse -Filter ffmpeg.exe (P 'tmp\ffmpeg') | Select-Object -First 1
    $fp = Get-ChildItem -Recurse -Filter ffprobe.exe (P 'tmp\ffmpeg') | Select-Object -First 1
    if (-not $ff -or -not $fp) { Fail 'video encoder unpack' }
    New-Item -ItemType Directory -Force -Path (P 'bin\ffmpeg') | Out-Null
    Move-Item -Force $fp.FullName (P 'bin\ffmpeg\ffprobe.exe')
    Move-Item -Force $ff.FullName (P 'bin\ffmpeg\ffmpeg.exe')
    Remove-Item -Recurse -Force (P 'tmp\ffmpeg'), $z -ErrorAction SilentlyContinue
}
# ── 6. brain model: Hunyuan-1.8B-Instruct Q4_K_M (the Mac's brain) ──
if (-not (Test-Path (P 'models\.brain-hunyuan-1.8b'))) {
    Say 'S download'
    $t = P 'tmp\brain2.gguf'
    if (-not (Fetch-Verified @("https://huggingface.co/bartowski/tencent_Hunyuan-1.8B-Instruct-GGUF/resolve/main/$BRAIN_FILE") $t $BRAIN_SHA $SZ_BRAIN)) { Fail 'brain' }
    Move-Item -Force $t (P 'models\brain.gguf')
    New-Item -ItemType File -Force -Path (P 'models\.brain-hunyuan-1.8b') | Out-Null
}
# ── 8b. MeloTTS (its jieba dictionary + number / date normalisers serve Breeze2 too; fallback voice) ──
if (-not (Test-Path (P 'models\vits-melo-tts-zh_en\model.onnx'))) {
    Say 'S download'
    $t = P 'tmp\melo.tar.bz2'
    if (-not (Fetch-Verified @('https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2') $t $MELO_SHA $SZ_MELO)) { Fail 'voice model' }
    Say 'S install'
    if (-not (Py-Untar $t (P 'models') @())) { Fail 'voice model unpack' }
    Remove-Item -Force $t -ErrorAction SilentlyContinue
}
# barge-in (打断): Silero VAD v4
if (-not (Test-Path (P 'models\silero-vad\silero_vad_v4.onnx'))) {
    if (-not (Fetch-Verified @('https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx') (P 'models\silero-vad\silero_vad_v4.onnx') $SILERO_SHA $SZ_SILERO)) { Fail 'barge-in model' }
}
# voice input (engine /stt): Paraformer-large — only the model, its tokens and its README kept
if (-not (Test-Path (P "models\asr\paraformer\$PARA_NAME\model.int8.onnx"))) {
    Say 'S download'
    $t = P 'tmp\paraformer.tar.bz2'
    if (-not (Fetch-Verified @("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$PARA_NAME.tar.bz2") $t $PARA_SHA $SZ_PARA)) { Fail 'voice input model' }
    Say 'S install'
    New-Item -ItemType Directory -Force -Path (P 'models\asr\paraformer') | Out-Null
    if (-not (Py-Untar $t (P 'models\asr\paraformer') @("$PARA_NAME/model.int8.onnx", "$PARA_NAME/tokens.txt", "$PARA_NAME/README.md"))) { Fail 'voice input model unpack' }
    Remove-Item -Force $t -ErrorAction SilentlyContinue
}
# her voice: Breeze2-VITS (台湾腔), three files, each checked
if (-not (Test-Path (P 'models\breeze2-vits\.ok'))) {
    Say 'S download'
    foreach ($b in $BREEZE) {
        $f = $b[0]
        if (-not (Fetch-Verified @("https://huggingface.co/MediaTek-Research/Breeze2-VITS-onnx/resolve/main/$f") (P "models\breeze2-vits\$f") $b[1] 0)) { Fail 'voice model' }
    }
    New-Item -ItemType File -Force -Path (P 'models\breeze2-vits\.ok') | Out-Null; $DONE += $SZ_BREEZE; Progress
}
# ── 9. her face: DUIX for Windows (DUIX.COM Community License — duix\LICENSE-DUIX.COM.txt) ──
function Duix-Ok { foreach ($d in $DUIX_FILES) { if (-not (ShaOk (P "models\duix\$($d[0])") $d[1])) { return $false } }; return $true }
if (-not (Test-Path (P 'models\duix\.ok'))) {
    if (Duix-Ok) { New-Item -ItemType File -Force -Path (P 'models\duix\.ok') | Out-Null; $DONE += $SZ_DUIX; Progress }
    else {
        Say 'S download'
        $t = P 'tmp\duix-win-1.tar'
        if (-not (Fetch-Verified @("$ASSETS/duix-win-1.tar") $t $DUIX_SHA $SZ_DUIX)) { Fail 'hd model' }
        Say 'S install'
        New-Item -ItemType Directory -Force -Path (P 'models\duix') | Out-Null
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $t -C (P 'models\duix')
        if ($LASTEXITCODE -ne 0) { Fail 'hd model unpack' }
        if (-not (Duix-Ok)) { Remove-Item -Force $t -ErrorAction SilentlyContinue; Fail 'hd model check' }
        Copy-Item -Force (Join-Path $HERE 'duix\LICENSE-DUIX.COM.txt') (P 'models\duix\') -ErrorAction SilentlyContinue
        New-Item -ItemType File -Force -Path (P 'models\duix\.ok') | Out-Null
        if (Test-Path (P 'venv\.ok4')) { New-Item -ItemType File -Force -Path (P 'models\duix\mobile\.ok1') | Out-Null }
        Remove-Item -Force $t -ErrorAction SilentlyContinue
    }
}

# ── 10. optimize: her clips' face tracking + DUIX caches now, so the first start is quick (engine.py --prepare) ──
$calm = Join-Path $MIA_DIR 'idle_calm.mp4'
if ((Test-Path $calm) -and -not (Test-Path (P 'cache\w2l\.prepared-mia-v4'))) {
    Say 'S optimize'
    New-Item -ItemType Directory -Force -Path (P 'cache\w2l') | Out-Null
    $env:GF_HOME = $HOME_DIR; $env:GF_DUIX_MODELS = (P 'models\duix')
    $env:PATH = (P 'bin\ffmpeg') + ';' + $env:PATH
    & $PY (Join-Path $HERE 'engine.py') --prepare $calm (Join-Path $MIA_DIR 'my_avatar.mp4') *> (P 'tmp\prepare.log')
    if ($LASTEXITCODE -eq 0) { New-Item -ItemType File -Force -Path (P 'cache\w2l\.prepared-mia-v4') | Out-Null }   # not fatal
}

# ── 11. verify ──
Say 'S verify'
& $PY -c 'import numpy, PIL, fastapi, uvicorn, websockets, sherpa_onnx' 2>$null
if ($LASTEXITCODE -ne 0) { Remove-Item -Force (P 'venv\.ok') -ErrorAction SilentlyContinue; Fail 'runtime check' }
& $PY -c 'import cv2, onnxruntime' 2>$null
if ($LASTEXITCODE -ne 0) { Remove-Item -Force (P 'venv\.ok2') -ErrorAction SilentlyContinue; Fail 'hd runtime check' }
& (P 'bin\llama\llama-server.exe') --version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'brain server check' }
& (P 'bin\ffmpeg\ffmpeg.exe') -hide_banner -version 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'video encoder check' }
foreach ($f in @('models\brain.gguf', 'models\.brain-hunyuan-1.8b', 'models\vits-melo-tts-zh_en\model.onnx', 'models\breeze2-vits\breeze2-vits.onnx',
                 'models\duix\duix_p.onnx', 'models\duix\duix_d.onnx', 'models\duix\wenet_bnf.onnx', 'models\duix\scrfd_500m_bnkps_shape640x640.onnx',
                 'models\duix\pfpld_robust_sim_bs1_8003.onnx', 'models\duix\dinet_v1_meta.npz', 'models\duix\mel_16k_1024_80.npy')) {
    if (-not (Test-Path (P $f))) { Remove-Item -Force (P 'models\duix\.ok') -ErrorAction SilentlyContinue; Fail 'missing after setup' }
}
foreach ($f in @('idle_calm.mp4', 'my_avatar.mp4', 'manifest.json')) {
    if (-not (Test-Path (Join-Path $MIA_DIR $f))) { Remove-Item -Force (Join-Path $MIA_DIR '.pack1') -ErrorAction SilentlyContinue; Fail 'her clips missing' }
}
[IO.File]::WriteAllText((P 'ready.json'), ('{{"version":3,"arch":"x86_64","os":"windows","at":"{0}"}}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')))
$lockStream.Close()
Remove-Item -Recurse -Force (P 'tmp') -ErrorAction SilentlyContinue
Remove-Item -Force (P 'setup.wanted') -ErrorAction SilentlyContinue
Say "P $TOTAL $TOTAL"
Say 'OK'
