const { exec } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
require('dotenv').config();

// ========== بياناتك ==========
const TELEGRAM_BOT_TOKEN = 'ضع_التوكن_الجديد_هنا';
const ALLOWED_USERS = []; // ضع معرفات المستخدمين المسموح لهم (اختياري)
// ============================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// تخزين حالة الـ containers لكل مستخدم
let activeContainer = null; // فقط container واحد نشط
let containerInfo = null; // تخزين معلومات الـ container

// ========== دوال مساعدة ==========
function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(stderr || error.message);
            } else {
                resolve(stdout);
            }
        });
    });
}

// التحقق إذا كان الـ container موجود
async function containerExists(containerName) {
    try {
        const output = await runCommand(`docker ps -a --filter "name=${containerName}" --format "{{.Names}}"`);
        return output.trim() === containerName;
    } catch {
        return false;
    }
}

// الحصول على حالة الـ container
async function getContainerStatus(containerName) {
    try {
        const output = await runCommand(`docker inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null || echo "not_found"`);
        return output.trim();
    } catch {
        return 'not_found';
    }
}

// تشغيل sshx والحصول على الرابط
async function startSSHX() {
    try {
        // تشغيل sshx في container موجود أو مباشرة
        const output = await runCommand(`docker exec ${containerInfo.name} sshx 2>/dev/null || sshx`);
        const linkMatch = output.match(/https:\/\/sshx\.io\/[a-zA-Z0-9_-]+/);
        return linkMatch ? linkMatch[0] : null;
    } catch (error) {
        return null;
    }
}

// ========== الأزرار والقوائم ==========

// قائمة التحكم الرئيسية
async function showManageMenu(chatId) {
    if (!activeContainer) {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📦 إنشاء Container جديد', callback_data: 'make_container' }]
                ]
            }
        };
        await bot.sendMessage(chatId, '❌ *لا يوجد Container نشط*\n\nاستخدم /make لإنشاء واحد أولاً.', { parse_mode: 'Markdown', ...opts });
        return;
    }

    const status = await getContainerStatus(activeContainer);
    const statusIcon = status === 'running' ? '🟢' : (status === 'exited' ? '🔴' : '⚪');
    
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚀 Start', callback_data: 'container_start' }, { text: '⏹️ Stop', callback_data: 'container_stop' }],
                [{ text: '🔄 Restart', callback_data: 'container_restart' }, { text: '🗑️ Remove', callback_data: 'container_remove' }],
                [{ text: '🔌 SSH (sshx)', callback_data: 'container_ssh' }],
                [{ text: '📊 Status', callback_data: 'container_status' }, { text: '📜 Logs', callback_data: 'container_logs' }]
            ]
        },
        parse_mode: 'Markdown'
    };
    
    await bot.sendMessage(chatId, `${statusIcon} *Container: ${activeContainer}*\n📊 الحالة: ${status}\n\n*اختر إجراء:*`, opts);
}

// ========== الأوامر ==========

// أمر !manage
bot.onText(/^!manage$/, async (msg) => {
    const chatId = msg.chat.id;
    await showManageMenu(chatId);
});

// أمر !make (يسوي container واحد فقط)
bot.onText(/^!make$/, async (msg) => {
    const chatId = msg.chat.id;
    
    // التأكد من عدم وجود container نشط
    if (activeContainer) {
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🗑️ حذف القديم أولاً', callback_data: 'container_remove' }],
                    [{ text: '📋 قائمة التحكم', callback_data: 'manage_menu' }]
                ]
            }
        };
        await bot.sendMessage(chatId, '⚠️ *يوجد Container نشط بالفعل!*\n\nيمكنك فقط إنشاء واحد.\nاحذف القديم أولاً.', { parse_mode: 'Markdown', ...opts });
        return;
    }
    
    await bot.sendMessage(chatId, '📦 *جاري إنشاء Container جديد...*\n\nالرجاء إرسال المعلومات بهذا الشكل:\n\n`الاسم | الصورة | المنفذ`\n\nمثال:\n`myapp | nginx | 8080:80`\n\nأو فقط:\n`myapp | alpine`', { parse_mode: 'Markdown' });
    
    // تخزين حالة انتظار المعلومات
    global.waitingForContainerInfo = chatId;
});

