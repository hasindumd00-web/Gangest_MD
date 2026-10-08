// ============================================================
// 🥷 HASINDU MD
// Created by Hasindu
// ============================================================

const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env')) {
    dotenv.config({ path: '.env' });
}

module.exports = {

    // ============================================================
    // 1. SESSION & DATABASE
    // ============================================================

    SESSION_ID: process.env.SESSION_ID || 'hasindu_md',

    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://imajithhasindu2_db_user:DhkJNVjDvLdc0vzO@cluster0.yl6bp78.mongodb.net/?appName=Cluster0',


    // ============================================================
    // 2. BOT INFORMATION
    // ============================================================

    PREFIX: process.env.PREFIX || '.',

    OWNER_NUMBER: process.env.OWNER_NUMBER || '94786173599',

    BOT_NAME: 'Hasindu MD',

    BOT_FOOTER: '👨‍💻 Hasindu-MD',

    WORK_TYPE: process.env.WORK_TYPE || 'public',


    // ============================================================
    // 3. STATUS FEATURES
    // ============================================================

    AUTO_VIEW_STATUS:
        process.env.AUTO_VIEW_STATUS || 'true',

    AUTO_LIKE_STATUS:
        process.env.AUTO_LIKE_STATUS || 'true',

    AUTO_LIKE_EMOJI: [
        '❤️',
        '👍',
        '😮',
        '😎',
        '🔥',
        '💫',
        '💎'
    ],

    AUTO_STATUS_REPLY:
        process.env.AUTO_STATUS_REPLY || 'false',

    AUTO_STATUS_MSG:
        process.env.AUTO_STATUS_MSG || 'Hello from HASINDU MD 🔥',


    // ============================================================
    // 4. CHAT & PRESENCE
    // ============================================================

    READ_MESSAGE:
        process.env.READ_MESSAGE || 'false',

    AUTO_TYPING:
        process.env.AUTO_TYPING || 'false',

    AUTO_RECORDING:
        process.env.AUTO_RECORDING || 'false',


    // ============================================================
    // 5. GROUP FEATURES
    // ============================================================

    WELCOME_ENABLE:
        process.env.WELCOME_ENABLE || 'true',

    GOODBYE_ENABLE:
        process.env.GOODBYE_ENABLE || 'true',

    WELCOME_MSG:
        process.env.WELCOME_MSG || null,

    GOODBYE_MSG:
        process.env.GOODBYE_MSG || null,

    WELCOME_IMAGE:
        process.env.WELCOME_IMAGE ||
        'https://files.catbox.moe/ezq6dm.jpeg',

    GOODBYE_IMAGE:
        process.env.GOODBYE_IMAGE ||
        'https://files.catbox.moe/ezq6dm.jpeg',

    GROUP_INVITE_LINK:
        process.env.GROUP_INVITE_LINK || '',


    // ============================================================
    // 6. ANTI CALL
    // ============================================================

    ANTI_CALL:
        process.env.ANTI_CALL || 'false',

    REJECT_MSG:
        process.env.REJECT_MSG ||
        '*📞 Call rejected automatically. No calls allowed.*',


    // ============================================================
    // 7. HASINDU MD IMAGE & CHANNEL
    // ============================================================

    IMAGE_PATH:
        process.env.IMAGE_PATH ||
        'https://files.catbox.moe/ezq6dm.jpeg',

    CHANNEL_LINK:
        process.env.CHANNEL_LINK ||
        'https://whatsapp.com/channel/0029VbEAEZMG8l5MxTCqxe0M',

    NEWSLETTER_JID:
        process.env.NEWSLETTER_JID ||
        '120363412673839541@newsletter',

    NEWSLETTER_NAME:
        process.env.NEWSLETTER_NAME ||
        'Hasindu MD',


    // ============================================================
    // 8. TELEGRAM
    // ============================================================
    // Telegram completely removed.
    // No Telegram token or Telegram chat ID is required.


    // ============================================================
    // 9. BUTTON / INTERACTIVE SUPPORT
    // ============================================================

    BUTTON_SUPPORT:
        process.env.BUTTON_SUPPORT || 'true',

    LIST_SUPPORT:
        process.env.LIST_SUPPORT || 'true',

    INTERACTIVE_SUPPORT:
        process.env.INTERACTIVE_SUPPORT || 'true'

};
