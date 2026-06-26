# FactoryFlow — Regras de Negócio

> Documento gerado a partir do código-fonte real (comentários em `backend/server.js`, `frontend/README.md` e os módulos `frontend/js/data.js`, `frontend/js/lots.js`, `frontend/js/kanban.js`, `frontend/js/relatorio-tempos.js`, `frontend/js/sync.js`).
> Nenhuma regra foi inventada. Itens que não puderam ser confirmados diretamente no código estão marcados como **"precisa confirmar"** na seção final.

---

## 1. Visão geral

FactoryFlow é um sistema web de gestão de produção para uma indústria de tintas (Induscolor). Ele controla o ciclo de vida de **lotes de produção** desde a liberação do pedido até a entrega, passando por setores fabris (coloração, laboratório, pesagem, produção, envase), com:

- Kanban visual por setor
- Controle de tempo trabalhado/pausado/ocioso por setor (Relatório de Tempos)
- Controle de expediente (abertura/fechamento por setor)
- Reprovação de lotes com justificativa
- Programação de entregas e simulador de encaixe de pedidos urgentes
- Integração com o ERP da empresa via um backend Node.js (sincronização automática de pedidos)

Frontend: SPA estático (HTML/JS, sem framework/build), arquivos em `frontend/js/`.
Backend: Express + MySQL (`backend/server.js`, `backend/db.js`, `backend/sync.js`).

---

## 2. Setores existentes

Definidos em `frontend/js/data.js` (`SECTORS`, `SECTOR_LABELS`):

| Chave | Label |
|---|---|
| `coloracao_revisao` | Coloração (Revisão) |
| `laboratorio_revisao` | Laboratório (Revisão) |
| `pcp_liberacao` | PCP (Liberação) |
| `laboratorio_amostras` | Laboratório – Amostras (exclusivo de amostras) |
| `coloracao_amostras` | Coloração – Amostras (exclusivo de amostras) |
| `pesagem` | Pesagem |
| `producao` | Produção |
| `coloracao` | Coloração |
| `laboratorio` | Laboratório |
| `envase_produzir` | Envase – Produzir |
| `envase_enlatamento` | Envase – Enlatamento |
| `pronto` | Pronto para Entrega |
| `entrega` | Em Rota de Entrega |
| `entregue` | Produto Entregue |

**Visibilidade por setor** (`SECTOR_VISIBILITY`, `data.js`):
- Usuário de Coloração vê: `coloracao_revisao`, `coloracao`, `coloracao_amostras` — **não vê Produção**.
- Usuário de Laboratório vê: `laboratorio_revisao`, `laboratorio`, `laboratorio_amostras` — **não vê Produção**.
- Usuário de Envase vê: `envase_produzir`, `envase_enlatamento`.
- PCP / `pcp_liberacao` vê: `pcp_liberacao`.

---

## 3. Status principais

### Status do lote (`lotStatus`, `data.js`)
- `idle` — aguardando / parado, sem sessão de trabalho ativa.
- `working` — em produção (sessão de trabalho ativa).
- `paused` — pausado (com motivo registrado).
- `rejected` — reprovado (lote sai do fluxo, não aparece mais no Kanban).

### Status do lote no backend (`producao_lotes.status`, conforme `backend/README_BACKEND.md`)
Valores documentados: `aguardando`, `em_producao`, `pausado`, `concluido`, `rejeitado`. **Precisa confirmar** se esses valores ainda são os únicos usados, já que o fluxo principal hoje parece controlado majoritariamente pelos campos `ff_lotStatus` / `setor_atual` (ver seção 14).

### Prioridade (`PRIORITY_LABELS`, `data.js`)
- `normal` — Normal
- `urgent` — Urgente
- `sameday` — Mesmo Dia

---

## 4. Fluxo padrão de tinta

Definido em `PRODUCT_FLOWS.tinta` (`data.js`):

```
Coloração (Revisão) → Laboratório (Revisão) → PCP (Liberação) → Pesagem → Produção → Coloração → Laboratório → Envase (Enlatamento) → Pronto para Entrega
```

Regras específicas:
- Ao sair do **Laboratório**, o lote de tinta vai para **Envase – Enlatamento** (não para o envase genérico/antigo) — comentário explícito no código para evitar lotes "perdidos" em um envase incorreto.
- Em **Produção**, o operador pode **pular a Coloração** e enviar direto para Laboratório (`skipColor = true`). Quando isso ocorre, a opção seguinte exibida é apenas "Laboratório (coloração pulada)".

