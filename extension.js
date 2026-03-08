import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PRESENCE_STATUS_IDLE = 3;
const STORE_VERSION = 1;
const DEFAULT_HISTORY_DAYS = 90;
const MAX_ACCOUNTING_GAP_MS = 10 * 60 * 1000;

class UsageStore {
    constructor(uuid) {
        this._file = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_state_dir(),
            uuid,
            'state.json',
        ]));
        this._state = {
            version: STORE_VERSION,
            days: {},
        };

        this._load();
    }

    _load() {
        if (!this._file.query_exists(null))
            return;

        try {
            const [, contents] = this._file.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data?.version !== STORE_VERSION || typeof data.days !== 'object')
                return;

            const days = {};
            for (const [key, value] of Object.entries(data.days)) {
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
                    days[key] = Math.round(value);
            }

            this._state = {
                version: STORE_VERSION,
                days,
            };
        } catch (error) {
            console.error(`GNOME Usage: failed to load state: ${error.message}`);
        }
    }

    save() {
        try {
            const parent = this._file.get_parent();
            parent?.make_directory_with_parents(null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.error(`GNOME Usage: failed to create state directory: ${error.message}`);
        }

        try {
            this._file.replace_contents(
                JSON.stringify(this._state, null, 2),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (error) {
            console.error(`GNOME Usage: failed to save state: ${error.message}`);
        }
    }

    addSeconds(dayKey, seconds) {
        if (seconds <= 0)
            return;

        const current = this._state.days[dayKey] ?? 0;
        this._state.days[dayKey] = current + Math.round(seconds);
    }

    prune(daysToKeep) {
        const cutoff = GLib.DateTime.new_now_local().add_days(-(daysToKeep - 1));
        const cutoffKey = cutoff.format('%F');

        for (const key of Object.keys(this._state.days)) {
            if (key < cutoffKey)
                delete this._state.days[key];
        }
    }

    getDaySeconds(dayKey) {
        return this._state.days[dayKey] ?? 0;
    }

    getRangeSeconds(dayKeys) {
        return dayKeys.reduce((total, dayKey) => total + this.getDaySeconds(dayKey), 0);
    }
}

const GnomeUsageIndicator = GObject.registerClass(
class GnomeUsageIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, 'GNOME Usage Indicator');

        this._extension = extension;
        this._settings = settings;
        this._store = new UsageStore(extension.uuid);
        this._presenceStatus = 0;
        this._presenceAvailable = false;
        this._lastSampleAtMs = Date.now();
        this._trackingActive = true;
        this._lastUpdatedLabelText = 'Not updated yet';
        this._lastSavedAt = null;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._icon = new St.Icon({
            icon_name: 'preferences-system-time-symbolic',
            style_class: 'system-status-icon gnome-usage-icon',
        });
        this._box.add_child(this._icon);

        this._panelProgressBg = new St.Widget({
            style_class: 'gnome-usage-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'gnome-usage-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnome-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();
        this._setupPresenceTracking();
        this._updateDisplayMode();
        this._updateIconVisibility();
        this._trackingActive = this._computeTrackingState();

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'history-days') {
                this._store.prune(this._settings.get_int('history-days'));
                this._store.save();
            }

            this._updateDisplay();
        });

        this._updateDisplay();
        this._startTimer();
    }

    _createMenu() {
        this._statusLabel = this._addInfoRow('Tracking', 'Waiting for first sample');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const todaySection = this._addUsageSection('Today');
        this._todayValueLabel = todaySection.valueLabel;
        this._todayProgressBar = todaySection.progressBar;
        this._todayMetaLabel = todaySection.metaLabel;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const weekSection = this._addUsageSection('Last 7 Days');
        this._weekValueLabel = weekSection.valueLabel;
        this._weekProgressBar = weekSection.progressBar;
        this._weekMetaLabel = weekSection.metaLabel;

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const footerBox = new St.BoxLayout({
            style_class: 'gnome-usage-footer-box',
            vertical: true,
        });
        this._lastUpdatedLabel = new St.Label({
            text: this._lastUpdatedLabelText,
            style_class: 'gnome-usage-meta-label',
        });
        footerBox.add_child(this._lastUpdatedLabel);
        footerItem.add_child(footerBox);
        this.menu.addMenuItem(footerItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _addInfoRow(title, subtitle) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            style_class: 'gnome-usage-section',
            vertical: true,
        });

        const titleLabel = new St.Label({
            text: title,
            style_class: 'gnome-usage-section-title',
        });
        box.add_child(titleLabel);

        const valueLabel = new St.Label({
            text: subtitle,
            style_class: 'gnome-usage-meta-label',
        });
        box.add_child(valueLabel);

        item.add_child(box);
        this.menu.addMenuItem(item);

        return valueLabel;
    }

    _addUsageSection(title) {
        const box = new St.BoxLayout({
            style_class: 'gnome-usage-section',
            vertical: true,
        });

        const header = new St.BoxLayout({vertical: false});
        const titleLabel = new St.Label({
            text: title,
            style_class: 'gnome-usage-section-title',
        });
        header.add_child(titleLabel);

        const valueLabel = new St.Label({
            text: '...',
            style_class: 'gnome-usage-value-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(valueLabel);
        box.add_child(header);

        const progressBg = new St.Widget({
            style_class: 'gnome-usage-progress-bg',
        });
        const progressBar = new St.Widget({
            style_class: 'gnome-usage-progress-bar usage-low',
        });
        progressBg.add_child(progressBar);
        box.add_child(progressBg);

        const metaLabel = new St.Label({
            text: '',
            style_class: 'gnome-usage-meta-label',
        });
        box.add_child(metaLabel);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(box);
        this.menu.addMenuItem(item);

        return {
            valueLabel,
            progressBar,
            metaLabel,
        };
    }

    _setupPresenceTracking() {
        try {
            this._presenceProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager/Presence',
                'org.gnome.SessionManager.Presence',
                null
            );
            this._presenceAvailable = this._presenceProxy.get_name_owner() !== null;
            this._presenceChangedId = this._presenceProxy.connect(
                'g-properties-changed',
                () => this._syncPresenceStatus()
            );
            this._presenceOwnerChangedId = this._presenceProxy.connect(
                'notify::g-name-owner',
                () => {
                    this._presenceAvailable = this._presenceProxy.get_name_owner() !== null;
                    this._syncPresenceStatus();
                }
            );
            this._syncPresenceStatus();
        } catch (error) {
            console.error(`GNOME Usage: failed to connect to presence service: ${error.message}`);
            this._presenceProxy = null;
            this._presenceAvailable = false;
            this._presenceStatus = 0;
        }
    }

    _syncPresenceStatus() {
        if (!this._presenceProxy)
            return;

        const status = this._presenceProxy.get_cached_property('status');
        if (!status)
            return;

        const nextStatus = status.unpack();
        if (nextStatus === this._presenceStatus) {
            this._presenceAvailable = this._presenceProxy.get_name_owner() !== null;
            return;
        }

        this._advanceClock(Date.now());
        this._presenceStatus = nextStatus;
        this._presenceAvailable = this._presenceProxy.get_name_owner() !== null;
        this._trackingActive = this._computeTrackingState();
        this._updateDisplay();
    }

    _computeTrackingState() {
        if (Main.sessionMode.isLocked)
            return false;

        if (!this._presenceAvailable)
            return true;

        return this._presenceStatus !== PRESENCE_STATUS_IDLE;
    }

    _startTimer() {
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'),
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (!this._timerId)
            return;

        GLib.source_remove(this._timerId);
        this._timerId = null;
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _tick() {
        const nowMs = Date.now();
        this._advanceClock(nowMs);
        this._trackingActive = this._computeTrackingState();
        this._updateDisplay();
    }

    _advanceClock(nowMs) {
        if (!this._lastSampleAtMs) {
            this._lastSampleAtMs = nowMs;
            return;
        }

        const deltaMs = nowMs - this._lastSampleAtMs;
        this._lastSampleAtMs = nowMs;

        if (!this._trackingActive)
            return;

        if (deltaMs <= 0 || deltaMs > MAX_ACCOUNTING_GAP_MS)
            return;

        const seconds = Math.round(deltaMs / 1000);
        if (seconds <= 0)
            return;

        const dayKey = this._dayKeyForMs(nowMs);
        this._store.addSeconds(dayKey, seconds);
        this._store.prune(this._settings.get_int('history-days') || DEFAULT_HISTORY_DAYS);
        this._store.save();
        this._lastSavedAt = nowMs;
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
        if (this._settings.get_boolean('show-icon'))
            this._icon.show();
        else
            this._icon.hide();
    }

    _updateDisplay() {
        const now = GLib.DateTime.new_now_local();
        const dayKeys = this._lastDayKeys(7);
        const todayKey = dayKeys[0];
        const todaySeconds = this._store.getDaySeconds(todayKey);
        const weekSeconds = this._store.getRangeSeconds(dayKeys);
        const activeNow = this._computeTrackingState();

        const panelPeriod = this._settings.get_string('panel-period');
        const panelSeconds = panelPeriod === 'week' ? weekSeconds : todaySeconds;
        const panelGoalSeconds = panelPeriod === 'week'
            ? this._settings.get_int('weekly-goal-minutes') * 60
            : this._settings.get_int('daily-goal-minutes') * 60;

        this._label.set_text(this._formatDurationCompact(panelSeconds));
        this._updatePanelProgressBar(this._progressPercent(panelSeconds, panelGoalSeconds));

        this._todayValueLabel.set_text(this._formatDurationLong(todaySeconds));
        this._todayMetaLabel.set_text(
            `${this._goalLabel('Daily goal', this._settings.get_int('daily-goal-minutes') * 60)} • ${activeNow ? 'tracking now' : this._statusReason()}`
        );
        this._updateProgressBar(
            this._todayProgressBar,
            this._progressPercent(todaySeconds, this._settings.get_int('daily-goal-minutes') * 60)
        );

        this._weekValueLabel.set_text(this._formatDurationLong(weekSeconds));
        this._weekMetaLabel.set_text(
            `Average ${this._formatDurationCompact(Math.round(weekSeconds / 7))}/day • ${this._goalLabel('Weekly goal', this._settings.get_int('weekly-goal-minutes') * 60)}`
        );
        this._updateProgressBar(
            this._weekProgressBar,
            this._progressPercent(weekSeconds, this._settings.get_int('weekly-goal-minutes') * 60)
        );

        this._statusLabel.set_text(activeNow
            ? 'Tracking activity from GNOME session presence'
            : `Paused: ${this._statusReason()}`
        );

        this._lastUpdatedLabelText = this._lastSavedAt
            ? `Last sample ${this._formatRelativeTime(this._lastSavedAt, now)}`
            : 'Waiting for the first activity sample';
        this._lastUpdatedLabel.set_text(this._lastUpdatedLabelText);
    }

    _statusReason() {
        if (Main.sessionMode.isLocked)
            return 'screen locked';

        if (this._presenceAvailable && this._presenceStatus === PRESENCE_STATUS_IDLE)
            return 'session idle';

        if (!this._presenceAvailable)
            return 'presence service unavailable';

        return 'paused';
    }

    _progressPercent(valueSeconds, goalSeconds) {
        if (goalSeconds <= 0)
            return 0;

        return Math.min(100, Math.round((valueSeconds / goalSeconds) * 100));
    }

    _goalLabel(prefix, goalSeconds) {
        return `${prefix}: ${this._formatDurationCompact(goalSeconds)}`;
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

        if (percent >= 100) {
            progressBar.add_style_class_name('usage-critical');
        } else if (percent >= 80) {
            progressBar.add_style_class_name('usage-high');
        } else if (percent >= 50) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _lastDayKeys(days) {
        const keys = [];
        const base = GLib.DateTime.new_now_local();
        for (let offset = 0; offset < days; offset++) {
            keys.push(base.add_days(-offset).format('%F'));
        }
        return keys;
    }

    _dayKeyForMs(epochMs) {
        const date = GLib.DateTime.new_from_unix_local(Math.floor(epochMs / 1000));
        return date.format('%F');
    }

    _formatDurationCompact(totalSeconds) {
        const seconds = Math.max(0, Math.round(totalSeconds));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0)
            return `${hours}h ${minutes}m`;

        if (minutes > 0)
            return `${minutes}m`;

        return '<1m';
    }

    _formatDurationLong(totalSeconds) {
        const seconds = Math.max(0, Math.round(totalSeconds));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0)
            return `${hours}h ${minutes}m active`;

        if (minutes > 0)
            return `${minutes}m active`;

        return 'Less than a minute';
    }

    _formatRelativeTime(epochMs, now) {
        const then = GLib.DateTime.new_from_unix_local(Math.floor(epochMs / 1000));
        const diffSeconds = Math.max(0, now.to_unix() - then.to_unix());

        if (diffSeconds < 60)
            return 'just now';

        if (diffSeconds < 3600)
            return `${Math.floor(diffSeconds / 60)}m ago`;

        return `${Math.floor(diffSeconds / 3600)}h ago`;
    }

    destroy() {
        this._advanceClock(Date.now());
        this._stopTimer();
        this._store.save();

        if (this._presenceProxy && this._presenceChangedId) {
            this._presenceProxy.disconnect(this._presenceChangedId);
            this._presenceChangedId = null;
        }

        if (this._presenceProxy && this._presenceOwnerChangedId) {
            this._presenceProxy.disconnect(this._presenceOwnerChangedId);
            this._presenceOwnerChangedId = null;
        }

        this._presenceProxy = null;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        super.destroy();
    }
});

export default class GnomeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new GnomeUsageIndicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
