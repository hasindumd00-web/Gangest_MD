const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { groupEvents } = require('./lib/groupEvents');
const events = require('./hasindu');
const { sms } = require('./lib/msg');

const {
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');

const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');

const router = express.Router();

const prefix = config.PREFIX || '.';

connectdb();


// ============================================================
// ACTIVE SOCKETS
// ============================================================

const activeSockets = new Map();
const socketCreationTime = new Map();


// ============================================================
// MESSAGE STORE
// ============================================================

function createHasinduStore() {
    const store = {
        messages: {},

        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages) {
                    const jid = msg.key && msg.key.remoteJid;

                    if (!jid) continue;

                    if (!store.messages[jid]) {
                        store.messages[jid] = [];
                    }

                    store.messages[jid].push(msg);

                    if (store.messages[jid].length > 200) {
                        store.messages[jid].shift();
                    }
                }
            });
        },

        async loadMessage(jid, id) {
            if (!store.messages[jid]) return null;

            return (
                store.messages[jid].find(
                    m => m.key && m.key.id === id
                ) || null
            );
        }
    };

    return store;
}


// ============================================================
// UTILITY
// ============================================================

const createSerial = (size) =>
    crypto.randomBytes(size)
        .toString('hex')
        .slice(0, size);

const getGroupAdmins = (participants = []) => {
    const admins = [];

    for (const i of participants) {
        if (i.admin == null) continue;
        admins.push(i.id);
    }

    return admins;
};

function isNumberAlreadyConnected(number) {
    const n = String(number).replace(/[^0-9]/g, '');
    return activeSockets.has(n);
}

function getConnectionStatus(number) {
    const n = String(number).replace(/[^0-9]/g, '');

    const isConnected = activeSockets.has(n);
    const connectionTime = socketCreationTime.get(n);

    return {
        isConnected,

        connectionTime: connectionTime
            ? new Date(connectionTime).toLocaleString()
            : null,

        uptime: connectionTime
            ? Math.floor(
                (Date.now() - connectionTime) / 1000
            )
            : 0
    };
}


// ============================================================
// HASINDU MD LOGGER
// ============================================================

function hasinduLog(message, type = 'info') {
    const icons = {
        info: '📝',
        success: '✅',
        error: '❌',
        warning: '⚠️',
        debug: '🐛'
    };

    console.log(
        `${icons[type] || '📝'} [HASINDU MD] ${new Date().toISOString()}: ${message}`
    );
}


// ============================================================
// LOAD PLUGINS
// ============================================================

const pluginsDir = path.join(__dirname, 'plugins');

if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
}

const pluginFiles = fs
    .readdirSync(pluginsDir)
    .filter(file => file.endsWith('.js'));

hasinduLog(
    `Loading ${pluginFiles.length} plugins...`,
    'info'
);

for (const file of pluginFiles) {
    try {
        require(path.join(pluginsDir, file));

        hasinduLog(
            `Loaded plugin: ${file}`,
            'success'
        );

    } catch (e) {
        hasinduLog(
            `Failed to load plugin ${file}: ${e.message}`,
            'error'
        );
    }
}


// ============================================================
// ANTI CALL
// ============================================================

async function setupCallHandlers(socket, number) {

    socket.ev.on('call', async (calls) => {

        try {

            const userConfig =
                await getUserConfigFromMongoDB(number);

            if (
                String(userConfig?.ANTI_CALL || config.ANTI_CALL) !== 'true'
            ) {
                return;
            }

            for (const call of calls) {

                if (call.status !== 'offer') {
                    continue;
                }

                await socket.rejectCall(
                    call.id,
                    call.from
                );

                await socket.sendMessage(
                    call.from,
                    {
                        text:
                            userConfig?.REJECT_MSG ||
                            config.REJECT_MSG
                    }
                );

                hasinduLog(
                    `Auto-rejected call for ${number}`,
                    'info'
                );
            }

        } catch (err) {

            hasinduLog(
                `Anti-call error for ${number}: ${err.message}`,
                'error'
            );
        }
    });
}


// ============================================================
// AUTO RESTART
// ============================================================

