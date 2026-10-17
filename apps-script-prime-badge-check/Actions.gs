/**
 * Dashboard actions: shared engine.
 *
 * The same file goes into every dashboard project. Only Rules.gs differs:
 * it defines ACTION_SETUP = { name, url, groups, rules }.
 *
 * What it does
 *  - getActionsPanel(scope): action plan + suggestions as HTML for the page.
 *  - draftGroup(group): Gmail draft (configured partner To) to one partner, with an
 *    .xlsx of the rows that need their attention. Never sends.
 *  - runDailyActions(): weekday trigger. Drafts a partner email only when a
 *    red finding for that partner is new, or the last draft for the same
 *    finding is older than REDRAFT_DAYS.
 *
 * A rule is function(ctx) returning an array of findings:
 *  { id, scope, severity: 'red'|'amber'|'ok', owner, title,
 *    evidence: [text], action: text, suggestion: text,
 *    mail: { group, section: text, sheets: [{name, rows: [[header..],[..]]}] },
 *    fp: text }   // fingerprint of the data behind the finding
 */

var ACT = {
  REDRAFT_DAYS: 7,
  RUN_HOUR: 14,                 // local time; after the daily readings
  TZ: 'Europe/Berlin',
  SENT_KEY: 'ACT_SENT',
  LOG_KEY: 'ACT_LOG',
  LOCK_WAIT_MS: 30000,
  SHOW_TO_ALL: false            // false: only the owner sees the action plan and the draft buttons
  // Owner, CC, sheet IDs and partner addresses live in Config.gs / Script Properties (cfg_).
  // CC: only a verified sent message for this partner/topic enables follow-up CC.
};

// ------------------------------------------------------------------ dates

/** Every yyyy-mm-dd inside a text becomes dd.mm.yyyy. Other text is left alone. */
function act_dmyText_(s) {
  return String(s == null ? '' : s).replace(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, '$3.$2.$1');
}

/** [y, m, d, hh, mm] from "2026-10-09", "2026-10-09 14:05" or "09.10.2026 14:05"; null if neither. */
function act_parts_(s) {
  var t = String(s == null ? '' : s);
  var a = t.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (a) return [+a[1], +a[2], +a[3], +(a[4] || 0), +(a[5] || 0)];
  var b = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (b) return [+b[3], +b[2], +b[1], +(b[4] || 0), +(b[5] || 0)];
  return null;
}

/** Normalises the visible text of one finding to dd.mm.yyyy. ids and fingerprints stay as they are. */
function act_normaliseDates_(f) {
  ['title', 'action', 'suggestion'].forEach(function (k) { if (f[k]) f[k] = act_dmyText_(f[k]); });
  if (f.evidence) f.evidence = f.evidence.map(act_dmyText_);
  if (f.mail) {
    if (f.mail.section) f.mail.section = act_dmyText_(f.mail.section);
    (f.mail.sheets || []).forEach(function (s) {
      s.rows = s.rows.map(function (r) { return r.map(function (c) { return typeof c === 'string' ? act_dmyText_(c) : c; }); });
    });
  }
  return f;
}

// ------------------------------------------------------------------ locking

/** Runs fn while holding this project's script lock, so triggers and the Draft button cannot overlap. */
function act_withLock_(label, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ACT.LOCK_WAIT_MS)) throw new Error(label + ': another run is still working. Try again in a minute.');
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ------------------------------------------------------------------ collect

function act_collect_() {
  var ctx = { now: new Date(), cache: {} };
  var out = [];
  ACTION_SETUP.rules.forEach(function (rule) {
    try {
      (rule(ctx) || []).forEach(function (f) { if (f) out.push(act_normaliseDates_(f)); });
    } catch (e) {
      out.push({ id: 'err-' + (rule.name || 'rule'), scope: '*', severity: 'amber', owner: 'Internal',
        title: 'Check could not run: ' + (rule.name || 'rule'),
        evidence: [String(e && e.message || e)], action: 'Open the source Sheet and check that the tab and headers are unchanged.' });
    }
  });
  var rank = { red: 0, amber: 1, ok: 2 };
  out.sort(function (a, b) { return (rank[a.severity] - rank[b.severity]) || String(a.owner).localeCompare(String(b.owner)); });
  return out;
}

