# Checklist Manual de Testes — FactoryFlow

> Documento de apoio operacional. Não altera código, banco de dados ou frontend — apenas documenta como testar manualmente o sistema antes/depois de mudanças.
> Baseado em módulos e endpoints **já existentes** no código (`backend/server.js`, `frontend/js/*`), confirmados em auditorias anteriores (`docs/FACTORYFLOW_REGRAS.md`, `docs/AUDITORIA_SCHEMA_PRODUCAO_LOTES.md`, `backend/docs/DECISAO_STATUS_FACTORYFLOW.md`). Nenhuma funcionalidade nova foi assumida. Itens sem confirmação direta no código estão marcados **"precisa confirmar"**.

## Topologia atual (contexto para os testes)

- **Frontend:** Cloudflare Pages — `https://factoryflow-pagina.pages.dev/`
- **Backend FactoryFlow:** Railway (URL própria — **precisa confirmar** a URL exata de produção atual antes de cada rodada de teste, pois não foi fornecida/confirmada no código analisado)
- **Login:** validado pelo backend do PaintLab (JWT HS256 compartilhado entre FactoryFlow, PaintLab e CQVision — ver `backend/server.js`, `verifyJwtHs256`)
- **CORS:** ajustado manualmente nos backends (lista de origens permitidas em `backend/server.js`); **precisa confirmar** que `https://factoryflow-pagina.pages.dev` está incluído na lista atual antes de testar em produção

---

## 1. Testes de login

- [ ] Login com usuário/senha válidos carrega o sistema sem erro e redireciona para a página inicial correta do papel do usuário (`PAGE_MAP`, `frontend/js/auth.js`).
- [ ] Login com credenciais inválidas exibe mensagem de erro e **não** deixa o usuário entrar.
- [ ] Após login, o token JWT é armazenado e enviado nas requisições subsequentes (`Authorization: Bearer <token>`) — verificar no painel de Network do navegador.
- [ ] Logout limpa a sessão e impede acesso às telas internas sem novo login.
- [ ] Testar login para pelo menos um usuário de cada papel relevante já existente (ex.: Coloração, Laboratório, Envase, PCP, administrador) e confirmar que cada um vê apenas os setores previstos em `SECTOR_VISIBILITY` (`frontend/js/data.js`).
- [ ] **Precisa confirmar:** comportamento esperado quando o backend do PaintLab está fora do ar (timeout/erro de rede) — se deve haver mensagem específica ao usuário.

## 2. Testes de carregamento inicial

- [ ] Ao abrir o sistema, a tela inicial carrega os lotes ativos sem erro (rota `GET /api/producao/ativos`, descrita no código como "Usada pelo Kanban no carregamento inicial").
- [ ] Caso `GET /api/producao/ativos` falhe, confirmar que o fallback para `GET /api/producao` é acionado (`loadBridgeLots`, `frontend/js/data.js`) e que o sistema não quebra.
- [ ] Rotas (`STATE.routes`), pedidos (`STATE.orders`) e usuários (`STATE.users`) carregam em paralelo sem travar a tela principal, mesmo que uma dessas chamadas falhe isoladamente (`Promise.allSettled`, conforme padrão usado em `frontend/js/data.js`).
- [ ] Tempo de carregamento inicial dentro do esperado (sem timeout) — comparar antes/depois de uma alteração.
- [ ] Atualização automática (auto-update a cada ~8s, `reloadBridgeLots`) continua funcionando sem duplicar lotes na tela.

## 3. Testes do Kanban

- [ ] Lotes aparecem nas colunas corretas de acordo com `setor_atual` (ver lista de setores em `docs/FACTORYFLOW_REGRAS.md`, seção 2).
- [ ] Avançar um lote de setor (`confirmSendToSector`, `frontend/js/lots.js`) move o card para a coluna seguinte esperada, testando ao menos um lote de cada tipo de produto (tinta, base, amostra, verniz, endurecedor, diluente — ver fluxos na seção 4-9 de `docs/FACTORYFLOW_REGRAS.md`).
- [ ] Pausar um lote (`openPauseModal`) e retomar funciona e reflete corretamente o badge de status.
- [ ] Reprovar um lote (`openRejectModal` → `openRejectConfirmation` → `confirmRejectLot`, `frontend/js/kanban.js`) exige justificativa com no mínimo 10 caracteres e remove o lote do Kanban ativo após confirmar.
- [ ] Um usuário sem permissão para um setor não vê esse setor no Kanban (`SECTOR_VISIBILITY`).
- [ ] Abrir/fechar expediente de um setor (`POST /api/expediente/toggle`) reflete corretamente nos lotes daquele grupo (congelamento/retomada de sessões — ver `docs/FACTORYFLOW_REGRAS.md`, seção 14).
- [ ] Nenhum lote "duplicado" aparece no Kanban após recarregar a página (checar especificamente após qualquer alteração de sincronização).

## 4. Testes do relatório de tempos

