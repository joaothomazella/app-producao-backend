'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { testConnection, dbPool } = require('./db');
const { startSync, getSyncStats, runSync } = require('./sync');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json({ limit: '2mb' }));
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // permite Postman/testes

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS bloqueado: origem não autorizada'));
  },
  methods: ['GET', 'PATCH', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
function sendError(res, status, message, detail) {
  return res.status(status).json({
    ok: false,
    error: message,
    detail: detail || null,
  });
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
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

async function hasFactoryFlowProcessadoColumns() {
  const hasFlag = await columnExists('cli_pedidos_itens', 'factoryflow_processado');
  const hasDate = await columnExists('cli_pedidos_itens', 'factoryflow_processado_em');
  return { hasFlag, hasDate, ok: hasFlag && hasDate };
}

// =========================
// SEGURANÇA - TOKEN/API KEY
// =========================
// Configure no Railway em Variables:
// FACTORYFLOW_API_TOKEN=uma-chave-grande-e-secreta
//
// O frontend deve enviar em todas as chamadas /api:
// Authorization: Bearer sua-chave
// ou:
// X-API-Key: sua-chave
//
// /health fica público para monitoramento. Todas as rotas /api ficam protegidas.

const API_TOKEN = (process.env.FACTORYFLOW_API_TOKEN || process.env.API_TOKEN || '').trim();

function extractToken(req) {
  const auth = String(req.headers.authorization || '').trim();

  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return String(req.headers['x-api-key'] || '').trim();
}

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return sendError(
      res,
      503,
      'API sem token configurado no servidor',
      'Configure FACTORYFLOW_API_TOKEN nas variáveis de ambiente do Railway.'
    );
  }

  const receivedToken = extractToken(req);

  if (!receivedToken || receivedToken !== API_TOKEN) {
    return sendError(res, 401, 'Acesso não autorizado', 'Token ausente ou inválido.');
  }

  return next();
}

// =========================
// HEALTH / ROOT
// =========================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow + CQVision API',
    version: '2.2.0-secure',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /health',
      'GET /api/stats',
      'GET /api/clientes',
      'GET /api/materias-primas/:codigo',
      'GET /api/pedidos',
      'GET /api/pedidos/:numero',
      'PATCH /api/pedidos/:numero/processado',
      'PATCH /api/pedidos/:numero/desprocessar',
      'GET /api/ops',
      'GET /api/ops/:op',
      'GET /api/producao',
      'GET /api/producao/:id',
      'PATCH /api/producao/:id',
      'GET /api/cq/lotes/:op',
      'GET /api/cq/lote-resumo/:op',
      'POST /api/cq/analises',
      'GET /api/cq/analises',
      'GET /api/cq/analises/:op',
      'GET /api/cq/dashboard/resumo',
      'GET /api/cq/dashboard/linhas',
      'GET /api/cq/dashboard/reajustes',
      'GET /api/cq/dashboard/materias-primas',
      'GET /api/cq/dashboard/historico',
      'GET /api/cq/dashboard/produtos-criticos',
      'GET /api/sync/status',
      'POST /api/sync/run'
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow + CQVision API',
    version: '2.2.0-secure',
    timestamp: new Date().toISOString(),
    sync: getSyncStats(),
  });
});

// A partir daqui, toda rota /api exige token.
app.use('/api', requireApiToken);

// =========================
// STATS GERAIS
// =========================

app.get('/api/stats', async (req, res) => {
  try {
    const [[totalItensRow]] = await dbPool.query(`
      SELECT COUNT(*) AS total_itens
      FROM cli_pedidos_itens
    `);

    const [[totalOpsRow]] = await dbPool.query(`
      SELECT COUNT(DISTINCT pits_op) AS total_ops
      FROM cli_pedidos_itens
      WHERE pits_op IS NOT NULL
        AND pits_op <> ''
    `);

    const [[totalPedidosRow]] = await dbPool.query(`
      SELECT COUNT(DISTINCT pits_numero) AS total_pedidos
      FROM cli_pedidos_itens
      WHERE pits_numero IS NOT NULL
        AND pits_numero <> ''
    `);

    const [[ultimaCargaRow]] = await dbPool.query(`
      SELECT
        MAX(id) AS ultimo_id,
        MAX(pits_previsao) AS ultima_previsao
      FROM cli_pedidos_itens
    `);

    let producao = null;
    const hasProducaoLotes = await tableExists('producao_lotes');

    if (hasProducaoLotes) {
      const [[producaoTotalRow]] = await dbPool.query(`
        SELECT COUNT(*) AS total_lotes_producao
        FROM producao_lotes
      `);

      producao = {
        total_lotes_producao: Number(producaoTotalRow.total_lotes_producao || 0),
      };
    }

    const processadoColumns = await hasFactoryFlowProcessadoColumns().catch(() => ({ ok: false }));

    res.json({
      ok: true,
      data: {
        total_itens: Number(totalItensRow.total_itens || 0),
        total_ops: Number(totalOpsRow.total_ops || 0),
        total_pedidos: Number(totalPedidosRow.total_pedidos || 0),
        ultimo_id: Number(ultimaCargaRow.ultimo_id || 0),
        ultima_previsao: ultimaCargaRow.ultima_previsao || null,
        producao,
        factoryflow_processado_configurado: !!processadoColumns.ok,
        sync: getSyncStats(),
      },
    });
  } catch (err) {
    console.error('GET /api/stats erro:', err.message);
    sendError(res, 500, 'Erro ao buscar estatísticas', err.message);
  }
});

