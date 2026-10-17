/**
 * ActionsLog.gs . Same file in DE Prime Check, SFP DE Weekly and Company 3PL Scorecard.
 * Writes the current open findings of this project to the tab "Open actions" in the Company 3PL Scorecard Sheet,
 * so Looker can show them. Needs the Actions engine (act_collect_, act_sent_, act_state_) and Config.gs in the same project.
 * Read only on the engine: it does not draft or send anything. Each project replaces only its own rows.
 *
 * Safety: dates are dd.MM.yyyy HH:mm; the sheet ID and addresses come from Config.gs;
 * the write is guarded by a script lock and by an advisory lease in the hidden tab "Open actions lock"
 * (three projects write the same tab); the header must match before anything is written;
 * rows are overwritten in place, the tab is never cleared first.
 */
var ALOG = {
  TAB: 'Open actions',
  LOCK_TAB: 'Open actions lock',
  LEASE_MS: 60000,
  LEASE_WAIT_MS: 25000,
  HEAD: ['Updated', 'Project', 'Scope', 'Severity', 'Owner', 'Title', 'Evidence', 'Next step', 'Suggestion', 'Partner', 'Status', 'Last draft', 'Draft link']
};

function alog_sheetId_() { return cfg_('LOG_SHEET_ID'); }

function logOpenActions() {
  var run = function () { alog_write_(); };
  if (typeof act_withLock_ === 'function') act_withLock_('logOpenActions', run); else run();
}

function alog_status_(f, sent, nowMs) {
  var s = act_state_(f, sent, nowMs);
  return { internal: 'Internal', needs: 'Needs draft', waiting: 'Waiting for partner', followup: 'Follow-up due' }[s.key] || 'Internal';
}

function alog_write_() {
  var project = (typeof ACTION_SETUP !== 'undefined' && ACTION_SETUP.name) ? String(ACTION_SETUP.name) : 'Unknown';
  var nowMs = Date.now();
  var now = Utilities.formatDate(new Date(nowMs), ACT.TZ, 'dd.MM.yyyy HH:mm');
  var sent = act_sent_();
  var mine = [];
  act_collect_().forEach(function (f) {
    if (f.severity === 'ok') return;
    var g = f.mail ? f.mail.group : '';
    var cfg = g ? (ACTION_SETUP.groups[g] || {}) : {};
    var last = g ? sent['last|' + g] : 0;
    var link = g ? alog_composeUrl_(cfg, g, f) : '';
    mine.push([
      now, project, f.scope || '', f.severity === 'red' ? 'Act' : 'Watch', f.owner || '', f.title || '',
      (f.evidence || []).join(' | '), f.action || '', f.suggestion || '',
      g ? (cfg.label || g) : '', alog_status_(f, sent, nowMs),
      last ? Utilities.formatDate(new Date(last), ACT.TZ, 'dd.MM.yyyy HH:mm') : '',
      link
    ]);
  });

  var ss = SpreadsheetApp.openById(alog_sheetId_());
  var release = alog_lease_(ss, project);
  try {
    var sh = ss.getSheetByName(ALOG.TAB) || ss.insertSheet(ALOG.TAB);
    var w = ALOG.HEAD.length;
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, w).setValues([ALOG.HEAD]).setFontWeight('bold');
    } else {
      var head = sh.getRange(1, 1, 1, w).getValues()[0].map(String);
      if (head.join('|') !== ALOG.HEAD.join('|')) {
        throw new Error('Open actions: header row has changed, nothing written. Expected: ' + ALOG.HEAD.join(', '));
      }
    }
    var lastRow = sh.getLastRow();
    var old = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, w).getValues() : [];
    var keep = old.filter(function (r) { return String(r[1]) !== project && String(r[1]) !== ''; })
      .map(function (r) { r[0] = act_dmyText_(r[0]); r[11] = act_dmyText_(r[11]); return r; });
    var all = keep.concat(mine);
    if (all.length) sh.getRange(2, 1, all.length, w).setNumberFormat('@').setValues(all);
    // rows left over from a longer previous list: blank them in place
    var extra = lastRow - 1 - all.length;
    if (extra > 0) sh.getRange(2 + all.length, 1, extra, w).clearContent();
    sh.setFrozenRows(1);
  } finally {
    release();
  }
  act_log_('Open actions logged: ' + mine.length + ' for ' + project);
}

/**
 * Advisory lease across projects. A script lock only protects one project, but three projects write this tab.
 * Cell A1 = holder, B1 = expiry (ms). Waits up to LEASE_WAIT_MS, then proceeds with a log line rather than
 * dropping the update. Returns a release function.
 */
function alog_lease_(ss, project) {
  var sh = ss.getSheetByName(ALOG.LOCK_TAB);
  if (!sh) { sh = ss.insertSheet(ALOG.LOCK_TAB); try { sh.hideSheet(); } catch (e) {} }
  var token = project + '#' + Date.now() + '#' + Math.floor(Math.random() * 1e6);
  var deadline = Date.now() + ALOG.LEASE_WAIT_MS;
  var got = false;
  while (Date.now() < deadline) {
    var v = sh.getRange(1, 1, 1, 2).getValues()[0];
    var holder = String(v[0] || ''), exp = Number(v[1]) || 0;
    if (!holder || exp < Date.now()) {
      sh.getRange(1, 1, 1, 2).setValues([[token, Date.now() + ALOG.LEASE_MS]]);
      SpreadsheetApp.flush();
      Utilities.sleep(400);
      if (String(sh.getRange(1, 1).getValue()) === token) { got = true; break; }
    }
    Utilities.sleep(1500);
  }
  if (!got) act_log_('Open actions: lease not obtained for ' + project + ', writing anyway');
  return function () {
    try {
      if (got && String(sh.getRange(1, 1).getValue()) === token) sh.getRange(1, 1, 1, 2).clearContent();
    } catch (e) {}
  };
}

/**
 * Gmail compose link for one finding: opens a ready-to-edit email in the work account,
 * To empty, CC ops lead, text from the same group wording as the dashboard draft. Nothing is sent.
 * The order list attachment is only in the dashboard's "Draft email" button.
 */
function alog_composeUrl_(cfg, g, f) {
  var today = Utilities.formatDate(new Date(), ACT.TZ, 'dd.MM.yyyy');
  var subject = (cfg.subject || g + ': open points') + ' (' + today + ')';
  var section = String((f.mail && f.mail.section) || f.title || '').trim();
  var head = [cfg.greeting || 'Hi,', '', cfg.intro || 'A few points from this week\'s numbers that need your input.', ''].join('\n');
  var tail = '\n\n' + (cfg.ask || 'Could you come back to me on these by the end of the week?') + '\n\nThanks,\nOwner';
  var base = 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(cfg_('OWNER')) + '&view=cm&fs=1&cc=' +
    encodeURIComponent(cfgCc_()) + '&su=' + encodeURIComponent(subject) + '&body=';
  var room = 7000 - base.length - encodeURIComponent(head + tail).length;
  while (encodeURIComponent(section).length > room && section.length > 40) section = section.slice(0, Math.floor(section.length * 0.85)).replace(/\s+\S*$/, '') + ' ...';
  return base + encodeURIComponent(head + section + tail);
}

/** Run once from the editor: weekdays about 14:30 local time, after runDailyActions (14:05). */
function installLogTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'logOpenActions') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('logOpenActions').timeBased().everyDays(1).atHour(14).nearMinute(30).inTimezone(ACT.TZ).create();
}
