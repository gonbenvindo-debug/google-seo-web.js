# google-seo-web.js

`google-seo-web.js` is a local Node.js API and browser controller for Google Search Console, Google Ads, PageSpeed Insights, and other Google SEO tools.

It keeps a persistent Chromium session, lets you complete Google login manually, and exposes JSON and CSV endpoints for reports, indexing, sitemaps, URL inspection, PageSpeed, and browser control.

## Requirements

- Node.js 22.12 or newer
- Google Chrome on Windows; Puppeteer's Chromium on other platforms

## Install and run

```bash
npm install
npm start
```

The API listens on `http://127.0.0.1:3100`.

Start the Google login flow:

```bash
curl -X POST http://127.0.0.1:3100/auth/login \
  -H "Content-Type: application/json" \
  -d '{}'
```

Complete login and 2FA in the browser window that opens. The session is stored locally and reused on the next run.

Read the current page:

```bash
curl http://127.0.0.1:3100/browser/state
```

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `GOOGLE_SEO_API_PORT` | `3100` | Local API port |
| `GOOGLE_SEO_API_KEY` | empty | Protects the API with a Bearer token |
| `PAGESPEED_API_KEY` | empty | Optional PageSpeed Insights API key |

When `GOOGLE_SEO_API_KEY` is set, send:

```http
Authorization: Bearer YOUR_API_KEY
```

The server binds to `127.0.0.1` only. All `POST` requests require `Content-Type: application/json`, including requests with an empty body (`{}`).

## Endpoints

Base URL: `http://127.0.0.1:3100`

### Session and browser control

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Browser and Google session status |
| GET | `/auth/status` | Alias of `/health` |
| GET | `/services` | List allowed services and URLs |
| POST | `/auth/login` | Open or reuse a Google login session |
| POST | `/auth/logout` | Close the browser and delete the saved session |
| POST | `/browser/start` | Start the browser for a service |
| POST | `/browser/open` | Open an allowed service or HTTPS URL |
| GET | `/browser/state` | Read page text, headings, links, controls, and charts |
| POST | `/browser/click` | Click a control by its ID from `/browser/state` |
| POST | `/browser/type` | Type into a control by its ID |
| POST | `/browser/back` | Go back one page |
| POST | `/browser/reload` | Reload the current page |
| GET | `/browser/screenshot` | Return a PNG screenshot |
| POST | `/browser/stop` | Stop the browser and keep the saved session |

### Search Console

| Method | Endpoint | Description |
|---|---|---|
| GET | `/search-console/reports` | List available Search Console reports |
| GET | `/search-console/navigation` | Alias of `/search-console/reports` |
| GET | `/search-console/report` | Read any report by name or internal path |
| GET | `/search-console/report.csv` | Export a report table as CSV |
| GET | `/search-console/performance` | Read performance data by dimension |
| GET | `/search-console/performance.csv` | Export performance data as CSV |
| GET | `/search-console/graph` | Read daily performance data and chart information |
| GET | `/search-console/time-gaps` | Find missing days in a performance range |
| GET | `/search-console/summary` | Get a compact multi-area SEO summary |
| GET | `/search-console/notifications` | Read Search Console notifications |
| GET | `/search-console/links` | Read the links report and drilldowns |
| GET | `/search-console/url-inspection` | Inspect a URL without starting an external action |
| POST | `/search-console/url-inspection` | Run a live test or request indexing |
| GET | `/search-console/sitemaps` | List submitted sitemaps |
| POST | `/search-console/sitemaps` | Submit a sitemap |
| GET | `/search-console/indexing` | Read indexing status and reasons |
| GET | `/search-console/validations` | Alias for the indexing report |
| GET | `/search-console/indexing/pages` | List indexed and non-indexed URLs |
| GET | `/search-console/indexing/pages.csv` | Export indexed pages as CSV |
| POST | `/search-console/control` | Operate a visible control by its label |
| POST | `/search-console/filter` | Alias for semantic Search Console control |

Useful Search Console query parameters include `property`, `report`, `path`, `dimension`, `period`, `startDate`, `endDate`, `allPages`, `maxPages`, `status`, `reason`, `urlContains`, `language`, and `crawled`.

