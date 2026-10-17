/**
 * Rules for the DE Prime Check project: three screens.
 *   scope 'prime'  : Prime badge per product and test postcode
 *   scope 'health' : SFP DE account health (Amazon-measured)
 *   scope 'eu'     : BrandX FR, UK, IT, ES (Amazon-measured)
 * Amazon metrics are judged here; warehouse KPIs stay in the 3PL Scorecard.
 * An email to a partner is drafted only for the part they control.
 */
// Sheet IDs (health, EU, 3PL Scorecard) come from Config.gs.

var ACTP_T = {
  OTD: 0.90, LDR: 0.04, BHDR: 0.90, VTR: 0.95, CANCEL: 0.025,
  OTD_AMBER_SHARE: 0.02,      // amber when on-time headroom is below 2% of the window
  SMALL_SAMPLE: 50,
  STALE_HOURS: 26,            // no reading for more than a working day
  PRIME_STALE_HOURS: 14
};

// marketplace -> who dispatches its seller-fulfilled orders (email group); blank = internal only
var ACTP_EU_NODE = { UK: 'WarehouseUK', FR: 'WarehouseDE', DE: 'WarehouseDE', IT: '', ES: '' };

var ACTION_SETUP = {
  name: 'DE Prime Check',
  groups: {
    WarehouseDE: { label: 'WarehouseDE', subject: 'Company: late dispatch on Amazon and Q4 non-working days', file: 'COMPANY_WarehouseDE_late_dispatch',
      greeting: 'Hi all,', intro: 'Amazon is flagging our late dispatch rate. Part of it is on our side (shipping template settings), but I want to make sure we have the warehouse side covered too.',
      ask: 'Could you send me your non-working days and any reduced DHL / DPD pickups until the end of January, and check the attached notes by the end of the week?' },
    WarehouseUK: { label: 'WarehouseUK', subject: 'Company: UK seller-fulfilled orders, dispatch and tracking', file: 'COMPANY_WarehouseUK_UK',
      greeting: 'Hi,', intro: 'Amazon UK is flagging our seller-fulfilled metrics. The numbers are small, but each order counts.',
      ask: 'Could you check the orders behind this and tell me what happened?' },
    DHL: { label: 'DHL', subject: 'Company: business deliveries attempted outside opening hours', file: 'COMPANY_DHL_business_deliveries',
      greeting: 'Hi,', intro: 'Amazon measures our business customer deliveries against the customer\'s opening hours. Several DHL first attempts fell on closed days or outside hours.',
      ask: 'Could you check these shipments and tell me whether the opening hours can be passed to the driver, or whether there is a business delivery option we should use?' }
  },
  rules: [actp_health_, actp_eu_, actp_prime_]
};

// --------------------------------------------------------------- health (DE)

