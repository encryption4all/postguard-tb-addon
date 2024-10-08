import { ComposeMail } from '@e4a/irmaseal-mail-utils'
import {
    toEmail,
    hashCon,
    generateBoundary,
    isPGEncrypted,
    wasPGEncrypted,
    getLocalFolder,
    type_to_image,
} from './../utils'
import jwtDecode, { JwtPayload } from 'jwt-decode'
import { ISealOptions, ISigningKey } from '@e4a/pg-wasm'

const DEFAULT_ENCRYPT = false
const WIN_TYPE_COMPOSE = 'messageCompose'
const PKG_URL = 'https://postguard-main.cs.ru.nl/pkg'
const EMAIL_ATTRIBUTE_TYPE = 'pbdf.sidn-pbdf.email.email'
const SENT_COPY_FOLDER = 'PostGuard Sent'
const RECEIVED_COPY_FOLDER = 'PostGuard Received'
const PK_KEY = 'pg-pk'
const POSTGUARD_SUBJECT = 'PostGuard Encrypted Email'

const PG_WHITE = '#FFFFFF'
const PG_INFO_COLOR = '#022E3D'
const PG_INFO_ACCENT_COLOR = '#006EF4'
const PG_ERR_COLOR = '#A63232'
const PG_WARN_COLOR = '#FFCC00'
const PG_DISABLED_COLOUR = '#757575'

const i18n = (key: string) => browser.i18n.getMessage(key)

const VERSION: Version = await browser.runtime.getBrowserInfo().then(({ version }) => {
    const parts = version.split('.')
    return {
        raw: version,
        major: parseInt(parts[0]),
        minor: parseInt(parts[1]),
        revision: parts.length > 2 ? parseInt(parts[2]) : 0,
    }
})
const EXT_VERSION = await browser.runtime.getManifest()['version']

const PG_CLIENT_HEADER = {
    'X-PostGuard-Client-Version': `Thunderbird,${VERSION.raw},pg4tb,${EXT_VERSION}`,
}

// Keeps track of displayScript connections.
const displayScriptPorts = {}

console.log(
    `[background]: postguard-tb-addon v${EXT_VERSION} started (Thunderbird v${VERSION.raw}).`
)
console.log(
    '[background]: loading wasm module and retrieving master public key and master verification key.'
)

const vk_promise: Promise<string> = fetch(`${PKG_URL}/v2/sign/parameters`)
    .then((r) => r.json())
    .then((j) => j.publicKey)

const pk_promise: Promise<string> = retrievePublicKey()
const mod_promise = import('@e4a/pg-wasm')

const [pk, vk, mod] = await Promise.all([pk_promise, vk_promise, mod_promise])

// Keeps track of which tabs (messageCompose type) should use encryption.
// Also, add a bar to any existing compose windows.
const composeTabs: {
    [tabId: number]: {
        tab: any
        encrypt: boolean
        barId: number
        notificationId?: number
        policy?: Policy
        configWindowId?: number
        signId?: Policy
        signWindowId?: number
        newMsgId?: number
        details?: any
    }
} = {}

const decryptedMessages: {
    [messageId: number]: {
        badges?: { type: string; value: string }[]
    }
} = {}

// Populate composeTabs during startup.
const tabs = await browser.tabs.query({ type: WIN_TYPE_COMPOSE })
for (const tab of tabs) {
    const encrypt = await shouldEncrypt(tab.id)
    const barId = await addBar(tab, encrypt)
    composeTabs[tab.id] = { encrypt, tab, barId }
}

// Determines the encryption policy based on the tab.
async function shouldEncrypt(tabId: number): Promise<boolean> {
    const details = await browser.compose.getComposeDetails(tabId)
    return (
        (details.type === 'reply' && (await wasPGEncrypted(details.relatedMessageId))) ||
        DEFAULT_ENCRYPT
    )
}

console.log('[background]: startup composeTabs: ', Object.keys(composeTabs))

// Run the cleanup every 10 minutes.
setInterval(cleanUp, 600000)

// Register the messageDisplayScript.
await browser.messageDisplayScripts.register({
    js: [{ file: 'messageDisplay.js' }],
})