- [ ] Tela de Relatório de Tempos carrega dados via `GET /api/producao/relatorio-tempos` sem erro.
- [ ] Se o endpoint falhar/retornar 404, confirmar que o fallback local (`STATE.lots`) assume e a tela continua funcional (`frontend/js/relatorio-tempos.js`).
- [ ] Para um lote conhecido, os valores de trabalhado + pausado + ocioso somam o total exibido (fórmula fixa, ver seção 13 de `docs/FACTORYFLOW_REGRAS.md`).
- [ ] Badge de status do lote no relatório reflete `ff_lotStatus` (campo `ff_lot_status` retornado pelo backend) e não o `status` legado quando ambos estão presentes e divergem — checar especificamente um lote onde os dois campos sejam diferentes (ver `backend/docs/DECISAO_STATUS_FACTORYFLOW.md`).
- [ ] Linha de "Totais Gerais" no rodapé soma corretamente os valores filtrados na tela.
- [ ] Trocar o expediente de um setor (abrir/fechar) e confirmar que o tempo "ocioso" do período fechado é descontado corretamente no relatório.

## 5. Testes de filtros (OP, pedido, cliente, produto, setor)

- [ ] Filtro por **código do produto** aceita múltiplos prefixos separados por vírgula e retorna apenas os lotes esperados.
- [ ] Filtro por **nome do produto** funciona com correspondência parcial.
- [ ] Filtro por **OP** retorna exatamente o(s) lote(s) daquela OP.
- [ ] Filtro por **número de pedido** retorna todos os lotes daquele pedido.
- [ ] Filtro por **cliente** funciona com correspondência parcial pelo nome.
- [ ] Filtro por **setor** retorna apenas lotes naquele setor (ou com histórico naquele setor, conforme comportamento atual do backend: `setor_atual LIKE ? OR ff_sectorMetrics LIKE ? OR ff_history LIKE ?`).
- [ ] Filtro por **data inicial/final** restringe corretamente o período exibido.
- [ ] Combinação de múltiplos filtros ao mesmo tempo retorna resultado coerente (interseção, não união).
- [ ] Limpar todos os filtros volta a exibir o conjunto padrão de dados (últimos 30 dias, conforme regra do backend quando nenhum filtro de usuário está ativo).

## 6. Testes de exportação Excel/PDF

- [ ] Exportar para **Excel** gera um arquivo válido (via SheetJS) com os dados atualmente filtrados na tela.
- [ ] Se a exportação Excel falhar, confirmar que o fallback CSV é acionado e gera um arquivo utilizável.
- [ ] Exportar para **PDF** gera um arquivo válido (via jsPDF + autoTable) com os dados atualmente filtrados na tela.
- [ ] Se a exportação PDF falhar, confirmar que o fallback `window.print()` é acionado.
- [ ] Confirmar que a coluna "Status" **não** aparece nas exportações (Excel/PDF), conforme comportamento documentado em `docs/FACTORYFLOW_REGRAS.md`, seção 13.
- [ ] Exportar com filtros aplicados gera arquivo apenas com os dados filtrados (não a base completa).

## 7. Testes de programação/entregas

- [ ] Tela de Programação de Entregas carrega o calendário sem erro (`frontend/js/programacao-entregas.js`).
- [ ] Lotes com `setor_atual = 'entrega'` ou `status`/`mysql_status = 'em_rota'` aparecem corretamente como "em rota" (`_peOrderStatus`).
- [ ] Lotes com todos os setores `'entregue'` aparecem como pedido `'delivered'`.
- [ ] Edição manual de data de entrega (`PATCH /api/pedidos/:numero/data-entrega` ou equivalente em `ff_pedidos_datas`) é salva e refletida na tela após recarregar.
- [ ] Tela de Entregas (`frontend/js/deliveries.js`) mostra rotas, motoristas e paradas corretamente; marcar uma parada como entregue reflete no status da rota.
- [ ] Lotes reprovados (`rejected = true`) não aparecem na Programação de Entregas (`_peIsRelevantLot` já trata isso).

## 8. Testes de CORS e URLs de API

- [ ] Acessar `https://factoryflow-pagina.pages.dev/` em produção e confirmar, pelo painel de Network, que as chamadas à API do backend Railway **não** retornam erro de CORS no console.
- [ ] Confirmar que a origem `https://factoryflow-pagina.pages.dev` está presente na lista de origens permitidas do backend (`backend/server.js`) — **precisa confirmar o valor atual exato**, já que o ajuste foi feito manualmente fora deste fluxo de documentação.
- [ ] Testar o sistema também a partir de `localhost`/ambiente de desenvolvimento e confirmar que CORS local continua funcionando (não deve ter sido quebrado pelo ajuste de produção).
- [ ] Confirmar que a URL base da API usada pelo frontend (`BRIDGE_CONFIG.baseUrl` ou equivalente em `frontend/js/data.js`) aponta para o backend Railway correto e não para um ambiente antigo/local esquecido em produção.
- [ ] Testar pelo menos uma rota autenticada (`X-API-Key`/Bearer com `FACTORYFLOW_API_TOKEN`) e uma rota pública (`/health`) para confirmar que a autenticação de API não foi afetada pela mudança de CORS.

