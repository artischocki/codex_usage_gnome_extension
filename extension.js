import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_AUTH_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
const FETCH_SCRIPT = 'fetch_codex_status.py';
const USAGE_PAGE_URL = 'https://chatgpt.com/codex/settings/usage';
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'codex-usage']);
const CACHE_PATH = GLib.build_filenamev([CACHE_DIR, 'last-usage.json']);
const MANUAL_REFRESH_COOLDOWN_MS = 5000;
const PANEL_SIDE_BY_SETTING = {
    left: 'left',
    right: 'right',
};

const CodexUsageIndicator = GObject.registerClass(
class CodexUsageIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.5, 'Codex Usage Indicator');

        this._extension = extension;
        this._settings = settings;
        this._lastUpdatedAt = null;
        this._lastPayload = null;
        this._refreshInFlight = false;
        this._manualRefreshCooldownUntil = 0;
        this._manualRefreshCooldownId = null;

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
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'codex-usage-panel-progress-bar',
            x_align: Clutter.ActorAlign.START,
        });
        this._bindProgressBar(this._panelProgressBg, this._panelProgressBar, 'panel');
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
        this._loadCachedPayload();

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if ((key === 'time-format' || key === 'date-format' || key === 'usage-metric' || key === 'show-code-review') && this._lastPayload) {
                this._updateDisplay(this._lastPayload);
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

        const refreshNowItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        this._refreshNowButtonLabel = new St.Label({
            text: 'Update Now',
            style_class: 'codex-usage-action-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._refreshNowButton = new St.Button({
            child: this._refreshNowButtonLabel,
            can_focus: true,
            x_expand: true,
            style_class: 'popup-menu-item',
        });
        this._refreshNowButton.connect('clicked', () => {
            this._refreshUsage(true);
        });
        refreshNowItem.add_child(this._refreshNowButton);
        this.menu.addMenuItem(refreshNowItem);

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
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const progressBar = new St.Widget({
            style_class: 'codex-usage-progress-bar usage-low',
            x_align: Clutter.ActorAlign.START,
        });
        this._bindProgressBar(progressBg, progressBar, 'menu');
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

    _bindProgressBar(progressBg, progressBar, mode) {
        progressBar._codexFillMode = mode;
        progressBar._codexPercent = null;
        progressBg.connect('notify::width', () => {
            this._syncProgressBar(progressBg, progressBar);
        });
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

    _refreshUsage(manual = false) {
        if (this._refreshInFlight || (manual && !this._canRunManualRefresh())) {
            return;
        }

        if (manual) {
            this._startManualRefreshCooldown();
        }

        this._refreshInFlight = true;
        this._setRefreshActionState();
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
                    this._finishRefresh();
                    return;
                }

                this._fetchUsage(authPath);
            } catch (error) {
                console.error(`Codex Usage: failed to read auth file: ${error.message}`);
                this._setErrorState(`Could not read ${authPath}`);
                this._finishRefresh();
            }
        });
    }

    _fetchUsage(authPath) {
        const scriptPath = GLib.build_filenamev([this._extension.path, FETCH_SCRIPT]);
        const argv = [
            'python3',
            scriptPath,
            '--raw',
            '--auth-file',
            authPath,
            '--timeout',
            '30',
        ];
        const proxyUrl = this._settings.get_string('proxy-url').trim();
        if (proxyUrl !== '') {
            argv.push('--proxy-url', proxyUrl);
        }

        const subprocess = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        subprocess.communicate_utf8_async(null, null, (_proc, result) => {
            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                if (!subprocess.get_successful()) {
                    const message = stderr?.trim() || 'Usage request failed';
                    console.error(`Codex Usage: failed to fetch usage: ${message}`);
                    this._setErrorState(message);
                    this._finishRefresh();
                    return;
                }

                const payload = JSON.parse(stdout);
                this._updateDisplay(payload);
                this._storeCachedPayload(payload);
            } catch (error) {
                console.error(`Codex Usage: failed to fetch usage: ${error.message}`);
                this._setErrorState('Usage request failed');
            } finally {
                this._finishRefresh();
            }
        });
    }

    _finishRefresh() {
        this._refreshInFlight = false;
        this._setRefreshActionState();
    }

    _canRunManualRefresh() {
        return Date.now() >= this._manualRefreshCooldownUntil;
    }

    _startManualRefreshCooldown() {
        this._manualRefreshCooldownUntil = Date.now() + MANUAL_REFRESH_COOLDOWN_MS;

        if (this._manualRefreshCooldownId) {
            GLib.source_remove(this._manualRefreshCooldownId);
        }

        this._manualRefreshCooldownId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            MANUAL_REFRESH_COOLDOWN_MS,
            () => {
                this._manualRefreshCooldownId = null;
                this._setRefreshActionState();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _setRefreshActionState() {
        if (!this._refreshNowButton || !this._refreshNowButtonLabel) {
            return;
        }

        const inCooldown = !this._canRunManualRefresh();
        this._refreshNowButtonLabel.text = this._refreshInFlight
            ? 'Updating...'
            : inCooldown
                ? 'Update Now (5s)'
                : 'Update Now';
        this._refreshNowButton.set_reactive(!this._refreshInFlight && !inCooldown);
        this._refreshNowButton.can_focus = !this._refreshInFlight && !inCooldown;
    }

    _loadCachedPayload() {
        try {
            const file = Gio.File.new_for_path(CACHE_PATH);
            const [success, contents] = file.load_contents(null);
            if (!success) {
                return;
            }

            const payload = JSON.parse(new TextDecoder().decode(contents));
            this._updateDisplay(payload);
            this._updatedLabel.set_text('Showing cached result');
        } catch (_error) {
        }
    }

    _storeCachedPayload(payload) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            const file = Gio.File.new_for_path(CACHE_PATH);
            file.replace_contents(
                JSON.stringify(payload),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (error) {
            console.error(`Codex Usage: failed to store cache: ${error.message}`);
        }
    }

    _setErrorState(message) {
        if (this._lastPayload) {
            this._updatedLabel.set_text(`Refresh failed (${message}), showing last result`);
            return;
        }

        this._label.set_text('Error');
        this._updatePanelProgressBar(null);
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
        this._lastPayload = payload;
        const rateLimit = payload.rate_limit ?? {};
        const primary = rateLimit.primary_window ?? null;
        const secondary = rateLimit.secondary_window ?? null;
        const codeReview = payload.code_review_rate_limit ?? null;
        const credits = payload.credits ?? null;

        const primaryPercent = this._displayPercent(primary);
        const secondaryPercent = this._displayPercent(secondary);

        this._label.set_text(this._formatPanelPercent(primaryPercent));
        this._updatePanelProgressBar(primaryPercent);
        this._creditsLabel.set_text(this._formatCredits(credits, rateLimit.allowed === false));

        this._primaryValueLabel.set_text(this._formatPercent(primaryPercent));
        this._primaryResetLabel.set_text(this._formatShortWindowMeta(primary));
        this._updateProgressBar(this._primaryProgressBar, primaryPercent);

        this._secondaryValueLabel.set_text(this._formatPercent(secondaryPercent));
        this._secondaryResetLabel.set_text(this._formatLongWindowMeta(secondary));
        this._updateProgressBar(this._secondaryProgressBar, secondaryPercent);

        const reviewWindow = codeReview?.primary_window ?? null;
        if (reviewWindow && this._settings.get_boolean('show-code-review')) {
            const reviewPercent = this._displayPercent(reviewWindow);
            this._reviewValueLabel.set_text(this._formatPercent(reviewPercent));
            this._reviewResetLabel.set_text(this._formatLongWindowMeta(reviewWindow));
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
            return null;
        }
        return Math.max(0, Math.min(100, value));
    }

    _displayPercent(window) {
        const usedPercent = this._windowPercent(window);
        if (usedPercent === null) {
            return null;
        }
        if (this._settings.get_string('usage-metric') === 'left') {
            return Math.max(0, Math.min(100, 100 - usedPercent));
        }
        return usedPercent;
    }

    _formatPercent(value) {
        if (value === null) {
            return '—';
        }
        return `${Math.round(value)}%`;
    }

    _formatPanelPercent(value) {
        if (value === null) {
            return '—';
        }
        return `${Math.round(value)}%`;
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

    _formatShortWindowMeta(window) {
        if (!window) {
            return 'No data';
        }

        const resetAfter = this._formatDuration(window.reset_after_seconds);
        const resetAt = this._formatClockTime(window.reset_at);
        return `Resets in ${resetAfter} at ${resetAt}`;
    }

    _formatLongWindowMeta(window) {
        if (!window) {
            return 'No data';
        }

        const resetAt = this._formatFullDateTime(window.reset_at);
        return `Resets at ${resetAt}`;
    }

    _formatClockTime(epochSeconds) {
        if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
            return 'unknown';
        }

        const date = GLib.DateTime.new_from_unix_local(Math.floor(epochSeconds));
        const timeFormat = this._settings.get_string('time-format');
        if (timeFormat === '12h') {
            return date.format('%I:%M %p').replace(/^0/, '');
        }
        return date.format('%H:%M');
    }

    _formatFullDateTime(epochSeconds) {
        if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) {
            return 'unknown';
        }

        const date = GLib.DateTime.new_from_unix_local(Math.floor(epochSeconds));
        const timeFormat = this._settings.get_string('time-format');
        const dateFormat = this._settings.get_string('date-format');

        let datePart = '';
        switch (dateFormat) {
        case 'day-month':
            datePart = date.format('%d %b');
            break;
        case 'month/day':
            datePart = date.format('%m/%d');
            break;
        case 'day/month':
            datePart = date.format('%d/%m');
            break;
        case 'month-day':
        default:
            datePart = date.format('%b %d').replace(/ 0(\d)$/, ' $1');
            break;
        }

        const timePart = timeFormat === '12h'
            ? date.format('%I:%M %p').replace(/^0/, '')
            : date.format('%H:%M');

        return `${datePart} ${timePart}`;
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
        this._panelProgressBar._codexPercent = percent;
        this._syncProgressBar(this._panelProgressBg, this._panelProgressBar);
    }

    _updateProgressBar(progressBar, percent) {
        progressBar._codexPercent = percent;
        this._syncProgressBar(progressBar.get_parent(), progressBar);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        const severityPercent = this._settings.get_string('usage-metric') === 'left'
            ? 100 - percent
            : percent;

        if (severityPercent >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (severityPercent >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (severityPercent >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _syncProgressBar(progressBg, progressBar) {
        const percent = progressBar._codexPercent;
        if (percent === null) {
            progressBar.set_width(0);
            return;
        }

        const backgroundWidth = progressBg?.width ?? 0;
        if (backgroundWidth <= 0) {
            return;
        }

        const shouldFillCompletely = progressBar._codexFillMode === 'panel'
            ? Math.round(percent) >= 100
            : Number(percent.toFixed(1)) >= 100;
        const width = shouldFillCompletely
            ? backgroundWidth + 1
            : Math.round((percent / 100) * backgroundWidth);

        progressBar.set_width(width);
    }

    destroy() {
        this._stopTimer();
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._manualRefreshCooldownId) {
            GLib.source_remove(this._manualRefreshCooldownId);
            this._manualRefreshCooldownId = null;
        }
        super.destroy();
    }
});

export default class CodexUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new CodexUsageIndicator(this, this._settings);
        this._addIndicator();
        this._panelSideChangedId = this._settings.connect('changed::panel-side', () => {
            this._moveIndicator();
        });
    }

    disable() {
        if (this._panelSideChangedId) {
            this._settings.disconnect(this._panelSideChangedId);
            this._panelSideChangedId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _addIndicator() {
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            0,
            PANEL_SIDE_BY_SETTING[this._settings.get_string('panel-side')] ?? 'right'
        );
    }

    _moveIndicator() {
        if (!this._indicator) {
            return;
        }

        this._indicator.destroy();
        this._indicator = new CodexUsageIndicator(this, this._settings);
        this._addIndicator();
    }
}
