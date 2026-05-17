const express = require('express');
const AUDIT_LOG = '/mnt/liftlog_data/liftlog/audit.log';
const jwt = require('jsonwebtoken'); // Add this
require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
function logAction(message) {
    const timestamp = new Date().toLocaleString(); // Local time is easier to read
    const entry = `[${timestamp}] ${message}\n`;
    fs.appendFile(AUDIT_LOG, entry, (err) => {
        if (err) console.error("Audit Log Write Error:", err);
    });
}

// ==================== 45-DAY ROLLING 1RM + BACKFILL ====================

const STATS_FILE = '/mnt/liftlog_data/liftlog/exercise_stats.json';
let exerciseStats = {};

try {
    if (fs.existsSync(STATS_FILE)) {
        exerciseStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
} catch (e) {}

// Exponential decay weighting: sets 14 days ago contribute half as much as today's
const HALF_LIFE_DAYS = 14;

function calculateEstimatedOneRM(exerciseName, userId = null) {
    return new Promise((resolve) => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 45);
        const cutoffDate = cutoff.toISOString().split('T')[0];

        const query = userId
            ? "SELECT exercises, date FROM workouts WHERE date >= ? AND user_id = ? ORDER BY date DESC"
            : "SELECT exercises, date FROM workouts WHERE date >= ? ORDER BY date DESC";
        const params = userId ? [cutoffDate, userId] : [cutoffDate];

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("1RM calculation error:", err);
                resolve();
                return;
            }

            const now = new Date();
            let weightedSum = 0;
            let decayTotal = 0;

            (rows || []).forEach(row => {
                try {
                    const daysAgo = (now - new Date(row.date)) / (1000 * 60 * 60 * 24);
                    const decay = Math.pow(0.5, daysAgo / HALF_LIFE_DAYS);
                    const exercises = JSON.parse(row.exercises || '[]');
                    const match = exercises.find(ex => ex.name === exerciseName);
                    if (match && match.sets) {
                        match.sets.forEach(set => {
                            const w = parseFloat(set.weight);
                            const r = parseInt(set.reps);
                            if (w && r > 0) {
                                weightedSum += w * (1 + r / 30) * decay;
                                decayTotal  += decay;
                            }
                        });
                    }
                } catch(e) {}
            });

            if (decayTotal > 0) {
                const estimated = Math.round(weightedSum / decayTotal);
                exerciseStats[exerciseName] = estimated;
                if (userId) {
                    const today = new Date().toISOString().split('T')[0];
                    db.run(
                        `INSERT OR REPLACE INTO exercise_1rm_history (user_id, exercise_name, date, estimated_1rm) VALUES (?, ?, ?, ?)`,
                        [userId, exerciseName, today, estimated]
                    );
                }
            }
            resolve();
        });
    });
}

// Update stats for a single workout (called after saving new workout)
function updateExerciseStatsForWorkout(workout, userId = null) {
    if (!workout || !workout.exercises) return;

    const exerciseNames = new Set(workout.exercises.map(ex => ex.name).filter(name => name));

    (async () => {
        for (const name of exerciseNames) {
            await calculateEstimatedOneRM(name, userId);
        }
        try {
            fs.writeFileSync(STATS_FILE, JSON.stringify(exerciseStats, null, 2));
        } catch (e) {
            console.error("Error writing stats file:", e);
        }
    })();
}

// Backfill on server start (populates with last 45 days)
function backfillExerciseStats() {
    console.log("🔄 Backfilling 45-day 1RM stats...");
    db.all("SELECT DISTINCT json_extract(value, '$.name') as name FROM workouts, json_each(exercises) WHERE date >= date('now', '-45 days')", [], async (err, rows) => {
        if (err) {
            console.error("Backfill query error:", err);
            return;
        }
        
        const uniqueExercises = [...new Set((rows || []).map(r => r.name).filter(name => name))];
        console.log(`Found ${uniqueExercises.length} unique exercises to backfill`);
        
        for (const name of uniqueExercises) {
            await calculateEstimatedOneRM(name);
        }
        
        try {
            fs.writeFileSync(STATS_FILE, JSON.stringify(exerciseStats, null, 2));
            console.log("✅ Backfill complete. Stats written to exercise_stats.json");
        } catch (e) {
            console.error("Error writing stats during backfill:", e);
        }
    });
}

// Run backfill once when server starts (with delay for db init)
setTimeout(() => backfillExerciseStats(), 1000);

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
app.use(helmet());
app.use(express.json({ limit: '200mb' }));
const port = 3000;

app.use(express.static('.')); // Serves your index.html and app.js

const cors = require('cors');
app.use(cors());

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const TEMPLATES_FILE = '/mnt/liftlog_data/liftlog/templates.json';