Examples:

```text
GET /search-console/performance?dimension=queries&period=28-days
GET /search-console/report?report=links&allPages=true
GET /search-console/url-inspection?url=https%3A%2F%2Fexample.com%2F
```

Actions that change Google data require `POST`:

```json
POST /search-console/url-inspection
{"url":"https://example.com/","action":"live"}
```

```json
POST /search-console/sitemaps
{"sitemap":"https://example.com/sitemap.xml"}
```

`action: "index"` requests indexing. These actions affect external Google data.

### Google Ads

Reuse the same Google session by calling `POST /auth/login` with `{"service":"google-ads"}`. An existing Ads account with access to the requested tools is required. This integration uses the web interface, not the Google Ads API.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/google-ads/accounts` | Open the account picker and read visible accounts |
| POST | `/google-ads/account` | Select an account using its returned `url` |
| GET | `/google-ads/reports` | List report names and URLs |
| GET | `/google-ads/navigation` | Read links on the current Ads page |
| GET | `/google-ads/state` | Read current page and control IDs |
| GET | `/google-ads/report` | Read a named report, an Ads `path`, or `report=current` |
| GET | `/google-ads/report.csv` | Export a report table |
| GET | `/google-ads/{report}` | Shortcut for any report below; also supports `.csv` |
| POST | `/google-ads/keyword-ideas` | Discover keywords from `keywords` and/or `website` |
| POST | `/google-ads/keyword-forecast` | Submit `keywords` for volume and forecasts |
| POST | `/google-ads/control` | Click a `label` or fill it with `text`; optional `submit` |
| POST | `/google-ads/filter` | Same control operation, for visible filter fields |

Reports: `overview`, `campaigns`, `ad-groups`, `ads`, `keywords`, `search-terms`, `landing-pages`, `assets`, `ad-assets`, `audiences`, `conversions`, `attribution`, `change-history`, `keyword-planner`, `data-manager`, `preferences`.

```bash
curl -X POST http://127.0.0.1:3100/auth/login -H "Content-Type: application/json" -d '{"service":"google-ads"}'
curl 'http://127.0.0.1:3100/google-ads/search-terms?allPages=true'
curl -X POST http://127.0.0.1:3100/google-ads/keyword-ideas -H "Content-Type: application/json" -d '{"keywords":["running shoes","trail shoes"]}'
```

Reports contain visible tables, metrics, charts, controls and links. `allPages=true` follows pagination up to `maxPages` (default 50, maximum 500). `complete=false` means partial data; `null` means completeness could not be verified. CSV requires verified completeness unless `allowPartial=true` is supplied.

Google's UI, account permissions and setup affect availability. Keyword Planner helpers target English/Portuguese labels; use `/google-ads/state` and `/google-ads/control` if labels differ. Controls can save changes and affect advertising spend. See [Google Ads endpoints](API.md#google-ads-web-session) for account selection, parameters and limitations. Validated with controlled Chrome pages; verification with a real Ads account is still pending.

### PageSpeed Insights

| Method | Endpoint | Description |
|---|---|---|
| GET | `/pagespeed/report` | Get Lighthouse, Core Web Vitals, audits, and opportunities |
| GET | `/pagespeed/report.csv` | Export PageSpeed audits as CSV |

Required query parameter: `url`.

Optional parameters: `strategy=mobile|desktop`, repeated or comma-separated `category` values, `locale`, and `raw=true`.

Example:

```text
GET /pagespeed/report?url=https%3A%2F%2Fexample.com%2F&strategy=mobile
```

## Library usage

```js
const { Client, LocalAuth } = require('google-seo-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'my-project' }),
});

await client.initialize('search-console');
console.log(await client.getState());
```

## Security

- Credentials and 2FA are entered only in the Google browser window; they are never sent through this API.
- The persistent session is stored in `.google-seo-auth/`. Do not share or commit it.
- Use `GOOGLE_SEO_API_KEY` if another local process can reach the API.
- Read `/browser/state` before using browser controls. Element IDs are temporary and change after navigation or reload.

## License

MIT
