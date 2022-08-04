/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["Juggler", "JugglerFactory"];

const {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
const {ComponentUtils} = ChromeUtils.import("resource://gre/modules/ComponentUtils.jsm");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Dispatcher} = ChromeUtils.import("chrome://juggler/content/protocol/Dispatcher.js");
const {BrowserHandler} = ChromeUtils.import("chrome://juggler/content/protocol/BrowserHandler.js");
const {NetworkObserver} = ChromeUtils.import("chrome://juggler/content/NetworkObserver.js");
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const helper = new Helper();

const Cc = Components.classes;
const Ci = Components.interfaces;

const FRAME_SCRIPT = "chrome://juggler/content/content/main.js";

class Juggler {
  get classDescription() { return "Sample command-line handler"; }
  get classID() { return Components.ID('{f7a74a33-e2ab-422d-b022-4fb213dd2639}'); }
  get contractID() { return "@mozilla.org/remote/juggler;1" }
  get QueryInterface() {
    return ChromeUtils.generateQI([ Ci.nsICommandLineHandler, Ci.nsIObserver ]);
  }
  get helpInfo() {
    return "  --juggler            Enable Juggler automation\n";
  }

  handle(cmdLine) {
    // flag has to be consumed in nsICommandLineHandler:handle
    // to avoid issues on macos. See Marionette.jsm::handle() for more details.
    // TODO: remove after Bug 1724251 is fixed.
    cmdLine.handleFlag("juggler-pipe", false);
  }

  // This flow is taken from Remote agent and Marionette.
  // See https://github.com/mozilla/gecko-dev/blob/0c1b4921830e6af8bc951da01d7772de2fe60a08/remote/components/RemoteAgent.jsm#L302
  async observe(subject, topic) {
    switch (topic) {
      case "profile-after-change":
        Services.obs.addObserver(this, "command-line-startup");
        break;
      case "command-line-startup":
        Services.obs.removeObserver(this, topic);
        const cmdLine = subject;
        const jugglerPipeFlag = cmdLine.handleFlag('juggler-pipe', false);
        if (!jugglerPipeFlag)
          return;

        this._silent = cmdLine.findFlag('silent', false) >= 0;
        if (this._silent)
          Services.startup.enterLastWindowClosingSurvivalArea();
        Services.obs.addObserver(this, "final-ui-startup");
        break;
      // Used to wait until the initial application window has been opened.
      case "final-ui-startup":
        Services.obs.removeObserver(this, topic);

        const targetRegistry = new TargetRegistry();
        new NetworkObserver(targetRegistry);

        const loadFrameScript = () => {
          Services.mm.loadFrameScript(FRAME_SCRIPT, true /* aAllowDelayedLoad */);
          if (Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless) {
            const styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Components.interfaces.nsIStyleSheetService);
            const ioService = Cc["@mozilla.org/network/io-service;1"].getService(Components.interfaces.nsIIOService);
            const uri = ioService.newURI('chrome://juggler/content/content/hidden-scrollbars.css', null, null);
            styleSheetService.loadAndRegisterSheet(uri, styleSheetService.AGENT_SHEET);
          }
        };

        // Force create hidden window here, otherwise its creation later closes the web socket!
        Services.appShell.hiddenDOMWindow;

        let pipeStopped = false;
        let browserHandler;
        const pipe = Cc['@mozilla.org/juggler/remotedebuggingpipe;1'].getService(Ci.nsIRemoteDebuggingPipe);
        const connection = {
          QueryInterface: ChromeUtils.generateQI([Ci.nsIRemoteDebuggingPipeClient]),
          receiveMessage(message) {
            if (this.onmessage)
              this.onmessage({ data: message });
          },
          disconnected() {
            if (browserHandler)
              browserHandler['Browser.close']();
          },
          send(message) {
            if (pipeStopped) {
              // We are missing the response to Browser.close,
              // but everything works fine. Once we actually need it,
              // we have to stop the pipe after the response is sent.
              return;
            }
            pipe.sendMessage(message);
          },
        };
        pipe.init(connection);
        const dispatcher = new Dispatcher(connection);
        browserHandler = new BrowserHandler(dispatcher.rootSession(), dispatcher, targetRegistry, () => {
          if (this._silent)
            Services.startup.exitLastWindowClosingSurvivalArea();
          connection.onclose();
          pipe.stop();
          pipeStopped = true;
        });
        dispatcher.rootSession().setHandler(browserHandler);
        loadFrameScript();
        dump(`\nJuggler listening to the pipe\n`);
        break;
    }
  }

}

const jugglerInstance = new Juggler();

// This is used by the XPCOM codepath which expects a constructor
var JugglerFactory = function() {
  return jugglerInstance;
};