// Cleanup notifications and windows.
// TODO: this doesn't run somehow.
browser.runtime.onSuspend.addListener(() => {
    Object.entries(composeTabs).forEach(([id, { notificationId }]) => {
        console.log(`tab with id ${id} has notification ${notificationId}`)
    })
})

// Store incoming ports. We use ports for the display scripts.
// The other scripts use brower.runtime.addListener with promisified return values.
browser.runtime.onConnect.addListener((p) => {
    const id = p.sender.tab.id
    switch (p.name) {
        case 'displayScript':
            displayScriptPorts[id] = p
            p.onMessage.addListener(displayListener)
            p.onDisconnect.addListener(() => delete displayScriptPorts[id])
            break
        default:
            break
    }
})

const displayListener = async (message, port) => {
    const {
        tab: { id: tabId, windowId },
    } = port.sender

    switch (message.command) {
        case 'queryDetails': {
            // Detects pg encryption
            const header = await browser.messageDisplay.getDisplayedMessage(tabId)
            const id = header.id
            const isEncrypted = await isPGEncrypted(id)

            if (isEncrypted) {
                port.postMessage({ isEncrypted })
                await messenger.notificationbar.create({
                    windowId,
                    tabId,
                    label: i18n('displayScriptDecryptBar'),
                    icon: 'icons/pg_logo_no_text.svg',
                    placement: 'message',
                    style: { color: PG_WHITE, 'background-color': PG_INFO_COLOR },
                    buttons: [{ id: `decrypt-${id}`, label: 'Decrypt', accesskey: 'decrypt' }],
                })
                return
            }

            if (decryptedMessages[id]?.badges) {
                // display sender identity in the UI.
                await messenger.notificationbar.create({
                    windowId,
                    tabId,
                    label: i18n('notificationHeaderBadgesLabel'),
                    icon: 'icons/pg_logo_no_text.svg',
                    placement: 'message',
                    style: { color: PG_WHITE, 'background-color': PG_INFO_COLOR },
                    buttons: [],
                    badges: decryptedMessages[id].badges,
                })
                return
            }

            // Detects if mail was once encrypted using PostGuard
            const wasEncrypted = await wasPGEncrypted(id)

            if (wasEncrypted) {
                await messenger.notificationbar.create({
                    tabId,
                    windowId,
                    label: i18n('displayScriptWasEncryptedBar'),
                    icon: 'icons/pg_logo_no_text.svg',
                    placement: 'message',
                    style: { color: PG_WHITE, 'background-color': PG_INFO_COLOR },
                })
            }

            break
        }
        default:
            break
    }
}

browser.notificationbar.onButtonClicked.addListener(async (windowId, notificationId, buttonId) => {
    if (buttonId.startsWith('decrypt')) {
        try {
            const id: number = +buttonId.split('-')[1]
            await decryptMessage(id)
        } catch {
            // do nothing
        }
    }
})