// =========================
// CLIENTES
// =========================

app.get('/api/clientes', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const limit = Math.min(toPositiveInt(req.query.limit, 300), 2000);
    const offset = toPositiveInt(req.query.offset, 0);

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(cli_codigo LIKE ? OR cli_nome LIKE ? OR cli_cidade LIKE ?)');
      params.push(search, search, search);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM cli_clientes ${where}`,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          cli_codigo,
          cli_nome,
          cli_endereco,
          cli_bairro,
          cli_cidade,
          cli_cep,
          cli_estado
        FROM cli_clientes
        ${where}
        ORDER BY cli_nome ASC
        LIMIT ? OFFSET ?
      `,
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
    console.error('GET /api/clientes erro:', err.message);
    sendError(res, 500, 'Erro ao buscar clientes', err.message);
  }
});

// =========================
// MATÉRIAS-PRIMAS
// =========================

app.get('/api/materias-primas/:codigo', async (req, res) => {
  try {
    const { codigo } = req.params;

    const [rows] = await dbPool.query(
      `
        SELECT
          mp_codigo,
          mp_nome
        FROM cli_materia_prima
        WHERE TRIM(mp_codigo) = TRIM(?)
        LIMIT 1
      `,
      [codigo]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Matéria-prima não encontrada');
    }

    res.json({
      ok: true,
      data: {
        codigo: rows[0].mp_codigo,
        nome: rows[0].mp_nome,
      }
    });
  } catch (err) {
    console.error('GET /api/materias-primas/:codigo erro:', err.message);
    sendError(res, 500, 'Erro ao buscar matéria-prima', err.message);
  }
});

// =========================
// FACTORYFLOW - PEDIDOS
// =========================