function actp_health_(ctx) {
  var rows = act_need_(act_tab_(ctx, cfg_('HEALTH_SHEET_ID'), 0), ['read_at', 'otd_num', 'otd_den', 'ldr_num', 'ldr_den'], 'SFP DE Account Health').filter(function (r) { return r.read_at; });
  rows.sort(function (a, b) { return String(b.read_at).localeCompare(String(a.read_at)); });
  var r = rows[0];
  if (!r) return [];
  var out = [];
  var age = act_ageDays_(r.read_at, ctx.now) * 24;
  if (age > ACTP_T.STALE_HOURS) out.push({ id: 'h-stale', scope: 'health', severity: 'amber', owner: 'Internal', alert: true,
    title: 'No account health reading since ' + r.read_at, evidence: ['Latest row in SFP DE Account Health: ' + r.read_at],
    action: 'Check that the latest account health reading was added to the sheet.' });

  // late dispatch 10 and 30 days
  [['ldr10_num', 'ldr10_den', '10 days'], ['ldr_num', 'ldr_den', '30 days']].forEach(function (k) {
    var n = act_num_(r[k[0]]), d = act_num_(r[k[1]]);
    if (!(d > 0)) return;
    var rate = n / d, allowed = Math.ceil(d * ACTP_T.LDR) - 1, over = n - allowed;
    if (rate <= ACTP_T.LDR) return;
    var wh = actp_warehouseDeLate_(ctx, k[2] === '10 days' ? 10 : 30);
    var deEu = actp_euDe_(ctx);
    var holiday = /holiday|feiertag/i.test(r.note + ' ' + r.action + ' ' + deEu);
    var f = { id: 'h-ldr-' + k[2], scope: 'health', severity: 'red', owner: 'Internal + WarehouseDE',
      title: 'Late dispatch ' + k[2] + ' ' + act_pct_(rate, 2) + ' (' + act_int_(n) + ' of ' + act_int_(d) + ' orders), limit 4%',
      evidence: ['About ' + act_int_(over) + ' orders over the limit; they roll off as the window moves', 'Reading ' + r.read_at + (r.note ? ': ' + r.note : ''), deEu ? 'EU sheet note: ' + deEu : '',
        wh ? 'JTL shows ' + wh.count + ' WarehouseDE delivery notes labelled late on the warehouse side in the same ' + k[2] : 'Warehouse-side late notes: not readable from the 3PL Scorecard'].filter(String),
      action: 'Split the ' + act_int_(n) + ' late orders by cause before talking to anyone: ship-by date on a non-working day (template) vs. warehouse late (JTL label after the ship-by date).',
      suggestion: holiday ? 'The note links the jump to a holiday. Add every Q4 non-working day of WarehouseDE to the Seller Central holiday settings now, so Amazon stops setting ship-by dates on days nobody ships.' : 'Download the late dispatch report and match order IDs against JTL label times; only the matches with a late label go to WarehouseDE.',
      fp: 'ldr' + k[2] + '|' + act_weekKey_(r.read_at) };
    if (k[2] === '10 days') f.mail = { group: 'WarehouseDE',
      section: 'Amazon DE late dispatch over the last 10 days is ' + act_pct_(rate, 2) + ' (' + act_int_(n) + ' of ' + act_int_(d) + ' orders, limit 4%). ' +
        (holiday ? 'Most of it comes from ship-by dates that fell on a public holiday, which is on our side in the shipping templates. ' : '') +
        (wh && wh.count ? 'On the warehouse side, JTL shows ' + wh.count + ' delivery notes labelled late in the same period (attached).' : 'Please send your non-working days so we can set them before the next holiday.'),
      sheets: wh && wh.rows.length > 1 ? [{ name: 'WarehouseDE late notes', rows: wh.rows }] : [] };
    out.push(f);
  });

  // on-time delivery
  var on = act_num_(r.otd_num), od = act_num_(r.otd_den);
  if (od > 0) {
    var otd = on / od, head = on - (Math.floor(od * ACTP_T.OTD) + 1) + 1;
    var sev = otd < ACTP_T.OTD ? 'red' : (head < od * ACTP_T.OTD_AMBER_SHARE ? 'amber' : 'ok');
    out.push({ id: 'h-otd', scope: 'health', severity: sev, owner: 'Internal',
      title: 'On-time delivery ' + act_pct_(otd, 2) + ' (' + act_int_(on) + ' of ' + act_int_(od) + ' units)',
      evidence: ['Headroom to 90%: ' + act_int_(Math.max(0, head)) + ' units', 'Change vs previous reading: ' + (r.otd_change || 'n/a')],
      action: sev === 'ok' ? 'Nothing to do.' : 'Pull the OTDR report and classify the late units S1-S6 (warehouse, carrier, promise) before any partner gets a number.' });
  }

  // business hour delivery (carrier side)
  var bn = act_num_(r.bhdr_num), bd = act_num_(r.bhdr_den);
  if (bd > 0) {
    var bh = bn / bd, bHead = bn - (Math.floor(bd * ACTP_T.BHDR) + 1);
    var bsev = bh < ACTP_T.BHDR ? 'red' : (bHead <= 1 ? 'amber' : 'ok');
    var missRows = actp_parseMisses_(r.bhdr_misses);
    var f2 = { id: 'h-bhdr', scope: 'health', severity: bsev, owner: 'DHL',
      title: 'Business hour delivery ' + act_pct_(bh, 2) + ' (' + bn + ' of ' + bd + ' shipments), ' + (bHead >= 0 ? bHead + ' shipment(s) headroom' : 'below 90%'),
      evidence: [r.bhdr_by_method ? 'By ship method: ' + r.bhdr_by_method : '', r.bhdr_rolloff ? 'Roll-off: ' + r.bhdr_rolloff : '', missRows.length > 1 ? (missRows.length - 1) + ' misses listed' : ''].filter(String),
      action: bsev === 'ok' ? 'Nothing to do.' : 'Send the misses to DHL and check whether business addresses get the DHL Prime / business service.',
      suggestion: bsev === 'ok' ? '' : 'With 0-1 shipments of headroom, one more Saturday attempt to an office breaches. Consider excluding Saturday delivery for business addresses until the misses roll off.',
      fp: 'bhdr|' + act_weekKey_(r.read_at) };
    if (bsev !== 'ok' && missRows.length > 1) f2.mail = { group: 'DHL',
      section: 'Over the last 14 days ' + bn + ' of ' + bd + ' business shipments were attempted within the customer\'s opening hours. The ' + (missRows.length - 1) + ' that were not are attached with the reason Amazon gives (closed day or outside hours).',
      sheets: [{ name: 'Business delivery misses', rows: missRows }] };
    out.push(f2);
  }

  // Prime block freshness
  if (r.prime_block) {
    var pAge = act_ageDays_(r.prime_block, ctx.now) * 24;
    if (pAge > ACTP_T.PRIME_STALE_HOURS * 2) out.push({ id: 'h-prime-stale', scope: 'health', severity: 'amber', owner: 'Internal', alert: true,
      title: 'Prime check last written ' + r.prime_block, evidence: ['Expected weekdays 06:00 and 17:00'],
      action: 'Check the process that fills the Prime sheet; the Prime badge view is not current.' });
  }
  return out;
}

