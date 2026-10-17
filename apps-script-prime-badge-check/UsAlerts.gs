/**
 * US action alert. Reads the US data sheet (tab "glance") and emails the owner only when something needs action.
 * Health metrics only while the US is outside an SFP period (SFP_ACTIVE = false). SFP rules (tier verdict,
 * speed gates, weekend relief reminder) stay in the code but are off. Set SFP_ACTIVE = true to bring them back.
 * No heartbeat email: silence means nothing to do. Sent to the account that owns the trigger, never to partners.
 *  - Health: on-time delivery < 90%, valid tracking < 95%, cancellations > 2.5% (per size tier, with counts).
 *  - US data not updated for more than 3 days (feed broken).
 * Setup once: installUsAlertTrigger. Test: sendUsAlertNow (sends only if something needs action).
 */
var USA = {
  TAB: 'glance',   // sheet ID: Config.gs (US_SHEET_ID)
  LOOKER: 'https://lookerstudio.google.com/reporting/00000000-0000-0000-0000-000000000000',
  TZ: 'Europe/Berlin', HOUR: 14, MIN: 25, KEEP_DAYS: 7, KEY: 'US_ALERT_SENT',
  SFP_ACTIVE: false,
  OTD_MIN: 90, VTR_MIN: 95, CANCEL_MAX: 2.5,
  STALE_DAYS: 3, RELIEF_END: '2026-10-17',
  RED: '🔴', TIERS: ['Oversize', 'Extra Large']
};

function runUsAlertEmail(force) {
  act_withLock_('US alert email', function () { usa_run_(force); });
}

function usa_run_(force) {
  var now = new Date();
  var dow = Number(Utilities.formatDate(now, USA.TZ, 'u'));
  if (dow > 5 && force !== true) return;
  var today = Utilities.formatDate(now, USA.TZ, 'yyyy-MM-dd');
  var v = SpreadsheetApp.openById(cfg_('US_SHEET_ID')).getSheetByName(USA.TAB).getRange('A1:W8').getDisplayValues();
  var head = v[0], rows = v.slice(1);
  var findings = [];
  function pct(s) { var m = /(-?[\d.]+)\s*%/.exec(String(s)); return m ? parseFloat(m[1]) : NaN; }

  var newest = '';
  rows.forEach(function (r) { if (/^\d{4}-\d{2}-\d{2}$/.test(r[13]) && r[13] > newest) newest = r[13]; });
  var age = newest ? Math.round((Date.parse(today) - Date.parse(newest)) / 864e5) : 999;
  if (age > USA.STALE_DAYS) {
    findings.push({ key: 'stale|' + newest, title: 'US data not updated for ' + age + ' days (newest ' + (newest || 'none') + ')',
      lines: ['The morning US check did not write new rows.'], action: 'Check the import and the daily sheet.' });
  }

  rows.forEach(function (r) {
    if (USA.TIERS.indexOf(r[0]) < 0) return;
    var bad = [];
    var otd = pct(r[3]), vtr = pct(r[4]), can = pct(r[5]);
    if (!isNaN(otd) && otd < USA.OTD_MIN) bad.push('On-time delivery ' + String(r[3]).replace(USA.RED, '').trim() + ' (min ' + USA.OTD_MIN + '%)');
    if (!isNaN(vtr) && vtr < USA.VTR_MIN) bad.push('Valid tracking ' + String(r[4]).replace(USA.RED, '').trim() + ' (min ' + USA.VTR_MIN + '%)');
    if (!isNaN(can) && can > USA.CANCEL_MAX) bad.push('Cancellations ' + String(r[5]).replace(USA.RED, '').trim() + ' (max ' + USA.CANCEL_MAX + '%)');
    if (bad.length) {
      findings.push({ key: 'health|' + r[0] + '|' + bad.map(function (b) { return b.slice(0, 12); }).join(','),
        title: r[0] + ': health metric below limit (' + r[1] + ')', lines: bad,
        action: 'Open the late packages sheet, split warehouse-caused vs carrier-caused, and draft the WarehouseUS email only for what WarehouseUS controls.' });
    }
    if (USA.SFP_ACTIVE) {
      var reds = [];
      for (var c = 3; c <= 9; c++) if (String(r[c]).indexOf(USA.RED) >= 0) reds.push(String(head[c]).replace(/\s*\(.*$/, '') + ' ' + String(r[c]).replace(USA.RED, '').trim());
      if (/^FAIL/i.test(r[9]) || reds.length) {
        findings.push({ key: 'sfp|' + r[0] + '|' + reds.join(',') + '|' + String(r[9]).slice(0, 40),
          title: r[0] + ': SFP ' + (r[9] || 'red requirement') + ' (' + r[1] + ')', lines: reds,
          action: 'Open the late packages sheet and split warehouse-caused vs carrier-caused causes.' });
      }
    }
  });

  if (USA.SFP_ACTIVE) {
    var daysTo = Math.round((Date.parse(USA.RELIEF_END) - Date.parse(today)) / 864e5);
    if (daysTo >= 0 && daysTo <= 3) {
      findings.push({ key: 'relief|' + (daysTo <= 1 ? '1d' : '3d'), title: 'US weekend relief ends in ' + daysTo + ' day' + (daysTo === 1 ? '' : 's') + ' (' + USA.RELIEF_END + ')',
        lines: ['Weekends re-enter the speed metric after this date.'], action: 'Confirm weekend shipping with WarehouseUS before then.' });
    }
  }

  var p = PropertiesService.getScriptProperties(), sent = {};
  try { sent = JSON.parse(p.getProperty(USA.KEY) || '{}'); } catch (e) { sent = {}; }
  var keepFrom = Utilities.formatDate(new Date(now.getTime() - USA.KEEP_DAYS * 864e5), USA.TZ, 'yyyy-MM-dd');
  Object.keys(sent).forEach(function (k) { if (sent[k] < keepFrom) delete sent[k]; });
  var fresh = findings.filter(function (f) { return !sent[f.key]; });
  if (!fresh.length) return;

  var out = [fresh.length + ' US item' + (fresh.length > 1 ? 's' : '') + ' need action:', ''];
  fresh.forEach(function (f) {
    out.push('[RED] ' + f.title);
    f.lines.forEach(function (l) { out.push('   ' + l); });
    out.push('   Next step: ' + f.action, '');
  });
  out.push('Checked ' + Utilities.formatDate(now, USA.TZ, 'dd.MM.yyyy HH:mm') + ' (local time). Data as of ' + (newest || 'unknown') + '.');
  out.push('Dashboard: ' + USA.LOOKER);
  out.push('This alert goes only to you. Nothing is sent to partners.');
  GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'SFP US: ' + fresh.length + ' item' + (fresh.length > 1 ? 's' : '') + ' need action', out.join('\n'), { name: 'Company dashboards' });
  fresh.forEach(function (f) { sent[f.key] = today; });
  p.setProperty(USA.KEY, JSON.stringify(sent));
}

function installUsAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runUsAlertEmail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runUsAlertEmail').timeBased().everyDays(1).atHour(USA.HOUR).nearMinute(USA.MIN).inTimezone(USA.TZ).create();
}

function sendUsAlertNow() { runUsAlertEmail(true); }
