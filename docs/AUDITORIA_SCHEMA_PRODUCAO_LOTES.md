# Auditoria de Schema — `producao_lotes` (somente leitura)

> Auditoria executada via consultas `SHOW CREATE TABLE`, `DESCRIBE`, `SHOW INDEX` e `SELECT` (somente leitura) contra o banco real, usando credenciais lidas exclusivamente de `process.env` (via `backend/db.js`). Nenhum valor de credencial foi exibido ou registrado. Nenhum `ALTER`/`UPDATE`/`DELETE`/`INSERT`/`DROP`/`CREATE` foi executado. Nenhum dado de produção foi alterado.

---

## 1. Tabelas e campos usados por arquivo (mapeamento de código)

| Arquivo | Tabelas | Campos relevantes |
|---|---|---|
| `backend/setup.js` | `producao_lotes` (CREATE TABLE original) | Define `numero_pedido`, `op`, dados de produto/cliente, `status`, `prioridade`, `classificado_pcp`, `liberado_pcp`, `setor_atual`, e `UNIQUE KEY uq_pedido_op (numero_pedido, op)` |
| `backend/sync.js` | `producao_lotes`, `cli_pedidos_itens`, `cli_clientes`, `sync_state` | Lê do ERP via `cli_pedidos_itens JOIN cli_clientes`; cria coluna `origem_item_id` e `UNIQUE KEY ux_producao_lotes_origem_item_id (origem_item_id)` se não existir; usa `INSERT ... ON DUPLICATE KEY UPDATE` por `origem_item_id`; mantém cursor em `sync_state.last_imported_pedido_id` |
| `backend/server.js` | `producao_lotes`, `cli_pedidos_itens`, `cli_clientes`, `ff_sector_shifts`, `ff_sector_shift_events`, `ff_pedidos_datas` | Cria/verifica colunas `ff_lotStatus`, `ff_sectorEnteredAt`, `ff_workSessions`, `ff_expedientePausedStatus`, `ff_history`, `ff_sectorMetrics`, `origem`, `linha_produto` via `columnExists`/`ALTER TABLE ADD COLUMN` (idempotente); todas as rotas `/api/producao*` leem/escrevem nesses campos; relatório de tempos (`rt*`) lê `ff_history`, `ff_workSessions`, `ff_sectorMetrics` |
| `frontend/js/data.js` | (via API, sem SQL direto) | Consome `ff_lotStatus` (→ `lotStatus`), `ff_history` (→ `history`), `ff_workSessions` (→ `workSessions`), `ff_sectorMetrics` (→ `sectorMetrics`), `ff_sectorEnteredAt`, `setor_atual`, `status`, `tipo_lote`, `op`, `numero_pedido` |
| `frontend/js/lots.js` | (via API) | Consome os mesmos campos de `data.js` para decidir o próximo setor (`getNextSectorOptions`) e overrides por tipo de produto (base/verniz) |
| `frontend/js/relatorio-tempos.js` | (via API, endpoint `GET /api/producao/relatorio-tempos`) | Consome `history`/`ff_history`, `workSessions`/`ff_workSessions`, `sectorMetrics`/`ff_sectorMetrics`, `status`, `op`, `numero_pedido`, `produto_codigo`/`produto_nome`, `cliente_nome` |

---

## 2. Schema real encontrado (`SHOW CREATE TABLE producao_lotes`)

