const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

// ========== بياناتك ==========
const TELEGRAM_BOT_TOKEN = '8357290061:AAEbuoj1HIFIcML9rx17XpVAUxHpdXiqRLg';
const DEEPSEEK_API_KEY = 'sk-4c5f4a3f54344065b264eaa75bb33807';
// ============================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ========== قاعدة بيانات SQLite للذاكرة الدائمة ==========
const db = new sqlite3.Database('user_data.db');

// إنشاء الجداول
db.serialize(() => {
    // جدول المستخدمين
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        name TEXT,
        preferences TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // جدول المهام
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        task TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // جدول الملاحظات
    db.run(`CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // جدول التذكيرات
    db.run(`CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        reminder TEXT,
        reminder_time DATETIME,
        is_done INTEGER DEFAULT 0
    )`);

    // جدول المحادثات (سياق قصير المدى)
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        role TEXT,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ========== دوال قاعدة البيانات ==========

// حفظ رسالة في تاريخ المحادثة (آخر 20 رسالة فقط)
function saveConversation(userId, role, content) {
    db.run(`INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)`, [userId, role, content]);
    // حذف الرسائل القديمة (أقدم من آخر 20 رسالة)
    db.run(`DELETE FROM conversations WHERE user_id = ? AND id NOT IN (
        SELECT id FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    )`, [userId, userId]);
}

// جلب تاريخ المحادثة للمستخدم
function getConversationHistory(userId, callback) {
    db.all(`SELECT role, content FROM conversations WHERE user_id = ? ORDER BY created_at ASC`, [userId], (err, rows) => {
        if (err || !rows) callback([]);
        else callback(rows);
    });
}

// إضافة مهمة
function addTask(userId, task, callback) {
    db.run(`INSERT INTO tasks (user_id, task) VALUES (?, ?)`, [userId, task], function(err) {
        callback(err ? null : this.lastID);
    });
}

// جلب المهام غير المنجزة
function getPendingTasks(userId, callback) {
    db.all(`SELECT id, task FROM tasks WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC`, [userId], callback);
}

// إنجاز مهمة
function completeTask(userId, taskId, callback) {
    db.run(`UPDATE tasks SET status = 'done' WHERE id = ? AND user_id = ?`, [taskId, userId], callback);
}

// إضافة ملاحظة
function addNote(userId, title, content, callback) {
    db.run(`INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)`, [userId, title, content], callback);
}

// جلب الملاحظات
function getNotes(userId, callback) {
    db.all(`SELECT id, title, content FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`, [userId], callback);
}

// حفظ/تحديث تفضيلات المستخدم
function saveUserPreference(userId, key, value, callback) {
    db.get(`SELECT preferences FROM users WHERE user_id = ?`, [userId], (err, row) => {
        let prefs = row ? (JSON.parse(row.preferences) || {}) : {};
        prefs[key] = value;
        if (row) {
            db.run(`UPDATE users SET preferences = ? WHERE user_id = ?`, [JSON.stringify(prefs), userId], callback);
        } else {
            db.run(`INSERT INTO users (user_id, name, preferences) VALUES (?, ?, ?)`, [userId, null, JSON.stringify(prefs)], callback);
        }
    });
}

// جلب تفضيلات المستخدم
function getUserPreferences(userId, callback) {
    db.get(`SELECT preferences FROM users WHERE user_id = ?`, [userId], (err, row) => {
        callback(row ? (JSON.parse(row.preferences) || {}) : {});
    });
}

// تحديث اسم المستخدم
function updateUserName(userId, name, callback) {
    db.run(`INSERT OR REPLACE INTO users (user_id, name, preferences, created_at)
            VALUES (?, ?, COALESCE((SELECT preferences FROM users WHERE user_id = ?), '{}'), COALESCE((SELECT created_at FROM users WHERE user_id = ?), CURRENT_TIMESTAMP))`,
            [userId, name, userId, userId], callback);
}

// ========== استخراج الأزرار من رد DeepSeek ==========
function extractButtonsFromResponse(responseText) {
    const buttonRegex = /\[button:\s*([^|]+)\|([^\]]+)\]/g;
    const buttons = [];
    let match;
    let cleanText = responseText;

    while ((match = buttonRegex.exec(responseText)) !== null) {
        buttons.push({ text: match[1].trim(), callback_data: match[2].trim() });
        cleanText = cleanText.replace(match[0], '');
    }

    return { cleanText: cleanText.trim(), buttons };
}

// ========== إرسال رد مع أزرار ==========
async function sendReply(chatId, deepseekResponse) {
    const { cleanText, buttons } = extractButtonsFromResponse(deepseekResponse);

    if (buttons.length > 0) {
        const keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) {
            const row = [];
            row.push({ text: buttons[i].text, callback_data: buttons[i].callback_data });
            if (buttons[i + 1]) {
                row.push({ text: buttons[i + 1].text, callback_data: buttons[i + 1].callback_data });
            }
            keyboard.push(row);
        }

        const opts = {
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        };

        await bot.sendMessage(chatId, cleanText || '🔘 اختر أحد الخيارات:', opts);
    } else {
        await bot.sendMessage(chatId, deepseekResponse, { parse_mode: 'Markdown' });
    }
}

// ========== الاتصال بـ DeepSeek مع معرفة البيانات الشخصية ==========
async function askDeepSeek(chatId, userMessage, username = null) {
    // جلب البيانات الشخصية للمستخدم
    const preferences = await new Promise(resolve => getUserPreferences(chatId, resolve));
    const tasks = await new Promise(resolve => getPendingTasks(chatId, resolve));
    const notesList = await new Promise(resolve => getNotes(chatId, resolve));

    // جلب آخر المحادثات
    const history = await new Promise(resolve => getConversationHistory(chatId, resolve));

    // بناء رسالة النظام مع البيانات الشخصية
    const tasksText = tasks.length > 0
        ? `\nمهامك الحالية:\n${tasks.map((t, i) => `${i+1}. ${t.task} (ID: ${t.id})`).join('\n')}`
        : '\nليس لديك مهام حالياً.';

    const notesText = notesList.length > 0
        ? `\nآخر ملاحظاتك:\n${notesList.map(n => `- ${n.title}: ${n.content.substring(0, 50)}`).join('\n')}`
        : '';

    const preferencesText = Object.keys(preferences).length > 0
        ? `\nتفضيلاتك: ${JSON.stringify(preferences)}`
        : '';

    history.push({ role: 'user', content: userMessage });

    const systemPrompt = `أنت مساعد شخصي ذكي جداً على تلغرام. اسم البوت: مساعدي الشخصي.

