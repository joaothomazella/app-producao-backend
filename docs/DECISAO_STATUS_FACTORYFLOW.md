# Decisão de Status — FactoryFlow / `producao_lotes`

> Documento técnico de decisão de arquitetura. Não altera código, banco de dados ou frontend.
> Baseado em fatos confirmados por auditoria real de schema/dados (`docs/AUDITORIA_SCHEMA_PRODUCAO_LOTES.md` e `docs/FACTORYFLOW_REGRAS.md`, seções 3 e 21) e por leitura de código (`backend/server.js`, `backend/sync.js`, `frontend/js/data.js`, `frontend/js/lots.js`, `frontend/js/kanban.js`, `frontend/js/relatorio-tempos.js`, `frontend/js/dashboard.js`, `frontend/js/programacao-entregas.js`, `frontend/js/deliveries.js`). Nenhuma regra de negócio nova foi inventada; pontos sem confirmação direta no código estão marcados como **"precisa confirmar"**.

---

## 1. O problema atual

A tabela `producao_lotes` mantém **três campos relacionados ao estado do lote**, criados em momentos diferentes da evolução do sistema, com vocabulários e graus de confiabilidade distintos:

| Campo | Origem | Vocabulário observado | Quem escreve |
|---|---|---|---|
| `status` | Coluna original (`backend/setup.js`), legado | Português: `aguardando`, `em_producao`, `pausado`, `pronto`, `em_rota`, `entregue`, `rejeitado`, `finalizado` (e variação `Finalizado` com inicial maiúscula encontrada em produção) | Inserção inicial pelo `sync.js` (sempre `'aguardando'` para registros novos) e por rotas antigas/manuais do backend |
| `ff_lotStatus` | Coluna adicionada depois pelo FactoryFlow (`backend/server.js`, via `ALTER TABLE ADD COLUMN`) | Inglês: `idle`, `working`, `paused`, `rejected`, `finalizado`, `delivered`, ou vazio/`null` | Frontend (Kanban/`data.js`/`lots.js`) via `PATCH /api/producao/:id` |
| `setor_atual` | Coluna original (`backend/setup.js`) | Nomes de setor (`pesagem`, `producao`, `coloracao`, `laboratorio`, `pronto`, `entrega`, `entregue`, etc., e um valor `finalizado` fora da lista oficial de setores) | Frontend, ao avançar o lote de setor |

**Achado confirmado pela auditoria de dados (818 lotes, junho/2026):** `status` e `ff_lotStatus` **divergem** em uma fração relevante dos registros — por exemplo, 117 lotes com `status='em_producao'` e `ff_lotStatus='idle'` simultaneamente, 99 lotes com `status='em_producao'` e `ff_lotStatus='finalizado'`, 17 lotes com `status='entregue'` e `ff_lotStatus='idle'`, e 6 lotes com o valor mal padronizado `'Finalizado'` (inicial maiúscula) em `status` e `ff_lotStatus` nulo.

Isso significa que **qualquer código que decida "o lote está ativo?", "o lote está finalizado?" ou "o lote foi entregue?" usando apenas `status`** pode estar respondendo de forma diferente de um código que use `ff_lotStatus`/`setor_atual` para a mesma pergunta, sobre o mesmo lote, ao mesmo tempo. Isso é a causa raiz do problema: não há uma fonte única e confiável de verdade sendo respeitada por todo o sistema.

---

## 2. Decisão oficial de fonte de verdade

Esta é a decisão de arquitetura já registrada em `docs/FACTORYFLOW_REGRAS.md` (seção 3) e reafirmada aqui como referência técnica central:

1. **`setor_atual`** é a fonte de verdade de **onde o lote está** no fluxo de produção.
2. **`ff_lotStatus`** é a fonte de verdade do **estado operacional** do lote (parado, trabalhando, pausado, reprovado, finalizado, entregue).
3. **`status`** é **legado**. Deve ser tratado como **fallback** — só consultado quando `ff_lotStatus`/`setor_atual` estiverem ausentes — e **não deve ser base de nenhuma regra de negócio nova**.

Esta decisão **não exige migração de dados nem mudança de schema**. É uma diretriz de **como o código deve ler** os três campos a partir de agora, mantendo todos os três campos existentes intactos no banco.

