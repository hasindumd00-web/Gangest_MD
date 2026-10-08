const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType
} = require('@whiskeysockets/baileys');

const P = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();

const port =
    process.env.PORT || 8000;

app.use(cors());
app.use(bodyParser.json());
app.use(
    bodyParser.urlencoded({
        extended: true
    })
);


// ============================================================
// PAIR ROUTER
// ============================================================

try {

    const pairRouter =
        require('./hsindu');

    app.use(
        '/',
        pairRouter
    );

} catch (e) {

    console.log(
        'Pair router note: hsindu.js could not be loaded as router, skipping...'
    );
}


// ============================================================
// START EXPRESS
// ============================================================

app.listen(
    port,
    () => {
        console.log(
            `🚀 Server & Pairing running on port ${port}`
        );
    }
);


// ============================================================
// COMMAND REGISTRY
// ============================================================

const {
    commands
} = require('./hasindu');

const {
    sms
} = require('./lib/msg');


// ============================================================
// PLUGIN LOADER
// ============================================================

const readPlugins = () => {

    const pluginFolders =
        path.join(
            __dirname,
            'plugins'
        );


    if (
        !fs.existsSync(
            pluginFolders
        )
    ) {

        console.log(
            '⚠️ plugins folder not found!'
        );

        return;
    }


    fs.readdirSync(
        pluginFolders
    ).forEach(
        (file) => {

            if (
                !file.endsWith('.js')
            ) {
                return;
            }


            try {

                require(
                    path.join(
                        pluginFolders,
                        file
                    )
                );


            } catch (e) {

                console.log(
                    `❌ Error loading plugin ${file}:`,
                    e
                );
            }
        }
    );


    console.log(
        `📁 Loaded plugins successfully! Total commands: ${commands.length}`
    );
};


// ============================================================
// WHATSAPP BOT
// ============================================================