function setupAutoRestart(socket, number) {

    let restartAttempts = 0;
    const maxRestartAttempts = 3;

    socket.ev.on(
        'connection.update',
        async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === 'open') {
                restartAttempts = 0;
                return;
            }

            if (connection !== 'close') {
                return;
            }

            const statusCode =
                lastDisconnect &&
                lastDisconnect.error &&
                lastDisconnect.error.output &&
                lastDisconnect.error.output.statusCode;

            const errorMessage =
                lastDisconnect &&
                lastDisconnect.error &&
                lastDisconnect.error.message;

            hasinduLog(
                `Connection closed for ${number}: ${statusCode} - ${errorMessage}`,
                'warning'
            );

            if (
                statusCode === 401 ||
                (errorMessage &&
                    errorMessage.includes('401'))
            ) {

                const sanitizedNumber =
                    String(number).replace(/[^0-9]/g, '');

                hasinduLog(
                    `Manual unlink detected for ${number}`,
                    'warning'
                );

                activeSockets.delete(
                    sanitizedNumber
                );

                socketCreationTime.delete(
                    sanitizedNumber
                );

                await deleteSessionFromMongoDB(
                    sanitizedNumber
                );

                await removeNumberFromMongoDB(
                    sanitizedNumber
                );

                return;
            }

            const isNormalError =
                statusCode === 408 ||
                (
                    errorMessage &&
                    errorMessage.includes(
                        'QR refs attempts ended'
                    )
                );

            if (isNormalError) {

                hasinduLog(
                    `Normal closure for ${number}`,
                    'info'
                );

                return;
            }

            if (restartAttempts < maxRestartAttempts) {

                restartAttempts++;

                hasinduLog(
                    `Reconnecting ${number} (${restartAttempts}/${maxRestartAttempts}) in 10s...`,
                    'warning'
                );

                const sanitizedNumber =
                    String(number).replace(/[^0-9]/g, '');

                activeSockets.delete(
                    sanitizedNumber
                );

                socketCreationTime.delete(
                    sanitizedNumber
                );

                await delay(10000);

                try {

                    const mockRes = {
                        headersSent: false,
                        send: () => {},
                        json: () => {},
                        status: () => mockRes,
                        setHeader: () => {}
                    };

                    await hasinduPair(
                        number,
                        mockRes
                    );

                } catch (e) {

                    hasinduLog(
                        `Reconnection failed for ${number}: ${e.message}`,
                        'error'
                    );
                }

            } else {

                hasinduLog(
                    `Max restart attempts reached for ${number}`,
                    'error'
                );
            }
        }
    );
}


// ============================================================
// PAIRING
// ============================================================

