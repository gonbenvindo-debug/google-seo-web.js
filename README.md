# google-seo-web.js

Controlador local orientado a LLMs para Google Search Console, PageSpeed Insights e outras ferramentas de indexação e SEO. Usa uma sessão Chromium persistente, permite login manual diretamente na Google e disponibiliza tanto controlo visual como endpoints semânticos para relatórios, tabelas completas, gráficos, notificações, CSV, indexação, sitemaps e inspeção de URLs.

O contrato HTTP completo, parâmetros e exemplos estão em [API.md](API.md).

## Segurança

- O servidor escuta apenas em `127.0.0.1`.
- A palavra-passe e os códigos 2FA são introduzidos pelo utilizador na janela oficial da Google e nunca passam pela API.
- A sessão fica em `.google-seo-auth/`. Essa pasta permite acesso à conta e nunca deve ser partilhada ou enviada para Git.
- Configure `GOOGLE_SEO_API_KEY` se outro processo local puder alcançar a API. Se colocar o servidor atrás de um proxy, a chave é obrigatória.
- Os endpoints de clique e escrita podem submeter formulários. Um agente deve ler `/browser/state` antes de agir e confirmar o efeito esperado.

## Instalação

Requer Node.js 22.12 ou superior. No Windows, o login manual usa uma instalação normal do Google Chrome; o Chrome for Testing incluído pelo Puppeteer não é usado para autenticação Google.

```powershell
npm install
npm start
```

O servidor fica disponível em `http://127.0.0.1:3100`.

Configuração opcional:

| Variável | Predefinição | Função |
|---|---:|---|
| `GOOGLE_SEO_API_PORT` | `3100` | Porta HTTP local |
| `GOOGLE_SEO_API_KEY` | vazio | Protege todos os endpoints com Bearer token |
| `PAGESPEED_API_KEY` | vazio | Chave opcional recomendada para uso frequente da API PageSpeed |

Quando existir uma chave:

```powershell
$headers = @{ Authorization = 'Bearer A_SUA_CHAVE' }
Invoke-RestMethod http://127.0.0.1:3100/health -Headers $headers
```

## Início rápido

### 1. Abrir o Search Console e fazer login

```powershell
Invoke-RestMethod http://127.0.0.1:3100/auth/login `
  -Method Post -ContentType 'application/json' -Body '{}'
```

Quando ainda não existe uma sessão, abre uma janela compacta do Google Chrome. Faça o login e conclua 2FA ou desafios diretamente nessa janela. Após a confirmação, a janela fecha automaticamente e o controlador continua em modo invisível. Nos arranques seguintes, a sessão é reutilizada sem mostrar a janela.

### 2. Ler a página para um LLM

```powershell
Invoke-RestMethod http://127.0.0.1:3100/browser/state
```

Resposta abreviada:

```json
{
  "running": true,
  "service": "search-console",
  "url": "https://search.google.com/search-console/...",
  "title": "Google Search Console",
  "googleSession": "present",
  "bodyText": "Vista geral ...",
  "headings": ["Vista geral"],
  "elements": [
    {
      "id": "e17",
      "tag": "button",
      "role": "button",
      "label": "Mapas do site",
      "disabled": false
    }
  ],
  "visuals": []
}
```

Os IDs `e...` são efémeros. Depois de uma navegação ou atualização da interface, peça `/browser/state` novamente.

### 3. Clicar e escrever

```powershell
Invoke-RestMethod http://127.0.0.1:3100/browser/click `
  -Method Post -ContentType 'application/json' `
  -Body '{"id":"e17"}'

Invoke-RestMethod http://127.0.0.1:3100/browser/type `
  -Method Post -ContentType 'application/json' `
  -Body '{"id":"e21","text":"https://iberflag.com/sitemap.xml","submit":false}'
```

Use `"submit": true` apenas quando pretende pressionar Enter depois da escrita.

## Endpoints atuais

