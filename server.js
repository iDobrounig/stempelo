const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8055;
const DB_PATH = path.join(__dirname, 'data.sqlite');

app.use(cors());
app.use(express.json());

// Serve static frontend files (will be created in the current directory)
app.use(express.static(__dirname));

// Initialize Database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    createTables();
    scheduleDailyBackup();
  }
});

// Helper to run SQL with Promises
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper to get all rows with Promises
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function createTables() {
  db.serialize(async () => {
    // 1. Users Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pin TEXT NOT NULL,
        weekly_hours REAL NOT NULL,
        daily_soll TEXT NOT NULL, -- JSON String
        language TEXT DEFAULT 'de',
        overtime_start_date TEXT,
        overtime_start_hours REAL DEFAULT 0.0,
        holiday_country TEXT,
        theme_color TEXT DEFAULT 'cyan',
        break_profile TEXT DEFAULT 'austria',
        break_custom_rules TEXT DEFAULT '[]',
        holiday_sync_active INTEGER DEFAULT 0,
        activities TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER DEFAULT 0
      )
    `);

    // Check if migration is needed for existing database
    db.all("PRAGMA table_info(users)", (err, columns) => {
      if (err) {
        console.error('Error checking table info for users:', err.message);
        return;
      }
      const hasLanguage = columns.some(col => col.name === 'language');
      if (!hasLanguage) {
        db.run("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'de'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding language column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added language column.');
          }
        });
      }
      const hasOvertimeStartDate = columns.some(col => col.name === 'overtime_start_date');
      if (!hasOvertimeStartDate) {
        db.run("ALTER TABLE users ADD COLUMN overtime_start_date TEXT", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding overtime_start_date column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added overtime_start_date column.');
          }
        });
      }
      const hasOvertimeStartHours = columns.some(col => col.name === 'overtime_start_hours');
      if (!hasOvertimeStartHours) {
        db.run("ALTER TABLE users ADD COLUMN overtime_start_hours REAL DEFAULT 0.0", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding overtime_start_hours column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added overtime_start_hours column.');
          }
        });
      }
      const hasHolidayCountry = columns.some(col => col.name === 'holiday_country');
      if (!hasHolidayCountry) {
        db.run("ALTER TABLE users ADD COLUMN holiday_country TEXT", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding holiday_country column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added holiday_country column.');
          }
        });
      }
      const hasThemeColor = columns.some(col => col.name === 'theme_color');
      if (!hasThemeColor) {
        db.run("ALTER TABLE users ADD COLUMN theme_color TEXT DEFAULT 'cyan'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding theme_color column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added theme_color column.');
          }
        });
      }
      const hasBreakProfile = columns.some(col => col.name === 'break_profile');
      if (!hasBreakProfile) {
        db.run("ALTER TABLE users ADD COLUMN break_profile TEXT DEFAULT 'austria'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding break_profile column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added break_profile column.');
          }
        });
      }
      const hasBreakCustomRules = columns.some(col => col.name === 'break_custom_rules');
      if (!hasBreakCustomRules) {
        db.run("ALTER TABLE users ADD COLUMN break_custom_rules TEXT DEFAULT '[]'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding break_custom_rules column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added break_custom_rules column.');
          }
        });
      }
      const hasHolidaySyncActive = columns.some(col => col.name === 'holiday_sync_active');
      if (!hasHolidaySyncActive) {
        db.run("ALTER TABLE users ADD COLUMN holiday_sync_active INTEGER DEFAULT 0", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding holiday_sync_active column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added holiday_sync_active column.');
          }
        });
      }
      const hasActivities = columns.some(col => col.name === 'activities');
      if (!hasActivities) {
        db.run("ALTER TABLE users ADD COLUMN activities TEXT DEFAULT '[]'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding activities column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added activities column.');
          }
        });
      }
    });

    // 2. Punches Table (Work sessions)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS punches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        manual_edit INTEGER DEFAULT 0,
        activity TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER DEFAULT 0
      )
    `);

    // Check if migration is needed for punches table
    db.all("PRAGMA table_info(punches)", (err, columns) => {
      if (err) {
        console.error('Error checking table info for punches:', err.message);
        return;
      }
      const hasActivity = columns.some(col => col.name === 'activity');
      if (!hasActivity) {
        db.run("ALTER TABLE punches ADD COLUMN activity TEXT", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding activity column to punches:', err.message);
          } else {
            console.log('Successfully migrated punches table: added activity column.');
          }
        });
      }
    });

    // 3. Time Off Table (Vacation, sickness, etc.)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS time_off (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL, -- YYYY-MM-DD
        type TEXT NOT NULL, -- 'vacation', 'holiday', 'sick', 'compensation'
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER DEFAULT 0
      )
    `);

    // 4. Audit Logs Table (Append-only)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL, -- 'insert', 'update', 'delete'
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        old_data TEXT, -- JSON String
        new_data TEXT, -- JSON String
        timestamp TEXT NOT NULL
      )
    `);

    console.log('Database tables initialized successfully.');
  });
}

