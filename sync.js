'use strict';

require('dotenv').config();
const { dbPool } = require('./db');

const syncStats = {
  totalSyncs: 0,
  totalInserted: 0,
  lastRunAt: null,
  lastError: null,
  intervalMs: Number(process.env.SYNC_INTERVAL_MS || 10000),
};

async function runSync() {
  let inserted = 0;

  const [rows] = await dbPool.query(`
    SELECT
      p.pits_numero       AS numero_pedido,
      p.pits_op           AS op,
      p.pits_produto      AS produto_codigo,
      p.pits_nome_produto AS produto_nome,
      p.pits_qtde         AS quantidade,
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
    ORDER BY p.id DESC
  `);

  for (const row of rows) {
    const [result] = await dbPool.query(`
      INSERT IGNORE INTO producao_lotes (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando', 'moagem')
    `, [
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
    ]);

    if (result.affectedRows > 0) {
      inserted++;
    }
  }

  syncStats.totalSyncs += 1;
  syncStats.totalInserted += inserted;
  syncStats.lastRunAt = new Date().toISOString();
  syncStats.lastError = null;

  if (inserted > 0) {
    console.log(`🔄 Sync concluído | novos lotes inseridos: ${inserted}`);
  }

  return {
    inserted,
    totalLidos: rows.length,
    ...syncStats,
  };
}

function startSync() {
  console.log(`🔄 Sincronização iniciada (intervalo: ${syncStats.intervalMs / 1000}s)`);

  runSync().catch(err => {
    syncStats.lastError = err.message;
    console.error('❌ Erro no sync inicial:', err.message);
  });

  setInterval(async () => {
    try {
      await runSync();
    } catch (err) {
      syncStats.lastError = err.message;
      console.error('❌ Erro na sincronização:', err.message);
    }
  }, syncStats.intervalMs);
}

function getSyncStats() {
  return syncStats;
}

module.exports = { runSync, startSync, getSyncStats };