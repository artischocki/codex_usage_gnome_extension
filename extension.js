import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_AUTH_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
const DEFAULT_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USAGE_PAGE_URL = 'https://chatgpt.com/codex/settings/usage';

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'Codex Usage Indicator');

        this._extension = extension;
        this._settings = settings;
        this._session = this._createSession();
        this._lastUpdatedAt = null;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extension.path, 'openai-blossom-light.svg']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon,
            style_class: 'codex-usage-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'codex-usage-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'codex-usage-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'codex-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();
        this._updateDisplayMode();
        this._updateIconVisibility();

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            }

            if (key === 'auth-file' || key === 'proxy-url') {
                this._refreshUsage();
            }
        });

        this._refreshUsage();
        this._startTimer();
    }

    _createMenu() {
        const primarySection = this._addUsageSection('5-Hour Usage');
        this._primaryValueLabel = primarySection.valueLabel;
        this._primaryProgressBar = primarySection.progressBar;
        this._primaryResetLabel = primarySection.metaLabel;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const secondarySection = this._addUsageSection('7-Day Usage');
        this._secondaryValueLabel = secondarySection.valueLabel;
        this._secondaryProgressBar = secondarySection.progressBar;
        this._secondaryResetLabel = secondarySection.metaLabel;

        this._reviewLeadingSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._reviewLeadingSeparator);

        const reviewSection = this._addUsageSection('Code Review');
        this._reviewValueLabel = reviewSection.valueLabel;
        this._reviewProgressBar = reviewSection.progressBar;
        this._reviewResetLabel = reviewSection.metaLabel;
        this._reviewSectionItem = reviewSection.item;
        this._reviewSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._reviewSeparator);
        this._reviewLeadingSeparator.hide();
        this._reviewSectionItem.hide();
        this._reviewSeparator.hide();

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const footerBox = new St.BoxLayout({
            style_class: 'codex-usage-footer-box',
            vertical: true,
        });
        this._creditsLabel = new St.Label({
            text: 'Credits: ...',
            style_class: 'codex-usage-meta-label',
        });
        footerBox.add_child(this._creditsLabel);
        this._updatedLabel = new St.Label({
            text: 'Waiting for first update',
            style_class: 'codex-usage-meta-label',
        });
        footerBox.add_child(this._updatedLabel);
        footerItem.add_child(footerBox);
        this.menu.addMenuItem(footerItem);

        const usageItem = new PopupMenu.PopupMenuItem('Open Usage Page');
        usageItem.connect('activate', () => {
            try {
                Gio.app_info_launch_default_for_uri(USAGE_PAGE_URL, null);
            } catch (error) {
                console.error(`Codex Usage: failed to open usage page: ${error.message}`);
            }
        });
        this.menu.addMenuItem(usageItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _addUsageSection(title) {
        const box = new St.BoxLayout({
            style_class: 'codex-usage-section',
            vertical: true,
        });

        const header = new St.BoxLayout({vertical: false});
        header.add_child(new St.Label({
            text: title,
            style_class: 'codex-usage-section-title',
        }));

        const valueLabel = new St.Label({
            text: '...',
            style_class: 'codex-usage-value-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(valueLabel);
        box.add_child(header);

        const progressBg = new St.Widget({
            style_class: 'codex-usage-progress-bg',
        });
        const progressBar = new St.Widget({
            style_class: 'codex-usage-progress-bar usage-low',
        });
        progressBg.add_child(progressBar);
        box.add_child(progressBg);

        const metaLabel = new St.Label({
            text: '',
            style_class: 'codex-usage-meta-label',
        });
        box.add_child(metaLabel);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(box);
        this.menu.addMenuItem(item);

        return {
            item,
            valueLabel,
            progressBar,
            metaLabel,
        };
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url').trim();
        if (proxyUrl !== '') {
            const resolver = Gio.SimpleProxyResolver.new(proxyUrl, null);
            session.set_proxy_resolver(resolver);
        }
        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
    }

    _startTimer() {
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'),
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
    }

    _updateIconVisibility() {
        if (this._settings.get_boolean('show-icon')) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _refreshUsage() {
        const authPath = this._resolveAuthPath();
        const file = Gio.File.new_for_path(authPath);

        file.load_contents_async(null, (_file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const payload = JSON.parse(new TextDecoder().decode(contents));
                const tokens = payload.tokens ?? {};
                const accessToken = tokens.access_token;
                const accountId = tokens.account_id;

                if (!accessToken || !accountId) {
                    this._setErrorState('Missing Codex token or account ID');
                    return;
                }

                this._fetchUsage(accessToken, accountId);
            } catch (error) {
                console.error(`Codex Usage: failed to read auth file: ${error.message}`);
                this._setErrorState(`Could not read ${authPath}`);
            }
        });
    }

    _fetchUsage(accessToken, accountId) {
        const message = Soup.Message.new('GET', DEFAULT_API_URL);
        message.request_headers.append('Authorization', `Bearer ${accessToken}`);
        message.request_headers.append('ChatGPT-Account-Id', accountId);
        message.request_headers.append('Accept', 'application/json');
        message.request_headers.append('User-Agent', 'gnome-shell-codex-usage/1.0');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        this._setErrorState(`HTTP ${message.status_code}`);
                        return;
                    }

                    const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._updateDisplay(payload);
                } catch (error) {
                    console.error(`Codex Usage: failed to fetch usage: ${error.message}`);
                    this._setErrorState('Usage request failed');
                }
            }
        );
    }

    _setErrorState(message) {
        this._label.set_text('Error');
        this._panelProgressBar.set_width(0);
        this._creditsLabel.set_text(`Credits: ${message}`);
        this._primaryValueLabel.set_text('—');
        this._primaryResetLabel.set_text('—');
        this._secondaryValueLabel.set_text('—');
        this._secondaryResetLabel.set_text('—');
        this._reviewLeadingSeparator.hide();
        this._reviewSectionItem.hide();
        this._reviewSeparator.hide();
        this._updatedLabel.set_text('Last update failed');
    }

    _updateDisplay(payload) {
        const rateLimit = payload.rate_limit ?? {};
        const primary = rateLimit.primary_window ?? null;
        const secondary = rateLimit.secondary_window ?? null;
        const codeReview = payload.code_review_rate_limit ?? null;
        const credits = payload.credits ?? null;

        const primaryPercent = this._windowPercent(primary);
        const secondaryPercent = this._windowPercent(secondary);

        this._label.set_text(`${Math.round(primaryPercent)}%`);
        this._updatePanelProgressBar(primaryPercent);
        this._creditsLabel.set_text(this._formatCredits(credits, rateLimit.allowed === false));

        this._primaryValueLabel.set_text(this._formatPercent(primaryPercent));
        this._primaryResetLabel.set_text(this._formatWindowMeta(primary));
        this._updateProgressBar(this._primaryProgressBar, primaryPercent);

        this._secondaryValueLabel.set_text(this._formatPercent(secondaryPercent));
        this._secondaryResetLabel.set_text(this._formatWindowMeta(secondary));
        this._updateProgressBar(this._secondaryProgressBar, secondaryPercent);

        const reviewWindow = codeReview?.primary_window ?? null;
        if (reviewWindow) {
            const reviewPercent = this._windowPercent(reviewWindow);
            this._reviewValueLabel.set_text(this._formatPercent(reviewPercent));
            this._reviewResetLabel.set_text(this._formatWindowMeta(reviewWindow));
            this._updateProgressBar(this._reviewProgressBar, reviewPercent);
            this._reviewLeadingSeparator.show();
            this._reviewSectionItem.show();
            this._reviewSeparator.show();
        } else {
            this._reviewLeadingSeparator.hide();
            this._reviewSectionItem.hide();
            this._reviewSeparator.hide();
        }

        this._lastUpdatedAt = new Date();
        this._updatedLabel.set_text(`Updated ${this._formatRelativeNow()}`);
    }

    _windowPercent(window) {
        const value = window?.used_percent;
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.min(100, value));
    }

    _formatPercent(value) {
        return `${value.toFixed(1)}%`;
    }

    _formatCredits(credits, limitReached) {
        if (limitReached) {
            return 'Credits: limit reached';
        }

        if (!credits) {
            return 'Credits: no credit data';
        }

        if (credits.unlimited) {
            return 'Credits: unlimited';
        }

        return `Credits: balance ${credits.balance ?? '0'}`;
    }

    _formatWindowMeta(window) {
        if (!window) {
            return 'No data';
        }

        const resetAfter = this._formatDuration(window.reset_after_seconds);
        const resetAt = this._formatTimestamp(window.reset_at);
        const duration = this._formatDuration(window.limit_window_seconds);
        return `Resets in ${resetAfter} at ${resetAt} • window ${duration}`;
    }

    _formatTimestamp(epochSeconds) {
        if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
            return 'unknown';
        }

        const date = GLib.DateTime.new_from_unix_local(Math.floor(epochSeconds));
        return date.format('%Y-%m-%d %H:%M');
    }

    _formatDuration(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
            return 'unknown';
        }

        let remaining = Math.max(0, Math.floor(seconds));
        const hours = Math.floor(remaining / 3600);
        remaining %= 3600;
        const minutes = Math.floor(remaining / 60);
        const secs = remaining % 60;

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        }
        return `${secs}s`;
    }

    _formatRelativeNow() {
        if (!this._lastUpdatedAt) {
            return 'never';
        }

        const diffSeconds = Math.max(0, Math.floor((Date.now() - this._lastUpdatedAt.getTime()) / 1000));
        if (diffSeconds < 5) {
            return 'just now';
        }
        if (diffSeconds < 60) {
            return `${diffSeconds}s ago`;
        }
        if (diffSeconds < 3600) {
            return `${Math.floor(diffSeconds / 60)}m ago`;
        }
        return `${Math.floor(diffSeconds / 3600)}h ago`;
    }

    _resolveAuthPath() {
        const configured = this._settings.get_string('auth-file').trim();
        if (configured === '') {
            return DEFAULT_AUTH_PATH;
        }

        if (configured.startsWith('~/')) {
            return GLib.build_filenamev([GLib.get_home_dir(), configured.slice(2)]);
        }

        return configured;
    }

    _updatePanelProgressBar(percent) {
        const maxWidth = 52;
        const width = Math.round((percent / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
    }

    _updateProgressBar(progressBar, percent) {
        const maxWidth = 220;
        const width = Math.round((percent / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (percent >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (percent >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (percent >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    destroy() {
        this._stopTimer();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CodexUsageIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
