'use strict';

require('dotenv').config();
const { dbPool } = require('./db');

const syncStats = {
  totalSyncs: 0,
  totalInserted: 0,
  totalUpdated: 0,
  totalRead: 0,
  lastRunAt: null,
  lastError: null,
  intervalMs: Number(process.env.SYNC_INTERVAL_MS || 10000),
};

const START_ID = Number(process.env.SYNC_START_ID || 0);
let lastImportedId = START_ID;
let syncTimer = null;

// =========================
// Helpers
// =========================

async function ensureSyncStateTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      chave VARCHAR(100) NOT NULL PRIMARY KEY,
      valor VARCHAR(255) NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

async function tableExists(tableName) {
  const [rows] = await dbPool.query(
    `
      SELECT COUNT(*) AS total
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = ?
    `,
    [tableName]
  );

  return Number(rows[0]?.total || 0) > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await dbPool.query(
    `
      SELECT COUNT(*) AS total
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
    `,
    [tableName, columnName]
  );

  return Number(rows[0]?.total || 0) > 0;
}

async function indexExists(tableName, indexName) {
  const [rows] = await dbPool.query(
    `
      SELECT COUNT(*) AS total
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND index_name = ?
    `,
    [tableName, indexName]
  );

  return Number(rows[0]?.total || 0) > 0;
}

// =========================
// Garantias estruturais
// =========================

async function ensureProducaoLotesTable() {
  const exists = await tableExists('producao_lotes');

  if (!exists) {
    throw new Error(
      'A tabela producao_lotes não existe. Crie essa tabela antes de iniciar o sync.'
    );
  }
}

async function ensureOrigemItemIdColumn() {
  const exists = await columnExists('producao_lotes', 'origem_item_id');

  if (!exists) {
    await dbPool.query(`
      ALTER TABLE producao_lotes
      ADD COLUMN origem_item_id INT NULL
    `);

    console.log('🧩 Coluna origem_item_id adicionada em producao_lotes');
  }
}

async function ensureOrigemItemIdUniqueIndex() {
  const exists = await indexExists('producao_lotes', 'ux_producao_lotes_origem_item_id');

  if (!exists) {
    await dbPool.query(`
      ALTER TABLE producao_lotes
      ADD UNIQUE KEY ux_producao_lotes_origem_item_id (origem_item_id)
    `);

    console.log('🔒 Índice único criado para origem_item_id em producao_lotes');
  }
}

async function ensureSyncStructure() {
  await ensureSyncStateTable();
  await ensureProducaoLotesTable();
  await ensureOrigemItemIdColumn();
  await ensureOrigemItemIdUniqueIndex();
}

// =========================
// Estado do sync
// =========================

async function loadLastImportedId() {
  await ensureSyncStateTable();

  const [rows] = await dbPool.query(
    `SELECT valor FROM sync_state WHERE chave = 'last_imported_pedido_id' LIMIT 1`
  );

  if (rows.length === 0) {
    await dbPool.query(
      `INSERT INTO sync_state (chave, valor) VALUES ('last_imported_pedido_id', ?)`,
      [String(START_ID)]
    );

    lastImportedId = START_ID;
    console.log(`🟡 Sync iniciado a partir do id ${START_ID}`);
    return;
  }

  lastImportedId = Number(rows[0].valor || START_ID);
  console.log(`🟡 Último id importado carregado: ${lastImportedId}`);
}

async function saveLastImportedId(id) {
  lastImportedId = Number(id) || 0;

  await dbPool.query(
    `
      INSERT INTO sync_state (chave, valor)
      VALUES ('last_imported_pedido_id', ?)
      ON DUPLICATE KEY UPDATE valor = VALUES(valor)
    `,
    [String(lastImportedId)]
  );
}

// =========================
// Sync principal
// =========================

