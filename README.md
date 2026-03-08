# GNOME Usage

A GNOME Shell extension that tracks your local GNOME activity time and shows it in the top panel.

## What it does

- Tracks active GNOME time locally, per day
- Shows a top-panel summary for today or the rolling last 7 days
- Opens a popup with today and 7-day totals plus goal progress
- Stores history under `~/.local/state/gnome-usage@artur.dev/state.json`

Tracking uses GNOME session presence to pause counting while the session is idle. Totals are approximate and become more accurate with shorter refresh intervals.

## Install manually

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/gnome-usage@artur.dev
cp -r . ~/.local/share/gnome-shell/extensions/gnome-usage@artur.dev
glib-compile-schemas ~/.local/share/gnome-shell/extensions/gnome-usage@artur.dev/schemas
```

Then restart GNOME Shell or log out and back in, and enable the extension.
