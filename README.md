# google-seo-web.js

Controlador local orientado a LLMs para Google Search Console, PageSpeed Insights e outras ferramentas de indexação e SEO. Usa uma sessão Chromium persistente, permite login manual diretamente na Google e expõe a página atual como texto e elementos interativos identificados.

Esta é a primeira fase do projeto: controlo e descoberta da interface real. Os endpoints semânticos de desempenho, indexação, sitemaps e validações serão adicionados depois de os fluxos terem sido observados numa propriedade autenticada. Sempre que a Google disponibilizar uma API oficial, essa API terá prioridade sobre automação visual.

## Segurança

- O servidor escuta apenas em `127.0.0.1`.
- A palavra-passe e os códigos 2FA são introduzidos pelo utilizador na janela oficial da Google e nunca passam pela API.
- A sessão fica em `.google-seo-auth/`. Essa pasta permite acesso à conta e nunca deve ser partilhada ou enviada para Git.
- Configure `GOOGLE_SEO_API_KEY` se outro processo local puder alcançar a API. Se colocar o servidor atrás de um proxy, a chave é obrigatória.
- Os endpoints de clique e escrita podem submeter formulários. Um agente deve ler `/browser/state` antes de agir e confirmar o efeito esperado.

## Instalação

Requer Node.js 22.12 ou superior.

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

Uma janela Chromium abre no Search Console. Faça o login e conclua 2FA ou desafios diretamente nessa janela. A sessão será reutilizada nos arranques seguintes.

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

## Próximos endpoints semânticos

Depois da descoberta autenticada, a camada específica será implementada nesta ordem:

1. `GET /search-console/properties`
2. `GET /search-console/performance` com consultas, páginas, países, dispositivos e datas
3. `GET /search-console/indexing` e detalhe das causas de exclusão
4. `GET /search-console/url-inspection?url=...`
5. `GET /search-console/sitemaps`
6. `POST /search-console/sitemaps` para submissão explícita
7. `GET /search-console/validations` para casos em análise e falhados
8. `GET /pagespeed/report?url=...&strategy=mobile|desktop`
9. Um resumo cruzado, próprio para LLM, entre indexação, desempenho e Core Web Vitals

Submeter sitemaps, iniciar validações e pedir indexação são operações com efeitos externos; terão endpoints separados das operações de leitura e respostas que indiquem exatamente o que foi enviado.

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

