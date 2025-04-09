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

// Updated table schema with username, single number per row
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
    const userId = msg.from.id; // Unique Telegram user ID
    const username = msg.from.username || 'N/A'; // Capture username, default to 'N/A' if not set
    const text = msg.text;

    if (!text) return;

    // Split by newlines or spaces, filter out empty strings
    const rawNumbers = text.split(/[\n\s]+/).filter(Boolean);

    // Normalize phone numbers
    const validNumbers = rawNumbers.map(normalizePhoneNumber).filter(Boolean);

    if (validNumbers.length === 0) {
        bot.sendMessage(chatId, 'Please send US/Canada phone numbers (starting with +1).\nSingle number or multiple numbers separated by newlines.');
        return;
    }

    bot.sendMessage(chatId, `Checking ${validNumbers.length} numbers...`);

    console.log('Normalized Numbers:', validNumbers);

    const results = await checkNumbersOnWhatsApp(validNumbers);

    // Log each number and result as a separate row in SQLite
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
        // Remove spaces, dashes, and other non-numeric characters except +
        let cleaned = number.replace(/[^0-9+]/g, '');

        // Add +1 if missing
        if (!cleaned.startsWith('+1')) {
            if (cleaned.length === 10) {
                cleaned = '+1' + cleaned; // Assume US/Canada for 10-digit numbers
            } else if (!cleaned.startsWith('+')) {
                cleaned = '+' + cleaned;
            }
        }

        // Must start with +1 for US/Canada
        if (!cleaned.startsWith('+1')) {
            console.warn(`Non-US/Canada number skipped: ${number}`);
            return null;
        }

        // Remove leading zeros after country code
        cleaned = '+1' + cleaned.slice(2).replace(/^0+/, '');

        // Validate length (should be 12 characters: +1 and 10 digits)
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

    // Wait for client to be ready
    if (!client.info) {
        await new Promise(resolve => client.on('ready', resolve));
    }

    for (const number of numbers) {
        try {
            // Remove + for WhatsApp ID format
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

// Serve index.html at the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

// API endpoint for usage data
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});
