// =============================================
// SERVER.JS – Express API + sincronização
// Ponto de entrada principal do backend
// =============================================

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { testConnections, localPool, empresaPool } = require('./db');
const { startSync, getSyncStats } = require('./sync');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// ── Middlewares ───────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Helpers ───────────────────────────────────────────────
function sendError(res, status, message, detail) {
  return res.status(status).json({ ok: false, error: message, detail: detail || null });
}

// ═══════════════════════════════════════════════════════════
//  ROTAS
// ═══════════════════════════════════════════════════════════

// ── GET /health ───────────────────────────────────────────
// Verifica se o servidor está de pé
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow MySQL Bridge',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    sync: getSyncStats(),
  });
});

// ── GET /api/clientes ─────────────────────────────────────
// Retorna todos os clientes do ERP
// Pensado para a tela administrativa do app
app.get('/api/clientes', async (req, res) => {
  try {
    const [rows] = await empresaPool.query(`
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

// ── GET /api/producao ─────────────────────────────────────
// Retorna todos os lotes da tabela producao_lotes
// Query params opcionais:
//   ?status=aguardando        → filtra por status
//   ?setor=moagem             → filtra por setor_atual
//   ?limit=100                → máx de registros (padrão 500)
//   ?offset=0                 → paginação
//   ?search=texto             → busca em cliente_nome / produto_nome / numero_pedido
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
      conditions.push('(cliente_nome LIKE ? OR produto_nome LIKE ? OR pedido_numero LIKE ?)');
      params.push(search, search, search);
    }

    const where = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const [[{ total }]] = await localPool.query(
      `SELECT COUNT(*) AS total FROM producao_lotes ${where}`,
      params
    );

    const [rows] = await localPool.query(
      `SELECT * FROM producao_lotes ${where}
       ORDER BY criado_em DESC
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

// ── GET /api/producao/:id ─────────────────────────────────
// Retorna um lote pelo ID
app.get('/api/producao/:id', async (req, res) => {
  try {
    const [rows] = await localPool.query(
      'SELECT * FROM producao_lotes WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    res.json({ ok: true, data: rows[0] });

  } catch (err) {
    sendError(res, 500, 'Erro ao buscar lote', err.message);
  }
});

// ── PATCH /api/producao/:id ───────────────────────────────
// Atualiza status e/ou setor_atual de um lote
// Body: { status?: string, setor_atual?: string }
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

    const [result] = await localPool.query(
      `UPDATE producao_lotes SET ${fields.join(', ')} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    const [rows] = await localPool.query(
      'SELECT * FROM producao_lotes WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    res.json({ ok: true, data: rows[0] });

  } catch (err) {
    console.error('PATCH /api/producao/:id erro:', err.message);
    sendError(res, 500, 'Erro ao atualizar lote', err.message);
  }
});

// ── GET /api/sync/status ──────────────────────────────────
// Retorna estatísticas da sincronização
app.get('/api/sync/status', (req, res) => {
  res.json({ ok: true, ...getSyncStats() });
});

// ── POST /api/sync/run ────────────────────────────────────
// Dispara uma sincronização manual imediata
app.post('/api/sync/run', async (req, res) => {
  try {
    const { runSync } = require('./sync');
    const result = await runSync();
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, 500, 'Erro na sincronização manual', err.message);
  }
});

// ── 404 genérico ──────────────────────────────────────────
app.use((req, res) => {
  sendError(res, 404, `Rota não encontrada: ${req.method} ${req.path}`);
});

// ═══════════════════════════════════════════════════════════
//  INICIALIZAÇÃO
// ═══════════════════════════════════════════════════════════
(async () => {
  try {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   FactoryFlow  –  MySQL Bridge  v1.0.0      ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // 1. Testa conexões com os dois bancos
    await testConnections();

    // 2. Inicia o servidor HTTP
    app.listen(PORT, () => {
      console.log(`\n🚀  API rodando em http://localhost:${PORT}`);
      console.log(`    GET  /api/clientes         → lista clientes ERP`);
      console.log(`    GET  /api/producao         → lista lotes`);
      console.log(`    GET  /api/producao/:id     → detalhe do lote`);
      console.log(`    PATCH /api/producao/:id    → atualiza status/setor`);
      console.log(`    POST /api/sync/run         → sync manual`);
      console.log(`    GET  /api/sync/status      → estatísticas`);
      console.log(`    GET  /health               → health check\n`);
    });

    // 3. Inicia o loop de sincronização automática
    // startSync();

  } catch (err) {
    console.error('\n💥  Falha na inicialização:', err.message);
    console.error('    Verifique o arquivo .env, o db.js e as conexões de banco.\n');
    process.exit(1);
  }
})();