app.get('/api/pedidos', async (req, res) => {
  try {
    const limit = Math.min(toPositiveInt(req.query.limit, 100), 1000);
    const offset = toPositiveInt(req.query.offset, 0);
    const search = req.query.search ? `%${req.query.search}%` : null;
    const cliente = req.query.cliente || null;
    const somenteNovos = req.query.somenteNovos === '1';
    const incluirProcessados = req.query.incluirProcessados === '1';
    const ultimoId = toPositiveInt(req.query.ultimoId, 0);
    const processadoColumns = await hasFactoryFlowProcessadoColumns();

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(`
        (
          p.pits_numero LIKE ?
          OR p.pits_op LIKE ?
          OR p.pits_produto LIKE ?
          OR p.pits_nome_produto LIKE ?
          OR c.cli_nome LIKE ?
        )
      `);
      params.push(search, search, search, search, search);
    }

    if (cliente) {
      conditions.push('p.pits_cliente = ?');
      params.push(cliente);
    }

    if (somenteNovos && ultimoId > 0) {
      conditions.push('p.id > ?');
      params.push(ultimoId);
    }

    if (processadoColumns.ok && !incluirProcessados) {
      conditions.push('COALESCE(p.factoryflow_processado, 0) = 0');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const processadoSelect = processadoColumns.ok
      ? `MAX(COALESCE(p.factoryflow_processado, 0)) AS factoryflow_processado,
         MAX(p.factoryflow_processado_em) AS factoryflow_processado_em,`
      : `0 AS factoryflow_processado,
         NULL AS factoryflow_processado_em,`;

    const [[{ total }]] = await dbPool.query(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT p.pits_numero
          FROM cli_pedidos_itens p
          LEFT JOIN cli_clientes c
            ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
          ${where}
          GROUP BY p.pits_numero
        ) t
      `,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome AS nome_cliente,
          MIN(p.pits_previsao) AS pits_previsao,
          COUNT(*) AS total_itens,
          COUNT(DISTINCT p.pits_op) AS total_ops,
          SUM(COALESCE(p.pits_qtde, 0)) AS total_quantidade,
          SUM(COALESCE(p.pits_peso, 0)) AS total_peso,
          ${processadoSelect}
          MAX(p.id) AS ultimo_id
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        ${where}
        GROUP BY
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome
        ORDER BY ultimo_id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      total: Number(total),
      limit,
      offset,
      processado_configurado: !!processadoColumns.ok,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/pedidos erro:', err.message);
    sendError(res, 500, 'Erro ao buscar pedidos', err.message);
  }
});

app.patch('/api/pedidos/:numero/processado', async (req, res) => {
  try {
    const { numero } = req.params;
    const processadoColumns = await hasFactoryFlowProcessadoColumns();

    if (!processadoColumns.ok) {
      return sendError(
        res,
        500,
        'Colunas de processado ainda não existem no MySQL',
        'Rode o ALTER TABLE para criar factoryflow_processado e factoryflow_processado_em em cli_pedidos_itens.'
      );
    }

    const [result] = await dbPool.query(
      `
        UPDATE cli_pedidos_itens
        SET
          factoryflow_processado = 1,
          factoryflow_processado_em = NOW()
        WHERE pits_numero = ?
      `,
      [numero]
    );

    if (!result.affectedRows) {
      return sendError(res, 404, 'Pedido não encontrado');
    }

    res.json({
      ok: true,
      message: 'Pedido marcado como processado no FactoryFlow',
      numero,
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error('PATCH /api/pedidos/:numero/processado erro:', err.message);
    sendError(res, 500, 'Erro ao marcar pedido como processado', err.message);
  }
});

app.patch('/api/pedidos/:numero/desprocessar', async (req, res) => {
  try {
    const { numero } = req.params;
    const processadoColumns = await hasFactoryFlowProcessadoColumns();

    if (!processadoColumns.ok) {
      return sendError(
        res,
        500,
        'Colunas de processado ainda não existem no MySQL',
        'Rode o ALTER TABLE para criar factoryflow_processado e factoryflow_processado_em em cli_pedidos_itens.'
      );
    }

    const [result] = await dbPool.query(
      `
        UPDATE cli_pedidos_itens
        SET
          factoryflow_processado = 0,
          factoryflow_processado_em = NULL
        WHERE pits_numero = ?
      `,
      [numero]
    );

    if (!result.affectedRows) {
      return sendError(res, 404, 'Pedido não encontrado');
    }

    res.json({
      ok: true,
      message: 'Pedido reaberto para o FactoryFlow',
      numero,
      affectedRows: result.affectedRows,
    });
  } catch (err) {
    console.error('PATCH /api/pedidos/:numero/desprocessar erro:', err.message);
    sendError(res, 500, 'Erro ao reabrir pedido', err.message);
  }
});

app.get('/api/pedidos/:numero', async (req, res) => {
  try {
    const { numero } = req.params;
    const processadoColumns = await hasFactoryFlowProcessadoColumns();
    const processadoItemSelect = processadoColumns.ok
      ? `COALESCE(p.factoryflow_processado, 0) AS factoryflow_processado,
         p.factoryflow_processado_em,`
      : `0 AS factoryflow_processado,
         NULL AS factoryflow_processado_em,`;

    const [rows] = await dbPool.query(
      `
        SELECT
          p.id,
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome AS nome_cliente,
          p.pits_previsao,
          p.pits_produto,
          p.pits_op,
          p.pits_nome_produto,
          p.pits_qtde,
          p.pits_peso,
          p.pits_revisao,
          p.pits_viscosidade,
          p.pits_densidade,
          p.pits_fineza,
          ${processadoItemSelect}
          c.cli_endereco,
          c.cli_bairro,
          c.cli_cidade,
          c.cli_cep,
          c.cli_estado
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        WHERE p.pits_numero = ?
        ORDER BY p.id ASC
      `,
      [numero]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Pedido não encontrado');
    }

    const header = {
      pits_numero: rows[0].pits_numero,
      pits_cliente: rows[0].pits_cliente,
      nome_cliente: rows[0].nome_cliente,
      cliente: rows[0].nome_cliente,
      pits_previsao: rows[0].pits_previsao,
      previsao_entrega: rows[0].pits_previsao,
      cli_endereco: rows[0].cli_endereco,
      cli_bairro: rows[0].cli_bairro,
      cli_cidade: rows[0].cli_cidade,
      cli_cep: rows[0].cli_cep,
      cli_estado: rows[0].cli_estado,
      factoryflow_processado: Number(rows[0].factoryflow_processado || 0),
      factoryflow_processado_em: rows[0].factoryflow_processado_em || null,
      total_itens: rows.length,
      total_ops: new Set(rows.map((r) => r.pits_op)).size,
      total_quantidade: rows.reduce((acc, item) => acc + Number(item.pits_qtde || 0), 0),
      total_peso: rows.reduce((acc, item) => acc + Number(item.pits_peso || 0), 0),
    };

    res.json({
      ok: true,
      pedido: header,
      data: header,
      itens: rows,
    });
  } catch (err) {
    console.error('GET /api/pedidos/:numero erro:', err.message);
    sendError(res, 500, 'Erro ao buscar pedido', err.message);
  }
});

// =========================
// FACTORYFLOW - OPS
// =========================

app.get('/api/ops', async (req, res) => {
  try {
    const limit = Math.min(toPositiveInt(req.query.limit, 100), 1000);
    const offset = toPositiveInt(req.query.offset, 0);
    const pedido = req.query.pedido || null;
    const cliente = req.query.cliente || null;
    const search = req.query.search ? `%${req.query.search}%` : null;
    const somenteNovos = req.query.somenteNovos === '1';
    const ultimoId = toPositiveInt(req.query.ultimoId, 0);

    const conditions = [
      `p.pits_op IS NOT NULL`,
      `p.pits_op <> ''`,
    ];
    const params = [];

    if (pedido) {
      conditions.push('p.pits_numero = ?');
      params.push(pedido);
    }

    if (cliente) {
      conditions.push('p.pits_cliente = ?');
      params.push(cliente);
    }

    if (search) {
      conditions.push(`
        (
          p.pits_op LIKE ?
          OR p.pits_numero LIKE ?
          OR p.pits_produto LIKE ?
          OR p.pits_nome_produto LIKE ?
          OR c.cli_nome LIKE ?
        )
      `);
      params.push(search, search, search, search, search);
    }

    if (somenteNovos && ultimoId > 0) {
      conditions.push('p.id > ?');
      params.push(ultimoId);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [[{ total }]] = await dbPool.query(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT p.pits_op
          FROM cli_pedidos_itens p
          LEFT JOIN cli_clientes c
            ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
          ${where}
          GROUP BY p.pits_op
        ) t
      `,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          p.pits_op,
          MIN(p.pits_numero) AS pits_numero,
          MIN(p.pits_cliente) AS pits_cliente,
          MAX(c.cli_nome) AS nome_cliente,
          MIN(p.pits_previsao) AS pits_previsao,
          MIN(p.pits_produto) AS pits_produto,
          MAX(p.pits_nome_produto) AS pits_nome_produto,
          COUNT(*) AS total_itens,
          SUM(COALESCE(p.pits_qtde, 0)) AS total_quantidade,
          SUM(COALESCE(p.pits_peso, 0)) AS total_peso,
          MAX(p.id) AS ultimo_id
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        ${where}
        GROUP BY p.pits_op
        ORDER BY ultimo_id DESC
        LIMIT ? OFFSET ?
      `,
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
    console.error('GET /api/ops erro:', err.message);
    sendError(res, 500, 'Erro ao buscar OPs', err.message);
  }
});

app.get('/api/ops/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const [rows] = await dbPool.query(
      `
        SELECT
          p.id,
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome AS nome_cliente,
          p.pits_previsao,
          p.pits_produto,
          p.pits_op,
          p.pits_nome_produto,
          p.pits_qtde,
          p.pits_peso,
          p.pits_revisao,
          p.pits_viscosidade,
          p.pits_densidade,
          p.pits_fineza
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        WHERE p.pits_op = ?
        ORDER BY p.id ASC
      `,
      [op]
    );

    if (!rows.length) {
      return sendError(res, 404, 'OP não encontrada');
    }

    res.json({
      ok: true,
      resumo: {
        pits_op: op,
        pits_numero: rows[0].pits_numero,
        pits_cliente: rows[0].pits_cliente,
        nome_cliente: rows[0].nome_cliente,
        pits_previsao: rows[0].pits_previsao,
        total_itens: rows.length,
        total_quantidade: rows.reduce((acc, item) => acc + Number(item.pits_qtde || 0), 0),
        total_peso: rows.reduce((acc, item) => acc + Number(item.pits_peso || 0), 0),
      },
      itens: rows,
    });
  } catch (err) {
    console.error('GET /api/ops/:op erro:', err.message);
    sendError(res, 500, 'Erro ao buscar OP', err.message);
  }
});

// =========================
// PRODUÇÃO (tabela interna)
// =========================

app.get('/api/producao', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(
        res,
        404,
        'Tabela producao_lotes não encontrada',
        'Crie a tabela producao_lotes ou ajuste o nome da tabela no backend.'
      );
    }

    const limit = Math.min(toPositiveInt(req.query.limit, 500), 2000);
    const offset = toPositiveInt(req.query.offset, 0);
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
      conditions.push('(cliente_nome LIKE ? OR produto_nome LIKE ? OR numero_pedido LIKE ? OR op LIKE ?)');
      params.push(search, search, search, search);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM producao_lotes ${where}`,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT *
        FROM producao_lotes
        ${where}
        ORDER BY data_criacao DESC, id DESC
        LIMIT ? OFFSET ?
      `,
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
    sendError(res, 500, 'Erro ao buscar lotes de produção', err.message);
  }
});

app.get('/api/producao/:id', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(res, 404, 'Tabela producao_lotes não encontrada');
    }

    const [rows] = await dbPool.query(
      'SELECT * FROM producao_lotes WHERE id = ? LIMIT 1',
      [req.params.id]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /api/producao/:id erro:', err.message);
    sendError(res, 500, 'Erro ao buscar lote', err.message);
  }
});

app.patch('/api/producao/:id', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(res, 404, 'Tabela producao_lotes não encontrada');
    }

    const allowedFields = [
      'status',
      'setor_atual',
      'tipo_lote',
      'prioridade',
      'classificado_pcp',
      'liberado_pcp',
      'data_liberacao_pcp',
      'rota_escolhida'
    ];

    const body = req.body || {};
    const fields = [];
    const params = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        fields.push(`${field} = ?`);
        params.push(body[field]);
      }
    }

    if (!fields.length) {
      return sendError(res, 400, 'Informe ao menos um campo válido para atualizar');
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

// =========================
// CQ VISION
// =========================

app.get('/api/cq/lotes/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const [rows] = await dbPool.query(
      `
        SELECT
          p.id,
          p.pits_op,
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome AS nome_cliente,
          p.pits_previsao,
          p.pits_produto,
          p.pits_nome_produto,
          p.pits_qtde,
          p.pits_peso,
          p.pits_revisao,
          p.pits_viscosidade,
          p.pits_densidade,
          p.pits_fineza
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        WHERE p.pits_op = ?
        ORDER BY p.id ASC
      `,
      [op]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Lote/OP não encontrado');
    }

    res.json({
      ok: true,
      resumo: {
        pits_op: rows[0].pits_op,
        pits_numero: rows[0].pits_numero,
        pits_cliente: rows[0].pits_cliente,
        nome_cliente: rows[0].nome_cliente,
        pits_previsao: rows[0].pits_previsao,
        total_registros: rows.length,
      },
      constantes: {
        pits_viscosidade: rows[0].pits_viscosidade,
        pits_densidade: rows[0].pits_densidade,
        pits_fineza: rows[0].pits_fineza,
        pits_revisao: rows[0].pits_revisao,
      },
      itens: rows,
    });
  } catch (err) {
    console.error('GET /api/cq/lotes/:op erro:', err.message);
    sendError(res, 500, 'Erro ao buscar lote do CQ Vision', err.message);
  }
});

app.get('/api/cq/lote-resumo/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const [rows] = await dbPool.query(
      `
        SELECT
          p.pits_op,
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome AS nome_cliente,
          p.pits_previsao,
          p.pits_produto,
          p.pits_nome_produto,
          p.pits_qtde,
          p.pits_peso,
          p.pits_revisao,
          p.pits_viscosidade,
          p.pits_densidade,
          p.pits_fineza
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        WHERE p.pits_op = ?
        LIMIT 1
      `,
      [op]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Lote não encontrado');
    }

    const row = rows[0];

    res.json({
      ok: true,
      data: {
        op: row.pits_op,
        pedido: row.pits_numero,
        cliente_codigo: row.pits_cliente,
        cliente_nome: row.nome_cliente,
        previsao: row.pits_previsao,
        produto_codigo: row.pits_produto,
        produto_nome: row.pits_nome_produto,
        quantidade: row.pits_qtde,
        peso: row.pits_peso,
        revisao: row.pits_revisao,
        viscosidade_padrao: row.pits_viscosidade,
        densidade_padrao: row.pits_densidade,
        fineza_padrao: row.pits_fineza
      }
    });
  } catch (err) {
    console.error('GET /api/cq/lote-resumo/:op erro:', err.message);
    sendError(res, 500, 'Erro ao buscar resumo do lote', err.message);
  }
});

app.post('/api/cq/analises', async (req, res) => {
  try {
    const {
      op,
      pedido,
      cliente_codigo,
      cliente_nome,
      produto_codigo,
      produto_nome,
      linha_produto,
      product_type,
      revisao,
      viscosidade_padrao,
      densidade_padrao,
      fineza_padrao,
      viscosidade_encontrada,
      densidade_encontrada,
      fineza_encontrada,
      solidos_a,
      solidos_ab,
      observacoes,
      resultado,
      usuario,
      reajustes,
      data_analise,
      viscosidade_inicial,
      viscosidade_final
    } = req.body || {};

    if (!op) {
      return sendError(res, 400, 'Informe a OP');
    }

    const [result] = await dbPool.query(
      `
        INSERT INTO cq_analises (
          op,
          pedido,
          cliente_codigo,
          cliente_nome,
          produto_codigo,
          produto_nome,
          linha_produto,
          revisao,
          viscosidade_padrao,
          densidade_padrao,
          fineza_padrao,
          viscosidade_encontrada,
          densidade_encontrada,
          fineza_encontrada,
          solidos_a,
          solidos_ab,
          observacoes,
          resultado,
          usuario,
          data_analise,
          viscosidade_inicial,
          viscosidade_final
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        op || null,
        pedido || null,
        cliente_codigo || null,
        cliente_nome || null,
        produto_codigo || null,
        produto_nome || null,
        (linha_produto || product_type || null),
        revisao || null,
        viscosidade_padrao || null,
        densidade_padrao || null,
        fineza_padrao || null,
        viscosidade_encontrada || null,
        densidade_encontrada || null,
        fineza_encontrada || null,
        solidos_a || null,
        solidos_ab || null,
        observacoes || null,
        resultado || null,
        usuario || null,
        data_analise || new Date().toISOString().slice(0, 10),
        viscosidade_inicial || null,
        viscosidade_final || null
      ]
    );

    const analiseId = result.insertId;

    if (Array.isArray(reajustes) && reajustes.length > 0) {
      for (const reajuste of reajustes) {
        await dbPool.query(
          `
            INSERT INTO cq_analises_reajustes (
              analise_id,
              numero_reajuste,
              materia_prima_codigo,
              materia_prima_nome,
              materia_prima_qtd,
              motivo_reajuste,
              observacao_reajuste
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            analiseId,
            reajuste.numero_reajuste || 1,
            reajuste.materia_prima_codigo || null,
            reajuste.materia_prima_nome || null,
            reajuste.materia_prima_qtd || null,
            reajuste.motivo_reajuste || null,
            reajuste.observacao_reajuste || null
          ]
        );
      }
    }

    res.json({
      ok: true,
      id: analiseId,
      message: 'Análise salva com sucesso'
    });

  } catch (err) {
    console.error('POST /api/cq/analises erro:', err.message);
    sendError(res, 500, 'Erro ao salvar análise', err.message);
  }
});



// =========================
// CQ VISION - DASHBOARD
// =========================

function buildCqDashboardFilters(query) {
  const conditions = [];
  const params = [];

  const linha = query.linha || query.linha_produto || null;
  const dateFrom = query.dateFrom || query.data_inicio || null;
  const dateTo = query.dateTo || query.data_fim || null;

  if (linha) {
    conditions.push('a.linha_produto = ?');
    params.push(linha);
  }

  if (dateFrom) {
    conditions.push('a.data_analise >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push('a.data_analise <= ?');
    params.push(dateTo);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

app.get('/api/cq/dashboard/resumo', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);

    const [[totais]] = await dbPool.query(
      `
        SELECT
          COUNT(*) AS total_analises,
          SUM(CASE WHEN UPPER(COALESCE(a.resultado, '')) IN ('APROVADO', 'APROVADA', 'OK', 'LIBERADO', 'LIBERADA') THEN 1 ELSE 0 END) AS aprovados,
          SUM(CASE WHEN UPPER(COALESCE(a.resultado, '')) IN ('REPROVADO', 'REPROVADA', 'REAJUSTE') THEN 1 ELSE 0 END) AS reprovados,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) AS com_reajuste,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) AS sem_reajuste,
          AVG(NULLIF(CAST(a.viscosidade_inicial AS DECIMAL(12,4)), 0)) AS media_viscosidade_inicial,
          AVG(NULLIF(CAST(a.viscosidade_final AS DECIMAL(12,4)), 0)) AS media_viscosidade_final,
          AVG(NULLIF(CAST(a.densidade_encontrada AS DECIMAL(12,4)), 0)) AS media_densidade,
          AVG(NULLIF(CAST(a.solidos_a AS DECIMAL(12,4)), 0)) AS media_solidos_a,
          AVG(NULLIF(CAST(a.solidos_ab AS DECIMAL(12,4)), 0)) AS media_solidos_ab
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) r ON r.analise_id = a.id
        ${where}
      `,
      params
    );

    const total = Number(totais.total_analises || 0);
    const comReajuste = Number(totais.com_reajuste || 0);
    const semReajuste = Number(totais.sem_reajuste || 0);
    const fpy = total ? (semReajuste / total) * 100 : 0;
    const percentualReajuste = total ? (comReajuste / total) * 100 : 0;

    res.json({
      ok: true,
      data: {
        total_analises: total,
        total: total,
        aprovados: Number(totais.aprovados || 0),
        reprovados: Number(totais.reprovados || 0),
        com_reajuste: comReajuste,
        sem_reajuste: semReajuste,
        fpy: Number(fpy.toFixed(2)),
        percentual_reajuste: Number(percentualReajuste.toFixed(2)),
        media_viscosidade_inicial: totais.media_viscosidade_inicial === null ? null : Number(Number(totais.media_viscosidade_inicial).toFixed(2)),
        media_viscosidade_final: totais.media_viscosidade_final === null ? null : Number(Number(totais.media_viscosidade_final).toFixed(2)),
        media_densidade: totais.media_densidade === null ? null : Number(Number(totais.media_densidade).toFixed(4)),
        media_solidos_a: totais.media_solidos_a === null ? null : Number(Number(totais.media_solidos_a).toFixed(2)),
        media_solidos_ab: totais.media_solidos_ab === null ? null : Number(Number(totais.media_solidos_ab).toFixed(2))
      }
    });
  } catch (err) {
    console.error('GET /api/cq/dashboard/resumo erro:', err.message);
    sendError(res, 500, 'Erro ao buscar resumo do dashboard CQ', err.message);
  }
});

app.get('/api/cq/dashboard/linhas', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);

    const [rows] = await dbPool.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(a.linha_produto), ''), 'Sem linha') AS linha_produto,
          COUNT(*) AS total,
          SUM(CASE WHEN UPPER(COALESCE(a.resultado, '')) IN ('APROVADO', 'APROVADA', 'OK', 'LIBERADO', 'LIBERADA') THEN 1 ELSE 0 END) AS aprovados,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) AS com_reajuste,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) AS sem_reajuste,
          ROUND((SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) * 100, 2) AS fpy
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) r ON r.analise_id = a.id
        ${where}
        GROUP BY COALESCE(NULLIF(TRIM(a.linha_produto), ''), 'Sem linha')
        ORDER BY total DESC
      `,
      params
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/cq/dashboard/linhas erro:', err.message);
    sendError(res, 500, 'Erro ao buscar dashboard CQ por linha', err.message);
  }
});