async function hasinduPair(
    number,
    res = null
) {

    let connectionLockKey;

    const sanitizedNumber =
        String(number).replace(/[^0-9]/g, '');

    try {

        if (!sanitizedNumber) {

            if (res && !res.headersSent) {
                return res.status(400).json({
                    error: 'Invalid number'
                });
            }

            return;
        }

        const sessionPath = path.join(
            __dirname,
            'session',
            `session_${sanitizedNumber}`
        );


        // ====================================================
        // ALREADY CONNECTED
        // ====================================================

        if (
            isNumberAlreadyConnected(
                sanitizedNumber
            )
        ) {

            const status =
                getConnectionStatus(
                    sanitizedNumber
                );

            if (res && !res.headersSent) {

                return res.json({
                    status: 'already_connected',
                    message:
                        'Number is already connected',
                    connectionTime:
                        status.connectionTime,
                    uptime:
                        `${status.uptime} seconds`
                });
            }

            return;
        }


        // ====================================================
        // CONNECTION LOCK
        // ====================================================

        connectionLockKey =
            `hasindu_lock_${sanitizedNumber}`;

        if (global[connectionLockKey]) {

            if (
                res &&
                !res.headersSent
            ) {
                return res.json({
                    status:
                        'connection_in_progress'
                });
            }

            return;
        }

        global[connectionLockKey] = true;


        // ====================================================
        // RESTORE SESSION
        // ====================================================

        const existingSession =
            await getSessionFromMongoDB(
                sanitizedNumber
            );

        if (!existingSession) {

            hasinduLog(
                `No MongoDB session for ${sanitizedNumber} — new pairing required`,
                'info'
            );

            if (
                fs.existsSync(sessionPath)
            ) {

                await fs.remove(
                    sessionPath
                );

                hasinduLog(
                    `Cleaned local session for ${sanitizedNumber}`,
                    'info'
                );
            }

        } else {

            fs.ensureDirSync(
                sessionPath
            );

            fs.writeFileSync(
                path.join(
                    sessionPath,
                    'creds.json'
                ),
                JSON.stringify(
                    existingSession,
                    null,
                    2
                )
            );

            hasinduLog(
                `Restored session from MongoDB for ${sanitizedNumber}`,
                'success'
            );
        }


        // ====================================================
        // AUTH
        // ====================================================

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            sessionPath
        );

        const logger = pino({
            level:
                process.env.NODE_ENV === 'production'
                    ? 'fatal'
                    : 'debug'
        });


        // ====================================================
        // STORE
        // ====================================================

        const hasinduStore =
            createHasinduStore();


        // ====================================================
        // WHATSAPP SOCKET
        // ====================================================

        const conn = makeWASocket({

            auth: {
                creds: state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
            },

            printQRInTerminal: false,

            logger: pino({
                level: 'silent'
            }),

            connectTimeoutMs: 60000,

            defaultQueryTimeoutMs: 0,

            keepAliveIntervalMs: 10000,

            emitOwnEvents: true,

            fireInitQueries: true,

            generateHighQualityLinkPreview: true,

            syncFullHistory: true,

            markOnlineOnConnect: false, // 👈 AUTO ONLINE OFF FIX

            browser: [
                'Mac OS',
                'Safari',
                '10.15.7'
            ],

            getMessage: async (key) => {

                const msg =
                    await hasinduStore.loadMessage(
                        key.remoteJid,
                        key.id
                    );

                return (
                    msg &&
                    msg.message
                )
                    ? msg.message
                    : {
                        conversation:
                            'HASINDU MD'
                    };
            }
        });


        socketCreationTime.set(
            sanitizedNumber,
            Date.now()
        );

        activeSockets.set(
            sanitizedNumber,
            conn
        );

        hasinduStore.bind(conn.ev);


        // ====================================================
        // HANDLERS
        // ====================================================

        setupCallHandlers(
            conn,
            sanitizedNumber
        );

        setupAutoRestart(
            conn,
            sanitizedNumber
        );


        // ====================================================
        // JID DECODER
        // ====================================================

        conn.decodeJid = (jid) => {

            if (!jid) return jid;

            if (/:\d+@/gi.test(jid)) {

                const decode =
                    jidDecode(jid) || {};

                return (
                    decode.user &&
                    decode.server
                )
                    ? `${decode.user}@${decode.server}`
                    : jid;
            }

            return jid;
        };


        // ====================================================
        // DOWNLOAD MEDIA
        // ====================================================

        conn.downloadAndSaveMediaMessage =
            async (
                message,
                filename,
                attachExtension = true
            ) => {

                const quoted =
                    message.msg
                        ? message.msg
                        : message;

                const mime =
                    (
                        message.msg ||
                        message
                    ).mimetype || '';

                const messageType =
                    message.mtype
                        ? message.mtype.replace(
                            /Message/gi,
                            ''
                        )
                        : mime.split('/')[0];

                const stream =
                    await downloadContentFromMessage(
                        quoted,
                        messageType
                    );

                let buffer = Buffer.from([]);

                for await (
                    const chunk of stream
                ) {
                    buffer = Buffer.concat([
                        buffer,
                        chunk
                    ]);
                }

                const type =
                    await FileType.fromBuffer(
                        buffer
                    );

                const trueFileName =
                    attachExtension && type
                        ? `${filename}.${type.ext}`
                        : filename;

                await fs.writeFile(
                    trueFileName,
                    buffer
                );

                return trueFileName;
            };


        // ====================================================
        // PAIRING CODE
        // ====================================================

        if (!conn.authState.creds.registered) {

            hasinduLog(
                `Starting NEW pairing process for ${sanitizedNumber}`,
                'info'
            );

            try {

                await delay(1500);

                const code =
                    await conn.requestPairingCode(
                        sanitizedNumber
                    );

                hasinduLog(
                    `Pairing Code for ${sanitizedNumber}: ${code}`,
                    'success'
                );

                if (
                    res &&
                    !res.headersSent
                ) {

                    res.send({
                        code,
                        status: 'new_pairing'
                    });
                }

            } catch (error) {

                hasinduLog(
                    `Failed to request pairing code: ${error.message}`,
                    'error'
                );

                if (
                    res &&
                    !res.headersSent
                ) {

                    res.status(500).send({
                        error:
                            'Failed to get pairing code',
                        status: 'error',
                        message:
                            error.message
                    });
                }

                throw error;
            }

        } else {

            hasinduLog(
                `Using existing session for ${sanitizedNumber}`,
                'success'
            );

            if (
                res &&
                !res.headersSent
            ) {

                res.json({
                    status: 'reconnecting',
                    message:
                        'Reconnecting with existing session'
                });
            }
        }


        // ====================================================
        // SAVE CREDS
        // ====================================================

        conn.ev.on(
            'creds.update',
            async () => {

                try {

                    await saveCreds();

                    const credsPath =
                        path.join(
                            sessionPath,
                            'creds.json'
                        );

                    if (
                        !fs.existsSync(
                            credsPath
                        )
                    ) {
                        return;
                    }

                    const fileContent =
                        await fs.readFile(
                            credsPath,
                            'utf8'
                        );

                    const creds =
                        JSON.parse(
                            fileContent
                        );

                    const existingSessionCheck =
                        await getSessionFromMongoDB(
                            sanitizedNumber
                        );

                    const isNewSession =
                        !existingSessionCheck;

                    await saveSessionToMongoDB(
                        sanitizedNumber,
                        creds
                    );

                    if (isNewSession) {

                        hasinduLog(
                            `NEW user ${sanitizedNumber} successfully registered!`,
                            'success'
                        );
                    }

                } catch (err) {

                    hasinduLog(
                        `Creds save error: ${err.message}`,
                        'error'
                    );
                }
            }
        );


        // ====================================================
        // ANTIDELETE
        // ====================================================

        conn.ev.on(
            'messages.update',
            async (updates) => {

                try {

                    await handleAntidelete(
                        conn,
                        updates,
                        hasinduStore
                    );

                } catch (err) {

                    hasinduLog(
                        `Antidelete error: ${err.message}`,
                        'error'
                    );
                }
            }
        );


        // ====================================================
        // GROUP EVENTS
        // IMPORTANT:
        // This must NOT be inside messages.upsert.
        // ====================================================

        conn.ev.on(
            'group-participants.update',
            async (update) => {

                try {

                    await groupEvents(
                        conn,
                        update
                    );

                } catch (err) {

                    hasinduLog(
                        `Group event error: ${err.message}`,
                        'error'
                    );
                }
            }
        );


        // ====================================================
        // CONNECTION UPDATE
        // ====================================================

        conn.ev.on(
            'connection.update',
            async (update) => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                if (connection === 'open') {

                    try {

                        hasinduLog(
                            `Connected: ${sanitizedNumber}`,
                            'success'
                        );

                        await addNumberToMongoDB(
                            sanitizedNumber
                        );

                        const userJid =
                            jidNormalizedUser(
                                conn.user.id
                            );

                        const userConfig = await getUserConfigFromMongoDB(sanitizedNumber);
                        const currentMode = userConfig?.WORK_TYPE || config.WORK_TYPE || 'public';

                        // Dynamic Always Online check on connect
                        const isAlwaysOnline = String(userConfig?.ALWAYS_ONLINE || config.ALWAYS_ONLINE) === 'true';
                        if (isAlwaysOnline) {
                            await conn.sendPresenceUpdate('available');
                        } else {
                            await conn.sendPresenceUpdate('unavailable');
                        }

                        // Send connected message
                        // only for a new session.

                        if (!existingSession) {

                            await conn.sendMessage(
                                userJid,
                                {
                                    image: {
                                        url:
                                            config.IMAGE_PATH
                                    },

                                    caption:
`╭────────────────────◇
│ ✦ *🥷⃝Ｈａｓｉｎｄｕ MD — CONNECTED* 🔥
│
│ ✦ Type *${prefix}menu* to see all commands 💫
│ ✦ Prefix 『 ${prefix} 』
│ ✦ Mode 〔${currentMode}〕
╰────────────────────○
*© Created by Hasindu*`
                                }
                            );
                        }

                    } catch (err) {

                        hasinduLog(
                            `Open connection error: ${err.message}`,
                            'error'
                        );
                    }
                }

                if (connection === 'close') {

                    const reason =
                        lastDisconnect &&
                        lastDisconnect.error &&
                        lastDisconnect.error.output &&
                        lastDisconnect.error.output.statusCode;

                    if (
                        reason ===
                        DisconnectReason.loggedOut
                    ) {

                        hasinduLog(
                            `Session logged out: ${sanitizedNumber}`,
                            'error'
                        );
                    }
                }
            }
        );


        // ====================================================
        // MESSAGES
        // ====================================================

        conn.ev.on(
            'messages.upsert',
            async (msg) => {

                try {

                    if (
                        !msg ||
                        !msg.messages ||
                        !msg.messages.length
                    ) {
                        return;
                    }

                    let mek =
                        msg.messages[0];

                    if (
                        !mek ||
                        !mek.message
                    ) {
                        return;
                    }


                    // ==================================================
                    // USER CONFIG
                    // ==================================================

                    const userConfig =
                        (await getUserConfigFromMongoDB(
                            sanitizedNumber
                        )) || {};


                    // Dynamic mode checking from database or config
                    const activeWorkType = (userConfig.WORK_TYPE || config.WORK_TYPE || 'public').toLowerCase();


                    // ==================================================
                    // DYNAMIC ALWAYS ONLINE CHECK
                    // ==================================================

                    const isAlwaysOnline = String(userConfig.ALWAYS_ONLINE || config.ALWAYS_ONLINE) === 'true';
                    if (isAlwaysOnline) {
                        try { await conn.sendPresenceUpdate('available'); } catch (_) {}
                    } else {
                        try { await conn.sendPresenceUpdate('unavailable'); } catch (_) {}
                    }


                    // ==================================================
                    // EPHEMERAL
                    // ==================================================

                    if (
                        mek.message
                            .ephemeralMessage
                    ) {

                        mek.message =
                            mek.message
                                .ephemeralMessage
                                .message;
                    }


                    // ==================================================
                    // VIEW ONCE
                    // ==================================================

                    if (
                        mek.message
                            .viewOnceMessageV2
                    ) {

                        mek.message =
                            mek.message
                                .viewOnceMessageV2
                                .message;
                    }

                    if (
                        mek.message
                            .viewOnceMessage
                    ) {

                        mek.message =
                            mek.message
                                .viewOnceMessage
                                .message;
                    }


                    // ==================================================
                    // READ MESSAGE
                    // ==================================================

                    if (
                        String(
                            userConfig.READ_MESSAGE
                        ) === 'true'
                    ) {

                        try {
                            await conn.readMessages([
                                mek.key
                            ]);
                        } catch (_) {}
                    }


                    // ==================================================
                    // NEWSLETTER REACTION
                    // ==================================================

                    const newsletterJids = [
                        config.NEWSLETTER_JID ||
                        '120363412673839541@newsletter'
                    ];

                    const newsEmojis = [
                        '❤️',
                        '👍',
                        '😮',
                        '😎',
                        '💀',
                        '💫',
                        '🔥',
                        '👑'
                    ];

                    const remoteJid =
                        mek.key &&
                        mek.key.remoteJid;

                    if (
                        remoteJid &&
                        newsletterJids.includes(
                            remoteJid
                        )
                    ) {

                        try {

                            const serverId =
                                mek.newsletterServerId;

                            if (serverId) {

                                const emoji =
                                    newsEmojis[
                                        Math.floor(
                                            Math.random() *
                                            newsEmojis.length
                                        )
                                    ];

                                await conn.newsletterReactMessage(
                                    remoteJid,
                                    serverId.toString(),
                                    emoji
                                );
                            }

                        } catch (_) {}
                    }


                    // ==================================================
                    // STATUS
                    // ==================================================

                    if (
                        remoteJid ===
                        'status@broadcast'
                    ) {

                        if (
                            String(
                                userConfig.AUTO_VIEW_STATUS
                            ) === 'true'
                        ) {

                            try {
                                await conn.readMessages([
                                    mek.key
                                ]);
                            } catch (_) {}
                        }


                        if (
                            String(
                                userConfig.AUTO_LIKE_STATUS
                            ) === 'true'
                        ) {

                            try {

                                const botJid =
                                    await conn.decodeJid(
                                        conn.user.id
                                    );

                                const emojis =
                                    userConfig.AUTO_LIKE_EMOJI ||
                                    config.AUTO_LIKE_EMOJI;

                                if (
                                    Array.isArray(
                                        emojis
                                    ) &&
                                    emojis.length
                                ) {

                                    const randomEmoji =
                                        emojis[
                                            Math.floor(
                                                Math.random() *
                                                emojis.length
                                            )
                                        ];

                                    await conn.sendMessage(
                                        remoteJid,
                                        {
                                            react: {
                                                text:
                                                    randomEmoji,
                                                key:
                                                    mek.key
                                            }
                                        },
                                        {
                                            statusJidList: [
                                                mek.key.participant,
                                                botJid
                                            ]
                                        }
                                    );
                                }

                            } catch (_) {}
                        }


                        if (
                            String(
                                userConfig.AUTO_STATUS_REPLY
                            ) === 'true'
                        ) {

                            try {

                                const user =
                                    mek.key.participant;

                                await conn.sendMessage(
                                    user,
                                    {
                                        text:
                                            userConfig.AUTO_STATUS_MSG ||
                                            config.AUTO_STATUS_MSG
                                    },
                                    {
                                        quoted: mek
                                    }
                                );

                            } catch (_) {}
                        }

                        return;
                    }


                    // ==================================================
                    // SMS PARSER
                    // ==================================================

                    const m =
                        sms(conn, mek);

                    if (!m) return;


                    // ==================================================
                    // IMPORTANT:
                    // USE m.body
                    // ==================================================

                    const body =
                        String(
                            m.body || ''
                        ).trim();


                    // ==================================================
                    // MESSAGE TYPE
                    // ==================================================

                    const type =
                        m.mtype ||
                        getContentType(
                            mek.message
                        );


                    const from =
                        mek.key.remoteJid;


                    // ==================================================
                    // COMMAND PARSING
                    // ==================================================

                    const isCmd =
                        body.startsWith(
                            prefix
                        );

                    const command =
                        isCmd
                            ? body
                                .slice(prefix.length)
                                .trim()
                                .split(/\s+/)
                                .shift()
                                .toLowerCase()
                            : '';

                    const args =
                        isCmd
                            ? body
                                .slice(prefix.length)
                                .trim()
                                .split(/\s+/)
                                .slice(1)
                            : [];

                    const q =
                        args.join(' ');

                    const text = q;


                    // ==================================================
                    // GROUP
                    // ==================================================

                    const isGroup =
                        Boolean(
                            from &&
                            from.endsWith(
                                '@g.us'
                            )
                        );


                    // ==================================================
                    // SENDER
                    // ==================================================

                    const sender =
                        mek.key.fromMe

                            ? (
                                conn.user.id
                                    .split(':')[0] +
                                '@s.whatsapp.net'
                            )

                            : (
                                mek.key.participant ||
                                mek.key.remoteJid
                            );


                    const senderNumber =
                        sender
                            .split('@')[0]
                            .split(':')[0]
                            .replace(/[^0-9]/g, '');


                    const botNumber =
                        conn.user.id
                            .split(':')[0]
                            .replace(/[^0-9]/g, '');


                    const botNumber2 =
                        await jidNormalizedUser(
                            conn.user.id
                        );


                    const pushname =
                        mek.pushName ||
                        'User';


                    // ==================================================
                    // OWNER CHECK FIX
                    // ==================================================

                    const isMe =
                        botNumber ===
                        senderNumber;


                    const ownerNumber =
                        String(
                            userConfig.OWNER_NUMBER || config.OWNER_NUMBER || ''
                        )
                        .replace(
                            /[^0-9]/g,
                            ''
                        );


                    const isOwner =
                        mek.key.fromMe ||
                        isMe ||
                        (
                            ownerNumber &&
                            ownerNumber ===
                            senderNumber
                        );


                    const isCreator =
                        isOwner;


                    // ==================================================
                    // 🔒 STRICT PRIVATE MODE CHECK WITH ERROR MESSAGE
                    // ==================================================

                    if (activeWorkType === 'private' && !isOwner) {
                        if (isCmd) {
                            await conn.sendMessage(from, {
                                text: `⚠️ *ACCESS DENIED!*\n\n` +
                                      `🤖 *Bot Name:* ${config.BOT_NAME}\n` +
                                      `🔒 *Status:* Currently in *PRIVATE MODE*.\n` +
                                      `👤 *Access:* Only the Owner (${ownerNumber || config.OWNER_NUMBER}) can use commands.`
                            }, { quoted: mek });
                        }
                        return; // Stop execution for non-owner immediately
                    }


                    // ==================================================
                    // GROUP DATA
                    // ==================================================

                    let groupMetadata = null;
                    let groupName = null;
                    let participants = null;
                    let groupAdmins = null;
                    let isBotAdmins = null;
                    let isAdmins = null;


                    if (isGroup) {

                        try {

                            groupMetadata =
                                await conn.groupMetadata(
                                    from
                                );

                            groupName =
                                groupMetadata.subject;

                            participants =
                                groupMetadata.participants;

                            groupAdmins =
                                getGroupAdmins(
                                    participants
                                );

                            isBotAdmins =
                                groupAdmins.includes(
                                    botNumber2
                                );

                            isAdmins =
                                groupAdmins.includes(
                                    sender
                                );

                        } catch (_) {}
                    }


                    // ==================================================
                    // TYPING / RECORDING
                    // ==================================================

                    if (
                        String(
                            userConfig.AUTO_TYPING
                        ) === 'true'
                    ) {

                        try {
                            await conn.sendPresenceUpdate(
                                'composing',
                                from
                            );
                        } catch (_) {}
                    }


                    if (
                        String(
                            userConfig.AUTO_RECORDING
                        ) === 'true'
                    ) {

                        try {
                            await conn.sendPresenceUpdate(
                                'recording',
                                from
                            );
                        } catch (_) {}
                    }


                    // ==================================================
                    // QUOTED CONTACT
                    // ==================================================

                    const myquoted = {

                        key: {
                            remoteJid:
                                'status@broadcast',

                            participant:
                                '13135550002@s.whatsapp.net',

                            fromMe: false,

                            id:
                                createSerial(16)
                                    .toUpperCase()
                        },

                        message: {
                            contactMessage: {

                                displayName:
                                    '🥷⃝Ｈａｓｉｎｄｕ MD',

                                vcard:
`BEGIN:VCARD
VERSION:3.0
FN:Hasindu MD
ORG:HASINDU MD;
TEL;type=CELL;type=VOICE;waid=94786173599:94786173599
END:VCARD`,

                                contextInfo: {
                                    stanzaId:
                                        createSerial(16)
                                            .toUpperCase(),

                                    participant:
                                        '0@s.whatsapp.net',

                                    quotedMessage: {
                                        conversation:
                                            '© HASINDU MD'
                                    }
                                }
                            }
                        },

                        messageTimestamp:
                            Math.floor(
                                Date.now() / 1000
                            ),

                        status: 1,

                        verifiedBizName:
                            'Meta'
                    };


                    // ==================================================
                    // REPLY
                    // ==================================================

                    const reply =
                        (replyText) =>
                            conn.sendMessage(
                                from,
                                {
                                    text:
                                        replyText
                                },
                                {
                                    quoted:
                                        myquoted
                                }
                            );

                    const l = reply;


                    // ==================================================
                    // COMMAND HANDLER
                    // ==================================================

                    if (isCmd) {

                        await incrementStats(
                            sanitizedNumber,
                            'commandsUsed'
                        );

                        const cmd =
                            events.commands.find(
                                c =>
                                    c.pattern ===
                                    command
                            ) ||

                            events.commands.find(
                                c =>
                                    Array.isArray(
                                        c.alias
                                    ) &&
                                    c.alias.includes(
                                        command
                                    )
                            );


                        if (cmd) {

                            if (cmd.react) {

                                try {

                                    await conn.sendMessage(
                                        from,
                                        {
                                            react: {
                                                text:
                                                    cmd.react,
                                                key:
                                                    mek.key
                                            }
                                        }
                                    );

                                } catch (_) {}
                            }


                            try {

                                await cmd.function(
                                    conn,
                                    mek,
                                    m,
                                    {
                                        from,
                                        quoted: mek,
                                        body,
                                        isCmd,
                                        command,
                                        args,
                                        q,
                                        text,
                                        isGroup,
                                        sender,
                                        senderNumber,
                                        botNumber2,
                                        botNumber,
                                        pushname,
                                        isMe,
                                        isOwner,
                                        isCreator,
                                        groupMetadata,
                                        groupName,
                                        participants,
                                        groupAdmins,
                                        isBotAdmins,
                                        isAdmins,
                                        reply,
                                        config,
                                        prefix,
                                        myquoted,

                                        // BUTTON DATA
                                        buttonId:
                                            m.buttonId ||
                                            body,

                                        selectedId:
                                            m.buttonId ||
                                            body
                                    }
                                );

                            } catch (e) {

                                hasinduLog(
                                    `PLUGIN ERROR [${command}]: ${e.message}`,
                                    'error'
                                );
                            }
                        }
                    }


                    // ==================================================
                    // MESSAGE STATS
                    // ==================================================

                    await incrementStats(
                        sanitizedNumber,
                        'messagesReceived'
                    );

                    if (isGroup) {

                        await incrementStats(
                            sanitizedNumber,
                            'groupsInteracted'
                        );
                    }


                    // ==================================================
                    // EVENT COMMANDS
                    // ==================================================

                    events.commands.forEach(
                        async (evCmd) => {

                            try {

                                const ctx = {

                                    from,

                                    l,

                                    quoted: mek,

                                    body,

                                    isCmd,

                                    command,

                                    args,

                                    q,

                                    text,

                                    isGroup,

                                    sender,

                                    senderNumber,

                                    botNumber2,

                                    botNumber,

                                    pushname,

                                    isMe,

                                    isOwner,

                                    isCreator,

                                    groupMetadata,

                                    groupName,

                                    participants,

                                    groupAdmins,

                                    isBotAdmins,

                                    isAdmins,

                                    reply,

                                    config,

                                    prefix,

                                    myquoted,

                                    buttonId:
                                        m.buttonId ||
                                        body,

                                    selectedId:
                                        m.buttonId ||
                                        body
                                };


                                // BODY
                                if (
                                    body &&
                                    evCmd.on ===
                                        'body'
                                ) {

                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );

                                    return;
                                }


                                // TEXT
                                if (
                                    body &&
                                    evCmd.on ===
                                        'text'
                                ) {

                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );

                                    return;
                                }


                                // IMAGE
                                if (
                                    (
                                        evCmd.on ===
                                            'image' ||
                                        evCmd.on ===
                                            'photo'
                                    ) &&
                                    type ===
                                        'imageMessage'
                                ) {

                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );

                                    return;
                                }


                                // STICKER
                                if (
                                    evCmd.on ===
                                        'sticker' &&
                                    type ===
                                        'stickerMessage'
                                ) {

                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );
                                }

                            } catch (err) {

                                hasinduLog(
                                    `Event error: ${err.message}`,
                                    'error'
                                );
                            }
                        }
                    );

                } catch (e) {

                    hasinduLog(
                        `Message handler error: ${e.message}`,
                        'error'
                    );
                }
            }
        );

    } catch (err) {

        hasinduLog(
            `hasinduPair error: ${err.message}`,
            'error'
        );

        if (
            res &&
            !res.headersSent
        ) {

            return res.json({
                error:
                    'Internal Server Error',

                details:
                    err.message
            });
        }

    } finally {

        if (connectionLockKey) {
            global[connectionLockKey] = false;
        }
    }
}