/** "6: 303-... Sat 12 Sep closed day; 304-... Fri 18 Sep outside hours; ..." -> rows */
function actp_parseMisses_(txt) {
  var rows = [['Order', 'Attempt day', 'Reason']];
  String(txt || '').replace(/^\s*\d+\s*:\s*/, '').split(';').forEach(function (p) {
    var m = p.trim().match(/^(\d{3}-\d{7}-\d{7})\s+(.*?)\s+(closed day|outside hours|.*)$/i);
    if (m) rows.push([m[1], m[2], m[3]]);
  });
  return rows;
}

/** WarehouseDE delivery notes late on the warehouse side within the last n days, from the 3PL Scorecard. */
function actp_warehouseDeLate_(ctx, n) {
  try {
    var late = act_tab_(ctx, cfg_('LOG_SHEET_ID'), 'Late notes');
    var cat = { miss1: 'Missed same day, labelled next working day', miss2: 'Missed same day, 2+ working days', lateafter: 'After cut-off, still later than next working day' };
    var rows = late.filter(function (r) {
      return r.Node === 'WarehouseDE (DE)' && cat[r.Category] && act_ageDays_(r['Release date'], ctx.now) <= n + 1;
    });
    return { count: rows.length, rows: [['Delivery note', 'Release date', 'Released', 'Labelled', 'Why it counts as late']].concat(rows.map(function (r) {
      return [r['Delivery note'], r['Release date'], r.Released, r.Labelled, cat[r.Category]]; })) };
  } catch (e) { return null; }
}

/** Note on the DE summary row of the EU sheet (where the holiday cause was recorded). */
function actp_euDe_(ctx) {
  try {
    var de = act_tab_(ctx, cfg_('EU_SHEET_ID'), 0).filter(function (r) { return String(r.marketplace).toUpperCase() === 'DE'; });
    de.sort(function (a, b) { return String(b.read_at).localeCompare(String(a.read_at)); });
    return de.length ? (de[0].note || '') : '';
  } catch (e) { return ''; }
}

// --------------------------------------------------------------- EU marketplaces

