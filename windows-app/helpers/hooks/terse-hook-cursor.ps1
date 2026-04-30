# terse-hook-cursor.ps1 — Cursor beforeShellExecution hook adapter (Windows)
$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()
$event = $inputText | ConvertFrom-Json
if (-not $event) { Write-Output '{"decision":"allow"}'; exit 0 }

$toolName = if ($event.tool_name) { $event.tool_name } elseif ($event.type) { $event.type } else { "" }
if ($toolName -ne "shell" -and $toolName -ne "terminal" -and $toolName -ne "Bash" -and $toolName -ne "") {
    Write-Output '{"decision":"allow"}'; exit 0
}

$command = if ($event.tool_input.command) { $event.tool_input.command }
           elseif ($event.input.command) { $event.input.command }
           elseif ($event.command) { $event.command }
           else { "" }
if (-not $command) { Write-Output '{"decision":"allow"}'; exit 0 }

# Skip patterns
$skipPatterns = @("terse-compress","terse-rewrite","terse-hook","<<EOF","<<'","cd ","echo ","export ","mkdir ","chmod ","mv ","cp ","rm ","touch ","which ","pwd","kill ","ssh ","vim ","nano ","start ")
foreach ($p in $skipPatterns) { if ($command -like "*$p*") { Write-Output '{"decision":"allow"}'; exit 0 } }

# Compress patterns
$compressPatterns = @("git status","git diff","git log","git show","git branch","git stash","git push","git pull","git fetch","git remote","git blame","ls ","find ","tree","du ","df ","dir ","npm test","npx ","jest","vitest","pytest","cargo test","go test","npm run","pnpm ","yarn ","bun ","eslint","tsc ","biome","prettier","ruff","clippy","docker ps","docker images","docker logs","kubectl ","cargo build","cargo clippy","cargo check","go build","make","pip list","pip show","pip install","cat ","head ","tail ","wc ","curl ","wget ","grep ","rg ","findstr ","tasklist")
$shouldCompress = $false
foreach ($p in $compressPatterns) {
    if ($command.StartsWith($p) -or $command -like "* | $p*" -or $command -like "* && $p*") { $shouldCompress = $true; break }
}
if (-not $shouldCompress -and $command -like "* | *" -and $command.Length -gt 50) { $shouldCompress = $true }
if (-not $shouldCompress) { Write-Output '{"decision":"allow"}'; exit 0 }

# Find terse-compress
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tc = @("$scriptDir\..\terse-compress.js","$scriptDir\terse-compress.js","$env:USERPROFILE\.terse\terse-compress.js") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $tc) { Write-Output '{"decision":"allow"}'; exit 0 }

$wrapped = "($command) 2>&1 | node `"$tc`""
$output = @{ decision = "allow"; updatedInput = @{ command = $wrapped } } | ConvertTo-Json -Depth 3 -Compress
Write-Output $output
exit 0