---

## 5. Fluxo de base

Definido em `PRODUCT_FLOWS.base`:

```
Coloração (Revisão) → Laboratório (Revisão) → PCP (Liberação) → Pesagem → Produção → Laboratório → Entregue (finalizado)
```

Regras específicas (`data.js`, `lots.js`):
- **Base nunca passa por Coloração, Envase ou Pronto para Entrega.**
- Em Produção, Base é sempre enviada para Laboratório (não tem opção de pular).
- Ao saírem do Laboratório, lotes de Base **finalizam automaticamente como `entregue`** — saem do fluxo ativo do FactoryFlow sem passar por envase/entrega física dentro do sistema.
- Detecção de lote "Base" em `lots.js` considera `productType === 'base'`, `tipo_lote === 'base'` (incluindo dado vindo do MySQL/ERP) ou nome do produto contendo "base".

---

## 6. Fluxo de amostra

Definido em `PRODUCT_FLOWS.amostra`:

```
PCP (Liberação) → Laboratório – Amostras → [Coloração – Amostras → Laboratório – Amostras] (opcional) → Pronto para Entrega
```

Regras específicas (`getNextSectorOptions`, `data.js`):
- O PCP envia a amostra **direto** para Laboratório – Amostras (não passa pelos setores normais de pesagem/produção).
- No Laboratório – Amostras, o operador escolhe entre:
  - Enviar para **Coloração – Amostras**, ou
  - Marcar como **Pronto para Entrega** diretamente.
- Se passar pela Coloração – Amostras, o lote **sempre volta** para Laboratório – Amostras antes de poder ir para Pronto.

---

## 7. Fluxo de verniz

Verniz não tem uma entrada própria em `PRODUCT_FLOWS` — é tratado como caso especial de `tinta` dentro de `confirmSendToSector()` (`lots.js`), via detecção por tipo de produto, nome contendo "verniz"/"varnish" ou código de produto iniciando em `027`.

Regras específicas (`lots.js`):
- **Verniz nunca pode sair do Laboratório direto como "entregue"/"pronto".** Se isso for tentado, o sistema redireciona automaticamente o destino para **Envase – Enlatamento**.
- Estando em qualquer envase (`envase`, `envase_produzir`, `envase_enlatamento`, `envase_producao`) e o destino pretendido for finalização (`entregue`, `entrega`, `retirada`, `finalizado`), o sistema redireciona o destino para **Pronto**.

---

## 8. Fluxo de endurecedor

Definido em `PRODUCT_FLOWS.endurecedor` e `ENDURECEDOR_FLOW_DIRECT` (`data.js`):

**Fluxo via Pesagem:**
```
Coloração (Revisão) → Laboratório (Revisão) → PCP (Liberação) → Pesagem → Produção → Envase (Enlatamento) → Pronto
```

**Fluxo direto:**
```
Coloração (Revisão) → Laboratório (Revisão) → PCP (Liberação) → Envase – Produzir → Pronto
```

Regras específicas:
- A escolha entre os dois fluxos é feita **em `pcp_liberacao`**, via campo `endurecedorRoute` / `destinoEndurecedor` no lote (radio buttons no modal de avanço, conforme `frontend/README.md`).
- Se passar por **Produção**, o endurecedor vai direto para **Envase – Enlatamento** (não passa por Coloração nem Laboratório).
- Endurecedor **nunca passa por Coloração ou Laboratório** em nenhum dos dois fluxos.

---

## 9. Fluxo de diluente

Definido em `PRODUCT_FLOWS.diluente`:

```
Coloração (Revisão) → Laboratório (Revisão) → PCP (Liberação) → Envase – Produzir → Pronto
```

Regras específicas:
- Diluente **não passa por Pesagem, Produção, Coloração nem Laboratório**.
- Ao sair do PCP (Liberação), vai direto para **Envase – Produzir**.

---

## 10. Regras de laboratório e coloração

