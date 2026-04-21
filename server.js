'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { testConnection, dbPool } = require('./db');
const { startSync, getSyncStats, runSync } = require('./sync');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

function sendError(res, status, message, detail) {
  return res.status(status).json({ ok: false, error: message, detail: detail || null });
}

// health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow MySQL Bridge',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    sync: getSyncStats(),
  });
});

// clientes
app.get('/api/clientes', async (req, res) => {
  try {
    const [rows] = await dbPool.query(`
      SELECT
        cli_codigo,
        cli_nome,
        cli_endereco,
        cli_bairro,
        cli_cidade,
        cli_cep,
        cli_estado
      FROM cli_clientes
      ORDER BY cli_nome ASC
    `);

    res.json({
      ok: true,
      total: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/clientes erro:', err.message);
    sendError(res, 500, 'Erro ao buscar clientes', err.message);
  }
});

// produção
app.get('/api/producao', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Number(req.query.offset) || 0;
    const status = req.query.status || null;
    const setor = req.query.setor || null;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (setor) {
      conditions.push('setor_atual = ?');
      params.push(setor);
    }

    if (search) {
      conditions.push('(cliente_nome LIKE ? OR produto_nome LIKE ? OR numero_pedido LIKE ?)');
      params.push(search, search, search);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM producao_lotes ${where}`,
      params
    );

    const [rows] = await dbPool.query(
      `SELECT * FROM producao_lotes
       ${where}
       ORDER BY data_criacao DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      total: Number(total),
      limit,
      offset,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/producao erro:', err.message);
    sendError(res, 500, 'Erro ao buscar lotes', err.message);
  }
});

// lote por id
app.get('/api/producao/:id', async (req, res) => {
  try {
    const [rows] = await dbPool.query(
      'SELECT * FROM producao_lotes WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    sendError(res, 500, 'Erro ao buscar lote', err.message);
  }
});

// atualizar lote
app.patch('/api/producao/:id', async (req, res) => {
  try {
    const { status, setor_atual } = req.body || {};

    if (!status && !setor_atual) {
      return sendError(res, 400, 'Informe status e/ou setor_atual no body');
    }

    const fields = [];
    const params = [];

    if (status) {
      fields.push('status = ?');
      params.push(status);
    }

    if (setor_atual) {
      fields.push('setor_atual = ?');
      params.push(setor_atual);
    }

    params.push(req.params.id);

    const [result] = await dbPool.query(
      `UPDATE producao_lotes SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    if (!result.affectedRows) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    const [rows] = await dbPool.query(
      'SELECT * FROM producao_lotes WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /api/producao/:id erro:', err.message);
    sendError(res, 500, 'Erro ao atualizar lote', err.message);
  }
});

// sync status
app.get('/api/sync/status', (req, res) => {
  res.json({ ok: true, ...getSyncStats() });
});

// sync manual
app.post('/api/sync/run', async (req, res) => {
  try {
    const result = await runSync();
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, 500, 'Erro na sincronização manual', err.message);
  }
});

app.use((req, res) => {
  sendError(res, 404, `Rota não encontrada: ${req.method} ${req.path}`);
});

(async () => {
  try {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   FactoryFlow  –  MySQL Bridge  v1.0.0      ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    await testConnection();

    app.listen(PORT, () => {
      console.log(`\n🚀 API rodando em http://localhost:${PORT}`);
      console.log(`   GET  /api/clientes`);
      console.log(`   GET  /api/producao`);
      console.log(`   GET  /api/producao/:id`);
      console.log(`   PATCH /api/producao/:id`);
      console.log(`   POST /api/sync/run`);
      console.log(`   GET  /api/sync/status`);
      console.log(`   GET  /health\n`);
    });

    startSync();
  } catch (err) {
    console.error('\n💥 Falha na inicialização:', err.message);
    process.exit(1);
  }
})();