/**
 * Where a finding stands with its partner draft.
 *  internal : no partner email involved
 *  needs    : partner finding, no draft yet
 *  waiting  : draft recorded less than REDRAFT_DAYS ago; sending/replies are not tracked
 *  followup : draft record is REDRAFT_DAYS old; review the still-open finding
 * This panel uses draft history only. It does not assert contact or a partner reply.
 */
function act_state_(f, sent, nowMs) {
  if (!f.mail) return { key: 'internal' };
  var t = sent[f.mail.group + '|' + f.fp];
  if (!t) return { key: 'needs' };
  var due = t + ACT.REDRAFT_DAYS * 864e5;
  return { key: nowMs >= due ? 'followup' : 'waiting', t: t, due: due };
}

function act_dmy_(ms) { return Utilities.formatDate(new Date(ms), ACT.TZ, 'dd.MM.yyyy'); }

// ------------------------------------------------------------------ panel

function act_isOwner_() {
  try { return String(Session.getActiveUser().getEmail()).toLowerCase() === cfgOwner_(); } catch (e) { return false; }
}

function getActionsPanel(scope) {
  var owner = act_isOwner_();
  if (!owner && !ACT.SHOW_TO_ALL) return '';
  var all = act_collect_();
  var list = all.filter(function (f) { return !scope || f.scope === scope || f.scope === '*'; });
  var sent = act_sent_();
  var nowMs = Date.now();
  var st = new Map();
  list.forEach(function (f) { st.set(f, act_state_(f, sent, nowMs)); });
  var waiting = list.filter(function (f) { return f.severity !== 'ok' && st.get(f).key === 'waiting'; });
  var open = list.filter(function (f) { return f.severity !== 'ok' && st.get(f).key !== 'waiting'; });
  var groups = {};
  list.forEach(function (f) { if (f.mail && f.severity !== 'ok') (groups[f.mail.group] = groups[f.mail.group] || []).push(f); });

  var reds = open.filter(function (f) { return f.severity === 'red'; }).length;
  var ambers = open.filter(function (f) { return f.severity === 'amber'; }).length;
  var h = [];
  h.push('<style>' + ACT_CSS + '</style><section class="actp">');
  h.push('<div class="actp-head"><h2>Action plan</h2><span class="actp-sum">' +
    (reds ? '<b class="r">' + reds + ' need action</b>' : '<b class="g">Nothing red</b>') +
    (ambers ? ' · <b class="a">' + ambers + ' to watch</b>' : '') +
    (waiting.length ? ' · <b class="w">' + waiting.length + ' with a draft recorded</b>' : '') + ' · checked ' +
    Utilities.formatDate(new Date(), ACT.TZ, 'dd.MM.yyyy HH:mm') + '</span></div>');

  var keys = Object.keys(groups);
  if (keys.length) {
    h.push('<div class="actp-mail">');
    keys.forEach(function (g) {
      var cfg = ACTION_SETUP.groups[g] || {};
      var last = act_lastDraft_(g, sent);
      var rows = groups[g].reduce(function (n, f) { return n + (f.mail.sheets || []).reduce(function (m, s) { return m + Math.max(0, s.rows.length - 1); }, 0); }, 0);
      h.push('<div class="actp-mbox"><div><b>' + act_esc_(cfg.label || g) + '</b><span>' + groups[g].length + ' item' + (groups[g].length > 1 ? 's' : '') +
        ' · attachment ' + rows + ' rows' + (last ? ' · last draft ' + last : '') + '</span></div>' +
        (owner ? '<button type="button" data-draft="' + act_esc_(g) + '">Draft email</button>' : '') + '</div>');
    });
    h.push('<a class="actp-link" href="' + cfgDraftsUrl_() + '" target="_blank" rel="noopener">Open Gmail drafts</a></div>');
  }

  if (!list.length) h.push('<p class="actp-empty">No findings.</p>');
  var oks = list.filter(function (f) { return f.severity === 'ok'; });
  open.forEach(function (f) {
    var s = st.get(f);
    var pill = s.key === 'followup' ? 'Review draft' : ({ red: 'Act', amber: 'Watch', ok: 'OK' }[f.severity]);
    h.push('<article class="actp-card s-' + f.severity + '">' +
      '<div class="actp-top"><span class="actp-pill p-' + f.severity + '">' + pill + '</span>' +
      '<span class="actp-owner">' + act_esc_(f.owner) + '</span></div>' +
      '<h3>' + act_esc_(f.title) + '</h3>' +
      (f.evidence && f.evidence.length ? '<ul>' + f.evidence.map(function (e) { return '<li>' + act_esc_(e) + '</li>'; }).join('') + '</ul>' : '') +
      (f.action ? '<p><b>Next step</b> ' + act_esc_(f.action) + '</p>' : '') +
      (f.suggestion ? '<p class="actp-sug"><b>Suggestion</b> ' + act_esc_(f.suggestion) + '</p>' : '') +
      (s.key === 'followup' ? '<p class="actp-m">Draft recorded ' + act_dmy_(s.t) + ', the finding is still open. Check Gmail before drafting again. Follow-up CC requires a verified sent message for this topic.</p>' :
        f.mail ? '<p class="actp-m">Goes into the ' + act_esc_((ACTION_SETUP.groups[f.mail.group] || {}).label || f.mail.group) + ' email</p>' : '') +
      '</article>');
  });
  if (waiting.length) h.push('<details class="actp-ok actp-wait"><summary>Drafts recorded: check Gmail (' + waiting.length + ')</summary><ul>' +
    waiting.map(function (f) {
      var s = st.get(f);
      return '<li>' + act_esc_(f.title) + '<br><span>Draft made ' + act_dmy_(s.t) + '. Sending and replies are not tracked here. Check Gmail. Review again on ' + act_dmy_(s.due) + '.</span></li>';
    }).join('') + '</ul></details>');
  if (oks.length) h.push('<details class="actp-ok"><summary>On track (' + oks.length + ')</summary><ul>' +
    oks.map(function (f) { return '<li>' + act_esc_(f.title) + '</li>'; }).join('') + '</ul></details>');
  h.push('</section>');
  return h.join('');
}

