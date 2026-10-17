// Products still checked (0-based index into the product list) and the date that list applies from.
var ACTIVE_PRODUCTS = [1,2,3,4,5,7];
var ACTIVE_SINCE = '2026-01-01';

/**
 * DE Prime Check: dashboard backend (Google Apps Script).
 *
 * Reads the check blocks out of the PLZ_Produkte sheet and serves them to
 * Index.html. Nothing is written back to the sheet: this is read-only.
 *
 * The sheet layout this expects, repeated top to bottom, newest first:
 *   row N      A = date, B = time
 *   row N+1    merged product group headers
 *   row N+2    PLZ | Ort | Prime Badge | Liefertag | ... (8 product pairs)
 *   row N+3..N+12   the ten postcode rows
 *   row N+13   blank
 */

// Sheet IDs live in Config.gs / Script Properties (cfg_).
// Exact tab name: Config.gs (PRIME_TAB); see pickSheet() fallback.
var MAX_BLOCKS = 60;   // newest N checks; the page charts the last 12
var ROWS_PER_BLOCK = 10;
var PRODUCT_COUNT = 8; // columns C..R = 8 (Prime Badge, Liefertag) pairs

// ---------------------------------------------------------------- serving

function doGet(e) {
  if (e && e.parameter && e.parameter.view === 'eu') {
    return HtmlService.createHtmlOutputFromFile('EU')
      .setTitle('BrandX EU Account Health')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (e && e.parameter && e.parameter.view === 'health') {
    return HtmlService.createHtmlOutputFromFile('Health')
      .setTitle('SFP DE Account Health')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (e && e.parameter && e.parameter.data === 'json') {
    return ContentService
      .createTextOutput(JSON.stringify(getChecks()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('DE Prime Check')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------- parsing

/**
 * The tab named in PRIME_TAB, or: if it has been renamed: the first tab whose
 * name starts with "PLZ_Produkte". Renaming the tab should not break the page.
 */
function pickSheet(ss) {
  var sh = ss.getSheetByName(cfg_('PRIME_TAB'));
  if (sh) return sh;
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getName().indexOf('PLZ_Produkte') === 0) return all[i];
  }
  throw new Error('No PLZ_Produkte tab found (looked for "' + cfg_('PRIME_TAB') + '")');
}

/**
 * Returns the newest checks, newest first:
 *   [{ ts, date, time, phase, rows: [{plz, ort, buffer, day, prime[8], liefer[8]}] }]
 * Called directly from the page via google.script.run.
 */
function getChecks() {
  var ss = SpreadsheetApp.openById(cfg_('PRIME_SHEET_ID'));
  var sh = pickSheet(ss);

  var lastRow = sh.getLastRow();
  var width = 2 + PRODUCT_COUNT * 2;                 // A..R
  var range = sh.getRange(1, 1, lastRow, width);
  var vals = range.getValues();                      // real types: Date, boolean
  var disp = range.getDisplayValues();               // exactly what the sheet shows

  var out = [];
  for (var i = 0; i < vals.length && out.length < MAX_BLOCKS; i++) {
    // A block starts where column A holds a real date and column B a time.
    if (!(vals[i][0] instanceof Date)) continue;
    var date = firstDay(disp[i][0]);   // read the shown date, no timezone involved
    if (!date) continue;
    var timeText = String(disp[i][1] || '').trim();
    if (!/^\d{1,2}:\d{2}/.test(timeText)) continue;

    var rows = [];
    for (var r = i + 3; r < i + 3 + ROWS_PER_BLOCK && r < vals.length; r++) {
      var plz = normalisePlz(disp[r][0]);
      if (!plz) break;
      var prime = [], primeKnown = [], liefer = [];
      for (var p = 0; p < PRODUCT_COUNT; p++) {
        prime.push(vals[r][2 + p * 2] === true ? 1 : 0);
        primeKnown.push(vals[r][2 + p * 2] === true || vals[r][2 + p * 2] === false);
        liefer.push(String(disp[r][3 + p * 2] || '').trim());
      }
      rows.push({
        plz: plz,
        ort: String(disp[r][1] || '').trim(),
        prime: prime,
        primeKnown: primeKnown,
        liefer: liefer
      });
    }
    if (rows.length !== ROWS_PER_BLOCK) continue;    // not a well-formed block

    // From ACTIVE_SINCE on, only complete active-product blocks may
    // establish freshness or comparisons. Keep older history readable.
    if (date >= ACTIVE_SINCE) {
      var activeProducts = ACTIVE_PRODUCTS;
      if (rows.some(function(row) { return activeProducts.some(function(p) {
        return !row.primeKnown[p] || !firstDay(row.liefer[p]);
      }); })) continue;
      rows.forEach(function(row) {
        row.availability = row.primeKnown.map(function(known,p) {
          return p === 0 || p === 6 ? 'unavailable' : 'observed';
        });
      });
    }

    assignBuffers(rows);

    var time = padTime(timeText);
    out.push({
      ts: date + 'T' + time,
      date: date,
      time: time,
      phase: parseInt(time.slice(0, 2), 10) < 12 ? 'before' : 'after',
      rows: rows
    });
    i += ROWS_PER_BLOCK + 2;                          // skip past this block
  }

  if (!out.length && lastRow > 20) throw new Error('Prime check sheet: ' + lastRow + ' rows but no readable check block. The sheet layout changed.');
  out = out.concat(primeOwnedChecks_());
  out.sort(function (a, b) { return a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0); });
  return out.slice(0, MAX_BLOCKS);
}

/** "4109" or "04109" -> "04109" */
function normalisePlz(v) {
  var s = String(v == null ? '' : v).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  while (s.length < 5) s = '0' + s;
  return s;
}

/** "9:00" -> "09:00" */
function padTime(t) {
  var m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
}

/**
 * A range ALWAYS counts as its first day.
 * "10/06/2026 - 10/08/2026" -> "2026-10-06"   (the sheet stores MM/DD/YYYY)
 */
function firstDay(cell) {
  if (!cell) return null;
  var t = String(cell).split(' - ')[0].trim();
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  var mm = m[1].length === 1 ? '0' + m[1] : m[1];
  var dd = m[2].length === 1 ? '0' + m[2] : m[2];
  return m[3] + '-' + mm + '-' + dd;
}

/**
 * Two steps, as the check defines them:
 *  1. a postcode's delivery day is the day shown for most of its eight
 *     products, ranges counted by their first day;
 *  2. 0 buffer days = the earliest of those days in this check,
 *     1 = the next one, 2 = the one after (and anything later).
 */
function assignBuffers(rows) {
  var days = [];
  rows.forEach(function (r) {
    var tally = {};
    r.liefer.forEach(function (v) {
      var d = firstDay(v);
      if (d) tally[d] = (tally[d] || 0) + 1;
    });
    var best = null, n = -1;
    Object.keys(tally).forEach(function (d) {
      if (best === null || tally[d] > n || (tally[d] === n && d < best)) {
        best = d; n = tally[d];
      }
    });
    r.day = best;
    if (best && days.indexOf(best) < 0) days.push(best);
  });
  days.sort();
  rows.forEach(function (r) {
    var ix = r.day ? days.indexOf(r.day) : -1;
    r.buffer = ix < 0 ? 0 : Math.min(ix, 2);
  });
}

// ---------------------------------------------------------------- optional

/** Sanity check: run once from the editor and read the log. */
function testParse() {
  var checks = getChecks();
  Logger.log('%s checks parsed', checks.length);
  if (checks.length) {
    var c = checks[0];
    Logger.log('latest: %s %s (%s cut-off)', c.date, c.time, c.phase);
    Logger.log('buffers: %s', c.rows.map(function (r) {
      return r.plz + '=' + r.buffer + '@' + r.day;
    }).join('  '));
  }
}


// ---------------------------------------------------------------- account health

/**
 * Amazon account health readings for BrandX | Germany, one row per reading,
 * kept in your own sheet "SFP DE Account Health" (first tab). The
 * routine appends a row; this page only reads. Header row names the fields:
 * read_at, otd_num, otd_den, otd_window, ldr_num, ldr_den, ldr_window,
 * bhdr_num, bhdr_den, bhdr_window, prime_block, action, note
 */

function getHealth() {
  var sh = SpreadsheetApp.openById(cfg_('HEALTH_SHEET_ID')).getSheets()[0];
  var v = sh.getDataRange().getDisplayValues();
  if (v.length < 2) return [];
  var head = v[0].map(function (x) { return String(x).trim(); });
  var out = [];
  for (var i = 1; i < v.length; i++) {
    if (!String(v[i][0]).trim()) continue;
    var o = {};
    for (var j = 0; j < head.length; j++) if (head[j]) o[head[j]] = String(v[i][j]).trim();
    out.push(o);
  }
  out.sort(function (a, b) { return String(b.read_at).localeCompare(String(a.read_at)); });
  return out.slice(0, 40);
}

// ---------------------------------------------------------------- BrandX EU (FR, UK, IT, ES)


function getEu() {
  var v = SpreadsheetApp.openById(cfg_('EU_SHEET_ID')).getSheets()[0].getDataRange().getDisplayValues();
  var h = v.shift().map(function (x) { return String(x).trim().toLowerCase(); });
  var rows = v.filter(function (r) { return String(r[0]).trim() !== ''; }).map(function (r) {
    var o = {}; h.forEach(function (k, i) { if (k) o[k] = String(r[i]).replace(/^'/, '').trim(); }); return o;
  });
  return JSON.stringify({rows: rows});
}


// Complete, verified retail batches in your workbook; shared history stays read-only.
function primeOwnedChecks_() {
  var sh = SpreadsheetApp.openById(cfg_('HEALTH_SHEET_ID')).getSheetByName('Prime_Observations');
  if (!sh || sh.getLastRow() < 81) return [];
  var values = sh.getDataRange().getValues(), batches = {};
  values.slice(1).forEach(function(v) {
    var id = String(v[0] || '');
    if (id) (batches[id] || (batches[id] = [])).push(v);
  });
  var asins = ['B0EXAMPLE1','B0EXAMPLE2','B0EXAMPLE3','B0EXAMPLE4','B0EXAMPLE5','B0EXAMPLE6','B0EXAMPLE7','B0EXAMPLE8'];
  var postcodes = ['10115','20095','80331','50667','60311','70173','40210','04109','01067','30159'];
  var out = [];
  Object.keys(batches).forEach(function(id) {
    var data = batches[id], rows = {}, seen = {}, valid = data.length === 80, times = [];
    data.forEach(function(v) {
      var plz=String(v[2]), p=Number(v[4]), status=String(v[9]), key=plz+'|'+p;
      if(postcodes.indexOf(plz)<0 || p<0 || p>7 || p%1!==0 || v[6]!==asins[p] || seen[key]) { valid=false; return; }
      seen[key]=true;
      if(!rows[plz]) rows[plz]={plz:plz,ort:String(v[3]),prime:[],primeKnown:[],liefer:[],availability:[]};
      var r=rows[plz], inactive=p===0||p===6;
      if(inactive) {
        if(status!=='unavailable'||v[7]!==''||v[8]!==''||!v[10]) valid=false;
      } else {
        if(status!=='observed'||typeof v[7]!=='boolean'||!firstDay(String(v[8]))||!v[11])valid=false;
        var t=Date.parse(String(v[1])); if(!isFinite(t))valid=false; else times.push(t);
      }
      r.prime[p]=v[7]===true?1:0;r.primeKnown[p]=!inactive&&typeof v[7]==='boolean';
      r.liefer[p]=String(v[8]||'');r.availability[p]=status;
    });
    var completed=Math.max.apply(null,times), started=Math.min.apply(null,times);
    if(!valid||times.length!==60||completed-started>3*36e5||id!==new Date(completed).toISOString())return;
    var ordered=postcodes.map(function(p){return rows[p];});assignBuffers(ordered);
    var stamp=Utilities.formatDate(new Date(completed),'Europe/Berlin',"yyyy-MM-dd'T'HH:mm");
    out.push({ts:stamp,date:stamp.slice(0,10),time:stamp.slice(11),phase:Number(stamp.slice(11,13))<12?'before':'after',rows:ordered,
      source:'Verified retail collection',measured:60,unavailable:20,startedAt:new Date(started).toISOString(),completedAt:id});
  });
  return out;
}
