# Decisão de Autenticação — Frontend FactoryFlow

> Documento técnico de decisão de segurança. Registra a remediação de um risco crítico encontrado após a publicação do frontend no Cloudflare Pages (`https://factoryflow-pagina.pages.dev/`). Não altera cálculo de tempos, fluxo de produção, Kanban, banco de dados ou layout.
>
> **Atualização (2ª passada):** a 1ª passada removeu o valor literal do token fixo do código-fonte, mas ainda deixava, em várias funções de resolução de token, um caminho de fallback que lia `FACTORYFLOW_API_TOKEN`/`window.FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`API_KEY` e enviava `X-API-Key`. A 2ª passada removeu **todo** esse caminho do frontend público: hoje o frontend não lê, não referencia e não envia mais nenhum desses identificadores — apenas `Authorization: Bearer <jwt>`.

---

## 1. O problema

O frontend é um site estático publicado publicamente. Qualquer string literal no código JS é visível a qualquer visitante via DevTools/"Ver código-fonte" — não existe "segredo escondido" em frontend estático.

Antes desta correção, **6 arquivos** do frontend continham o token fixo `FACTORYFLOW_API_TOKEN` (`INDUSCOLORSECURE9xA82kLmP2026`) escrito diretamente no código-fonte, usado como fallback para os headers `Authorization: Bearer` e `X-API-Key` quando não havia JWT de sessão disponível:

- `frontend/js/data.js`
- `frontend/js/relatorio-tempos.js`
- `frontend/js/dashboard.js`
- `frontend/js/deliveries.js`
- `frontend/js/pedidos-novos.js`
- `frontend/driver.html`

Isso significava que qualquer pessoa com acesso ao site público podia copiar o token do código-fonte e chamar a API do backend FactoryFlow diretamente, sem precisar de login, com o mesmo nível de acesso que as rotas automatizadas/server-to-server.

## 2. Decisão final

1. **O frontend público autentica exclusivamente com o JWT emitido no login** (backend do PaintLab), guardado em `sessionStorage`/`localStorage` na chave `ff_token` (ou variações legadas de nome de chave) e enviado como `Authorization: Bearer <jwt>`.
2. **O frontend não envia mais o header `X-API-Key` em nenhuma chamada.** Esse header foi removido de todas as funções de montagem de headers do frontend.
3. **O frontend não lê, não referencia e não depende mais de `FACTORYFLOW_API_TOKEN`, `window.FACTORYFLOW_API_TOKEN`, `API_TOKEN` ou `API_KEY`.** Não existe mais nenhum ponto no código do frontend que tente usar esses identificadores como credencial — nem como literal, nem como variável global opcional, nem como item de `localStorage`/`sessionStorage`. A única credencial possível enviada pelo navegador é o JWT.
4. **`FACTORYFLOW_API_TOKEN` continua existindo apenas no backend** (`backend/server.js`, variável `API_TOKEN` e função `requireApiToken`), para uso server-to-server/automação/manual (integrações, scripts internos, testes via Postman/curl). O backend continua aceitando as duas formas de autenticação em paralelo — token fixo OU JWT — isso **não foi alterado nesta etapa**, conforme solicitado.
5. **CORS não é controle de autenticação.** CORS apenas restringe quais origens de navegador podem ler a resposta de uma requisição cross-origin; não impede que alguém com um token válido (ou sem ele) chame a API diretamente via curl/Postman/script. A autenticação real é feita pelo JWT/token verificado em `requireApiToken`, não pelas regras de CORS.
6. **Sem JWT salvo, a chamada falha de forma controlada:** nenhum header `Authorization` é enviado, o backend responde `401` (rota protegida por `requireApiToken`), e o código de chamada no frontend já trata esse erro (`try/catch`, fallback para dados locais já carregados, ou mensagem de erro) sem travar a tela nem alterar o fluxo existente.

## 3. Como o frontend autentica agora

Fluxo, sem excepções:

1. Usuário faz login pelo backend do PaintLab (`AUTH_API_BASE`/`DRIVER_AUTH_API` = `https://paintlab-backend-production.up.railway.app`).
2. O backend do PaintLab emite um JWT HS256 (segredo compartilhado entre PaintLab, FactoryFlow e CQVision).
3. O frontend guarda esse JWT em `sessionStorage`/`localStorage` na chave `ff_token`.
4. Toda chamada ao backend FactoryFlow (Railway) envia `Authorization: Bearer <ff_token>`.
5. O backend FactoryFlow valida o JWT (`verifyJwtHs256`) e libera o acesso (`req.authType = 'jwt'`).