// Connect to the SQLite database on your T7 SSD
const db = new sqlite3.Database('/mnt/liftlog_data/liftlog/data/workouts.db');
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
// Database Migration: Phase 2 Schema Upgrade
db.serialize(() => {
    // 1. Create the main workouts table if it doesn't exist
    db.run(`CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        name TEXT,
        type TEXT DEFAULT 'strength',
        exercises TEXT,
        user_id INTEGER,
        distance REAL,
        duration INTEGER,
        pace TEXT,
        rpe INTEGER,
        notes TEXT,
        hr INTEGER,
        calories INTEGER,
        rir INTEGER,
        watchData TEXT
    )`);

    // 2. Add Cardio/Strength/WatchData columns (using try-catch style via SQL)
    const columns = [
        "ALTER TABLE workouts ADD COLUMN exercises TEXT",
        "ALTER TABLE workouts ADD COLUMN user_id INTEGER",
        "ALTER TABLE workouts ADD COLUMN distance REAL",
        "ALTER TABLE workouts ADD COLUMN duration INTEGER",
        "ALTER TABLE workouts ADD COLUMN pace TEXT",
        "ALTER TABLE workouts ADD COLUMN rpe INTEGER",
        "ALTER TABLE workouts ADD COLUMN notes TEXT",
        "ALTER TABLE workouts ADD COLUMN hr INTEGER",
        "ALTER TABLE workouts ADD COLUMN calories INTEGER",
        "ALTER TABLE workouts ADD COLUMN rir INTEGER",
        "ALTER TABLE workouts ADD COLUMN watchData TEXT"
    ];

    columns.forEach(query => {
        db.run(query, (err) => {
            if (!err) console.log(`Migration: Added column via [${query.split('ADD COLUMN ')[1]}]`);
        });
    });
});
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.sendStatus(401);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// ====================== GOOGLE OAUTH SETUP ======================

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "https://liftlognm.tailee3a44.ts.net/auth/google/callback",
    passReqToCallback: true
}, (req, accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;

    const userMap = { 'nvm113001@gmail.com': 75001 };
    const assignedUserId = userMap[email];

    // Known owner account — let straight through
    if (assignedUserId) {
        return done(null, { email, user_id: assignedUserId, name: profile.displayName });
    }

    // Check if this email has already redeemed an invite before (returning invited user)
    db.get(`SELECT user_id FROM invited_users WHERE email = ?`, [email], (err, row) => {
        if (row) {
            return done(null, { email, user_id: row.user_id, name: profile.displayName });
        }

        // Brand new email — require a valid invite token passed via OAuth state
        const inviteToken = req.query.state || '';
        if (!inviteToken) {
            return done(null, false, { message: 'Email not allowed' });
        }

        db.get(
            `SELECT * FROM invites WHERE token = ? AND current_uses < max_uses AND datetime('now') < expires_at`,
            [inviteToken],
            (err2, invite) => {
                if (err2 || !invite) {
                    return done(null, false, { message: 'Invalid or expired invite' });
                }

                // Valid invite — assign a deterministic user_id and persist
                const newUserId = 75100 + invite.id;
                db.run(
                    `INSERT OR IGNORE INTO invited_users (email, user_id, invite_token) VALUES (?, ?, ?)`,
                    [email, newUserId, inviteToken],
                    (err3) => {
                        if (err3) return done(err3);
                        db.run(
                            `UPDATE invites SET current_uses = current_uses + 1, redeemed_by = ? WHERE id = ?`,
                            [email, invite.id],
                            (err4) => {
                                if (err4) return done(err4);
                                logAction(`AUTH: New user registered via invite. Email: ${email}`);
                                return done(null, { email, user_id: newUserId, name: profile.displayName });
                            }
                        );
                    }
                );
            }
        );
    });
}));

// ====================== ROUTES ======================

