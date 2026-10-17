/**
 * Prime Check freshness watchdog. Emails only the owner, once per missed slot.
 * Slots: weekdays 06:00 and 17:00 local time. Checks 45 min after each slot.
 * Setup once from the editor: installWatchdogTriggers. Test: watchdogTest.
 */
var WD = { TZ: 'Europe/Berlin', SLOTS: [6, 17], GRACE_MIN: 45, KEY: 'WD_SENT' };

function wdLatestBlock_() {
  var ss = SpreadsheetApp.openById(cfg_('PRIME_SHEET_ID'));
  var sh = ss.getSheetByName(cfg_('PRIME_TAB'));
  if (!sh) { ss.getSheets().forEach(function (s) { if (!sh && /PLZ/i.test(s.getName())) sh = s; }); }
  if (!sh) sh = ss.getSheets()[0];
  var vals = sh.getRange(1, 1, Math.min(sh.getLastRow(), 40), 2).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    var a = String(vals[i][0]).trim(), b = String(vals[i][1]).trim();
    var d = a.match(/(\d{4})-(\d{2})-(\d{2})/), e = a.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/), f = a.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    var t = b.match(/(\d{1,2}):(\d{2})/);
    if ((d || e || f) && t) {
      var y, mo, da;
      if (d) { y = +d[1]; mo = +d[2]; da = +d[3]; }
      else if (e) { y = +e[3]; mo = +e[2]; da = +e[1]; }
      else { y = +f[3]; mo = +f[1]; da = +f[2]; }
      return { key: y * 1e8 + mo * 1e6 + da * 1e4 + (+t[1]) * 100 + (+t[2]), label: da + '.' + mo + '.' + y + ' ' + t[1] + ':' + t[2] };
    }
  }
  return null;
}

function runWatchdog(force) {
  var now = new Date();
  var dow = Number(Utilities.formatDate(now, WD.TZ, 'u'));
  if (dow > 5 && force !== true) return;
  var hm = Number(Utilities.formatDate(now, WD.TZ, 'H')) * 60 + Number(Utilities.formatDate(now, WD.TZ, 'm'));
  var slot = -1;
  WD.SLOTS.forEach(function (h) { if (hm >= h * 60 + WD.GRACE_MIN - 5) slot = h; });
  if (slot < 0) return;
  var day = Utilities.formatDate(now, WD.TZ, 'yyyyMMdd');
  var need = Number(day) * 1e4 + slot * 100;
  var last = wdLatestBlock_();
  if (last && last.key >= need) return;
  var p = PropertiesService.getScriptProperties(), sent = {};
  try { sent = JSON.parse(p.getProperty(WD.KEY) || '{}'); } catch (x) { sent = {}; }
  var k = day + '|' + slot;
  if (sent[k] && force !== true) return;
  var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (x) {}
  var body = 'The ' + (slot < 10 ? '0' : '') + slot + ':00 Prime check block is missing.\n' +
    'Newest block in the sheet: ' + (last ? last.label : 'none found') + '.\n\n' +
    'Next step: check the process that fills the sheet and run it once by hand.\n' +
    (url ? '\nDashboard: ' + url + '\n' : '') + '\nThis goes only to you.';
  GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'DE Prime Check: ' + (slot < 10 ? '0' : '') + slot + ':00 block missing', body, { name: 'Company dashboards' });
  sent[k] = 1;
  var keys = Object.keys(sent); if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(function (q) { delete sent[q]; });
  p.setProperty(WD.KEY, JSON.stringify(sent));
}

function installWatchdogTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'runWatchdog') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWatchdog').timeBased().everyDays(1).atHour(6).nearMinute(50).inTimezone(WD.TZ).create();
  ScriptApp.newTrigger('runWatchdog').timeBased().everyDays(1).atHour(17).nearMinute(50).inTimezone(WD.TZ).create();
}

function watchdogTest() { runWatchdog(true); }

/** Dry run: logs the newest block the watchdog sees. Sends nothing. */
function watchdogDryRun() { Logger.log(JSON.stringify(wdLatestBlock_())); }