// ============================================================
// ROUTES
// ============================================================

router.get(
    '/',
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                'pair.html'
            )
        );
    }
);


// ============================================================
// PAIR CODE
// ============================================================

router.get(
    '/code',
    async (req, res) => {

        if (!req.query.number) {

            return res.status(400).json({
                error:
                    'Number required'
            });
        }

        await hasinduPair(
            req.query.number,
            res
        );
    }
);


// ============================================================
// STATUS
// ============================================================

router.get(
    '/status',
    async (req, res) => {

        const {
            number
        } = req.query;

        if (!number) {

            const list =
                Array.from(
                    activeSockets.keys()
                ).map(n => {

                    const s =
                        getConnectionStatus(n);

                    return {
                        number: n,
                        status: 'connected',
                        connectionTime:
                            s.connectionTime,
                        uptime:
                            `${s.uptime} seconds`
                    };
                });

            return res.json({
                totalActive:
                    activeSockets.size,

                connections:
                    list
            });
        }

        const s =
            getConnectionStatus(
                number
            );

        res.json({
            number,

            isConnected:
                s.isConnected,

            connectionTime:
                s.connectionTime,

            uptime:
                `${s.uptime} seconds`
        });
    }
);


// ============================================================
// DISCONNECT
// ============================================================

router.get(
    '/disconnect',
    async (req, res) => {

        const {
            number
        } = req.query;

        if (!number) {

            return res.status(400).json({
                error:
                    'Number required'
            });
        }

        const n =
            String(number)
                .replace(
                    /[^0-9]/g,
                    ''
                );

        if (
            !activeSockets.has(n)
        ) {

            return res.status(404).json({
                error:
                    'Not found'
            });
        }

        try {

            const socket =
                activeSockets.get(n);

            try {
                await socket.ws.close();
            } catch (_) {}

            socket.ev.removeAllListeners();

            activeSockets.delete(n);

            socketCreationTime.delete(n);

            await removeNumberFromMongoDB(n);

            await deleteSessionFromMongoDB(n);

            res.json({
                status:
                    'success',

                message:
                    'Disconnected'
            });

        } catch (e) {

            res.status(500).json({
                error:
                    'Failed to disconnect'
            });
        }
    }
);