// Create the templates table if it doesn't exist
// Note: the workouts table is created in the migration block above.
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        exercises TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE NOT NULL,
        max_uses INTEGER DEFAULT 1,
        current_uses INTEGER DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        redeemed_by TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS invited_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        user_id INTEGER UNIQUE NOT NULL,
        invite_token TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS strava_connections (
        user_id INTEGER PRIMARY KEY,
        strava_athlete_id TEXT,
        strava_athlete_name TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        connected_at TEXT DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS apple_health_tokens (
        user_id INTEGER PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_import_at TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS exercise_1rm_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        exercise_name TEXT NOT NULL,
        date TEXT NOT NULL,
        estimated_1rm REAL NOT NULL,
        UNIQUE(user_id, exercise_name, date)
    )`);
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.post('/login', loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === process.env.APP_PASSWORD) {
        // Generate a token that lasts for 30 days
        const token = jwt.sign({ user: 'noah' }, process.env.JWT_SECRET, { expiresIn: '2h' });
        logAction("AUTH: Successful login. Token issued.");
        res.json({ token });
    } else {
        logAction("AUTH: Failed login attempt.");
        res.status(401).send("Invalid Password");
    }
});

// ======================== GOOGLE OAUTH ROUTES ========================

// 1. The initial login route — forward invite code as OAuth state if present
app.get('/auth/google', (req, res, next) => {
    const opts = { scope: ['profile', 'email'], session: false };
    if (req.query.invite) opts.state = req.query.invite;
    passport.authenticate('google', opts)(req, res, next);
});

// 2. The callback route
app.get('/auth/google/callback',
    passport.authenticate('google', {
        failureRedirect: '/login.html?error=denied',
        session: false
    }),
    (req, res) => {
        const token = jwt.sign({
            user: req.user.email,
            user_id: req.user.user_id 
        }, process.env.JWT_SECRET, { expiresIn: '2h' });

        res.redirect(`/index.html?token=${token}&debug=success`);
    }
);

app.get('/exercise_stats', authenticateToken, (req, res) => {
    res.json(exerciseStats);
});

app.get('/api/progress/:exercise', authenticateToken, (req, res) => {
    db.all(
        `SELECT date, estimated_1rm FROM exercise_1rm_history WHERE user_id = ? AND exercise_name = ? ORDER BY date ASC`,
        [req.user.user_id, req.params.exercise],
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

 // This allows the iPad to talk to the API

// The bridge that receives data from your app and puts it in SQLite
// This version handles the full workout object from your app.js
app.post('/add-workout', authenticateToken, (req, res) => {
    const {
        date,
        name,
        exercises,
        type,
        distance,
        duration,
        pace,
        rpe,
        notes,
        hr,
        calories,
        rir,
        watchData
    } = req.body;

    const exercisesStr = JSON.stringify(Array.isArray(exercises) ? exercises : []);
    const watchDataStr = watchData ? JSON.stringify(watchData) : null;
    const userId = req.user.user_id;

    const query = `INSERT OR IGNORE INTO workouts (date, name, exercises, type, distance, duration, pace, rpe, notes, hr, calories, rir, watchData, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.run(query, [date, name, exercisesStr, type || 'strength', distance || 0, duration || 0, pace || '', rpe || null, notes || '', hr || null, calories || null, rir || null, watchDataStr, userId], function(err) {
        if (err) {
            console.error("Database Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.json({ message: "Duplicate workout skipped", skipped: true });
        }
        updateExerciseStatsForWorkout({ exercises: JSON.parse(exercisesStr) }, userId);
        res.json({ message: "Saved to SSD", id: this.lastID, skipped: false });
    });
});

// FIXED: Only returns the logged-in user's workouts
app.get('/api/workouts', authenticateToken, (req, res) => {
    const userId = req.user.user_id;

    db.all("SELECT * FROM workouts WHERE user_id = ? ORDER BY date DESC", [userId], (err, rows) => {
        if (err) {
            console.error("Database error:", err.message);
            return res.status(500).json({ error: "Database error" });
        }
        
        const formatted = rows.map(row => {
            let watchData = row.watchData;
            if (typeof watchData === 'string' && watchData) {
                try {
                    watchData = JSON.parse(watchData);
                } catch (e) {
                    console.warn("Failed to parse watchData for:", row.date, e);
                    watchData = null;
                }
            }
            return {
                ...row,
                exercises: JSON.parse(row.exercises || '[]'),
                watchData
            };
        });
        
        res.json(formatted);
    });
});

// FIXED: Only return templates for the logged-in user (from templates.json)
// FIXED: Only return templates for the logged-in user
app.get('/api/templates', authenticateToken, (req, res) => {
    const TEMPLATES_FILE = '/mnt/liftlog_data/liftlog/templates.json';
    const userId = req.user.user_id;

    if (fs.existsSync(TEMPLATES_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
            const userTemplates = data.filter(t => t.user_id === userId);
            res.json(userTemplates);
        } catch (e) {
            console.error("Error reading templates.json:", e);
            res.json([]);
        }
    } else {
        res.json([]);
    }
});

// FIXED: Save templates in a user-safe way
app.post('/save-templates', authenticateToken, (req, res) => {
    const templates = req.body; // Array of templates
    const userId = req.user.user_id;

    try {
        const TEMPLATES_FILE = '/mnt/liftlog_data/liftlog/templates.json';
        let existing = [];
        if (fs.existsSync(TEMPLATES_FILE)) {
            existing = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')) || [];
        }

        // Remove current user's templates and replace them with the incoming ones
        const otherUsers = existing.filter(t => t.user_id !== userId);
        const templatesWithUser = templates.map(t => ({ ...t, user_id: userId }));

        fs.writeFileSync(TEMPLATES_FILE, JSON.stringify([...otherUsers, ...templatesWithUser], null, 2));
        res.sendStatus(200);
    } catch (e) {
        console.error("Error saving templates.json:", e);
        res.status(500).json({ error: "Failed to save templates" });
    }
});



// GET current 1RM stats for the frontend
app.get('/exercise_stats', (req, res) => {
    res.json(exerciseStats);
});

const HISTORY_FILE = '/mnt/liftlog_data/liftlog/history.json';

app.post('/save-workout', authenticateToken, (req, res) => {
    const workoutData = req.body;
    
    // 1. Read existing history
    fs.readFile(HISTORY_FILE, (err, data) => {
        let history = [];
        if (!err && data.length > 0) history = JSON.parse(data);

        // 2. Add the new workout
        history.push(workoutData);

        // 3. Save back to SSD
        fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), (writeErr) => {
            if (writeErr) {
                logAction("ERROR: Could not save workout history.");
                return res.status(500).send("Error saving workout");
            }
            logAction(`SUCCESS: Saved workout: ${workoutData.name}`);
            updateExerciseStatsForWorkout(workoutData);
            res.sendStatus(200);
        });
    });
});





