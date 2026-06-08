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

// Helper to get a single row with Promises
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function createTables() {
  db.serialize(async () => {
    // 0. Companies Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        secret_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER DEFAULT 0
      )
    `);

    // 0b. Company Invites Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS company_invites (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id),
        code TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        used INTEGER DEFAULT 0
      )
    `);

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
        api_token TEXT UNIQUE DEFAULT NULL,
        role TEXT DEFAULT 'user',
        is_active INTEGER DEFAULT 1,
        company_id TEXT DEFAULT NULL,
        sync_token TEXT DEFAULT NULL,
        device_mode TEXT DEFAULT 'shared',
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
      const hasApiToken = columns.some(col => col.name === 'api_token');
      if (!hasApiToken) {
        db.run("ALTER TABLE users ADD COLUMN api_token TEXT DEFAULT NULL", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding api_token column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added api_token column.');
            db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token ON users (api_token)", (err) => {
              if (err) {
                console.error('Failed to create unique index on api_token:', err.message);
              } else {
                console.log('Successfully created unique index on api_token.');
              }
            });
          }
        });
      }
      const hasRole = columns.some(col => col.name === 'role');
      if (!hasRole) {
        db.run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding role column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added role column.');
          }
        });
      }
      const hasIsActive = columns.some(col => col.name === 'is_active');
      if (!hasIsActive) {
        db.run("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding is_active column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added is_active column.');
          }
        });
      }
      const hasCompanyId = columns.some(col => col.name === 'company_id');
      if (!hasCompanyId) {
        db.run("ALTER TABLE users ADD COLUMN company_id TEXT DEFAULT NULL", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding company_id column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added company_id column.');
          }
        });
      }
      const hasSyncToken = columns.some(col => col.name === 'sync_token');
      if (!hasSyncToken) {
        db.run("ALTER TABLE users ADD COLUMN sync_token TEXT DEFAULT NULL", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding sync_token column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added sync_token column.');
          }
        });
      }
      const hasDeviceMode = columns.some(col => col.name === 'device_mode');
      if (!hasDeviceMode) {
        db.run("ALTER TABLE users ADD COLUMN device_mode TEXT DEFAULT 'shared'", (err) => {
          if (err) {
            console.error('Failed to migrate: error adding device_mode column to users:', err.message);
          } else {
            console.log('Successfully migrated users table: added device_mode column.');
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

function generateCode(prefix) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let parts = [];
  for (let p = 0; p < 2; p++) {
    let part = '';
    for (let i = 0; i < 4; i++) {
      part += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    parts.push(part);
  }
  return `${prefix}-${parts.join('-')}`;
}

function generateUniqueCode(prefix, table, column) {
  return new Promise(async (resolve, reject) => {
    let code;
    let attempts = 0;
    while (attempts < 10) {
      code = generateCode(prefix);
      try {
        const row = await dbGet(`SELECT 1 FROM ${table} WHERE ${column} = ?`, [code]);
        if (!row) {
          return resolve(code);
        }
      } catch (err) {
        return reject(err);
      }
      attempts++;
    }
    reject(new Error('Failed to generate a unique code after 10 attempts'));
  });
}

// Company Management Endpoints
app.post('/api/companies/create', async (req, res) => {
  const { name, key } = req.body;
  if (!name || !key) {
    return res.status(400).json({ error: 'Company name and admin key are required' });
  }
  const companyId = crypto.randomUUID();
  try {
    const code = await generateUniqueCode('COM', 'companies', 'code');
    const now = new Date().toISOString();
    
    await dbRun(`
      INSERT INTO companies (id, name, code, secret_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [companyId, name, code, key, now, now]);

    res.json({ company_id: companyId, code, secret_key: key });
  } catch (error) {
    console.error('Create company error:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

app.post('/api/companies/invite', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Company admin key is required' });
  }
  const secretKey = authHeader.substring(7).trim();
  const { role } = req.body; // 'user' or 'admin'
  const targetRole = role === 'admin' ? 'admin' : 'user';

  try {
    const company = await dbGet('SELECT * FROM companies WHERE secret_key = ? AND deleted = 0', [secretKey]);
    if (!company) {
      return res.status(401).json({ error: 'Unauthorized: Invalid company key' });
    }

    const inviteId = crypto.randomUUID();
    const code = await generateUniqueCode('INV', 'company_invites', 'code');
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48h validity

    await dbRun(`
      INSERT INTO company_invites (id, company_id, code, role, created_at, expires_at, used)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [inviteId, company.id, code, targetRole, now, expiresAt]);

    res.json({ code });
  } catch (error) {
    console.error('Create invite error:', error);
    res.status(500).json({ error: 'Failed to create invite code' });
  }
});

app.post('/api/companies/join', async (req, res) => {
  const { invite_code, user_id } = req.body;
  if (!invite_code || !user_id) {
    return res.status(400).json({ error: 'Invite code and user ID are required' });
  }

  try {
    const invite = await dbGet(`
      SELECT * FROM company_invites 
      WHERE code = ? AND used = 0 AND (expires_at IS NULL OR expires_at > ?)
    `, [invite_code, new Date().toISOString()]);

    if (!invite) {
      return res.status(400).json({ error: 'Invalid or expired invite code' });
    }

    await dbRun('UPDATE company_invites SET used = 1 WHERE id = ?', [invite.id]);

    const syncToken = crypto.randomBytes(32).toString('hex');
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [user_id]);
    
    const now = new Date().toISOString();
    if (user) {
      await dbRun(`
        UPDATE users 
        SET company_id = ?, sync_token = ?, role = ?, updated_at = ?
        WHERE id = ?
      `, [invite.company_id, syncToken, invite.role, now, user_id]);
    } else {
      await dbRun(`
        INSERT INTO users (id, name, pin, weekly_hours, daily_soll, company_id, sync_token, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [user_id, 'Joining User', '0000', 0, '{}', invite.company_id, syncToken, invite.role, now, now]);
    }

    res.json({
      company_id: invite.company_id,
      sync_token: syncToken,
      role: invite.role
    });
  } catch (error) {
    console.error('Join company error:', error);
    res.status(500).json({ error: 'Failed to join company' });
  }
});

// REST Sync Endpoint (Multi-Tenant & Standalone)
app.post('/api/sync', async (req, res) => {
  const { 
    company_code, company_key, 
    user_id, sync_token, 
    lastSyncTime, 
    changes 
  } = req.body;
  const serverTime = new Date().toISOString();

  let mode = null;
  let activeCompanyId = null;
  let activeUserId = null;

  try {
    if (company_code && company_key) {
      const company = await dbGet('SELECT * FROM companies WHERE code = ? AND secret_key = ? AND deleted = 0', [company_code, company_key]);
      if (!company) {
        return res.status(401).json({ error: 'Unauthorized: Invalid company credentials' });
      }
      mode = 'company';
      activeCompanyId = company.id;
    } else if (user_id && sync_token) {
      let user = await dbGet('SELECT * FROM users WHERE id = ?', [user_id]);
      if (user) {
        if (user.sync_token !== sync_token) {
          return res.status(401).json({ error: 'Unauthorized: Invalid sync token' });
        }
        activeCompanyId = user.company_id;
      } else {
        activeCompanyId = null;
      }
      mode = 'personal';
      activeUserId = user_id;
    } else {
      return res.status(400).json({ error: 'Authentication credentials are required (either company_code/company_key or user_id/sync_token)' });
    }

    if (changes) {
      // 1. Sync Users
      if (changes.users && changes.users.length > 0) {
        for (const user of changes.users) {
          if (mode === 'personal' && user.id !== activeUserId) {
            continue;
          }

          const existingUser = await dbGet('SELECT company_id, sync_token FROM users WHERE id = ?', [user.id]);
          
          let targetCompanyId = activeCompanyId;
          let targetSyncToken = sync_token;

          if (existingUser) {
            targetCompanyId = existingUser.company_id;
            targetSyncToken = existingUser.sync_token;
          } else if (mode === 'personal') {
            targetCompanyId = null;
            targetSyncToken = sync_token;
          }

          await dbRun(`
            INSERT INTO users (
              id, name, pin, weekly_hours, daily_soll, language, 
              overtime_start_date, overtime_start_hours, holiday_country, 
              theme_color, break_profile, break_custom_rules, holiday_sync_active, 
              activities, api_token, role, is_active, company_id, sync_token, device_mode, 
              created_at, updated_at, deleted
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              api_token = excluded.api_token,
              role = excluded.role,
              is_active = excluded.is_active,
              company_id = excluded.company_id,
              sync_token = excluded.sync_token,
              device_mode = excluded.device_mode,
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
            user.api_token || null,
            user.role || 'user',
            user.is_active !== undefined ? (user.is_active ? 1 : 0) : 1,
            targetCompanyId,
            targetSyncToken,
            user.device_mode || 'shared',
            user.created_at,
            user.updated_at,
            user.deleted ? 1 : 0
          ]);
        }
      }

      // Build Set of allowed user IDs for safety
      const allowedUserIds = new Set();
      if (mode === 'company') {
        const companyUsers = await dbAll('SELECT id FROM users WHERE company_id = ?', [activeCompanyId]);
        companyUsers.forEach(u => allowedUserIds.add(u.id));
        if (changes.users) {
          changes.users.forEach(u => allowedUserIds.add(u.id));
        }
      } else {
        allowedUserIds.add(activeUserId);
      }

      // 2. Sync Punches
      if (changes.punches && changes.punches.length > 0) {
        for (const punch of changes.punches) {
          if (!allowedUserIds.has(punch.user_id)) continue;
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
          if (!allowedUserIds.has(off.user_id)) continue;
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
          if (!allowedUserIds.has(log.user_id)) continue;
          await dbRun(`
            INSERT OR IGNORE INTO audit_logs (id, user_id, action, table_name, record_id, old_data, new_data, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [log.id, log.user_id, log.action, log.table_name, log.record_id, JSON.stringify(log.old_data), JSON.stringify(log.new_data), log.timestamp]);
        }
      }
    }

    const syncCutoff = lastSyncTime || new Date(0).toISOString();

    let updatedUsers, updatedPunches, updatedTimeOff, newAuditLogs;

    if (mode === 'company') {
      updatedUsers = await dbAll(`SELECT * FROM users WHERE company_id = ? AND updated_at > ?`, [activeCompanyId, syncCutoff]);
      updatedPunches = await dbAll(`
        SELECT p.* FROM punches p
        JOIN users u ON p.user_id = u.id
        WHERE u.company_id = ? AND p.updated_at > ?
      `, [activeCompanyId, syncCutoff]);
      updatedTimeOff = await dbAll(`
        SELECT t.* FROM time_off t
        JOIN users u ON t.user_id = u.id
        WHERE u.company_id = ? AND t.updated_at > ?
      `, [activeCompanyId, syncCutoff]);
      newAuditLogs = await dbAll(`
        SELECT a.* FROM audit_logs a
        JOIN users u ON a.user_id = u.id
        WHERE u.company_id = ? AND a.timestamp > ?
      `, [activeCompanyId, syncCutoff]);
    } else {
      updatedUsers = await dbAll(`SELECT * FROM users WHERE id = ? AND updated_at > ?`, [activeUserId, syncCutoff]);
      updatedPunches = await dbAll(`SELECT * FROM punches WHERE user_id = ? AND updated_at > ?`, [activeUserId, syncCutoff]);
      updatedTimeOff = await dbAll(`SELECT * FROM time_off WHERE user_id = ? AND updated_at > ?`, [activeUserId, syncCutoff]);
      newAuditLogs = await dbAll(`SELECT * FROM audit_logs WHERE user_id = ? AND timestamp > ?`, [activeUserId, syncCutoff]);
    }

    const responseUsers = updatedUsers.map(u => ({
      ...u,
      daily_soll: JSON.parse(u.daily_soll),
      break_custom_rules: u.break_custom_rules ? JSON.parse(u.break_custom_rules) : [],
      holiday_sync_active: !!u.holiday_sync_active,
      activities: u.activities ? JSON.parse(u.activities) : [],
      is_active: u.is_active !== undefined ? !!u.is_active : true,
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

// REST API Token Authentication Middleware
async function authenticateApiToken(req, res, next) {
  let token = req.query.token;
  const authHeader = req.headers['authorization'];
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: API token is required' });
  }
  
  try {
    const user = await dbGet('SELECT * FROM users WHERE api_token = ? AND deleted = 0', [token]);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API token' });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error('API token auth error:', error);
    return res.status(500).json({ error: 'Internal Server Error during authentication' });
  }
}

// REST API endpoints (v1)
app.get('/api/v1/me', authenticateApiToken, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    name: u.name,
    weekly_hours: u.weekly_hours,
    daily_soll: u.daily_soll ? JSON.parse(u.daily_soll) : {},
    language: u.language,
    overtime_start_date: u.overtime_start_date,
    overtime_start_hours: u.overtime_start_hours,
    holiday_country: u.holiday_country,
    theme_color: u.theme_color,
    break_profile: u.break_profile,
    break_custom_rules: u.break_custom_rules ? JSON.parse(u.break_custom_rules) : [],
    holiday_sync_active: !!u.holiday_sync_active,
    activities: u.activities ? JSON.parse(u.activities) : [],
    role: u.role || 'user',
    is_active: u.is_active !== undefined ? !!u.is_active : true,
    created_at: u.created_at,
    updated_at: u.updated_at
  });
});

app.get('/api/v1/punches', authenticateApiToken, async (req, res) => {
  const userId = req.user.id;
  const fromDate = req.query.from; // YYYY-MM-DD
  const toDate = req.query.to;     // YYYY-MM-DD
  
  let sql = 'SELECT * FROM punches WHERE user_id = ? AND deleted = 0';
  const params = [userId];
  
  if (fromDate) {
    sql += ' AND start_time >= ?';
    params.push(fromDate);
  }
  if (toDate) {
    sql += ' AND start_time <= ?';
    params.push(toDate + 'T23:59:59.999Z');
  }
  
  sql += ' ORDER BY start_time ASC';
  
  try {
    const punches = await dbAll(sql, params);
    const formatted = punches.map(p => ({
      id: p.id,
      start_time: p.start_time,
      end_time: p.end_time,
      manual_edit: !!p.manual_edit,
      activity: p.activity,
      created_at: p.created_at,
      updated_at: p.updated_at
    }));
    
    res.json({
      user_id: userId,
      from: fromDate || null,
      to: toDate || null,
      punches: formatted
    });
  } catch (error) {
    console.error('API punches fetch error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/v1/time-off', authenticateApiToken, async (req, res) => {
  const userId = req.user.id;
  const fromDate = req.query.from; // YYYY-MM-DD
  const toDate = req.query.to;     // YYYY-MM-DD
  
  let sql = 'SELECT * FROM time_off WHERE user_id = ? AND deleted = 0';
  const params = [userId];
  
  if (fromDate) {
    sql += ' AND date >= ?';
    params.push(fromDate);
  }
  if (toDate) {
    sql += ' AND date <= ?';
    params.push(toDate);
  }
  
  sql += ' ORDER BY date ASC';
  
  try {
    const timeOff = await dbAll(sql, params);
    const formatted = timeOff.map(o => ({
      id: o.id,
      date: o.date,
      type: o.type,
      created_at: o.created_at,
      updated_at: o.updated_at
    }));
    
    res.json({
      user_id: userId,
      from: fromDate || null,
      to: toDate || null,
      time_off: formatted
    });
  } catch (error) {
    console.error('API time-off fetch error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/v1/audit-logs', authenticateApiToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const logs = await dbAll('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY timestamp DESC', [userId]);
    const formatted = logs.map(l => ({
      id: l.id,
      action: l.action,
      table_name: l.table_name,
      record_id: l.record_id,
      old_data: l.old_data ? JSON.parse(l.old_data) : null,
      new_data: l.new_data ? JSON.parse(l.new_data) : null,
      timestamp: l.timestamp
    }));
    
    res.json({
      user_id: userId,
      audit_logs: formatted
    });
  } catch (error) {
    console.error('API audit-logs fetch error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
