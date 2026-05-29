let currentLanguage = 'de';

export const SUPPORTED_LANGUAGES = ['de', 'en'];

const translations = {
  de: {
    // Lock Screen
    'lock-select-profile': 'Bitte wähle dein Profil',
    'lock-btn-new-user': '+ Neuer Benutzer',
    'lock-btn-connection': 'Verbindung',
    'lock-pin-error': 'Falscher PIN! Bitte erneut versuchen.',
    'lock-pin-btn-clear': 'C',
    'lock-pin-btn-ok': 'OK',

    // Main App Header
    'header-employee': 'Mitarbeiter',
    'header-btn-lock': 'Bildschirm sperren',
    'header-btn-theme': 'Design wechseln',

    // Tab Punch
    'punch-status-stopped': 'Nicht eingestempelt',
    'punch-status-working': 'Arbeitszeit läuft',
    'punch-status-onbreak': 'In der Pause',
    'punch-subtitle': 'Heutige Arbeitszeit',
    'punch-btn-in': 'Einstempeln',
    'punch-btn-out': 'Ausstempeln',
    'punch-btn-break-start': 'Pause starten',
    'punch-btn-break-end': 'Pause beenden',
    'punch-stat-soll': 'Soll Heute',
    'punch-stat-ist': 'Ist Heute (Netto)',
    'punch-stat-pause': 'Pause Heute',
    'punch-stat-saldo': 'Tagessaldo',
    'punch-alert-break-deductions-title': 'Gesetzlicher Pausenabzug (AT):',
    'punch-alert-break-deductions-text': 'Da du heute über 6 Stunden gearbeitet hast, wurden automatisch 30 Minuten Pause abgezogen.',

    // Tab History
    'history-title': 'Arbeitszeiten-Protokoll',
    'history-btn-add-punch': '+ Zeit eintragen',
    'history-btn-add-timeoff': '+ Freier Tag',
    'history-btn-export-csv': 'CSV Export',
    'history-filter-period': 'Zeitraum',
    'history-period-all': 'Gesamt',
    'history-period-week': 'Aktuelle Woche',
    'history-period-month': 'Aktueller Monat',
    'history-period-last-month': 'Letzter Monat',
    'history-period-custom': 'Benutzerdefiniert...',
    'history-filter-custom-range': 'Zeitraum von - bis',
    'history-filter-custom-to': 'bis',
    'history-filter-type': 'Typ',
    'history-type-all': 'Alle Typen',
    'history-type-work': 'Nur Arbeit',
    'history-type-vacation': 'Urlaub',
    'history-type-sick': 'Krankenstand',
    'history-type-holiday': 'Feiertag',
    'history-type-compensation': 'Zeitausgleich',
    'history-filter-manual-only': 'Nur manuelle Korrekturen',
    'history-th-date': 'Datum',
    'history-th-type': 'Typ',
    'history-th-worktime': 'Arbeitszeit (Kommen - Gehen)',
    'history-th-actual': 'Ist (Netto)',
    'history-th-break': 'Pause (gest./ges.)',
    'history-th-target': 'Soll',
    'history-th-status': 'Status',
    'history-th-actions': 'Aktionen',
    'history-empty': 'Keine Einträge für die gewählten Filter gefunden.',
    'history-total-filtered': 'Gesamt (gefiltert)',
    'history-action-delete': 'Löschen',
    'history-action-edit': 'Bearbeiten',
    'history-active-punch': 'Aktiv...',
    'history-view-list': 'Tabelle',
    'history-view-calendar': 'Kalender',
    'calendar-details-title': 'Details für {date}',
    'calendar-details-empty': 'Keine Einträge für diesen Tag.',
    'calendar-details-punches': 'Arbeitszeit',
    'calendar-details-absence': 'Abwesenheit',
    'calendar-details-ist': 'Ist: {time}',
    'calendar-details-soll': 'Soll: {time}',
    'calendar-details-break': 'Pause: {time}',
    'calendar-action-add-punch': '+ Zeit eintragen',
    'calendar-action-add-absence': '+ Freier Tag',

    // Tab Reports
    'reports-title': 'Auswertung & Berichte',
    'reports-period-week': 'Aktuelle Woche',
    'reports-period-month': 'Aktueller Monat',
    'reports-period-last-month': 'Letzter Monat',
    'reports-period-all': 'Gesamt',
    'reports-stat-target': 'Soll-Arbeitszeit',
    'reports-stat-actual': 'Ist-Arbeitszeit (Netto)',
    'reports-stat-balance': 'Zeitsaldo',
    'reports-stat-free': 'Urlaub & Freie Tage',
    'reports-free-days': '{count} Tag{suffix}',
    'reports-free-days-breakdown': 'Urlaub: {vacation} | Krank: {sick} | Feiertag: {holiday} | ZA: {compensation}',
    'reports-audit-title': 'Änderungshistorie (Audit Log)',
    'reports-audit-empty': 'Keine Änderungen protokolliert.',
    'reports-audit-insert': 'Zeit manuell hinzugefügt für {id}',
    'reports-audit-update': 'Eintrag bearbeitet.',
    'reports-audit-delete': 'Eintrag gelöscht ({tableName}).',
    'reports-audit-action': '(Aktion: <strong>{action}</strong>)',

    // Tab Settings
    'settings-profile-title': 'Profil-Einstellungen',
    'settings-label-name': 'Name',
    'settings-label-pin': '4-stellige PIN',
    'settings-placeholder-pin': 'Unverändert lassen...',
    'settings-target-hours': 'Individuelle Soll-Stunden pro Wochentag',
    'settings-btn-save': 'Einstellungen speichern',
    'settings-sync-title': 'Synchronisation (Cloud / SQLite)',
    'settings-sync-status': 'Status: <strong>{status}</strong>',
    'settings-sync-status-label': 'Status:',
    'settings-sync-status-disconnected': 'Nicht verbunden',
    'settings-sync-status-connected': 'Verbunden',
    'settings-sync-status-syncing': 'Synchronisierung läuft...',
    'settings-sync-last': 'Letzter Abgleich: <span>{time}</span>',
    'settings-sync-last-label': 'Letzter Abgleich:',
    'settings-sync-never': 'Nie',
    'settings-sync-label-server': 'Server URL',
    'settings-sync-btn-now': 'Jetzt abgleichen',
    'settings-sync-btn-csv': 'Als CSV exportieren',
    'settings-sync-btn-backup': 'Backup (JSON) laden/speichern',
    'settings-label-language': 'Sprache',

    // Overtime Account
    'settings-overtime-title': 'Überstundenkonto',
    'settings-label-overtime-date': 'Startdatum (Berechnungsbasis)',
    'settings-label-overtime-hours': 'Start-Saldo (Stunden)',
    'punch-overtime-balance-title': 'Überstundenkonto',
    'punch-overtime-details': 'Start-Saldo am {date}: {startHours} | Seitdem: {accumulatedHours}',

    // Notifications
    'settings-notifications-title': 'Benachrichtigungen',
    'settings-label-notifications': 'Pausen-Erinnerungen per Push-Notification aktivieren',
    'notification-work-reminder-title': 'Zeit für eine Pause! ☕',
    'notification-work-reminder-body': 'Du arbeitest bereits seit 6 Stunden. Nimm dir bitte eine gesetzliche Pause von 30 Minuten.',
    'notification-break-reminder-title': 'Pause beenden 🕒',
    'notification-break-reminder-body': 'Deine 30-minütige Pause ist vorbei. Vergiss nicht wieder einzustempeln.',

    // Weekly Progress
    'punch-weekly-progress-title': 'Wochenfortschritt',
    'punch-weekly-progress-subtitle': '{actual} / {target} Std. – {percent}%',

    // Holiday Import
    'settings-holiday-title': 'Feiertags-Import',
    'settings-label-holiday-country': 'Land',
    'settings-holiday-none': 'Kein automatischer Import',
    'settings-btn-import-holidays': 'Feiertage laden',
    'alert-holidays-imported': 'Erfolgreich {count} Feiertage für {year} importiert!',
    'alert-holidays-failed': 'Feiertags-Import fehlgeschlagen: {error}',
    'alert-select-country': 'Bitte wähle zuerst ein Land aus.',

    // Nav Bar
    'nav-punch': 'Stempel',
    'nav-times': 'Zeiten',
    'nav-reports': 'Berichte',
    'nav-options': 'Optionen',

    // Create User Modal
    'create-title': 'Neuen Benutzer erstellen',
    'create-label-name': 'Name',
    'create-label-pin': '4-stellige PIN',
    'create-placeholder-pin': 'z. B. 1234',
    'create-target-hours': 'Wochenstunden (Soll)',
    'create-btn-cancel': 'Abbrechen',
    'create-btn-submit': 'Erstellen',

    // Edit/Add Punch Dialog
    'manual-title-add': 'Arbeitszeit eintragen',
    'manual-title-edit': 'Arbeitszeit bearbeiten',
    'manual-label-date': 'Datum',
    'manual-label-in': 'Kommen (Beginn)',
    'manual-label-out': 'Gehen (Ende)',
    'manual-label-break': 'Gestempelte Pause (in Minuten)',
    'manual-edit-individual': 'Einzelne Stempelungen bearbeiten',
    'manual-btn-add-punch': '+ Stempelung hinzufügen',
    'manual-btn-cancel': 'Abbrechen',
    'manual-btn-delete': 'Eintrag löschen',
    'manual-btn-save': 'Speichern',

    // Time Off Dialog
    'timeoff-title': 'Freien Tag / Fehlzeit eintragen',
    'timeoff-label-date': 'Datum',
    'timeoff-label-type': 'Art der Abwesenheit',
    'timeoff-type-vacation': 'Urlaubstag',
    'timeoff-type-sick': 'Krankheitsfall (Krankstand)',
    'timeoff-type-holiday': 'Feiertag',
    'timeoff-type-compensation': 'Zeitausgleich',
    'timeoff-btn-cancel': 'Abbrechen',
    'timeoff-btn-save': 'Speichern',

    // Backup Dialog
    'backup-title': 'Backup verwalten',
    'backup-desc': 'Hier kannst du alle lokalen Daten als Backup sichern oder wiederherstellen.',
    'backup-label-json': 'Backup-Daten (JSON)',
    'backup-placeholder': 'Backup-JSON hier einfügen...',
    'backup-btn-close': 'Schließen',
    'backup-btn-import': 'Importieren',
    'backup-btn-copy': 'Kopieren & Download',

    // Server Settings Dialog (Lock Screen)
    'server-title': 'Server-Verbindung',
    'server-desc': 'Konfiguriere den Server, um Profile und Arbeitszeiten zu synchronisieren.',
    'server-label-url': 'Server-URL',
    'server-btn-cancel': 'Abbrechen',
    'server-btn-save': 'Speichern & Abgleichen',

    // JavaScript Alerts / Confirms
    'alert-login-failed': 'Fehler bei der Anmeldung: {message}',
    'alert-invalid-punch-times': 'Ungültige Stempelung: Die Endzeit ({endVal}) muss nach der Startzeit ({startVal}) liegen.',
    'alert-active-punch-must-be-last': 'Eine Stempelung ohne Endzeit (aktiv) kann nur die letzte Stempelung des Tages sein.',
    'alert-previous-punch-active': 'Die vorherige Stempelung ist noch aktiv und hat keine Endzeit. Ein neuer Zeitraum kann erst nach einer Endzeit starten.',
    'alert-overlapping-punches': 'Überlappende Arbeitszeiten: Die Stempelung von {startVal} bis {endVal} überlappt mit der vorherigen Stempelung (endet um {prevEndVal}).',
    'alert-max-one-active': 'Es kann maximal eine aktive Stempelung (ohne Endzeit) geben.',
    'alert-time-conversion-error': 'Fehler beim Konvertieren der Zeiten. Bitte prüfe deine Eingaben.',
    'alert-settings-saved': 'Einstellungen gespeichert!',
    'alert-valid-url-required': 'Bitte gib eine gültige Server-URL ein.',
    'alert-connection-success': 'Verbindung erfolgreich! {count} Änderungen synchronisiert.',
    'alert-connection-failed': 'Fehler beim Verbinden: {message}',
    'alert-sync-success': 'Synchronisation erfolgreich! {count} Änderungen importiert.',
    'alert-sync-failed': 'Fehler beim Synchronisieren: {message}',
    'alert-backup-import-confirm': 'Achtung: Dies importiert alle Daten. Möchtest du fortfahren?',
    'alert-backup-import-success': 'Backup erfolgreich importiert!',
    'alert-backup-import-failed': 'Fehler beim Import: {message}',
    'alert-backup-copied': 'Backup in Zwischenablage kopiert!',
    'alert-db-start-error': 'Datenbankfehler beim Starten: {message}',
    'alert-confirm-delete-absence': 'Möchtest du diese Abwesenheit löschen?',
    'alert-confirm-delete-all-punches': 'Du hast alle Stempelungen entfernt. Möchtest du die Arbeitszeiten für diesen Tag löschen?',
    'alert-confirm-delete-day': 'Möchtest du die Arbeitszeiten für diesen Tag wirklich löschen?',

    // General Words
    'type-work': 'Arbeit',
    'type-vacation': 'Urlaub',
    'type-sick': 'Krank',
    'type-holiday': 'Feiertag',
    'type-compensation': 'Zeitausgleich',
    
    // Weekdays
    'weekday-mon': 'Mo',
    'weekday-tue': 'Di',
    'weekday-wed': 'Mi',
    'weekday-thu': 'Do',
    'weekday-fri': 'Fr',
    'weekday-sat': 'Sa',
    'weekday-sun': 'So',
    
    'weekday-mon-long': 'Montag',
    'weekday-tue-long': 'Dienstag',
    'weekday-wed-long': 'Mittwoch',
    'weekday-thu-long': 'Donnerstag',
    'weekday-fri-long': 'Freitag',
    'weekday-sat-long': 'Samstag',
    'weekday-sun-long': 'Sonntag',
  },
  en: {
    // Lock Screen
    'lock-select-profile': 'Please select your profile',
    'lock-btn-new-user': '+ New User',
    'lock-btn-connection': 'Connection',
    'lock-pin-error': 'Wrong PIN! Please try again.',
    'lock-pin-btn-clear': 'C',
    'lock-pin-btn-ok': 'OK',

    // Main App Header
    'header-employee': 'Employee',
    'header-btn-lock': 'Lock screen',
    'header-btn-theme': 'Toggle design',

    // Tab Punch
    'punch-status-stopped': 'Not punched in',
    'punch-status-working': 'Working',
    'punch-status-onbreak': 'On break',
    'punch-subtitle': 'Work time today',
    'punch-btn-in': 'Punch In',
    'punch-btn-out': 'Punch Out',
    'punch-btn-break-start': 'Start Break',
    'punch-btn-break-end': 'End Break',
    'punch-stat-soll': 'Target Today',
    'punch-stat-ist': 'Actual Today (Net)',
    'punch-stat-pause': 'Break Today',
    'punch-stat-saldo': 'Daily Balance',
    'punch-alert-break-deductions-title': 'Statutory break deduction (AT):',
    'punch-alert-break-deductions-text': 'Since you worked over 6 hours today, 30 minutes of break were automatically deducted.',

    // Tab History
    'history-title': 'Work Time Log',
    'history-btn-add-punch': '+ Enter Time',
    'history-btn-add-timeoff': '+ Time Off',
    'history-btn-export-csv': 'CSV Export',
    'history-filter-period': 'Period',
    'history-period-all': 'All Time',
    'history-period-week': 'Current Week',
    'history-period-month': 'Current Month',
    'history-period-last-month': 'Last Month',
    'history-period-custom': 'Custom...',
    'history-filter-custom-range': 'Period from - to',
    'history-filter-custom-to': 'to',
    'history-filter-type': 'Type',
    'history-type-all': 'All Types',
    'history-type-work': 'Only Work',
    'history-type-vacation': 'Vacation',
    'history-type-sick': 'Sick Leave',
    'history-type-holiday': 'Holiday',
    'history-type-compensation': 'Comp Time',
    'history-filter-manual-only': 'Only manual corrections',
    'history-th-date': 'Date',
    'history-th-type': 'Type',
    'history-th-worktime': 'Work Time (In - Out)',
    'history-th-actual': 'Actual (Net)',
    'history-th-break': 'Break (pnch./tot.)',
    'history-th-target': 'Target',
    'history-th-status': 'Status',
    'history-th-actions': 'Actions',
    'history-empty': 'No entries found for the selected filters.',
    'history-total-filtered': 'Total (filtered)',
    'history-action-delete': 'Delete',
    'history-action-edit': 'Edit',
    'history-active-punch': 'Active...',
    'history-view-list': 'Table',
    'history-view-calendar': 'Calendar',
    'calendar-details-title': 'Details for {date}',
    'calendar-details-empty': 'No entries for this day.',
    'calendar-details-punches': 'Work Time',
    'calendar-details-absence': 'Absence',
    'calendar-details-ist': 'Actual: {time}',
    'calendar-details-soll': 'Target: {time}',
    'calendar-details-break': 'Break: {time}',
    'calendar-action-add-punch': '+ Enter Time',
    'calendar-action-add-absence': '+ Day Off',

    // Tab Reports
    'reports-title': 'Evaluation & Reports',
    'reports-period-week': 'Current Week',
    'reports-period-month': 'Current Month',
    'reports-period-last-month': 'Last Month',
    'reports-period-all': 'All Time',
    'reports-stat-target': 'Target Work Time',
    'reports-stat-actual': 'Actual Work Time (Net)',
    'reports-stat-balance': 'Time Balance',
    'reports-stat-free': 'Vacation & Time Off',
    'reports-free-days': '{count} Day{suffix}',
    'reports-free-days-breakdown': 'Vacation: {vacation} | Sick: {sick} | Holiday: {holiday} | Comp: {compensation}',
    'reports-audit-title': 'Change History (Audit Log)',
    'reports-audit-empty': 'No changes logged.',
    'reports-audit-insert': 'Time manually added for {id}',
    'reports-audit-update': 'Entry edited.',
    'reports-audit-delete': 'Entry deleted ({tableName}).',
    'reports-audit-action': '(Action: <strong>{action}</strong>)',

    // Tab Settings
    'settings-profile-title': 'Profile Settings',
    'settings-label-name': 'Name',
    'settings-label-pin': '4-digit PIN',
    'settings-placeholder-pin': 'Leave unchanged...',
    'settings-target-hours': 'Individual target hours per weekday',
    'settings-btn-save': 'Save Settings',
    'settings-sync-title': 'Synchronization (Cloud / SQLite)',
    'settings-sync-status': 'Status: <strong>{status}</strong>',
    'settings-sync-status-label': 'Status:',
    'settings-sync-status-disconnected': 'Not connected',
    'settings-sync-status-connected': 'Connected',
    'settings-sync-status-syncing': 'Syncing...',
    'settings-sync-last': 'Last sync: <span>{time}</span>',
    'settings-sync-last-label': 'Last sync:',
    'settings-sync-never': 'Never',
    'settings-sync-label-server': 'Server URL',
    'settings-sync-btn-now': 'Sync Now',
    'settings-sync-btn-csv': 'Export as CSV',
    'settings-sync-btn-backup': 'Load/Save Backup (JSON)',
    'settings-label-language': 'Language',

    // Overtime Account
    'settings-overtime-title': 'Overtime Account',
    'settings-label-overtime-date': 'Start Date (Calculation Base)',
    'settings-label-overtime-hours': 'Start Balance (Hours)',
    'punch-overtime-balance-title': 'Overtime Account',
    'punch-overtime-details': 'Start balance on {date}: {startHours} | Since then: {accumulatedHours}',

    // Notifications
    'settings-notifications-title': 'Notifications',
    'settings-label-notifications': 'Enable break reminders via push notifications',
    'notification-work-reminder-title': 'Time for a break! ☕',
    'notification-work-reminder-body': 'You have been working for 6 hours. Please take a statutory 30-minute break.',
    'notification-break-reminder-title': 'Break complete 🕒',
    'notification-break-reminder-body': 'Your 30-minute break is complete. Don\'t forget to punch back in.',

    // Weekly Progress
    'punch-weekly-progress-title': 'Weekly Progress',
    'punch-weekly-progress-subtitle': '{actual} / {target} hrs – {percent}%',

    // Holiday Import
    'settings-holiday-title': 'Holiday Import',
    'settings-label-holiday-country': 'Country',
    'settings-holiday-none': 'No automatic import',
    'settings-btn-import-holidays': 'Load Holidays',
    'alert-holidays-imported': 'Successfully imported {count} holidays for {year}!',
    'alert-holidays-failed': 'Holiday import failed: {error}',
    'alert-select-country': 'Please select a country first.',

    // Nav Bar
    'nav-punch': 'Punch',
    'nav-times': 'Times',
    'nav-reports': 'Reports',
    'nav-options': 'Options',

    // Create User Modal
    'create-title': 'Create New User',
    'create-label-name': 'Name',
    'create-label-pin': '4-digit PIN',
    'create-placeholder-pin': 'e.g. 1234',
    'create-target-hours': 'Weekly Hours (Target)',
    'create-btn-cancel': 'Cancel',
    'create-btn-submit': 'Create',

    // Edit/Add Punch Dialog
    'manual-title-add': 'Enter Work Time',
    'manual-title-edit': 'Edit Work Time',
    'manual-label-date': 'Date',
    'manual-label-in': 'In (Start)',
    'manual-label-out': 'Out (End)',
    'manual-label-break': 'Punched Break (in minutes)',
    'manual-edit-individual': 'Edit individual punches',
    'manual-btn-add-punch': '+ Add Punch',
    'manual-btn-cancel': 'Cancel',
    'manual-btn-delete': 'Delete entry',
    'manual-btn-save': 'Save',

    // Time Off Dialog
    'timeoff-title': 'Enter Day Off / Absence',
    'timeoff-label-date': 'Date',
    'timeoff-label-type': 'Type of Absence',
    'timeoff-type-vacation': 'Vacation',
    'timeoff-type-sick': 'Sick Leave',
    'timeoff-type-holiday': 'Public Holiday',
    'timeoff-type-compensation': 'Compensation Time',
    'timeoff-btn-cancel': 'Cancel',
    'timeoff-btn-save': 'Save',

    // Backup Dialog
    'backup-title': 'Manage Backup',
    'backup-desc': 'Here you can back up or restore all local data.',
    'backup-label-json': 'Backup Data (JSON)',
    'backup-placeholder': 'Paste backup JSON here...',
    'backup-btn-close': 'Close',
    'backup-btn-import': 'Import',
    'backup-btn-copy': 'Copy & Download',

    // Server Settings Dialog (Lock Screen)
    'server-title': 'Server Connection',
    'server-desc': 'Configure the server to sync profiles and work times.',
    'server-label-url': 'Server URL',
    'server-btn-cancel': 'Cancel',
    'server-btn-save': 'Save & Sync',

    // JavaScript Alerts / Confirms
    'alert-login-failed': 'Login error: {message}',
    'alert-invalid-punch-times': 'Invalid punch: End time ({endVal}) must be after start time ({startVal}).',
    'alert-active-punch-must-be-last': 'A punch without an end time (active) can only be the last punch of the day.',
    'alert-previous-punch-active': 'The previous punch is still active and has no end time. A new period can only start after an end time.',
    'alert-overlapping-punches': 'Overlapping work times: The punch from {startVal} to {endVal} overlaps with the previous punch (ends at {prevEndVal}).',
    'alert-max-one-active': 'There can be at most one active punch (without end time).',
    'alert-time-conversion-error': 'Error converting times. Please check your inputs.',
    'alert-settings-saved': 'Settings saved!',
    'alert-valid-url-required': 'Please enter a valid server URL.',
    'alert-connection-success': 'Connection successful! {count} changes synchronized.',
    'alert-connection-failed': 'Connection failed: {message}',
    'alert-sync-success': 'Synchronization successful! {count} changes imported.',
    'alert-sync-failed': 'Sync failed: {message}',
    'alert-backup-import-confirm': 'Warning: This will import all data. Do you want to proceed?',
    'alert-backup-import-success': 'Backup successfully imported!',
    'alert-backup-import-failed': 'Import error: {message}',
    'alert-backup-copied': 'Backup copied to clipboard!',
    'alert-db-start-error': 'Database error on startup: {message}',
    'alert-confirm-delete-absence': 'Do you want to delete this absence?',
    'alert-confirm-delete-all-punches': 'You removed all punches. Do you want to delete the work times for this day?',
    'alert-confirm-delete-day': 'Do you really want to delete the work times for this day?',

    // General Words
    'type-work': 'Work',
    'type-vacation': 'Vacation',
    'type-sick': 'Sick Leave',
    'type-holiday': 'Holiday',
    'type-compensation': 'Comp Time',

    // Weekdays
    'weekday-mon': 'Mon',
    'weekday-tue': 'Tue',
    'weekday-wed': 'Wed',
    'weekday-thu': 'Thu',
    'weekday-fri': 'Fri',
    'weekday-sat': 'Sat',
    'weekday-sun': 'Sun',
    
    'weekday-mon-long': 'Monday',
    'weekday-tue-long': 'Tuesday',
    'weekday-wed-long': 'Wednesday',
    'weekday-thu-long': 'Thursday',
    'weekday-fri-long': 'Friday',
    'weekday-sat-long': 'Saturday',
    'weekday-sun-long': 'Sunday',
  }
};

export function getLanguage() {
  return currentLanguage;
}

export function setLanguage(lang) {
  if (SUPPORTED_LANGUAGES.includes(lang)) {
    currentLanguage = lang;
    document.documentElement.lang = lang;
  }
}

export function t(key, params = {}) {
  const dict = translations[currentLanguage] || translations['de'];
  let val = dict[key] || key;
  for (const [k, v] of Object.entries(params)) {
    val = val.replace(new RegExp(`{${k}}`, 'g'), v);
  }
  return val;
}

export function translateDOM(root = document) {
  // Translate text content
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  // Translate placeholders
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', t(key));
  });

  // Translate titles (tooltips)
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.setAttribute('title', t(key));
  });
}