معلومات عن المستخدم:
- معرفه: ${chatId}
- اسمه: ${username || 'لم يخبرك بعد'}
${preferencesText}
${tasksText}
${notesText}

قدراتك:
1. التعرف على المستخدم وتذكر اسمه وتفضيلاته
2. إدارة المهام (إضافة، إنجاز، عرض)
3. حفظ ملاحظات سريعة
4. تذكر سياق المحادثة
5. التحدث بأسلوب ودود ومحترم
6. إنشاء أزرار تفاعلية حسب الحاجة

كيفية إنشاء الأزرار:
استخدم [button: النص المعروض|القيمة المرسلة]

أمثلة على الأزرار التي يمكنك إنشاؤها:
- [button: ✅ عرض مهامي|show_tasks]
- [button: 📝 إضافة مهمة|add_task]
- [button: 📒 ملاحظاتي|show_notes]
- [button: ✏️ إضافة ملاحظة|add_note]
- [button: 🎮 ألعاب|show_games]
- [button: 💬 محادثة عادية|normal_chat]

عندما يطلب المستخدم إضافة مهمة، اسأله عن التفاصيل أولاً.
عندما يطلب إنجاز مهمة، اعرض له مهامه الحالية وأعطه أزراراً لإنجازها.

كن شخصياً ودوداً، وابدأ دائماً بتحية لطيفة.`;

    // حفظ رسالة المستخدم
    saveConversation(chatId, 'user', userMessage);

    try {
        bot.sendChatAction(chatId, 'typing');

        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                ...history.slice(-15) // آخر 15 رسالة للسياق
            ],
            temperature: 0.8,
            max_tokens: 1500
        }, {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const reply = response.data.choices[0].message.content;

        // حفظ رد المساعد
        saveConversation(chatId, 'assistant', reply);

        await sendReply(chatId, reply);

    } catch (error) {
        console.error('خطأ:', error.response?.data || error.message);
        await bot.sendMessage(chatId, '⚠️ عذراً، حدث خطأ. حاول مرة أخرى.');
    }
}

// ========== معالجة أوامر خاصة من الأزرار ==========
async function handleSpecialCommand(chatId, command, username) {
    switch(command) {
        case 'show_tasks':
            getPendingTasks(chatId, (err, tasks) => {
                if (tasks.length === 0) {
                    bot.sendMessage(chatId, '📋 *ليس لديك أي مهام حالياً!* 🎉\n\nأرسل "أضف مهمة: [المهمة]" لإضافة واحدة.', { parse_mode: 'Markdown' });
                } else {
                    let taskList = '📋 *مهامك الحالية:*\n\n';
                    tasks.forEach((task, i) => {
                        taskList += `${i+1}. ${task.task}\n   🆔 معرف المهمة: \`${task.id}\`\n\n`;
                    });
                    taskList += '\nلإنجاز مهمة، أرسل: `انجز المهمة [المعرف]`';
                    bot.sendMessage(chatId, taskList, { parse_mode: 'Markdown' });
                }
            });
            return true;

        case 'add_task':
            bot.sendMessage(chatId, '📝 *أضف مهمة جديدة*\n\nأرسل المهمة بالصيغة:\n`مهمة: [وصف المهمة]`', { parse_mode: 'Markdown' });
            return true;

        case 'show_notes':
            getNotes(chatId, (err, notes) => {
                if (notes.length === 0) {
                    bot.sendMessage(chatId, '📒 *ليس لديك أي ملاحظات!*\n\nأرسل "ملاحظة: [العنوان] | [المحتوى]" لإضافة واحدة.', { parse_mode: 'Markdown' });
                } else {
                    let notesText = '📒 *ملاحظاتك:*\n\n';
                    notes.forEach((note, i) => {
                        notesText += `${i+1}. *${note.title}*\n   ${note.content.substring(0, 100)}\n\n`;
                    });
                    bot.sendMessage(chatId, notesText, { parse_mode: 'Markdown' });
                }
            });
            return true;

        case 'add_note':
            bot.sendMessage(chatId, '📝 *أضف ملاحظة جديدة*\n\nأرسل بالصيغة:\n`ملاحظة: [العنوان] | [المحتوى]`', { parse_mode: 'Markdown' });
            return true;

        case 'show_games':
            bot.sendMessage(chatId, '🎮 *الألعاب المتاحة:* 🎮\n\nاختر لعبتك المفضلة:');
            askDeepSeek(chatId, 'اعرض قائمة الألعاب المتاحة مع أزرار للاختيار', username);
            return true;

        case 'normal_chat':
            bot.sendMessage(chatId, '💬 *وضع المحادثة العادية*\n\nأرسل لي أي شيء وسأتحدث معك! 🗣️', { parse_mode: 'Markdown' });
            return true;

        default:
            return false;
    }
}