---

## 3. Mapa recomendado de equivalência (`ff_lotStatus` ↔ significado)

| Valor de `ff_lotStatus` | Significado operacional | Observação |
|---|---|---|
| `idle` | Lote parado no setor atual, sem sessão de trabalho aberta | Estado padrão de espera dentro de um setor |
| `working` | Lote em produção ativa (sessão de trabalho aberta) | — |
| `paused` | Lote pausado (com motivo registrado em `ff_workSessions`) | Ver `docs/FACTORYFLOW_REGRAS.md`, seção 15 |
| `rejected` | Lote reprovado | Sai do fluxo ativo; não deve reaparecer no Kanban |
| `finalizado` | Lote concluiu sua produção/etapas | **Precisa confirmar**: não há, nos arquivos analisados, uma definição explícita e única de em que momento exato o frontend grava `finalizado` em `ff_lotStatus` (se é só ao chegar em setores finais como `pronto`/`entrega`/`entregue`, ou também em outras condições) |
| `delivered` | Lote entregue ao cliente | **Precisa confirmar**: relação exata com o setor `entregue` e com o status legado `entregue` — não foi localizado, nos arquivos analisados, o ponto exato do código que grava `delivered` em `ff_lotStatus` |
| `null` / vazio | Nenhum estado operacional registrado ainda | Ocorre em registros antigos ou criados antes da coluna existir; a auditoria encontrou 6 lotes nessa condição. Nesses casos, o fallback para `status` (item 4) é necessário |

---

## 4. Como tratar os valores legados de `status`

| Valor legado (`status`) | Tratamento recomendado quando usado como fallback |
|---|---|
| `aguardando` | Equivalente apropriado: `idle` (lote ainda não iniciou trabalho) |
| `em_producao` | Equivalente apropriado: `working` — **mas a auditoria mostrou que isso nem sempre é verdade** (pode estar `idle`, `paused` ou até `finalizado` em `ff_lotStatus`); usar apenas se `ff_lotStatus` estiver vazio |
| `pronto` | Não tem um valor único e exclusivo em `ff_lotStatus`; está associado ao setor `pronto`. Tratar como informação de **setor**, não de status operacional — **precisa confirmar** se deveria gerar algum `ff_lotStatus` específico |
| `em_rota` | **Não existe equivalente em `ff_lotStatus`** hoje. Esse valor descreve uma condição de logística de entrega (lote em rota), e o módulo de Programação de Entregas (seção 5) já trata isso corretamente lendo `status`/`mysql_status` diretamente, pois não há alternativa em `ff_lotStatus` — **este é um uso de `status` aceitável e intencional**, não um ponto a corrigir |
| `entregue` | Equivalente apropriado: `delivered` (quando presente) |
| `rejeitado` | Equivalente apropriado: `rejected` |
| `finalizado` | Equivalente apropriado: `finalizado` (mesmo nome, contextos diferentes) |
| `Finalizado` (inicial maiúscula) | **Bug de dado, não de regra.** É o mesmo significado de `finalizado`, mas grafado de forma inconsistente. Comparações devem normalizar para minúsculas antes de comparar (`String(valor).toLowerCase()`), nunca comparar por igualdade exata sem normalização. Corrigir a grafia em produção está fora do escopo deste documento (envolveria `UPDATE`, não autorizado nesta etapa) |

---

## 5. Módulos que ainda usam `status` legado como critério de decisão

Levantamento feito por leitura de código (sem alteração):

