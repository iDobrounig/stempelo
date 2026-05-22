# Stempelo (PWA Work Time Tracking)

A modern, offline-capable Progressive Web App (PWA) for tracking work hours, featuring multi-user support, flexible daily targets (Soll), Austrian break compliance rules, and SQLite synchronization.

---

## 🛠 Architecture & Structure

The application is designed to be lightweight, utilizing modern web standards without heavy frameworks (like React or Vue):

```
├── assets/
│   └── icon.png            # 512x512 App Icon (PWA)
├── index.html              # App layout and dialog modals
├── index.css               # Premium styling (glassmorphism, dark & light mode)
├── app.js                  # Core application logic, IndexedDB adapter & timer
├── syncService.js          # Client synchronization service
├── sw.js                   # Service Worker for offline asset caching
├── manifest.json           # PWA manifest for app installation
├── temporal-polyfill.js    # Local polyfill for precise datetime arithmetic
├── server.js               # Node.js/Express server (sync backend)
└── package.json            # Node.js project dependencies
```

- **Frontend (Offline-First)**: All tracking data is stored locally in the browser database **IndexedDB**. The **Service Worker** caches all assets so that the app loads and works seamlessly even without an active internet connection.
- **Backend (Centralized Sync)**: A compact **Express server** receives local changes and persists them in a central **SQLite database** (`data.sqlite`).

---

## ✨ Features

- 👥 **Multi-User Capable & PIN Protection**: Switch users quickly with local PIN verification (SHA-256 hashed).
- 🕒 **Custom Daily Targets**: Define custom target hours (Soll) individually for each day of the week (Mon-Sun).
- 🇦🇹 **Austrian Break Compliance (AZG § 11)**: If a user works more than 6 hours, the app automatically deducts the difference to reach the legally required 30-minute minimum break if it wasn't already logged manually.
- 📝 **Audit Log**: Every manual entry, edit, or deletion generates a revision log for traceability. Deleted records are marked via *soft-delete* (`deleted = 1`).
- 🔄 **Central Sync (Manual & Automatic)**: Data synchronization between IndexedDB (client) and SQLite (server). The sync runs automatically and silently in the background (upon app launch, after user actions like punching or editing, when network connectivity is restored, and periodically every 5 minutes) or can be triggered manually.
- 💾 **Backup & Export**: Local data export as CSV or full JSON backup (import/export) directly from the settings tab.

---

## 🚀 Getting Started

### Prerequisites
Make sure you have **Node.js** installed on your system.

### 1. Install Dependencies
Open your terminal in the project directory and run:
```bash
npm install
```

### 2. Start the Server
Launch the Node.js Express server:
```bash
npm start
```
The server runs on port `8055` by default. The SQLite database file `data.sqlite` will be automatically created and initialized on the first startup.

### 3. Open the App in the Browser
Open your web browser and go to:
- [http://localhost:8055](http://localhost:8055)

*Tip*: You can install Stempelo directly on your operating system (desktop/mobile) as a standalone app using the install icon in the browser's address bar.

### 4. Configure Synchronization
In the app, navigate to **Settings** (gear icon) and enter your server URL (e.g., `http://localhost:8055`) under **Synchronization**. Click **Sync Now** to perform the initial sync.