app.get('/api/cq/dashboard/reajustes', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);
    const limit = Math.min(toPositiveInt(req.query.limit, 10), 50);

    const [rows] = await dbPool.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(r.motivo_reajuste), ''), 'Sem motivo informado') AS motivo_reajuste,
          COUNT(*) AS total,
          COUNT(DISTINCT r.analise_id) AS analises_afetadas
        FROM cq_analises_reajustes r
        INNER JOIN cq_analises a ON a.id = r.analise_id
        ${where}
        GROUP BY COALESCE(NULLIF(TRIM(r.motivo_reajuste), ''), 'Sem motivo informado')
        ORDER BY total DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/cq/dashboard/reajustes erro:', err.message);
    sendError(res, 500, 'Erro ao buscar motivos de reajuste do dashboard CQ', err.message);
  }
});

app.get('/api/cq/dashboard/materias-primas', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);
    const limit = Math.min(toPositiveInt(req.query.limit, 10), 50);

    const [rows] = await dbPool.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(r.materia_prima_codigo), ''), '-') AS materia_prima_codigo,
          COALESCE(NULLIF(TRIM(r.materia_prima_nome), ''), 'Sem matéria-prima informada') AS materia_prima_nome,
          COUNT(*) AS total_vezes,
          SUM(COALESCE(CAST(r.materia_prima_qtd AS DECIMAL(12,4)), 0)) AS qtd_total
        FROM cq_analises_reajustes r
        INNER JOIN cq_analises a ON a.id = r.analise_id
        ${where}
        GROUP BY
          COALESCE(NULLIF(TRIM(r.materia_prima_codigo), ''), '-'),
          COALESCE(NULLIF(TRIM(r.materia_prima_nome), ''), 'Sem matéria-prima informada')
        ORDER BY total_vezes DESC, qtd_total DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/cq/dashboard/materias-primas erro:', err.message);
    sendError(res, 500, 'Erro ao buscar matérias-primas ajustadas no dashboard CQ', err.message);
  }
});

