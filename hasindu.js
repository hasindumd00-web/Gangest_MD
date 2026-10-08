// ============================================================
// HASINDU-MD - COMMAND REGISTRY + BUTTON & IMAGE SUPPORT
// ============================================================

var commands = [];


// ============================================================
// COMMAND REGISTRATION
// ============================================================

function cmd(info, func) {

    var data = info || {};

    // Store command function
    data.function = func;

    // If pattern is missing, use cmdname
    if (!data.pattern && data.cmdname) {
        data.pattern = data.cmdname;
    }

    // Defaults
    if (!data.alias) {
        data.alias = [];
    }

    if (!data.dontAddCommandList) {
        data.dontAddCommandList = false;
    }

    if (!data.desc) {
        data.desc = '';
    }

    if (!data.fromMe) {
        data.fromMe = false;
    }

    if (!data.category) {
        data.category = 'misc';
    }

    // Normalize command values
    if (typeof data.pattern === 'string') {
        data.pattern = data.pattern.toLowerCase();
    }

    if (Array.isArray(data.alias)) {
        data.alias = data.alias
            .filter(Boolean)
            .map(function (alias) {
                return String(alias).toLowerCase();
            });
    }

    // Add command to registry
    commands.push(data);

    return data;
}


// ============================================================
// QUICK REPLY BUTTON BUILDER
// ============================================================

function quickReplyButton(displayText, id) {

    return {
        name: 'quick_reply',

        buttonParamsJson: JSON.stringify({
            display_text: String(displayText),
            id: String(id)
        })
    };
}


// ============================================================
// NATIVE FLOW BUTTON BUILDER
// ============================================================

function createNativeFlowButton(name, params) {

    return {
        name: String(name),

        buttonParamsJson:
            typeof params === 'string'
                ? params
                : JSON.stringify(params || {})
    };
}


// ============================================================
// NORMALIZE BUTTONS
// ============================================================

function normalizeButtons(buttonList) {

    if (!Array.isArray(buttonList)) {
        return [];
    }

    return buttonList
        .filter(Boolean)
        .map(function (button) {

            // Already native-flow format
            if (
                button.name &&
                button.buttonParamsJson
            ) {

                return {
                    name: String(button.name),

                    buttonParamsJson:
                        typeof button.buttonParamsJson === 'string'
                            ? button.buttonParamsJson
                            : JSON.stringify(
                                button.buttonParamsJson
                            )
                };
            }


            // Simple object format
            if (
                button.id ||
                button.buttonId
            ) {

                var id =
                    button.id ||
                    button.buttonId;

                var text =
                    button.text ||
                    button.displayText ||
                    button.display_text ||
                    button.buttonText?.displayText ||
                    'Button';

                return quickReplyButton(
                    text,
                    id
                );
            }

            return null;

        })
        .filter(Boolean);
}


// ============================================================
// CHECK GROUP JID
// ============================================================

function isGroupJid(jid) {

    return (
        typeof jid === 'string' &&
        (
            jid.endsWith('@g.us') ||
            jid.endsWith('@broadcast')
        )
    );
}


// ============================================================
// BUILD BIZ NODE FOR NATIVE FLOW
// ============================================================

function buildNativeFlowBizNode() {

    var privacyModeTs =
        (
            Math.floor(
                Date.now() / 1000
            ) - 77980457
        ).toString();


    return {

        tag: 'biz',

        attrs: {

            actual_actors: '2',

            host_storage: '2',

            privacy_mode_ts:
                privacyModeTs
        },

        content: [

            {

                tag: 'interactive',

                attrs: {

                    type: 'native_flow',

                    v: '1'
                },

                content: [

                    {

                        tag: 'native_flow',

                        attrs: {

                            v: '9',

                            name: 'mixed'
                        }
                    }
                ]
            },

            {

                tag: 'quality_control',

                attrs: {

                    source_type:
                        'third_party'
                }
            }
        ]
    };
}


// ============================================================
// SEND NATIVE FLOW INTERACTIVE MESSAGE (WITH IMAGE & BUTTONS)
// ============================================================