// ============================================================
// ACTIVE
// ============================================================

router.get(
    '/active',
    (req, res) => {

        res.json({
            count:
                activeSockets.size,

            numbers:
                Array.from(
                    activeSockets.keys()
                )
        });
    }
);


// ============================================================
// PING
// ============================================================

router.get(
    '/ping',
    (req, res) => {

        res.json({

            status:
                'active',

            message:
                'HASINDU MD is running 🔥',

            activeSessions:
                activeSockets.size
        });
    }
);


// ============================================================
// CONNECT ALL
// ============================================================

router.get(
    '/connect-all',
    async (req, res) => {

        try {

            const numbers =
                await getAllNumbersFromMongoDB();

            if (!numbers.length) {

                return res.status(404).json({
                    error:
                        'No numbers found'
                });
            }

            const results = [];

            for (
                const number of numbers
            ) {

                if (
                    activeSockets.has(
                        number
                    )
                ) {

                    results.push({
                        number,
                        status:
                            'already_connected'
                    });

                    continue;
                }

                const mockRes = {

                    headersSent:
                        false,

                    json:
                        () => {},

                    send:
                        () => {},

                    status:
                        () => mockRes
                };

                await hasinduPair(
                    number,
                    mockRes
                );

                results.push({
                    number,
                    status:
                        'connection_initiated'
                });

                await delay(1000);
            }

            res.json({

                status:
                    'success',

                total:
                    numbers.length,

                connections:
                    results
            });

        } catch (e) {

            res.status(500).json({
                error:
                    'Failed'
            });
        }
    }
);