// Watch for outgoing mails. The encryption process starts here.
browser.compose.onBeforeSend.addListener(async (tab, details) => {
    if (!composeTabs[tab.id].encrypt) return

    if (composeTabs[tab.id].configWindowId) {
        await messenger.windows.update(composeTabs[tab.id].configWindowId, {
            drawAttention: true,
            focused: true,
        })
        return { cancel: true }
    }

    if (details.bcc.length) {
        if (!composeTabs[tab.id].notificationId) {
            const notificationId = await messenger.notificationbar.create({
                windowId: tab.windowId,
                tabId: tab.id,
                label: i18n('composeBccWarning'),
                placement: 'top',
                style: { color: PG_WHITE, 'background-color': PG_WARN_COLOR },
                icon: 'icons/pg_logo_no_text.svg',
            })
            composeTabs[tab.id].notificationId = notificationId
        }
        return { cancel: true }
    }

    const originalSubject = details.subject
    details.subject = POSTGUARD_SUBJECT

    const attachments = await browser.compose.listAttachments(tab.id)
    const date = new Date()

    // Create the inner mime from the details.

    let innerContenType = ''
    let boundary = ''
    let contentType = `${details.isPlainText ? 'text/plain' : 'text/html'}; charset=utf-8`
    const attachmentLen = attachments.length

    if (attachmentLen > 0) {
        innerContenType = contentType
        boundary = generateBoundary()
        contentType = `multipart/mixed; boundary="${boundary}"`
    }

    let innerMime = ''
    innerMime += `Date: ${date.toUTCString()}\r\n`
    innerMime += 'MIME-Version: 1.0\r\n'
    innerMime += `To: ${String(details.to)}\r\n`
    innerMime += `From: ${String(details.from)}\r\n`
    innerMime += `Subject: ${originalSubject}\r\n`
    if (details.cc.length > 0) innerMime += `Cc: ${String(details.cc)}\r\n`
    innerMime += `Content-Type: ${contentType}\r\n`
    innerMime += `X-PostGuard: 0.1\r\n`
    innerMime += '\r\n'

    let innerBody = details.isPlainText ? details.plainTextBody : details.body
    if (attachmentLen > 0)
        innerBody = `--${boundary}\r\nContent-Type: ${innerContenType}\r\n\r\n${innerBody}\r\n`
    innerMime += innerBody

    const tempFile = await browser.pg4tb.createTempFile()
    const encoder = new TextEncoder()
    const readable = new ReadableStream<Uint8Array>({
        start: async (controller: ReadableStreamController<Uint8Array>) => {
            controller.enqueue(encoder.encode(innerMime))

            await browser.pg4tb.writeToFile(tempFile, innerMime)

            for (const att of attachments) {
                const isLast = att.id === attachments[attachmentLen - 1].id
                const file: File = await browser.compose.getAttachmentFile(att.id)
                const buf = await file.arrayBuffer()
                const b64 = Buffer.from(buf).toString('base64')
                const formatted = b64.replace(/(.{76})/g, '$1\r\n')

                let attMime = ''
                attMime += `--${boundary}\r\nContent-Type: ${file.type}; name="${file.name}"\r\n`
                attMime += `Content-Disposition: attachment; filename="${file.name}"\r\n`
                attMime += `Content-Transfer-Encoding: base64\r\n\r\n`
                attMime += formatted
                attMime += isLast ? `\r\n--${boundary}--\r\n` : '\r\n'

                controller.enqueue(encoder.encode(attMime))
                await browser.pg4tb.writeToFile(tempFile, attMime)
                await browser.compose.removeAttachment(tab.id, att.id)
            }

            controller.close()
        },
    })

    let encrypted = new Uint8Array(0)
    const writable = new WritableStream<Uint8Array>({
        write: (chunk: Uint8Array) => {
            encrypted = new Uint8Array([...encrypted, ...chunk])
        },
    })

    const timestamp = Math.round(date.getTime() / 1000)

    const customPolicies = composeTabs[tab.id].policy
    const policy = [...details.to, ...details.cc].reduce((total, recipient) => {
        const id = toEmail(recipient)

        // If there's a custom policy, use it.
        if (customPolicies && customPolicies[id])
            total[id] = { ts: timestamp, con: customPolicies[id] }
        else {
            // otherwise fall back to using email
            total[id] = { ts: timestamp, con: [{ t: EMAIL_ATTRIBUTE_TYPE, v: id }] }
        }

        // Make sure no email values are capitalized.
        total[id].con = total[id].con.map(({ t, v }) => {
            if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: v.toLowerCase() }
            else return { t, v }
        })

        return total
    }, {})

    const from = toEmail(details.from)

    // Sign with email under the public signing identity (email).
    const pubSignId = [{ t: EMAIL_ATTRIBUTE_TYPE, v: from }]

    const privSignId = composeTabs[tab.id].signId?.[from]?.filter(
        ({ t }) => t !== EMAIL_ATTRIBUTE_TYPE
    )

    const totalId = [...pubSignId, ...(privSignId ? privSignId : [])]

    // Get a JWT or use one from the storage.
    const jwt = await checkLocalStorage(totalId).catch(async () => {
        const jwt = await createSessionPopup(totalId, 'Signing')
        await storeLocalStorage(totalId, jwt)
        return jwt
    })
    const { pubSignKey, privSignKey } = await getSigningKeys(jwt, { pubSignId, privSignId })

    const sealOptions: ISealOptions = {
        policy,
        pubSignKey,
        ...(privSignKey && { privSignKey }),
    }

    console.log('Sealing with options: ', sealOptions)

    const tEncStart = performance.now()
    await mod.sealStream(pk, sealOptions, readable, writable)
    console.log(`Encryption took ${performance.now() - tEncStart} ms`)

    // Create the attachment
    const encryptedFile = new File([encrypted], `postguard.encrypted`, {
        type: 'application/postguard; charset=utf-8',
    })

    // Add the encrypted file attachment
    await browser.compose.addAttachment(tab.id, { file: encryptedFile })

    const compose = new ComposeMail()
    compose.setSender(details.from)

    // This doesn't work in onBeforeSend due to a bug, hence we set this
    // when the PostGuard switch is turned on (see messenger.switchbar.onButtonClicked.addListener).
    // details.deliveryFormat = 'both'

    details.plainTextBody = compose.getPlainText()
    details.body = compose.getHtmlText()

    // Save a copy of the message in the sent folder.
    // 1) Import copy to local sent folder
    // The rest happens in onAfterSend:
    // 2) Move to final folder (sent folder),
    // 3) Cleanup: remove ciphertext.
    // TODO: use import(): https://webextension-api.thunderbird.net/en/latest/messages.html#import-file-destination-properties

    getLocalFolder(SENT_COPY_FOLDER)
        .then((localFolder) => browser.pg4tb.copyFileMessage(tempFile, localFolder))
        .then((newMsgId) => {
            composeTabs[tab.id].newMsgId = newMsgId
        })
        .catch((e) => console.log('failed to create plaintext copy in sent folder: ', e))

    return { cancel: false, details }
})