Se não houver JWT salvo (usuário deslogado), as chamadas simplesmente não enviam header de autenticação e o backend responde `401` — não há mais fallback de segredo fixo cobrindo esse caso.

## 4. Arquivos alterados

### 1ª passada (remoção do literal do token fixo)

| Arquivo | O que mudou |
|---|---|
| `frontend/js/data.js` | Removida a constante `FACTORYFLOW_FALLBACK_API_TOKEN` (segredo fixo). |
| `frontend/js/relatorio-tempos.js` | Removida a variável local `fallbackApiKey` (segredo fixo). |
| `frontend/js/dashboard.js` | Removido o literal de fallback em `ffDashResolveToken`. |
| `frontend/js/deliveries.js` | Removido o literal de fallback em `ffDeliveriesResolveToken`. |
| `frontend/js/pedidos-novos.js` | Removida a declaração `const FACTORYFLOW_API_TOKEN = '...'`. |
| `frontend/driver.html` | Removida a declaração `const FACTORYFLOW_API_TOKEN = '...'`. |
| `frontend/js/lots.js` | Ajustado `carregarMotoristasFactoryFlow`, que referenciava a global removida sem guarda `typeof`. |

### 2ª passada (remoção completa de qualquer caminho de token fixo/`X-API-Key`)