## 9. Testes de console/network no navegador

- [ ] Abrir o DevTools (F12) → aba **Console** e confirmar que não há erros vermelhos (`Uncaught`, `TypeError`, etc.) durante o carregamento inicial e a navegação pelas telas principais (Kanban, Relatório de Tempos, Programação de Entregas).
- [ ] Aba **Network**: confirmar que todas as chamadas a `/api/*` retornam status `200`/`304` (ou o esperado) e não `4xx`/`5xx` inesperados.
- [ ] Verificar se há chamadas de API duplicadas/excessivas em loop (sinal de bug de polling ou de auto-update mal configurado).
- [ ] Verificar tempo de resposta das chamadas principais (`/api/producao/ativos`, `/api/producao/relatorio-tempos`) — comparar antes/depois de uma alteração para detectar regressão de performance.
- [ ] Confirmar que nenhuma credencial (token, senha) aparece em texto plano no console ou nos logs do navegador.

## 10. Checklist antes do deploy

- [ ] Rodar os testes das seções 1 a 9 no ambiente de homologação/local antes de promover para produção.
- [ ] Confirmar que nenhuma variável de ambiente obrigatória está ausente no Railway (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`, `JWT_SECRET`, `FACTORYFLOW_API_TOKEN`, `CORS_ORIGIN` — ver `backend/.env.example`).
- [ ] Confirmar que a lista de origens CORS no backend inclui o domínio atual do Cloudflare Pages.
- [ ] Confirmar que não há alterações pendentes de banco de dados não testadas (este checklist não cobre migrações de schema).
- [ ] Revisar o diff do que será publicado e confirmar que nenhuma credencial real foi adicionada ao código (`.env`, tokens, senhas).
- [ ] Anotar a versão/commit atual em produção (frontend e backend) para permitir rollback rápido caso necessário.

## 11. Checklist depois do deploy

- [ ] Repetir os testes de login (seção 1) imediatamente após o deploy, em produção.
- [ ] Repetir os testes de carregamento inicial e Kanban (seções 2 e 3) em produção com um usuário de cada papel principal.
- [ ] Confirmar que o Relatório de Tempos carrega e os filtros/exportações funcionam (seções 4 a 6).
- [ ] Confirmar ausência de erros de CORS/console (seções 8 e 9) especificamente em `https://factoryflow-pagina.pages.dev/`.
- [ ] Monitorar por pelo menos um ciclo de expediente completo (ver `docs/FACTORYFLOW_REGRAS.md`, seção 14) para confirmar estabilidade da contagem de lotes ativos no Kanban.
- [ ] Confirmar com a operação (usuários reais) que nenhum lote "desapareceu" ou "duplicou" após o deploy.

## 12. Sinais de erro que exigem rollback

- [ ] **Login falhando para todos os usuários** (não apenas um caso isolado) — indica problema no backend do PaintLab ou na integração JWT.
- [ ] **Erro de CORS bloqueando todas as chamadas de API** a partir de `https://factoryflow-pagina.pages.dev/` — indica que o ajuste de CORS foi revertido ou um novo deploy do backend não preservou a configuração.
- [ ] **`/api/producao/ativos` retornando erro 5xx ou vazio quando deveria haver lotes** — quebra o carregamento do Kanban para todos os usuários.
- [ ] **Quantidade de lotes ativos no Kanban mudando drasticamente sem explicação operacional** (ex.: de ~200 lotes ativos para 0 ou para um número muito maior) — sinal de que uma mudança de lógica de status/setor alterou o filtro de "ativos" (ver riscos documentados em `backend/docs/DECISAO_STATUS_FACTORYFLOW.md`, seção 6).
- [ ] **Relatório de Tempos retornando valores de tempo negativos, ou trabalhado+pausado+ocioso não somando o total** — indica regressão no cálculo (`rtCalculateMetricsFromFallback`/`rtBuildTempoRowsFromLot`).
- [ ] **Exportação Excel/PDF falhando para todos os usuários** (não um caso isolado de navegador) — sinal de regressão no carregamento das bibliotecas (SheetJS/jsPDF) após deploy do frontend.
- [ ] **Erros recorrentes de timeout/erro de rede entre frontend (Cloudflare Pages) e backend (Railway)** — pode indicar que o backend está fora do ar, sobrecarregado, ou que a URL configurada no frontend está incorreta.
- [ ] **Avanço de setor movendo lotes para o setor errado** para qualquer tipo de produto (tinta, base, amostra, verniz, endurecedor, diluente) — indica regressão grave nas regras de fluxo (`getNextSectorOptions`/`confirmSendToSector`).
- [ ] **Erros no console indicando exceções não tratadas (`Uncaught TypeError`, etc.) em qualquer tela principal durante uso normal** (não apenas em casos extremos/edge cases).

Quando qualquer um dos sinais acima for observado em produção após um deploy, a recomendação é reverter para a versão/commit anotado no item de checklist da seção 10 (frontend no Cloudflare Pages, backend no Railway) e investigar em ambiente de homologação antes de tentar novamente.