// ============================================================
// UPDATE CONFIG
// ============================================================

router.get(
    '/update-config',
    async (req, res) => {

        const {
            number,
            config: configString
        } = req.query;

        if (
            !number ||
            !configString
        ) {

            return res.status(400).json({
                error:
                    'Number and config required'
            });
        }

        let newConfig;

        try {

            newConfig =
                JSON.parse(
                    configString
                );

        } catch (_) {

            return res.status(400).json({
                error:
                    'Invalid config'
            });
        }

        const n =
            String(number)
                .replace(
                    /[^0-9]/g,
                    ''
                );

        const socket =
            activeSockets.get(n);

        if (!socket) {

            return res.status(404).json({
                error:
                    'No active session'
            });
        }

        const otp =
            Math.floor(
                100000 +
                Math.random() *
                900000
            ).toString();

        await saveOTPToMongoDB(
            n,
            otp,
            newConfig
        );

        try {

            await socket.sendMessage(
                jidNormalizedUser(
                    socket.user.id
                ),
                {
                    text:
`*🔐 HASINDU MD — CONFIG UPDATE*

OTP: *${otp}*
Valid for 5 minutes`
                }
            );

            res.json({
                status:
                    'otp_sent'
            });

        } catch (e) {

            res.status(500).json({
                error:
                    'Failed to send OTP'
            });
        }
    }
);