app.get('/workouts', authenticateToken, (req, res) => {
    db.all("SELECT * FROM workouts ORDER BY date DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// server.js on the Raspberry Pi

app.delete('/api/workouts', authenticateToken, (req, res) => {
    const { date, name } = req.query;
    
    // This SQL command actually removes the row from the T7 SSD
    const sql = "DELETE FROM workouts WHERE date = ? AND name = ?";
    
    db.run(sql, [date, name], function(err) {
        if (err) {
            console.error(err.message);
            res.status(500).send("Database error");
        } else {
            console.log(`Deleted workout: ${name} on ${date}`);
            res.status(200).send("Deleted successfully");
        }
    });
});

// ... (Your routes and app.delete here)

// ... existing code (rename-workout, delete, etc.)

// ====================== STRAVA PER-USER OAUTH ======================

// Returns a valid access token for userId, refreshing if expired
async function getStravaToken(userId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM strava_connections WHERE user_id = ?`, [userId], async (err, conn) => {
            if (err || !conn) return reject(new Error('No Strava connection'));
            if (Date.now() / 1000 > conn.expires_at - 300) {
                try {
                    const r = await axios.post('https://www.strava.com/oauth/token', {
                        client_id: process.env.STRAVA_CLIENT_ID,
                        client_secret: process.env.STRAVA_CLIENT_SECRET,
                        refresh_token: conn.refresh_token,
                        grant_type: 'refresh_token'
                    });
                    const { access_token, refresh_token, expires_at } = r.data;
                    db.run(`UPDATE strava_connections SET access_token=?, refresh_token=?, expires_at=? WHERE user_id=?`,
                        [access_token, refresh_token, expires_at, userId]);
                    resolve(access_token);
                } catch (e) { reject(e); }
            } else {
                resolve(conn.access_token);
            }
        });
    });
}

// Returns the Strava OAuth URL so the frontend can redirect the browser there
app.get('/api/strava/connect', authenticateToken, (req, res) => {
    const token = req.headers['authorization'].split(' ')[1];
    const callbackUrl = process.env.STRAVA_OAUTH_CALLBACK_URL || 'https://liftlognm.tailee3a44.ts.net/api/strava/callback';
    const url = new URL('https://www.strava.com/oauth/authorize');
    url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', 'activity:read_all,read,profile:read_all');
    url.searchParams.set('state', token);
    res.json({ url: url.toString() });
});

// Strava redirects here after user approves
app.get('/api/strava/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) return res.redirect('/index.html?strava=denied');

    let userId;
    try {
        const payload = jwt.verify(state, process.env.JWT_SECRET);
        userId = payload.user_id;
        if (!userId) throw new Error('No user_id');
    } catch (e) {
        return res.redirect('/login.html?error=denied');
    }

    try {
        const callbackUrl = process.env.STRAVA_OAUTH_CALLBACK_URL || 'https://liftlognm.tailee3a44.ts.net/api/strava/callback';
        const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            redirect_uri: callbackUrl,
            code,
            grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, expires_at, athlete } = tokenRes.data;
        const athleteName = `${athlete.firstname} ${athlete.lastname}`.trim();

        db.run(
            `INSERT OR REPLACE INTO strava_connections (user_id, strava_athlete_id, strava_athlete_name, access_token, refresh_token, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, String(athlete.id), athleteName, access_token, refresh_token, expires_at],
            (err) => {
                if (err) { console.error('Strava save error:', err); return res.redirect('/index.html?strava=error'); }
                logAction(`STRAVA: User ${userId} connected as ${athleteName} (athlete ${athlete.id})`);
                res.redirect('/index.html?strava=connected');
            }
        );
    } catch (e) {
        console.error('Strava callback error:', e.response?.data || e.message);
        res.redirect('/index.html?strava=error');
    }
});

// Returns connection status for the logged-in user
app.get('/api/strava/status', authenticateToken, (req, res) => {
    db.get(`SELECT strava_athlete_name, strava_athlete_id FROM strava_connections WHERE user_id = ?`,
        [req.user.user_id], (err, row) => {
            res.json({ connected: !!row, name: row?.strava_athlete_name || null });
        }
    );
});

