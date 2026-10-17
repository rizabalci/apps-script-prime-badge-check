/**
 * Config.gs (DE Prime Check). One place for every sheet ID and email address of this project.
 * Values are read from Script Properties (keys CFG_<NAME>). CONFIG_DEFAULTS is only the fallback,
 * so the project keeps working before setupConfig has run.
 *
 * Once, from the editor: run setupConfig. It copies the defaults into Script Properties.
 * After that you can change a value in Project Settings > Script Properties, and you can empty
 * CONFIG_DEFAULTS below so no ID or address stays in the code.
 */
var CONFIG_DEFAULTS = {
  PRIME_SHEET_ID: 'YOUR_SHEET_ID_4',    // PLZ_Produkte (Prime check blocks)
  PRIME_TAB: 'PLZ_Produkte',
  HEALTH_SHEET_ID: 'YOUR_SHEET_ID_3',     // SFP DE Account Health
  EU_SHEET_ID: 'YOUR_SHEET_ID_1',         // BrandX EU Account Health
  US_SHEET_ID: 'YOUR_SHEET_ID_5',         // US data, tab "glance"
  LOG_SHEET_ID: 'YOUR_SHEET_ID_2',      // Company 3PL Scorecard (tab "Open actions")
  OWNER: 'you@example.com',
  CC: 'manager@example.com',
  // match = regex on the group name. to = draft recipient (never sent, drafts only).
  // followCc = extra CC that is added on follow-up drafts (the CC above is also added on follow-ups).
  PARTNERS: JSON.stringify([
    { match: 'warehouseDe', to: 'ops@warehouse-de.example,contact1@warehouse-de.example', followCc: 'contact2@warehouse-de.example' },
    { match: 'warehouseUk|warehouse-uk|uk', to: 'ops@warehouse-uk.example', followCc: '' },
    { match: 'dhl', to: 'contact@carrier.example', followCc: '' },
    { match: 'warehouseUs|warehouse-us', to: 'contact1@warehouse-us.example,contact2@warehouse-us.example', followCc: '' },
    { match: 'legacyWh', to: '', followCc: '' }
  ])
};

function cfg_(key) {
  var v = null;
  try { v = PropertiesService.getScriptProperties().getProperty('CFG_' + key); } catch (e) { v = null; }
  if (v !== null && v !== '') return v;
  return CONFIG_DEFAULTS[key] == null ? '' : CONFIG_DEFAULTS[key];
}

function cfgOwner_() { return String(cfg_('OWNER')).toLowerCase(); }
function cfgCc_() { return cfg_('CC'); }
function cfgDraftsUrl_() { return 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(cfg_('OWNER')) + '#drafts'; }

function cfgPartners_() {
  try { return JSON.parse(cfg_('PARTNERS')) || []; } catch (e) { return []; }
}

/** Partner entry for a group name, or {} when nothing matches. */
function cfgPartner_(group) {
  var g = String(group).toLowerCase(), list = cfgPartners_();
  for (var i = 0; i < list.length; i++) {
    if (new RegExp(list[i].match, 'i').test(g)) return list[i];
  }
  return {};
}

/** Run once from the editor. Copies the defaults into Script Properties (keeps values already set). */
function setupConfig() {
  var p = PropertiesService.getScriptProperties();
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    if (!p.getProperty('CFG_' + k)) p.setProperty('CFG_' + k, String(CONFIG_DEFAULTS[k]));
  });
  console.log('Config saved to Script Properties: ' + Object.keys(CONFIG_DEFAULTS).join(', '));
}