// ============================================================
// VERIFY OTP
// ============================================================

router.get(
    '/verify-otp',
    async (req, res) => {

        const {
            number,
            otp
        } = req.query;

        if (
            !number ||
            !otp
        ) {

            return res.status(400).json({
                error:
                    'Number and OTP required'
            });
        }

        const n =
            String(number)
                .replace(
                    /[^0-9]/g,
                    ''
                );

        const verification =
            await verifyOTPFromMongoDB(
                n,
                otp
            );

        if (!verification.valid) {

            return res.status(400).json({
                error:
                    verification.error
            });
        }

        await updateUserConfigInMongoDB(
            n,
            verification.config
        );

        const socket =
            activeSockets.get(n);

        if (socket) {

            await socket.sendMessage(
                jidNormalizedUser(
                    socket.user.id
                ),
                {
                    text:
                        '*✅ HASINDU MD CONFIG UPDATED*'
                }
            );
        }

        res.json({
            status:
                'success'
        });
    }
);


// ============================================================
// STATS
// ============================================================

router.get(
    '/stats',
    async (req, res) => {

        const {
            number
        } = req.query;

        if (!number) {

            return res.status(400).json({
                error:
                    'Number required'
            });
        }

        try {

            const stats =
                await getStatsForNumber(
                    number
                );

            const n =
                String(number)
                    .replace(
                        /[^0-9]/g,
                        ''
                    );

            const s =
                getConnectionStatus(n);

            res.json({

                number: n,

                connectionStatus:
                    s.isConnected
                        ? 'Connected'
                        : 'Disconnected',

                uptime:
                    s.uptime,

                stats
            });

        } catch (e) {

            res.status(500).json({
                error:
                    'Failed'
            });
        }
    }
);


