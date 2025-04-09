const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const path = require('path');

// Telegram Bot Token and Chat ID (replace with your own)
const TELEGRAM_BOT_TOKEN = '8012229791:AAFw7ojB0L61NrWwm0ZtAPubt60WNm_nQ78';
const CHAT_ID_FOR_QR_CODE = '7965121728';

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize WhatsApp Client
const client = new Client({
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// SQLite Database Setup
const db = new sqlite3.Database('./usage.db', (err) => {
    if (err) console.error('Database error:', err);
    else console.log('Connected to SQLite database');
});

// Usage table
db.run(`
    CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT,
        username TEXT,
        timestamp TEXT,
        number TEXT,
        result TEXT
    )
`);

// Users table for tracking Telegram users
db.run(`
    CREATE TABLE IF NOT EXISTS users (
        chatId TEXT PRIMARY KEY,
        userId TEXT,
        username TEXT,
        lastActive TEXT
    )
`);

// Handle WhatsApp QR Code
client.on('qr', (qr) => {
    console.log('Scan this QR code with your WhatsApp app:');
    qrcode.generate(qr, { small: true });
    bot.sendMessage(CHAT_ID_FOR_QR_CODE, `Scan this QR code to log in to WhatsApp:\n${qr}`);
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
});

client.on('auth_failure', () => {
    console.error('Authentication failed. Please restart the session.');
});

client.on('disconnected', () => {
    console.error('Disconnected from WhatsApp Web. Reconnecting...');
    client.initialize();
});

client.initialize();

// Listen for Telegram messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';
    const text = msg.text;

    if (!text) return;

    // Update or insert user info
    db.run(
        'INSERT OR REPLACE INTO users (chatId, userId, username, lastActive) VALUES (?, ?, ?, ?)',
        [chatId, userId, username, new Date().toISOString()],
        (err) => {
            if (err) console.error('Error storing user:', err);
        }
    );

    const rawNumbers = text.split(/[\n\s]+/).filter(Boolean);
    const validNumbers = rawNumbers.map(normalizePhoneNumber).filter(Boolean);

    if (validNumbers.length === 0) {
        bot.sendMessage(chatId, 'Please send US/Canada phone numbers (starting with +1).\nSingle number or multiple numbers separated by newlines.');
        return;
    }

    bot.sendMessage(chatId, `Checking ${validNumbers.length} numbers...`);

    console.log('Normalized Numbers:', validNumbers);

    const results = await checkNumbersOnWhatsApp(validNumbers);

    const timestamp = new Date().toISOString();
    for (let i = 0; i < validNumbers.length; i++) {
        db.run(
            'INSERT INTO usage (userId, username, timestamp, number, result) VALUES (?, ?, ?, ?, ?)',
            [userId, username, timestamp, validNumbers[i], results[i]],
            (err) => {
                if (err) console.error('Error logging usage:', err);
            }
        );
    }

    bot.sendMessage(chatId, results.join('\n'));
});

// Function to normalize phone numbers (US/Canada only)
function normalizePhoneNumber(number) {
    try {
        let cleaned = number.replace(/[^0-9+]/g, '');
        if (!cleaned.startsWith('+1')) {
            if (cleaned.length === 10) {
                cleaned = '+1' + cleaned;
            } else if (!cleaned.startsWith('+')) {
                cleaned = '+' + cleaned;
            }
        }
        if (!cleaned.startsWith('+1')) {
            console.warn(`Non-US/Canada number skipped: ${number}`);
            return null;
        }
        cleaned = '+1' + cleaned.slice(2).replace(/^0+/, '');
        if (cleaned.length !== 12) {
            console.warn(`Invalid US/Canada number skipped: ${number}`);
            return null;
        }
        return cleaned;
    } catch (error) {
        console.error(`Error normalizing number: ${number}`, error);
        return null;
    }
}

// Function to check numbers on WhatsApp
async function checkNumbersOnWhatsApp(numbers) {
    const results = [];
    if (!client.info) {
        await new Promise(resolve => client.on('ready', resolve));
    }
    for (const number of numbers) {
        try {
            const phoneNumber = number.replace('+', '');
            const whatsappId = `${phoneNumber}@c.us`;
            console.log('Checking WID:', whatsappId);
            const isRegistered = await client.isRegisteredUser(whatsappId);
            if (isRegistered) {
                results.push(`✅ ${number} is registered on WhatsApp.`);
            } else {
                results.push(`❌ ${number} is NOT registered on WhatsApp.`);
            }
        } catch (error) {
            console.error(`Error checking ${number}:`, error.message);
            results.push(`⚠️ Error checking ${number}: ${error.message}`);
        }
    }
    return results;
}

// Express Web Server for UI
const app = express();
app.use(express.static(path.join(__dirname, 'Public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.get('/usage', (req, res) => {
    db.all('SELECT * FROM usage ORDER BY timestamp DESC', (err, rows) => {
        if (err) {
            console.error('Error fetching usage:', err);
            res.status(500).send('Error fetching data');
        } else {
            res.json(rows);
        }
    });
});

app.post('/broadcast', express.json(), (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).send('Message is required');
    }
    db.all('SELECT chatId FROM users', (err, rows) => {
        if (err) {
            console.error('Error fetching users:', err);
            return res.status(500).send('Error fetching users');
        }
        const chatIds = rows.map(row => row.chatId);
        console.log(`Broadcasting to ${chatIds.length} users`);
        let successCount = 0;
        chatIds.forEach(chatId => {
            bot.sendMessage(chatId, `[Admin Broadcast]\n${message}`)
                .then(() => {
                    successCount++;
                    if (successCount === chatIds.length) {
                        res.send('Broadcast sent successfully');
                    }
                })
                .catch(error => {
                    console.error(`Failed to send to ${chatId}:`, error);
                    if (successCount + 1 === chatIds.length) {
                        res.status(500).send('Broadcast partially failed');
                    }
                });
        });
        if (chatIds.length === 0) {
            res.send('No users to broadcast to');
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