```sql
CREATE TABLE `producao_lotes` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `numero_pedido` varchar(50) NOT NULL,
  `op` varchar(50) NOT NULL,
  `produto_codigo` varchar(100) NOT NULL DEFAULT '',
  `produto_nome` varchar(255) NOT NULL DEFAULT '',
  `tipo_lote` varchar(30) DEFAULT NULL,
  `quantidade` decimal(15,4) NOT NULL DEFAULT 0.0000,
  `cliente_codigo` varchar(50) NOT NULL DEFAULT '',
  `cliente_nome` varchar(255) NOT NULL DEFAULT '',
  `cliente_endereco` varchar(255) NOT NULL DEFAULT '',
  `cliente_bairro` varchar(100) NOT NULL DEFAULT '',
  `cliente_cidade` varchar(100) NOT NULL DEFAULT '',
  `cliente_cep` varchar(20) NOT NULL DEFAULT '',
  `cliente_estado` varchar(2) NOT NULL DEFAULT '',
  `status` varchar(50) NOT NULL DEFAULT 'aguardando',
  `prioridade` varchar(20) DEFAULT 'normal',
  `classificado_pcp` tinyint(1) DEFAULT 0,
  `liberado_pcp` tinyint(1) DEFAULT 0,
  `setor_atual` varchar(50) NOT NULL DEFAULT 'moagem',
  `data_criacao` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `origem_item_id` int(11) DEFAULT NULL,
  `origem` varchar(20) DEFAULT 'AUTO',
  `linha_produto` varchar(100) DEFAULT NULL,
  `cq_resultado` varchar(50) DEFAULT NULL,
  `cq_analise_id` int(11) DEFAULT NULL,
  `cq_reajustes` int(11) DEFAULT 0,
  `cq_aprovado_em` datetime DEFAULT NULL,
  `cq_status` varchar(50) DEFAULT 'pendente',
  `ff_lotStatus` varchar(50) DEFAULT NULL,
  `ff_sectorEnteredAt` bigint(20) DEFAULT NULL,
  `ff_workSessions` longtext DEFAULT NULL,
  `ff_expedientePausedStatus` varchar(50) DEFAULT NULL,
  `ff_history` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ff_sectorMetrics` longtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pedido_op` (`numero_pedido`,`op`),
  UNIQUE KEY `ux_producao_lotes_origem_item_id` (`origem_item_id`),
  KEY `idx_producao_lotes_op` (`op`)
) ENGINE=InnoDB AUTO_INCREMENT=823 DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci
```

Total de linhas na tabela: **818**.

Observação: a coluna `ff_history` está em `utf8mb4`, enquanto o restante da tabela está em `utf8` (charset legado) — mistura de charsets dentro da mesma tabela, criada por migrações incrementais (`setup.js` original em `utf8`, colunas `ff_*` adicionadas depois pelo `server.js`).

---

## 3. Índices reais encontrados (`SHOW INDEX`)

| Key_name | Não-único? | Colunas |
|---|---|---|
| `PRIMARY` | Não (único) | `id` |
| `uq_pedido_op` | Não (único) | `numero_pedido`, `op` |
| `ux_producao_lotes_origem_item_id` | Não (único) | `origem_item_id` |
| `idx_producao_lotes_op` | Sim (não-único) | `op` |

**As duas constraints UNIQUE coexistem na tabela real.** A hipótese levantada em `FACTORYFLOW_REGRAS.md` (seção 17) de que uma delas estaria "desatualizada/sem efeito" está **confirmada como incorreta**: ambas estão ativas e ambas são respeitadas pelo MySQL simultaneamente. Isso significa que qualquer `INSERT` precisa satisfazer as duas regras de unicidade ao mesmo tempo.

---

## 4. Diferença real entre `setup.js` e `sync.js`

- `backend/setup.js` cria a tabela do zero com `UNIQUE KEY uq_pedido_op (numero_pedido, op)` — é a constraint **original**, pensada para o cenário "um pedido + uma OP = um lote único".
- `backend/sync.js`, ao rodar, verifica se a coluna `origem_item_id` existe (`ensureOrigemItemIdColumn`) e cria a coluna + `UNIQUE KEY ux_producao_lotes_origem_item_id` (`ensureOrigemItemIdUniqueIndex`) **se ainda não existirem** — ou seja, é uma migração aditiva que roda em cima de uma tabela já criada por `setup.js`.
- Resultado real (confirmado nesta auditoria): a tabela tem **as duas constraints simultaneamente**. `setup.js` não foi substituído por `sync.js` — foi complementado.
- O `sync.js` usa `origem_item_id` (id da linha em `cli_pedidos_itens`) como chave de dedupe no `ON DUPLICATE KEY UPDATE`, não `(numero_pedido, op)`. Isso funciona, mas só é seguro porque, até hoje, **nenhum pedido do ERP gerou duplicidade de `(numero_pedido, op)`** (confirmado abaixo, seção 5) — se algum dia o ERP reaproveitar um par `(numero_pedido, op)` para itens diferentes (`origem_item_id` diferentes), o `INSERT` do sync vai **falhar** por violar `uq_pedido_op`, mesmo que `origem_item_id` seja novo e único.

---

## 5. Riscos de duplicação

Consultas de duplicidade executadas (somente leitura) na base atual (818 linhas):

