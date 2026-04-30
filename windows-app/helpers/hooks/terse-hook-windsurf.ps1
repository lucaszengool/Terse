# terse-hook-windsurf.ps1 — Windsurf shell execution hook (Windows)
$ErrorActionPreference = "SilentlyContinue"

$inputText = [Console]::In.ReadToEnd()
$event = $inputText | ConvertFrom-Json
if (-not $event) { exit 0 }

$toolName = $event.tool_name
if ($toolName -ne "shell" -and $toolName -ne "Bash" -and $toolName -ne "terminal") { exit 0 }

$command = if ($event.tool_input.command) { $event.tool_input.command } elseif ($event.input.command) { $event.input.command } else { "" }
if (-not $command) { exit 0 }

$skipPatterns = @("terse-compress","terse-rewrite","terse-hook","<<EOF","cd ","echo ","export ","mkdir ","mv ","cp ","rm ","touch ","which ","pwd","ssh ","vim ","nano ")
foreach ($p in $skipPatterns) { if ($command -like "*$p*") { exit 0 } }

$compressPatterns = @("git status","git diff","git log","git show","git branch","ls ","find ","tree","dir ","npm test","npx ","jest","vitest","pytest","cargo test","go test","npm run","pnpm ","yarn ","eslint","tsc ","docker ps","kubectl ","cargo build","make","pip list","cat ","curl ","grep ","rg ","findstr ","tasklist")
$shouldCompress = $false
foreach ($p in $compressPatterns) {
    if ($command.StartsWith($p) -or $command -like "* | $p*") { $shouldCompress = $true; break }
}
if (-not $shouldCompress -and $command -like "* | *" -and $command.Length -gt 50) { $shouldCompress = $true }
if (-not $shouldCompress) { exit 0 }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tc = @("$scriptDir\..\terse-compress.js","$scriptDir\terse-compress.js","$env:USERPROFILE\.terse\terse-compress.js") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $tc) { exit 0 }

$wrapped = "($command) 2>&1 | node `"$tc`""
$output = @{ hookSpecificOutput = @{ hookEventName = "pre_tool_use"; permissionDecision = "allow"; updatedInput = @{ command = $wrapped }; additionalContext = "" } } | ConvertTo-Json -Depth 4 -Compress
Write-Output $output
exit 0