- **Coloração (Revisão)** e **Laboratório (Revisão)** são etapas iniciais de revisão/aprovação, antes do PCP liberar o lote — presentes no início do fluxo de todos os tipos de produto (tinta, base, diluente, endurecedor).
- Setores normais (`coloracao`, `laboratorio`) e os de revisão (`coloracao_revisao`, `laboratorio_revisao`) e amostras (`coloracao_amostras`, `laboratorio_amostras`) são tratados como **grupos equivalentes** para fins de expediente e cálculo de tempo (`normalizeShiftSetor()` em `backend/server.js`): todos do grupo Coloração compartilham o mesmo controle de expediente, assim como todos do grupo Laboratório.
- Em **Produção**, lotes de tinta podem pular a Coloração (skip) e ir direto ao Laboratório — opção exibida explicitamente ao operador, não é automática.
- Base, ao saída do Laboratório, finaliza (ver seção 5). Tinta, ao saída do Laboratório, vai para Envase – Enlatamento (ver seção 4). Verniz tem trava especial para não saltar etapas (ver seção 7).

---

## 11. Regras de envase

- Existem **dois quadros de envase**: `envase_produzir` e `envase_enlatamento` — tratados como telas/etapas distintas no Kanban, mas **ambos levam ao mesmo destino seguinte: Pronto para Entrega** (`getNextSectorOptions`, `data.js`).
- O grupo "envase" (para expediente/relatório) agrupa `envase`, `envase_produzir` e `envase_enlatamento` (`normalizeShiftSetor`, `backend/server.js`).
- Produtos que chegam ao envase já tiveram, conforme o tipo, fluxo de Laboratório (tinta/endurecedor-via-produção) ou vieram direto do PCP (diluente/endurecedor-direto) — ver seções 4, 8 e 9.

---

## 12. Regras de pronto para entrega

- `pronto` é o status que marca o lote como **finalizado na produção, aguardando logística de entrega**.
- A partir de `pronto`, o ciclo de vida segue (fora do escopo direto dos arquivos analisados) para `entrega` (em rota) e `entregue` (entregue) — esses dois últimos aparecem em `SECTOR_LABELS` mas o fluxo de entrega/rotas em si está em `frontend/js/deliveries.js` (**não analisado em detalhe nesta tarefa — precisa confirmar regras específicas de rotas/motoristas**).
- Lotes de **Base** não passam por `pronto` — finalizam direto como `entregue` ao saírem do Laboratório (ver seção 5).
- Lotes em `pronto`, `entrega` ou `entregue` são **excluídos do cálculo de expediente/trabalho por setor** (`getLotsByShiftGroup`, `data.js`) e dos setores "finais" no cálculo de métricas de tempo (`finalSectors` em `rtCalculateMetricsFromFallback`, `backend/server.js`).

---

## 13. Regras do relatório de tempos

Fonte: `frontend/js/relatorio-tempos.js`, `backend/server.js` (funções com prefixo `rt`), `frontend/README.md`.

- Tela carregada **sob demanda** (não impacta o polling do Kanban); usa fallback automático para dados locais (`STATE.lots`) se o endpoint de backend `GET /api/producao/relatorio-tempos` falhar ou retornar 404.
- **Fórmula fixa:** `total = trabalhado + pausado + ocioso` — sempre, em qualquer cálculo (front e back).
- `workedMs` e `pausedMs` nunca podem exceder `totalMs` (clamps aplicados nos dois lados).
- A fonte de verdade da sequência de setores por lote é o **histórico (`ff_history` / `history`)**; `ff_sectorMetrics` (snapshot salvo) só é usado quando não há histórico confiável, mas seus valores de trabalhado/pausado são preservados quando existem e fazem sentido (`rtFindStoredMetricForTimeline`, `backend/server.js`).
- Transições de histórico com `saída ≤ entrada` são **descartadas silenciosamente** (não geram erro, apenas `console.warn`); linhas com timestamp impossível exibem aviso em vez de data corrompida.
- **Tempo total por setor é calculado pelos eventos reais de abertura/fechamento de expediente** (ver seção 14) — não existe mais expediente fixo fixo 07:10–17:25 cravado no cálculo; o sistema desconta os períodos em que o expediente do setor estava fechado.
- Filtros disponíveis: código do produto (multi-prefixo separado por vírgula), nome do produto, OP/Lote, número de pedido, cliente, data inicial/final, setor.
- Exportações: Excel via tabela HTML reconhecida pelo Excel (`.xls`, sem dependência externa, sem fallback necessário) e PDF via jsPDF+autoTable; a exportação em Excel/PDF **não inclui a coluna "Status"**. Se jsPDF/autoTable não estiverem disponíveis ou a geração do PDF falhar, o frontend baixa um **CSV simples** como fallback (`exportRelatorioTemposCSV`, `frontend/js/relatorio-tempos.js`) — esse CSV de fallback **inclui a coluna "Status"** (não é o mesmo formato do Excel/PDF). Não existe fallback `window.print()`.
- A tabela exibe uma linha de **Totais Gerais** no rodapé, respeitando os filtros ativos.