// ------------------------------------------------------------------ drafts

function draftGroup(group) {
  if (!act_isOwner_()) throw new Error('Only the dashboard owner can create drafts');
  return act_withLock_('Draft', function () {
    var list = act_collect_().filter(function (f) { return f.mail && f.mail.group === group && f.severity !== 'ok'; });
    if (!list.length) return { ok: false, msg: 'Nothing to send' };
    act_makeDraft_(group, list);
    act_mark_(list, group);
    return { ok: true, msg: 'Draft ready in Gmail', url: cfgDraftsUrl_() };
  });
}

function runDailyActions() {
  var now = new Date();
  var dow = Number(Utilities.formatDate(now, ACT.TZ, 'u'));   // 1 = Mon .. 7 = Sun
  if (dow > 5) return;
  act_withLock_('Daily actions', function () {
    var sent = act_sent_();
    var cutoff = now.getTime() - ACT.REDRAFT_DAYS * 864e5;
    var all = act_collect_();
    var byGroup = {};
    all.forEach(function (f) { if (f.mail && f.severity !== 'ok') (byGroup[f.mail.group] = byGroup[f.mail.group] || []).push(f); });
    Object.keys(byGroup).forEach(function (g) {
      var list = byGroup[g];
      var fresh = list.filter(function (f) {
        if (f.severity !== 'red') return false;
        var t = sent[g + '|' + f.fp];
        return !t || t < cutoff;
      });
      if (!fresh.length) return;
      try { act_makeDraft_(g, list); act_mark_(list, g); }
      catch (e) { act_log_('Draft for ' + g + ' failed: ' + e.message); }
    });
  });
}

