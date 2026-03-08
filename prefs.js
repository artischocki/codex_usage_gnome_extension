import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GnomeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'GNOME Usage',
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure how often the extension samples local GNOME activity.',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Sampling frequency in seconds. Lower values improve accuracy.',
            adjustment: new Gtk.Adjustment({
                lower: 15,
                upper: 300,
                step_increment: 15,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(refreshRow);

        const historyRow = new Adw.SpinRow({
            title: 'History retention',
            subtitle: 'How many days of local usage history to keep.',
            adjustment: new Gtk.Adjustment({
                lower: 7,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
                value: settings.get_int('history-days'),
            }),
        });
        settings.bind('history-days', historyRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(historyRow);

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Panel display',
            description: 'Choose what appears in the top bar.',
        });
        page.add(panelGroup);

        const displayModeRow = new Adw.ComboRow({
            title: 'Display mode',
            subtitle: 'Show text, a goal bar, or both in the top panel.',
        });
        const displayModel = new Gtk.StringList();
        displayModel.append('Text');
        displayModel.append('Progress bar');
        displayModel.append('Both');
        displayModeRow.set_model(displayModel);
        displayModeRow.set_selected(this._modeIndex(settings.get_string('display-mode')));
        displayModeRow.connect('notify::selected', () => {
            settings.set_string('display-mode', ['text', 'bar', 'both'][displayModeRow.get_selected()]);
        });
        panelGroup.add(displayModeRow);

        const panelPeriodRow = new Adw.ComboRow({
            title: 'Panel metric',
            subtitle: 'Use today or the rolling 7-day total for the panel summary.',
        });
        const periodModel = new Gtk.StringList();
        periodModel.append('Today');
        periodModel.append('Last 7 days');
        panelPeriodRow.set_model(periodModel);
        panelPeriodRow.set_selected(settings.get_string('panel-period') === 'week' ? 1 : 0);
        panelPeriodRow.connect('notify::selected', () => {
            settings.set_string('panel-period', panelPeriodRow.get_selected() === 1 ? 'week' : 'today');
        });
        panelGroup.add(panelPeriodRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show icon',
            subtitle: 'Display a symbolic clock icon next to the usage summary.',
        });
        settings.bind('show-icon', showIconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showIconRow);

        const goalsGroup = new Adw.PreferencesGroup({
            title: 'Goals',
            description: 'Progress bars compare tracked usage to these local targets.',
        });
        page.add(goalsGroup);

        const dailyGoalRow = new Adw.SpinRow({
            title: 'Daily goal',
            subtitle: 'Minutes of active GNOME usage to target each day.',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 1440,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_int('daily-goal-minutes'),
            }),
        });
        settings.bind('daily-goal-minutes', dailyGoalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        goalsGroup.add(dailyGoalRow);

        const weeklyGoalRow = new Adw.SpinRow({
            title: 'Weekly goal',
            subtitle: 'Minutes of active GNOME usage to target across the last 7 days.',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 10080,
                step_increment: 60,
                page_increment: 240,
                value: settings.get_int('weekly-goal-minutes'),
            }),
        });
        settings.bind('weekly-goal-minutes', weeklyGoalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        goalsGroup.add(weeklyGoalRow);

        const notesGroup = new Adw.PreferencesGroup({
            title: 'How tracking works',
        });
        page.add(notesGroup);

        const notes = new Gtk.Label({
            label: 'The extension stores daily totals locally and counts time only while the GNOME session is available. Idle time is paused using the GNOME session presence service, so totals are approximate and improve with shorter refresh intervals.',
            wrap: true,
            xalign: 0,
            justify: Gtk.Justification.LEFT,
            css_classes: ['dim-label'],
        });
        notesGroup.add(notes);
    }

    _modeIndex(mode) {
        if (mode === 'bar')
            return 1;
        if (mode === 'both')
            return 2;
        return 0;
    }
}
