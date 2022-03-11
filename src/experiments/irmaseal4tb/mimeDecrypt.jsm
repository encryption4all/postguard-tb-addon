/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *  Module for handling PGP/MIME encrypted messages
 *  implemented as an XPCOM object.
 *  Adapted from: https://gitlab.com/pbrunschwig/thunderbird-encryption-example/-/blob/master/chrome/content/modules/mimeDecrypt.jsm
 */

/* global Components: false, ChromeUtils: false, NotifyTools: false */

'use strict'

var EXPORTED_SYMBOLS = ['IRMAsealMimeDecrypt']

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr, manager: Cm } = Components

Cm.QueryInterface(Ci.nsIComponentRegistrar)

const Services = Cu.import('resource://gre/modules/Services.jsm').Services
const { ExtensionCommon } = ChromeUtils.import('resource://gre/modules/ExtensionCommon.jsm')
const { ExtensionParent } = ChromeUtils.import('resource://gre/modules/ExtensionParent.jsm')
const { MailServices } = Cu.import('resource:///modules/MailServices.jsm')
const { MailUtils } = Cu.import('resource:///modules/MailUtils.jsm')

const extension = ExtensionParent.GlobalManager.getExtension('irmaseal4tb@e4a.org')
const { notifyTools } = Cu.import(extension.rootURI.resolve('irmaseal4tb/notifyTools.js'))
const { block_on, folderPathToURI } = Cu.import(extension.rootURI.resolve('irmaseal4tb/utils.jsm'))
const { clearTimeout, setTimeout } = ChromeUtils.import('resource://gre/modules/Timer.jsm')

const MIME_JS_DECRYPTOR_CONTRACTID = '@mozilla.org/mime/pgp-mime-js-decrypt;1'
const MIME_JS_DECRYPTOR_CID = Components.ID('{f3a50b87-b198-42c0-86d9-116aca7180b3}')

