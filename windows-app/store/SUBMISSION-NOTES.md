# Microsoft Store submission — text to paste

> ⚠ The restricted-capability justification below describes what the code
> ACTUALLY does, including keystroke capture. Read the "Keystroke capture"
> section before submitting — it is a review risk and a policy decision, not
> boilerplate. Do not submit a justification that omits it: an inaccurate
> declaration to the Store is grounds for removal, and the low-level keyboard
> hook is discoverable in the binary.

## What the bundled helper (terse-uia.exe) actually does

Verified against windows-app/helpers/terse-uia/Program.cs:

1. **UI Automation reads** (`AutomationElement`, `ValuePattern`, `TextPattern`)
   — reads the focused window and the text of the coding tool's input field,
   to know which tool is active and to read the prompt being written.
2. **A global low-level keyboard hook** (`SetWindowsHookEx(WH_KEYBOARD_LL)`),
   the `key-monitor` mode. It buffers printable keystrokes and emits the text
   on Enter. It is the fallback text-capture path used when UI Automation
   cannot read a tool's editor (e.g. Electron/canvas editors like VS Code).
   The shipped app uses it: `read_method == "keymonitor"` in lib.rs.
   - It is gated to a target process: keys are only buffered while THAT tool's
     window is in the foreground (`fgPid == TargetPid`), and the buffer is
     dropped otherwise.
   - But the hook itself is system-wide, and while the target is focused it
     records the actual characters typed.
3. **Synthesized keystrokes** (`keybd_event`) to paste optimized text back.

## Keystroke capture — decide before submitting

The hook is legitimate (it captures only the target coding tool's prompt, to
optimize it) but it IS keystroke capture, and the Store treats a global
keyboard hook under runFullTrust as high-scrutiny. Two honest options:

- **Submit as-is** with the accurate justification below. Expect questions;
  answer them with the gating detail. Higher rejection risk.
- **Ship a Store build without key-monitor.** Fall back to clipboard/UIA
  capture only (the app already has `read_method == "clipboard"` and selection
  paths). Removes the keyboard hook from the Store binary entirely, which is
  the lowest-friction path to approval. This needs a code change and is a
  product decision — it slightly weakens capture in canvas editors.

## Restricted capability justification (`runFullTrust`) — accurate version

Paste into 提交选项 → 受限功能. Only valid if you submit the build that
actually contains the keyboard hook.

```
Terse is a Win32 desktop app packaged as MSIX; runFullTrust is required for it
to run.

It reads which AI coding tool (Cursor, VS Code, Codex, Copilot, Windsurf, etc.)
is in the foreground and the prompt the user is currently writing in it, so it
can show token usage for the right tool and offer to shorten the prompt before
it is sent.

Text is read two ways. Where the Windows UI Automation API can read the tool's
input field, it is used directly. Where it cannot (some Electron/canvas
editors), Terse falls back to a keyboard hook that buffers what the user types
ONLY while that specific coding tool's window is in the foreground; the buffer
is discarded whenever any other window is focused, and it is used solely to
recover the prompt text for optimization.

Terse does not run when those tools are not in focus, does not read document or
file contents, and transmits nothing typed — prompt optimization runs on the
local machine.
```

## Product declarations

- Accesses/transmits personal info? **Yes** — email (sign-in).
- Uses Microsoft commerce? **No** — Stripe on the web (Store cut 0%, no payout
  profile needed).
- Age rating: declare **user-generated content** (rooms chat, plaza posts,
  DMs). Moderation exists (illegal content, near-duplicate detection, report
  path) — name it.

## Package

Upload `Terse.msix` from the **Terse-MSIX** artifact of
build-windows-store.yml. If it is named `Terse-MSIX-DRYRUN-not-submittable`,
the identity secrets were unset at build time — set them and re-run.

## Declared requirements

- Min Windows 10 1809 (10.0.17763); x64; `terse://` protocol handler.
