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

// TODO: cleanup

/******************************************************************************/

(function() {

/******************************************************************************/

// Don't hold permanently onto background page. I don't know if this help,
// but I am trying to keep memory footprint as low as possible.
// TODO: re-evaluate whether this is needed as caching the references
// would help performance.

function getBackgroundPage() {
    return chrome.extension.getBackgroundPage();
}

function getHTTPSB() {
    return getBackgroundPage().HTTPSB;
}

function getPageStats() {
    return getBackgroundPage().pageStatsFromTabId(HTTPSBPopup.tabId);
}

/******************************************************************************/

function getUserSetting(setting) {
    return getHTTPSB().userSettings[setting];
}

function setUserSetting(setting, value) {
    chrome.runtime.sendMessage({
        what: 'userSettings',
        name: setting,
        value: value
    });
}

/******************************************************************************/

function EntryStats(hostname, type) {
    this.hostname = hostname;
    this.type = type;
    this.count = 0;
    this.temporaryColor = '';
    this.permanentColor = '';
}

EntryStats.prototype.reset = function(hostname, type) {
    if ( hostname ) {
        this.hostname = hostname;
    }
    if ( type ) {
        this.type = type;
    }
    this.count = 0;
};

EntryStats.prototype.colourize = function(httpsb, scopeURL) {
    httpsb = httpsb || getHTTPSB();
    if ( !this.hostname || !this.type ) {
        return;
    }
    this.temporaryColor = httpsb.getTemporaryColor(scopeURL, this.type, this.hostname);
    this.permanentColor = httpsb.getPermanentColor(scopeURL, this.type, this.hostname);
};

EntryStats.prototype.add = function(other) {
    this.count += other.count;
};

/******************************************************************************/

function HostnameStats(hostname) {
    this.hostname = hostname;
    this.types = {
        '*': new EntryStats(hostname, '*'),
        main_frame: new EntryStats(hostname, 'main_frame'),
        stylesheet: new EntryStats(hostname, 'stylesheet'),
        cookie: new EntryStats(hostname, 'cookie'),
        image: new EntryStats(hostname, 'image'),
        object: new EntryStats(hostname, 'object'),
        script: new EntryStats(hostname, 'script'),
        xmlhttprequest: new EntryStats(hostname, 'xmlhttprequest'),
        sub_frame: new EntryStats(hostname, 'sub_frame'),
        other: new EntryStats(hostname, 'other')
    };
    this.hasRule = undefined;
}

HostnameStats.prototype.junkyard = [];

HostnameStats.prototype.factory = function(hostname) {
    var domainStats = HostnameStats.prototype.junkyard.pop();
    if ( domainStats ) {
        domainStats.reset(hostname);
    } else {
        domainStats = new HostnameStats(hostname);
    }
    return domainStats;
};

HostnameStats.prototype.reset = function(hostname) {
    if ( hostname ) {
        this.hostname = hostname;
    } else {
        hostname = this.hostname;
    }
    this.types['*'].reset(hostname);
    this.types.main_frame.reset(hostname);
    this.types.stylesheet.reset(hostname);
    this.types.cookie.reset(hostname);
    this.types.image.reset(hostname);
    this.types.object.reset(hostname);
    this.types.script.reset(hostname);
    this.types.xmlhttprequest.reset(hostname);
    this.types.sub_frame.reset(hostname);
    this.types.other.reset(hostname);
    this.hasRule = undefined;
};

HostnameStats.prototype.dispose = function() {
    HostnameStats.prototype.junkyard.push(this);
};

HostnameStats.prototype.colourize = function(httpsb, scopeURL) {
    httpsb = httpsb || getHTTPSB();
    this.types['*'].colourize(httpsb, scopeURL);
    this.types.main_frame.colourize(httpsb, scopeURL);
    this.types.cookie.colourize(httpsb, scopeURL);
    this.types.image.colourize(httpsb, scopeURL);
    this.types.object.colourize(httpsb, scopeURL);
    this.types.script.colourize(httpsb, scopeURL);
    this.types.xmlhttprequest.colourize(httpsb, scopeURL);
    this.types.sub_frame.colourize(httpsb, scopeURL);
    this.types.other.colourize(httpsb, scopeURL);
};

HostnameStats.prototype.add = function(other) {
    var thisTypes = this.types;
    var otherTypes = other.types;
    thisTypes['*'].add(otherTypes['*']);
    thisTypes.main_frame.add(otherTypes.main_frame);
    thisTypes.stylesheet.add(otherTypes.stylesheet);
    thisTypes.cookie.add(otherTypes.cookie);
    thisTypes.image.add(otherTypes.image);
    thisTypes.object.add(otherTypes.object);
    thisTypes.script.add(otherTypes.script);
    thisTypes.xmlhttprequest.add(otherTypes.xmlhttprequest);
    thisTypes.sub_frame.add(otherTypes.sub_frame);
    thisTypes.other.add(otherTypes.other);
};

/******************************************************************************/

function MatrixStats() {
    // hostname '*' always present
    this['*'] = HostnameStats.prototype.factory('*');
}

MatrixStats.prototype.createMatrixStats = function() {
    return new MatrixStats();
};

MatrixStats.prototype.reset = function() {
    var hostnames = Object.keys(this);
    var i = hostnames.length;
    var hostname, prop;
    while ( i-- ) {
        hostname = hostnames[i];
        prop = this[hostname];
        if ( hostname !== '*' && prop instanceof HostnameStats ) {
            prop.dispose();
            delete this[hostname];
        }
    }
    this['*'].reset();
};

/******************************************************************************/

var HTTPSBPopup = {
    tabId: -1,
    pageURL: '',
    scopeURL: '*',

    
    matrixDomains: {},

    matrixStats: MatrixStats.prototype.createMatrixStats(),
    matrixHeaderTypes: ['*'],
    matrixCellMenu: null,
    matrixCellHotspots: null,
    matrixRowTemplate: null,
    matrixHasRows: false,
    matrixGroup3Collapsed: false,
    matrixList: null,

    groupsSnapshot: [],
    domainListSnapshot: 'do not leave this initial string empty',

    matrixHeaderPrettyNames: {
        'all': '',
        'cookie': '',
        'image': '',
        'object': '',
        'script': '',
        'xmlhttprequest': '',
        'sub_frame': '',
        'other': ''
    },

    // Just so the background page will be notified when popup menu is closed
    port: chrome.runtime.connect(),

    dummy: 0
};

/******************************************************************************/
/*
function getSelectorFromElement(node) {
    var path = [];
    var tag, classes, parent, index;
    while ( node ) {
        if ( node.nodeType !== 1 ) {
            break;
        }
        tag = node.localName;
        if ( node.id ) {
            path.unshift('#' + node.id);
            break;
        }
        if ( node.className ) {
            tag += '.' + node.className.split(/\s+/).sort().join('.');
        }
        parent = node.parentElement;
        path.unshift(tag);
        node = parent;
    }
    return path.join(' > ');
}
*/

/******************************************************************************/

// This creates a stats entry for each possible rows in the matrix.

function initMatrixStats() {
    var pageStats = getPageStats();
    if ( !pageStats ) {
        return;
    }

    var matrixStats = HTTPSBPopup.matrixStats;
    matrixStats.reset();

    // collect all hostnames and ancestors from net traffic
    var background = getBackgroundPage();
    var uriTools = background.uriTools;
    var pageUrl = pageStats.pageUrl;
    var hostname, reqType, nodes, node, reqKey;
    var reqKeys = pageStats.requests.getRequestKeys();
    var iReqKeys = reqKeys.length;

    HTTPSBPopup.matrixHasRows = iReqKeys > 0;

    while ( iReqKeys-- ) {
        reqKey = reqKeys[iReqKeys];
        hostname = pageStats.requests.hostnameFromRequestKey(reqKey);

        // rhill 2013-10-23: hostname can be empty if the request is a data url
        // https://github.com/gorhill/httpswitchboard/issues/26
        if ( hostname === '' ) {
            hostname = uriTools.hostnameFromURI(pageUrl);
        }
        reqType = pageStats.requests.typeFromRequestKey(reqKey);

        // we want a row for self and ancestors
        nodes = uriTools.allHostnamesFromHostname(hostname);

        while ( true ) {
            node = nodes.shift();
            if ( !node ) {
                break;
            }
            if ( !matrixStats[node] ) {
                matrixStats[node] = HostnameStats.prototype.factory(node);
            }
        }
        matrixStats[hostname].types[reqType].count += 1;
        // https://github.com/gorhill/httpswitchboard/issues/12
        // Count requests for whole row.

        matrixStats[hostname].types['*'].count += 1;
        // meta row for domain, only:
        // - there are subdomains
        // - no subdomain has an explicit rule
    }

    updateMatrixStats();

    return matrixStats;
}

/******************************************************************************/

function updateMatrixStats() {
    // For each hostname/type occurrence, evaluate colors
    var httpsb = getHTTPSB();
    var scopeURL = HTTPSBPopup.scopeURL;
    var matrixStats = HTTPSBPopup.matrixStats;
    var hostnames = Object.keys(matrixStats);
    var i = hostnames.length;
    while ( i-- ) {
        matrixStats[hostnames[i]].colourize(httpsb, scopeURL);
    }
}

/******************************************************************************/

// For display purpose, create four distinct groups of rows:
// 1st: page domain's related
// 2nd: whitelisted
// 3rd: graylisted
// 4th: blacklisted

function getGroupStats() {

    // Try to not reshuffle groups around while popup is opened if
    // no new hostname added.
    var matrixStats = HTTPSBPopup.matrixStats;
    var latestDomainListSnapshot = Object.keys(matrixStats).sort().join();
    if ( latestDomainListSnapshot === HTTPSBPopup.domainListSnapshot ) {
        return HTTPSBPopup.groupsSnapshot;
    }
    HTTPSBPopup.domainListSnapshot = latestDomainListSnapshot;

    var groups = [
        {},
        {},
        {},
        {}
    ];

    // First, group according to whether at least one node in the domain
    // hierarchy is white or blacklisted
    var background = getBackgroundPage();
    var pageDomain = background.uriTools.domainFromURI(HTTPSBPopup.pageURL);
    var hostname, domain, nodes, node;
    var temporaryColor;
    var dark, group;
    var hostnames = Object.keys(matrixStats);
    var iHostname = hostnames.length;
    while ( iHostname-- ) {
        hostname = hostnames[iHostname];
        // '*' is for header, ignore, since header is always at the top
        if ( hostname === '*' ) {
            continue;
        }
        // https://github.com/gorhill/httpswitchboard/issues/12
        // Ignore rows with no request for now.
        if ( matrixStats[hostname].types['*'].count === 0 ) {
            continue;
        }
        // Walk upward the chain of hostname and find at least one which
        // is expressly whitelisted or blacklisted.
        nodes = background.uriTools.allHostnamesFromHostname(hostname);
        domain = nodes[nodes.length-1];

        while ( true ) {
            node = nodes.shift();
            if ( !node ) {
                break;
            }
            temporaryColor = matrixStats[node].types['*'].temporaryColor;
            dark = temporaryColor.charAt(1) === 'd';
            if ( dark ) {
                break;
            }
        }
        // Domain of the page comes first
        if ( domain === pageDomain ) {
            group = 0;
        }
        // Whitelisted hostnames are second, blacklisted are fourth
        else if ( dark ) {
            group = temporaryColor.charAt(0) === 'g' ? 1 : 3;
        // Graylisted are third
        } else {
            group = 2;
        }
        if ( !groups[group][domain] ) {
            groups[group][domain] = { all: {}, withRules: {} };
        }
        groups[group][domain].withRules[hostname] = true;
    }
    // At this point, one domain could end up in two different groups.

    // Generate all nodes possible for each groups, this is useful
    // to allow users to toggle permissions for higher-level hostnames
    // which are not explicitly part of the web page.
    var iGroup = groups.length;
    var domains, iDomain;
    var nodes;
    while ( iGroup-- ) {
        group = groups[iGroup];
        domains = Object.keys(group);
        iDomain = domains.length;
        while ( iDomain-- ) {
            domain = domains[iDomain];
            hostnames = Object.keys(group[domain].withRules);
            iHostname = hostnames.length;
            while ( iHostname-- ) {
                nodes = background.uriTools.allHostnamesFromHostname(hostnames[iHostname]);
                while ( true ) {
                    node = nodes.shift();
                    if ( !node ) {
                        break;
                    }
                    group[domain].all[node] = group[domain].withRules[node];
                }
            }
        }
    }

    HTTPSBPopup.groupsSnapshot = groups;

    return groups;
}

/******************************************************************************/

// helpers

function getCellStats(hostname, type) {
    var matrixStats = HTTPSBPopup.matrixStats;
    if ( matrixStats[hostname] ) {
        return matrixStats[hostname].types[type];
    }
    return null;
}

function getTemporaryColor(hostname, type) {
    var entry = getCellStats(hostname, type);
    if ( entry ) {
        return entry.temporaryColor;
    }
    return '';
}

function getPermanentColor(hostname, type) {
    var entry = getCellStats(hostname, type);
    if ( entry ) {
        return entry.permanentColor;
    }
    return '';
}

function getCellClass(hostname, type) {
    var temporaryColor = getTemporaryColor(hostname, type);
    var permanentColor = getPermanentColor(hostname, type);
    if ( permanentColor === 'xxx' ) {
        return temporaryColor;
    }
    return temporaryColor + ' ' + permanentColor;
}

// compute next state
function getNextAction(hostname, type, leaning) {
    var entry = HTTPSBPopup.matrixStats[hostname].types[type];
    var temporaryColor = entry.temporaryColor;
    // special case: root toggle only between two states
    if ( type === '*' && hostname === '*' ) {
        return temporaryColor.charAt(0) === 'g' ? 'blacklist' : 'whitelist';
    }
    // Lean toward whitelisting?
    if ( leaning === 'whitelisting' ) {
        if ( temporaryColor.charAt(1) === 'p' ) {
            return 'whitelist';
        }
        return 'graylist';
    }
    // Lean toward blacklisting
    if ( temporaryColor.charAt(1) === 'p' ) {
        return 'blacklist';
    }
    return 'graylist';
}

/******************************************************************************/

// This is required for when we update the matrix while it is open:
// the user might have collapsed/expanded one or more domains, and we don't
// want to lose all his hardwork.

function getCollapseState(domain) {
    var states = getUserSetting('popupCollapseSpecificDomains');
    if ( states !== undefined && states[domain] !== undefined ) {
        return states[domain];
    }
    return getUserSetting('popupCollapseDomains');
}

function toggleCollapseState(element) {
    element = $(element);
    if ( element.parents('#matHead.collapsible').length > 0 ) {
        toggleMainCollapseState(element);
    } else {
        toggleSpecificCollapseState(element);
    }
}

function toggleMainCollapseState(element) {
    var matHead = element.parents('#matHead.collapsible')
        .toggleClass('collapsed');
    var collapsed = matHead.hasClass('collapsed');
    $('#matList .matSection.collapsible').toggleClass('collapsed', collapsed);
    setUserSetting('popupCollapseDomains', collapsed);

    var specificCollapseStates = getUserSetting('popupCollapseSpecificDomains') || {};
    var domains = Object.keys(specificCollapseStates);
    var i = domains.length;
    var domain;
    while ( i-- ) {
        domain = domains[i];
        if ( specificCollapseStates[domain] === collapsed ) {
            delete specificCollapseStates[domain];
        }
    }
    setUserSetting('popupCollapseSpecificDomains', specificCollapseStates);
}

function toggleSpecificCollapseState(element) {
    // Remember collapse state forever, but only if it is different
    // from main collapse switch.
    var section = element.parents('.matSection.collapsible')
        .toggleClass('collapsed');
    var domain = section.prop('domain');
    var collapsed = section.hasClass('collapsed');
    var mainCollapseState = getUserSetting('popupCollapseDomains');
    var specificCollapseStates = getUserSetting('popupCollapseSpecificDomains') || {};
    if ( collapsed !== mainCollapseState ) {
        specificCollapseStates[domain] = collapsed;
        setUserSetting('popupCollapseSpecificDomains', specificCollapseStates);
    } else if ( specificCollapseStates[domain] !== undefined ) {
        delete specificCollapseStates[domain];
        setUserSetting('popupCollapseSpecificDomains', specificCollapseStates);
    }
}

/******************************************************************************/

// Update color of matrix cells(s)
// Color changes when rules change

function updateMatrixColors() {
    var cells = $('.matrix .matRow.rw > .matCell');
    var i = cells.length;
    var cell;
    while ( i-- ) {
        cell = $(cells[i]);
        cell.removeClass()
            .addClass('matCell ' + getCellClass(cell.prop('hostname'), cell.prop('reqType')));
    }
}

/******************************************************************************/

// Update request count of matrix cells(s)
// Count changes when number of distinct requests changes

function updateMatrixCounts() {
}

/******************************************************************************/

// Update behavior of matrix:
// - Whether a section is collapsible or not. It is collapsible if:
//   - It has at least one subdomain AND
//   - There is no explicit rule anywhere in the subdomain cells AND
//   - It is not part of group 3 (blacklisted hostnames)

function updateMatrixBehavior() {
    var sections = $('.matSection', HTTPSBPopup.matrixList);
    var i = sections.length;
    var section, subdomainRows, j, subdomainRow;
    while ( i-- ) {
        section = $(sections[i]);
        subdomainRows = section.children('.l2:not(.g3)');
        j = subdomainRows.length;
        while ( j-- ) {
            subdomainRow = $(subdomainRows[j]);
            subdomainRow.toggleClass('collapsible', subdomainRow.children('.gdt,.rdt').length === 0);
        }
        section.toggleClass('collapsible', subdomainRows.filter('.collapsible').length > 0);
    }
}

/******************************************************************************/

// handle user interaction with filters

function handleFilter(button, leaning) {
    var httpsb = getHTTPSB();
    // our parent cell knows who we are
    var cell = button.closest('div.matCell');
    var type = cell.prop('reqType');
    var hostname = cell.prop('hostname');
    var nextAction = getNextAction(hostname, type, leaning);
    if ( nextAction === 'blacklist' ) {
        httpsb.blacklistTemporarily(HTTPSBPopup.scopeURL, type, hostname);
    } else if ( nextAction === 'whitelist' ) {
        httpsb.whitelistTemporarily(HTTPSBPopup.scopeURL, type, hostname);
    } else {
        httpsb.graylistTemporarily(HTTPSBPopup.scopeURL, type, hostname);
    }
    updateMatrixStats();
    updateMatrixColors();
    updateMatrixBehavior();
    handleFilterMessage(button, leaning);
}

function handleWhitelistFilter(button) {
    handleFilter(button, 'whitelisting');
}

function handleBlacklistFilter(button) {
    handleFilter(button, 'blacklisting');
}

/******************************************************************************/

// handle user interaction with persistence buttons

function handlePersistence(button) {
    var httpsb = getHTTPSB();
    // our parent cell knows who we are
    var cell = button.closest('div.matCell');
    var type = cell.prop('reqType');
    var hostname = cell.prop('hostname');
    var entry = getCellStats(hostname, type);
    if ( !entry ) { return; }
    if ( entry.temporaryColor.charAt(1) === 'd' && entry.temporaryColor !== entry.permanentColor ) {
        if ( entry.temporaryColor === 'rdt' ) {
            httpsb.blacklistPermanently(HTTPSBPopup.scopeURL, type, hostname);
        } else if ( entry.temporaryColor === 'gdt' ) {
            httpsb.whitelistPermanently(HTTPSBPopup.scopeURL, type, hostname);
        }
        entry.permanentColor = httpsb.getPermanentColor(HTTPSBPopup.scopeURL, type, hostname);
        var newClass = getCellClass(hostname, type);
        cell.removeClass('rdt gdt rpt gpt rdp gdp rpp gpp');
        cell.addClass(newClass);
    }
}

function handleUnpersistence(button) {
    var httpsb = getHTTPSB();
    // our parent cell knows who we are
    var cell = button.closest('div.matCell');
    var type = cell.prop('reqType');
    var hostname = cell.prop('hostname');
    var entry = getCellStats(hostname, type);
    if ( !entry ) { return; }
    if ( entry.permanentColor.charAt(1) === 'd' ) {
        httpsb.graylistPermanently(HTTPSBPopup.scopeURL, type, hostname);
        entry.permanentColor = httpsb.getPermanentColor(HTTPSBPopup.scopeURL, type, hostname);
        var newClass = getCellClass(hostname, type);
        cell.removeClass('rdt gdt rpt gpt rdp gdp rpp gpp');
        cell.addClass(newClass);
    }
}

/******************************************************************************/

// build menu according to white and black lists
// TODO: update incrementally

function formatHeader(s) {
    var maxLength = 80;
    var msg = '&nbsp;';
    if ( !s || !s.length ) {
        msg = '&nbsp;';
    } else {
        msg = s.slice(0, maxLength);
        if ( s.length > maxLength ) {
            msg += '...';
        }
    }
    return msg;
}

/******************************************************************************/

function renderMatrixHeaderRow() {
    var matHead = $('#matHead.collapsible');
    matHead.toggleClass('collapsed', getUserSetting('popupCollapseDomains'));
    var cells = matHead.find('.matCell');
    $(cells[0]).prop({reqType: '*', hostname: '*'}).addClass(getCellClass('*', '*'));
    $(cells[1]).prop({reqType: 'cookie', hostname: '*'}).addClass(getCellClass('*', 'cookie'));
    $(cells[2]).prop({reqType: 'image', hostname: '*'}).addClass(getCellClass('*', 'image'));
    $(cells[3]).prop({reqType: 'object', hostname: '*'}).addClass(getCellClass('*', 'object'));
    $(cells[4]).prop({reqType: 'script', hostname: '*'}).addClass(getCellClass('*', 'script'));
    $(cells[5]).prop({reqType: 'xmlhttprequest', hostname: '*'}).addClass(getCellClass('*', 'xmlhttprequest'));
    $(cells[6]).prop({reqType: 'sub_frame', hostname: '*'}).addClass(getCellClass('*', 'sub_frame'));
    $(cells[7]).prop({reqType: 'other', hostname: '*'}).addClass(getCellClass('*', 'other'));
    $('#matHead .matRow').css('display', '');
}

/******************************************************************************/

function renderMatrixCellDomain(cell, domain) {
    $(cell).prop({reqType: '*', hostname: domain})
        .addClass(getCellClass(domain, '*'))
        .children('b')
        .text(punycode.toUnicode(domain));
}

function renderMatrixCellSubdomain(cell, domain, subomain) {
    $(cell).prop({reqType: '*', hostname: subomain})
        .addClass(getCellClass(subomain, '*'))
        .children('b')
        .text(punycode.toUnicode(subomain.slice(0, subomain.lastIndexOf(domain)-1)) + '.')
        .after(punycode.toUnicode(domain));
}

function renderMatrixMetaCellDomain(cell, domain) {
    $(cell).prop({reqType: '*', hostname: domain})
        .addClass(getCellClass(domain, '*'))
        .children('b')
        .text(punycode.toUnicode(domain))
        .before('\u2217.');
}

function renderMatrixCellType(cell, hostname, type, stats) {
    cell = $(cell);
    cell.prop({reqType: type, hostname: hostname, count: stats.count})
        .addClass(getCellClass(hostname, type));
    if ( stats.count ) {
        cell.text(stats.count);
    }
}

function renderMatrixCellTypes(cells, hostname, stats) {
    renderMatrixCellType(cells[1], hostname, 'cookie', stats.cookie);
    renderMatrixCellType(cells[2], hostname, 'image', stats.image);
    renderMatrixCellType(cells[3], hostname, 'object', stats.object);
    renderMatrixCellType(cells[4], hostname, 'script', stats.script);
    renderMatrixCellType(cells[5], hostname, 'xmlhttprequest', stats.xmlhttprequest);
    renderMatrixCellType(cells[6], hostname, 'sub_frame', stats.sub_frame);
    renderMatrixCellType(cells[7], hostname, 'other', stats.other);
}

/******************************************************************************/

function makeMatrixRowDomain(domain) {
    var matrixRow = HTTPSBPopup.matrixRowTemplate.clone().addClass('rw');
    var cells = $('.matCell', matrixRow);
    renderMatrixCellDomain(cells[0], domain);
    renderMatrixCellTypes(cells, domain, HTTPSBPopup.matrixStats[domain].types);
    return matrixRow;
}

function makeMatrixRowSubdomain(domain, subdomain) {
    var matrixRow = HTTPSBPopup.matrixRowTemplate.clone().addClass('rw');
    var cells = $('.matCell', matrixRow);
    renderMatrixCellSubdomain(cells[0], domain, subdomain);
    renderMatrixCellTypes(cells, subdomain, HTTPSBPopup.matrixStats[subdomain].types);
    return matrixRow;
}

function makeMatrixMetaRowDomain(domain, stats) {
    var matrixRow = HTTPSBPopup.matrixRowTemplate.clone().addClass('rw');
    var cells = $('.matCell', matrixRow);
    renderMatrixMetaCellDomain(cells[0], domain);
    renderMatrixCellTypes(cells, domain, stats);
    return matrixRow;
}

/******************************************************************************/

function renderMatrixMetaCellType(cell, count) {
    cell = $(cell);
    cell.addClass('rpt');
    if ( count ) {
        cell.text(count);
    }
}

function makeMatrixMetaRow(stats) {
    var typeStats = stats.types;
    var matrixRow = HTTPSBPopup.matrixRowTemplate.clone().addClass('ro');
    var cells = $('div', matrixRow);
    $(cells[0])
        .addClass('matCell rdt')
        .html('<i>' + typeStats['*'].count + ' blacklisted hostname(s)</i>');
    renderMatrixMetaCellType(cells[1], typeStats.cookie.count);
    renderMatrixMetaCellType(cells[2], typeStats.image.count);
    renderMatrixMetaCellType(cells[3], typeStats.object.count);
    renderMatrixMetaCellType(cells[4], typeStats.script.count);
    renderMatrixMetaCellType(cells[5], typeStats.xmlhttprequest.count);
    renderMatrixMetaCellType(cells[6], typeStats.sub_frame.count);
    renderMatrixMetaCellType(cells[7], typeStats.other.count);
    return matrixRow;
}

/******************************************************************************/

function computeMatrixGroupMetaStats(group) {
    var metaStats = new HostnameStats();
    var domains = Object.keys(group);
    var blacklistedCount = 0;
    var i = domains.length;
    var hostnames, hostname, j;
    while ( i-- ) {
        hostnames = Object.keys(group[domains[i]].all);
        j = hostnames.length;
        while ( j-- ) {
            hostname = hostnames[j];
            if ( getTemporaryColor(hostname, '*') === 'rdt' ) {
                blacklistedCount++;
            }
            metaStats.add(HTTPSBPopup.matrixStats[hostname]);
        }
    }
    metaStats.types['*'].count = blacklistedCount;
    return metaStats;
}

/******************************************************************************/

// Compare hostname helper, to order hostname in a logical manner:
// top-most < bottom-most, take into account whether IP address or
// named hostname

function hostnameCompare(a,b) {
    // Normalize: most significant parts first
    if ( !a.match(/^\d+(\.\d+){1,3}$/) ) {
        var aa = a.split('.');
        a = aa.slice(-2).concat(aa.slice(0,-2).reverse()).join('.');
    }
    if ( !b.match(/^\d+(\.\d+){1,3}$/) ) {
        var bb = b.split('.');
        b = bb.slice(-2).concat(bb.slice(0,-2).reverse()).join('.');
    }
    return a.localeCompare(b);
}

/******************************************************************************/

function makeMatrixGroup0SectionDomain(domain) {
    return makeMatrixRowDomain(domain)
        .addClass('g0 l1');
}

function makeMatrixGroup0SectionSubomain(domain, subdomain) {
    return makeMatrixRowSubdomain(domain, subdomain)
        .addClass('g0 l2');
}

function makeMatrixGroup0SectionMetaDomain(hostnames) {
    var metaStats = new HostnameStats();
    var i = hostnames.length;
    while ( i-- ) {
        metaStats.add(HTTPSBPopup.matrixStats[hostnames[i]]);
    }
    return makeMatrixMetaRowDomain(hostnames[0], metaStats.types)
        .addClass('g0 l1 meta');
}

function makeMatrixGroup0Section(hostnames) {
    var domain = hostnames[0];
    var domainDiv = $('<div>')
        .addClass('matSection')
        .toggleClass('collapsed', getCollapseState(domain))
        .prop('domain', domain);
    if ( hostnames.length > 1 ) {
        makeMatrixGroup0SectionMetaDomain(hostnames)
            .appendTo(domainDiv);
    }
    makeMatrixGroup0SectionDomain(domain)
        .appendTo(domainDiv);
    for ( var i = 1; i < hostnames.length; i++ ) {
        makeMatrixGroup0SectionSubomain(domain, hostnames[i])
            .appendTo(domainDiv);
    }
    return domainDiv;
}

function makeMatrixGroup0(group) {
    var domains = Object.keys(group).sort(hostnameCompare);
    if ( domains.length ) {
        var groupDiv = $('<div>')
            .addClass('matGroup g0');
        makeMatrixGroup0Section(Object.keys(group[domains[0]].all).sort(hostnameCompare))
            .appendTo(groupDiv);
        for ( var i = 1; i < domains.length; i++ ) {
            makeMatrixGroup0Section(Object.keys(group[domains[i]].all).sort(hostnameCompare))
                .appendTo(groupDiv);
        }
        groupDiv.appendTo(HTTPSBPopup.matrixList);
    }
}

/******************************************************************************/

function makeMatrixGroup1SectionDomain(domain) {
    return makeMatrixRowDomain(domain)
        .addClass('g1 l1');
}

function makeMatrixGroup1SectionSubomain(domain, subdomain) {
    return makeMatrixRowSubdomain(domain, subdomain)
        .addClass('g1 l2');
}

function makeMatrixGroup1SectionMetaDomain(hostnames) {
    var metaStats = new HostnameStats();
    var i = hostnames.length;
    while ( i-- ) {
        metaStats.add(HTTPSBPopup.matrixStats[hostnames[i]]);
    }
    return makeMatrixMetaRowDomain(hostnames[0], metaStats.types)
        .addClass('g1 l1 meta');
}

function makeMatrixGroup1Section(hostnames) {
    var domain = hostnames[0];
    var domainDiv = $('<div>')
        .addClass('matSection')
        .toggleClass('collapsed', getCollapseState(domain))
        .prop('domain', domain);
    if ( hostnames.length > 1 ) {
        makeMatrixGroup1SectionMetaDomain(hostnames)
            .appendTo(domainDiv);
    }
    makeMatrixGroup1SectionDomain(domain)
        .appendTo(domainDiv);
    for ( var i = 1; i < hostnames.length; i++ ) {
        makeMatrixGroup1SectionSubomain(domain, hostnames[i])
            .appendTo(domainDiv);
    }
    return domainDiv;
}

function makeMatrixGroup1(group) {
    var domains = Object.keys(group).sort(hostnameCompare);
    if ( domains.length) {
        var groupDiv = $('<div>')
            .addClass('matGroup g1');
        makeMatrixGroup1Section(Object.keys(group[domains[0]].all).sort(hostnameCompare))
            .appendTo(groupDiv);
        for ( var i = 1; i < domains.length; i++ ) {
            makeMatrixGroup1Section(Object.keys(group[domains[i]].all).sort(hostnameCompare))
                .appendTo(groupDiv);
        }
        groupDiv.appendTo(HTTPSBPopup.matrixList);
    }
}

/******************************************************************************/

function makeMatrixGroup2SectionDomain(domain) {
    return makeMatrixRowDomain(domain)
        .addClass('g2 l1');
}

function makeMatrixGroup2SectionSubomain(domain, subdomain) {
    return makeMatrixRowSubdomain(domain, subdomain)
        .addClass('g2 l2');
}

function makeMatrixGroup2SectionMetaDomain(hostnames) {
    var metaStats = new HostnameStats();
    var i = hostnames.length;
    while ( i-- ) {
        metaStats.add(HTTPSBPopup.matrixStats[hostnames[i]]);
    }
    return makeMatrixMetaRowDomain(hostnames[0], metaStats.types)
        .addClass('g2 l1 meta');
}

function makeMatrixGroup2Section(hostnames) {
    var domain = hostnames[0];
    var domainDiv = $('<div>')
        .addClass('matSection')
        .toggleClass('collapsed', getCollapseState(domain))
        .prop('domain', domain);
    if ( hostnames.length > 1 ) {
        makeMatrixGroup2SectionMetaDomain(hostnames)
            .appendTo(domainDiv);
    }
    makeMatrixGroup2SectionDomain(domain)
        .appendTo(domainDiv);
    for ( var i = 1; i < hostnames.length; i++ ) {
        makeMatrixGroup2SectionSubomain(domain, hostnames[i])
            .appendTo(domainDiv);
    }
    return domainDiv;
}

function makeMatrixGroup2(group) {
    var domains = Object.keys(group).sort(hostnameCompare);
    if ( domains.length) {
        var groupDiv = $('<div>')
            .addClass('matGroup g2');
        makeMatrixGroup2Section(Object.keys(group[domains[0]].all).sort(hostnameCompare))
            .appendTo(groupDiv);
        for ( var i = 1; i < domains.length; i++ ) {
            makeMatrixGroup2Section(Object.keys(group[domains[i]].all).sort(hostnameCompare))
                .appendTo(groupDiv);
        }
        groupDiv.appendTo(HTTPSBPopup.matrixList);
    }
}

/******************************************************************************/

function makeMatrixGroup3SectionDomain(domain) {
    return makeMatrixRowDomain(domain)
        .addClass('g3 l1');
}

function makeMatrixGroup3SectionSubomain(domain, subdomain) {
    return makeMatrixRowSubdomain(domain, subdomain)
        .addClass('g3 l2');
}

function makeMatrixGroup3Section(hostnames) {
    var domain = hostnames[0];
    var domainDiv = $('<div>')
        .addClass('matSection')
        .prop('domain', domain);
    makeMatrixGroup3SectionDomain(domain)
        .appendTo(domainDiv);
    for ( var i = 1; i < hostnames.length; i++ ) {
        makeMatrixGroup3SectionSubomain(domain, hostnames[i])
            .appendTo(domainDiv);
    }
    return domainDiv;
}

function makeMatrixGroup3(group) {
    var domains = Object.keys(group).sort(hostnameCompare);
    if ( domains.length ) {
        var groupDiv = $('<div>')
            .addClass('matGroup g3');
        $('<div>')
            .addClass('matSection g3Meta')
            .toggleClass('g3Collapsed', !!getUserSetting('popupHideBlacklisted'))
            .appendTo(groupDiv);
        makeMatrixMetaRow(computeMatrixGroupMetaStats(group), 'g3')
            .appendTo(groupDiv);
        makeMatrixGroup3Section(Object.keys(group[domains[0]].all).sort(hostnameCompare))
            .appendTo(groupDiv);
        for ( var i = 1; i < domains.length; i++ ) {
            makeMatrixGroup3Section(Object.keys(group[domains[i]].all).sort(hostnameCompare))
                .appendTo(groupDiv);
        }
        groupDiv.appendTo(HTTPSBPopup.matrixList);
    }
}

/******************************************************************************/

// TODO: build incrementally, i.e. reuse any existing rows rather than
// dispose then re-create all of them.

function makeMenu() {
    initMatrixStats();
    var groupStats = getGroupStats();

    showMessage(formatHeader(HTTPSBPopup.pageURL));

    if ( Object.keys(groupStats).length === 0 ) {
        return;
    }

    // https://github.com/gorhill/httpswitchboard/issues/31
    if ( HTTPSBPopup.matrixCellHotspots ) {
        HTTPSBPopup.matrixCellHotspots.detach();
    }
    if ( HTTPSBPopup.matrixCellMenu ) {
        HTTPSBPopup.matrixCellMenu.detach();
    }

    renderMatrixHeaderRow();

    HTTPSBPopup.matrixList.detach();
    // TODO: reuse elements
    HTTPSBPopup.matrixList.empty();
    makeMatrixGroup0(groupStats[0]);
    makeMatrixGroup1(groupStats[1]);
    makeMatrixGroup2(groupStats[2]);
    makeMatrixGroup3(groupStats[3]);

    updateMatrixBehavior();

    HTTPSBPopup.matrixList.appendTo($('.paneContent'));
}

/******************************************************************************/

// Do all the stuff that needs to be done before building menu et al.

function initMenuEnvironment() {
    HTTPSBPopup.matrixRowTemplate = $('#templates .matRow');
    HTTPSBPopup.matrixList = $('#matList');

    var prettyNames = HTTPSBPopup.matrixHeaderPrettyNames;
    var keys = Object.keys(prettyNames);
    var i = keys.length;
    var cell, key, text;
    while ( i-- ) {
        key = keys[i];
        cell = $('#matHead .matCell[data-filter-type="'+ key +'"]');
        text = chrome.i18n.getMessage(key + 'PrettyName');
        cell.text(text);
        prettyNames[key] = text;
    }
}

/******************************************************************************/

// Create page scopes for the web page

function toggleScopePage() {
    var toolbar = $('body');
    if ( toolbar.hasClass('scope-is-page') ) {
        toolbar.removeClass('scope-is-page');
        getHTTPSB().destroyPageScopeIfExists(HTTPSBPopup.pageURL);
    } else {
        toolbar.addClass('scope-is-page');
        getHTTPSB().createPageScopeIfNotExists(HTTPSBPopup.pageURL);
    }
    updateMatrixStats();
    updateMatrixColors();
    updateMatrixBehavior();
}

function getScopePageButtonTip() {
    var toolbar = $('body');
    if ( toolbar.hasClass('scope-is-page') ) {
        return chrome.i18n.getMessage('matrixRemoveScope', HTTPSBPopup.scopeURL);
    }
    return chrome.i18n.getMessage('matrixCreateScope', HTTPSBPopup.scopeURL);
}

/******************************************************************************/

// Handle user mouse over filter buttons

var mouseOverPrompts = {
    '+**': chrome.i18n.getMessage('matrixAllowAll'),
    '-**': chrome.i18n.getMessage('matrixBlockAll'),
    '+?*': chrome.i18n.getMessage('matrixAllowSomethingFromEverywhere'),
    '+*?': chrome.i18n.getMessage('matrixAllowEverythingFromSomewhere'),
    '+??': chrome.i18n.getMessage('matrixAllowSomethingFromSomewhere'),
    '-?*': chrome.i18n.getMessage('matrixBlockSomethingFromEverywhere'),
    '-*?': chrome.i18n.getMessage('matrixBlockEverythingFromSomewhere'),
    '-??': chrome.i18n.getMessage('matrixBlockSomethingFromSomewhere'),
    '.?*': chrome.i18n.getMessage('matrixGraylistSomethingFromEverywhere'),
    '.*?': chrome.i18n.getMessage('matrixGraylistEverythingFromSomewhere'),
    '.??': chrome.i18n.getMessage('matrixGraylistSomethingFromSomewhere')
};

function handleFilterMessage(hotspot, leaning) {
    var cell = hotspot.closest('div.matCell');
    var type = cell.prop('reqType');
    var hostname = cell.prop('hostname');
    if ( !type || !hostname ) {
        return;
    }
    var nextAction = getNextAction(hostname, type, leaning);
    var action = nextAction === 'whitelist' ? '+' : (nextAction === 'blacklist' ? '-' : '.');
    var what = type === '*' ? '*' : '?';
    var where = hostname === '*' ? '*' : '?';
    var prompt = mouseOverPrompts[action + what + where];
    prompt = prompt.replace('{{what}}', HTTPSBPopup.matrixHeaderPrettyNames[type]);
    prompt = prompt.replace('{{where}}', hostname);
    showMessage(prompt);
}

function handleWhitelistFilterMessage(hotspot) {
    handleFilterMessage(hotspot, 'whitelisting');
}

function handleBlacklistFilterMessage(hotspot) {
    handleFilterMessage(hotspot, 'blacklisting');
}

/******************************************************************************/

function handlePersistMessage(button) {
    if ( button.closest('.rdt:not(.rdp)').length ) {
        showMessage(chrome.i18n.getMessage('matrixPersistBlock'));
    } else if ( button.closest('.gdt:not(.gdp)').length ) {
        showMessage(chrome.i18n.getMessage('matrixPersistAllow'));
    } else {
        blankMessage();
    }
}

function handleUnpersistMessage(button) {
    if ( button.closest('.rdp').length ) {
        showMessage(chrome.i18n.getMessage('matrixUnpersistBlock'));
    } else if ( button.closest('.gdp').length ) {
        showMessage(chrome.i18n.getMessage('matrixUnpersistAllow'));
    } else {
        blankMessage();
    }
}

/******************************************************************************/

function showMessage(s) {
    $('#message').html(s);
}

function blankMessage() {
    $('#message').html(formatHeader(HTTPSBPopup.pageURL));
}

/******************************************************************************/

function revert() {
    getHTTPSB().revertPermissions();
    updateMatrixStats();
    updateMatrixColors();
    updateMatrixBehavior();
}

/******************************************************************************/

function onMessageHandler(request) {
    if ( request.what === 'urlStatsChanged' ) {
        if ( HTTPSBPopup.pageURL === request.pageURL ) {
            makeMenu();
        }
    }
}

/******************************************************************************/

// Because chrome.tabs.query() is async

function bindToTabHandler(tabs) {
    // TODO: can tabs be empty?
    if ( !tabs.length ) {
        return;
    }

    var background = getBackgroundPage();
    var httpsb = getHTTPSB();

    $('body').toggleClass('powerOff', httpsb.off);

    // Important! Before calling makeMenu()
    HTTPSBPopup.tabId = tabs[0].id;
    HTTPSBPopup.pageURL = background.pageUrlFromTabId(HTTPSBPopup.tabId);
    HTTPSBPopup.scopeURL = httpsb.normalizeScopeURL(HTTPSBPopup.pageURL);

    // Now that tabId and pageURL are set, we can build our menu
    initMenuEnvironment();
    makeMenu();

    // After popup menu is built, check whether there is a non-empty matrix
    if ( !HTTPSBPopup.matrixHasRows ) {
        $('#no-traffic').css('display', '');
        $('#matHead').css('display', 'none');
        $('#scopeToolbar').css('display', 'none');
    }

    // Activate page scope if there is one
    if ( httpsb.scopePageExists(HTTPSBPopup.scopeURL) ) {
        toggleScopePage();
    }

    // To know when to rebuild the matrix
    // TODO: What if this event is triggered before bindToTabHandler()
    // is called?
    if ( HTTPSBPopup.port ) {
        HTTPSBPopup.port.onMessage.addListener(onMessageHandler);
    }
}

/******************************************************************************/

function togglePower(force) {
    var httpsb = getHTTPSB();
    var off;
    if ( typeof force === 'boolean' ) {
        off = force;
    } else {
        off = !httpsb.off;
    }
    if ( off ) {
        httpsb.turnOff();
    } else {
        httpsb.turnOn();
    }
    $('body').toggleClass('powerOff', off);
    updateMatrixStats();
    updateMatrixColors();
}

/******************************************************************************/

// make menu only when popup html is fully loaded

function initAll() {
    chrome.tabs.query({currentWindow: true, active: true}, bindToTabHandler);

   // Below is UI stuff which is not key to make the menu, so this can
    // be done without having to wait for a tab to be bound to the menu.

    var popup = HTTPSBPopup;

    // Display size
    $('body').css('font-size', getUserSetting('displayTextSize'));

    // We reuse for all cells the one and only cell menu.
    popup.matrixCellMenu = $('#cellMenu').detach();
    $('#persist', popup.matrixCellMenu)
        .on('click', function() {
            handlePersistence($(this));
            return false;
        })
        .on('mouseenter', function() {
            handlePersistMessage($(this));
            return false;
        });
    $('#unpersist', popup.matrixCellMenu)
        .on('click', function() {
            handleUnpersistence($(this));
            return false;
        })
        .on('mouseenter', function() {
            handleUnpersistMessage($(this));
            return false;
        });

    // We reuse for all cells the one and only cell hotspots.
    popup.matrixCellHotspots = $('#cellHotspots').detach();
    $('#whitelist', popup.matrixCellHotspots)
        .on('click', function() {
            handleWhitelistFilter($(this));
            return false;
        })
        .on('mouseenter', function() {
            handleWhitelistFilterMessage($(this));
            return false;
        });
    $('#blacklist', popup.matrixCellHotspots)
        .on('click', function() {
            handleBlacklistFilter($(this));
            return false;
        })
        .on('mouseenter', function() {
                handleBlacklistFilterMessage($(this));
                return false;
        });
    $('#domainOnly', popup.matrixCellHotspots)
        .on('click', function() {
            toggleCollapseState(this);
            return false;
        });

    // to attach/detach widgets to matrix cell
    $('body')
        .on('mouseenter', '.matCell', function() {
            popup.matrixCellHotspots.prependTo(this);
            popup.matrixCellMenu.prependTo(this);
            })
        .on('mouseleave', '.matCell', function() {
            popup.matrixCellHotspots.detach();
            popup.matrixCellMenu.detach();
            blankMessage();
            });

    $('#buttonToggleScope')
        .on('mouseenter', function() { showMessage(getScopePageButtonTip()); })
        .on('mouseleave', blankMessage);
        
    $('#buttonRevert')
        .on('mouseenter', function() { showMessage(chrome.i18n.getMessage('matrixRevert')); })
        .on('mouseleave', blankMessage);

    $('#buttonToggleScope').on('click', toggleScopePage);
    $('#buttonRevert').on('click', revert);

    $('#buttonRuleManager').text(chrome.i18n.getMessage('ruleManagerPageName'));
    $('#buttonInfo').text(chrome.i18n.getMessage('statsPageName'));
    $('#buttonSettings').text(chrome.i18n.getMessage('settingsPageName'));
    $('#buttonPower').on('click', togglePower);

    $('#matList').on('click', '.g3Meta', function() {
        var separator = $(this);
        separator.toggleClass('g3Collapsed');
        chrome.runtime.sendMessage({
            what: 'userSettings',
            name: 'popupHideBlacklisted',
            value: separator.hasClass('g3Collapsed')
        });
    });
}

/******************************************************************************/

// Entry point

$(function(){
    initAll();
});

/******************************************************************************/

})();