function actp_eu_(ctx) {
  var rows = act_need_(act_tab_(ctx, cfg_('EU_SHEET_ID'), 0), ['marketplace', 'read_at', 'status'], 'BrandX EU Account Health');
  var latest = {};
  rows.forEach(function (r) { var mk = String(r.marketplace).toUpperCase(); if (mk && mk !== 'DE' && (!latest[mk] || r.read_at > latest[mk].read_at)) latest[mk] = r; });
  var out = [];
  Object.keys(latest).sort().forEach(function (mk) {
    var r = latest[mk];
    var checks = [
      ['On-time delivery', 'otd', ACTP_T.OTD, 'min', 'carrier / promise'],
      ['Late dispatch 10d', 'ldr10', ACTP_T.LDR, 'max', 'warehouse'],
      ['Late dispatch 30d', 'ldr30', ACTP_T.LDR, 'max', 'warehouse'],
      ['Valid tracking', 'vtr', ACTP_T.VTR, 'min', 'warehouse'],
      ['Cancellation', 'cancel', ACTP_T.CANCEL, 'max', 'stock'],
      ['Business hour delivery', 'bhdr', ACTP_T.BHDR, 'min', 'carrier']
    ];
    var ev = [], bad = [], whBad = [];
    checks.forEach(function (c) {
      var rate = act_share_(r[c[1] + '_pct'], true);
      if (isNaN(rate)) return;
      var n = act_num_(r[c[1] + '_num']), d = act_num_(r[c[1] + '_den']);
      var breach = c[3] === 'min' ? rate < c[2] : rate > c[2];
      var cnt = d > 0 ? ' (' + n + ' of ' + d + (d < ACTP_T.SMALL_SAMPLE ? ', small sample' : '') + ')' : '';
      if (breach) { bad.push(c[0]); ev.push(c[0] + ' ' + act_pct_(rate, 2) + cnt + ', limit ' + act_pct_(c[2], 1)); if (c[4] === 'warehouse') whBad.push(c[0] + ' ' + act_pct_(rate, 2) + cnt); }
    });
    var tight = /tight/i.test(r.status);
    if (!bad.length && !tight) return;
    if (tight && r.breaches) ev.push(r.breaches);
    if (r.note) ev.push('Note: ' + r.note);
    var node = ACTP_EU_NODE[mk] || '';
    var f = { id: 'eu-' + mk, scope: 'eu', severity: bad.length ? 'red' : 'amber', owner: mk + (node ? ' / ' + node : ''),
      title: 'Amazon ' + mk + ': ' + (bad.length ? bad.join(', ') + ' outside the limit' : 'tight, ' + (r.breaches || 'little headroom')),
      evidence: ['Reading ' + r.read_at].concat(ev),
      action: whBad.length && node ? 'Ask ' + node + ' about the warehouse-side metrics (' + whBad.join('; ') + '). Handle delivery and promise metrics internally.' :
        'Pull the order list for ' + (bad.length ? bad.join(', ') : 'metrics with limited headroom') + ' in Seller Central (' + mk + ' selected) and decide carrier vs. promise vs. stock before contacting anyone.',
      suggestion: (act_num_(r.otd_den) < ACTP_T.SMALL_SAMPLE || act_num_(r.vtr_den) < ACTP_T.SMALL_SAMPLE) ? 'Volumes are small, so one or two orders move the rate a lot. If this market stays FBA-first, consider pausing seller-fulfilled offers here during peak rather than carrying the risk.' : '',
      fp: mk + '|' + act_weekKey_(r.read_at) + '|' + bad.join(',') };
    if (whBad.length && node) f.mail = { group: node,
      section: 'Amazon ' + mk + ', reading of ' + r.read_at.slice(0, 10) + ': ' + whBad.join('; ') + '. These depend on dispatch on time and a valid tracking number being uploaded. Could you check the ' + mk + ' seller-fulfilled orders of the last 30 days for anything shipped late or without tracking?',
      sheets: [{ name: 'Amazon ' + mk + ' reading', rows: [['Metric', 'Rate', 'Count', 'Out of', 'Limit']].concat(checks.filter(function (c) { return !isNaN(act_share_(r[c[1] + '_pct'], true)); }).map(function (c) {
        return [c[0], act_pct_(act_share_(r[c[1] + '_pct'], true), 2), r[c[1] + '_num'] || '', r[c[1] + '_den'] || '', (c[3] === 'min' ? 'min ' : 'max ') + act_pct_(c[2], 1)]; })) }] };
    out.push(f);
  });
  return out;
}

// --------------------------------------------------------------- Prime badge

var ACTP_PRODUCTS = ['Product A', 'Product B', 'Product C', 'Product D', 'Product E', 'Product F', 'Product G', 'Product H'];

