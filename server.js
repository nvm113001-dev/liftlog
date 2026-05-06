const express = require('express');
const AUDIT_LOG = '/mnt/liftlog_data/liftlog/audit.log';
const jwt = require('jsonwebtoken'); // Add this
require('dotenv').config();
const axios = require('axios');
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

// Calculate estimated 1RM from ALL sets in last 45 days (your preferred method)
function calculateEstimatedOneRM(exerciseName) {
    return new Promise((resolve) => {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 45);
        const cutoffDate = cutoff.toISOString().split('T')[0];

        db.all("SELECT exercises FROM workouts WHERE date >= ? ORDER BY date DESC", [cutoffDate], (err, rows) => {
            if (err) {
                console.error("1RM calculation error:", err);
                resolve();
                return;
            }

            let totalWeight = 0;
            let totalReps = 0;
            let setCount = 0;

            (rows || []).forEach(row => {
                try {
                    const exercises = JSON.parse(row.exercises || '[]');
                    const match = exercises.find(ex => ex.name === exerciseName);
                    if (match && match.sets) {
                        match.sets.forEach(set => {
                            const w = parseFloat(set.weight);
                            const r = parseInt(set.reps);
                            if (w && r > 0) {
                                totalWeight += w;
                                totalReps += r;
                                setCount++;
                            }
                        });
                    }
                } catch(e) {}
            });

            if (setCount > 0) {
                const avgWeight = totalWeight / setCount;
                const avgReps   = totalReps / setCount;
                const oneRM = avgWeight * (1 + avgReps / 30);
                exerciseStats[exerciseName] = Math.round(oneRM);
            }
            resolve();
        });
    });
}

// Update stats for a single workout (called after saving new workout)
function updateExerciseStatsForWorkout(workout) {
    if (!workout || !workout.exercises) return;
    
    const exerciseNames = new Set(workout.exercises.map(ex => ex.name).filter(name => name));
    
    (async () => {
        for (const name of exerciseNames) {
            await calculateEstimatedOneRM(name);
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
const app = express();
app.use(express.json());
const port = 3000;

app.use(express.static('.')); // Serves your index.html and app.js

const cors = require('cors');
app.use(cors());

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const TEMPLATES_FILE = '/mnt/liftlog_data/liftlog/templates.json';

// Connect to the SQLite database on your T7 SSD
const db = new sqlite3.Database('/mnt/liftlog_data/liftlog/data/workouts.db');
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
    callbackURL: process.env.GOOGLE_CALLBACK_URL || "https://liftlognm.tailee3a44.ts.net/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    
    const userMap = {
        'nvm113001@gmail.com': 75001,
        'nmtest77@gmail.com': 75005
    };

    // 2. Look up the ID for whoever is trying to log in
    const assignedUserId = userMap[email];

    if (!assignedUserId) {
        return done(null, false, { message: 'Email not allowed' });
    }

    return done(null, { 
        id: profile.id, 
        email: email, 
        name: profile.displayName,
        user_id: assignedUserId  // 3. Make this dynamic instead of a hardcoded 1
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
});

app.post('/login', (req, res) => {
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

// 1. The initial login route
app.get('/auth/google', 
    passport.authenticate('google', { 
        scope: ['profile', 'email'], 
        session: false // <-- ADD THIS FLAG HERE
    })
);

// 2. The callback route
app.get('/auth/google/callback',
    passport.authenticate('google', { 
        failureRedirect: '/login.html', 
        session: false // <-- AND ADD THIS FLAG HERE
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
        updateExerciseStatsForWorkout({ exercises: JSON.parse(exercisesStr) });   // ← add this
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





app.get('/workouts', (req, res) => {
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

// PASTE THE BLOCK HERE
app.get('/api/strava/sync', authenticateToken, async (req, res) => {
    try {
        const runDb = (sql, params) => new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
            client_id: process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            refresh_token: process.env.STRAVA_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        });

        const activityRes = await axios.get('https://www.strava.com/api/v3/athlete/activities?per_page=200', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });

        for (const act of activityRes.data) {
            const date = act.start_date_local.split('T')[0];
            const miles = Number((act.distance / 1609.34).toFixed(2));
            const mins = Math.floor(act.moving_time / 60);

            const hr = act.average_heartrate ? Math.round(act.average_heartrate) : null;
            const maxHr = act.max_heartrate ? Math.round(act.max_heartrate) : null;
            const cals = act.calories ? Math.round(act.calories) : null;
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