async function runSync() {
  let inserted = 0;
  let updated = 0;
  let maxIdSeen = lastImportedId;

  await ensureSyncStructure();

  const [rows] = await dbPool.query(
    `
      SELECT
        p.id                AS origem_item_id,
        p.pits_numero       AS numero_pedido,
        p.pits_op           AS op,
        p.pits_previsao     AS previsao,
        p.pits_produto      AS produto_codigo,
        p.pits_nome_produto AS produto_nome,
        p.pits_qtde         AS quantidade,
        p.pits_peso         AS peso,
        p.pits_revisao      AS revisao,
        p.pits_viscosidade  AS viscosidade,
        p.pits_densidade    AS densidade,
        p.pits_fineza       AS fineza,
        c.cli_codigo        AS cliente_codigo,
        c.cli_nome          AS cliente_nome,
        c.cli_endereco      AS cliente_endereco,
        c.cli_bairro        AS cliente_bairro,
        c.cli_cidade        AS cliente_cidade,
        c.cli_cep           AS cliente_cep,
        c.cli_estado        AS cliente_estado
      FROM cli_pedidos_itens p
      INNER JOIN cli_clientes c
        ON c.cli_codigo = p.pits_cliente
      WHERE p.id > ?
      ORDER BY p.id ASC
    `,
    [lastImportedId]
  );

  for (const row of rows) {
    const [result] = await dbPool.query(
      `
        INSERT INTO producao_lotes (
          origem_item_id,
          numero_pedido,
          op,
          produto_codigo,
          produto_nome,
          quantidade,
          cliente_codigo,
          cliente_nome,
          cliente_endereco,
          cliente_bairro,
          cliente_cidade,
          cliente_cep,
          cliente_estado,
          status,
          setor_atual
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando', 'moagem')
        ON DUPLICATE KEY UPDATE
          numero_pedido = VALUES(numero_pedido),
          op = VALUES(op),
          produto_codigo = VALUES(produto_codigo),
          produto_nome = VALUES(produto_nome),
          quantidade = VALUES(quantidade),
          cliente_codigo = VALUES(cliente_codigo),
          cliente_nome = VALUES(cliente_nome),
          cliente_endereco = VALUES(cliente_endereco),
          cliente_bairro = VALUES(cliente_bairro),
          cliente_cidade = VALUES(cliente_cidade),
          cliente_cep = VALUES(cliente_cep),
          cliente_estado = VALUES(cliente_estado)
      `,
      [
        row.origem_item_id,
        row.numero_pedido || '',
        row.op || '',
        row.produto_codigo || '',
        row.produto_nome || '',
        row.quantidade || 0,
        row.cliente_codigo || '',
        row.cliente_nome || '',
        row.cliente_endereco || '',
        row.cliente_bairro || '',
        row.cliente_cidade || '',
        row.cliente_cep || '',
        row.cliente_estado || '',
      ]
    );

    if (result.affectedRows === 1) {
      inserted += 1;
    } else if (result.affectedRows === 2) {
      updated += 1;
    }

    if (row.origem_item_id > maxIdSeen) {
      maxIdSeen = row.origem_item_id;
    }
  }

  if (maxIdSeen > lastImportedId) {
    await saveLastImportedId(maxIdSeen);
  }

  syncStats.totalSyncs += 1;
  syncStats.totalInserted += inserted;
  syncStats.totalUpdated += updated;
  syncStats.totalRead += rows.length;
  syncStats.lastRunAt = new Date().toISOString();
  syncStats.lastError = null;

  if (rows.length > 0 || inserted > 0 || updated > 0) {
    console.log(
      `🔄 Sync concluído | lidos: ${rows.length} | inseridos: ${inserted} | atualizados: ${updated} | último id: ${lastImportedId}`
    );
  }

  return {
    inserted,
    updated,
    totalLidos: rows.length,
    lastImportedId,
    ...syncStats,
  };
}

// =========================
// Inicialização automática
// =========================

function startSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  console.log(`🔄 Sincronização iniciada (intervalo: ${syncStats.intervalMs / 1000}s)`);

  loadLastImportedId()
    .then(() => runSync())
    .catch((err) => {
      syncStats.lastError = err.message;
      console.error('❌ Erro no sync inicial:', err.message);
    });

  syncTimer = setInterval(async () => {
    try {
      await runSync();
    } catch (err) {
      syncStats.lastError = err.message;
      console.error('❌ Erro na sincronização:', err.message);
    }
  }, syncStats.intervalMs);
}

// =========================
// Stats
// =========================

function getSyncStats() {
  return {
    ...syncStats,
    lastImportedId,
    startId: START_ID,
  };
}

module.exports = {
  runSync,
  startSync,
  getSyncStats,
};