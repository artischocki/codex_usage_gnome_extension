# Codex Usage GNOME Extension

A GNOME Shell extension that displays Codex usage in the top panel.

![Preview](preview.png)

## Data source

The extension:

- reads `~/.codex/auth.json` by default
- uses the access token and account id stored there
- calls `https://chatgpt.com/backend-api/wham/usage`
- is implemented entirely in GJS

It displays:

- 5-hour Codex usage
- 7-day Codex usage
- optional code-review usage when present
- credit information
- manual refresh
- configurable panel side, time format, and date format

## Manual install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/codex-usage@dernst.me
cp extension.js metadata.json openai-blossom-light.svg prefs.js stylesheet.css ~/.local/share/gnome-shell/extensions/codex-usage@dernst.me/
mkdir -p ~/.local/share/gnome-shell/extensions/codex-usage@dernst.me/schemas
cp schemas/org.gnome.shell.extensions.codex-usage.gschema.xml ~/.local/share/gnome-shell/extensions/codex-usage@dernst.me/schemas/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/codex-usage@dernst.me/schemas
```

Then restart GNOME Shell or log out and back in, and enable the extension.

## Build zip

```bash
mkdir -p dist
gnome-extensions pack . \
  --force \
  --out-dir dist \
  --extra-source=openai-blossom-light.svg
```

This creates `dist/codex-usage@dernst.me.shell-extension.zip`.