// Cleanup: remove ciphertext emails from sent folder.
browser.compose.onAfterSend.addListener(async (tab, sendInfo) => {
    sendInfo.messages.forEach(async (m) => {
        if ((await isPGEncrypted(m.id)) && composeTabs[tab.id].newMsgId) {
            // Move to sent folder
            await browser.messages.move([composeTabs[tab.id].newMsgId], m.folder)
            // Delete original sent email (ciphertext).
            await browser.messages.delete([m.id], true)
            // cleanup composeTabs
            delete composeTabs[tab.id]
        }
    })
})

// Listen for notificationbar switch button clicks.
messenger.switchbar.onButtonClicked.addListener(
    async (windowId: number, barId: number, buttonId: string, enabled: boolean) => {
        if (['btn-switch'].includes(buttonId)) {
            const tabIdKey = Object.keys(composeTabs).find(
                (key) => composeTabs[key]?.barId === barId
            )
            if (tabIdKey) {
                const tabId = Number(tabIdKey)
                composeTabs[tabId].encrypt = enabled

                // if PostGuard is enabled turn on deliveryFormat = both
                const details = await browser.compose.getComposeDetails(tabId)
                await browser.compose.setComposeDetails(tabId, {
                    ...details,
                    deliveryFormat: enabled ? 'both' : 'auto',
                })

                // Remove the notification if PostGuard is turned off.
                if (composeTabs[tabId].notificationId && !enabled) {
                    await messenger.notificationbar.clear(composeTabs[tabId].notificationId)
                    composeTabs[tabId].notificationId = undefined
                }
            }
            return { close: false }
        }
    }
)

// Remove the notification on dismiss.
messenger.notificationbar.onDismissed.addListener((windowId, notificationId) => {
    const tabId = Object.keys(composeTabs).find(
        (key) => composeTabs[key]?.notificationId === notificationId
    )
    if (tabId) composeTabs[tabId].notificationId = undefined
})

// Keep track of all the compose tabs created.
browser.tabs.onCreated.addListener(async (tab) => {
    const win = await browser.windows.get(tab.windowId)

    // Check the windowType of the tab.
    if (win.type === WIN_TYPE_COMPOSE) {
        const enabled = await shouldEncrypt(tab.id)
        const barId = await addBar(tab, enabled)

        // Register the tab.
        composeTabs[tab.id] = {
            encrypt: enabled,
            barId,
            tab,
        }
    }
})

