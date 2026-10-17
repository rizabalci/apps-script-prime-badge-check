# Prime Badge Check Dashboard (Apps Script)

A web dashboard that shows whether your products carry the Prime badge and which delivery day Amazon promises, per product and per postcode, check after check. It answers "are we Prime everywhere today, and is the promise getting worse?" without opening Amazon.

## What it does

- Reads check blocks from a Sheet (date, time, then one row per postcode with Prime badge and delivery day per product) and serves them as a trend dashboard (`Index.html`).
- `Health.html` and `EU.html`: account health views per marketplace, with stale-data banners when the morning reading is missing.
- `Watchdog.gs`: emails you when an expected check block is missing.
- `UsAlerts.gs`: daily US alert email from a separate sheet.
- `Actions.gs`, `Rules.gs`, `Alerts.gs`, `ActionsLog.gs`: the drafts-only action engine, which turns findings into an action plan and Gmail drafts.

## Configure

`Config.gs` holds every sheet ID, tab name and address. Set `ACTIVE_PRODUCTS` and `ACTIVE_SINCE` at the top of `Code.gs`, and the product list (labels and ASINs) in `Index.html` and `Code.gs`.

Install with `setupConfig`, `installWatchdogTriggers`, `installUsAlertTrigger`, `installActionTriggers` and `installAlertTrigger`, then deploy as a web app. `?view=eu` and `?view=health` open the other pages.

## Design rules

The page is read-only. Incomplete check blocks never count as fresh data. Partner emails are drafts, never sent.

## Setup

1. Create a Google Sheet and an Apps Script project (Extensions > Apps Script, or a standalone project).
2. Copy every `.gs` and `.html` file into the project, plus `appsscript.json` (show it under Project Settings > "Show appsscript.json").
3. Replace the `YOUR_...` placeholders, or set them as Script Properties (Project Settings > Script Properties). Secrets never go in the code.
4. Run the `install...` function named below once from the editor and approve the permission prompt.
5. For the web page: Deploy > New deployment > Web app, execute as you, access only yourself.

Times use `Europe/Berlin`. Change `TZ` in the config and `timeZone` in `appsscript.json` for your location.

## Part of a set

Built while running seller-fulfilled marketplace operations (Amazon SFP, bol, Otto, ManoMano) across several 3PL warehouses. Related templates: [marketplace health collector](https://github.com/rizabalci/apps-script-marketplace-health-collector), [Prime badge check](https://github.com/rizabalci/apps-script-prime-badge-check), [account health dashboard](https://github.com/rizabalci/apps-script-account-health-dashboard), [SFP weekly dashboard](https://github.com/rizabalci/apps-script-sfp-weekly-dashboard), [ops action engine](https://github.com/rizabalci/apps-script-ops-action-engine), and the Looker Studio reports in [the index repo](https://github.com/rizabalci/apps-script-marketplace-ops).

## License

MIT
