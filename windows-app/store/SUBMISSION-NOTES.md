# Microsoft Store submission — text to paste

## Keyboard hook: removed from Store builds

The direct-download app has a global keyboard hook (SetWindowsHookEx
WH_KEYBOARD_LL) as a fallback for reading prompts out of editors UI Automation
cannot read. The Store build compiles with `TERSE_MSSTORE`, which #if-excludes
the entire hook — the key-monitor command, HandleKeyMonitor, the P/Invokes, and
the state class.

Verified against the actual CI artifact:
- Terse's own assembly (terse-uia.dll) contains NONE of SetWindowsHookEx,
  UnhookWindowsHookEx, CallNextHookEx, or HandleKeyMonitor.
- The single-file exe still shows `SetWindowsHookEx` only because it is a
  self-contained build that bundles Microsoft's own System.Windows.Forms.dll,
  which declares that import internally. That is framework code, present in
  every self-contained WinForms app — not Terse calling a hook.

So the Store build does not capture keystrokes. It reads prompts via UI
Automation and the clipboard only.

## Restricted capability justification (`runFullTrust`)

Paste into 提交选项 / Submission options → 受限功能 / Restricted capabilities.

```
Terse is a Win32 desktop application packaged as MSIX, so runFullTrust is
required for it to run.

It is used to show the user how much their AI coding tools are spending. A
bundled helper reads, through the Windows UI Automation API, which coding tool
(Cursor, VS Code, Codex, Copilot, Windsurf, etc.) is in the foreground and the
prompt currently in its input field, so that usage is attributed to the right
tool and the user can optionally shorten the prompt before sending it. It also
reads and writes the user's own local configuration files for those tools, to
install and remove optional prompt-optimization hooks at the user's request.

Terse does not install a keyboard hook, does not capture keystrokes, does not
inject code into other processes, and does not read document contents. Prompt
optimization runs entirely on the local machine; nothing typed is transmitted.
```

## Product declarations

- Accesses/transmits personal info? **Yes** — email (sign-in).
- Uses the Microsoft commerce engine? **No** — subscriptions sell on the web
  through Stripe (Store cut 0%, no payout/tax profile needed).
- Age rating: declare **user-generated content** — rooms have chat, the plaza
  has posts and DMs. Moderation exists (illegal content, near-duplicate
  detection, report path); name it in the answer.

## Listing text

**Title:** Terse

**Description:**

```
Terse shows you what your AI coding agents are actually spending.

It watches the tools you already use — Claude Code, Cursor, Codex, Copilot,
Windsurf and more — and turns their token usage into a live picture on your
desktop: what is running now, what it costs, and what is left today.

Link your phone to carry the same view with you. Open a room and watch the
same field with other people. Publish a project to the plaza and it appears,
drawn out of particles, on other people's screens.

An optional prompt optimizer trims filler from what you type before you send
it. It runs entirely on your machine — nothing you type is transmitted.

Pro unlocks the full wallpaper style set and the 3D free-view.
```

## Package

Upload `Terse.msix` from the **Terse-MSIX** artifact of
build-windows-store.yml. If it is named `Terse-MSIX-DRYRUN-not-submittable`,
the identity secrets were unset at build time — set the three MSSTORE_IDENTITY_*
secrets and re-run.

## Declared requirements

- Minimum Windows 10 1809 (10.0.17763); x64; `terse://` protocol handler.
