# API HTTP

Base local: `http://127.0.0.1:3100`. Se `GOOGLE_SEO_API_KEY` estiver definida, todos os pedidos exigem `Authorization: Bearer <chave>`. Todos os `POST` usam `Content-Type: application/json`.

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