---

## 14. Regras de expediente

Fonte: `frontend/js/data.js` (funções `iniciarExpedienteSetor`, `finalizarExpedienteSetor`, `freezeLotsForShiftClose`, `resumeLotsForShiftOpen`) e `backend/server.js` (`rtBusinessIntervals`, `rtLoadShiftClosedIntervals`).

- Cada setor (agrupado: PCP, Pesagem, Produção, Coloração, Laboratório, Envase) tem um estado de expediente **aberto/fechado**, controlado via `POST /api/expediente/toggle` e consultado via `GET /api/expediente` / `GET /api/expediente/:setor`.
- **Regra central:** "Entrou no setor → começa a contar. Fechou expediente → congela. Abriu expediente → continua do ponto congelado. Saiu do setor → finaliza." (comentário literal em `backend/server.js`).
- O cálculo de tempo útil usa **somente eventos reais** de abertura/fechamento registrados em `ff_sector_shift_events` e no estado vivo em `ff_sector_shifts` — não existe mais um horário fixo de expediente cravado no código.
- Ao **fechar** o expediente de um grupo de setor, todos os lotes ativos daquele grupo (`getLotsByShiftGroup`) têm suas sessões de trabalho/pausa abertas congeladas (`closeReason: 'Fim de expediente'`), e o `lotStatus` é temporariamente colocado em `idle`, guardando o estado anterior em `expedientePausedStatus` (`working` ou `paused`).
- Ao **reabrir** o expediente, lotes que estavam `working` antes do fechamento recebem uma nova sessão de trabalho a partir do horário de abertura; o tempo "parado" entre o fechamento e a reabertura é somado ao `sectorEnteredAt` do lote (não conta como tempo no setor).
- Existem chaves de expediente "globais" (`geral`, `expediente_geral`, `todos`, `all`, `global`, `todos_setores`) que, se usadas, afetam o cálculo de todos os setores simultaneamente (`rtGetGlobalShiftKeys`, `backend/server.js`).
- Há um sistema de **alertas automáticos de expediente** (`frontend/js/expediente-alerts.js`) com horários configurados: 07:10 abrir, 11:25 aviso de almoço (só se aberto), 13:05 reabrir (só se fechado), 17:25 encerrar (16:25 sextas, 15:20 última sexta do mês). Cada alerta aparece no máximo 1x por dia por usuário (controle via `localStorage`).

---

## 15. Regras de pausa

Fonte: `frontend/js/lots.js`, `frontend/js/kanban.js`, `backend/server.js` (`rtGetSessionType`, `rtSumWorkSessionsBySector`).

- Uma sessão de trabalho (`workSessions`) é classificada como pausa quando tem `pauseReason`/`motivoPausa` preenchido, ou quando o tipo/status indica explicitamente pausa.
- Pausar um lote abre o modal de pausa (`openPauseModal`); a sessão de trabalho aberta é encerrada e uma nova sessão do tipo pausa é registrada com o motivo.
- Ao **avançar de setor** (`confirmSendToSector`, `lots.js`), qualquer sessão de trabalho aberta é fechada automaticamente (`ffCloseOpenWorkSessions`, motivo: "Encerrada automaticamente ao avançar de setor") antes de consolidar a métrica do setor.
- No cálculo de tempo (`rtSumWorkSessionsBySector`, backend), intervalos de pausa são **subtraídos** dos intervalos de trabalho para não contar o mesmo período como trabalhado e pausado simultaneamente; pausas também são recortadas pelos períodos de expediente fechado.
- **Precisa confirmar:** se há um motivo mínimo obrigatório (quantidade de caracteres) para pausar um lote, similar à regra de reprovação — não foi localizada validação de tamanho mínimo para `pauseReason` nos arquivos analisados (diferente da reprovação, que exige ≥10 caracteres, ver seção 17).

