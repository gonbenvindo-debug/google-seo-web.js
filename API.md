# Google Tools Manager — API local

Base: `http://127.0.0.1:3100`. Todos os POST usam `Content-Type: application/json`.
Se a opção local `API_KEY` estiver definida, envie `Authorization: Bearer <token>`.
O login Google é manual numa janela Chrome e fica guardado no perfil local.

## Endpoints comuns a todos os serviços

`GET /services` devolve o catálogo. Os serviços privados são `search-console`,
`google-ads`, `merchant-center`, `analytics` e `adsense`. As ferramentas públicas
são `pagespeed`, `rich-results`, `trends`, `search-docs` e `schema-validator`.

Substitua `{service}` pela chave do catálogo:

| Método | Rota | Função |
|---|---|---|
| GET | `/{service}/reports` | Catálogo de relatórios; não abre o Chrome |
| GET | `/{service}/state` | Texto, controlos e IDs atuais; abre o serviço se necessário |
| GET | `/{service}/navigation` | Links visíveis dentro do mesmo serviço |
| GET | `/{service}/report` | Abre um relatório e extrai texto, tabelas, métricas e gráficos |
| GET | `/{service}/report.csv` | Exporta uma tabela do relatório |
| GET | `/{service}/{report}` | Atalho para um relatório definido no catálogo; aceita `.csv` |
| POST | `/{service}/navigate` | Abre `{"target":"<caminho ou URL do serviço>"}` |
| POST | `/{service}/control` | Clica num rótulo ou escreve num campo observado |
| POST | `/{service}/filter` | Alias de `control` |

`state` aceita `maxText` (1000–100000, padrão 30000) e `maxElements` (1–1000, padrão 250).
PageSpeed usa uma rota especializada `GET /pagespeed/report?url=...`, descrita abaixo;
`GET /pagespeed/overview` permite a leitura comum da interface.

`report` aceita:

| Parâmetro | Padrão | Função |
|---|---|---|
| `report` | `overview` | Nome do catálogo; `current` mantém a página e filtros atuais |
| `path` | — | Caminho relativo ou URL HTTPS dentro do serviço |
| `property` | — | Propriedade Search Console, por exemplo `sc-domain:iberflag.com` |
| `tab` | — | Rótulo exato de um separador visível |
| `allPages` | false; true em CSV | Percorre paginadores visíveis |
| `maxPages` | 50 | Limite entre 1 e 500 |
| `table` | 0 | Índice da tabela para CSV |
| `allowPartial` | false | Autoriza CSV de linhas cuja completude não foi comprovada |

Analytics e AdSense disponibilizam inicialmente `overview` e `current`.
As páginas destas apps dependem da conta, da propriedade e de rotas com fragmentos
na URL. Descubra os destinos por `navigation` ou `state` e use `navigate` com a URL
observada, incluindo o fragmento. A autenticação Google não garante acesso a uma
propriedade, conta de anúncios ou relatório; a resposta inclui o texto real da página.

Os relatórios devolvem `service`, `url`, `title`, `account`, `source`, `headings`,
`controls` (com IDs), `metrics`, `tables`, `charts`, `links`, `rawText`,
`paginations`, `pagesRead` e `complete`. Search Console inclui `property` quando conhecida.

`complete=true` exige uma única tabela, recolhida desde a linha 1, com tantas
linhas como o total do paginador. `false` significa extração incompleta e devolve
HTTP 206. `null` significa que a interface não forneceu evidência suficiente.
CSV exige `true` ou `allowPartial=true`; caso contrário responde HTTP 409.
Linhas virtualizadas, colunas escondidas e dados indisponíveis não são inferidos.

### Controlos

`{"label":"Add filter"}` clica no controlo. `{"label":"Search","text":"example","submit":false}`
preenche o campo. `exact` é true por padrão; `submit=true` pressiona Enter.
O serviço indicado deve ser o serviço atualmente aberto. Rótulos ambíguos são
rejeitados; use um ID devolvido por `state` com `/browser/click` ou `/browser/type`.

As ações podem guardar alterações reais, incluindo campanhas, orçamentos e
configurações. A resposta é uma leitura da página após a ação; confirme o
resultado e quaisquer diálogos apresentados pela Google.

## Sessão e browser

