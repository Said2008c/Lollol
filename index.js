const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { DatabaseSync } = require('node:sqlite'); // ✅ مكتبة SQLite المدمجة في Node.js 22
require('dotenv').config();

// ========== بياناتك ==========
const TELEGRAM_BOT_TOKEN = '8357290061:AAEbuoj1HIFIcML9rx17XpVAUxHpdXiqRLg';
const DEEPSEEK_API_KEY = 'sk-your-deepseek-api-key-here';
// ============================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ========== إنشاء قاعدة البيانات باستخدام node:sqlite (دون أي مشاكل!) ==========
const db = new DatabaseSync('user_data.db');

// إنشاء الجداول
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        name TEXT,
        preferences TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        task TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reminder TEXT,
        reminder_time DATETIME,
        is_done INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        role TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

console.log('✅ قاعدة البيانات جاهزة باستخدام node:sqlite المدمج!');

// ========== دوال قاعدة البيانات ==========
function saveConversation(userId, role, content) {
    const stmt = db.prepare(`
        INSERT INTO conversations (user_id, role, content) 
        VALUES (?, ?, ?)
    `);
    stmt.run(userId, role, content);
    
    // حذف الرسائل القديمة (نبقي آخر 20 رسالة فقط)
    db.prepare(`
        DELETE FROM conversations 
        WHERE user_id = ? AND id NOT IN (
            SELECT id FROM conversations WHERE user_id = ? 
            ORDER BY created_at DESC LIMIT 20
        )
    `).run(userId, userId);
}

function getConversationHistory(userId) {
    const stmt = db.prepare(`
        SELECT role, content FROM conversations 
        WHERE user_id = ? ORDER BY created_at ASC
    `);
    return stmt.all(userId);
}

function addTask(userId, task) {
    const stmt = db.prepare(`INSERT INTO tasks (user_id, task) VALUES (?, ?)`);
    return stmt.run(userId, task).lastInsertRowid;
}

function getPendingTasks(userId) {
    const stmt = db.prepare(`
        SELECT id, task FROM tasks 
        WHERE user_id = ? AND status = 'pending' 
        ORDER BY created_at DESC
    `);
    return stmt.all(userId);
}

function completeTask(userId, taskId) {
    const stmt = db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ? AND user_id = ?`);
    return stmt.run(taskId, userId);
}

function addNote(userId, title, content) {
    const stmt = db.prepare(`INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)`);
    return stmt.run(userId, title, content);
}

function getNotes(userId) {
    const stmt = db.prepare(`
        SELECT id, title, content FROM notes 
        WHERE user_id = ? ORDER BY created_at DESC LIMIT 10
    `);
    return stmt.all(userId);
}

function saveUserPreference(userId, key, value) {
    const row = db.prepare(`SELECT preferences FROM users WHERE user_id = ?`).get(userId);
    let prefs = row ? (JSON.parse(row.preferences) || {}) : {};
    prefs[key] = value;
    
    if (row) {
        db.prepare(`UPDATE users SET preferences = ? WHERE user_id = ?`).run(JSON.stringify(prefs), userId);
    } else {
        db.prepare(`INSERT INTO users (user_id, preferences) VALUES (?, ?)`).run(userId, JSON.stringify(prefs));
    }
}

function getUserPreferences(userId) {
    const row = db.prepare(`SELECT preferences FROM users WHERE user_id = ?`).get(userId);
    return row ? (JSON.parse(row.preferences) || {}) : {};
}

function updateUserName(userId, name) {
    const existing = db.prepare(`SELECT preferences FROM users WHERE user_id = ?`).get(userId);
    const prefs = existing ? (JSON.parse(existing.preferences) || {}) : {};
    const createdAt = existing ? existing.created_at : new Date().toISOString();
    
    db.prepare(`
        INSERT OR REPLACE INTO users (user_id, name, preferences, created_at) 
        VALUES (?, ?, ?, ?)
    `).run(userId, name, JSON.stringify(prefs), createdAt);
}

// ========== باقي دوال البوت (نفس الكود السابق) ==========
// دوال استخراج الأزرار، sendReply، askDeepSeek، معالجة الأوامر...

console.log('🚀 المساعد الشخصي يعمل... بدون أي متاعب في sqlite3!');