async function startHasinduBot() {

    try {

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                './session'
            );


        const {
            version
        } =
            await fetchLatestBaileysVersion();


        const conn =
            makeWASocket({

                logger:
                    P({
                        level: 'silent'
                    }),

                printQRInTerminal:
                    true,

                auth:
                    state,

                version
            });


        // Load plugins
        readPlugins();


        // ====================================================
        // CONNECTION UPDATE
        // ====================================================

        conn.ev.on(
            'connection.update',
            (update) => {

                const {
                    connection,
                    lastDisconnect
                } = update;


                if (
                    connection === 'close'
                ) {

                    const reason =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;


                    if (
                        reason !==
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            'Connection closed, reconnecting...'
                        );


                        setTimeout(
                            () => {
                                startHasinduBot();
                            },
                            3000
                        );


                    } else {

                        console.log(
                            'Server Logged Out. Please delete session and rescan.'
                        );
                    }


                } else if (
                    connection === 'open'
                ) {

                    console.log(
                        '✅ Hasindu Bot connected to WhatsApp successfully!'
                    );
                }
            }
        );


        // ====================================================
        // SAVE CREDENTIALS
        // ====================================================

        conn.ev.on(
            'creds.update',
            saveCreds
        );


        // ====================================================
        // MESSAGE HANDLER
        // ====================================================

        conn.ev.on(
            'messages.upsert',
            async (chatUpdate) => {

                try {

                    const mek =
                        chatUpdate
                            ?.messages?.[0];


                    if (
                        !mek ||
                        !mek.message
                    ) {
                        return;
                    }


                    // =================================================
                    // UNWRAP EPHEMERAL MESSAGE
                    // =================================================

                    if (
                        mek.message.ephemeralMessage
                    ) {

                        mek.message =
                            mek.message
                                .ephemeralMessage
                                .message;
                    }


                    // =================================================
                    // UNWRAP VIEW ONCE
                    // =================================================

                    if (
                        mek.message
                            .viewOnceMessage
                    ) {

                        mek.message =
                            mek.message
                                .viewOnceMessage
                                .message;
                    }


                    // =================================================
                    // IGNORE STATUS
                    // =================================================

                    if (
                        mek.key &&
                        mek.key.remoteJid ===
                        'status@broadcast'
                    ) {
                        return;
                    }


                    // =================================================
                    // MESSAGE OBJECT
                    // =================================================

                    const m =
                        sms(
                            conn,
                            mek
                        );


                    if (!m) {
                        return;
                    }


                    // =================================================
                    // WHATSAPP LIST SELECTION
                    // =================================================

                    let listSelectedId =
                        '';


                    try {

                        listSelectedId =
                            mek?.message
                                ?.listResponseMessage
                                ?.singleSelectReply
                                ?.selectedRowId ||
                            '';

                    } catch (_) {

                        listSelectedId =
                            '';
                    }


                    // =================================================
                    // BUTTON RESPONSE
                    // =================================================

                    let buttonSelectedId =
                        '';


                    try {

                        buttonSelectedId =
                            m?.buttonId ||
                            mek?.message
                                ?.buttonsResponseMessage
                                ?.selectedButtonId ||
                            '';

                    } catch (_) {

                        buttonSelectedId =
                            '';
                    }


                    // =================================================
                    // BODY
                    // =================================================

                    const body =
                        String(
                            m.body ||
                            listSelectedId ||
                            buttonSelectedId ||
                            ''
                        ).trim();


                    if (!body) {
                        return;
                    }


                    // =================================================
                    // PREFIX
                    // =================================================

                    const prefixMatch =
                        body.match(
                            /^[°•π÷×¶∆£¢€¥®™+✓_=|~!?@#$%^&.©^]/
                        );


                    const prefix =
                        prefixMatch
                            ? prefixMatch[0]
                            : '.';


                    // =================================================
                    // COMMAND
                    // =================================================

                    const isCmd =
                        body.startsWith(
                            prefix
                        );


                    const command =
                        isCmd
                            ? body
                                .slice(
                                    prefix.length
                                )
                                .trim()
                                .split(/\s+/)[0]
                                .toLowerCase()
                            : '';


                    const args =
                        isCmd
                            ? body
                                .slice(
                                    prefix.length
                                )
                                .trim()
                                .split(/\s+/)
                                .slice(1)
                            : [];


                    const q =
                        args.join(' ');


                    // =================================================
                    // COMMON CONTEXT
                    // =================================================

                    const context = {

                        from:
                            m.chat,

                        prefix,

                        body,

                        isCmd,

                        command,

                        args,

                        q,

                        text:
                            q,

                        mek,

                        quoted:
                            mek,

                        message:
                            mek.message,

                        buttonId:
                            buttonSelectedId ||
                            listSelectedId ||
                            '',

                        selectedId:
                            listSelectedId ||
                            buttonSelectedId ||
                            '',

                        listSelectedId,

                        reply:
                            m.reply
                                ? m.reply.bind(m)
                                : async (text) => {

                                    return await conn.sendMessage(
                                        m.chat,
                                        {
                                            text
                                        },
                                        {
                                            quoted: mek
                                        }
                                    );
                                }
                    };


                    // =================================================
                    // NORMAL COMMAND
                    // =================================================

                    if (isCmd) {

                        const cmdData =
                            commands.find(
                                (cmd) =>
                                    cmd.pattern ===
                                    command ||

                                    (
                                        Array.isArray(
                                            cmd.alias
                                        ) &&
                                        cmd.alias.includes(
                                            command
                                        )
                                    )
                            );


                        if (
                            cmdData &&
                            typeof cmdData.function ===
                            'function'
                        ) {

                            try {

                                await cmdData.function(
                                    conn,
                                    mek,
                                    m,
                                    context
                                );


                            } catch (e) {

                                console.error(
                                    `❌ Error executing command ${command}:`,
                                    e
                                );
                            }
                        }
                    }


                    // =================================================
                    // BODY EVENT PLUGINS
                    // =================================================

                    for (
                        const evCmd
                        of commands
                    ) {

                        if (
                            !evCmd ||
                            evCmd.on !== 'body'
                        ) {
                            continue;
                        }


                        if (
                            typeof evCmd.function !==
                            'function'
                        ) {
                            continue;
                        }


                        try {

                            await evCmd.function(
                                conn,
                                mek,
                                m,
                                context
                            );


                        } catch (e) {

                            console.error(
                                '❌ Error executing body event:',
                                e
                            );
                        }
                    }


                } catch (e) {

                    console.error(
                        '❌ Error in messages.upsert:',
                        e
                    );
                }
            }
        );


    } catch (error) {

        console.error(
            '❌ Failed to start Hasindu Bot:',
            error
        );


        setTimeout(
            () => {
                startHasinduBot();
            },
            5000
        );
    }
}


// ============================================================
// START BOT
// ============================================================

startHasinduBot();


// ============================================================
// EXPORT
// ============================================================

module.exports = app;