function actp_prime_(ctx) {
  var checks = getChecks();
  if (!checks.length) return [];
  var cur = checks[0];
  var prev = checks.filter(function (c, i) { return i > 0 && c.phase === cur.phase; })[0];   // same cut-off phase, so 06:00 vs 17:00 noise is excluded
  var out = [];
  var hours = (ctx.now - new Date(cur.ts)) / 36e5;
  if (hours > ACTP_T.PRIME_STALE_HOURS) out.push({ id: 'p-stale', scope: 'prime', severity: 'amber', owner: 'Internal', alert: true,
    title: 'Latest Prime check is ' + Math.floor(hours) + ' hours old (' + cur.date + ' ' + cur.time + ')', evidence: ['Checks run weekdays 06:00 and 17:00'],
    action: 'Check that the latest Prime observation batch was added. Incomplete batches must not be published.' });
  if (!prev) return out;
  var lost = [], gained = [], incomplete = [];
  var previousByPostcode = {};
  prev.rows.forEach(function (r) { previousByPostcode[String(r.plz)] = r; });
  for (var p = 0; p < 8; p++) {
    if(cur.rows.every(function(r){return r.availability && r.availability[p] === "unavailable";})) continue;
    var a = 0, b = 0, compared = 0, missing = 0, lostAt = [];
    cur.rows.forEach(function (r) {
      var o = previousByPostcode[String(r.plz)];
      // Unknown observations must never become a confirmed missing badge.
      if (!o || !r.primeKnown || !o.primeKnown || !r.primeKnown[p] || !o.primeKnown[p]) { missing++; return; }
      compared++;
      a += r.prime[p]; b += o.prime[p];
      if (o.prime[p] === 1 && r.prime[p] === 0) lostAt.push(r.plz + ' ' + r.ort);
    });
    var name = ACTP_PRODUCTS ? ACTP_PRODUCTS[p] : 'Product ' + (p + 1);
    if (missing) incomplete.push(name + ': ' + compared + ' comparable postcode(s); ' + missing + ' missing or unmatched observation(s) excluded');
    if (a < b) lost.push(name + ': ' + b + ' -> ' + a + ' of ' + compared + ' comparable postcodes (lost ' + lostAt.join(', ') + ')');
    else if (a > b) gained.push(name + ': ' + b + ' -> ' + a + ' of ' + compared + ' comparable postcodes');
  }
  if (incomplete.length) out.push({ id: 'p-incomplete', scope: 'prime', severity: 'amber', owner: 'Internal',
    title: 'Prime comparison has missing product observations',
    evidence: [cur.date + ' ' + cur.time + ' vs ' + prev.date + ' ' + prev.time].concat(incomplete),
    action: 'Complete the blank Prime badge observations in the source check. Only explicit recorded badges are compared; blanks do not establish a lost badge.' });
  var buffers = cur.rows.filter(function (r) { return r.buffer >= 2; }).map(function (r) { return r.plz + ' ' + r.ort + ' (' + r.day + ')'; });
  if (lost.length) out.push({ id: 'p-lost', scope: 'prime', severity: 'red', owner: 'Internal',
    title: 'Prime badge lost on ' + lost.length + ' product(s) vs ' + prev.date + ' ' + prev.time + ' (' + (cur.phase === 'before' ? 'before' : 'after') + ' cut-off)', evidence: lost.concat(gained.length ? ['Gained: ' + gained.join('; ')] : []),
    action: 'Check stock at WarehouseDE for these products and the shipping template / handling time in Seller Central; a lost badge after a cut-off change usually means the promise got longer.',
    fp: 'prime|' + cur.ts });
  if (buffers.length) out.push({ id: 'p-buffer', scope: 'prime', severity: 'amber', owner: 'Internal',
    title: buffers.length + ' postcode(s) show a delivery day 2+ days later than the earliest', evidence: buffers,
    action: 'Compare these regions against DHL transit times; if DHL delivers faster, the template is padding the promise.' });
  if (!lost.length && !buffers.length && !incomplete.length) out.push({ id: 'p-ok', scope: 'prime', severity: 'ok', owner: 'Internal', title: 'No Prime badges lost since the previous check', evidence: [cur.date + ' ' + cur.time + ' vs ' + prev.date + ' ' + prev.time] });
  return out;
}