// REST Sync Endpoint
app.post('/api/sync', async (req, res) => {
  const { lastSyncTime, changes } = req.body;
  const serverTime = new Date().toISOString();

  try {
    // Perform synchronization within a database transaction if possible, or sequentially
    if (changes) {
      // 1. Sync Users
      if (changes.users && changes.users.length > 0) {
        for (const user of changes.users) {
          await dbRun(`
            INSERT INTO users (id, name, pin, weekly_hours, daily_soll, language, overtime_start_date, overtime_start_hours, holiday_country, theme_color, break_profile, break_custom_rules, holiday_sync_active, activities, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              pin = excluded.pin,
              weekly_hours = excluded.weekly_hours,
              daily_soll = excluded.daily_soll,
              language = excluded.language,
              overtime_start_date = excluded.overtime_start_date,
              overtime_start_hours = excluded.overtime_start_hours,
              holiday_country = excluded.holiday_country,
              theme_color = excluded.theme_color,
              break_profile = excluded.break_profile,
              break_custom_rules = excluded.break_custom_rules,
              holiday_sync_active = excluded.holiday_sync_active,
              activities = excluded.activities,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              deleted = excluded.deleted
            WHERE excluded.updated_at > users.updated_at
          `, [
            user.id,
            user.name,
            user.pin,
            user.weekly_hours,
            JSON.stringify(user.daily_soll),
            user.language || 'de',
            user.overtime_start_date || null,
            user.overtime_start_hours !== undefined ? user.overtime_start_hours : 0.0,
            user.holiday_country || null,
            user.theme_color || 'cyan',
            user.break_profile || 'austria',
            user.break_custom_rules ? (typeof user.break_custom_rules === 'string' ? user.break_custom_rules : JSON.stringify(user.break_custom_rules)) : '[]',
            user.holiday_sync_active ? 1 : 0,
            user.activities ? (typeof user.activities === 'string' ? user.activities : JSON.stringify(user.activities)) : '[]',
            user.created_at,
            user.updated_at,
            user.deleted ? 1 : 0
          ]);
        }
      }

      // 2. Sync Punches
      if (changes.punches && changes.punches.length > 0) {
        for (const punch of changes.punches) {
          await dbRun(`
            INSERT INTO punches (id, user_id, start_time, end_time, manual_edit, activity, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              start_time = excluded.start_time,
              end_time = excluded.end_time,
              manual_edit = excluded.manual_edit,
              activity = excluded.activity,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              deleted = excluded.deleted
            WHERE excluded.updated_at > punches.updated_at
          `, [punch.id, punch.user_id, punch.start_time, punch.end_time, punch.manual_edit ? 1 : 0, punch.activity || null, punch.created_at, punch.updated_at, punch.deleted ? 1 : 0]);
        }
      }

      // 3. Sync Time Off
      if (changes.time_off && changes.time_off.length > 0) {
        for (const off of changes.time_off) {
          await dbRun(`
            INSERT INTO time_off (id, user_id, date, type, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              user_id = excluded.user_id,
              date = excluded.date,
              type = excluded.type,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              deleted = excluded.deleted
            WHERE excluded.updated_at > time_off.updated_at
          `, [off.id, off.user_id, off.date, off.type, off.created_at, off.updated_at, off.deleted ? 1 : 0]);
        }
      }

      // 4. Sync Audit Logs
      if (changes.audit_logs && changes.audit_logs.length > 0) {
        for (const log of changes.audit_logs) {
          await dbRun(`
            INSERT OR IGNORE INTO audit_logs (id, user_id, action, table_name, record_id, old_data, new_data, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [log.id, log.user_id, log.action, log.table_name, log.record_id, JSON.stringify(log.old_data), JSON.stringify(log.new_data), log.timestamp]);
        }
      }
    }

    // Retrieve all server updates since lastSyncTime
    const syncCutoff = lastSyncTime || new Date(0).toISOString();

    const updatedUsers = await dbAll(`SELECT * FROM users WHERE updated_at > ?`, [syncCutoff]);
    const updatedPunches = await dbAll(`SELECT * FROM punches WHERE updated_at > ?`, [syncCutoff]);
    const updatedTimeOff = await dbAll(`SELECT * FROM time_off WHERE updated_at > ?`, [syncCutoff]);
    const newAuditLogs = await dbAll(`SELECT * FROM audit_logs WHERE timestamp > ?`, [syncCutoff]);

    // Parse JSON columns back to objects
    const responseUsers = updatedUsers.map(u => ({
      ...u,
      daily_soll: JSON.parse(u.daily_soll),
      break_custom_rules: u.break_custom_rules ? JSON.parse(u.break_custom_rules) : [],
      holiday_sync_active: !!u.holiday_sync_active,
      activities: u.activities ? JSON.parse(u.activities) : [],
      deleted: !!u.deleted
    }));

    const responsePunches = updatedPunches.map(p => ({
      ...p,
      manual_edit: !!p.manual_edit,
      deleted: !!p.deleted
    }));

    const responseTimeOff = updatedTimeOff.map(o => ({
      ...o,
      deleted: !!o.deleted
    }));

    const responseAuditLogs = newAuditLogs.map(l => ({
      ...l,
      old_data: l.old_data ? JSON.parse(l.old_data) : null,
      new_data: l.new_data ? JSON.parse(l.new_data) : null
    }));

    res.json({
      serverTime,
      updates: {
        users: responseUsers,
        punches: responsePunches,
        time_off: responseTimeOff,
        audit_logs: responseAuditLogs
      }
    });

  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Internal Server Error during synchronization' });
  }
});

const BACKUP_DIR = path.join(__dirname, 'backups');

function scheduleDailyBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const runBackup = async () => {
    try {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
      const backupFile = path.join(BACKUP_DIR, `backup_${dateStr}.sqlite`);

      if (fs.existsSync(backupFile)) {
        return;
      }

      console.log(`Starting automated daily SQLite backup: backup_${dateStr}.sqlite`);
      
      const escapedPath = backupFile.replace(/'/g, "''");
      await dbRun(`VACUUM INTO '${escapedPath}'`);
      
      console.log(`Backup successfully completed: backup_${dateStr}.sqlite`);

      const files = fs.readdirSync(BACKUP_DIR);
      const backupFiles = files
        .filter(file => file.startsWith('backup_') && file.endsWith('.sqlite'))
        .map(file => ({
          name: file,
          path: path.join(BACKUP_DIR, file),
          time: fs.statSync(path.join(BACKUP_DIR, file)).mtime.getTime()
        }))
        .sort((a, b) => a.time - b.time);

      if (backupFiles.length > 7) {
        const toDelete = backupFiles.slice(0, backupFiles.length - 7);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          console.log(`Pruned old backup file: ${file.name}`);
        }
      }
    } catch (error) {
      console.error('Error during automated daily backup:', error);
    }
  };

  // Run on startup
  runBackup();

  // Run check hourly
  setInterval(runBackup, 60 * 60 * 1000);
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