| Módulo | Onde | Como usa `status` hoje |
|---|---|---|
| **Kanban** | `frontend/js/data.js`, função `isActiveKanbanLot`; também `loadBridgeLots` | Monta a condição "lote ativo" verificando `lot.status \|\| lot.backendStatus \|\| lot.mysql_status \|\| lot.raw_mysql?.status \|\| lot.lotStatus` contra `ACTIVE_KANBAN_EXCLUDED_VALUES` (vocabulário em português) — ou seja, `status` legado é consultado **antes** de `lotStatus` (que reflete `ff_lotStatus`) |
| **Dashboard** | `frontend/js/dashboard.js`, função `ffDashLotSourceStatus` | Mesmo padrão: `lot.mysql_status \|\| lot.backendStatus \|\| lot.status \|\| lot.situacao \|\| lot.lotStatus`, comparado contra `FF_DASH_FINISHED_STATUSES` (também em português) |
| **Programação de entregas** | `frontend/js/programacao-entregas.js`, funções `_peIsRelevantLot` e `_peOrderStatus` | Usa `lot.status \|\| lot.mysql_status` para detectar `'em_rota'` e `'cancelado'/'rejeitado'`. Não há equivalente de `'em_rota'` em `ff_lotStatus` (ver seção 4) |
| **Bot WhatsApp** | `backend/server.js`, funções `consultarLotesPorSetorWhatsapp` e `resumoOperacionalWhatsapp` | Filtra diretamente em SQL: `LOWER(COALESCE(status,'')) NOT IN ('finalizado','cancelado')` para decidir quais lotes mostrar como "ativos" nas respostas do bot |
| **`/api/producao/ativos`** | `backend/server.js` (rota usada pelo Kanban no carregamento inicial — comentário no código: "Usada pelo Kanban no carregamento inicial") | Filtra em SQL: `LOWER(COALESCE(pl.status,'')) NOT IN ('entregue','finalizado','cancelado','rejeitado') AND LOWER(COALESCE(pl.setor_atual,'')) NOT IN (...)` — ou seja, `status` e `setor_atual` decidem juntos, **sem considerar `ff_lotStatus`** |

---

## 6. Riscos de alterar a prioridade nesses módulos

- **Risco principal: mudança silenciosa de quais lotes aparecem como "ativos".** A auditoria confirmou que, hoje, ~280 dos 818 lotes têm `status` e `ff_lotStatus` divergentes. Se qualquer um dos cinco módulos acima passar a priorizar `ff_lotStatus` sobre `status` sem antes alinhar o vocabulário, um número não trivial de lotes pode **desaparecer** do Kanban/Dashboard (se estavam visíveis por `status` mas `ff_lotStatus` indica finalizado) ou **reaparecer** (se estavam ocultos por `status='entregue'` mas `ff_lotStatus='idle'`).
- **Risco de vocabulário incompatível.** `ACTIVE_KANBAN_EXCLUDED_VALUES` (Kanban) e `FF_DASH_FINISHED_STATUSES` (Dashboard) usam termos em português (`entregue`, `finalizado`, `cancelado`, `rejeitado`) — os mesmos termos do `status` legado, não os termos em inglês de `ff_lotStatus` (`delivered`, `finalizado`, `rejected`). Trocar a prioridade de leitura **sem criar um conjunto de exclusão equivalente em inglês primeiro** tornaria a comparação praticamente inofensiva (porque os valores não coincidem) ou, pior, causaria comportamento inconsistente entre lotes que têm `ff_lotStatus` preenchido e os que não têm.
- **Risco de regressão no bot WhatsApp e na rota `/api/producao/ativos`.** Ambos fazem a filtragem **diretamente em SQL**. Qualquer mudança ali afeta o resultado da consulta antes mesmo de chegar ao JavaScript — um erro de lógica SQL (ex.: `COALESCE` mal aplicado) pode causar listas vazias ou listas com lotes indevidos sem nenhum erro visível na aplicação.
- **Risco de regressão na Programação de Entregas.** Esse módulo é o único que usa `status` para um conceito (`em_rota`) que **não tem substituto** em `ff_lotStatus`. Uma alteração genérica de prioridade que ignore esse caso específico quebraria a visualização de "pedidos em rota de entrega".
- **Ausência de testes automatizados confirmada.** Não foi localizado, nos arquivos analisados, nenhum teste automatizado (unitário ou de integração) cobrindo essas funções de decisão de status — **precisa confirmar** se existem testes em outro diretório não analisado nesta tarefa. Sem testes, qualquer alteração nesses pontos depende de validação manual cuidadosa.

---

## 7. Plano seguro em fases para migração futura

> Nenhuma fase abaixo foi executada. É um plano para decisão e execução futuras, sujeitas a aprovação separada.