app.get('/api/cq/dashboard/historico', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);
    const limit = Math.min(toPositiveInt(req.query.limit, 30), 365);

    const [rows] = await dbPool.query(
      `
        SELECT
          DATE(COALESCE(a.data_analise, a.criado_em)) AS data,
          COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) AS com_reajuste,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) AS sem_reajuste,
          ROUND((SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) * 100, 2) AS fpy
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) r ON r.analise_id = a.id
        ${where}
        GROUP BY DATE(COALESCE(a.data_analise, a.criado_em))
        ORDER BY data DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ ok: true, data: rows.reverse() });
  } catch (err) {
    console.error('GET /api/cq/dashboard/historico erro:', err.message);
    sendError(res, 500, 'Erro ao buscar histórico do dashboard CQ', err.message);
  }
});

app.get('/api/cq/dashboard/produtos-criticos', async (req, res) => {
  try {
    const { where, params } = buildCqDashboardFilters(req.query);
    const limit = Math.min(toPositiveInt(req.query.limit, 10), 50);

    const [rows] = await dbPool.query(
      `
        SELECT
          a.produto_codigo,
          a.produto_nome,
          COALESCE(NULLIF(TRIM(a.linha_produto), ''), 'Sem linha') AS linha_produto,
          COUNT(*) AS total_analises,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) AS com_reajuste,
          ROUND((SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) * 100, 2) AS percentual_reajuste
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) r ON r.analise_id = a.id
        ${where}
        GROUP BY a.produto_codigo, a.produto_nome, COALESCE(NULLIF(TRIM(a.linha_produto), ''), 'Sem linha')
        HAVING total_analises >= 1
        ORDER BY percentual_reajuste DESC, com_reajuste DESC, total_analises DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /api/cq/dashboard/produtos-criticos erro:', err.message);
    sendError(res, 500, 'Erro ao buscar produtos críticos do dashboard CQ', err.message);
  }
});