/** Recipient for a partner group, from Config (Script Properties). Empty when none is set. Drafts only, nothing is sent. */
function act_to_(group) { return cfgPartner_(group).to || ''; }

/** Extract exact addresses, not display-name or domain substring matches. */
function act_addresses_(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
}

function act_subjectBase_(value) {
  return String(value || '').replace(/^(?:(?:re|fw|fwd|aw|wg):\s*)+/i, '')
    .replace(/\s*\(\d{2}\.\d{2}\.\d{4}\)\s*$/, '').trim().toLowerCase();
}

/**
 * Draft history cannot establish contact. Verify an outgoing message for the
 * configured topic and partner in the last 45 days, then confirm its exact
 * Message-ID matches in:sent. Gmail search returns threads, so inspecting only
 * a matching thread would accidentally include its drafts and other messages.
 * No additional Gmail service or permission is required. Nothing is sent.
 * Bounded lookup; uncertainty means no automatic CC and an execution-log note.
 */
function act_hasSent_(group) {
  var recipients = act_addresses_(act_to_(group));
  var owner = String(cfgOwner_() || '').toLowerCase();
  var cfg = ACTION_SETUP.groups[group] || {};
  var subject = act_subjectBase_(cfg.subject || group + ': open points');
  if (!recipients.length || !owner || !subject) return false;
  var cutoff = Date.now() - 45 * 864e5;
  var quote = function (s) { return '"' + s.replace(/["\\\r\n]/g, ' ') + '"'; };
  var query = 'in:sent newer_than:45d from:' + quote(owner) +
    ' {' + recipients.map(function (r) { return 'to:' + quote(r); }).join(' ') + '}' +
    ' subject:' + quote(subject);
  try {
    var threads = GmailApp.search(query, 0, 20), checked = 0;
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      for (var j = messages.length - 1; j >= 0; j--) {
        if (++checked > 200) { console.warn('CC review: message limit reached for ' + group); return false; }
        var m = messages[j], date = m.getDate().getTime();
        if (m.isDraft() || date < cutoff || date > Date.now() ||
            act_addresses_(m.getFrom()).indexOf(owner) < 0 ||
            act_subjectBase_(m.getSubject()) !== subject) continue;
        var to = act_addresses_(m.getTo());
        if (!recipients.some(function (r) { return to.indexOf(r) >= 0; })) continue;
        var id = String(m.getHeader('Message-ID') || '').trim().replace(/^<|>$/g, '');
        if (!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~@-]+$/i.test(id) || id.indexOf('@') < 1) continue;
        if (GmailApp.search('in:sent rfc822msgid:' + quote(id), 0, 1).length) return true;
      }
    }
    if (threads.length === 20) console.warn('CC review: thread limit reached for ' + group);
    return false;
  } catch (e) {
    console.warn('CC review: sent verification unavailable for ' + group + '; no automatic CC.');
    return false;
  }
}

/** First contact: no CC. Confirmed prior sent topic: configured follow-up CC. */
function act_cc_(group) {
  if (!act_hasSent_(group)) return '';
  var extra = cfgPartner_(group).followCc || '';
  return cfgCc_() + (extra ? ',' + extra : '');
}

/** Safe editor check: reads Gmail and reports decisions; creates no drafts. */
function previewActionContactStatus() {
  Object.keys(ACTION_SETUP.groups).forEach(function (group) {
    console.log(group + ': ' + (act_hasSent_(group) ?
      'sent topic verified; follow-up CC eligible' : 'no sent topic verified; first-contact CC policy'));
  });
}

function act_makeDraft_(group, list) {
  var cfg = ACTION_SETUP.groups[group] || {};
  var today = Utilities.formatDate(new Date(), ACT.TZ, 'dd.MM.yyyy');
  var body = [cfg.greeting || 'Hi,', '', cfg.intro || 'A few points from this week\'s numbers that need your input.', ''];
  list.forEach(function (f, i) { body.push((list.length > 1 ? (i + 1) + '. ' : '') + f.mail.section.trim(), ''); });
  var sheets = [];
  list.forEach(function (f) { (f.mail.sheets || []).forEach(function (s) { if (s.rows.length > 1) sheets.push(s); }); });
  if (sheets.length) body.push((cfg.attachNote || 'The order level detail is in the attached file') + ' (' + sheets.map(function (s) { return s.name; }).join(', ') + ').', '');
  body.push(cfg.ask || 'Could you come back to me on these by the end of the week?', '', cfg.closing || 'Thanks,', 'Owner');
  var subject = (cfg.subject || group + ': open points') + ' (' + today + ')';
  var opts = {};
  var cc = act_cc_(group);
  if (cc) opts.cc = cc;
  if (sheets.length) opts.attachments = [act_xlsx_((cfg.file || group.replace(/\W+/g, '_')) + '_' + Utilities.formatDate(new Date(), ACT.TZ, 'dd.MM.yyyy'), sheets)];
  GmailApp.createDraft(act_to_(group), subject, body.join('\n'), opts);
  act_log_('Draft ' + group + ': ' + list.length + ' items, ' + sheets.length + ' tabs');
}

/** Builds an .xlsx blob: temporary private Sheet in My Drive, exported, then trashed. */
function act_xlsx_(name, sheets) {
  var ss = SpreadsheetApp.create(name);
  try {
    sheets.forEach(function (s, i) {
      var sh = i === 0 ? ss.getSheets()[0].setName(s.name.slice(0, 99)) : ss.insertSheet(s.name.slice(0, 99));
      var w = s.rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      var rows = s.rows.map(function (r) { var c = r.slice(); while (c.length < w) c.push(''); return c; });
      sh.getRange(1, 1, rows.length, w).setNumberFormat('@').setValues(rows);
      sh.getRange(1, 1, 1, w).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.autoResizeColumns(1, w);
    });
    SpreadsheetApp.flush();
    var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
    var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
    return blob.setName(name + '.xlsx');
  } finally {
    DriveApp.getFileById(ss.getId()).setTrashed(true);
  }
}

// ------------------------------------------------------------------ memory

/** Legacy key name: ACT_SENT stores draft timestamps, never evidence of sending. */
function act_sent_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(ACT.SENT_KEY) || '{}'); }
  catch (e) { return {}; }
}