async function decryptMessage(msgId: number) {
    const msg = await browser.messages.get(msgId)

    const attachments = await browser.messages.listAttachments(msg.id)
    const filtered = attachments.filter((att) => att.name === 'postguard.encrypted')
    if (filtered.length !== 1) return

    const pgPartName = filtered[0].partName

    try {
        const attFile = await browser.messages.getAttachmentFile(msg.id, pgPartName)
        const readable = attFile.stream()
        const unsealer = await mod.StreamUnsealer.new(readable, vk)
        const accountId = msg.folder.accountId
        const defaultIdentity = await browser.identities.getDefault(accountId)
        const recipientId = toEmail(defaultIdentity.email)
        const recipients = unsealer.inspect_header()
        const sender = msg.author
        const me = recipients.get(recipientId)

        if (!me) {
            const e = new Error('recipient identifier not found in header')
            e.name = 'RecipientUnknownError'
            throw e
        }

        const keyRequest = Object.assign({}, me)
        let hints = me.con

        // Convert hints.
        hints = hints.map(({ t, v }) => {
            if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId }
            else return { t, v }
        })

        // Convert hidden policy to attribute request.
        keyRequest.con = keyRequest.con.map(({ t, v }) => {
            if (t === EMAIL_ATTRIBUTE_TYPE) return { t, v: recipientId }
            else if (v === '' || v.includes('*')) return { t }
            else return { t, v }
        })

        console.log('Trying decryption with policy: ', keyRequest, hints)

        // Check localStorage, otherwise create a popup to retrieve a JWT.
        const jwt = await checkLocalStorage(hints).catch(() =>
            createSessionPopup(keyRequest.con, 'Decryption', hints, toEmail(sender))
        )
        /// Use the JWT to retrieve a USK.
        const usk = await getUSK(jwt, keyRequest.ts)

        let tempFile = -1
        let data = ''

        if (VERSION.major < 106) tempFile = await browser.pg4tb.createTempFile()

        const decoder = new TextDecoder()
        const writable = new WritableStream({
            write: async (chunk: Uint8Array) => {
                const decoded = decoder.decode(chunk, { stream: true })
                if (VERSION.major < 106) await browser.pg4tb.writeToFile(tempFile, decoded)
                else data += decoded
            },
            close: async () => {
                const finalDecoded = decoder.decode()
                if (VERSION.major < 106) await browser.pg4tb.writeToFile(tempFile, finalDecoded)
                else data += finalDecoded
            },
        })

        const senderIdentity = await unsealer.unseal(recipientId, usk, writable)
        console.log('Sender verification successful: ', senderIdentity)

        const privBadges = senderIdentity?.private?.con ?? []
        const badges = [...senderIdentity.public.con, ...privBadges].map(({ t, v }) => {
            return { type: type_to_image(t), value: v }
        })

        // Store the JWT if decryption succeeded.
        await storeLocalStorage(hints, jwt)

        // 1) Decrypt into new local folder message,
        // 2) Move to original folder (usually inbox),
        // 2) Show new inbox message,
        // 3) Remove original message.

        const localFolder = await getLocalFolder(RECEIVED_COPY_FOLDER)

        let localMsgId: number
        if (VERSION.major < 106)
            localMsgId = await browser.pg4tb.copyFileMessage(tempFile, localFolder, msg.id)
        else {
            const file = new File([data], 'tmp.eml', { type: 'text/plain' })
            const localMsgheader = await browser.messages.import(file, localFolder)
            localMsgId = localMsgheader.id
        }

        const localMsg = await browser.messages.get(localMsgId)

        await browser.messages.move([localMsgId], msg.folder)

        // FIXME: Ugly workaround until messages.move() returns the message id.
        // Doesn't work consistently unfortunately.

        const fromDate: Date = new Date(localMsg.date.getTime())
        fromDate.setSeconds(fromDate.getSeconds() - 1)
        const toDate: Date = new Date(localMsg.date.getTime())
        toDate.setSeconds(localMsg.date.getSeconds() + 1)

        let moved
        let tried = 0
        do {
            const queryDetails = {
                folder: msg.folder,
                subject: localMsg.subject,
                recipients: localMsg.recipients.join(';'),
                author: localMsg.author,
                fromDate,
                toDate,
            }
            moved = await browser.messages.query(queryDetails)

            await new Promise((res) => setTimeout(res, 100))
            tried++
        } while (moved.messages.length !== 1 && tried < 10)

        try {
            const movedMsgId = moved.messages[0].id

            // store the badges
            decryptedMessages[movedMsgId] = { badges }

            if (VERSION.major < 106) await browser.messageDisplay.open({ messageId: movedMsgId })
            else await browser.mailTabs.setSelectedMessages([movedMsgId])
        } catch (e: any) {
            e instanceof Error && console.log('switching to message failed: ', e.message)
        }

        await browser.messages.delete([msg.id], true)
    } catch (e: any) {
        console.log('error during decryption: ', e.message, e.name)
        if (e instanceof Error && e.name === 'OperationError')
            await notifyDecryptionFailed(i18n('decryptionFailed'))
        if (e instanceof Error && e.name === 'RecipientUnknownError')
            await notifyDecryptionFailed(i18n('recipientUnknown'))
    }
}

