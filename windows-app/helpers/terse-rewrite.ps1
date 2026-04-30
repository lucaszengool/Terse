# terse-rewrite.ps1 — RTK-style PreToolUse hook for Claude Code (Windows)
# Intercepts Bash tool calls and pipes output through terse-compress
# for 60-90% token reduction on common dev commands.
#
# Install: Add to ~/.claude/settings.json:
# {
#   "hooks": {
#     "PreToolUse": [
#       {
#         "matcher": "Bash",
#         "hooks": [
#           {
#             "type": "command",
#             "command": "powershell -ExecutionPolicy Bypass -File ~/.terse/terse-rewrite.ps1"
#           }
#         ]
#       }
#     ]
#   }
# }

$ErrorActionPreference = "SilentlyContinue"

# Exit immediately if Terse is not running
$terseProc = Get-Process -Name "Terse" -ErrorAction SilentlyContinue
if (-not $terseProc) { exit 0 }

# Read tool use event from stdin
$input = $input | Out-String
if (-not $input) { $input = [Console]::In.ReadToEnd() }
$event = $input | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $event) { exit 0 }

$toolName = $event.tool_name
if ($toolName -ne "Bash") { exit 0 }

$command = $event.tool_input.command
if (-not $command) { exit 0 }

# Skip commands that shouldn't be compressed
$skipPatterns = @(
    "terse-compress", "terse-rewrite",
    "<<EOF", "<<'",
    "cd ", "echo ", "export ", "mkdir ", "chmod ", "mv ", "cp ",
    "rm ", "touch ", "which ", "pwd", "kill ", "pkill ",
    "ssh ", "vim ", "nano ", "start "
)

foreach ($pattern in $skipPatterns) {
    if ($command -like "*$pattern*") { exit 0 }
}

# Commands that benefit most from compression
$compressPatterns = @(
    "git status", "git diff", "git log", "git show", "git branch", "git stash",
    "git push", "git pull", "git fetch", "git remote", "git blame",
    "ls ", "ls -", "find ", "tree", "du ", "df ", "dir ",
    "npm test", "npx ", "jest", "vitest", "pytest", "cargo test", "go test",
    "npm run", "pnpm ", "yarn ", "bun ",
    "npm install", "npm ci", "pnpm install", "yarn install",
    "eslint", "tsc ", "tsc --", "biome", "prettier", "ruff", "clippy",
    "docker ps", "docker images", "docker logs", "docker compose",
    "kubectl ", "helm ",
    "cargo build", "cargo clippy", "cargo check", "go build", "go vet", "make",
    "pip list", "pip show", "pip install", "pip freeze",
    "cat ", "head ", "tail ", "wc ",
    "env", "printenv", "set",
    "ps ", "tasklist",
    "curl ", "wget ",
    "grep ", "rg ", "findstr "
)

$shouldCompress = $false
foreach ($pattern in $compressPatterns) {
    if ($command.StartsWith($pattern) -or $command -like "* | $pattern*" -or $command -like "* && $pattern*") {
        $shouldCompress = $true
        break
    }
}

# Also compress if output is likely to be large (chained commands)
if (-not $shouldCompress) {
    if ($command -like "* | *" -and $command.Length -gt 50) {
        $shouldCompress = $true
    }
}

if (-not $shouldCompress) { exit 0 }

# Find terse-compress
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$terseCompress = $null

$candidates = @(
    "$scriptDir\terse-compress.js",
    "$env:USERPROFILE\.terse\terse-compress.js"
)

foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
        $terseCompress = $candidate
        break
    }
}

if (-not $terseCompress) { exit 0 }

# Rewrite: wrap command to pipe through terse-compress
$wrapped = "($command) 2>&1 | node `"$terseCompress`""

# Emit the modified tool input
$output = @{
    hookSpecificOutput = @{
        hookEventName = "PreToolUse"
        permissionDecision = "allow"
        updatedInput = @{
            command = $wrapped
        }
        additionalContext = ""
    }
} | ConvertTo-Json -Depth 4 -Compress

Write-Output $output
exit 0