const DEBUG_LOG = (str) => Services.console.logStringMessage(`[experiment]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

const MIN_BUFFER = 1024

function MimeDecryptHandler() {
    DEBUG_LOG('mimeDecrypt.jsm: new MimeDecryptHandler()\n')
    this.mimeProxy = null
    this.msgHdr = null
    this.msgId = null
}

MimeDecryptHandler.prototype = {
    classDescription: 'IRMAseal/MIME JS Decryption Handler',
    classID: MIME_JS_DECRYPTOR_CID,
    contractID: MIME_JS_DECRYPTOR_CONTRACTID,
    QueryInterface: ChromeUtils.generateQI([Ci.nsIStreamListener]),

    inStream: Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream),

    // the MIME handler needs to implement the nsIStreamListener API
    onStartRequest: function (request) {
        DEBUG_LOG('mimeDecrypt.jsm: onStartRequest()\n')
        this.mimeProxy = request.QueryInterface(Ci.nsIPgpMimeProxy)
        this.uri = this.mimeProxy.messageURI

        if (this.uri) {
            this.msgHdr = this.uri.QueryInterface(Ci.nsIMsgMessageUrl).messageHeader
            this.copyReceivedFolderURI = this.msgHdr.folder.URI.replace(
                'INBOX',
                'Cryptify Received'
            )
            DEBUG_LOG(`copyReceivedFolderURI: ${this.copyReceivedFolderURI}`)
            this.msgId = extension.messageManager.convert(this.msgHdr).id
            DEBUG_LOG(`msgId: ${this.msgId}`)
        }

        this.buffer = ''
        this.bufferCount = 0
        this.sessionStarted = false
        this.sessionCompleted = false
        this.aborted = false

        // add a listener to wait for decrypted blocks
        // initially waits one minute for a session to start
        this.finishedPromise = new Promise((resolve, reject) => {
            this.sessionPromise = new Promise((resolve2, reject2) => {
                var timeout = setTimeout(
                    () => reject(new Error('wait for session timed out')),
                    60000
                )
                this.listener = notifyTools.addListener((msg) => {
                    switch (msg.command) {
                        case 'dec_session_start':
                            DEBUG_LOG('session started')
                            this.sessionStarted = true
                            clearTimeout(timeout)
                            timeout = setTimeout(() => reject(new Error('session timeout')), 60000)
                            return
                        case 'dec_session_complete':
                            DEBUG_LOG('session complete')
                            this.sessionCompleted = true
                            this.initFile()
                            resolve2()
                            return
                        case 'dec_plain':
                            DEBUG_LOG(`got some plaintext: ${msg.data}`)
                            clearTimeout(timeout)
                            timeout = setTimeout(
                                () => reject(new Error('plaintext chunks timeout')),
                                5000
                            )
                            this.mimeProxy.outputDecryptedData(msg.data, msg.data.length)
                            this.foStream.write(msg.data, msg.data.length)
                            return
                        case 'dec_finished':
                            resolve()
                            return
                        case 'dec_aborted':
                            DEBUG_LOG(`decryption aborted due to error: ${msg.error}`)
                            this.aborted = true
                            reject(new Error(msg.error))
                            reject2(new Error(msg.error))
                            return
                    }
                })
            })
        })

        // Wait till both sides are ready.
        block_on(
            notifyTools.notifyBackground({
                command: 'dec_init',
                msgId: this.msgId,
            })
        )

        // Both sides are ready, start reading from metadata.
        if (!this.aborted)
            notifyTools.notifyBackground({ command: 'dec_metadata', msgId: this.msgId })
    },

    onDataAvailable: function (req, stream, offset, count) {
        DEBUG_LOG(
            `onDataAvailable: started: ${this.sessionStarted}, completed: ${this.sessionCompleted}, aborted: ${this.aborted}, count: ${count}`
        )
        if (this.aborted || count === 0) return
        if (this.sessionStarted && !this.sessionCompleted) this.blockOnSession()

        this.inStream.setInputStream(stream)
        const data = this.inStream.readBytes(count)

        // Check if the data is base64 encoded.
        let b64
        try {
            b64 = btoa(data)
        } catch (e) {
            b64 = data
        }

        // Ignore the newlines
        if (b64 == '\n') return

        this.buffer += b64
        this.bufferCount += count

        if (this.bufferCount > MIN_BUFFER) {
            block_on(
                notifyTools.notifyBackground({
                    command: 'dec_ct',
                    msgId: this.msgId,
                    data: this.buffer,
                })
            )

            this.buffer = ''
            this.bufferCount = 0
        }
    },

    onStopRequest: function (request, status) {
        DEBUG_LOG('mimeDecrypt.jsm: onStartRequest(): start\n')
        if (this.aborted) {
            notifyTools.removeListener(this.listener)
            return
        }

        if (this.bufferCount > 0) {
            block_on(
                notifyTools.notifyBackground({
                    command: 'dec_ct',
                    msgId: this.msgId,
                    data: this.buffer,
                })
            )
        }

        if (!this.sessionCompleted) this.blockOnSession()

        try {
            DEBUG_LOG('sending finalize command')
            notifyTools.notifyBackground({ command: 'dec_finalize', msgId: this.msgId })
            block_on(this.finishedPromise)
            this.closeAndCopyFile()
        } catch (e) {
            ERROR_LOG(e)
            throw e
        } finally {
            notifyTools.removeListener(this.listener)
            DEBUG_LOG(`mimeDecrypt.jsm: onStopRequest(): succesfully completed: ${!this.aborted}`)
        }
    },

    blockOnSession: function () {
        // There is a session is ongoing, block until it completes.
        // Then, signal for the decryption to start.
        DEBUG_LOG('session was not yet completed. blocking..')
        block_on(this.sessionPromise)
        DEBUG_LOG('session completed. sending start command')
        notifyTools.notifyBackground({ command: 'dec_start', msgId: this.msgId })
    },

    initFile: function () {
        this.tempFile = Services.dirsvc.get('TmpD', Ci.nsIFile)
        this.tempFile.append('message.eml')
        this.tempFile.createUnique(0, 384) // == 0600, octal is deprecated

        // ensure that file gets deleted on exit, if something goes wrong ...
        let extAppLauncher = Cc['@mozilla.org/mime;1'].getService(Ci.nsPIExternalAppLauncher)

        this.foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(
            Ci.nsIFileOutputStream
        )
        this.foStream.init(this.tempFile, 2, 0x200, false) // open as "write only"
        extAppLauncher.deleteTemporaryFileOnExit(this.tempFile)
    },

    closeAndCopyFile: function () {
        this.foStream.close()
        const tempFile = this.tempFile
        const copyListener = {
            GetMessageId(messageId) {},
            OnProgress(progress, progressMax) {},
            OnStartCopy() {},
            SetMessageKey(key) {
                DEBUG_LOG(`mimeDecrypt.jsm: copyListener: copyListener: SetMessageKey(${key})\n`)
            },
            OnStopCopy(statusCode) {
                if (statusCode !== 0) {
                    DEBUG_LOG(
                        `mimeDecrypt.jsm: copyListener: Error copying message: ${statusCode}\n`
                    )
                }
                try {
                    tempFile.remove(false)
                } catch (ex) {
                    DEBUG_LOG('mimeDecrypt.jsm: copyListener: Could not delete temp file\n')
                    ERROR_LOG(ex)
                }
            },
        }

        DEBUG_LOG(`Copying to folder with URI ${this.copyReceivedFolderURI}`)

        MailServices.copy.copyFileMessage(
            this.tempFile,
            MailUtils.getExistingFolder(this.copyReceivedFolderURI),
            null,
            false,
            0,
            '',
            copyListener,
            null
        )
    },
}

// Factory used to register the component in Thunderbird
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
var IRMAsealMimeDecrypt = {
    startup: function (reason) {
        try {
            this.factory = new Factory(MimeDecryptHandler)

            // re-use the PGP/MIME handler for our own purposes
            // only required if you want to decrypt something else than Content-Type: multipart/encrypted

            let reg = Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
            let pgpMimeClass = Components.classes['@mozilla.org/mimecth;1?type=multipart/encrypted']

            reg.registerFactory(
                pgpMimeClass,
                'IRMASeal Decryption Module',
                '@mozilla.org/mimecth;1?type=application/irmaseal',
                null
            )
        } catch (ex) {
            DEBUG_LOG(ex.message)
        }
    },

    shutdown: function (reason) {
        if (this.factory) {
            this.factory.unregister()
        }
    },
}