// Cleans up the local storage.
async function cleanUp(): Promise<void> {
    const all = await browser.storage.local.get(null)
    const now = Date.now() / 1000
    for (const [hash, val] of Object.entries(all)) {
        if (val) {
            const { exp } = val as { encoded: string; exp: number }
            if (now > exp) await browser.storage.local.remove(hash)
        }
    }
}

// Best-effort attempt to detect if darkMode is enabled.
async function detectMode(): Promise<boolean> {
    let darkMode = false
    try {
        const currentTheme = await browser.theme.getCurrent()
        const toolbarHSL = currentTheme.colors.toolbar
        const hslRegExp = /hsl\((\d+),\s*([\d.]+)%,\s*([\d.]+)%\)/gm
        const found = hslRegExp.exec(toolbarHSL)
        if (found && found[3]) {
            darkMode = parseInt(found[3]) < 50
        }
    } catch (e) {
        // fallback to false
    }
    return darkMode
}

async function addSignBar(
    windowId: number,
    tabId: number,
    scenario: 'compose' | 'header'
): Promise<number> {
    return new Promise((resolve, reject) => {
        if (!composeTabs[tabId].signId) return reject()

        const pol: Policy = composeTabs[tabId].signId || {}
        const badges = Object.values(pol)[0].map(({ t, v }) => {
            return { type: type_to_image(t), value: v }
        })

        messenger.notificationbar
            .create({
                windowId,
                label: i18n(`notification${scenario}BadgesLabel`),
                icon: 'icons/sign.svg',
                placement: scenario === 'compose' ? 'top' : 'message',
                style: { color: PG_WHITE, 'background-color': PG_INFO_COLOR },
                buttons: [],
                badges,
            })
            .then((id: number) => resolve(id))
    })
}

async function addBar(tab, enabled): Promise<number> {
    const darkMode = await detectMode()
    const notificationId = await messenger.switchbar.create({
        enabled,
        windowId: tab.windowId,
        buttonId: 'btn-switch',
        placement: 'top',
        iconEnabled: 'icons/pg_logo_no_text.svg',
        iconDisabled: `icons/pg_logo${darkMode ? '' : '_grey'}_no_text.svg`,
        buttons: [
            {
                id: 'postguard-configure',
                label: i18n('attributeSelectionButtonLabel'),
                accesskey: 'manage access',
            },
            {
                id: 'postguard-sign',
                label: i18n('attributeSelectionButtonLabelSign'),
                accesskey: 'sign',
            },
        ],
        labels: {
            enabled: i18n('composeSwitchBarEnabledHtml'),
            disabled: i18n('composeSwitchBarDisabledHtml'),
        },
        style: {
            'color-enabled': PG_WHITE, // text color
            'color-disabled': darkMode ? PG_INFO_COLOR : PG_WHITE,
            'background-color-enabled': PG_INFO_COLOR, // background of bar
            'background-color-disabled': darkMode ? PG_WHITE : PG_INFO_COLOR,
            'slider-background-color-enabled': PG_INFO_ACCENT_COLOR, // background of slider
            'slider-background-color-disabled': darkMode ? PG_INFO_COLOR : PG_DISABLED_COLOUR,
            'slider-color-enabled': PG_WHITE, // slider itself
            'slider-color-disabled': darkMode ? PG_WHITE : PG_WHITE,
        },
    })

    return notificationId
}

