/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/httpswitchboard
*/

// ORDER IS IMPORTANT

/******************************************************************************/

// rhill 20131017 > https://github.com/gorhill/httpswitchboard/issues/9:
// HTTP Switchboard relinquishes all control of cookies settings (it will
// however keep removing outbound cookies from headers, so this is equivalent
// to a recording machine which can never be played back).
chrome.contentSettings.cookies.clear({});

// https://github.com/gorhill/httpswitchboard/issues/37
chrome.contentSettings.plugins.clear({});

/******************************************************************************/

HTTPSB.turnOn();

/******************************************************************************/

function onUpdatedTabsHandler(tabId, changeInfo, tab) {
    // Can this happen?
    if ( !tab.url || !tab.url.length ) {
        return;
    }

    var pageUrl = uriTools.normalizeURI(tab.url);

    // console.debug('tabs.onUpdated > tabId=%d changeInfo=%o tab=%o', tabId, changeInfo, tab);
    var protocol = uriTools.schemeFromURI(pageUrl);
    if ( protocol !== 'http' && protocol !== 'https' ) {
        return;
    }

    // Following code is for script injection, which makes sense only if
    // web page in tab is completely loaded.
    if ( changeInfo.status !== 'complete' ) {
        return;
    }

    updateContextMenu();
}

chrome.tabs.onUpdated.addListener(onUpdatedTabsHandler);

/******************************************************************************/

function onRemovedTabHandler(tabId) {
    // Can this happen?
    if ( tabId < 0 ) {
        return;
    }

    unbindTabFromPageStats(tabId);
}

chrome.tabs.onRemoved.addListener(onRemovedTabHandler);

/******************************************************************************/

chrome.tabs.onActivated.addListener(updateContextMenu)

/******************************************************************************/

// Bind a top URL to a specific tab

function onBeforeNavigateCallback(details) {
    if ( details.url.search(/^https?:\/\//) < 0 ) {
        return;
    }
    if ( HTTPSB.excludeRegex.test(details.url) ) {
        return;
    }
    // Don't bind to a subframe
    if ( details.frameId > 0 ) {
        return;
    }

    // console.debug('onBeforeNavigateCallback() > binding "%s" to tab %d', details.url, details.tabId);

    bindTabToPageStats(details.tabId, uriTools.normalizeURI(details.url));
}

chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigateCallback);

/******************************************************************************/

// Load user settings

load();

/******************************************************************************/

// rhill 2013-11-24: bind behind-the-scene virtual tab/url manually, since the
// normal way forbid binding behind the scene tab.
// https://github.com/gorhill/httpswitchboard/issues/67

(function(tabId, pageUrl) {
    var pageStats = createPageStats(pageUrl);
    HTTPSB.pageUrlToTabId[pageUrl] = tabId;
    HTTPSB.tabIdToPageUrl[tabId] = pageUrl;
})(HTTPSB.behindTheSceneTabId, HTTPSB.behindTheSceneURL);

/******************************************************************************/

// Initialize internal state with maybe already existing tabs

(function(){
    chrome.tabs.query({ url: '<all_urls>' }, function(tabs) {
        var i = tabs.length;
        // console.debug('HTTP Switchboard > preparing to bind %d tabs', i);
        var tab;
        while ( i-- ) {
            tab = tabs[i];
            bindTabToPageStats(tab.id, uriTools.normalizeURI(tab.url));
        }
        // Tabs are now bound to url stats stores, therefore it is now safe
        // to handle net traffic.
        chrome.runtime.sendMessage({
            'what': 'startWebRequestHandler',
            'from': 'tabsBound'
            });
    });
})();

/******************************************************************************/

// Listeners to let popup let us know when pages must be reloaded.

function onConnectHandler(port) {
    HTTPSB.port = port;
    port.onDisconnect.addListener(onDisconnectHandler);
}

function onDisconnectHandler() {
    HTTPSB.port = null;
    smartReloadTabs();
}

chrome.extension.onConnect.addListener(onConnectHandler);