app.get('/api/cq/analises', async (req, res) => {
  try {
    const limit = Math.min(toPositiveInt(req.query.limit, 500), 5000);
    const offset = toPositiveInt(req.query.offset, 0);
    const search = req.query.search ? `%${req.query.search}%` : null;
    const linha = req.query.linha || req.query.linha_produto || null;
    const dateFrom = req.query.dateFrom || req.query.data_inicio || null;
    const dateTo = req.query.dateTo || req.query.data_fim || null;

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(`
        (
          a.op LIKE ?
          OR a.pedido LIKE ?
          OR a.produto_codigo LIKE ?
          OR a.produto_nome LIKE ?
          OR a.cliente_nome LIKE ?
          OR a.usuario LIKE ?
        )
      `);
      params.push(search, search, search, search, search, search);
    }

    if (linha) {
      conditions.push('a.linha_produto = ?');
      params.push(linha);
    }

    if (dateFrom) {
      conditions.push('a.data_analise >= ?');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('a.data_analise <= ?');
      params.push(dateTo);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM cq_analises a ${where}`,
      params
    );

    const [analises] = await dbPool.query(
      `
        SELECT
          a.*,
          COUNT(r.id) AS qtd_reajustes
        FROM cq_analises a
        LEFT JOIN cq_analises_reajustes r
          ON r.analise_id = a.id
        ${where}
        GROUP BY a.id
        ORDER BY COALESCE(a.data_analise, DATE(a.criado_em)) DESC, a.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    if (!analises.length) {
      return res.json({ ok: true, total: Number(total), limit, offset, data: [] });
    }

    const ids = analises.map(a => a.id);
    const placeholders = ids.map(() => '?').join(',');

    const [reajustes] = await dbPool.query(
      `
        SELECT *
        FROM cq_analises_reajustes
        WHERE analise_id IN (${placeholders})
        ORDER BY analise_id ASC, numero_reajuste ASC, id ASC
      `,
      ids
    );

    const reajustesPorAnalise = new Map();
    for (const r of reajustes) {
      if (!reajustesPorAnalise.has(r.analise_id)) reajustesPorAnalise.set(r.analise_id, []);
      reajustesPorAnalise.get(r.analise_id).push(r);
    }

    for (const analise of analises) {
      analise.qtd_reajustes = Number(analise.qtd_reajustes || 0);
      analise.reajustes = reajustesPorAnalise.get(analise.id) || [];
    }

    res.json({
      ok: true,
      total: Number(total),
      limit,
      offset,
      data: analises
    });
  } catch (err) {
    console.error('GET /api/cq/analises erro:', err.message);
    sendError(res, 500, 'Erro ao listar histórico de análises', err.message);
  }
});