async function notifyDecryptionFailed(msg: string) {
    const activeMailTabs = await browser.tabs.query({ mailTab: true, active: true })
    if (activeMailTabs.length === 1)
        await messenger.notificationbar.create({
            windowId: activeMailTabs[0].windowId,
            tabId: activeMailTabs[0].tabId,
            label: msg,
            placement: 'message',
            style: { color: PG_WHITE, 'background-color': PG_ERR_COLOR },
            icon: 'icons/pg_logo_no_text.svg',
        })
}

// Check localStorage for a conjunction.
async function checkLocalStorage(con: AttributeCon): Promise<string> {
    const hash = await hashCon(con)

    return browser.storage.local.get(hash).then((cached) => {
        if (Object.keys(cached).length === 0) throw new Error('not found in localStorage')
        const entry = cached[hash]
        if (Date.now() / 1000 > entry.exp) throw new Error('jwt has expired')
        return entry.jwt
    })
}

async function storeLocalStorage(con: AttributeCon, jwt: string) {
    const decoded = jwtDecode<JwtPayload>(jwt)
    hashCon(con).then((hash) => {
        browser.storage.local.set({
            [hash]: { jwt, exp: decoded.exp },
        })
    })
}

// Retrieve a USK using a JWT and timestamp.
async function getUSK(jwt: string, ts: number): Promise<any> {
    const url = `${PKG_URL}/v2/irma/key/${ts?.toString()}`
    return fetch(url, {
        headers: {
            Authorization: `Bearer ${jwt}`,
            ...PG_CLIENT_HEADER,
        },
    })
        .then((r) => r.json())
        .then((json) => {
            if (json.status !== 'DONE' || json.proofStatus !== 'VALID')
                throw new Error('session not DONE and VALID')
            return json.key
        })
}

async function getSigningKeys(jwt: string, keyRequest?: any): Promise<any> {
    const url = `${PKG_URL}/v2/irma/sign/key`
    return fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            ...PG_CLIENT_HEADER,
            'content-type': 'application/json',
        },
        body: JSON.stringify(keyRequest),
    })
        .then((r) => r.json())
        .then((json) => {
            if (json.status !== 'DONE' || json.proofStatus !== 'VALID')
                throw new Error('session not DONE and VALID')
            return { pubSignKey: json.pubSignKey, privSignKey: json.privSignKey }
        })
}

async function createSessionPopup(
    con: AttributeCon,
    sort: KeySort,
    hints?: AttributeCon,
    senderId?: string
): Promise<string> {
    const popupWindow = await messenger.windows.create({
        url: 'decryptPopup.html',
        type: 'popup',
        height: 700,
        width: 620,
    })

    const popupId = popupWindow.id
    await messenger.windows.update(popupId, { drawAttention: true, focused: true })

    const data: PopupData = {
        hostname: PKG_URL,
        header: PG_CLIENT_HEADER,
        con,
        sort,
        hints,
        senderId,
    }

    let popupListener, tabClosedListener
    const jwtPromise = new Promise<string>((resolve, reject) => {
        popupListener = (req, sender) => {
            if (sender.tab.windowId == popupId && req && req.command === 'popup_init') {
                return Promise.resolve(data)
            } else if (sender.tab.windowId == popupId && req && req.command === 'popup_done') {
                if (req.jwt) resolve(req.jwt)
                else reject(new Error('no jwt'))
                return Promise.resolve()
            }
            return false
        }

        tabClosedListener = (windowId: number) => {
            if (windowId === popupId) reject(new Error('tab closed'))
        }
        browser.runtime.onMessage.addListener(popupListener)
        browser.windows.get(popupId).catch((e) => reject(e))
        browser.windows.onRemoved.addListener(tabClosedListener)
    })

    return jwtPromise.finally(() => {
        browser.windows.onRemoved.removeListener(tabClosedListener)
        browser.runtime.onMessage.removeListener(popupListener)
    })
}