| Verificação | Resultado |
|---|---|
| Duplicidade por `TRIM(op)` | **0 encontradas** |
| Duplicidade por `(TRIM(numero_pedido), TRIM(op))` | **0 encontradas** |
| Duplicidade por `origem_item_id` (entre não-nulos) | **0 encontradas** |
| Linhas com `origem_item_id IS NULL` | **816 de 818** (99,7%) |

**Não há duplicidade hoje.** Mas há um risco estrutural relevante: **816 das 818 linhas não têm `origem_item_id` preenchido** (apenas 2 linhas têm). Isso indica que a grande maioria dos lotes na tabela foi criada **antes** da coluna `origem_item_id` existir, ou por um caminho que não passa pelo `sync.js` (ex.: `POST /api/producao/manual`, `POST /api/lotes`, ou uma carga inicial). Como a constraint `UNIQUE (origem_item_id)` do MySQL trata múltiplos `NULL` como valores distintos (comportamento padrão do MySQL/InnoDB), isso **não gera erro hoje**, mas também significa que a dedupe por `origem_item_id` está, na prática, protegendo uma fração muito pequena da tabela. A proteção real contra duplicidade, para a maior parte dos dados existentes, ainda depende de `uq_pedido_op`.

**Risco identificado:** se o processo de sincronização for re-executado para o histórico completo (reimportação) ou se houver mudança no ERP que gere um novo `origem_item_id` para um pedido/OP que já existe na tabela (ex.: pedido cancelado e recriado no ERP com novo id, mas mesmo número de pedido/OP), o `INSERT ... ON DUPLICATE KEY UPDATE` vai colidir com `uq_pedido_op` em vez de `ux_producao_lotes_origem_item_id`, e o comportamento de atualização passa a depender de **qual das duas chaves o MySQL reporta como conflito primeiro** — isso não foi testado nesta auditoria (auditoria é somente leitura) e **precisa ser confirmado/testado em ambiente controlado**, não em produção.

---

## 6. Uso de `status` e `ff_lotStatus` (campos de status ativos)

Ambos os campos estão **ativos e em uso simultâneo**, com vocabulários diferentes:

**`status` (coluna legada, criada por `setup.js`)** — valores reais encontrados:

| status | qtd |
|---|---|
| `finalizado` | 490 |
| `em_producao` | 227 |
| `pronto` | 39 |
| `em_rota` | 36 |
| `entregue` | 23 |
| `rejeitado` | 3 |

Nota: o `DEFAULT` da coluna é `'aguardando'`, mas **nenhuma linha atual tem esse valor** — ou seja, o valor default nunca é observado em produção hoje (todas as linhas já avançaram de status, ou o valor inicial é sobrescrito imediatamente por outro processo).

**`ff_lotStatus` (coluna adicionada pelo FactoryFlow/`server.js`)** — valores reais encontrados:

| ff_lotStatus | qtd |
|---|---|
| `finalizado` | 584 |
| `idle` | 212 |
| `working` | 7 |
| `null` (vazio) | 6 |
| `paused` | 4 |
| `rejected` | 3 |
| `delivered` | 2 |

**Divergência confirmada entre os dois campos** (cruzamento `status` × `ff_lotStatus`):

| status | ff_lotStatus | qtd | Observação |
|---|---|---|---|
| `finalizado` | `finalizado` | 481 | consistente |
| `em_producao` | `idle` | 117 | **divergente** — status diz "em produção" mas ff_lotStatus diz "parado" |
| `em_producao` | `finalizado` | 99 | **divergente** — status diz "em produção" mas ff_lotStatus diz "finalizado" |
| `pronto` | `idle` | 39 | **divergente** |
| `em_rota` | `idle` | 36 | **divergente** |
| `entregue` | `idle` | 17 | **divergente** |
| `em_producao` | `working` | 7 | consistente (semanticamente) |
| `Finalizado` (com inicial maiúscula) | `null` | 6 | **bug de dado**: valor com capitalização diferente de todos os outros (`finalizado` minúsculo), e sem `ff_lotStatus` preenchido |
| `entregue` | `finalizado` | 4 | **divergente** |
| `em_producao` | `paused` | 4 | consistente (semanticamente) |
| `rejeitado` | `rejected` | 3 | consistente (semanticamente) |
| `finalizado` | `idle` | 3 | **divergente** |
| `entregue` | `delivered` | 2 | consistente (semanticamente) |

