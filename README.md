# Google Tools Manager

App local em Node.js e Puppeteer para gerir serviços Google com uma sessão
persistente do Chrome. Search Console, Google Ads, Merchant Center, Analytics
e AdSense partilham o login; PageSpeed, Trends e outras ferramentas usam o mesmo
browser. Não é necessário configurar OAuth, refresh tokens ou chaves Google.

## Iniciar

Requer Node.js 22.12+ e Google Chrome no Windows; nas restantes plataformas usa
o Chromium instalado pelo Puppeteer.

```bash
npm ci
npm start
```

Durante o desenvolvimento, `npm run dev` recarrega o servidor quando alteras o código.

A API fica disponível em `http://127.0.0.1:3100`. Para abrir o Analytics:

```bash
curl -X POST http://127.0.0.1:3100/auth/login \
  -H "Content-Type: application/json" \
  -d '{"service":"analytics"}'
```

Se o perfil ainda não tiver sessão, o Chrome abre para introduzires o login e 2FA
manualmente. Depois a app continua em segundo plano. A sessão fica guardada em
`.google-seo-auth/`; parar o browser conserva-a, fazer logout apaga-a.

## Um fluxo para todos os serviços

`GET /services` lista as chaves dos serviços. Para cada chave existem as mesmas
operações:

```text
GET  /analytics/reports
GET  /analytics/report
GET  /analytics/state
GET  /analytics/navigation
POST /analytics/navigate   {"target":"<URL observada no painel>"}
POST /analytics/control    {"label":"<controlo observado>"}
GET  /analytics/report?report=current
```

Troca `analytics` por `adsense`, `merchant-center`, `google-ads`, `search-console`,
`trends` ou qualquer outra chave do catálogo. `report` lê as tabelas, métricas,
gráficos acessíveis e texto da página; `state` permite localizar controlos e IDs.
`navigate` aceita apenas destinos do serviço indicado.

A mesma extração e paginação serve todas as apps. Há uma página partilhada e uma
fila de operações para evitar que uma leitura ou ação aconteça na app errada.
Os endpoints específicos do Search Console e do Keyword Planner continuam
disponíveis. Consulta [API.md](API.md) para os parâmetros e exemplos.

O Merchant Center tem também catálogo estruturado e CSV, diagnósticos, problemas
da conta, políticas, páginas de preços/qualidade e edição de produtos. A criação
e alteração de produtos ou políticas usa um passo de pré-visualização e outro de
confirmação explícita; consulta [API.md](API.md#merchant-center--produtos-problemas-e-políticas).

## Adicionar serviços e endpoints

O catálogo está em [src/Constants.js](src/Constants.js). Uma entrada com `name` e
`url` ganha automaticamente os endpoints `reports`, `report`, `state`,
`navigation`, `navigate` e `control`. Usa `login: true` para painéis privados.
O host é acrescentado automaticamente à lista permitida.

Relatórios nomeados são apenas entradas em `reports`. Por exemplo:

```js
'merchant-center': {
    name: 'Google Merchant Center',
    url: 'https://merchants.google.com/mc/',
    login: true,
    reports: { overview: 'overview', products: 'items' },
}
```

`products` cria os atalhos `GET /merchant-center/products` e
`GET /merchant-center/products.csv`. Não precisas de duplicar autenticação,
navegação, extração ou handlers HTTP. Para ações que envolvam vários passos,
reutiliza os métodos do `Client` e os controlos observados na página.

## Configuração local

`.env` é opcional e é carregado pelo Node.js no arranque:

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | 3100 | Porta HTTP, limitada a `127.0.0.1` |
| `API_KEY` | vazio | Token Bearer opcional para proteger os pedidos locais |

As antigas variáveis `GOOGLE_SEO_API_PORT` e `GOOGLE_SEO_API_KEY` continuam aceites.
`API_KEY` protege a tua app local; não é uma chave Google.

Os antigos proxies `/api/merchant/*`, `/api/google-ads/*`, `/api/adsense/*` e
`GoogleApiClient` foram removidos. PageSpeed também usa a interface web; os dados
de auditoria correspondem ao conteúdo renderizado, sem o payload completo da
API Lighthouse. H5 Games continua a exigir a integração AdSense na página do jogo,
documentada em [API.md](API.md).

## Usar como biblioteca

```js
const { Client } = require('google-tools-manager');

const client = new Client();
await client.initialize('analytics');
console.log(await client.getReport('analytics'));
console.log(await client.getNavigation('analytics'));
await client.destroy();
```

`LocalAuth({ clientId, dataPath })` permite selecionar outro perfil local.
Os métodos anteriores de Search Console, Ads e Merchant Center delegam no fluxo
comum e continuam disponíveis.

## Limites e segurança

O acesso depende das permissões da conta Google e da interface de cada produto.
Analytics e AdSense disponibilizam `overview` e `current`; use links e controlos
observados para selecionar contas, propriedades e relatórios.

A extração cobre conteúdo visível. `complete` distingue completude comprovada,
incompletude e ausência de evidência; CSV exige completude ou `allowPartial=true`.
Alterações na interface Google podem exigir ajustes nos rótulos ou caminhos.

Introduz credenciais apenas no Chrome. O perfil local contém a sessão Google:
não o partilhes nem o publiques. Lê um estado novo antes de clicar; os IDs são
temporários. Controlos de campanhas e configurações atuam sobre a conta real.

## Verificação

```bash
npm test
```

Os checks cobrem URLs e contexto de conta, handlers HTTP, validação de entrada,
CSV incompleto e extração/controlo no Puppeteer usando uma página simulada local.
Não alteram contas Google reais.

## Licença

MIT
