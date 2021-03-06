/* jshint node: true */
'use strict';

var log = {
  generateArguments: function(args) {
    var argsArray = Array.slice(args);
    argsArray.unshift('[PassFF]');
    return argsArray;
  }
};

(function() {
  function logPrototype() {
    if (PassFF.Preferences) {
      // jshint validthis: true
      this.apply(console, log.generateArguments(arguments));
    }
  }
  log.debug = logPrototype.bind(console.debug);
  log.info  = logPrototype.bind(console.info);
  log.warn  = logPrototype.bind(console.warn);
  log.error = logPrototype.bind(console.error);
})();

function getActiveTab() {
  return browser.tabs.query({active: true, currentWindow: true})
         .then((tabs) => { return tabs[0]; });
}

var PassFF = {
  Ids: {
    button: 'passff-button',
    key: 'passff-key',
    keyset: 'passff-keyset',
    searchbox: 'passff-search-box',
    searchboxlabel: 'passff-search-box-label',
    entrieslist: 'passff-entries-list',
    contextlist: 'passff-context-list',
    optionsmenu: 'passff-options-menu',
    optionsmenupopup: 'passff-options-menupopup',
    rootbutton: 'passff-root-button',
    contextbutton: 'passff-context-button',
    buttonsbox: 'passff-buttonsbox',
    refreshmenuitem: 'passff-refresh-menuitem',
    prefsmenuitem: 'passff-prefs-menuitem',
    newpasswordmenuitem: 'passff-new-password-menuitem',
    menubar: 'passff-menubar',
    menu: 'passff-menu-',
  },

  tab_url: null,

  load_scripts: function (scripts) {
    let path_prefix = "modules/";
    if (PassFF.mode !== "background" && PassFF.mode !== "page") {
      path_prefix = "../" + path_prefix;
    }
    let promises = scripts.map((script) => {
      let scriptEl = document.createElement("script");
      scriptEl.src = path_prefix + script;
      document.getElementsByTagName('head')[0].appendChild(scriptEl);
      return new Promise(function (resolve, reject) {
        scriptEl.addEventListener("load", resolve);
      });
    });
    return Promise.all(promises);
  },

  menu_state: {
    'context_url': null,
    'search_val': "",
    '_items': null,
    get items() {
      return this._items;
    },
    set items(new_items) {
      this._items = new_items;
      chrome.contextMenus.removeAll();
      chrome.contextMenus.create({
        id: "login-add",
        title: "Add login input name",
        contexts: ["editable"]
      });
      chrome.contextMenus.create({
        id: "sep",
        type: "separator",
        contexts: ["editable"]
      });
      if (this._items == null) {
        return;
      } else if (this._items instanceof Array) {
        this._items.slice(0,3).forEach(this.addItemContext);
      } else {
        this.addItemContext(PassFF.Pass.getItemById(this._items).toObject());
      }
    },
    'addItemContext': function (i) {
      if (i.isLeaf) {
        chrome.contextMenus.create({
          id: "login-"+i.id,
          title: i.fullKey,
          contexts: ["editable"]
        });
      }
    },
    'toObject': function () {
      return {
        'context_url': this.context_url,
        'search_val': this.search_val,
        'items': this.items
      };
    }
  },

  currentHttpAuth: null,

  gsfm: function (key, params) {
    if (params) {
      return browser.i18n.getMessage(key, params);
    }
    return browser.i18n.getMessage(key);
  },

  alert: function(msg) {
    browser.tabs.executeScript({code : 'alert(' + JSON.stringify(msg) + ');' });
  },

  init: function() {
    if (window.location.href.indexOf("moz-extension") !== 0) {
      PassFF.mode = "content";
    } else {
      PassFF.mode = document.querySelector("body").id;
      if (typeof PassFF.mode === "undefined") {
        PassFF.mode = "background";
      }
    }

    return PassFF.load_scripts(["preferences.js"])
      .then(() => { return PassFF.Preferences.init(); })
      .then(() => {
        switch (PassFF.mode) {
          case "content":
            log.debug("init content script");
            break;
          case "itemPicker":
            log.debug("init popup for HTTP authentication");
            return PassFF.load_scripts(["menu.js"])
              .then(() => { return PassFF.Menu.init(); });
            break;
          case "itemMonitor":
            log.debug("init popup for item display");
            return PassFF.init_itemMonitor();
            break;
          case "passwordGenerator":
            log.debug("init popup for password generation/insertion");
            return PassFF.load_scripts(["passwordGenerator.js"]);
            break;
          case "menu":
            log.debug("init browser action popup");
            return PassFF.load_scripts(["menu.js"])
              .then(() => { return PassFF.Menu.init(); });
            break;
          case "preferences":
            log.debug("init preferences page");
            return PassFF.Preferences.init_ui();
            break;
          default:
            log.debug("init background script");
            return PassFF.load_scripts(["pass.js","page.js","shortcut-helper.js"])
              .then(() => { return PassFF.Pass.init(); })
              .then(() => { return PassFF.init_bg(); });
        }
      });
  },

  init_bg: function () {
    browser.tabs.onUpdated.addListener(PassFF.onTabUpdate);
    browser.tabs.onActivated.addListener(PassFF.onTabUpdate);
    PassFF.onTabUpdate();
    browser.runtime.onMessage.addListener(PassFF.bg_handle);
    browser.contextMenus.onClicked.addListener(PassFF.Page.onContextMenu);
    PassFF.init_http_auth();
  },

  init_itemMonitor: function () {
    let passOutputEl = document.getElementsByTagName("pre")[0];
    let restOutputEl = document.getElementsByTagName("pre")[1];
    document.querySelector("div:first-child > span").textContent
      = PassFF.gsfm("passff_display_hover");
    PassFF.bg_exec('getDisplayItemData')
      .then((passwordData) => {
        let otherData = passwordData['fullText'];
        let sep = otherData.indexOf("\n");
        passOutputEl.textContent = passwordData['password'];
        restOutputEl.textContent = otherData.substring(sep+1);
      });
  },

  init_http_auth: function () {
    log.debug("Initialize HTTP authentication", PassFF.Preferences.handleHttpAuth);
    PassFF.resetHttpAuth();
    browser.webRequest.onAuthRequired.removeListener(PassFF.onHttpAuth);
    if(PassFF.Preferences.handleHttpAuth) {
      browser.webRequest.onAuthRequired.addListener(
        PassFF.onHttpAuth, { urls: ["<all_urls>"] }, ["blocking"]
      );
    }
  },

  init_tab: function (tab) {
    // do nothing if called from a non-tab context
    if (!tab || !tab.url) {
      return;
    }

    log.debug('Location changed', tab.url, tab.status);

    if (tab.url != PassFF.tab_url && PassFF.currentHttpAuth.details == null) {
      PassFF.tab_url = tab.url;
      let items = PassFF.Pass.getUrlMatchingItems(PassFF.tab_url);
      PassFF.menu_state.items = items.map((i) => { return i.toObject(true); });
    }

    if (PassFF.currentHttpAuth.details !== null) {
      PassFF.tab_url = PassFF.currentHttpAuth.details.url;
      let items = PassFF.Pass.getUrlMatchingItems(PassFF.tab_url);
      PassFF.menu_state.items = items.map((i) => { return i.toObject(true); });
    }

    // Allow our browser command to bypass the usual dom event mapping, so that
    // the keyboard shortcut still works, even  when a password field is focused.
    //
    // Read the _execute_browser_action command to get its shortcut. We're
    // ignoring the shortcut specified in preferences because there is
    // currently no way to apply that preference. See open mozilla bug at
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1215061
    getCommandByName('_execute_browser_action').then((shortcut) => {
      // Attach a DOM-level event handler for our command key, so it works
      // even if an input box is focused.
      PassFF.Page.swallowShortcut(tab, shortcut);
    });

    if (/^https?/.exec(tab.url) && tab.status == "complete") {
        // Start auto fill only for readily loaded web pages
        PassFF.Page.tabAutoFill(tab);
    }
  },

  onTabUpdate: function () {
    getActiveTab().then(PassFF.init_tab);
  },

  onHttpAuth: function (requestDetails) {
    PassFF.cancelHttpAuth();
    PassFF.currentHttpAuth.details = requestDetails;
    return new Promise((resolve, reject) => {
      browser.windows.create({
        'url': browser.extension.getURL('content/itemPicker.html'),
        'width': 450,
        'height': 280,
        'type': 'popup',
      }).then((win) => {
        PassFF.currentHttpAuth.popup = win;
        PassFF.currentHttpAuth.onClose = function (windowId) {
          if (win.id === windowId) {
            PassFF.cancelHttpAuth();
          }
        };
        browser.windows.onRemoved.addListener(PassFF.currentHttpAuth.onClose);
      });
      PassFF.currentHttpAuth.resolve = resolve;
    });
  },

  cancelHttpAuth: function () {
    if (typeof PassFF.currentHttpAuth.resolve === 'function') {
      PassFF.currentHttpAuth.resolve({ cancel: false });
    }
    PassFF.resetHttpAuth();
  },

  resetHttpAuth: function () {
    if (PassFF.currentHttpAuth !== null
        && PassFF.currentHttpAuth.popup !== null) {
      browser.windows.onRemoved.removeListener(PassFF.currentHttpAuth.onClose);
      browser.windows.remove(PassFF.currentHttpAuth.popup.id);
    }
    PassFF.currentHttpAuth = {
      details: null,
      promise: null,
      popup: null,
      resolve: null,
    };
  },

  bg_exec: function (action) {
    return browser.runtime.sendMessage({
      action: action,
      params: [].slice.call(arguments).slice(1)
    }).then((msg) => {
      if (msg) {
        return msg.response;
      } else {
        return null;
      }
    }).catch((error) => {
      log.error("Runtime port has crashed:", error);
    });
  },

  bg_handle: function (request, sender, sendResponse) {
    if (request.action == "Pass.getUrlMatchingItems") {
      let items = PassFF.Pass.rootItems;
      if (PassFF.tab_url !== null) {
        items = PassFF.Pass.getUrlMatchingItems(PassFF.tab_url);
        if (items.length === 0) {
          items = PassFF.Pass.rootItems;
        }
      }
      items = items.map((i) => { return i.toObject(true); });
      PassFF.menu_state.context_url = PassFF.tab_url;
      PassFF.menu_state.search_val = "";
      PassFF.menu_state.items = items;
      sendResponse({ response: items });
    } else if (request.action == "Pass.getMatchingItems") {
      let val = request.params[0];
      let lim = request.params[1];
      let matchingItems = PassFF.Pass.getMatchingItems(val, lim);
      matchingItems = matchingItems.map((i) => { return i.toObject(true); });
      PassFF.menu_state.context_url = PassFF.tab_url;
      PassFF.menu_state.search_val = val;
      PassFF.menu_state.items = matchingItems;
      sendResponse({ response: matchingItems });
    } else if (request.action == "Pass.rootItems") {
      let items = PassFF.Pass.rootItems;
      items = items.map((i) => { return i.toObject(true); });
      PassFF.menu_state.context_url = PassFF.tab_url;
      PassFF.menu_state.search_val = "";
      PassFF.menu_state.items = items;
      sendResponse({ response: items });
    } else if (request.action == "Pass.getItemById") {
      PassFF.menu_state.context_url = PassFF.tab_url;
      PassFF.menu_state.items = request.params[0];
      let item = PassFF.Pass.getItemById(request.params[0]);
      sendResponse({ response: item.toObject(true) });
    } else if (request.action == "Pass.getPasswordData") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      PassFF.Pass.getPasswordData(item).then((passwordData) => {
        log.debug("sending response");
        sendResponse({ response: passwordData });
      });
      return true;
    } else if (request.action == "Pass.addNewPassword") {
      PassFF.Pass.addNewPassword.apply(PassFF.Pass, request.params)
      .then((result) => {
        sendResponse({ response: result });
      });
      return true;
    } else if (request.action == "Pass.generateNewPassword") {
      PassFF.Pass.generateNewPassword.apply(PassFF.Pass, request.params)
      .then((result) => {
        sendResponse({ response: result });
      });
      return true;
    } else if (request.action == "Pass.isPasswordNameTaken") {
      sendResponse({
        response: PassFF.Pass.isPasswordNameTaken(request.params[0])
      });
    } else if (request.action == "Menu.restore") {
      if(PassFF.menu_state.context_url != PassFF.tab_url) {
        PassFF.menu_state.context_url = null;
        PassFF.menu_state.search_val = "";
        PassFF.menu_state.items = null;
      }
      sendResponse({
        response: PassFF.menu_state.toObject()
      });
    } else if (request.action == "Menu.onEnter") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      let shiftKey = request.params[1];
      log.debug("onEnter", item, shiftKey);
      switch (PassFF.Preferences.enterBehavior) {
        case 0:
          //goto url, fill, submit
          PassFF.Page.goToItemUrl(item, shiftKey, true, true);
          break;
        case 1:
          //goto url, fill
          PassFF.Page.goToItemUrl(item, shiftKey, true, false);
          break;
        case 2:
          //fill, submit
          getActiveTab().then((tb) => {
            return PassFF.Page.fillInputs(tb.id, item);
          }).then((tabId) => {
            PassFF.Page.submit(tabId);
          });
          break;
        case 3:
          //fill
          getActiveTab().then((tb) => {
            PassFF.Page.fillInputs(tb.id, item);
          });
          break;
      }
    } else if (request.action == "Menu.onCopyToClipboard") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      let dataKey = request.params[1];
      PassFF.Pass.getPasswordData(item).then((passwordData) => {
        copyToClipboard(passwordData[dataKey]);
      });
    } else if (request.action == "Menu.onDisplayItemData") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      PassFF.Pass.getPasswordData(item).then((passwordData) => {
        PassFF._displayItemData = passwordData;
        return browser.windows.create({
          'url': browser.extension.getURL('content/itemMonitor.html'),
          'width': 640,
          'height': 250,
          'type': 'popup',
        });
      });
    } else if (request.action == "Menu.onPickItem") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      log.debug("Resolve HTTP auth", item);
      PassFF.Pass.getPasswordData(item).then((passwordData) => {
        PassFF.currentHttpAuth.resolve({
          authCredentials: {
            username: passwordData.login,
            password: passwordData.password
          }
        });
        PassFF.resetHttpAuth();
      });
    } else if (request.action == "Page.goToItemUrl") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      PassFF.Page.goToItemUrl(item, request.params[1], request.params[2], request.params[3]);
    } else if (request.action == "Page.fillInputs") {
      let item = PassFF.Pass.getItemById(request.params[0]);
      let andSubmit = request.params[1];
      getActiveTab().then((tab) => {
        return PassFF.Page.fillInputs(tab, item).then(() => {
          if (andSubmit) PassFF.Page.submit(tab);
        });
      });
    } else if (request.action == "Preferences.addInputName") {
      if (PassFF.Preferences.addInputName(request.params[0], request.params[1])) {
        PassFF.Preferences.init(true)
          .then(() => PassFF.Pass.init());
      }
    } else if (request.action == "getDisplayItemData") {
      sendResponse({ response: PassFF._displayItemData });
      PassFF._displayItemData = null;
    } else if (request.action == "getItemPickerData") {
      sendResponse({ response: PassFF.currentHttpAuth.details.url });
    } else if (request.action == "openOptionsPage") {
      browser.runtime.openOptionsPage();
    } else if (request.action == "refresh") {
      PassFF.Preferences.init(true)
        .then(() => PassFF.Pass.init())
        .then(() => sendResponse());
      return true;
    }
  }
};

window.onload = function () {
  PassFF.init();
}