// ============================================================
// AUTO RECONNECT
// ============================================================

async function autoReconnectFromMongoDB() {

    try {

        hasinduLog(
            'Attempting auto-reconnect from MongoDB...',
            'info'
        );

        const numbers =
            await getAllNumbersFromMongoDB();

        if (!numbers.length) {

            hasinduLog(
                'No numbers in MongoDB',
                'info'
            );

            return;
        }

        for (
            const number of numbers
        ) {

            if (
                !activeSockets.has(number)
            ) {

                const mockRes = {

                    headersSent:
                        false,

                    json:
                        () => {},

                    send:
                        () => {},

                    status:
                        () => mockRes
                };

                await hasinduPair(
                    number,
                    mockRes
                );

                await delay(2000);
            }
        }

        hasinduLog(
            'Auto-reconnect completed',
            'success'
        );

    } catch (e) {

        hasinduLog(
            `autoReconnectFromMongoDB error: ${e.message}`,
            'error'
        );
    }
}


// ============================================================
// START AUTO RECONNECT
// ============================================================

setTimeout(
    () => {
        autoReconnectFromMongoDB();
    },
    3000
);


// ============================================================
// PROCESS EVENTS
// ============================================================

process.on(
    'exit',
    () => {

        activeSockets.forEach(
            (socket, number) => {

                try {
                    socket.ws.close();
                } catch (_) {}

                activeSockets.delete(
                    number
                );

                socketCreationTime.delete(
                    number
                );
            }
        );

        const sessionDir =
            path.join(
                __dirname,
                'session'
            );

        if (
            fs.existsSync(sessionDir)
        ) {

            try {
                fs.emptyDirSync(
                    sessionDir
                );
            } catch (_) {}
        }
    }
);


process.on(
    'uncaughtException',
    (err) => {

        hasinduLog(
            `Uncaught exception: ${err.message}`,
            'error'
        );
    }
);


// ============================================================
// EXPORT
// ============================================================

module.exports = router;