app.get('/api/cq/analises/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const [analises] = await dbPool.query(
      `
        SELECT *
        FROM cq_analises
        WHERE op = ?
        ORDER BY criado_em DESC, id DESC
      `,
      [op]
    );

    for (const analise of analises) {
      const [reajustes] = await dbPool.query(
        `
          SELECT *
          FROM cq_analises_reajustes
          WHERE analise_id = ?
          ORDER BY numero_reajuste ASC, id ASC
        `,
        [analise.id]
      );

      analise.reajustes = reajustes;
    }

    res.json({
      ok: true,
      total: analises.length,
      data: analises
    });
  } catch (err) {
    console.error('GET /api/cq/analises/:op erro:', err.message);
    sendError(res, 500, 'Erro ao buscar histórico de análises', err.message);
  }
});

// =========================
// SYNC
// =========================

app.get('/api/sync/status', (req, res) => {
  res.json({
    ok: true,
    ...getSyncStats(),
  });
});

app.post('/api/sync/run', async (req, res) => {
  try {
    const result = await runSync();
    res.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error('POST /api/sync/run erro:', err.message);
    sendError(res, 500, 'Erro na sincronização manual', err.message);
  }
});

// =========================
// 404
// =========================

app.use((req, res) => {
  sendError(res, 404, `Rota não encontrada: ${req.method} ${req.path}`);
});