function act_mark_(list, group) {
  var p = PropertiesService.getScriptProperties();
  var sent = act_sent_(), now = Date.now(), old = now - 45 * 864e5;
  list.forEach(function (f) { sent[group + '|' + f.fp] = now; });
  sent['last|' + group] = now;
  Object.keys(sent).forEach(function (k) { if (sent[k] < old) delete sent[k]; });
  p.setProperty(ACT.SENT_KEY, JSON.stringify(sent));
}

function act_lastDraft_(group, sent) {
  var t = sent['last|' + group];
  return t ? Utilities.formatDate(new Date(t), ACT.TZ, 'dd.MM.yyyy HH:mm') : '';
}

function act_log_(msg) {
  var p = PropertiesService.getScriptProperties();
  var log = [];
  try { log = JSON.parse(p.getProperty(ACT.LOG_KEY) || '[]'); } catch (e) {}
  log.unshift(Utilities.formatDate(new Date(), ACT.TZ, 'dd.MM.yyyy HH:mm') + ' ' + msg);
  p.setProperty(ACT.LOG_KEY, JSON.stringify(log.slice(0, 60)));
  console.log(msg);
}

/** Run once from the editor: weekday trigger at RUN_HOUR local time. */
function installActionTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyActions') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyActions').timeBased().everyDays(1).atHour(ACT.RUN_HOUR).nearMinute(5).inTimezone(ACT.TZ).create();
}