app.get('/api/strava/sync', authenticateToken, async (req, res) => {
    try {
        const runDb = (sql, params) => new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        let accessToken;
        try {
            accessToken = await getStravaToken(req.user.user_id);
        } catch (e) {
            // Fall back to owner env tokens for the owner account
            if (req.user.user_id !== 75001) {
                return res.status(400).json({ error: 'No Strava account connected. Please connect Strava in Settings.' });
            }
            const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                refresh_token: process.env.STRAVA_REFRESH_TOKEN,
                grant_type: 'refresh_token'
            });
            accessToken = tokenRes.data.access_token;
        }

        const activityRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        for (const act of activityRes.data) {
            const date = act.start_date_local.split('T')[0];
            const miles = Number((act.distance / 1609.34).toFixed(2));
            const mins = Math.floor(act.moving_time / 60);

            const hr = act.average_heartrate ? Math.round(act.average_heartrate) : null;
            const maxHr = act.max_heartrate ? Math.round(act.max_heartrate) : null;
            // Fallback to kilojoules if Strava API hides calories (often happens if no HR data)
            const cals = act.calories ? Math.round(act.calories) : (act.kilojoules ? Math.round(act.kilojoules) : null);
            const elevationFeet = act.total_elevation_gain ? Math.round(act.total_elevation_gain * 3.28084) : 0;

            let pace = null;
            if (miles > 0 && (act.type === 'Run' || act.type === 'Walk')) {
                const totalMinutes = act.moving_time / 60;
                const paceDec = totalMinutes / miles;
                const pMins = Math.floor(paceDec);
                const pSecs = Math.round((paceDec - pMins) * 60);
                pace = `${pMins}:${pSecs.toString().padStart(2, '0')} /mi`;
            }

            const cardioTypes = ['Run', 'Ride', 'Walk', 'Hike', 'VirtualRide', 'Swim'];
            const activityType = cardioTypes.includes(act.type) || miles > 0 ? 'cardio' : 'watch';
            const watchData = JSON.stringify({
                source: 'Strava',
                stravaId: act.id,
                name: act.name,
                type: act.type,
                sportType: act.sport_type || act.type,
                startTime: act.start_date_local,
                distance: miles,
                duration: mins,
                elapsedTime: Math.floor((act.elapsed_time || act.moving_time || 0) / 60),
                hr,
                maxHr,
                calories: cals,
                pace,
                elevation: elevationFeet,
                elevationHigh: act.elev_high ? Math.round(act.elev_high * 3.28084) : null,
                elevationLow: act.elev_low ? Math.round(act.elev_low * 3.28084) : null,
                averageSpeed: act.average_speed || null,
                maxSpeed: act.max_speed || null,
                averageCadence: act.average_cadence || null,
                averageWatts: act.average_watts || null,
                weightedAverageWatts: act.weighted_average_watts || null,
                kilojoules: act.kilojoules || null,
                sufferScore: act.suffer_score || null,
                achievementCount: act.achievement_count || 0,
                kudosCount: act.kudos_count || 0,
                trainer: Boolean(act.trainer),
                commute: Boolean(act.commute),
                manual: Boolean(act.manual),
                visibility: act.visibility || null,
                gearId: act.gear_id || null,
                raw: {
                    average_speed: act.average_speed || null,
                    max_speed: act.max_speed || null,
                    average_cadence: act.average_cadence || null,
                    average_watts: act.average_watts || null,
                    weighted_average_watts: act.weighted_average_watts || null,
                    kilojoules: act.kilojoules || null,
                    suffer_score: act.suffer_score || null,
                    achievement_count: act.achievement_count || 0,
                    kudos_count: act.kudos_count || 0,
                    elev_high: act.elev_high || null,
                    elev_low: act.elev_low || null,
                    trainer: act.trainer || false,
                    commute: act.commute || false,
                    manual: act.manual || false,
                    visibility: act.visibility || null
                }
            });

            const update = await runDb(
                `UPDATE workouts
                 SET type = ?, distance = ?, duration = ?, hr = ?, calories = ?, pace = ?, watchData = ?
                 WHERE date = ? AND name = ? AND user_id = ? AND (exercises IS NULL OR exercises = '[]')`,
                [activityType, miles, mins, hr, cals, pace, watchData, date, act.name, req.user.user_id]
            );

            if (update.changes === 0) {
                await runDb(
                    `INSERT INTO workouts (date, name, type, distance, duration, hr, calories, pace, exercises, watchData, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [date, act.name, activityType, miles, mins, hr, cals, pace, '[]', watchData, req.user.user_id]
                );
            }
        }

        res.json({ success: true });
    } catch (err) {
        // This will print the SPECIFIC reason Strava is mad
        console.error("❌ Strava Sync Error Details:", err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/rename-workout', authenticateToken, (req, res) => {
    const { date, oldName, newName } = req.body;
    const sql = "UPDATE workouts SET name = ? WHERE date = ? AND name = ?";
    
    db.run(sql, [newName, date, oldName], function(err) {
        if (err) {
            res.status(500).send(err.message);
        } else {
            res.status(200).send("Renamed successfully");
        }
    });
});

// ====================== APPLE HEALTH IMPORT ======================

const AH_CUTOFF = '2026-01-01';

const AH_ACTIVITY_MAP = {
    HKWorkoutActivityTypeTraditionalStrengthTraining:   { type: 'strength', name: 'Strength Training' },
    HKWorkoutActivityTypeFunctionalStrengthTraining:    { type: 'strength', name: 'Functional Strength' },
    HKWorkoutActivityTypeRunning:                       { type: 'cardio',   name: 'Run' },
    HKWorkoutActivityTypeCycling:                       { type: 'cardio',   name: 'Ride' },
    HKWorkoutActivityTypeWalking:                       { type: 'cardio',   name: 'Walk' },
    HKWorkoutActivityTypeHiking:                        { type: 'cardio',   name: 'Hike' },
    HKWorkoutActivityTypeSwimming:                      { type: 'cardio',   name: 'Swim' },
    HKWorkoutActivityTypeRowingMachine:                 { type: 'cardio',   name: 'Row' },
    HKWorkoutActivityTypeElliptical:                    { type: 'cardio',   name: 'Elliptical' },
    HKWorkoutActivityTypeCrossTraining:                 { type: 'watch',    name: 'Cross Training' },
    HKWorkoutActivityTypeYoga:                          { type: 'watch',    name: 'Yoga' },
    HKWorkoutActivityTypePilates:                       { type: 'watch',    name: 'Pilates' },
    HKWorkoutActivityTypeMindAndBody:                   { type: 'watch',    name: 'Mindfulness' },
    HKWorkoutActivityTypeMixedCardio:                   { type: 'cardio',   name: 'Mixed Cardio' },
    HKWorkoutActivityTypeHighIntensityIntervalTraining: { type: 'cardio',   name: 'HIIT' },
    HKWorkoutActivityTypePlay:                          { type: 'watch',    name: 'Play' },
};

// Handles: raw number | "123.4 kcal" string | {qty: 123, units: "kcal"} object (HAE v3+)
function ahParseNum(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && 'qty' in val) return parseFloat(val.qty) || null;
    const n = parseFloat(String(val).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? null : n;
}

// workoutStatistics can be a keyed object (old HAE) or an array with {id, ...} (new HAE)
function ahGetStat(stats, id) {
    if (!stats) return {};
    if (Array.isArray(stats)) return stats.find(x => x.id === id || x.type === id) || {};
    return stats[id] || {};
}

// Try every known date field across all Health Auto Export versions
function ahParseStartDate(w) {
    const raw = w.start || w.startDate || w.date || w.creationDate || '';
    if (!raw) return null;
    // HAE uses "2026-05-15 06:22:08 -0500" — normalize to ISO 8601 before parsing
    const normalized = String(raw).trim()
        .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4')
        .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2');
    const d = new Date(normalized);
    if (!isNaN(d.getTime())) return d;
    const d2 = new Date(raw);
    return isNaN(d2.getTime()) ? null : d2;
}

function ahMapWorkout(w, skipDateFilter) {
    const startDate = ahParseStartDate(w);
    if (!startDate) {
        return { skipped: true, reason: 'no_parseable_date', raw: String(w.start || w.startDate || w.date || '(none)') };
    }

    const dateStr = startDate.toISOString().split('T')[0];
    if (!skipDateFilter && dateStr < AH_CUTOFF) {
        return { skipped: true, reason: 'before_cutoff', date: dateStr };
    }

    const activityTypeKey = w.workoutActivityType || w.activityType || '';
    const info = AH_ACTIVITY_MAP[activityTypeKey] || { type: 'watch', name: w.name || activityTypeKey || 'Workout' };

    const stats = w.workoutStatistics || w.statistics || null;

    // HR — stats first, then top-level avg/max/min fields
    const hrStat = ahGetStat(stats, 'HKQuantityTypeIdentifierHeartRate');
    const avgHr  = ahParseNum(hrStat.average ?? hrStat.Average) ?? ahParseNum(w.avgHeartRate) ?? ahParseNum(w.averageHeartRate);
    const maxHr  = ahParseNum(hrStat.maximum ?? hrStat.Maximum) ?? ahParseNum(w.maxHeartRate);
    const minHr  = ahParseNum(hrStat.minimum ?? hrStat.Minimum) ?? ahParseNum(w.minHeartRate);

    // Calories — real HAE field is `activeEnergyBurned: {qty, units}`, not `activeEnergy` (which is an array)
    const calStat     = ahGetStat(stats, 'HKQuantityTypeIdentifierActiveEnergyBurned');
    const calories    = ahParseNum(w.activeEnergyBurned)      // real HAE v3 field
                     ?? ahParseNum(w.active_energy)
                     ?? ahParseNum(w.totalEnergy)
                     ?? ahParseNum(w.calories)
                     ?? ahParseNum(w.energyBurned)
                     ?? ahParseNum(calStat.sum ?? calStat.Sum)
                     ?? ahParseNum(w.totalEnergyBurned)
                     ?? ahParseNum(w.energy);
    const totalCalories = ahParseNum(w.totalEnergyBurned)
                       ?? ahParseNum(w.totalEnergy)
                       ?? ahParseNum(w.energy)
                       ?? calories;

    // Distance — HAE v3 uses top-level `distance` object; fallback to stats
    const distRunStat   = ahGetStat(stats, 'HKQuantityTypeIdentifierDistanceWalkingRunning');
    const distCycleStat = ahGetStat(stats, 'HKQuantityTypeIdentifierDistanceCycling');
    const distSwimStat  = ahGetStat(stats, 'HKQuantityTypeIdentifierDistanceSwimming');
    const distance = ahParseNum(w.distance)
                  ?? ahParseNum(distRunStat.sum)
                  ?? ahParseNum(distCycleStat.sum)
                  ?? ahParseNum(distSwimStat.sum)
                  ?? ahParseNum(w.totalDistance);

    // Duration — HAE sends raw seconds (or {qty, units:"s"} object); convert to minutes.
    // Fallback: derive from start/end timestamps (already ms, /60000 = minutes).
    let durationNum = null;
    const rawDur = w.duration;
    if (rawDur != null) {
        if (typeof rawDur === 'object' && 'qty' in rawDur) {
            const qty = parseFloat(rawDur.qty);
            if (!isNaN(qty)) {
                const units = (rawDur.units || '').toLowerCase();
                durationNum = (units === 'min' || units === 'minutes') ? Math.round(qty) : Math.round(qty / 60);
            }
        } else {
            const qty = parseFloat(String(rawDur).replace(/[^\d.-]/g, ''));
            if (!isNaN(qty)) durationNum = Math.round(qty / 60);
        }
    }
    if (durationNum == null) {
        const endRaw  = w.end || w.endDate || null;
        const endDate = endRaw ? new Date(endRaw) : null;
        if (endDate && !isNaN(endDate.getTime())) durationNum = Math.round((endDate - startDate) / 60000);
    }
    const distanceNum  = distance != null ? Math.round(distance * 100) / 100 : null;

    // Pace for cardio (distance assumed in miles — matches US iPhone Health settings)
    let pace = null;
    if (info.type === 'cardio' && distanceNum && durationNum && distanceNum > 0) {
        const paceDec = durationNum / distanceNum;
        const pMins   = Math.floor(paceDec);
        const pSecs   = Math.round((paceDec - pMins) * 60);
        pace = `${pMins}:${pSecs.toString().padStart(2, '0')} /mi`;
    }

    const watchData = JSON.stringify({
        source:            'AppleHealth',
        appleActivityType: activityTypeKey,
        startTime:         w.start || w.startDate,
        endTime:           w.end || w.endDate,
        duration:          durationNum,
        hr:                avgHr != null ? Math.round(avgHr) : null,
        maxHr:             maxHr != null ? Math.round(maxHr) : null,
        minHr:             minHr != null ? Math.round(minHr) : null,
        calories:          calories != null ? Math.round(calories) : null,
        totalCalories:     totalCalories != null ? Math.round(totalCalories) : null,
        distance:          distanceNum,
        pace,
        sourceName:        w.sourceName || w.source || null,
    });

    return {
        mapped:    true,
        date:      dateStr,
        name:      info.name,
        type:      info.type,
        duration:  durationNum,
        hr:        avgHr != null ? Math.round(avgHr) : null,
        calories:  calories != null ? Math.round(calories) : null,
        distance:  distanceNum,
        pace,
        watchData,
        exercises: '[]',
    };
}

async function importAHWorkouts(userId, body, runDb, skipDateFilter) {
    const data = body.data || body;
    const rawWorkouts = Array.isArray(data.workouts) ? data.workouts : [];

    console.log(`[AH] Total workouts in JSON: ${rawWorkouts.length}`);
    rawWorkouts.slice(0, 3).forEach((w, i) => {
        console.log(`[AH][${i}] keys: ${Object.keys(w).join(', ')}`);
        console.log(`[AH][${i}] start="${w.start}" name="${w.name}" duration=${JSON.stringify(w.duration)}`);
        console.log(`[AH][${i}] activeEnergyBurned=${JSON.stringify(w.activeEnergyBurned)} avgHeartRate=${JSON.stringify(w.avgHeartRate)} maxHeartRate=${JSON.stringify(w.maxHeartRate)}`);
    });

    // Map and filter
    let skippedOld = 0, skippedBadDate = 0;
    const candidates = [];
    for (const w of rawWorkouts) {
        const m = ahMapWorkout(w, skipDateFilter);
        if (m.skipped) {
            if (m.reason === 'before_cutoff') skippedOld++;
            else { skippedBadDate++; console.log(`[AH] Bad date: ${m.raw}`); }
        } else {
            let watchObj = {};
            try { watchObj = JSON.parse(m.watchData); } catch(e) {}
            candidates.push({ raw: w, m, watchObj });
        }
    }

    if (!candidates.length) {
        return {
            success: true,
            message: 'No workouts passed the date filter — check server logs for field names',
            workoutsProcessed: rawWorkouts.length,
            workoutsMatchedAndUpdated: 0,
            workoutsSkippedNoMatch: 0,
            workoutsSkippedOld: skippedOld,
            workoutsSkippedBadDate: skippedBadDate,
            sampleParsedWorkout: null,
        };
    }

    // Fetch all existing workouts for this user on relevant dates in one query
    const uniqueDates = [...new Set(candidates.map(c => c.m.date))];
    const placeholders = uniqueDates.map(() => '?').join(',');
    const existingRows = await new Promise((resolve, reject) =>
        db.all(
            `SELECT id, date, name, type, watchData FROM workouts WHERE user_id = ? AND date IN (${placeholders})`,
            [userId, ...uniqueDates],
            (err, rows) => err ? reject(err) : resolve(rows || [])
        )
    );

    const existing = existingRows.map(row => {
        let wd = {};
        if (row.watchData) { try { wd = JSON.parse(row.watchData); } catch(e) {} }
        return { ...row, wd };
    });

    let matched = 0, skippedNoMatch = 0;
    let sampleParsedWorkout = null;
    const usedIds = new Set();

    for (const { raw: w, m, watchObj } of candidates) {
        const haeStartMs = ahParseStartDate(w)?.getTime() ?? null;
        const sameDayRows = existing.filter(e => e.date === m.date && !usedIds.has(e.id));

        let hit = null;

        // Priority 1: start timestamp within 10 minutes
        if (haeStartMs) {
            hit = sameDayRows.find(e => {
                const t = e.wd.startTime ? new Date(e.wd.startTime).getTime() : NaN;
                return !isNaN(t) && Math.abs(t - haeStartMs) <= 10 * 60 * 1000;
            });
        }

        // Priority 1b: if P1 hit a watch/Strava entry, prefer the co-day manual strength workout
        // (user logs sets/reps manually; Strava auto-creates a parallel watch entry for the same session)
        if (hit && hit.type === 'watch') {
            const manualStrength = sameDayRows.filter(e => e.type === 'strength' && !usedIds.has(e.id));
            if (manualStrength.length === 1) hit = manualStrength[0];
        }

        // Priority 2: only workout of same type on that day
        if (!hit) {
            const sameType = sameDayRows.filter(e =>
                e.type === m.type || (m.type === 'strength' && e.type === 'watch')
            );
            if (sameType.length === 1) hit = sameType[0];
        }

        if (hit) {
            const appleHealthData = {
                source:        'AppleHealth',
                startTime:     watchObj.startTime,
                endTime:       watchObj.endTime,
                duration:      watchObj.duration,
                calories:      watchObj.calories,
                totalCalories: watchObj.totalCalories ?? null,
                hr:            watchObj.hr,
                maxHr:         watchObj.maxHr,
                minHr:         watchObj.minHr ?? null,
            };
            const merged = { ...hit.wd, appleHealth: appleHealthData };
            await runDb(
                `UPDATE workouts SET watchData = ?,
                    calories = COALESCE(?, calories),
                    hr       = COALESCE(?, hr),
                    duration = COALESCE(?, duration)
                 WHERE id = ?`,
                [JSON.stringify(merged), appleHealthData.calories ?? null, appleHealthData.hr ?? null, appleHealthData.duration ?? null, hit.id]
            );
            hit.wd = merged;
            usedIds.add(hit.id);
            matched++;
            console.log(`[AH] Merged id=${hit.id} name="${hit.name}" date=${m.date} cal=${appleHealthData.calories} dur=${appleHealthData.duration}min avgHR=${appleHealthData.hr}`);
            if (!sampleParsedWorkout) {
                sampleParsedWorkout = {
                    start:    w.start || w.startDate,
                    duration: appleHealthData.duration,
                    calories: appleHealthData.calories,
                    hr:       appleHealthData.hr,
                    maxHr:    appleHealthData.maxHr,
                };
            }
        } else {
            skippedNoMatch++;
            console.log(`[AH] No match for "${m.name}" on ${m.date} (haeStart=${new Date(haeStartMs).toISOString()}) — skipped`);
        }
    }

    console.log(`[AH] Done → matched=${matched} skippedNoMatch=${skippedNoMatch} skippedOld=${skippedOld} skippedBadDate=${skippedBadDate}`);

    // Raw sample for debugging — key fields from first 2-3 workouts
    const rawSample = rawWorkouts.slice(0, 3).map(w => {
        const picked = {};
        ['start','end','name','workoutActivityType','duration',
         'activeEnergyBurned','avgHeartRate','maxHeartRate',
         'activeEnergy','totalEnergyBurned'].forEach(k => {
            if (k in w) picked[k] = w[k];
        });
        return picked;
    });

    return {
        success:                   true,
        message:                   'Merge complete',
        workoutsProcessed:         rawWorkouts.length,
        workoutsMatchedAndUpdated: matched,
        workoutsSkippedNoMatch:    skippedNoMatch,
        workoutsSkippedOld:        skippedOld,
        workoutsSkippedBadDate:    skippedBadDate,
        sampleParsedWorkout,
        debug: { rawWorkoutSample: rawSample },
    };
}

app.post('/api/apple-health/generate-token', authenticateToken, (req, res) => {
    const userId = req.user.user_id;
    if (!userId) return res.status(403).json({ error: 'No user_id' });
    const token = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT OR REPLACE INTO apple_health_tokens (user_id, token) VALUES (?, ?)`,
        [userId, token],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to generate token' });
            res.json({ token });
        }
    );
});

