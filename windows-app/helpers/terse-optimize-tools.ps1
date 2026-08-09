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

# ── Compression constants ──
# Tune meaning-preserving compression for large Read files. A PreToolUse hook can
# only rewrite tool INPUT, so we cap the raw read to a HEAD window (via limit) and
# deliver a compressed TAIL of the file plus repeat collapsing as additionalContext.
# This preserves file endings (exports, closing brackets, error tails) a head-cap drops.
$HeadKeep = 400        # first N lines shown as the raw Read output
$TailKeep = 100        # last M lines surfaced via additionalContext
$ByteCap  = 61440      # 60 KB hard backstop on the tail rendering

# Collapse-Runs — fold runs of >=3 consecutive identical or whitespace-only lines
# to a single representative line + a marker. Meaning-preserving. Pure PowerShell.
function Collapse-Runs([string[]]$lines) {
    $out = New-Object System.Collections.Generic.List[string]
    $prev = $null; $prevKey = $null; $run = 0
    $flush = {
        if ($run -ge 3) {
            $out.Add($prev)
            $out.Add("… [terse: ${run}× repeated] …")
        } elseif ($run -gt 0) {
            for ($i = 0; $i -lt $run; $i++) { $out.Add($prev) }
        }
    }
    foreach ($line in $lines) {
        $key = if ($line -match '^\s*$') { "" } else { $line }
        if ($null -ne $prev -and $key -eq $prevKey) {
            $run++
        } else {
            & $flush
            $prev = $line; $prevKey = $key; $run = 1
        }
    }
    & $flush
    return ($out -join "`n")
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
            $allLines = @(Get-Content $filePath -ErrorAction SilentlyContinue)
            $lineCount = $allLines.Count
            if ($lineCount -gt 500) {
                # Large file. HEAD keep via limit; TAIL keep via additionalContext so file
                # endings survive the head-cap. Tail is run-collapsed (B) and byte-capped (C).
                $elided = $lineCount - $HeadKeep - $TailKeep
                $tailRender = $null
                if ($elided -gt 0) {
                    $tailLines = $allLines[($lineCount - $TailKeep)..($lineCount - 1)]
                    $tailRender = Collapse-Runs $tailLines
                    if ($tailRender.Length -gt $ByteCap) {
                        $tailRender = $tailRender.Substring(0, $ByteCap)  # 60 KB hard backstop
                    }
                }

                if ($tailRender) {
                    $updated = $toolInput | ConvertTo-Json -Depth 3 | ConvertFrom-Json
                    $updated | Add-Member -NotePropertyName "limit" -NotePropertyValue $HeadKeep -Force
                    $ctx = "Terse: $lineCount lines total. Showing first $HeadKeep lines above; last $TailKeep lines below (middle $elided elided).`n… [terse: elided $elided lines] …`n$tailRender"
                    Emit-Hook $updated $ctx
                    Track-Save "Read" $lineCount $HeadKeep
                    exit 0
                }

                # Fallback (tail render unavailable): original plain 500-line cap.
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
