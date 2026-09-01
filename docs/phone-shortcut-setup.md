# Publishing the Terse shortcut (once)

This is the difference between a user tapping **one link** and a user building a
shortcut by hand from written steps. It has to be done once, on an iPhone, by a
person — and then never again.

## Why it cannot be automated

Since iOS 15 shortcuts must be **signed**, signing cannot be done on-device or on
a server, and the unsigned `.shortcut` import path was removed. The only form
that can be handed to someone else is an **iCloud share link**, and the only way
to produce one is to share a shortcut *from* an Apple device.

So no amount of server code can generate this. What server code *can* do is take
the link once it exists and put a one-tap button in front of every user, which is
what `TERSE_SHORTCUT_URL` does.

## Building it

On an iPhone, in Shortcuts → **+**:

### The still (Home Screen and Lock Screen, refreshes on a schedule)

1. **Get Contents of URL** — the `…​/w/<token>.png` link from the app.
2. **Set Wallpaper** — pick Home Screen, Lock Screen, or both.

### Or the overlay (keeps the user's own wallpaper, adds only the text)

1. **Find Photos** — where Album is *Wallpaper* (the user makes this album).
2. **Get Contents of URL** — the `…​/w/<token>.overlay.png` link.
3. **Overlay Images** — base is the photo, overlay is what was just fetched.
4. **Set Wallpaper**.

Leave the URL as a **placeholder the user replaces**: the token is per-account and
is a bearer credential, so a shortcut published with a real one would point every
user at one person's wallpaper. Use `Ask Each Time` for the URL, or a `Text`
action holding `PASTE YOUR TERSE LINK HERE`.

## Publishing it

Share sheet → **Copy iCloud Link**, then set it in Railway:

```
TERSE_SHORTCUT_URL=https://www.icloud.com/shortcuts/<id>
```

The app validates the host and only ever renders an `icloud.com/shortcuts` link,
so a mistyped value degrades to the written steps rather than sending people
somewhere arbitrary.

## What the user still has to do

Nothing about this is fully automatic, and the app says so rather than implying
otherwise:

- tap the link, then **Add Shortcut**
- paste their own Terse link into it once
- choose when it runs — Automation → Personal → **When I unlock iPhone** is the
  closest iOS offers to continuous, since there is no periodic background trigger

For the overlay route they also add their wallpaper photo to an album, because
iOS exposes no way for any app to read the wallpaper they already have.