**Fase 0 — Preparação (sem risco, somente leitura/observação)**
- Confirmar manualmente os pontos marcados "precisa confirmar" neste documento (seções 3 e 4), especialmente quando/onde `ff_lotStatus` é gravado como `finalizado`/`delivered`.
- Mapear, para os ~280 lotes divergentes já identificados, se a divergência é um problema real (lote com estado errado) ou apenas um reflexo de dados antigos que nunca mais serão tocados.

**Fase 1 — Criar vocabulário de equivalência no código (aditivo, sem mudar comportamento)**
- Introduzir, em cada módulo listado na seção 5, uma função utilitária única que traduza `status` legado para o vocabulário de `ff_lotStatus` (a tabela da seção 4 pode servir de base), sem ainda mudar a ordem de prioridade nem o resultado final das funções de decisão.
- Adicionar esse valor traduzido como **campo extra** ao lado dos existentes (como já foi feito, em etapa anterior, com `ff_lot_status` na resposta de `/api/producao/relatorio-tempos`), para permitir comparação lado a lado em ambiente de homologação antes de qualquer troca real de prioridade.

**Fase 2 — Validação em homologação (sem produção)**
- Em ambiente de homologação com uma cópia do banco, comparar o resultado de "lote ativo" calculado pela lógica atual (baseada em `status`) com o resultado calculado pela lógica nova (baseada em `ff_lotStatus`/`setor_atual`) para os mesmos 818+ lotes.
- Listar e revisar manualmente todos os lotes onde os dois resultados diferem antes de decidir qual prevalece.

**Fase 3 — Troca de prioridade módulo por módulo (com decisão de negócio explícita por módulo)**
- Trocar a prioridade em **um módulo por vez** (sugestão de ordem, do menor para o maior risco de impacto visível): Dashboard → Bot WhatsApp → Programação de Entregas (apenas a parte que não envolve `em_rota`) → Kanban (`isActiveKanbanLot`/`loadBridgeLots`) → `/api/producao/ativos`.
- Cada troca exige aprovação explícita do responsável de negócio, por afetar diretamente o que aparece nas telas operacionais.

**Fase 4 — Limpeza/normalização de dados (fora do escopo de código)**
- Avaliar, separadamente, um `UPDATE` controlado para corrigir o valor mal grafado `'Finalizado'` e, possivelmente, popular `ff_lotStatus` nos 6 registros que hoje estão nulos — **esta fase envolve alteração de dados de produção e não deve ser executada como parte de nenhuma etapa de leitura/código**.

---

## 8. Checklist de testes antes de qualquer alteração real

- [ ] Confirmar, em ambiente de homologação (nunca produção), a contagem total de "lotes ativos" antes e depois da mudança, para os mesmos filtros, nos seguintes pontos: Kanban, Dashboard, `/api/producao/ativos`, bot WhatsApp.
- [ ] Listar manualmente os lotes cujo resultado de "ativo/inativo" muda entre a lógica antiga e a nova, e obter validação humana de que a nova resposta está correta para cada um.
- [ ] Confirmar que a Programação de Entregas continua identificando corretamente lotes `em_rota` após qualquer mudança (esse conceito não existe em `ff_lotStatus`, então não deve ser afetado, mas precisa ser testado para garantir que nenhuma alteração colateral o atingiu).
- [ ] Confirmar que lotes reprovados (`rejected`) continuam sumindo do Kanban corretamente nos dois cenários (quando só `status='rejeitado'` está setado e quando só `ff_lotStatus='rejected'` está setado).
- [ ] Confirmar que o valor mal grafado `'Finalizado'` (inicial maiúscula) é tratado de forma equivalente a `'finalizado'` em qualquer nova lógica de comparação (normalização para minúsculas antes de comparar).
- [ ] Validar que nenhuma rota SQL alterada (bot WhatsApp, `/api/producao/ativos`) introduziu uma condição que silenciosamente retorne zero resultados (testar com dados reais de homologação, não apenas dados sintéticos).
- [ ] Obter aprovação explícita do responsável de negócio para cada módulo antes de subir a mudança de prioridade para produção (ver Fase 3 do plano).
- [ ] Após qualquer alteração subir para produção, monitorar por pelo menos um ciclo completo de expediente (ver `docs/FACTORYFLOW_REGRAS.md`, seção 14) para confirmar que a quantidade de lotes visíveis no Kanban permanece estável e consistente com a operação real.
