import { ComposeMail } from '@e4a/irmaseal-mail-utils'

// Converts a Thunderbird email account identity to an email address
export function toEmail(identity: string): string {
    const regex = /^(.*)<(.*)>$/
    const match = identity.match(regex)
    const email = match ? match[2] : identity
    return email.toLowerCase()
}

export function generateBoundary(): string {
    const rand = crypto.getRandomValues(new Uint8Array(16))
    const boundary = Buffer.from(rand).toString('hex')
    return boundary
}

export async function hashCon(con: AttributeCon): Promise<string> {
    const sorted = con.sort(
        (att1: AttributeRequest, att2: AttributeRequest) =>
            att1.t.localeCompare(att2.t) || att1.v.localeCompare(att2.v)
    )
    return await hashString(JSON.stringify(sorted))
}

export async function hashString(message: string): Promise<string> {
    const msgArray = new TextEncoder().encode(message)
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgArray)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
    return hashHex
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    const timeout: Promise<T> = new Promise((_, reject) => {
        const timer = setTimeout(() => {
            clearTimeout(timer)
            reject(new Error(`timeout of ${ms} ms exceeded`))
        }, ms)
    })

    return Promise.race([p, timeout])
}

export async function getLocalFolder(folderName: string) {
    const accs = await browser.accounts.list()
    for (const acc of accs) {
        // if type is non, it is considered a local folder
        // Docs: https://webextension-api.thunderbird.net/en/latest/accounts.html#accounts-mailaccount
        if (acc.type === 'none') {
            for (const f of acc.folders) {
                if (f.name === folderName) return f
            }
            const f = await browser.folders.create(acc, folderName)
            return f
        }
    }
    return undefined
}

export async function isPGEncrypted(msgId: number): Promise<boolean> {
    // Check attachment first
    const attachments = await browser.messages.listAttachments(msgId)
    const filtered = attachments.filter((att) => att.name === 'postguard.encrypted')
    if (filtered.length === 1) return true

    // Fallback: check for armor in body
    try {
        const full = await browser.messages.getFull(msgId)
        const bodyHtml = findHtmlBody(full)
        if (bodyHtml && extractArmoredPayload(bodyHtml)) return true
    } catch {
        // ignore
    }

    return false
}

function findHtmlBody(part: any): string | null {
    if (part.contentType === 'text/html' && part.body) return part.body
    if (part.parts) {
        for (const sub of part.parts) {
            const found = findHtmlBody(sub)
            if (found) return found
        }
    }
    return null
}

export async function wasPGEncrypted(msgId: number): Promise<boolean> {
    const full = await browser.messages.getFull(msgId)
    return 'x-postguard' in full.headers
}

// ─── Armor & URL helpers ───────────────────────────────────────────

export const PG_ARMOR_BEGIN = '-----BEGIN POSTGUARD MESSAGE-----'
export const PG_ARMOR_END = '-----END POSTGUARD MESSAGE-----'
export const PG_ARMOR_DIV_ID = 'postguard-armor'
export const POSTGUARD_WEBSITE_URL = 'https://postguard.eu'
export const PG_MAX_URL_FRAGMENT_SIZE = 100_000

export function armorBase64(base64: string): string {
    const lines: string[] = []
    for (let i = 0; i < base64.length; i += 76) {
        lines.push(base64.substring(i, i + 76))
    }
    return `${PG_ARMOR_BEGIN}\n${lines.join('\n')}\n${PG_ARMOR_END}`
}

export function extractArmoredPayload(html: string): string | null {
    const regex = new RegExp(
        PG_ARMOR_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '\\s*([A-Za-z0-9+/=\\s]+?)\\s*' +
            PG_ARMOR_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    const match = html.match(regex)
    if (!match) return null
    return match[1].replace(/\s/g, '')
}

export function toUrlSafeBase64(base64: string): string {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function buildEncryptedBody(senderHtml: string, base64Encrypted: string): string {
    const compose = new ComposeMail()
    compose.setSender(senderHtml)
    let html = compose.getHtmlText()

    let fallbackLinkHtml: string
    if (base64Encrypted.length <= PG_MAX_URL_FRAGMENT_SIZE) {
        const urlSafe = toUrlSafeBase64(base64Encrypted)
        const fallbackUrl = `${POSTGUARD_WEBSITE_URL}/decrypt#${urlSafe}`
        fallbackLinkHtml =
            `<div class="outer">` +
            `<div class="numberCounter">3</div>` +
            `<div style="margin-left: 34px">` +
            `Or <a href="${fallbackUrl}">decrypt in your browser</a> ` +
            `without installing any add-on.` +
            `</div></div>`
    } else {
        fallbackLinkHtml =
            `<div class="outer">` +
            `<div class="numberCounter">3</div>` +
            `<div style="margin-left: 34px">` +
            `Or decrypt in your browser via ` +
            `<a href="${POSTGUARD_WEBSITE_URL}/decrypt">postguard.eu/decrypt</a>. ` +
            `Upload the attached <code>postguard.encrypted</code> file on that page.` +
            `</div></div>`
    }

    const armorDiv =
        `<div id="${PG_ARMOR_DIV_ID}" style="display:none;font-size:0;max-height:0;overflow:hidden;mso-hide:all">` +
        armorBase64(base64Encrypted) +
        `</div>`

    const whatIsPostguardMarker = 'What is PostGuard?'
    const markerIndex = html.indexOf(whatIsPostguardMarker)
    if (markerIndex !== -1) {
        const beforeMarker = html.substring(0, markerIndex)
        const lastOuterDiv = beforeMarker.lastIndexOf(`<div style="`)
        if (lastOuterDiv !== -1) {
            const insertionPoint = beforeMarker.lastIndexOf('</div>', lastOuterDiv)
            if (insertionPoint !== -1) {
                html =
                    html.substring(0, insertionPoint) +
                    fallbackLinkHtml +
                    html.substring(insertionPoint)
            }
        }
    }

    html = html.replace('</body>', armorDiv + '</body>')

    return html
}

// If hours <  4: seconds till 4 AM today.
// If hours >= 4: seconds till 4 AM tomorrow.
export function secondsTill4AM(): number {
    const now = Date.now()
    const nextMidnight = new Date(now).setHours(24, 0, 0, 0)
    const secondsTillMidnight = Math.round((nextMidnight - now) / 1000)
    const secondsTill4AM = secondsTillMidnight + 4 * 60 * 60
    return secondsTill4AM % (24 * 60 * 60)
}

export function type_to_image(t: string): string {
    let type: string
    switch (t) {
        case 'pbdf.sidn-pbdf.email.email':
            type = 'envelope'
            break
        case 'pbdf.sidn-pbdf.mobilenumber.mobilenumber':
            type = 'phone'
            break
        case 'pbdf.pbdf.surfnet-2.id':
            type = 'education'
            break
        case 'pbdf.nuts.agb.agbcode':
            type = 'health'
            break
        case 'pbdf.gemeente.personalData.dateofbirth':
            type = 'calendar'
            break
        default:
            type = 'personal'
            break
    }
    return type
}
