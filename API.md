# API HTTP

For the Google Ads integration, see [Google Ads (web session)](#google-ads-web-session). Merchant Center's browser integration is described in [Google Merchant Center (web session)](#google-merchant-center-web-session).

Base local: `http://127.0.0.1:3100`. Se `GOOGLE_SEO_API_KEY` estiver definida, todos os pedidos exigem `Authorization: Bearer <chave>`. Todos os `POST` usam `Content-Type: application/json`.

## REST APIs Google (OAuth opcional)

Estas rotas chamam diretamente as APIs oficiais e funcionam independentemente da sessão de Chromium. Configure `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` e `GOOGLE_OAUTH_REFRESH_TOKEN`; o refresh token deve ter as permissões `https://www.googleapis.com/auth/content` e `https://www.googleapis.com/auth/adwords`. O `.env` é ignorado pelo Git; use `.env.example` como modelo. Também é possível definir temporariamente `GOOGLE_ACCESS_TOKEN` para testes locais.

### Merchant API

Passe o caminho REST depois de `/api/merchant/`; método, query string e corpo JSON seguem o recurso da Google:

```text
GET    /api/merchant/accounts/v1/accounts
GET    /api/merchant/products/v1/accounts/{accountId}/products?pageSize=100
GET    /api/merchant/products/v1/accounts/{accountId}/products/{productId}
POST   /api/merchant/products/v1/accounts/{accountId}/productInputs:insert
PATCH  /api/merchant/products/v1/accounts/{accountId}/productInputs/{productInputId}?updateMask=title,description
DELETE /api/merchant/products/v1/accounts/{accountId}/productInputs/{productInputId}
GET    /api/merchant/datasources/v1/accounts/{accountId}/dataSources
POST   /api/merchant/datasources/v1/accounts/{accountId}/dataSources/{dataSourceId}:fetch
POST   /api/merchant/reports/v1/accounts/{accountId}/reports:search
GET    /api/merchant/promotions/v1/accounts/{accountId}/promotions
POST   /api/merchant/promotions/v1/accounts/{accountId}/promotions:insert
GET    /api/merchant/conversions/v1/accounts/{accountId}/conversionSources
GET    /api/merchant/quota/v1/accounts/{accountId}/quotas
```

Todos os métodos GET/POST/PATCH/DELETE são encaminhados para `merchantapi.googleapis.com`; os namespaces permitidos cobrem `accounts`, `products`, `reports`, `datasources`, `inventories`, `conversions`, `notifications`, `promotions`, `quota`, `ordertracking` e `productstudio`. O recurso e as permissões continuam sujeitos à API oficial e à conta autenticada. O corpo das operações mutáveis é JSON.

### Google Ads API

Google Ads requer `GOOGLE_ADS_DEVELOPER_TOKEN`. Configure ainda `GOOGLE_ADS_LOGIN_CUSTOMER_ID` se a conta anunciada estiver sob uma conta de gestor. O ID de cliente na URL usa apenas dígitos. A versão predefinida é `v24`, configurável através de `GOOGLE_ADS_API_VERSION`.

```http
GET /api/google-ads/customers:listAccessibleCustomers

POST /api/google-ads/{customerId}/googleAds:search
Content-Type: application/json

{"query":"SELECT campaign.id, campaign.name, campaign.status FROM campaign ORDER BY campaign.id"}
```

```http
POST /api/google-ads/{customerId}/googleAds:searchStream
POST /api/google-ads/{customerId}/campaigns:mutate
POST /api/google-ads/{customerId}/campaignBudgets:mutate
POST /api/google-ads/{customerId}/adGroups:mutate
POST /api/google-ads/{customerId}/adGroupAds:mutate
POST /api/google-ads/{customerId}/adGroupCriteria:mutate
POST /api/google-ads/{customerId}/campaignCriteria:mutate
POST /api/google-ads/{customerId}/assets:mutate
POST /api/google-ads/{customerId}/conversionActions:mutate
POST /api/google-ads/{customerId}/conversionUploads:uploadClickConversions
POST /api/google-ads/{customerId}/conversionUploads:uploadCallConversions
POST /api/google-ads/{customerId}/offlineUserDataJobs:create
POST /api/google-ads/{customerId}/offlineUserDataJobs/{jobId}:addOperations
POST /api/google-ads/{customerId}/offlineUserDataJobs/{jobId}:run
POST /api/google-ads/{customerId}:generateKeywordIdeas
```

`search` and `searchStream` accept the Google Ads REST request JSON; resource actions and supported customer-level actions are passed through to their corresponding official methods. This covers the generic mutate method for supported resources plus special operations such as conversion uploads and offline user data jobs. Google Ads actions can change campaigns, bids and spend. The server validates the customer ID and method path; errors retain Google's HTTP status and response payload. Direct API credentials are not supplied with this project.

Official references: [Merchant API REST resources](https://developers.google.com/merchant/api/reference/rest), [Google Ads API REST overview](https://developers.google.com/google-ads/api/rest/overview), [Google Ads API OAuth](https://developers.google.com/google-ads/api/docs/oauth/overview).

## Sessão e controlo de baixo nível

| Método | Rota | Entrada | Saída/efeito |
|---|---|---|---|
| `GET` | `/health` | — | Browser, serviço, URL, título e estado da sessão Google |
| `GET` | `/auth/status` | — | Alias de `/health` |
| `POST` | `/auth/login` | `{ "service"?: "search-console" }` | Reutiliza a sessão ou abre o login compacto |
| `POST` | `/auth/logout` | `{}` | Fecha o browser e apaga a sessão persistente |
| `GET` | `/services` | — | Serviços e destinos permitidos |
| `POST` | `/browser/start` | `{ "service"?: string }` | Inicia o browser |
| `POST` | `/browser/open` | `{ "target": string }` | Navega para serviço ou URL permitida |
| `GET` | `/browser/state` | `maxText`, `maxElements` | Texto e controlos visíveis com IDs efémeros |
| `POST` | `/browser/click` | `{ "id": "e17" }` | Clica num ID devolvido pelo estado atual |
| `POST` | `/browser/type` | `{ "id", "text", "submit"?: boolean }` | Substitui texto e pode pressionar Enter |
| `POST` | `/browser/back` | `{}` | Volta atrás |
| `POST` | `/browser/reload` | `{}` | Atualiza a página |
| `GET` | `/browser/screenshot` | `fullPage=true` | PNG |
| `POST` | `/browser/stop` | `{}` | Fecha o browser sem apagar a sessão |

## Modelo de relatório

Os relatórios semânticos devolvem:

- `property`, `url`, `title`, `updated`;
- `headings`, `metrics`, `controls` e `links`;
- `tables[]` com `headers` e `rows`;
- `charts[]` com descrição acessível e rótulos SVG;
- `pagination`, `pagesRead` e `rawText` para interpretação por LLM.

`allPages=true` percorre automaticamente todos os paginadores visíveis, elimina linhas repetidas e agrega cada tabela. `maxPages` limita a recolha entre 1 e 500.

## Navegação e relatórios

### `GET /search-console/reports`

Devolve os nomes e URLs de `overview`, `insights`, `performance`, `ai-performance`, `indexing`, `sitemaps`, `removals`, `core-web-vitals`, `https`, `product-snippets`, `merchant-listings`, `merchant-opportunities`, `breadcrumbs`, `manual-actions`, `security-issues`, `links`, `achievements` e `settings`. `/search-console/navigation` é um alias.

Query opcional: `property=sc-domain:example.com`.

### `GET /search-console/report`

Queries:

| Query | Função |
|---|---|
| `report` | Nome do catálogo; predefinição `overview` |
| `path` | Caminho interno do Search Console, para relatórios ainda não catalogados |
| `property` | Propriedade; usa a propriedade ativa se omitida |
| `tab` | Abre um separador pelo rótulo, por exemplo `PAGES` |
| `allPages` | `true` para recolher todas as páginas |
| `maxPages` | Limite de páginas, predefinição 50 |

Exemplo:

```text
GET /search-console/report?report=links&allPages=true
GET /search-console/report?path=index/drilldown%3Fpages%3DALL_URLS
```

### `GET /search-console/report.csv`

Aceita as queries do relatório, usa `allPages=true` por predefinição e acrescenta `table=0` para escolher a tabela. Responde com CSV UTF-8 com BOM.

## Performance, gráficos, filtros e datas

### `GET /search-console/performance`

Queries:

| Query | Valores |
|---|---|
| `dimension` | `queries`, `pages`, `countries`, `devices`, `appearance`, `days` |
| `period` | `24-hours`, `7-days`, `28-days`, `3-months`, `6-months`, `12-months`, `16-months`, `custom` |
| `startDate`, `endDate` | `YYYY-MM-DD`; obrigatórios para `custom` |
| `query`, `page` | Filtro textual da consulta ou URL |
| `queryOperator`, `pageOperator` | `contains`, `not-contains`, `exact` ou `regex` |
| `country`, `device`, `appearance` | Rótulo exato apresentado pelo Search Console |
| `allMetrics` | `true` por predefinição; inclui cliques, impressões, CTR e posição |
| `property` | Propriedade opcional |
| `allPages`, `maxPages` | Paginação integral |

```text
GET /search-console/performance?dimension=queries&period=3-months&allPages=true
GET /search-console/performance?dimension=pages&period=custom&startDate=2026-08-01&endDate=2026-08-31
GET /search-console/performance?dimension=queries&period=3-months&country=Portugal&query=fly&queryOperator=contains
```

`GET /search-console/performance.csv` aceita as mesmas queries e exporta a dimensão inteira. `GET /search-console/graph` força `dimension=days` e devolve o gráfico, os rótulos e a série tabular diária.

### `GET /search-console/time-gaps`

Aceita as queries de período e devolve `range`, `observedDays`, `gaps[]` e `complete`. Cada lacuna indica `after`, `before` e `missingDays`.

### `GET /search-console/summary`

Aceita `property` e `period` e reúne numa resposta compacta: métricas e principais consultas, motivos de indexação e validações, sitemaps, Core Web Vitals, ações manuais, problemas de segurança e notificações. É a rota indicada para uma verificação diária por LLM.

### `POST /search-console/control` e `/search-console/filter`

Opera qualquer controlo visível pelo rótulo acessível, sem depender de IDs efémeros:

```json
{ "label": "PAGES" }
```

```json
{ "label": "Filter table rows", "exact": true }
```

Para campos de texto: `{ "label": "...", "text": "valor", "submit": false }`. `exact=false` permite correspondência parcial. A resposta é o relatório estruturado após a ação.

## Notificações

### `GET /search-console/notifications`

Abre o sino, recolhe as mensagens e fecha o painel. Devolve `unread`, `total` e `items[]` com `title`, `date` e `category`.

### `GET /search-console/links`

Recolhe o resumo de links e expande automaticamente todos os painéis `MORE`, incluindo a paginação integral de cada drilldown. Aceita `property` e `maxPages`; responde com `complete=false` e HTTP 206 se algum painel ficar incompleto.

## Indexação e validações

### `GET /search-console/indexing`

Devolve cartões de páginas indexadas/não indexadas, gráfico, motivos, origem, estado de validação, tendência e contagens. Aceita `property`, `allPages` e `maxPages`.

`GET /search-console/validations` é um alias orientado aos casos de validação. Para abrir um motivo ou iniciar um controlo disponível, use `/search-console/control` depois de ler o relatório.

### `GET /search-console/indexing/pages`

Reúne numa única resposta todas as URLs indexadas e todos os motivos de não indexação. Percorre automaticamente cada relatório e respetiva paginação, compara as linhas recolhidas com os totais do Google e responde com `complete=false` e HTTP 206 se a extração estiver incompleta.

| Query | Valores |
|---|---|
| `status` | `all` (predefinição), `indexed` ou `not-indexed` |
| `reason` | Texto contido no motivo, por exemplo `discovered`, `crawled`, `404` ou `redirect` |
| `urlContains` | Texto contido na URL |
| `language` | `pt` ou `es`, inferido pelo prefixo `/es` |
| `crawled` | `true` para URLs com data de rastreio; `false` para URLs ainda sem rastreio |
| `property` | Propriedade opcional |
| `maxPages` | Limite de páginas por relatório, entre 1 e 500; predefinição `500` |

```text
GET /search-console/indexing/pages
GET /search-console/indexing/pages?status=not-indexed&reason=discovered&language=es&crawled=false
GET /search-console/indexing/pages?urlContains=%2Fguias%2F
```

Cada item de `pages[]` contém `url`, `status`, `reason` e `lastCrawled`. `summary` apresenta os totais globais e por motivo; `extraction` mostra, para cada grupo, quantas URLs eram esperadas e quantas foram recolhidas.

`GET /search-console/indexing/pages.csv` aceita os mesmos filtros e exporta as linhas completas. Por segurança, o CSV responde com erro se a extração não estiver completa.

## Inspeção de URL

### `GET /search-console/url-inspection?url=https%3A%2F%2Fexample.com%2F`

Inspeciona a versão armazenada sem iniciar uma ação externa. Pode receber `property`.

### `POST /search-console/url-inspection`

```json
{ "url": "https://example.com/", "action": "live" }
```

`action` pode ser `live` para iniciar o teste ao vivo ou `index` para pedir indexação. O pedido de indexação é uma mutação externa.

## Sitemaps

### `GET /search-console/sitemaps`

Lista URL, tipo, submissão, última leitura, estado, páginas e vídeos descobertos. Aceita `property`, `allPages` e `maxPages`.

### `POST /search-console/sitemaps`

```json
{ "sitemap": "https://example.com/sitemap.xml" }
```

Pode incluir `property`. Esta rota submete realmente o sitemap no Search Console.

## CSV

Os CSVs usam vírgulas, escapam aspas/quebras de linha e incluem BOM para abrir corretamente no Excel:

```powershell
Invoke-WebRequest 'http://127.0.0.1:3100/search-console/performance.csv?dimension=queries&allPages=true' `
  -OutFile queries.csv
```

## PageSpeed Insights

### `GET /pagespeed/report`

Usa a API PageSpeed Insights v5. Queries:

| Query | Valores |
|---|---|
| `url` | URL HTTP/HTTPS obrigatória |
| `strategy` | `mobile` ou `desktop`; predefinição `mobile` |
| `category` | Repetível ou separado por vírgulas: `performance`, `accessibility`, `best-practices`, `seo` |
| `locale` | Locale Lighthouse; predefinição `en` |
| `raw` | `true` para acrescentar a resposta integral da Google |

A resposta normal já contém pontuações, dados de campo disponíveis, ambiente, tempos, configuração, todas as auditorias, oportunidades e diagnósticos. Para chamadas frequentes, defina `PAGESPEED_API_KEY`. Se a quota da API oficial estiver esgotada, o controlador executa automaticamente a análise na interface PageSpeed e devolve `source: "web-ui-fallback"`, as pontuações, métricas, oportunidades, diagnósticos e o texto integral visível.

```text
GET /pagespeed/report?url=https%3A%2F%2Fiberflag.com%2F&strategy=mobile
GET /pagespeed/report?url=https%3A%2F%2Fiberflag.com%2F&strategy=desktop&category=performance,seo&raw=true
```

`GET /pagespeed/report.csv` aceita as mesmas queries e exporta todas as auditorias.

## Google Merchant Center (web session)

These endpoints use the same persistent Google Chrome profile as Search Console and Google Ads. Start the manual sign-in flow with `POST /auth/login` and `{ "service": "merchant-center" }`. They automate the Merchant Center web UI; they do **not** call Google's Merchant API and do not require an API token. UI routes, labels and available data can vary by account and Google rollout.

### Navigation and account context

| Method | Path | Input / result |
|---|---|---|
| GET | `/merchant-center/reports` | Names of built-in report/section shortcuts; no browser required |
| GET | `/merchant-center/state` | Current page text, headings, controls, account context and URL |
| GET | `/merchant-center/navigation` | Links visible in the signed-in account, restricted to `merchants.google.com` |
| POST | `/merchant-center/navigate` | `{ "target": "<Merchant Center path or URL>" }`; rejects other hosts |

The single browser page is shared with every Google integration. Read `/merchant-center/navigation` to discover current account-specific links and pass a returned URL to `/merchant-center/navigate`. The endpoint validates the destination host. If the login has expired or the current page is not Merchant Center, the API returns HTTP 409 and prompts a new login.

### Reports and CSV

`GET /merchant-center/report` accepts `report` (default `overview`), `path` (a relative path or full Merchant Center URL), `allPages` and `maxPages` (1–500). Named sections also have shortcuts:

| Name | Section |
|---|---|
| `overview` | Account overview |
| `products` | Product catalog and statuses |
| `diagnostics` | Product issues and diagnostics |
| `performance` | Analytics and product performance |
| `marketing` | Marketing methods |
| `campaigns` | Ad campaign management |
| `promotions` | Promotions |
| `data-sources` | Product data sources |
| `shipping-returns` | Shipping and returns settings |
| `notifications` | Account notifications |
| `settings` | Account settings |

Example routes: `GET /merchant-center/products?allPages=true`, `GET /merchant-center/report?path=<encoded-path>`, and `GET /merchant-center/products.csv?allowPartial=true`. CSV requires verified completeness unless `allowPartial=true`; JSON returns 206 when pagination proves the report incomplete. Rendered UI extraction may omit virtualized rows or hidden columns.

### Controls

`POST /merchant-center/control` and `/merchant-center/filter` accept the same body:

```json
{"label":"Products"}
```

```json
{"label":"Search products","text":"flag","submit":true,"exact":false}
```

Read `/merchant-center/state` first to use labels shown by the live interface. Clicking, submitting, saving or changing settings affects the real Merchant Center account; the endpoint does not silently save or confirm a change.

For direct API use, see [Merchant API REST resources](https://developers.google.com/merchant/api/reference/rest). That API uses OAuth scopes and its own supported resource methods. This package's web-session endpoints are a separate integration.

## Google Ads (web session)

Google Ads uses the same persistent Chrome profile as Search Console. No separate OAuth application or developer token is used. Sign in with `POST /auth/login` and body `{"service":"google-ads"}`. Ads authentication does not require a Search Console property. A Google login does not grant access to an Ads account or complete its setup.

### Accounts and navigation

| Method | Path | Input / result |
|---|---|---|
| GET | `/google-ads/accounts` | Opens Google's account picker; returns visible account labels, customer IDs where shown, control IDs and available URLs |
| POST | `/google-ads/account` | `{"url":"<account URL from the picker>"}`; navigates and returns the selected page |
| GET | `/google-ads/reports` | Built-in report names and URLs; does not start a browser |
| GET | `/google-ads/navigation` | Internal links from the current Ads page, including account-specific tools |
| GET | `/google-ads/state` | Current text, headings, controls and account URL context |

If the account picker provides a button without a URL, click its exact label with `/google-ads/control`, or use its ID with `/browser/click`. Do not construct an `euid` from a displayed customer ID: they are different identifiers. The selected URL's `euid`, `ocid` and `authuser` are preserved for subsequent report navigation. Explicit account parameters in an Ads URL replace, rather than merge with, the remembered context.

The app has one active page; Ads operations are serialized. `/google-ads/state`, `/google-ads/navigation`, controls and `report=current` require that page to be on Ads. After reading GSC, reopen Ads via `/auth/login` or request a named Ads report. Existing `/browser/*` endpoints also work on Ads. If the session expires, call `/browser/stop`, then `/auth/login` with `{"service":"google-ads"}` to reopen the manual login flow.

### Reports and CSV

`GET /google-ads/report` and `GET /google-ads/report.csv` accept:

| Query | Meaning |
|---|---|
| `report` | Name below, or `current` to preserve the current page and its filters; default `overview` |
| `path` | Overrides `report`: relative Ads path, `/aw/...` path, or full `https://ads.google.com/aw/...` URL |
| `allPages` | Follow visible Next page controls; default false for JSON, true for CSV |
| `maxPages` | Maximum pages to read, 1–500; default 50 |
| `table` | Zero-based CSV table index; default 0 |
| `allowPartial` | CSV only: true explicitly permits exporting unverified or partial rows |

Every report name also has `GET /google-ads/<name>` and `GET /google-ads/<name>.csv` shortcuts:

| Name | Contents available in the UI |
|---|---|
| `overview` | Account/campaign overview and visible metrics |
| `campaigns` | Campaigns, status, budgets and performance columns |
| `ad-groups` | Ad groups and their performance |
| `ads` | Ads, approval status and performance |
| `keywords` | Search keywords, match types and visible quality/performance columns |
| `search-terms` | Queries that triggered ads |
| `landing-pages` | Landing-page URLs and performance |
| `assets` | Asset associations and performance |
| `ad-assets` | Ad-level responsive search ad asset details; may require selecting an ad |
| `audiences` | Audience summary |
| `conversions` | Conversion goals and actions |
| `attribution` | Attribution overview |
| `change-history` | Changes recorded by Google Ads |
| `keyword-planner` | Planner home and saved plans available to the account |
| `data-manager` | Product links / data connections |
| `preferences` | Account preferences |
| `recommendations` | Recommendations |
| `budgets` | Campaign budgets |
| `devices` | Device performance |
| `geographic` | Geographic performance |
| `demographics` | Demographic performance |
| `placements` | Placement performance |
| `negative-keywords` | Negative keywords |
| `asset-groups` | Performance Max asset groups |
| `shopping-products` | Shopping product reporting |
| `conversion-goals` | Conversion actions and goals |
| `billing` | Billing summary |
| `campaign-diagnostics` | Campaign overview/diagnostics |

Responses include `url`, `account`, `headings`, `metrics`, `tables`, `charts`, `controls`, `links`, `rawText`, `paginations`, `pagesRead`, `source` and `complete`. Values retain the UI's units, currency, date range and formatting. Numeric metrics are not normalized, and dates/filters are not reset automatically. Use controls to select dates, locations, languages, networks, columns or segments, then read `report=current`.

If Google redirects a requested report to a different area (for example, an unavailable keywords report to the account overview), the endpoint returns HTTP 409. Check the account's permissions, campaign setup and current navigation. Default Ads navigation uses a 1440×1000 viewport and brings the table into view so Google renders its rows; a custom `puppeteer.defaultViewport` is respected.

`complete=true` is reported only when a single table was collected from row 1 and its row count matches the visible pagination total. `false` returns HTTP 206; `null` means the UI did not supply enough evidence. Virtualized rows, hidden columns, unavailable reports and Google's own data limits are not bypassed. CSV returns HTTP 409 unless completeness is verified or `allowPartial=true` is explicitly requested. An unavailable table returns an error, not an empty successful export.

```text
GET /google-ads/campaigns?allPages=true&maxPages=100
GET /google-ads/report?report=current
GET /google-ads/report.csv?report=current&table=0&allowPartial=true
```

To access other tools (for example recommendations, negative keywords, devices, locations, auction insights or billing), use links exposed by `/google-ads/navigation` or visible controls. These are UI operations, not dedicated typed CRUD APIs. Campaign creation, editing, pausing and deleting can be performed through the visible controls when the account permits them; there are no automatic campaign or budget changes in report reads.

### Keyword research and forecasts

`POST /google-ads/keyword-ideas`:

```json
{"keywords":["running shoes","trail shoes"],"website":"https://example.com/","allPages":true}
```

Use 1–10 seed `keywords`, a `website`, or both. Website-only mode accepts `entireSite` (default true); false selects only the supplied page. Each keyword must be a non-empty string of at most 200 characters.

`POST /google-ads/keyword-forecast`:

```json
{"keywords":["running shoes","trail shoes"],"allPages":true,"maxPages":50}
```

Forecast mode accepts 1–1000 keywords and opens Google's “Get search volume and forecasts” flow. It can create a keyword plan in Google Ads, but does not publish a campaign. Both helpers return the resulting visible tables/charts; switch tabs with `/google-ads/control` to read historical metrics or forecasts when Google displays them on separate tabs. Actual Google limits may be lower.

These helpers request the English interface and recognize selected English/Portuguese labels. They return HTTP 409 when required controls are unavailable; inspect `/google-ads/state` for changed labels, validation messages or setup requirements. Missing permissions, billing setup, consent prompts, captchas and verification must be completed manually. Helpers do not fabricate data or bypass these requirements. Keyword Planner values can be ranges rather than exact volumes.

### Controls and filters

`POST /google-ads/control` and `POST /google-ads/filter` accept the same body:

```json
{"label":"Add filter"}
```

```json
{"label":"Search","text":"running shoes","exact":true,"submit":false}
```

Without `text`, the control is clicked. With `text`, the field is filled; `submit=true` presses Enter. `exact` defaults to true. Ambiguous labels are rejected; use `/browser/state` and `/browser/click` or `/browser/type` with a specific control ID instead. Responses contain the page after the action, not a guarantee that a change was saved. Inspect the result and any confirmation dialog.

Saving campaign changes, applying recommendations, editing bids/budgets or enabling ads can affect spend. These are real account operations. Keep the API local and use `GOOGLE_SEO_API_KEY` to restrict access.

### Library

The package exports `GoogleAdsReports`. The existing `Client` provides `getGoogleAdsReports()`, `getGoogleAdsAccounts()`, `getGoogleAdsState()`, `getGoogleAdsReport(options)`, `planGoogleAdsKeywords(options)` and `controlGoogleAds(options)`.

### Verification and references

The integration is checked with controlled Chrome pages and local HTTP requests, including shared-session routing, table extraction, pagination and error handling. Live checks on 2026-09-17 verified persistent login, Ads account selection, reuse of the same session in Search Console, keyword ideas (319 rows across 32 pages), historical metrics, the forecast view and CSV output. Some campaign-related areas redirected to the overview in the tested account and were unavailable there. Google UI changes and account-specific layouts may still require selector updates.

Google references: [Google Ads REST API](https://developers.google.com/google-ads/api/rest/overview), [Keyword Planner](https://support.google.com/google-ads/answer/7337243?hl=en), [reporting and report links](https://support.google.com/google-ads/answer/16470459?hl=en), [ad groups](https://support.google.com/google-ads/answer/2375452?hl=en), [account history](https://support.google.com/google-ads/answer/2454137?hl=en), [conversion goals](https://support.google.com/google-ads/answer/10995103?hl=en).