async function sendInteractiveMessage(
    conn,
    jid,
    options
) {

    if (
        !conn ||
        typeof conn.relayMessage !== 'function'
    ) {

        throw new Error(
            'Baileys relayMessage() is unavailable.'
        );
    }


    if (
        !jid ||
        typeof jid !== 'string'
    ) {

        throw new Error(
            'Invalid destination JID.'
        );
    }


    options =
        options || {};


    var buttonList =
        normalizeButtons(
            options.buttons ||
            options.interactiveButtons ||
            []
        );


    if (!buttonList.length) {

        throw new Error(
            'No valid interactive buttons supplied.'
        );
    }


    var baileys =
        require('@whiskeysockets/baileys');


    var proto =
        baileys.proto;

    var generateWAMessageFromContent =
        baileys.generateWAMessageFromContent;

    var prepareWAMessageMedia =
        baileys.prepareWAMessageMedia;


    if (
        !proto ||
        !generateWAMessageFromContent
    ) {

        throw new Error(
            'Baileys interactive message helpers are unavailable.'
        );
    }


    // ========================================================
    // CREATE NATIVE FLOW BUTTONS
    // ========================================================

    var nativeButtons =
        buttonList.map(function (button) {

            return proto
                .Message
                .InteractiveMessage
                .NativeFlowMessage
                .NativeFlowButton
                .create({

                    name:
                        button.name,

                    buttonParamsJson:
                        button.buttonParamsJson
                });

        });


    // ========================================================
    // HEADER (WITH SAFE IMAGE SUPPORT)
    // ========================================================

    let headerParams = {
        title: options.title || '',
        subtitle: options.subtitle || '',
        hasMediaAttachment: false
    };

    if (options.image) {
        try {
            let uploadFn = conn.waUploadToServer;
            if (typeof uploadFn !== 'function' && baileys.waUploadToServer) {
                uploadFn = baileys.waUploadToServer;
            }

            const mediaMessage = await prepareWAMessageMedia(
                { image: { url: options.image } },
                { upload: uploadFn }
            );
            if (mediaMessage && mediaMessage.imageMessage) {
                headerParams.imageMessage = mediaMessage.imageMessage;
                headerParams.hasMediaAttachment = true;
            }
        } catch (mediaErr) {
            console.log('[HASINDU MD] Interactive header image error:', mediaErr);
        }
    }

    var header =
        proto
            .Message
            .InteractiveMessage
            .Header
            .create(headerParams);


    // ========================================================
    // BODY
    // ========================================================

    var body =
        proto
            .Message
            .InteractiveMessage
            .Body
            .create({

                text:
                    String(
                        options.text || ''
                    )
            });


    // ========================================================
    // FOOTER
    // ========================================================

    var footer =
        proto
            .Message
            .InteractiveMessage
            .Footer
            .create({

                text:
                    String(
                        options.footer || ''
                    )
            });


    // ========================================================
    // NATIVE FLOW
    // ========================================================

    var nativeFlow =
        proto
            .Message
            .InteractiveMessage
            .NativeFlowMessage
            .create({

                buttons:
                    nativeButtons,

                messageParamsJson:
                    '{}',

                messageVersion:
                    1
            });


    // ========================================================
    // INTERACTIVE MESSAGE
    // ========================================================

    var interactiveMessage =
        proto
            .Message
            .InteractiveMessage
            .create({

                header,

                body,

                footer,

                nativeFlowMessage:
                    nativeFlow
            });


    // ========================================================
    // GENERATE WA MESSAGE
    // ========================================================

    var userJid =
        conn?.user?.id ||
        undefined;


    var generated =
        generateWAMessageFromContent(

            jid,

            {
                interactiveMessage:
                    interactiveMessage
            },

            {
                userJid,

                quoted:
                    options.quoted || undefined
            }
        );


    if (
        !generated ||
        !generated.message ||
        !generated.key
    ) {

        throw new Error(
            'Failed to generate interactive WhatsApp message.'
        );
    }


    // ========================================================
    // REQUIRED RELAY NODES
    // ========================================================

    var bizNode =
        buildNativeFlowBizNode();


    var botNode = {

        tag: 'bot',

        attrs: {

            biz_bot: '1'
        }
    };


    var additionalNodes =
        isGroupJid(jid)

            ? [bizNode]

            : [
                botNode,
                bizNode
            ];


    // ========================================================
    // RELAY MESSAGE
    // ========================================================

    await conn.relayMessage(

        jid,

        generated.message,

        {

            messageId:
                generated.key.id,

            additionalNodes:
                additionalNodes
        }
    );


    return generated;
}


// ============================================================
// SAFE INTERACTIVE MESSAGE
// ============================================================

async function safeInteractiveMessage(
    conn,
    jid,
    options
) {

    try {

        return await sendInteractiveMessage(
            conn,
            jid,
            options
        );

    } catch (error) {

        console.log(
            '[HASINDU MD] Interactive message error:',
            error?.message ||
            error
        );


        // Text/Image fallback if interactive fails
        if (
            options &&
            options.text &&
            conn &&
            typeof conn.sendMessage === 'function'
        ) {
            if (options.image) {
                return await conn.sendMessage(
                    jid,
                    {
                        image: { url: options.image },
                        caption: String(options.text)
                    },
                    { quoted: options.quoted }
                );
            }

            return await conn.sendMessage(

                jid,

                {
                    text:
                        String(
                            options.text
                        )
                },

                {
                    quoted:
                        options.quoted
                }
            );
        }


        throw error;
    }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {

    cmd,
    AddCommand: cmd,
    Function: cmd,
    commands,
    quickReplyButton,
    createNativeFlowButton,
    normalizeButtons,
    sendInteractiveMessage,
    safeInteractiveMessage
};
