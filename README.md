# Stempelo (PWA Arbeitszeiterfassung)

Eine moderne, offline-fähige Progressive Web App (PWA) zur Arbeitszeiterfassung mit Multi-User-Support, flexiblem Wochentag-Soll, österreichischer Pausenregelung und SQLite-Synchronisation.

---

## 🛠 Architektur & Struktur

Die Anwendung ist bewusst leichtgewichtig ohne schwere Frameworks (wie React oder Vue) gebaut und setzt auf moderne Webstandards:

```
├── assets/
│   └── icon.png            # 512x512 App-Symbol (PWA)
├── index.html              # App-Layout und Dialog-Fenster (Modals)
├── index.css               # Premium-Styling (Glassmorphism, Dark- & Light-Mode)
├── app.js                  # Haupt-Logik, IndexedDB-Schnittstelle & Timer
├── syncService.js          # Client-Synchronisationsdienst
├── sw.js                   # Service Worker für Offline-Verfügbarkeit
├── manifest.json           # PWA-Manifest zur App-Installation
├── temporal-polyfill.js    # Lokaler Polyfill für exakte Zeitberechnungen
├── server.js               # Node.js/Express-Server (Sync-Backend)
└── package.json            # Node.js Projektabhängigkeiten
```

- **Frontend (Offline-First)**: Alle Daten werden lokal in der Browser-Datenbank **IndexedDB** gespeichert. Der **Service Worker** sorgt dafür, dass die App auch ohne Internetverbindung im Browser geladen und voll genutzt werden kann.
- **Backend (Zentraler Sync)**: Ein kompakter **Express-Server** nimmt lokale Änderungen entgegen und sichert sie in einer **SQLite-Datenbank** (`data.sqlite`).

---

## ✨ Features

- 👥 **Mehrbenutzerfähig & PIN-Schutz**: Einfacher Benutzerwechsel mit lokaler PIN-Prüfung (SHA-256 gehasht).
- 🕒 **Individuelle Soll-Stunden**: Für jeden Wochentag (Mo-So) können individuelle Soll-Stunden definiert werden.
- 🇦🇹 **Österreichischer Pausenabzug (AZG § 11)**: Arbeitet ein Nutzer mehr als 6 Stunden, zieht die App automatisch die Differenz zur gesetzlichen 30-Minuten-Mindestpause ab, falls diese nicht manuell gestempelt wurde.
- 📝 **Audit-Log**: Alle manuellen Nachträge, Bearbeitungen oder Löschungen erzeugen ein Revisionsprotokoll zur Nachvollziehbarkeit. Gelöschte Einträge werden per *Soft-Delete* (`deleted = 1`) markiert.
- 🔄 **Zentraler Sync (Manuell & Automatisch)**: Datenabgleich zwischen IndexedDB (Client) und SQLite (Server). Der Abgleich läuft vollautomatisch und geräuschlos im Hintergrund (beim App-Start, nach jeder Benutzeraktion wie Stempeln/Bearbeiten, bei Wiedererlangung der Internetverbindung sowie periodisch alle 5 Minuten) oder kann manuell per Knopfdruck angestoßen werden.
- 💾 **Backup & Export**: Lokaler Datenexport als CSV oder vollständiger JSON-Backup (Laden/Speichern) direkt in den Optionen.

---

## 🚀 Installation & Inbetriebnahme

### Voraussetzungen
Stelle sicher, dass **Node.js** auf deinem System installiert ist.

### 1. Abhängigkeiten installieren
Öffne das Terminal im Projektordner und installiere die benötigten Pakete:
```bash
npm install
```

### 2. Server starten
Starte den Node.js Express-Server:
```bash
node server.js
```
Der Server läuft standardmäßig auf Port `8054`. Die SQLite-Datenbankdatei `data.sqlite` wird beim ersten Start automatisch erzeugt und eingerichtet.

### 3. App im Browser aufrufen
Öffne deinen Webbrowser und rufe folgende Adresse auf:
- [http://localhost:8054](http://localhost:8054)

*Tipp*: Im Browser kannst du die App über das Plus-Symbol in der Adressleiste direkt als App auf deinem Betriebssystem (Desktop/Mobil) installieren.

### 4. Synchronisation einrichten
Gehe in der App auf **Optionen** (Zahnrad-Symbol) und trage unter **Synchronisation** die Server-URL ein (z. B. `http://localhost:8054`). Klicke danach auf **Jetzt abgleichen**.