| Arquivo | O que mudou |
|---|---|
| `frontend/js/data.js` | `resolveFactoryFlowApiToken` não lê mais `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`window.*` — só chaves de `sessionStorage`/`localStorage` ligadas ao JWT. `factoryFlowAuthHeaders`, `apiUpdateLot` (PATCH de lote) e `bridgeAuthHeaders` não enviam mais `X-API-Key`. |
| `frontend/js/app.js` | `ffResolveApiToken` não lê mais `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`window.*`. `ffAuthHeaders` não envia mais `X-API-Key`. |
| `frontend/js/dashboard.js` | `ffDashResolveToken` não lê mais `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`window.FACTORYFLOW_API_TOKEN`. `ffDashApiGet` não envia mais `X-API-Key`. |
| `frontend/js/deliveries.js` | `ffDeliveriesResolveToken` não lê mais `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`window.*`. `ffDeliveriesHeaders` não envia mais `X-API-Key`. |
| `frontend/js/lots.js` | `ffLotsRouteResolveToken` não lê mais `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`window.*`. `ffLotsRouteHeaders` e `carregarMotoristasFactoryFlow` não enviam mais `X-API-Key`. |
| `frontend/js/programacao-entregas.js` | `_peGetAuthHeaders` não lê mais `window.FACTORYFLOW_API_KEY`/`localStorage('FACTORYFLOW_API_KEY')`/`localStorage('ff_api_key')` e não envia mais `X-API-Key`. Função já usava JWT como base; ficou só com o JWT. |
| `frontend/js/expediente-alerts.js` | Removida a leitura de `API_KEY`/envio de `X-API-Key` em `ffConfirmarEncerrarExpedienteGeral`; o JWT agora é resolvido a partir de `user.token` ou de `sessionStorage`/`localStorage` (`ff_token`), igual ao restante do app. |
| `frontend/js/relatorio-tempos.js` | Removido por completo o bloco `apiKey` (que lia `FACTORYFLOW_API_TOKEN`/`API_TOKEN`/`API_KEY`/`window.*`) em `_rtFetchBackend`; `X-API-Key` não é mais enviado. Só `Authorization: Bearer <jwt>`, e só quando há JWT salvo. |
| `frontend/js/pedidos-novos.js` | Já não tinha dependência de token fixo desde a 1ª passada; confirmado sem alterações adicionais. |
| `frontend/driver.html` | Já não tinha dependência de token fixo desde a 1ª passada; confirmado sem alterações adicionais. |

Nenhuma mudança em: cálculo de tempos (`relatorio-tempos.js` mantém intacta toda a lógica de busca/filtro/cálculo, só os headers HTTP foram tocados), fluxo de produção/Kanban, schema ou dados do banco, ou layout/HTML visível. O backend (`backend/server.js`) não foi alterado nesta etapa.

## 5. Segredos removidos do frontend

O valor antigo de `FACTORYFLOW_API_TOKEN` (que estava hardcoded em 6 arquivos) foi removido do código-fonte do frontend. O valor real não é reproduzido neste documento por segurança — ele já estava público desde a publicação do site no Cloudflare Pages e **deve ser rotacionado** (seção 7).

## 6. Endpoints testados / a testar

Confirmado por leitura do código do backend:

- `backend/server.js:2679` — `app.use('/api', requireApiToken)`: **uma única middleware global protege todas as rotas `/api/*`**, incluindo todas as usadas pelos 10 arquivos revisados (`/api/tables/*`, `/api/producao/*`, `/api/motoristas`, `/api/pedidos/*`, `/api/expediente/*`).
- `requireApiToken` (`backend/server.js:1792–1822`): aceita JWT puro via `Authorization: Bearer <jwt>` independentemente do `X-API-Key`/token fixo — `bearerToken` é primeiro comparado ao `API_TOKEN` fixo e, se não bater, é validado como JWT (`verifyJwtHs256`). Logo, **todas as rotas usadas pelo frontend aceitam JWT sozinho, sem precisar de `X-API-Key`.**
- Observação não relacionada a segurança: `frontend/js/expediente-alerts.js` chama `POST /api/expediente/encerrar-geral`, rota que **não existe** no backend atual. Isso já era assim antes desta correção (não é uma regressão); a função já tem um fallback local (`sectorShifts`) para esse caso e degrada sem travar a tela.

Recomenda-se validar manualmente após o deploy (login real → checar aba Network do navegador → confirmar que só `Authorization: Bearer <jwt>` é enviado, sem `X-API-Key`):
- `GET /api/tables/lots` (Kanban — `data.js`/`app.js`/`lots.js`)
- `PATCH /api/producao/:id` (atualização de lote — `data.js`)
- `GET /api/producao/relatorio-tempos` (Relatório de Tempos — `relatorio-tempos.js`)
- `GET /api/motoristas` (lista de motoristas — `lots.js`)
- `GET/POST` das rotas de entrega usadas por `deliveries.js`/`programacao-entregas.js`
- Rotas de dashboard usadas por `dashboard.js`
- Rotas usadas por `driver.html` (Painel do Motorista, JWT do PaintLab)

## 7. Riscos restantes e plano de rotação do token antigo

- **O token antigo (`INDUSCOLORSECURE9xA82kLmP2026`) já esteve público** no frontend publicado no Cloudflare Pages. Removê-lo do código-fonte agora **não invalida** o valor antigo — ele continua aceito pelo backend até ser trocado no ambiente.
- **Plano de rotação (fazer após o deploy desta correção):**
  1. Confirmar que o novo frontend (sem o token embutido) está no ar e funcionando só com JWT.
  2. Gerar um novo valor para `FACTORYFLOW_API_TOKEN` e atualizá-lo na variável de ambiente do backend no Railway.
  3. Atualizar qualquer integração server-to-server/manual que ainda dependa do valor antigo (scripts, Postman, automações) com o novo valor.
  4. Após a troca, o valor antigo deixa de funcionar — nenhuma chamada do frontend depende dele, então não há impacto para os usuários.
- **Discrepância de URL não relacionada a segredo:** `frontend/js/dashboard.js` (função `ffDashResolveApiBase`) usa como último fallback `https://app-producao-backend-production-b4a7.up.railway.app`, diferente da URL usada no resto do frontend (`https://app-producao-backend-production.up.railway.app`). Não é um segredo e não foi alterado nesta correção, mas vale confirmar se esse domínio `-b4a7` ainda existe/é válido — se não, é só um fallback morto sem risco de segurança.
- **CORS** continua sendo apenas uma camada de restrição de origem no navegador, não um mecanismo de autenticação — reforçado aqui para não ser confundido com proteção real em decisões futuras.
- **Rota inexistente:** `frontend/js/expediente-alerts.js` chama `/api/expediente/encerrar-geral`, que não existe no backend. Não é um risco de segurança (a chamada falha e cai no fallback local), mas é uma inconsistência funcional pré-existente que pode merecer correção em outra etapa (fora do escopo desta remediação de segurança).
