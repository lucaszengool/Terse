# Shipping Terse for Windows to the Microsoft Store

Google Play cannot host a Windows app — Play only accepts Android packages.
`windows-app/` is a Tauri desktop app, so its store is the Microsoft Store.

## Cost

| Item | Cost |
|---|---|
| Partner Center developer account — individual | **$19 USD one-time** |
| Partner Center developer account — company | **$99 USD one-time** |
| Publishing / updates | Free |
| Microsoft's cut on non-gaming apps | **15%**, or **0%** if you keep your own commerce (Stripe) |

The 0% tier is why Terse should keep selling Pro through Stripe on Windows
rather than adding Microsoft's in-app purchase. Android is the opposite case:
Play *requires* Play Billing, which is why the Android app routes Upgrade
through it.

Confirm current figures at partner.microsoft.com before paying — these are the
numbers as of this writing.

## What's already wired

- `windows-app/store/AppxManifest.xml` — MSIX manifest, with the three
  Partner Center values left as `__PLACEHOLDERS__`.
- `windows-app/store/Assets/` — the required tiles (44, 150, 310×150, 310, 50).
- `.github/workflows/build-windows-store.yml` — builds the app, stages the MSIX
  layout, substitutes the identity, and packs it with `makeappx`.

## What only you can do

The identity values are assigned by Partner Center when you reserve the app
name; nothing can derive them. Reserve the name, open **Product management →
Product identity**, and copy three values into repository secrets:

| Secret | Partner Center field | Looks like |
|---|---|---|
| `MSSTORE_IDENTITY_NAME` | Package/Identity/Name | `12345PruneAI.Terse` |
| `MSSTORE_IDENTITY_PUBLISHER` | Package/Identity/Publisher | `CN=A1B2C3D4-…` |
| `MSSTORE_PUBLISHER_DISPLAY` | Publisher display name | `PruneAI` |

An MSIX whose `Identity` does not match byte-for-byte is rejected at upload
with an unhelpful generic error.

## Build and submit

```
gh workflow run build-windows-store.yml -f version=1.3.3.0
```

The version must be four parts and end in `0` — the Store reserves the fourth.
Download the `Terse-MSIX` artifact and upload it to your submission's Packages
page. Do **not** sign it yourself: Store submissions are signed by Microsoft
after upload.

## Review notes to expect

- **`runFullTrust` is a restricted capability.** Terse needs it (UI Automation
  reads which agent window is focused). Justify it in the submission's
  restricted-capability box or review will reject it.
- **WebView2** is declared as a dependency at Windows 10 1809 (10.0.17763).
- The NSIS installer from `build-windows.yml` is still the right artifact for
  direct download from the site. Store users get the MSIX; everyone else gets
  the `.exe`. Both come from the same build.

## If you'd rather skip the Store

Direct download costs nothing and has no review, but an unsigned installer
triggers a SmartScreen warning that kills conversion. An OV code-signing
certificate runs roughly $200–400/year and needs hardware-token storage;
Azure Trusted Signing is cheaper if you qualify. That is the real trade: Store
review latency vs. a certificate bill.