app.get('/api/apple-health/token-status', authenticateToken, (req, res) => {
    db.get(`SELECT token, last_import_at FROM apple_health_tokens WHERE user_id = ?`,
        [req.user.user_id],
        (err, row) => res.json({ token: row?.token || null, lastImport: row?.last_import_at || null })
    );
});

app.post('/api/apple-health/import', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const skipDateFilter = req.query.skipDateFilter === '1';

    db.get(`SELECT user_id FROM apple_health_tokens WHERE token = ?`, [token], async (err, row) => {
        if (err || !row) return res.status(401).json({ error: 'Invalid token' });

        const runDb = (sql, params) => new Promise((resolve, reject) =>
            db.run(sql, params, function(e) { if (e) reject(e); else resolve(this); })
        );

        try {
            const result = await importAHWorkouts(row.user_id, req.body, runDb, skipDateFilter);
            db.run(`UPDATE apple_health_tokens SET last_import_at = datetime('now') WHERE user_id = ?`, [row.user_id]);
            logAction(`APPLE HEALTH: User ${row.user_id} imported ${result.workoutsImportedOrUpdated} workouts via token`);
            res.json(result);
        } catch(e) {
            console.error('Apple Health import error:', e);
            res.status(500).json({ error: e.message });
        }
    });
});