// First tries to download the public key from the PKG.
// If this fails, it falls back to a public key in localStorage.
// The public key is stored iff there was no public key or it was different.
// If no public key is found, either through the PKG or localStorage, the promise rejects.
async function retrievePublicKey(): Promise<string> {
    const stored = await browser.storage.local.get(PK_KEY)
    const storedPublicKey = stored[PK_KEY]

    return fetch(`${PKG_URL}/v2/parameters`, {
        headers: PG_CLIENT_HEADER,
    })
        .then((resp) =>
            resp.json().then(async ({ publicKey }) => {
                if (storedPublicKey !== publicKey)
                    await browser.storage.local.set({ [PK_KEY]: publicKey })
                return publicKey
            })
        )
        .catch((e) => {
            console.log(
                `[background]: failed to retrieve public key from PKG: ${e.toString()}, falling back to localStorage`
            )
            if (storedPublicKey) return storedPublicKey
            throw new Error('no public key')
        })
}

async function createAttributeSelectionPopup(
    initialPolicy: Policy,
    tabId: number,
    sign: boolean
): Promise<Policy> {
    const popupWindow = await messenger.windows.create({
        url: 'attributeSelection.html',
        type: 'popup',
        height: 400,
        width: 700,
    })

    const popupId = popupWindow.id
    composeTabs[tabId].configWindowId = popupId

    await messenger.windows.update(popupId, { drawAttention: true, focused: true })

    let popupListener, tabClosedListener
    const policyPromise = new Promise<Policy>((resolve, reject) => {
        popupListener = (req, sender) => {
            if (sender.tab.windowId == popupId && req && req.command === 'popup_init') {
                return Promise.resolve({
                    initialPolicy,
                    sign,
                })
            } else if (sender.tab.windowId == popupId && req && req.command === 'popup_done') {
                if (req.policy) resolve(req.policy)
                else reject(new Error('no policy'))
                return Promise.resolve()
            }
            return false
        }

        tabClosedListener = (windowId: number) => {
            if (windowId === popupId) reject(new Error('tab closed'))
        }
        browser.runtime.onMessage.addListener(popupListener)
        browser.windows.get(popupId).catch((e) => reject(e))
        browser.windows.onRemoved.addListener(tabClosedListener)
    })

    return policyPromise.finally(() => {
        browser.windows.onRemoved.removeListener(tabClosedListener)
        browser.runtime.onMessage.removeListener(popupListener)
        composeTabs[tabId].configWindowId = undefined
    })
}

browser.switchbar.onButtonClicked.addListener(async (windowId, notificationId, buttonId) => {
    if (buttonId === 'postguard-configure' || buttonId === 'postguard-sign') {
        const sign = buttonId === 'postguard-sign'
        const tabs = await browser.tabs.query({ windowId, windowType: WIN_TYPE_COMPOSE })
        const tabId = tabs[0].id

        // Check if a config for this tab is open already.
        if (
            (!sign && composeTabs[tabId].configWindowId) ||
            (sign && composeTabs[tabId].signWindowId)
        )
            return

        const state = await browser.compose.getComposeDetails(tabId)
        const recipients = [...state.to, ...state.cc]

        const start = sign ? [state.from] : recipients

        let policy: Policy = start.reduce((p, next) => {
            const email = toEmail(next)
            p[email] = []
            return p
        }, {})

        if (!sign && composeTabs[tabId].policy) {
            // merge
            for (const [rec, con] of Object.entries(composeTabs[tabId].policy as Policy)) {
                if (recipients.includes(rec)) policy[rec] = con
            }
        }

        if (sign && composeTabs[tabId].signId?.[toEmail(state.from)]) {
            // start over if sender changed
            policy = composeTabs[tabId].signId || policy
        }

        try {
            const newPolicy: Policy = await createAttributeSelectionPopup(policy, tabId, sign)
            if (!sign) {
                composeTabs[tabId].policy = newPolicy
                const latest = await browser.compose.getComposeDetails(tabId)
                const newTo = Object.keys(newPolicy)
                latest.to = newTo
                await browser.compose.setComposeDetails(tabId, latest)
            } else {
                composeTabs[tabId].signId = newPolicy

                if (composeTabs[tabId].notificationId) {
                    await messenger.notificationbar.clear(composeTabs[tabId].notificationId)
                }

                composeTabs[tabId].notificationId = await addSignBar(windowId, tabId, 'compose')
            }
        } catch (e) {
            console.log('failed to get the new policy: ', e)
        }
    }
})