**Conclusão:** os dois campos não são sincronizados de forma confiável. `status` parece ser atualizado por um fluxo (possivelmente o `sync.js` ou rotas mais antigas) enquanto `ff_lotStatus` é o campo realmente controlado pelo frontend/Kanban (`data.js`/`lots.js`). O campo `setor_atual` (distribuição: `entregue` 659, `entrega` 44, `pronto` 40, `pcp_liberacao` 21, `pesagem` 19, `laboratorio` 10, `finalizado` 8, `laboratorio_revisao` 7, `envase_produzir` 3, `coloracao` 3, `producao` 3, `envase_enlatamento` 1) parece ser o indicador mais confiável de "onde o lote está", mas também tem um valor (`finalizado`) que não está na lista de setores documentada em `data.js` (`SECTOR_LABELS`), sugerindo uso legado ou de um fluxo não mapeado nesta documentação.

---

## 7. Recomendação de correção futura (não aplicada)

> Estas recomendações **não foram aplicadas**. São sugestões para uma etapa futura, a ser decidida e autorizada separadamente.

1. **Definir uma única fonte de verdade para o status do lote.** Hoje `status`, `ff_lotStatus` e `setor_atual` coexistem com significados parcialmente sobrepostos e nem sempre consistentes. Recomenda-se decidir qual campo é autoritativo e tratar os demais como derivados/legados, com um plano de migração (não uma alteração imediata).
2. **Investigar e corrigir a origem do valor `'Finalizado'`** (capitalizado) nas 6 linhas afetadas — provavelmente um insert/update feito por um caminho de código diferente do padrão (ex.: script manual, migração antiga, ou uma rota que não normaliza o valor antes de salvar).
2.1. Mapear de onde vêm as 6 linhas com `ff_lotStatus = null` para entender se são lotes "órfãos" de uma migração incompleta.
3. **Avaliar se a constraint `uq_pedido_op` ainda deve ser a chave primária de negócio**, ou se `origem_item_id` deveria ser promovido a chave de negócio principal — hoje as duas convivem, mas 816/818 linhas não têm `origem_item_id`, o que sugere que essa coluna só cobre dados recentes (pós-implementação do sync atual). Antes de qualquer mudança de constraint, seria necessário um plano de backfill de `origem_item_id` para os registros antigos, fora do escopo desta auditoria.
4. **Testar em ambiente de homologação** (não em produção) o comportamento do `INSERT ... ON DUPLICATE KEY UPDATE` do `sync.js` quando há colisão simultânea nas duas UNIQUE keys, para confirmar qual delas o MySQL prioriza e se o `UPDATE` aplicado é o esperado.
5. **Padronizar o charset da tabela** (hoje misto entre `utf8`/`utf8_unicode_ci` na tabela e `utf8mb4`/`utf8mb4_unicode_ci` na coluna `ff_history`) em uma futura migração controlada, para evitar problemas de comparação/collation entre colunas.

---

## 8. Resumo objetivo

- **Existe `UNIQUE` em `origem_item_id`?** Sim — `ux_producao_lotes_origem_item_id`.
- **Existe `UNIQUE` em `numero_pedido + op`?** Sim — `uq_pedido_op`. **As duas coexistem na mesma tabela.**
- **Há duplicidades hoje?** Não. 0 duplicidades por OP, por `(numero_pedido, op)` e por `origem_item_id` nas 818 linhas atuais.
- **Quais campos de status estão ativos?** Três: `status` (legado, 6 valores em uso), `ff_lotStatus` (FactoryFlow/frontend, 6 valores + nulos), e `setor_atual` (12 valores em uso). Os três coexistem e **divergem entre si** em uma parte relevante dos registros (ex.: 117 linhas com `status='em_producao'` mas `ff_lotStatus='idle'`).
- **Correção recomendada para a próxima etapa:** definir formalmente qual campo é a fonte de verdade do status do lote (recomendação: `ff_lotStatus` + `setor_atual`, já que são os campos efetivamente usados pelo Kanban/Relatório de Tempos), tratar `status` como legado/derivado, corrigir o valor capitalizado incorretamente (`'Finalizado'`), e planejar um backfill de `origem_item_id` para os 816 registros que hoje não o possuem — tudo isso como mudanças futuras, a serem autorizadas e testadas separadamente, fora desta auditoria.