---

## 16. Regras de sincronização ERP → FactoryFlow

Fonte: `backend/sync.js`, `backend/server.js`, `backend/README_BACKEND.md`.

- O backend lê periodicamente (`SYNC_INTERVAL_MS`, padrão 10000ms) a tabela do ERP `cli_pedidos_itens` com `JOIN cli_clientes`, filtrando apenas registros com `id > último_id_importado` (cursor incremental salvo na tabela `sync_state`, chave `last_imported_pedido_id`).
- Cada linha do ERP é identificada por `origem_item_id` (= `cli_pedidos_itens.id`), com **índice único** garantido em `producao_lotes.origem_item_id` (criado automaticamente pelo sync se não existir).
- Inserção usa `INSERT ... ON DUPLICATE KEY UPDATE`: se o `origem_item_id` já existe, os dados descritivos (produto, cliente, quantidade, endereço etc.) são **atualizados**, mas os campos de status/setor/fluxo de produção (`status`, `setor_atual`, `ff_*`) **não são tocados** pelo sync — preservando o progresso do lote já em produção.
- Novos registros entram sempre com `status='aguardando'` e `setor_atual='moagem'`.
- O cursor de importação (`lastImportedId`) só avança para o maior `origem_item_id` lido; não há reprocessamento automático de IDs já importados, exceto a atualização de dados feita pelo próprio `ON DUPLICATE KEY UPDATE`.

---

## 17. Cuidados para não duplicar OP

- A chave de deduplicação **efetivamente usada hoje pelo sync** é `producao_lotes.origem_item_id` (único, ligado ao `id` da linha de origem em `cli_pedidos_itens`), não diretamente `numero_pedido + op`.
- **Inconsistência encontrada — precisa confirmar:** `backend/setup.js` (script de criação manual da tabela) define uma constraint diferente: `UNIQUE KEY uq_pedido_op (numero_pedido, op)`. Já `backend/sync.js` cria e depende de `UNIQUE KEY ux_producao_lotes_origem_item_id (origem_item_id)`. Não foi possível confirmar nestes arquivos se as duas constraints coexistem na tabela real ou se uma delas está desatualizada/sem efeito. Antes de qualquer alteração no schema, é necessário **verificar a estrutura real da tabela `producao_lotes` em produção**.
- No frontend, ao liberar pedidos do ERP (`pedidos-novos.js`, conforme `frontend/README.md`), há uma guarda anti-duplicidade que verifica `STATE.lots` por OP/número antes de criar novos lotes/pedidos internos.
- Reprovação de lote (`rejected=true`) **não libera o número de OP** para reuso — o lote reprovado simplesmente some do Kanban e da produção ativa, mas seu registro permanece no histórico/relatórios.

---

## 18. Endpoints principais envolvidos

Lista extraída do índice de rotas em `backend/server.js` (rota `GET /`):

| Método | Rota | Uso |
|---|---|---|
| GET | `/health` | Health check + estatísticas de sync |
| GET | `/api/pedidos`, `/api/pedidos/:numero` | Pedidos do ERP |
| PATCH | `/api/pedidos/:numero/processado` \| `/desprocessar` \| `/data-entrega` | Marca processamento / data de entrega do pedido |
| GET | `/api/ops`, `/api/ops/:op` | Ordens de produção |
| GET | `/api/producao`, `/api/producao/ativos`, `/api/producao/:id` | Lista/consulta lotes |
| GET | `/api/producao/relatorio-tempos` | Dados do Relatório de Tempos |
| POST | `/api/admin/reprocessar-tempos` | Reprocessamento administrativo de tempos |
| POST | `/api/producao/manual` | Criação manual de lote |
| POST | `/api/lotes` | Criação de lote |
| GET | `/api/lote/:op` | Consulta de lote por OP |
| PATCH | `/api/producao/:id` | Atualização de status/setor do lote |
| GET | `/api/expediente`, `/api/expediente/:setor` | Consulta de expediente |
| POST | `/api/expediente/toggle` | Abre/fecha expediente de um setor |
| GET/POST/PUT | `/api/cq/*` | Módulo CQVision (qualidade) — fora do escopo desta documentação |
| GET | `/api/sync/status` | Estatísticas de sincronização |
| POST | `/api/sync/run` | Disparo manual de sincronização |