// ========== معالجة الأوامر والرسائل ==========

// أمر /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.first_name;

    await updateUserName(chatId, username, () => {});

    await bot.sendMessage(chatId, `🌟 *أهلاً بك يا ${username}!* 🌟\n\nأنا مساعدك الشخصي الذكي. سأتذكر مهامك، ملاحظاتك، وتفضيلاتك.\n\nاسألني أي شيء، أو استخدم الأزرار أدناه للبدء:`, { parse_mode: 'Markdown' });

    askDeepSeek(chatId, 'رحب بالمستخدم الجديد واعرض عليه قائمة بما يمكنني فعله كمساعد شخصي. استخدم أزراراً للخيارات الرئيسية.', username);
});

// أمر /reset
bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    db.run(`DELETE FROM conversations WHERE user_id = ?`, [chatId]);
    await bot.sendMessage(chatId, '🗑️ *تم مسح سياق المحادثة!*\n\nما زلت أتذكر مهامك وملاحظاتك.', { parse_mode: 'Markdown' });
});

// معالجة الرسائل العادية
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const username = msg.from.first_name;

    if (!text) return;
    if (text.startsWith('/')) return;

    // معالجة أوامر النص السريعة
    if (text.toLowerCase().startsWith('مهمة:')) {
        const task = text.substring(5).trim();
        if (task) {
            addTask(chatId, task, (id) => {
                bot.sendMessage(chatId, `✅ *تم إضافة المهمة!*\n\n📝 ${task}\n🆔 معرف المهمة: \`${id}\``, { parse_mode: 'Markdown' });
            });
        }
        return;
    }

    if (text.toLowerCase().startsWith('انجز المهمة')) {
        const idMatch = text.match(/\d+/);
        if (idMatch) {
            const taskId = parseInt(idMatch[0]);
            completeTask(chatId, taskId, () => {
                bot.sendMessage(chatId, `✅ *تم إنجاز المهمة!* 🎉\n\nأحسنت! تابع إنجاز مهامك.`, { parse_mode: 'Markdown' });
            });
        } else {
            bot.sendMessage(chatId, '⚠️ يرجى إرسال معرف المهمة.\nمثال: `انجز المهمة 5`', { parse_mode: 'Markdown' });
        }
        return;
    }

    if (text.toLowerCase().startsWith('ملاحظة:')) {
        const parts = text.substring(5).trim().split('|');
        if (parts.length >= 2) {
            const title = parts[0].trim();
            const content = parts.slice(1).join('|').trim();
            addNote(chatId, title, content, () => {
                bot.sendMessage(chatId, `✅ *تم إضافة الملاحظة!*\n\n📌 *${title}*\n${content.substring(0, 100)}`, { parse_mode: 'Markdown' });
            });
        } else {
            bot.sendMessage(chatId, '⚠️ الصيغة الصحيحة: `ملاحظة: [العنوان] | [المحتوى]`', { parse_mode: 'Markdown' });
        }
        return;
    }

    // المحادثة العادية مع DeepSeek
    await askDeepSeek(chatId, text, username);
});

// معالجة الأزرار
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const buttonValue = callbackQuery.data;
    const username = callbackQuery.from.first_name;

    bot.answerCallbackQuery(callbackQuery.id);

    // معالجة الأوامر الخاصة
    const handled = await handleSpecialCommand(chatId, buttonValue, username);

    if (!handled) {
        // إرسال قيمة الزر إلى DeepSeek
        await askDeepSeek(chatId, `[المستخدم ضغط على زر: ${buttonValue}] بناءً على هذا، قم بتنفيذ الإجراء المناسب.`, username);
    }
});

console.log('🚀 المساعد الشخصي يعمل...');
console.log('💾 قاعدة البيانات: user_data.db');
console.log('📋 الأوامر السريعة:');
console.log('   - مهمة: [الوصف]');
console.log('   - انجز المهمة [المعرف]');
console.log('   - ملاحظة: [العنوان] | [المحتوى]');