// =========================
// START
// =========================

(async () => {
  try {
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║   FactoryFlow + CQVision – MySQL Bridge v2.2.0 SECURE    ║');
    console.log('╚════════════════════════════════════════════════════╝\n');

    await testConnection();

    app.listen(PORT, () => {
      console.log(`🚀 API rodando em http://localhost:${PORT}\n`);
      console.log('Rotas disponíveis:');
      console.log('   GET  /');
      console.log('   GET  /health');
      console.log('   GET  /api/stats');
      console.log('   GET  /api/clientes');
      console.log('   GET  /api/materias-primas/:codigo');
      console.log('   GET  /api/pedidos');
      console.log('   GET  /api/pedidos/:numero');
      console.log('   PATCH /api/pedidos/:numero/processado');
      console.log('   PATCH /api/pedidos/:numero/desprocessar');
      console.log('   GET  /api/ops');
      console.log('   GET  /api/ops/:op');
      console.log('   GET  /api/producao');
      console.log('   GET  /api/producao/:id');
      console.log('   PATCH /api/producao/:id');
      console.log('   GET  /api/cq/lotes/:op');
      console.log('   GET  /api/cq/lote-resumo/:op');
      console.log('   POST /api/cq/analises');
      console.log('   GET  /api/cq/analises');
      console.log('   GET  /api/cq/analises/:op');
      console.log('   GET  /api/cq/dashboard/resumo');
      console.log('   GET  /api/cq/dashboard/linhas');
      console.log('   GET  /api/cq/dashboard/reajustes');
      console.log('   GET  /api/cq/dashboard/materias-primas');
      console.log('   GET  /api/cq/dashboard/historico');
      console.log('   GET  /api/cq/dashboard/produtos-criticos');
      console.log('   GET  /api/sync/status');
      console.log('   POST /api/sync/run\n');
      console.log(API_TOKEN ? '🔐 Segurança: rotas /api protegidas por token.\n' : '⚠️  Segurança: FACTORYFLOW_API_TOKEN não configurado. Rotas /api retornarão 503.\n');
    });

    startSync();
  } catch (err) {
    console.error('\n💥 Falha na inicialização:', err.message);
    process.exit(1);
  }
})();