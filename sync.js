// =============================================
// SYNC.JS – Sincronização automática
// MySQL Empresa → producao_lotes (local)
// Executa a cada SYNC_INTERVAL_MS (padrão 10s)
// =============================================

'use strict';

require('dotenv').config();
const { empresaPool, localPool } = require('./db');

// ── Query: pedidos da empresa com JOIN de clientes ────────
const QUERY_PEDIDOS = `
  SELECT
    p.pits_numero        AS numero_pedido,
    p.pits_op            AS op,
    p.pits_produto       AS produto_codigo,
    p.pits_nome_produto  AS produto_nome,
    p.pits_qtde          AS quantidade,
    c.cli_codigo         AS cliente_codigo,
    c.cli_nome           AS cliente_nome,
    COALESCE(c.cli_endereco, '') AS cliente_endereco,
    COALESCE(c.cli_bairro,   '') AS cliente_bairro,
    COALESCE(c.cli_cidade,   '') AS cliente_cidade,
    COALESCE(c.cli_cep,      '') AS cliente_cep,
    COALESCE(c.cli_estado,   '') AS cliente_estado
  FROM cli_pedidos_itens  p
  INNER JOIN cli_clientes c
    ON c.cli_codigo = p.pits_cliente
  WHERE p.pits_numero IS NOT NULL
    AND p.pits_op     IS NOT NULL
  ORDER BY p.pits_numero, p.pits_op
`;

// ── Verifica se o lote já existe no banco local ───────────
const QUERY_EXISTS = `
  SELECT id
  FROM   producao_lotes
  WHERE  numero_pedido = ?
    AND  op            = ?
  LIMIT  1
`;

// ── Insere novo lote no banco local ──────────────────────
const QUERY_INSERT = `
  INSERT INTO producao_lotes (
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
    setor_atual,
    data_criacao
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando', 'moagem', NOW())
`;

// ── Contadores para log ───────────────────────────────────
let totalSyncs    = 0;
let totalInserted = 0;

/**
 * Executa um ciclo completo de sincronização:
 * 1. Lê todos os pedidos + clientes da empresa
 * 2. Para cada registro, verifica se já existe localmente
 * 3. Se não existir, insere
 * Retorna { checked, inserted, errors }
 */
async function runSync() {
  let checked  = 0;
  let inserted = 0;
  let errors   = 0;

  let empresaConn = null;
  let localConn   = null;

  try {
    // Obtém conexões dos dois pools
    empresaConn = await empresaPool.getConnection();
    localConn   = await localPool.getConnection();

    // 1. Busca pedidos na empresa
    const [pedidos] = await empresaConn.query(QUERY_PEDIDOS);
    checked = pedidos.length;

    if (checked === 0) {
      return { checked: 0, inserted: 0, errors: 0 };
    }

    // 2. Processa cada pedido individualmente
    for (const row of pedidos) {
      try {
        // Verifica existência
        const [existRows] = await localConn.query(QUERY_EXISTS, [
          String(row.numero_pedido).trim(),
          String(row.op).trim(),
        ]);

        // Pula se já existir
        if (existRows.length > 0) continue;

        // Insere novo lote
        await localConn.query(QUERY_INSERT, [
          String(row.numero_pedido).trim(),
          String(row.op).trim(),
          String(row.produto_codigo || '').trim(),
          String(row.produto_nome   || '').trim(),
          parseFloat(row.quantidade) || 0,
          String(row.cliente_codigo || '').trim(),
          String(row.cliente_nome   || '').trim(),
          String(row.cliente_endereco || '').trim(),
          String(row.cliente_bairro   || '').trim(),
          String(row.cliente_cidade   || '').trim(),
          String(row.cliente_cep      || '').trim(),
          String(row.cliente_estado   || '').trim(),
        ]);

        inserted++;
        totalInserted++;

        console.log(
          `  ➕ Novo lote inserido → Pedido #${row.numero_pedido} | OP: ${row.op} | ${row.produto_nome} | Cliente: ${row.cliente_nome}`
        );

      } catch (rowErr) {
        errors++;
        console.error(
          `  ⚠️  Erro ao processar Pedido #${row.numero_pedido} / OP ${row.op}:`,
          rowErr.message
        );
      }
    }

  } catch (err) {
    console.error('❌  Erro geral no ciclo de sync:', err.message);
    errors++;
  } finally {
    if (empresaConn) empresaConn.release();
    if (localConn)   localConn.release();
  }

  return { checked, inserted, errors };
}

/**
 * Inicia o loop de sincronização periódica.
 * Executa imediatamente na primeira vez e repete conforme o intervalo.
 */
function startSync() {
  const interval = Number(process.env.SYNC_INTERVAL_MS) || 10000;

  console.log(`\n🔄  Sincronização iniciada  (intervalo: ${interval / 1000}s)\n`);

  const tick = async () => {
    totalSyncs++;
    const now = new Date().toLocaleTimeString('pt-BR');

    try {
      const { checked, inserted, errors } = await runSync();

      if (inserted > 0 || errors > 0) {
        console.log(
          `[${now}] Sync #${totalSyncs} → verificados: ${checked} | novos: ${inserted} | erros: ${errors} | total inserido: ${totalInserted}`
        );
      }
      // Se tudo ok e sem novos, apenas silencioso (evita spam no log)
    } catch (err) {
      console.error(`[${now}] Sync #${totalSyncs} falhou:`, err.message);
    }
  };

  // Executa imediatamente ao iniciar
  tick();

  // Agenda o intervalo periódico
  setInterval(tick, interval);
}

/**
 * Retorna estatísticas do sync para uso na API de status.
 */
function getSyncStats() {
  return {
    totalSyncs,
    totalInserted,
    intervalMs: Number(process.env.SYNC_INTERVAL_MS) || 10000,
  };
}

module.exports = { startSync, runSync, getSyncStats };
