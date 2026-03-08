import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodexUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Codex Usage',
            icon_name: 'utilities-terminal-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure how the extension fetches and displays Codex usage.',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'How often to request usage from the Codex backend, in seconds.',
            adjustment: new Gtk.Adjustment({
                lower: 15,
                upper: 900,
                step_increment: 15,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(refreshRow);

        const authRow = new Adw.EntryRow({
            title: 'Auth file',
            show_apply_button: true,
        });
        authRow.set_text(settings.get_string('auth-file'));
        authRow.connect('apply', () => {
            settings.set_string('auth-file', authRow.get_text());
        });
        generalGroup.add(authRow);

        const authHint = new Gtk.Label({
            label: 'Leave empty to use ~/.codex/auth.json',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        generalGroup.add(authHint);

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel display',
            description: 'Choose how 5-hour usage appears in the top bar.',
        });
        page.add(panelGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display mode',
            subtitle: 'Show a number, a progress bar, or both.',
        });
        const displayModel = new Gtk.StringList();
        displayModel.append('Text');
        displayModel.append('Progress bar');
        displayModel.append('Both');
        displayModeRow.set_model(displayModel);
        displayModeRow.set_selected(this._displayModeIndex(settings.get_string('display-mode')));
        displayModeRow.connect('notify::selected', () => {
            settings.set_string('display-mode', ['text', 'bar', 'both'][displayModeRow.get_selected()]);
        });
        panelGroup.add(displayModeRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show icon',
            subtitle: 'Display a terminal icon next to the usage indicator.',
        });
        settings.bind('show-icon', showIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showIconRow);

        const timeFormatRow = new Adw.ComboRow({
            title: 'Reset time format',
            subtitle: 'Choose whether reset times use a 24-hour or 12-hour clock.',
        });
        const timeFormatModel = new Gtk.StringList();
        timeFormatModel.append('24-hour');
        timeFormatModel.append('12-hour');
        timeFormatRow.set_model(timeFormatModel);
        timeFormatRow.set_selected(settings.get_string('time-format') === '12h' ? 1 : 0);
        timeFormatRow.connect('notify::selected', () => {
            settings.set_string('time-format', timeFormatRow.get_selected() === 1 ? '12h' : '24h');
        });
        panelGroup.add(timeFormatRow);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Optional proxy settings for the usage request.',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:8080. Leave empty for direct access.',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);
    }

    _displayModeIndex(mode) {
        if (mode === 'bar') {
            return 1;
        }
        if (mode === 'both') {
            return 2;
        }
        return 0;
    }
}