// معالجة معلومات الـ container الجديد
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (!text || text.startsWith('/') || text.startsWith('!')) return;
    
    // إذا كنا ننتظر معلومات الـ container
    if (global.waitingForContainerInfo === chatId) {
        global.waitingForContainerInfo = null;
        
        const parts = text.split('|').map(p => p.trim());
        const name = parts[0];
        const image = parts[1] || 'alpine';
        const port = parts[2] || '';
        
        if (!name) {
            await bot.sendMessage(chatId, '❌ يجب إدخال اسم الـ container على الأقل.\nاستخدم /make مرة أخرى.');
            return;
        }
        
        await bot.sendMessage(chatId, `⏳ *جاري إنشاء container:* ${name}\nالصورة: ${image}${port ? `\nالمنفذ: ${port}` : ''}`, { parse_mode: 'Markdown' });
        
        try {
            // بناء أمر docker run
            let dockerCmd = `docker run -d --name ${name}`;
            if (port) {
                dockerCmd += ` -p ${port}`;
            }
            dockerCmd += ` ${image} tail -f /dev/null`; // يبقي الـ container شغال
            
            // التأكد أن الاسم غير موجود
            const exists = await containerExists(name);
            if (exists) {
                await bot.sendMessage(chatId, `❌ Container بالاسم "${name}" موجود مسبقاً. استخدم اسم آخر.`);
                return;
            }
            
            await runCommand(dockerCmd);
            activeContainer = name;
            containerInfo = { name, image, port, created: new Date().toISOString() };
            
            // حفظ المعلومات في ملف
            fs.writeFileSync('container.json', JSON.stringify(containerInfo, null, 2));
            
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🎮 فتح لوحة التحكم', callback_data: 'manage_menu' }]
                    ]
                }
            };
            await bot.sendMessage(chatId, `✅ *تم إنشاء container بنجاح!*\n\n📦 الاسم: ${name}\n🐳 الصورة: ${image}${port ? `\n🔌 المنفذ: ${port}` : ''}\n\nاستخدم !manage للتحكم به.`, { parse_mode: 'Markdown', ...opts });
            
        } catch (error) {
            await bot.sendMessage(chatId, `❌ خطأ في الإنشاء:\n\`${error}\``, { parse_mode: 'Markdown' });
        }
    }
});

