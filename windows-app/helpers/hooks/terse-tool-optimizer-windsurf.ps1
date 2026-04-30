# terse-optimize-tools.ps1 — PreToolUse hook for Read, Grep, Glob (Windows)
# Caps input parameters to prevent excessive token consumption.
$ErrorActionPreference = "SilentlyContinue"

# Exit if Terse is not running
$terseProc = Get-Process -Name "Terse" -ErrorAction SilentlyContinue
if (-not $terseProc) { exit 0 }

$inputText = [Console]::In.ReadToEnd()
$event = $inputText | ConvertFrom-Json
if (-not $event) { exit 0 }

$toolName = $event.tool_name
if (-not $toolName) { exit 0 }

$toolInput = $event.tool_input

# Stats tracking
$statsFile = Join-Path $env:TEMP "terse-tool-optimize-stats.jsonl"
function Track-Save($tool, $original, $optimized) {
    $saved = $original - $optimized
    if ($saved -gt 0) {
        $ts = [int][double]::Parse((Get-Date -UFormat %s))
        $line = "{`"tool`":`"$tool`",`"original`":$original,`"optimized`":$optimized,`"saved`":$saved,`"ts`":$ts}"
        Add-Content -Path $statsFile -Value $line -ErrorAction SilentlyContinue
    }
}

function Emit-Hook($updatedInput, $context) {
    $output = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "allow"
            updatedInput = $updatedInput
            additionalContext = $context
        }
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Output $output
}

# ── READ ──
if ($toolName -eq "Read") {
    $filePath = $toolInput.file_path
    $limit = $toolInput.limit

    if (-not $filePath) { exit 0 }

    # Skip binary/generated files
    $ext = [System.IO.Path]::GetExtension($filePath)
    $binaryExts = @(".lock",".min.js",".min.css",".map",".wasm",".dll",".exe",".obj",".lib")
    if ($binaryExts -contains $ext) {
        $updated = $toolInput | ConvertTo-Json -Depth 3 | ConvertFrom-Json
        $updated | Add-Member -NotePropertyName "limit" -NotePropertyValue 100 -Force
        Emit-Hook $updated "Terse: capped to 100 lines (generated/binary file)"
        Track-Save "Read" 2000 100
        exit 0
    }

    # If no limit set, check file size
    if (-not $limit -or $limit -eq 0) {
        if (Test-Path $filePath) {
            $lineCount = (Get-Content $filePath -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
            if ($lineCount -gt 500) {
                $updated = $toolInput | ConvertTo-Json -Depth 3 | ConvertFrom-Json
                $updated | Add-Member -NotePropertyName "limit" -NotePropertyValue 500 -Force
                Emit-Hook $updated "Terse: file has $lineCount lines, showing 500. Use offset+limit for specific sections."
                Track-Save "Read" $lineCount 500
                exit 0
            }
        }
    }

    # Cap very high explicit limits
    if ($limit -and $limit -gt 1000) {
        $updated = $toolInput | ConvertTo-Json -Depth 3 | ConvertFrom-Json
        $updated | Add-Member -NotePropertyName "limit" -NotePropertyValue 1000 -Force
        Emit-Hook $updated "Terse: capped Read limit to 1000 lines"
        Track-Save "Read" $limit 1000
        exit 0
    }

    exit 0
}

# ── GREP ──
if ($toolName -eq "Grep") {
    $headLimit = if ($toolInput.head_limit) { $toolInput.head_limit } else { 0 }
    $outputMode = if ($toolInput.output_mode) { $toolInput.output_mode } else { "files_with_matches" }
    $contextA = if ($toolInput.'-A') { $toolInput.'-A' } else { 0 }
    $contextB = if ($toolInput.'-B') { $toolInput.'-B' } else { 0 }
    $contextC = if ($toolInput.'-C') { $toolInput.'-C' } elseif ($toolInput.context) { $toolInput.context } else { 0 }

    $modified = $false
    $updated = $toolInput | ConvertTo-Json -Depth 3 | ConvertFrom-Json
    $notes = @()

    if ($outputMode -eq "content") {
        if ($headLimit -eq 0 -or $headLimit -gt 200) {
            $updated | Add-Member -NotePropertyName "head_limit" -NotePropertyValue 200 -Force
            $modified = $true
            $notes += "capped to 200 lines"
        }
    } elseif ($outputMode -eq "files_with_matches") {
        if ($headLimit -eq 0 -or $headLimit -gt 50) {
            $updated | Add-Member -NotePropertyName "head_limit" -NotePropertyValue 50 -Force
            $modified = $true
            $notes += "capped to 50 files"
        }
    }

    $maxCtx = 5
    if ($contextA -gt $maxCtx) { $updated | Add-Member -NotePropertyName "-A" -NotePropertyValue $maxCtx -Force; $modified = $true; $notes += "context-after capped to $maxCtx" }
    if ($contextB -gt $maxCtx) { $updated | Add-Member -NotePropertyName "-B" -NotePropertyValue $maxCtx -Force; $modified = $true; $notes += "context-before capped to $maxCtx" }
    if ($contextC -gt $maxCtx) { $updated | Add-Member -NotePropertyName "-C" -NotePropertyValue $maxCtx -Force; $updated | Add-Member -NotePropertyName "context" -NotePropertyValue $maxCtx -Force; $modified = $true; $notes += "context capped to $maxCtx" }

    if ($modified) {
        Emit-Hook $updated ("Terse: " + ($notes -join ", "))
        Track-Save "Grep" 500 200
        exit 0
    }

    exit 0
}

# ── GLOB ──
if ($toolName -eq "Glob") {
    exit 0
}

exit 0
