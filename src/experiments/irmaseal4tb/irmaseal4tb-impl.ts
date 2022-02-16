/**
 * IRMAseal thunderbird experiment
 */

/* global Components: false */

declare const Components
const { classes: Cc, interfaces: Ci, utils: Cu } = Components

const { ExtensionCommon } = Cu.import('resource://gre/modules/ExtensionCommon.jsm')
const { Services } = Cu.import('resource://gre/modules/Services.jsm')
const { ExtensionParent } = Cu.import('resource://gre/modules/ExtensionParent.jsm')
const extension = ExtensionParent.GlobalManager.getExtension('irmaseal4tb@e4a.org')

// To load and unload modules
const loadJsm = (path: string) => Cu.import(extension.rootURI.resolve(path))
const unloadJsm = (path: string) => Cu.unload(extension.rootURI.resolve(path))

const DEBUG_LOG = (str: string) => Services.console.logStringMessage(`[EXPERIMENT]: ${str}`)
const ERROR_LOG = (ex) => DEBUG_LOG(`exception: ${ex.toString()}, stack: ${ex.stack}`)

export default class irmaseal4tb extends ExtensionCommon.ExtensionAPI {
    public getAPI(context) {
        return {
            irmaseal4tb: {
                setSecurityInfo: function (windowId: number) {
                    DEBUG_LOG('irmaseal4tb.js: setSecurityInfo()\n')
                    let compSec = Cc['@e4a/irmaseal/compose-encrypted;1'].createInstance(
                        Ci.nsIMsgComposeSecure
                    )

                    compSec = compSec.wrappedJSObject

                    // Get window by windowId
                    const windowObject = context.extension.windowManager.get(windowId)
                    const win = windowObject.window

                    if (win.gMsgCompose.compFields) {
                        if ('securityInfo' in win.gMsgCompose.compFields) {
                            // TB < 64
                            win.gMsgCompose.compFields.securityInfo = compSec
                        } else {
                            // TB >
                            win.gMsgCompose.compFields.composeSecure = compSec
                        }
                    }
                    DEBUG_LOG('irmaseal4tb.js: setSecurityInfo() complete\n')
                    return Promise.resolve()
                },
            },
        }
    }

    public onStartup(): void {
        try {
            DEBUG_LOG('starting experiment')
            const { IRMAsealMimeEncrypt } = loadJsm('irmaseal4tb/mimeEncrypt.jsm')
            IRMAsealMimeEncrypt.startup()
            DEBUG_LOG('all modules loaded')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }

    public onShutdown(isAppShutdown: boolean): void {
        if (isAppShutdown) {
            DEBUG_LOG('shutting down experiment')
            return
        }

        try {
            DEBUG_LOG('unloading modules')
            const { IRMAsealMimeEncrypt } = loadJsm('irmaseal4tb/mimeEncrypt.jsm')
            IRMAsealMimeEncrypt.shutdown()
            unloadJsm('irmaseal4tb/mimeEncrypt.jsm')
            DEBUG_LOG('invalidating startup cache')
            Services.obs.notifyObservers(null, 'startupcache-invalidate', null)
            DEBUG_LOG('succesfully shutdown experiment')
        } catch (ex) {
            ERROR_LOG(ex)
        }
    }
}