// ========== معالجة أزرار التحكم ==========

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    switch(data) {
        case 'manage_menu':
            await showManageMenu(chatId);
            break;
            
        case 'make_container':
            await bot.sendMessage(chatId, 'استخدم الأمر `!make` لإنشاء container جديد.', { parse_mode: 'Markdown' });
            break;
            
        case 'container_start':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                await showManageMenu(chatId);
                break;
            }
            await bot.sendMessage(chatId, `🚀 *جاري تشغيل ${activeContainer}...*`, { parse_mode: 'Markdown' });
            try {
                await runCommand(`docker start ${activeContainer}`);
                await bot.sendMessage(chatId, `✅ *تم تشغيل ${activeContainer} بنجاح!*`, { parse_mode: 'Markdown' });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ: ${error}`, { parse_mode: 'Markdown' });
            }
            await showManageMenu(chatId);
            break;
            
        case 'container_stop':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                break;
            }
            await bot.sendMessage(chatId, `⏹️ *جاري إيقاف ${activeContainer}...*`, { parse_mode: 'Markdown' });
            try {
                await runCommand(`docker stop ${activeContainer}`);
                await bot.sendMessage(chatId, `✅ *تم إيقاف ${activeContainer}.*`, { parse_mode: 'Markdown' });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ: ${error}`);
            }
            await showManageMenu(chatId);
            break;
            
        case 'container_restart':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                break;
            }
            await bot.sendMessage(chatId, `🔄 *جاري إعادة تشغيل ${activeContainer}...*`, { parse_mode: 'Markdown' });
            try {
                await runCommand(`docker restart ${activeContainer}`);
                await bot.sendMessage(chatId, `✅ *تم إعادة تشغيل ${activeContainer}.*`, { parse_mode: 'Markdown' });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ: ${error}`);
            }
            await showManageMenu(chatId);
            break;
            
        case 'container_remove':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container للحذف.');
                break;
            }
            
            // تأكيد الحذف
            const confirmOpts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ نعم، احذف', callback_data: 'confirm_remove' }, { text: '❌ إلغاء', callback_data: 'manage_menu' }]
                    ]
                }
            };
            await bot.sendMessage(chatId, `⚠️ *هل أنت متأكد من حذف ${activeContainer}؟*\nهذا الإجراء لا يمكن التراجع عنه.`, { parse_mode: 'Markdown', ...confirmOpts });
            break;
            
        case 'confirm_remove':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container للحذف.');
                break;
            }
            await bot.sendMessage(chatId, `🗑️ *جاري حذف ${activeContainer}...*`, { parse_mode: 'Markdown' });
            try {
                await runCommand(`docker stop ${activeContainer} 2>/dev/null || true`);
                await runCommand(`docker rm ${activeContainer}`);
                activeContainer = null;
                containerInfo = null;
                if (fs.existsSync('container.json')) {
                    fs.unlinkSync('container.json');
                }
                await bot.sendMessage(chatId, `✅ *تم حذف container بنجاح.*\n\nيمكنك الآن إنشاء واحد جديد باستخدام !make`, { parse_mode: 'Markdown' });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ في الحذف: ${error}`);
            }
            await showManageMenu(chatId);
            break;
            
        case 'container_ssh':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                break;
            }
            
            await bot.sendMessage(chatId, `🔌 *جاري تشغيل SSHX داخل ${activeContainer}...*\nقد يستغرق هذا بضع ثوانٍ.`, { parse_mode: 'Markdown' });
            
            try {
                // محاولة تشغيل sshx داخل الـ container
                let sshLink = null;
                try {
                    const output = await runCommand(`docker exec ${activeContainer} sh -c "which sshx || (curl -fsSL https://sshx.io/get | sh)" 2>/dev/null`);
                    const linkOutput = await runCommand(`docker exec ${activeContainer} sshx --timeout 3600 2>&1`);
                    const match = linkOutput.match(/https:\/\/sshx\.io\/[a-zA-Z0-9_-]+/);
                    sshLink = match ? match[0] : null;
                } catch (e) {
                    // إذا فشل، نحاول تشغيله على الهوست
                    const hostOutput = await runCommand(`sshx --timeout 3600 2>&1`);
                    const hostMatch = hostOutput.match(/https:\/\/sshx\.io\/[a-zA-Z0-9_-]+/);
                    sshLink = hostMatch ? hostMatch[0] : null;
                }
                
                if (sshLink) {
                    const opts = {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🌐 فتح الرابط', url: sshLink }],
                                [{ text: '◀️ رجوع للتحكم', callback_data: 'manage_menu' }]
                            ]
                        }
                    };
                    await bot.sendMessage(chatId, `🔗 *رابط SSHX:*\n${sshLink}\n\nالرابط صالح لمدة ساعة واحدة.`, { parse_mode: 'Markdown', ...opts });
                } else {
                    await bot.sendMessage(chatId, `❌ فشل في تشغيل SSHX.\nتأكد من تثبيته على جهاز الهوست أو داخل الـ container.\n\nلتثبيت SSHX:\n\`curl -fsSL https://sshx.io/get | sh\``, { parse_mode: 'Markdown' });
                }
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ في SSHX:\n\`${error}\``, { parse_mode: 'Markdown' });
            }
            break;
            
        case 'container_status':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                break;
            }
            try {
                const status = await getContainerStatus(activeContainer);
                const inspect = await runCommand(`docker inspect ${activeContainer} --format='{{.Created}}|{{.Image}}|{{.State.Status}}|{{.State.Running}}'`);
                const opts = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '◀️ رجوع', callback_data: 'manage_menu' }]
                        ]
                    }
                };
                await bot.sendMessage(chatId, `📊 *حالة ${activeContainer}*\n\n🟢 الحالة: ${status}\n📅 تاريخ الإنشاء: ${inspect.split('|')[0]}\n🐳 الصورة: ${inspect.split('|')[1]}\n🔄 يعمل: ${inspect.split('|')[3] === 'true' ? 'نعم' : 'لا'}`, { parse_mode: 'Markdown', ...opts });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ: ${error}`);
            }
            break;
            
        case 'container_logs':
            if (!activeContainer) {
                await bot.sendMessage(chatId, '❌ لا يوجد container نشط.');
                break;
            }
            await bot.sendMessage(chatId, `📜 *جلب آخر 50 سطر من logs ${activeContainer}...*`, { parse_mode: 'Markdown' });
            try {
                const logs = await runCommand(`docker logs --tail 50 ${activeContainer} 2>&1`);
                const logText = logs.length > 4000 ? logs.substring(0, 4000) + '\n\n... (مقطوع للطول)' : logs;
                await bot.sendMessage(chatId, `\`\`\`\n${logText || '(لا توجد logs)'}\n\`\`\``, { parse_mode: 'Markdown' });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ خطأ في جلب logs: ${error}`);
            }
            await showManageMenu(chatId);
            break;
    }
});

// أمر /start العادي
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcome = `🐳 *مرحباً بك في بوت إدارة Docker!*\n\n*الأوامر المتاحة:*\n\n📦 \`!make\` - إنشاء Container جديد (يمكن إنشاء واحد فقط)\n\n🎮 \`!manage\` - فتح لوحة التحكم لإدارة الـ container\n\n*الميزات:*\n• Start / Stop / Restart\n• حذف الـ container\n• SSH عبر sshx (رابط مؤقت)\n• عرض الحالة والـ logs\n\n*ملاحظة:* يمكنك إنشاء Container واحد فقط في كل مرة.`;
    
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📦 إنشاء Container', callback_data: 'make_container' }],
                [{ text: '🎮 لوحة التحكم', callback_data: 'manage_menu' }]
            ]
        }
    };
    bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown', ...opts });
});

// استعادة الـ container السابق لو موجود
if (fs.existsSync('container.json')) {
    try {
        const saved = JSON.parse(fs.readFileSync('container.json', 'utf-8'));
        if (saved.name) {
            containerExists(saved.name).then(exists => {
                if (exists) {
                    activeContainer = saved.name;
                    containerInfo = saved;
                    console.log(`✅ تم استعادة container: ${activeContainer}`);
                }
            });
        }
    } catch(e) {}
}

console.log('🚀 بوت Docker شغال!');
console.log('الأوامر: !make | !manage');
console.log('✅ يمكنك التحكم بـ Container واحد فقط');