| Método | Endpoint | Corpo/query | Resultado |
|---|---|---|---|
| `GET` | `/health` | — | Estado do browser e da sessão Google |
| `GET` | `/auth/status` | — | Alias legível do estado atual |
| `POST` | `/auth/login` | `{ "service"?: string }` | Abre o Chromium persistente |
| `POST` | `/auth/logout` | `{}` | Fecha o browser e elimina a sessão local guardada |
| `GET` | `/services` | — | Serviços e URLs conhecidos |
| `POST` | `/browser/start` | `{ "service"?: string }` | Inicia o browser |
| `POST` | `/browser/open` | `{ "target": string }` | Abre um serviço ou URL permitida |
| `GET` | `/browser/state` | `maxText`, `maxElements` | Texto, títulos, elementos e gráficos identificados |
| `POST` | `/browser/click` | `{ "id": "e17" }` | Clica num elemento do último estado |
| `POST` | `/browser/type` | `{ "id", "text", "submit"? }` | Substitui o conteúdo de um campo |
| `POST` | `/browser/back` | `{}` | Volta à página anterior |
| `POST` | `/browser/reload` | `{}` | Atualiza a página atual |
| `GET` | `/browser/screenshot` | `fullPage=true` opcional | PNG da página |
| `POST` | `/browser/stop` | `{}` | Fecha o browser e preserva a sessão |

Endpoints semânticos principais:

| Método | Endpoint | Resultado |
|---|---|---|
| `GET` | `/search-console/reports` | Catálogo das áreas úteis da sidebar e URLs da propriedade |
| `GET` | `/search-console/report` | Qualquer relatório por nome ou caminho interno |
| `GET` | `/search-console/report.csv` | Tabela completa de qualquer relatório em CSV |
| `GET` | `/search-console/performance` | Consultas, páginas, países, dispositivos, aparência ou dias |
| `GET` | `/search-console/performance.csv` | Dimensão de Performance completa em CSV |
| `GET` | `/search-console/graph` | Gráfico e série diária de Performance |
| `GET` | `/search-console/time-gaps` | Dias em falta no intervalo selecionado |
| `GET` | `/search-console/summary` | Resumo diário cruzado, pronto para LLM |
| `GET` | `/search-console/notifications` | Mensagens do sino, incluindo total e não lidas |
| `GET` | `/search-console/indexing` | Estado, motivos, validações e contagens de indexação |
| `GET` | `/search-console/validations` | Alias orientado aos casos de validação |
| `GET/POST` | `/search-console/url-inspection` | Inspeciona; opcionalmente testa ao vivo ou pede indexação |
| `GET/POST` | `/search-console/sitemaps` | Lista ou submete um sitemap |
| `POST` | `/search-console/control` | Clica ou escreve usando o rótulo estável do controlo |
| `POST` | `/search-console/filter` | Alias semântico para operar filtros da interface |
| `GET` | `/pagespeed/report` | Lighthouse, Core Web Vitals, auditorias e oportunidades |
| `GET` | `/pagespeed/report.csv` | Todas as auditorias PageSpeed em CSV |

Todos os pedidos `POST` exigem `Content-Type: application/json`, mesmo quando o corpo é `{}`. O limite é 100 kB.

## Serviços permitidos

- `search-console`
- `pagespeed`
- `rich-results`
- `merchant-center`
- `search-docs`
- `schema-validator`
- `trends`

Também podem ser usadas URLs HTTPS profundas destes serviços. Hosts externos, `file://` e URLs com credenciais são recusados.

```powershell
Invoke-RestMethod http://127.0.0.1:3100/browser/open `
  -Method Post -ContentType 'application/json' `
  -Body '{"target":"pagespeed"}'
```

As rotas `POST /search-console/sitemaps` e `POST /search-console/url-inspection` com `action=index` alteram estado externo. Os endpoints `GET` não submetem sitemaps, não iniciam testes e não pedem indexação.

## Uso como biblioteca

```js
const { Client, LocalAuth } = require('google-seo-web.js');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'iberflag' }),
});

await client.initialize('search-console');
console.log(await client.getState());
```

## Testes

```powershell
npm test
```

Os testes atuais cobrem a lista segura de serviços e o contrato HTTP. Não tentam iniciar sessão numa conta Google nem executar ações no Search Console.