app.post('/api/apple-health/upload', authenticateToken, async (req, res) => {
    const skipDateFilter = req.query.skipDateFilter === '1';
    const runDb = (sql, params) => new Promise((resolve, reject) =>
        db.run(sql, params, function(e) { if (e) reject(e); else resolve(this); })
    );

    try {
        const result = await importAHWorkouts(req.user.user_id, req.body, runDb, skipDateFilter);
        db.run(`UPDATE apple_health_tokens SET last_import_at = datetime('now') WHERE user_id = ?`, [req.user.user_id]);
        logAction(`APPLE HEALTH: User ${req.user.user_id} uploaded ${result.workoutsImportedOrUpdated} workouts manually`);
        res.json(result);
    } catch(e) {
        console.error('Apple Health upload error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/invites/generate', authenticateToken, (req, res) => {
    const isOwner = req.user.user_id === 75001 || req.user.user === 'noah';
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(12);
    const token = Array.from(bytes).map(b => chars[b % chars.length]).join('');

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const createdBy = req.user.user_id || 0;

    db.run(
        `INSERT INTO invites (token, max_uses, current_uses, expires_at, created_by) VALUES (?, 1, 0, ?, ?)`,
        [token, expiresAt, createdBy],
        function(err) {
            if (err) return res.status(500).json({ error: 'Failed to generate invite' });
            res.json({ token, expiresAt });
        }
    );
});

const PORT = 3000;

// Remote restart - ONLY allowed for authenticated users (you)
app.post('/restart', authenticateToken, (req, res) => {
    const user = "authenticated user";   // We can improve this later if you want real username
    logAction(`REMOTE RESTART initiated by ${user}`);
    
    res.json({ message: "Server restarting..." });

    // Give the response time to send, then restart
    setTimeout(() => {
        logAction(`Server shutdown for restart (initiated by ${user})`);
        process.exit(0);   // pm2 or systemd will auto-restart it
    }, 800);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`LIFT-LOG LIVE: Running on port ${PORT}`);
});

process.on('uncaughtException', (err) => {
    console.error('CRASH PREVENTED. Error:', err);
});