Todas as rotas `/api/*` exigem autenticação: **JWT** (`Authorization: Bearer <token>`, validado contra `JWT_SECRET`) **ou** token fixo (`X-API-Key` / `Authorization: Bearer` igual a `FACTORYFLOW_API_TOKEN`). Rotas públicas: `/`, `/health`, `/webhook/whatsapp`.

---

## 19. Arquivos principais

### Backend
| Arquivo | Responsabilidade |
|---|---|
| `backend/server.js` | API Express completa: rotas, autenticação, cálculo de tempos/expediente, webhook WhatsApp/IA |
| `backend/db.js` | Pool de conexão MySQL (via variáveis de ambiente) |
| `backend/sync.js` | Sincronização periódica ERP → `producao_lotes` |
| `backend/setup.js` | Script único de criação da tabela `producao_lotes` |
| `backend/teste-db.js` | Script manual de teste de conexão ao banco |

### Frontend
| Arquivo | Responsabilidade |
|---|---|
| `frontend/js/data.js` | Estado global (`STATE`), constantes de setores/fluxos/prioridades, API helpers, expediente |
| `frontend/js/lots.js` | Cards de lotes, avanço entre setores (`confirmSendToSector`), regras especiais por tipo de produto |
| `frontend/js/kanban.js` | Quadro Kanban, reprovação de lote (`openRejectModal`/`confirmRejectLot`) |
| `frontend/js/relatorio-tempos.js` | Tela e cálculos do Relatório de Tempos (filtros, export Excel/PDF) |
| `frontend/js/meu-setor.js` | Tela do operador de setor (`role=sector`) |
| `frontend/js/expediente-alerts.js` | Alertas automáticos de horário de expediente |
| `frontend/js/simulador-entrega.js` | Simulador de encaixe de pedido urgente na fila de produção |
| `frontend/js/pedidos-novos.js` | Importação/liberação de pedidos vindos do ERP |
| `frontend/js/programacao-entregas.js` | Calendário de entregas, edição manual de data |
| `frontend/js/deliveries.js` | Entregas, motoristas, gerenciamento de usuários |
| `frontend/js/dashboard.js`, `reports.js` | Dashboards e relatórios gerais |
| `frontend/js/auth.js` | Login, hash de senha, `PAGE_MAP` (mapa de páginas por role) |

---

## 20. Regras que ainda precisam ser confirmadas manualmente

1. **Schema real da tabela `producao_lotes` em produção** — `setup.js` define `UNIQUE KEY (numero_pedido, op)` enquanto `sync.js` cria/depende de `UNIQUE KEY (origem_item_id)`. Precisa confirmar qual(is) constraint(s) realmente existem na tabela em uso e se há risco de conflito/erro de insert.
2. **Valores de `producao_lotes.status`** — o README do backend lista `aguardando, em_producao, pausado, concluido, rejeitado`, mas o controle observado no código de produção parece usar majoritariamente `ff_lotStatus` (`idle/working/paused/rejected`) e `setor_atual`. Precisa confirmar se o campo `status` do MySQL ainda é atualizado por algum fluxo ou se está desatualizado/legado.
3. **Regras de motivo mínimo para pausa** — não foi localizada validação de tamanho mínimo para `pauseReason`, diferente da reprovação (mín. 10 caracteres). Confirmar se isso é intencional.
4. **Fluxo de Entrega/Rotas (`entrega` → `entregue`)** — `frontend/js/deliveries.js` e `frontend/js/programacao-entregas.js` não foram analisados em profundidade nesta tarefa; as regras específicas de criação de rota, atribuição de motorista e confirmação de entrega precisam ser documentadas separadamente.
5. **Papel exato do campo `tipo_lote` vindo do MySQL/ERP** vs. `productType` do frontend — ambos parecem usados para detectar Base/Amostra/etc., mas a relação entre os dois não está totalmente clara nos arquivos analisados.
6. **Limite de API mencionado no README do frontend** (`limit=500` revertido após erro 422 com `limit=2000`) — confirmar se esse limite ainda está em vigor em todos os endpoints relevantes ou foi alterado desde então.
7. **Módulo CQVision (`/api/cq/*`)** — presente no backend mas fora do escopo de regras do FactoryFlow propriamente dito; precisa confirmar se há alguma interdependência de regras de negócio entre os dois módulos.
