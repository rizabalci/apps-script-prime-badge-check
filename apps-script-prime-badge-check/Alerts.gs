/**
 * Daily alert email to the owner. Same file in every dashboard project except the 3PL Scorecard (it has dailyAlerts).
 * Uses the Actions engine findings (act_collect_) so there is nothing project specific here.
 *  - Red findings, and amber findings flagged alert:true (stale data) or err- (a check could not run), are emailed once (kept 14 days).
 *  - No heartbeat email: silence means nothing needs action.
 *  - Email goes only to the account that owns the trigger. Nothing is sent to partners.
 *  - Findings whose partner draft is waiting are not counted as open; a follow-up that falls due is alerted once.
 * Setup once from the editor: installAlertTrigger. Test: sendAlertEmailNow.
 */
var ALERT = {
  TZ: 'Europe/Berlin', HOUR: 14, MIN: 20, KEEP_DAYS: 14, KEY: 'ALERT_SENT',
  STALE_RE: /stale|out of date|older|too old|no new reading|not updated|not read/i
};

function runDailyAlertEmail(force) {
  var now = new Date();
  var dow = Number(Utilities.formatDate(now, ALERT.TZ, 'u'));
  var manual = force === true;
  if (dow > 5 && !manual) return;
  act_withLock_('Alert email', function () { alert_run_(now, manual); });
}

function alert_run_(now, manual) {
  var all = act_collect_();
  var psent = act_sent_(), nowMs = now.getTime();
  // A finding whose partner draft is waiting is not "open" for the counts, and a follow-up that falls due is alerted once.
  var state = function (f) { return act_state_(f, psent, nowMs); };
  var items = all.filter(function (f) {
    if (state(f).key === 'waiting') return false;
    // alert:true is set by rules on stale-data findings; err- findings mean a check could not run (layout change)
    return f.severity === 'red' || (f.severity === 'amber' && (f.alert === true || /^err-/.test(String(f.id)) || ALERT.STALE_RE.test(String(f.title))));
  }).map(function (f) {
    var s = state(f);
    if (s.key !== 'followup') return f;
    var c = {}; Object.keys(f).forEach(function (k) { c[k] = f[k]; });
    c.id = 'fu-' + f.id; c.title = 'Follow up, draft of ' + act_dmy_(s.t) + ' is old: ' + f.title; c.fp = f.fp + '|' + act_dmy_(s.due);
    return c;
  });
  var p = PropertiesService.getScriptProperties(), sent = {};
  try { sent = JSON.parse(p.getProperty(ALERT.KEY) || '{}'); } catch (e) { sent = {}; }
  var today = Utilities.formatDate(now, ALERT.TZ, 'yyyy-MM-dd');
  var keepFrom = Utilities.formatDate(new Date(now.getTime() - ALERT.KEEP_DAYS * 864e5), ALERT.TZ, 'yyyy-MM-dd');
  Object.keys(sent).forEach(function (k) { if (sent[k] < keepFrom) delete sent[k]; });
  function key(f) { return String(f.id) + '|' + String(f.fp || f.title).slice(0, 80); }
  var fresh = items.filter(function (f) { return !sent[key(f)]; });
  var weekly = manual;
  if (!fresh.length && !weekly) return;

  var name = (typeof ACTION_SETUP !== 'undefined' && ACTION_SETUP.name) ? ACTION_SETUP.name : 'Dashboard';
  var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (e) { url = ''; }
  var openNow = all.filter(function (f) { return state(f).key !== 'waiting'; });
  var waitingN = all.length - openNow.length;
  var reds = openNow.filter(function (f) { return f.severity === 'red'; }).length;
  var ambers = openNow.filter(function (f) { return f.severity === 'amber'; }).length;
  var lines = [];
  if (fresh.length) {
    lines.push(fresh.length + ' new item' + (fresh.length > 1 ? 's' : '') + ' need attention:', '');
    fresh.forEach(function (f) {
      lines.push('[' + String(f.severity).toUpperCase() + '] ' + f.owner + ': ' + f.title);
      if (f.evidence && f.evidence.length) lines.push('   ' + f.evidence.join('; '));
      if (f.action) lines.push('   Next step: ' + f.action);
      lines.push('');
    });
  } else {
    lines.push('Nothing new since the last alert.', '');
  }
  lines.push('Open now: ' + reds + ' red, ' + ambers + ' amber' + (waitingN ? ', ' + waitingN + ' waiting for a partner' : '') + '. Checked ' + Utilities.formatDate(now, ALERT.TZ, 'dd.MM.yyyy HH:mm') + '.');
  if (url) lines.push('Dashboard: ' + url);
  lines.push('Partner emails are separate: look in Gmail drafts. This alert goes only to you.');
  var subject = name + ': ' + (fresh.length ? fresh.length + ' new item' + (fresh.length > 1 ? 's' : '') + ' need attention' : 'status, nothing new');
  GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, lines.join('\n'), { name: 'Company dashboards' });
  fresh.forEach(function (f) { sent[key(f)] = today; });
  p.setProperty(ALERT.KEY, JSON.stringify(sent));
  try { act_log_('Alert email: ' + fresh.length + ' new, ' + reds + ' red, ' + ambers + ' amber'); } catch (e) {}
}

/** Run once from the editor: weekday email check at HOUR:MIN local time (after runDailyActions). */
function installAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDailyAlertEmail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyAlertEmail').timeBased().everyDays(1).atHour(ALERT.HOUR).nearMinute(ALERT.MIN).inTimezone(ALERT.TZ).create();
}

/** Run from the editor to test: sends the status email now. */
function sendAlertEmailNow() { runDailyAlertEmail(true); }