| Método | Rota | Entrada / efeito |
|---|---|---|
| GET | `/health` ou `/auth/status` | Estado do browser e da sessão Google |
| POST | `/auth/login` ou `/browser/start` | `{"service":"analytics"}`; abre o login manual se necessário |
| POST | `/auth/logout` | Fecha o browser e apaga o perfil local |
| POST | `/browser/open` | `{"target":"analytics"}` ou uma URL HTTPS de um host permitido |
| GET | `/browser/state` | Mesmos limites de `state` |
| POST | `/browser/click` | `{"id":"e17"}` |
| POST | `/browser/type` | `{"id":"e17","text":"example","submit":false}`; campos password são rejeitados |
| POST | `/browser/back` | Volta atrás |
| POST | `/browser/reload` | Atualiza a página |
| GET | `/browser/screenshot` | PNG; `fullPage=true` opcional |
| POST | `/browser/stop` | Fecha o Chrome e preserva o perfil |

`/auth/login` reabre o perfil para permitir login manual mesmo se o browser já
estiver ativo numa ferramenta pública. `/browser/start` reutiliza o browser ativo.

Existe uma página partilhada. As operações que usam a página ficam numa fila,
incluindo leituras do estado, para não misturar ações de serviços diferentes.
Os contextos de conta observados em Ads e Merchant Center são preservados por
serviço. Leia um estado novo depois de navegar: os IDs são temporários.

As URLs são limitadas aos hosts do catálogo; `navigate` e `report?path=` são
também limitados ao serviço indicado. URLs com credenciais ou portas adicionais
são rejeitadas. Login, 2FA, captchas e consentimentos são concluídos manualmente.

## Search Console — operações específicas

Os relatórios definidos em `SearchConsoleReports` usam os endpoints comuns.
Continuam disponíveis performance, gráficos, indexação, links, mensagens,
inspeção de URL e submissão de sitemaps:

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

`GET /search-console/performance.csv` aceita as mesmas queries e exporta as linhas recolhidas; exige completude verificada ou allowPartial=true. `GET /search-console/graph` força `dimension=days` e devolve o gráfico, os rótulos e a série tabular diária.

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

Aceita `property`. Abre o sino, recolhe as mensagens e fecha o painel. Devolve `unread`, `total` e `items[]` com `title`, `date` e `category`.

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
Invoke-WebRequest 'http://127.0.0.1:3100/search-console/performance.csv?dimension=queries&allPages=true&allowPartial=true' `
  -OutFile queries.csv
```

## PageSpeed Insights

### `GET /pagespeed/report`

Executa a análise na interface PageSpeed pelo Puppeteer. Queries:

| Query | Valores |
|---|---|
| `url` | URL HTTP/HTTPS obrigatória |
| `strategy` | `mobile` ou `desktop`; predefinição `mobile` |

A resposta contém as pontuações e métricas renderizadas, auditorias observadas,
oportunidades, diagnósticos e texto da página. A fonte é `pagespeed-web-ui`.
Não exige chave Google e não devolve o payload completo da API Lighthouse.

```text
GET /pagespeed/report?url=https%3A%2F%2Fiberflag.com%2F&strategy=mobile
GET /pagespeed/report?url=https%3A%2F%2Fiberflag.com%2F&strategy=desktop
```

`GET /pagespeed/report.csv` aceita as mesmas queries e exporta os títulos das
auditorias observadas, não uma garantia de todos os resultados Lighthouse.


## Google Ads — Keyword Planner

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


## AdSense e H5 Games

A administração do AdSense usa os endpoints comuns e o mesmo perfil Chrome. Abra o painel com POST /auth/login e {"service":"adsense"}; consulte os relatórios e controlos visíveis. Para relatórios H5, use as opções de formato de anúncio disponíveis na interface da conta.

H5 Games usa o mesmo código AdSense, com a inicialização da Ad Placement API. Coloque isto no `<head>` da página que contém o canvas/jogo e substitua o publisher ID. A API deve estar no mesmo documento do jogo:

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456" crossorigin="anonymous"></script>
<script>
  window.adsbygoogle = window.adsbygoogle || [];
  var adBreak = adConfig = function (options) { adsbygoogle.push(options); };
</script>
```

No jogo, chame `adBreak({type: 'interstitial', name: 'between-levels', beforeAd: pauseGame, afterAd: resumeGame})` em transições naturais. Para recompensas, use `type: 'reward'`, apresente uma opção explícita ao jogador em `beforeReward(showAdFn)`, e conceda a recompensa em `adViewed`; feche a oferta sem recompensa em `adDismissed`. `adBreakDone` informa quando a tentativa terminou mesmo sem anúncio servido. Não invoque anúncios em cada interação ou durante jogo contínuo. A página H5 Games Ads da Google requer candidatura/aprovação; para jogos em WebView de aplicação, use os slots AdMob indicados pela Google.


Referências: [H5 Games Ads](https://adsense.google.com/start/h5-games-ads/), [Ad Placement API](https://developers.google.com/ad-placement/apis).