/** Run from the editor: one draft per partner that has open findings now (ignores the 7-day memory). */
function draftAllNow() {
  var groups = {};
  act_collect_().forEach(function (f) { if (f.mail && f.severity !== 'ok') groups[f.mail.group] = 1; });
  Object.keys(groups).forEach(function (g) { console.log(g + ': ' + draftGroup(g).msg); });
}

/** Run from the editor to see what the trigger would draft, without drafting. */
function previewActions() {
  act_collect_().forEach(function (f) {
    console.log('[' + f.severity + '] ' + f.owner + ' · ' + f.title + (f.mail ? ' -> ' + f.mail.group : ''));
  });
}

// ------------------------------------------------------------------ helpers for rules

/** Tab as objects keyed by header, display values. */
function act_tab_(ctx, id, tab) {
  var k = id + '|' + tab;
  if (ctx.cache[k]) return ctx.cache[k];
  var ss = SpreadsheetApp.openById(id);
  var sh = tab === 0 ? ss.getSheets()[0] : ss.getSheetByName(tab);
  if (!sh) throw new Error('Tab "' + tab + '" not found');
  var v = sh.getDataRange().getDisplayValues();
  var head = v.shift().map(function (x) { return String(x).trim(); });
  var rows = v.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {}; head.forEach(function (h, i) { if (h) o[h] = String(r[i]).replace(/^'/, '').trim(); }); return o;
  });
  rows.head = head;
  return (ctx.cache[k] = rows);
}

/** Throws when a tab lacks columns a rule depends on, so a layout change shows up as a "Check could not run" finding and an alert. */
function act_need_(rows, cols, label) {
  var head = (rows.head || []).map(String);
  var miss = cols.filter(function (c) { return head.indexOf(c) < 0; });
  if (miss.length) throw new Error(label + ': missing column(s) ' + miss.join(', ') + '. The sheet layout changed.');
  return rows;
}

/** "2026-KW41" for a date string, so a finding keeps the same fingerprint for the whole week. */
function act_weekKey_(s) {
  var p = act_parts_(s);
  return p ? p[0] + '-' + act_kw_(s) : 'n/a';
}

/** "1.234,5" "1,234.5" "97.55%" "-108" -> number (NaN if blank). */
function act_num_(s) {
  var t = String(s == null ? '' : s).replace(/[%\s€$]/g, '');
  if (t === '') return NaN;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  var n = parseFloat(t);
  return isNaN(n) ? NaN : n;
}

/** Share as 0..1 from "97.55%", "97.55" or "0.9755". percentUnits: plain numbers are percent ("0.77" = 0.77%). */
function act_share_(s, percentUnits) {
  var n = act_num_(s);
  if (isNaN(n)) return NaN;
  return (percentUnits || String(s).indexOf('%') >= 0 || n > 1.0001) ? n / 100 : n;
}

function act_pct_(x, d) { return isNaN(x) ? 'n/a' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
function act_int_(n) { return isNaN(n) ? 'n/a' : Math.round(n).toLocaleString('en-US'); }
function act_esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/** "2026-09-30" or "30.09.2026" -> "30 Sep" */
function act_day_(ymd) {
  var p = act_parts_(ymd);
  if (!p) return String(ymd);
  return p[2] + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][p[1] - 1];
}

/** ISO week label "KW40" for "2026-10-02" or "02.10.2026". */
function act_kw_(ymd) {
  var p = act_parts_(ymd);
  if (!p) return '';
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  var day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  var y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var w = Math.ceil(((d - y0) / 864e5 + 1) / 7);
  return 'KW' + (w < 10 ? '0' : '') + w;
}

/** Days between a date string (yyyy-mm-dd or dd.mm.yyyy, optional time) and now. NaN when it is neither. */
function act_ageDays_(ymd, now) {
  var p = act_parts_(ymd);
  if (!p) return NaN;
  var t = new Date(p[0], p[1] - 1, p[2], p[3], p[4]);
  return (now - t) / 864e5;
}

var ACT_CSS = [
  '.actp{--a-bg:#fff;--a-fg:#14201b;--a-mut:#5b6b64;--a-line:#d8e0dc;--a-r:#b3261e;--a-rb:#fbe3e1;--a-y:#a86400;--a-yb:#fdf0d9;--a-g:#1e7a4c;--a-gb:#e1f2e8;--a-br:#2e6b3f;',
  'display:grid;gap:12px;margin:8px 0 24px;font-family:inherit;color:var(--a-fg)}',
  '@media (prefers-color-scheme:dark){.actp{--a-bg:#18211e;--a-fg:#e7eeeb;--a-mut:#9aaaa4;--a-line:#2a3632;--a-r:#ff8a80;--a-rb:#3d1a18;--a-y:#f0b04d;--a-yb:#3a2b12;--a-g:#5fcf93;--a-gb:#173527;--a-br:#3f8a55}}',
  '.actp-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}',
  '.actp h2{margin:0;font-size:.78rem;text-transform:uppercase;letter-spacing:.1em;color:var(--a-mut)}',
  '.actp-sum{font-size:.85rem;color:var(--a-mut)} .actp-sum b.r{color:var(--a-r)} .actp-sum b.a{color:var(--a-y)} .actp-sum b.g{color:var(--a-g)} .actp-sum b.w{color:var(--a-mut)}',
  '.actp-mail{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
  '.actp-mbox{display:flex;gap:12px;align-items:center;background:var(--a-bg);border:1px solid var(--a-line);border-radius:12px;padding:10px 12px}',
  '.actp-mbox div{display:grid;font-size:.85rem} .actp-mbox span{color:var(--a-mut);font-size:.75rem}',
  '.actp button{font:inherit;font-size:.82rem;font-weight:600;border:0;border-radius:9px;padding:8px 12px;background:var(--a-br);color:#fff;cursor:pointer;min-height:36px}',
  '.actp button:disabled{opacity:.6;cursor:default} .actp button:focus-visible,.actp a:focus-visible{outline:2px solid var(--a-br);outline-offset:2px}',
  '.actp-link{font-size:.82rem;color:var(--a-br)}',
  '.actp-card{background:var(--a-bg);border-radius:12px;padding:12px 14px;border-left:4px solid var(--a-g);box-shadow:0 1px 6px rgba(0,0,0,.06)}',
  '.actp-card.s-red{border-left-color:var(--a-r)} .actp-card.s-amber{border-left-color:var(--a-y)}',
  '.actp-top{display:flex;gap:8px;align-items:center} .actp-owner{font-size:.75rem;color:var(--a-mut);font-weight:600}',
  '.actp-pill{font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.05em}',
  '.p-red{background:var(--a-rb);color:var(--a-r)} .p-amber{background:var(--a-yb);color:var(--a-y)} .p-ok{background:var(--a-gb);color:var(--a-g)}',
  '.actp-card h3{margin:6px 0 4px;font-size:.98rem} .actp-card ul{margin:4px 0;padding-left:18px;font-size:.85rem;display:grid;gap:2px}',
  '.actp-ok{font-size:.85rem;color:var(--a-mut)} .actp-ok summary{cursor:pointer;font-weight:600} .actp-ok ul{margin:6px 0;padding-left:18px} .actp-wait li{margin:4px 0} .actp-wait li span{font-size:.78rem}',
  '.actp-card p{margin:6px 0 0;font-size:.86rem} .actp-sug{color:var(--a-mut)} .actp-m{font-size:.75rem!important;color:var(--a-mut)} .actp-empty{color:var(--a-mut)}'
].join('');
