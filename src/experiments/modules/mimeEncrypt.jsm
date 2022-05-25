/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for creating PGP/MIME signed and/or encrypted messages
 *  implemented as XPCOM component.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example
 */

/* global Components: false, ChromeUtils: false, NotifyTools: false */

'use strict'

var EXPORTED_SYMBOLS = ['PostGuardMimeEncrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const { MailServices } = Cu.import('resource:///modules/MailServices.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('pg4tb@e4a.org')
const { notifyTools } = Cu.import('resource://pg4tb/notifyTools.jsm')
const { block_on, folderPathToURI } = Cu.import('resource://pg4tb/utils.jsm')
const { clearTimeout, setTimeout } = Cu.import('resource://gre/modules/Timer.jsm')

// contract IDs
const IRMASEAL_ENCRYPT_CONTRACTID = '@e4a/irmaseal/compose-encrypted;1'
const IRMASEAL_JS_ENCRYPT_CID = Components.ID('{2b7a8e39-88d6-4ed2-91ec-f2aaf964be95}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

// Minimal buffer size before sending buffered data to the background script.
const MIN_BUFFER = 1024

// Maximum time before the decryption handler expects an answer to a message.
const MSG_TIMEOUT = 3000

function MimeEncrypt() {
    this.wrappedJSObject = this
}

MimeEncrypt.prototype = {
    classDescription: 'PostGuard Encryption Handler',
    classID: IRMASEAL_JS_ENCRYPT_CID,
    get contractID() {
        return IRMASEAL_ENCRYPT_CONTRACTID
    },

    QueryInterface: ChromeUtils.generateQI(['nsIMsgComposeSecure']),

    recipientList: null,
    msgCompFields: null,
    msgIdentity: null,
    isDraft: null,
    sendReport: null,

    outStream: null,
    outStringStream: null,
    outBuffer: '',

    init(windowId, tabId, originalSubject) {
        this.windowId = windowId
        this.tabId = tabId
        this.originalSubject = originalSubject
    },

    /**
     * Determine if encryption is required or not
     * (nsIMsgComposeSecure interface)
     *
     * @param {nsIMsgIdentity}   msgIdentity:   the sender's identity
     * @param {nsIMsgCompFields} msgCompFields: the msgCompFields object of the composer window
     *
     * @return {Boolean}:  true if the message should be encrypted, false otherwiese
     */
    requiresCryptoEncapsulation: function (msgIdentity, msgCompFields) {
        return true
    },

    /**
     * Prepare for encrypting the data (called before we get the message data)
     * (nsIMsgComposeSecure interface)
     *
     * @param {nsIOutputStream}      outStream: the stream that will consume the result of our decryption
     * @param {String}           recipientList: List of recipients, separated by space
     * @param {nsIMsgCompFields} msgCompFields: the msgCompFields object of the composer window
     * @param {nsIMsgIdentity}     msgIdentity: the sender's identity
     * @param {nsIMsgSendReport}    sendReport: report progress to TB
     * @param {Boolean}                isDraft: true if saving draft
     *
     * (no return value)
     */
    beginCryptoEncapsulation: function (
        outStream,
        recipientList,
        msgCompFields,
        msgIdentity,
        sendReport,
        isDraft
    ) {
        DEBUG_LOG('mimeEncrypt.jsm: beginCryptoEncapsulation()\n')

        this.outStream = outStream
        this.outStringStream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(
            Ci.nsIStringInputStream
        )

        this.recipientList = recipientList
        this.msgCompFields = msgCompFields
        this.msgIdentity = msgIdentity
        this.sendReport = sendReport
        this.isDraft = isDraft
        this.aborted = false
        this.buffer = ''
        this.bufferCount = 0

        this.initFile()

        // After 1 second of not receiving data this promise rejects.
        // This is to make sure it never fully blocks.
        this.finished = new Promise((resolve, reject) => {
            var timeout = setTimeout(() => reject(new Error('timeout')), MSG_TIMEOUT)
            this.listener = notifyTools.addListener((msg) => {
                switch (msg.command) {
                    case 'enc_ct':
                        clearTimeout(timeout)
                        timeout = setTimeout(() => reject(new Error('timeout')), MSG_TIMEOUT)

                        this.writeOut(msg.data)
                        break
                    case 'enc_finished':
                        resolve()
                        break
                    case 'enc_aborted':
                        this.aborted = true
                        reject(msg.error)
                        break
                }
                return
            })
        })

        this.copySentFolderPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(reject, 3000, new Error('waiting for copyFolder too long'))
            this.copyFolderListener = notifyTools.addListener((msg) => {
                if (msg.command === 'enc_copy_folder') {
                    clearTimeout(timer)
                    resolve(msg.folder)
                }
                return
            })
        })

        this.aborted = block_on(
            Promise.race([
                new Promise((resolve, _) => setTimeout(resolve, MSG_TIMEOUT, true)),
                notifyTools
                    .notifyBackground({
                        command: 'enc_init',
                        tabId: this.tabId,
                    })
                    .then(() => this.aborted),
            ])
        )
        if (this.aborted) return

        // Both sides are ready.
        notifyTools.notifyBackground({ command: 'enc_start', tabId: this.tabId })

        var headers = ''
        headers += `Date: ${new Date().toUTCString()}\r\n`
        headers += `From: ${msgCompFields.from}\r\n`
        headers += `To: ${msgCompFields.to}\r\n`
        headers += `Subject: ${this.originalSubject}\r\n`
        headers += 'MIME-Version: 1.0\r\n'
        if (msgCompFields.cc) headers += `Cc: ${msgCompFields.cc}\r\n`

        this.foStream.write(headers, headers.length)
        notifyTools.notifyBackground({ command: 'enc_plain', tabId: this.tabId, data: headers })

        DEBUG_LOG(`mimeEncrypt.jsm: beginCryptoEncapsulation(): finish\n`)
    },

    /**
     * Encrypt a block of data (we are getting called for every bit of
     * data that TB sends to us). Most likely the data gets fed line by line
     * (nsIMsgComposeSecure interface)
     *
     * @param {String} buffer: buffer containing the data
     * @param {Number} length: number of bytes
     *
     * (no return value)
     */
    mimeCryptoWriteBlock: function (data, length) {
        if (this.aborted) return
        this.foStream.write(data, length)

        this.buffer += data
        this.bufferCount += length

        if (this.bufferCount > MIN_BUFFER) {
            notifyTools.notifyBackground({
                command: 'enc_plain',
                tabId: this.tabId,
                data: this.buffer,
            })
            this.buffer = ''
            this.bufferCount = 0
        }
    },

    /**
     * we got all data; time to return something to Thunderbird
     * (nsIMsgComposeSecure interface)
     *
     * @param {Boolean}          abort: if true, sending is aborted
     * @param {nsIMsgSendReport} sendReport: report progress to TB
     *
     * (no return value)
     */
    finishCryptoEncapsulation: function (abort, sendReport) {
        if (this.aborted || abort) {
            this.foStream.close()
            this.tempFile.remove(false)
            return
        }
        DEBUG_LOG(`mimeEncrypt.jsm: finishCryptoEncapsulation()\n`)

        // Flush the remaining buffer.
        if (this.bufferCount) {
            notifyTools.notifyBackground({
                command: 'enc_plain',
                tabId: this.tabId,
                data: this.buffer,
            })
        }

        // Notify background that no new chunks will be coming.
        notifyTools.notifyBackground({ command: 'enc_finalize', tabId: this.tabId })

        try {
            block_on(this.finished)
        } catch (e) {
            ERROR_LOG(e)
            return
        }

        notifyTools.removeListener(this.listener)
        this.foStream.close()

        DEBUG_LOG('mimeEncrypt: encryption complete.')

        this.copySentFolderPromise
            .then((copySentFolder) => {
                const { accountId, path } = copySentFolder
                const copySentFolderURI = folderPathToURI(accountId, path)
                DEBUG_LOG(`got folder: ${copySentFolderURI}`)
                let tempFile = this.tempFile
                if (copySentFolderURI) {
                    const copyListener = {
                        GetMessageId(messageId) {},
                        OnProgress(progress, progressMax) {},
                        OnStartCopy() {},
                        SetMessageKey(key) {
                            DEBUG_LOG(
                                `mimeEncrypt.jsm: copyListener: copyListener: SetMessageKey(${key})\n`
                            )
                        },
                        OnStopCopy(statusCode) {
                            if (statusCode !== 0) {
                                DEBUG_LOG(
                                    `mimeEncrypt.jsm: copyListener: Error copying message: ${statusCode}\n`
                                )
                            }
                            try {
                                tempFile.remove(false)
                            } catch (ex) {
                                DEBUG_LOG(
                                    'mimeEncrypt.jsm: copyListener: Could not delete temp file\n'
                                )
                                ERROR_LOG(ex)
                            }
                        },
                    }

                    DEBUG_LOG(`Copying to folder with URI ${copySentFolderURI}`)

                    MailServices.copy.copyFileMessage(
                        this.tempFile,
                        MailUtils.getExistingFolder(copySentFolderURI),
                        null,
                        false,
                        0,
                        '',
                        copyListener,
                        null
                    )
                }
            })
            .catch((e) => {
                DEBUG_LOG(
                    `unable to retrieve folder for copies of plaintext messages: ${e.message}`
                )
                this.tempFile.remove(false)
            })
            .finally(() => notifyTools.removeListener(this.copyFolderListener))

        DEBUG_LOG(`mimeEncrypt.jsm: finishCryptoEncapsulation(): done\n`)
    },

    writeOut: function (content) {
        this.outStringStream.setData(content, content.length)
        var writeCount = this.outStream.writeFrom(this.outStringStream, content.length)
        if (writeCount < content.length) {
            DEBUG_LOG(
                `mimeEncrypt.jsm: writeOut: wrote ${writeCount} instead of  ${content.length} bytes\n`
            )
        }
    },

    initFile: function () {
        this.tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
        this.tempFile.append('message.eml')
        this.tempFile.createUnique(0, 0o600)

        // ensure that file gets deleted on exit, if something goes wrong ...
        let extAppLauncher = Cc['@mozilla.org/mime;1'].getService(Ci.nsPIExternalAppLauncher)
        this.foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
            Ci.nsIFileOutputStream
        )
        this.foStream.init(this.tempFile, 2, 0x200, false) // open as "write only"

        extAppLauncher.deleteTemporaryFileOnExit(this.tempFile)
    },
}

// Factory used to register a component in Thunderbird
class Factory {
    constructor(component) {
        this.component = component
        this.register()
        Object.freeze(this)
    }

    createInstance(outer, iid) {
        if (outer) {
            throw Cr.NS_ERROR_NO_AGGREGATION
        }
        return new this.component()
    }

    register() {
        Cm.registerFactory(
            this.component.prototype.classID,
            this.component.prototype.classDescription,
            this.component.prototype.contractID,
            this
        )
    }

    unregister() {
        Cm.unregisterFactory(this.component.prototype.classID, this)
    }
}

// Exported API that will register and unregister the class Factory
var PostGuardMimeEncrypt = {
    startup: function (reason) {
        this.factory = new Factory(MimeEncrypt)
    },

    shutdown: function (reason) {
        if (this.factory) {
            this.factory.unregister()
        }
    },
}