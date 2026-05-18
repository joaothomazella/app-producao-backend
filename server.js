'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { testConnection, dbPool } = require('./db');
const { startSync, getSyncStats, runSync } = require('./sync');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// ─────────────────────────────────────
// OPENAI / IA
// ─────────────────────────────────────
// Configure no Railway em Variables:
// OPENAI_API_KEY=sua-chave-da-openai
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
const defaultAllowedOrigins = [
  'https://factoryflowindus.netlify.app',
  'https://gvfwcjxe.gensparkspace.com',
  'https://fklqismj.gensparkspace.com',
  'https://qqjmblcn.gensparkspace.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5500'
];

const envAllowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // permite Postman/testes/curl

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn('⚠️ CORS bloqueado para origem:', origin);
    return callback(new Error('CORS bloqueado: origem não autorizada'));
  },
  credentials: true,
  methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
};

app.use(cors(corsOptions));
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


async function ensureProductionLotesManualColumns() {
  const hasProducaoLotes = await tableExists('producao_lotes');
  if (!hasProducaoLotes) return;

  const hasOrigem = await columnExists('producao_lotes', 'origem');
  if (!hasOrigem) {
    await dbPool.query(`
      ALTER TABLE producao_lotes
      ADD COLUMN origem VARCHAR(20) DEFAULT 'AUTO'
    `);
    console.log('✅ Coluna producao_lotes.origem criada.');
  }

  const hasLinhaProduto = await columnExists('producao_lotes', 'linha_produto');
  if (!hasLinhaProduto) {
    await dbPool.query(`
      ALTER TABLE producao_lotes
      ADD COLUMN linha_produto VARCHAR(100) NULL
    `);
    console.log('✅ Coluna producao_lotes.linha_produto criada.');
  }
}


async function ensureSectorShiftTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS ff_sector_shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setor VARCHAR(80) NOT NULL UNIQUE,
      expediente_aberto TINYINT DEFAULT 0,
      iniciado_em DATETIME NULL,
      finalizado_em DATETIME NULL,
      atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

async function ensureProductionLotesTimeColumns() {
  const hasProducaoLotes = await tableExists('producao_lotes');
  if (!hasProducaoLotes) return;

  const columns = [
    {
      name: 'ff_lotStatus',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_lotStatus VARCHAR(50) NULL`
    },
    {
      name: 'ff_sectorEnteredAt',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_sectorEnteredAt BIGINT NULL`
    },
    {
      name: 'ff_workSessions',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_workSessions LONGTEXT NULL`
    },
    {
      name: 'ff_expedientePausedStatus',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_expedientePausedStatus VARCHAR(50) NULL`
    },
    {
      name: 'ff_history',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_history LONGTEXT NULL`
    }
  ];

  for (const col of columns) {
    const exists = await columnExists('producao_lotes', col.name);
    if (!exists) {
      await dbPool.query(col.sql);
      console.log(`✅ Coluna producao_lotes.${col.name} criada.`);
    }
  }
}

function normalizeShiftSetor(setor) {
  const s = String(setor || '').trim().toLowerCase();
  const map = {
    coloracao_revisao: 'coloracao',
    coloracao_amostras: 'coloracao',
    laboratorio_revisao: 'laboratorio',
    laboratorio_amostras: 'laboratorio',
    envase_produzir: 'envase',
    envase_enlatamento: 'envase',
    envase: 'envase'
  };
  return map[s] || s;
}

async function getProductionLoteByOp(op) {
  const hasProducaoLotes = await tableExists('producao_lotes');
  if (!hasProducaoLotes) return null;

  const hasOrigem = await columnExists('producao_lotes', 'origem');
  const hasLinhaProduto = await columnExists('producao_lotes', 'linha_produto');
  const hasFfLotStatus = await columnExists('producao_lotes', 'ff_lotStatus');
  const hasFfSectorEnteredAt = await columnExists('producao_lotes', 'ff_sectorEnteredAt');
  const hasFfWorkSessions = await columnExists('producao_lotes', 'ff_workSessions');
  const hasFfExpedientePausedStatus = await columnExists('producao_lotes', 'ff_expedientePausedStatus');
  const hasFfHistory = await columnExists('producao_lotes', 'ff_history');

  const [rows] = await dbPool.query(
    `
      SELECT
        id,
        op,
        numero_pedido,
        cliente_codigo,
        cliente_nome,
        produto_codigo,
        produto_nome,
        quantidade,
        tipo_lote,
        prioridade,
        status,
        setor_atual,
        classificado_pcp,
        liberado_pcp,
        ${hasLinhaProduto ? 'linha_produto' : 'NULL AS linha_produto'},
        ${hasOrigem ? "COALESCE(NULLIF(TRIM(origem), ''), 'AUTO') AS origem" : "'AUTO' AS origem"},
        ${hasFfLotStatus ? 'ff_lotStatus' : 'NULL AS ff_lotStatus'},
        ${hasFfSectorEnteredAt ? 'ff_sectorEnteredAt' : 'NULL AS ff_sectorEnteredAt'},
        ${hasFfWorkSessions ? 'ff_workSessions' : 'NULL AS ff_workSessions'},
        ${hasFfExpedientePausedStatus ? 'ff_expedientePausedStatus' : 'NULL AS ff_expedientePausedStatus'},
        ${hasFfHistory ? 'ff_history' : 'NULL AS ff_history'},
        data_criacao,
        updated_at
      FROM producao_lotes
      WHERE TRIM(op) = TRIM(?)
      ORDER BY id DESC
      LIMIT 1
    `,
    [op]
  );

  return rows[0] || null;
}

async function getPedidoItemByOp(op) {
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
        p.pits_fineza,
        c.cli_endereco,
        c.cli_bairro,
        c.cli_cidade,
        c.cli_cep,
        c.cli_estado
      FROM cli_pedidos_itens p
      LEFT JOIN cli_clientes c
        ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
      WHERE TRIM(p.pits_op) = TRIM(?)
      ORDER BY p.id ASC
      LIMIT 1
    `,
    [op]
  );

  return rows[0] || null;
}

// =========================
// SEGURANÇA - JWT DOS 3 APPS + TOKEN FIXO
// =========================
// Este backend aceita dois formatos de autenticação nas rotas /api:
//
// 1) JWT do login central dos apps, enviado como:
//    Authorization: Bearer <ff_token>
//
// 2) Token fixo interno/automação, enviado como:
//    X-API-Key: <FACTORYFLOW_API_TOKEN>
//    ou Authorization: Bearer <FACTORYFLOW_API_TOKEN>
//
// IMPORTANTE:
// - O JWT_SECRET precisa ser o MESMO no PaintLab, CQVision e FactoryFlow.
// - /health, / e /webhook/whatsapp continuam públicos.
// - As rotas /api continuam protegidas.

const API_TOKEN = (process.env.FACTORYFLOW_API_TOKEN || process.env.API_TOKEN || '').trim();

const JWT_SECRET = (
  process.env.JWT_SECRET ||
  process.env.FACTORYFLOW_JWT_SECRET ||
  'INDUSCOLORSECURE9xA82kLmP2026'
).trim();

function base64UrlDecode(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '='
  );

  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a || ''));
  const bBuffer = Buffer.from(String(b || ''));

  if (aBuffer.length !== bBuffer.length) return false;

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function verifyJwtHs256(token) {
  const parts = String(token || '').split('.');

  if (parts.length !== 3) {
    throw new Error('JWT malformado');
  }

  const [headerEncoded, payloadEncoded, signature] = parts;
  const header = JSON.parse(base64UrlDecode(headerEncoded));

  if (header.alg !== 'HS256') {
    throw new Error(`Algoritmo JWT não suportado: ${header.alg || 'vazio'}`);
  }

  const expectedSignature = base64UrlEncode(
    crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerEncoded}.${payloadEncoded}`)
      .digest()
  );

  if (!safeEqual(signature, expectedSignature)) {
    throw new Error('Assinatura JWT inválida');
  }

  const payload = JSON.parse(base64UrlDecode(payloadEncoded));
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && Number(payload.exp) < now) {
    throw new Error('JWT expirado');
  }

  if (payload.nbf && Number(payload.nbf) > now) {
    throw new Error('JWT ainda não válido');
  }

  return payload;
}

function extractAuthToken(req) {
  const auth = String(req.headers.authorization || '').trim();

  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

function extractApiKey(req) {
  return String(req.headers['x-api-key'] || '').trim();
}

function requireApiToken(req, res, next) {
  const bearerToken = extractAuthToken(req);
  const apiKey = extractApiKey(req);

  // 1) Libera automações/comandos internos com token fixo.
  if (API_TOKEN && (safeEqual(apiKey, API_TOKEN) || safeEqual(bearerToken, API_TOKEN))) {
    req.authType = 'api_token';
    return next();
  }

  // 2) Libera usuários logados nos apps pelo JWT central.
  if (bearerToken) {
    try {
      const decoded = verifyJwtHs256(bearerToken);

      req.user = decoded;
      req.authType = 'jwt';

      return next();
    } catch (err) {
      console.warn('⚠️ JWT recusado pelo FactoryFlow:', err.message);
    }
  }

  return sendError(
    res,
    401,
    'Acesso não autorizado',
    'Token ausente ou inválido.'
  );
}

// =========================
// HEALTH / ROOT
// =========================

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow + CQVision API',
    version: '2.4.0-expediente-setor',
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
      'GET /api/producao/ativos',
      'GET /api/producao/:id',
      'POST /api/producao/manual',
      'POST /api/lotes',
      'GET /api/lote/:op',
      'PATCH /api/producao/:id',
      'GET /api/expediente',
      'GET /api/expediente/:setor',
      'POST /api/expediente/toggle',
      'GET /api/cq/lotes/:op',
      'GET /api/cq/lote-resumo/:op',
      'POST /api/cq/analises',
      'GET /api/cq/analises',
      'GET /api/cq/analise/:id',
      'PUT /api/cq/analises/:id',
      'GET /api/cq/analises/:op',
      'GET /api/cq/dashboard/dados',
      'GET /api/cq/dashboard/resumo',
      'GET /api/cq/dashboard/linhas',
      'GET /api/cq/dashboard/reajustes',
      'GET /api/cq/dashboard/materias-primas',
      'GET /api/cq/dashboard/historico',
      'GET /api/cq/dashboard/produtos-criticos',
      'GET /api/cq/produtos',
      'GET /api/cq/produtos/:codigo/previsao',
      'GET /api/cq/previsoes/ops',
      'GET /api/cq/previsoes/produto/:codigo',
      'GET /api/cq/previsoes/op/:op',
      'GET /api/sync/status',
      'POST /api/sync/run'
    ],
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'FactoryFlow + CQVision API',
    version: '2.4.0-expediente-setor',
    timestamp: new Date().toISOString(),
    sync: getSyncStats(),
  });
});


// =========================
// WHATSAPP / TWILIO WEBHOOK — PÚBLICO + OPENAI
// =========================
// Configure na Twilio Sandbox em "When a message comes in":
// https://SEU-BACKEND.up.railway.app/webhook/whatsapp
// Método: HTTP POST
//
// Para ativar a IA:
// 1) Railway > Variables
// 2) Adicione OPENAI_API_KEY
// 3) Faça deploy novamente

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlResponse(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;
}

function limparTexto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatarDataCurta(value) {
  if (!value) return '-';

  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);

    return d.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    });
  } catch (_) {
    return String(value);
  }
}

function normalizarSetorPergunta(texto) {
  const t = limparTexto(texto);

  if (t.includes('laboratorio') || t.includes('lab')) return 'laboratorio';
  if (t.includes('coloracao') || t.includes('cor')) return 'coloracao';
  if (t.includes('envase') || t.includes('enlatamento')) return 'envase';
  if (t.includes('producao') || t.includes('moagem')) return 'producao';
  if (t.includes('pesagem')) return 'pesagem';
  if (t.includes('expedicao') || t.includes('entrega') || t.includes('pronto')) return 'expedicao';
  if (t.includes('pcp')) return 'pcp';

  return '';
}

async function chamarOpenAIParaInterpretar(mensagem) {
  if (!OPENAI_API_KEY) {
    return null;
  }

  try {
    const promptSistema = `
Você é o interpretador da IA operacional da Induscolor.
Transforme a pergunta do WhatsApp em JSON puro, sem markdown.

Intenções possíveis:
- consultar_numero: quando tiver OP, lote ou pedido numérico.
- listar_setor: quando perguntar quais lotes estão em um setor.
- buscar_cliente: quando perguntar por cliente.
- resumo_operacional: quando perguntar visão geral, atrasos, urgentes ou situação geral.
- ajuda: quando pedir ajuda/menu.
- desconhecido: quando não entender.

Campos esperados:
{
  "intent": "consultar_numero|listar_setor|buscar_cliente|resumo_operacional|ajuda|desconhecido",
  "numero": "string ou vazio",
  "setor": "laboratorio|coloracao|envase|producao|pesagem|expedicao|pcp|vazio",
  "cliente": "string ou vazio",
  "resumo": "frase curta explicando o que o usuário quer"
}

Regras:
- Se houver número de 5 a 8 dígitos, coloque em numero.
- "lab" significa laboratorio.
- "cor" pode significar coloracao.
- "pronto para entrega" ou "entrega" pode significar expedicao.
- Retorne somente JSON válido.
`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: promptSistema },
          { role: 'user', content: mensagem }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('❌ OpenAI erro:', response.status, text);
      return null;
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    return JSON.parse(cleaned);
  } catch (err) {
    console.error('❌ Erro ao interpretar com OpenAI:', err.message);
    return null;
  }
}

async function consultarPedidoOuOpWhatsapp(texto) {
  const mensagem = String(texto || '').trim();
  const numeroEncontrado = mensagem.match(/\b\d{5,8}\b/);

  if (!numeroEncontrado) {
    return null;
  }

  const numero = numeroEncontrado[0];

  // 1) Tenta achar como OP/lote em producao_lotes ou cli_pedidos_itens
  const lote = await getProductionLoteByOp(numero).catch(() => null);

  if (lote) {
    return [
      `✅ OP/Lote ${lote.op} encontrado no FactoryFlow.`,
      `Pedido: ${lote.numero_pedido || '-'}`,
      `Cliente: ${lote.cliente_nome || '-'}`,
      `Produto: ${lote.produto_nome || '-'}`,
      `Setor atual: ${lote.setor_atual || '-'}`,
      `Status: ${lote.status || '-'}`,
      `Prioridade: ${lote.prioridade || '-'}`,
    ].join('\n');
  }

  const pedidoItem = await getPedidoItemByOp(numero).catch(() => null);

  if (pedidoItem) {
    return [
      `✅ OP ${pedidoItem.pits_op} encontrada nos pedidos.`,
      `Pedido: ${pedidoItem.pits_numero || '-'}`,
      `Cliente: ${pedidoItem.nome_cliente || '-'}`,
      `Produto: ${pedidoItem.pits_nome_produto || '-'}`,
      `Quantidade: ${pedidoItem.pits_qtde || '-'}`,
      `Previsão: ${formatarDataCurta(pedidoItem.pits_previsao)}`,
    ].join('\n');
  }

  // 2) Se não achou como OP, tenta achar como número de pedido
  const [pedidoRows] = await dbPool.query(
    `
      SELECT
        p.pits_numero,
        p.pits_op,
        p.pits_cliente,
        c.cli_nome AS nome_cliente,
        p.pits_nome_produto,
        p.pits_qtde,
        p.pits_peso,
        p.pits_previsao
      FROM cli_pedidos_itens p
      LEFT JOIN cli_clientes c
        ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
      WHERE TRIM(p.pits_numero) = TRIM(?)
      ORDER BY p.id ASC
      LIMIT 12
    `,
    [numero]
  );

  if (pedidoRows.length) {
    const cliente = pedidoRows[0].nome_cliente || '-';
    const previsao = formatarDataCurta(pedidoRows[0].pits_previsao);
    const opsUnicas = new Map();

    for (const row of pedidoRows) {
      const op = String(row.pits_op || '-').trim();
      const produto = String(row.pits_nome_produto || '-').trim();
      const chave = `${op}_${produto}`;
      if (!opsUnicas.has(chave)) {
        opsUnicas.set(chave, `• OP ${op} — ${produto}`);
      }
    }

    return [
      `✅ Pedido ${numero} encontrado.`,
      `Cliente: ${cliente}`,
      `Previsão: ${previsao}`,
      `Lotes/OPs:`,
      [...opsUnicas.values()].join('\n'),
    ].join('\n');
  }

  return `⚠️ Não encontrei pedido/OP ${numero} no banco do FactoryFlow.`;
}

async function consultarLotesPorSetorWhatsapp(setorBruto) {
  const setor = normalizarSetorPergunta(setorBruto || '');

  if (!setor) {
    return 'Me diga o setor que você quer consultar. Exemplo: quais lotes estão no laboratório?';
  }

  const hasProducaoLotes = await tableExists('producao_lotes');
  if (!hasProducaoLotes) {
    return '⚠️ A tabela producao_lotes não foi encontrada no banco.';
  }

  const busca = `%${setor}%`;

  const [rows] = await dbPool.query(
    `
      SELECT
        op,
        numero_pedido,
        cliente_nome,
        produto_nome,
        quantidade,
        setor_atual,
        status,
        prioridade,
        updated_at,
        data_criacao
      FROM producao_lotes
      WHERE LOWER(COALESCE(setor_atual, '')) LIKE LOWER(?)
        AND LOWER(COALESCE(status, '')) NOT IN ('finalizado', 'cancelado')
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(prioridade, '')) LIKE '%urgent%' THEN 0
          WHEN LOWER(COALESCE(prioridade, '')) LIKE '%alta%' THEN 1
          ELSE 2
        END,
        updated_at DESC,
        data_criacao DESC
      LIMIT 10
    `,
    [busca]
  );

  if (!rows.length) {
    return `✅ Não encontrei lotes ativos no setor ${setor}.`;
  }

  const linhas = rows.map((row) => {
    return `• OP ${row.op || '-'} — ${row.cliente_nome || '-'} — ${row.produto_nome || '-'} — ${row.status || '-'}`;
  });

  return [
    `📍 Lotes ativos no setor ${setor}:`,
    ...linhas,
    '',
    `Total exibido: ${rows.length}`
  ].join('\n');
}

async function consultarClienteWhatsapp(clienteBruto) {
  const cliente = String(clienteBruto || '').trim();

  if (!cliente || cliente.length < 3) {
    return 'Me diga o nome do cliente. Exemplo: cliente Carbofibras';
  }

  const like = `%${cliente}%`;

  const [lotes] = await dbPool.query(
    `
      SELECT
        op,
        numero_pedido,
        cliente_nome,
        produto_nome,
        setor_atual,
        status,
        prioridade,
        updated_at
      FROM producao_lotes
      WHERE cliente_nome LIKE ?
      ORDER BY updated_at DESC, data_criacao DESC
      LIMIT 8
    `,
    [like]
  );

  if (lotes.length) {
    const linhas = lotes.map((row) => {
      return `• Pedido ${row.numero_pedido || '-'} / OP ${row.op || '-'} — ${row.produto_nome || '-'} — ${row.setor_atual || '-'} — ${row.status || '-'}`;
    });

    return [
      `✅ Encontrei lotes para cliente parecido com "${cliente}":`,
      ...linhas
    ].join('\n');
  }

  const [pedidos] = await dbPool.query(
    `
      SELECT
        p.pits_numero,
        p.pits_op,
        c.cli_nome AS nome_cliente,
        p.pits_nome_produto,
        p.pits_previsao
      FROM cli_pedidos_itens p
      LEFT JOIN cli_clientes c
        ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
      WHERE c.cli_nome LIKE ?
      ORDER BY p.id DESC
      LIMIT 8
    `,
    [like]
  );

  if (!pedidos.length) {
    return `⚠️ Não encontrei cliente parecido com "${cliente}".`;
  }

  const linhas = pedidos.map((row) => {
    return `• Pedido ${row.pits_numero || '-'} / OP ${row.pits_op || '-'} — ${row.pits_nome_produto || '-'} — previsão ${formatarDataCurta(row.pits_previsao)}`;
  });

  return [
    `✅ Encontrei pedidos para cliente parecido com "${cliente}":`,
    ...linhas
  ].join('\n');
}

async function resumoOperacionalWhatsapp() {
  const hasProducaoLotes = await tableExists('producao_lotes');
  if (!hasProducaoLotes) {
    return '⚠️ A tabela producao_lotes não foi encontrada no banco.';
  }

  const [porSetor] = await dbPool.query(
    `
      SELECT
        COALESCE(NULLIF(TRIM(setor_atual), ''), 'sem_setor') AS setor,
        COUNT(*) AS total
      FROM producao_lotes
      WHERE LOWER(COALESCE(status, '')) NOT IN ('finalizado', 'cancelado')
      GROUP BY COALESCE(NULLIF(TRIM(setor_atual), ''), 'sem_setor')
      ORDER BY total DESC
      LIMIT 8
    `
  );

  if (!porSetor.length) {
    return '✅ Não encontrei lotes ativos no momento.';
  }

  const linhas = porSetor.map((row) => `• ${row.setor}: ${row.total}`);

  return [
    '📊 Resumo operacional FactoryFlow:',
    ...linhas
  ].join('\n');
}

async function responderComOpenAISePrecisar(mensagem) {
  const interpretacao = await chamarOpenAIParaInterpretar(mensagem);

  if (!interpretacao) {
    const setorLocal = normalizarSetorPergunta(mensagem);
    if (setorLocal && (limparTexto(mensagem).includes('quais') || limparTexto(mensagem).includes('lotes') || limparTexto(mensagem).includes('estao'))) {
      return consultarLotesPorSetorWhatsapp(setorLocal);
    }
    return null;
  }

  const intent = String(interpretacao.intent || '').trim();
  const numero = String(interpretacao.numero || '').trim();
  const setor = String(interpretacao.setor || '').trim();
  const cliente = String(interpretacao.cliente || '').trim();

  if (intent === 'consultar_numero' && numero) {
    return consultarPedidoOuOpWhatsapp(numero);
  }

  if (intent === 'listar_setor') {
    return consultarLotesPorSetorWhatsapp(setor || mensagem);
  }

  if (intent === 'buscar_cliente') {
    return consultarClienteWhatsapp(cliente || mensagem);
  }

  if (intent === 'resumo_operacional') {
    return resumoOperacionalWhatsapp();
  }

  if (intent === 'ajuda') {
    return [
      '🤖 IndusOne IA — FactoryFlow',
      'Você pode perguntar:',
      '• status',
      '• onde está o pedido 087153?',
      '• quais lotes estão no laboratório?',
      '• cliente Carbofibras',
      '• resumo operacional'
    ].join('\n');
  }

  return null;
}

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const mensagem = String(req.body.Body || '').trim();
    const numero = String(req.body.From || '').trim();

    console.log('📩 WhatsApp recebido:', mensagem);
    console.log('📱 Número:', numero);

    let resposta = '';
    const msgLower = limparTexto(mensagem);

    if (!mensagem) {
      resposta = 'Recebi sua mensagem, mas ela veio vazia.';
    } else if (['status', 'teste', 'ping'].includes(msgLower)) {
      resposta = '✅ WhatsApp conectado ao backend FactoryFlow + IA. Pode mandar uma OP, pedido, cliente ou setor para consultar.';
    } else if (msgLower.includes('ajuda') || msgLower.includes('menu')) {
      resposta = [
        '🤖 IndusOne IA — FactoryFlow',
        'Você pode perguntar:',
        '• status',
        '• onde está o pedido 087153?',
        '• quais lotes estão no laboratório?',
        '• cliente Carbofibras',
        '• resumo operacional'
      ].join('\n');
    } else {
      // 1) Se tiver número, consulta direto no banco.
      resposta = await consultarPedidoOuOpWhatsapp(mensagem);

      // 2) Se não tiver número, usa OpenAI para interpretar e consultar o banco.
      if (!resposta) {
        resposta = await responderComOpenAISePrecisar(mensagem);
      }

      // 3) Fallback.
      if (!resposta) {
        resposta = [
          'Recebi sua mensagem.',
          OPENAI_API_KEY
            ? 'Não consegui entender qual consulta fazer ainda.'
            : 'A IA ainda não está ativada. Configure OPENAI_API_KEY no Railway para entender perguntas naturais.',
          '',
          'Exemplos:',
          '• onde está 087153',
          '• quais lotes estão no laboratório?',
          '• cliente Carbofibras',
          '• resumo operacional'
        ].join('\n');
      }
    }

    res.type('text/xml');
    return res.status(200).send(twimlResponse(resposta));
  } catch (err) {
    console.error('❌ Erro webhook WhatsApp:', err);
    res.type('text/xml');
    return res.status(200).send(twimlResponse('❌ Erro interno ao consultar o FactoryFlow.'));
  }
});

app.get('/webhook/whatsapp', (req, res) => {
  res.json({
    ok: true,
    message: 'Webhook WhatsApp FactoryFlow + IA ativo. Configure a Twilio para enviar POST para esta URL.',
    openai_configurada: !!OPENAI_API_KEY,
    model: OPENAI_MODEL,
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


app.get('/api/clientes/:codigo', async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    if (!codigo) return sendError(res, 400, 'Informe o código do cliente');

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
        WHERE TRIM(cli_codigo) = TRIM(?)
           OR CAST(TRIM(cli_codigo) AS UNSIGNED) = CAST(TRIM(?) AS UNSIGNED)
        LIMIT 1
      `,
      [codigo, codigo]
    );

    if (!rows.length) return sendError(res, 404, 'Cliente não encontrado');
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /api/clientes/:codigo erro:', err.message);
    sendError(res, 500, 'Erro ao buscar cliente por código', err.message);
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
// PRODUTOS REAIS DA EMPRESA
// =========================

app.get('/api/produtos', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const limit = Math.min(toPositiveInt(req.query.limit, 500), 5000);
    const offset = toPositiveInt(req.query.offset, 0);

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(`
        (
          pro_codigo LIKE ?
          OR pro_nome LIKE ?
          OR pro_grupo_nome LIKE ?
          OR pro_linha LIKE ?
        )
      `);
      params.push(search, search, search, search);
    }

    // Filtro final definido para a Induscolor:
    // Entra: Endurecedor, Soluções, Testes e Pastas Internas.
    // Sai: Matéria-prima, Solvente, Embalagens e Diversos.
    conditions.push(`
      COALESCE(pro_grupo_nome, '') NOT LIKE '%MATERIA%'
      AND COALESCE(pro_grupo_nome, '') NOT LIKE '%MATÉRIA%'
      AND COALESCE(pro_grupo_nome, '') NOT LIKE '%SOLVENTE%'
      AND COALESCE(pro_grupo_nome, '') NOT LIKE '%EMBALAG%'
      AND COALESCE(pro_grupo_nome, '') NOT LIKE '%DIVERSO%'
    `);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM cli_produtos ${where}`,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          pro_codigo AS id,
          pro_codigo AS code,
          pro_nome AS name,
          pro_grupo AS grupo,
          pro_grupo_nome AS grupo_nome,
          COALESCE(NULLIF(TRIM(pro_linha), ''), pro_grupo_nome, 'Sem linha') AS type,
          pro_linha AS linha,
          1 AS active
        FROM cli_produtos
        ${where}
        ORDER BY pro_nome ASC, pro_codigo ASC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      total: Number(total || 0),
      limit,
      offset,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/produtos erro:', err.message);
    sendError(res, 500, 'Erro ao buscar produtos reais da empresa', err.message);
  }
});


// =========================
// MOTORISTAS (USERS CENTRAL)
// =========================

app.get('/api/motoristas', async (req, res) => {
  try {
    const [rows] = await dbPool.query(`
      SELECT
        id,
        COALESCE(NULLIF(TRIM(nome), ''), NULLIF(TRIM(usuario), ''), CONCAT('Motorista ', id)) AS name,
        usuario AS login,
        role,
        acesso_factoryflow,
        ativo
      FROM users
      WHERE COALESCE(ativo, 1) = 1
        AND (
          LOWER(COALESCE(role, '')) IN ('driver', 'motorista')
          OR LOWER(COALESCE(acesso_factoryflow, '')) IN ('driver', 'motorista')
          OR LOWER(COALESCE(acesso_factoryflow, '')) LIKE '%motor%'
        )
      ORDER BY name ASC
    `);

    res.json({
      ok: true,
      total: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/motoristas erro:', err.message);
    sendError(res, 500, 'Erro ao buscar motoristas', err.message);
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

// =========================
// PRODUÇÃO - LOTE MANUAL (FactoryFlow -> CQVision)
// =========================

async function criarLoteManual(req, res) {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(
        res,
        404,
        'Tabela producao_lotes não encontrada',
        'Crie a tabela producao_lotes antes de criar lote manual.'
      );
    }

    await ensureProductionLotesManualColumns();

    const body = req.body || {};
    const numeroPedido = String(body.numero_pedido || body.pedido || body.numero || '').trim();
    const op = String(body.op || body.pits_op || '').trim();
    const produtoCodigo = String(body.produto_codigo || body.codigo_produto || body.pits_produto || '').trim();
    const produtoNome = String(body.produto_nome || body.nome_produto || body.pits_nome_produto || '').trim();
    const clienteCodigo = String(body.cliente_codigo || body.codigo_cliente || body.pits_cliente || '').trim();
    const clienteNome = String(body.cliente_nome || body.nome_cliente || body.cliente || '').trim();
    const clienteEndereco = String(body.cliente_endereco || body.endereco || '').trim();
    const clienteBairro = String(body.cliente_bairro || body.bairro || '').trim();
    const clienteCidade = String(body.cliente_cidade || body.cidade || '').trim();
    const clienteCep = String(body.cliente_cep || body.cep || '').trim();
    const clienteEstado = String(body.cliente_estado || body.estado || '').trim();
    const tipoLote = String(body.tipo_lote || body.tipo || 'manual').trim();
    const linhaProduto = String(body.linha_produto || body.linha || body.product_type || '').trim();
    const prioridade = String(body.prioridade || body.urgencia || 'normal').trim();
    const setorAtual = String(body.setor_atual || body.setor || 'moagem').trim();
    const status = String(body.status || 'aguardando').trim();
    const quantidade = Number(body.quantidade ?? body.pits_qtde ?? body.qtd ?? 0) || 0;

    if (!op) return sendError(res, 400, 'Informe a OP/lote');
    if (!produtoNome && !produtoCodigo) return sendError(res, 400, 'Informe o produto');

    const [duplicados] = await dbPool.query(
      `SELECT id FROM producao_lotes WHERE TRIM(op) = TRIM(?) LIMIT 1`,
      [op]
    );

    if (duplicados.length) {
      return sendError(
        res,
        409,
        'Já existe um lote com essa OP em produção',
        `Lote existente ID ${duplicados[0].id}`
      );
    }

    const [result] = await dbPool.query(
      `
        INSERT INTO producao_lotes (
          numero_pedido,
          op,
          produto_codigo,
          produto_nome,
          tipo_lote,
          quantidade,
          cliente_codigo,
          cliente_nome,
          cliente_endereco,
          cliente_bairro,
          cliente_cidade,
          cliente_cep,
          cliente_estado,
          status,
          prioridade,
          classificado_pcp,
          liberado_pcp,
          setor_atual,
          origem,
          linha_produto
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'MANUAL', ?)
      `,
      [
        numeroPedido || `MANUAL-${op}`,
        op,
        produtoCodigo,
        produtoNome || produtoCodigo,
        tipoLote,
        quantidade,
        clienteCodigo,
        clienteNome,
        clienteEndereco,
        clienteBairro,
        clienteCidade,
        clienteCep,
        clienteEstado,
        status,
        prioridade,
        setorAtual,
        linhaProduto
      ]
    );

    const [rows] = await dbPool.query(
      `SELECT * FROM producao_lotes WHERE id = ? LIMIT 1`,
      [result.insertId]
    );

    return res.json({
      ok: true,
      message: 'Lote manual criado com sucesso',
      data: rows[0]
    });
  } catch (err) {
    console.error('POST /api/producao/manual erro:', err.message);
    return sendError(res, 500, 'Erro ao criar lote manual', err.message);
  }
}

app.post('/api/producao/manual', criarLoteManual);
app.post('/api/lotes', criarLoteManual);

app.get('/api/lote/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const lote = await getProductionLoteByOp(op);
    if (lote) {
      return res.json({
        ok: true,
        origem: 'producao_lotes',
        data: {
          op: lote.op,
          pedido: lote.numero_pedido,
          numero_pedido: lote.numero_pedido,
          cliente_codigo: lote.cliente_codigo,
          cliente_nome: lote.cliente_nome,
          produto_codigo: lote.produto_codigo,
          produto_nome: lote.produto_nome,
          quantidade: lote.quantidade,
          linha_produto: lote.linha_produto,
          tipo_lote: lote.tipo_lote,
          prioridade: lote.prioridade,
          status: lote.status,
          setor_atual: lote.setor_atual,
          origem: lote.origem,
          ff_lotStatus: lote.ff_lotStatus || null,
          ff_sectorEnteredAt: lote.ff_sectorEnteredAt || null,
          ff_workSessions: lote.ff_workSessions || null,
          ff_expedientePausedStatus: lote.ff_expedientePausedStatus || null,
          ff_history: lote.ff_history || null
        }
      });
    }

    const pedido = await getPedidoItemByOp(op);
    if (pedido) {
      return res.json({
        ok: true,
        origem: 'cli_pedidos_itens',
        data: {
          op: pedido.pits_op,
          pedido: pedido.pits_numero,
          numero_pedido: pedido.pits_numero,
          cliente_codigo: pedido.pits_cliente,
          cliente_nome: pedido.nome_cliente,
          previsao: pedido.pits_previsao,
          produto_codigo: pedido.pits_produto,
          produto_nome: pedido.pits_nome_produto,
          quantidade: pedido.pits_qtde,
          peso: pedido.pits_peso,
          revisao: pedido.pits_revisao,
          viscosidade_padrao: pedido.pits_viscosidade,
          densidade_padrao: pedido.pits_densidade,
          fineza_padrao: pedido.pits_fineza,
          linha_produto: null,
          tipo_lote: null,
          origem: 'AUTO'
        }
      });
    }

    return sendError(res, 404, 'Lote/OP não encontrado');
  } catch (err) {
    console.error('GET /api/lote/:op erro:', err.message);
    return sendError(res, 500, 'Erro ao buscar lote por OP', err.message);
  }
});


// =========================
// PRODUÇÃO - ROTA LEVE PARA ABERTURA DO FACTORYFLOW
// =========================
// Esta rota é usada pelo frontend para abrir o app rápido.
// Ela evita a query pesada de /api/producao, que faz JOINs, GROUP BY e enrich completo.
// Para detalhes completos de um lote, continue usando GET /api/producao/:id ou /api/lote/:op.
app.get('/api/producao/ativos', async (req, res) => {
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

    const limit = Math.min(toPositiveInt(req.query.limit, 300), 1000);
    const offset = toPositiveInt(req.query.offset, 0);
    const status = req.query.status || null;
    const setor = req.query.setor || null;
    const search = req.query.search ? `%${req.query.search}%` : null;

    const conditions = [
      "LOWER(COALESCE(pl.status, '')) NOT IN ('finalizado', 'cancelado', 'rejeitado')"
    ];
    const params = [];

    if (status) {
      conditions.push('pl.status = ?');
      params.push(status);
    }

    if (setor) {
      conditions.push('pl.setor_atual = ?');
      params.push(setor);
    }

    if (search) {
      conditions.push('(pl.cliente_nome LIKE ? OR pl.produto_nome LIKE ? OR pl.numero_pedido LIKE ? OR pl.op LIKE ?)');
      params.push(search, search, search, search);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [rows] = await dbPool.query(
      `
        SELECT
          pl.id,
          pl.numero_pedido,
          pl.op,
          pl.produto_codigo,
          pl.produto_nome,
          pl.tipo_lote,
          pl.quantidade,
          pl.cliente_codigo,
          pl.cliente_nome,
          pl.cliente_endereco,
          pl.cliente_bairro,
          pl.cliente_cidade,
          pl.cliente_cep,
          pl.cliente_estado,
          pl.status,
          pl.prioridade,
          pl.classificado_pcp,
          pl.liberado_pcp,
          pl.setor_atual,
          pl.data_criacao,
          pl.updated_at,
          pl.origem,
          pl.linha_produto,
          pl.cq_status,
          pl.ff_lotStatus,
          pl.ff_sectorEnteredAt,
          pl.ff_workSessions,
          pl.ff_expedientePausedStatus,
          pl.ff_history,

          COALESCE(
            (
              SELECT p1.pits_previsao
              FROM cli_pedidos_itens p1
              WHERE TRIM(p1.pits_op) = TRIM(pl.op)
              ORDER BY p1.id ASC
              LIMIT 1
            ),
            (
              SELECT MIN(p2.pits_previsao)
              FROM cli_pedidos_itens p2
              WHERE TRIM(p2.pits_numero) = TRIM(pl.numero_pedido)
            )
          ) AS pits_previsao,

          COALESCE(
            (
              SELECT p1.pits_previsao
              FROM cli_pedidos_itens p1
              WHERE TRIM(p1.pits_op) = TRIM(pl.op)
              ORDER BY p1.id ASC
              LIMIT 1
            ),
            (
              SELECT MIN(p2.pits_previsao)
              FROM cli_pedidos_itens p2
              WHERE TRIM(p2.pits_numero) = TRIM(pl.numero_pedido)
            )
          ) AS previsao_entrega

        FROM producao_lotes pl
        ${where}
        ORDER BY pl.updated_at DESC, pl.data_criacao DESC, pl.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const data = rows.map((row) => ({
      ...row,
      deliveryDate: row.pits_previsao || row.previsao_entrega || null,
      delivery_date: row.pits_previsao || row.previsao_entrega || null,
      data_entrega: row.pits_previsao || row.previsao_entrega || null,
    }));

    return res.json({
      ok: true,
      total: data.length,
      limit,
      offset,
      mode: 'fast',
      data,
    });
  } catch (err) {
    console.error('GET /api/producao/ativos erro:', err.message);
    return sendError(res, 500, 'Erro ao buscar lotes ativos de produção', err.message);
  }
});

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

    // IMPORTANTE:
    // A tela do FactoryFlow usa /api/producao para montar os pedidos.
    // Antes esta rota retornava apenas producao_lotes, e essa tabela não tem pits_previsao.
    // Por isso o front recebia deliveryDate vazio.
    //
    // Aqui enriquecemos cada lote com a previsão vinda de cli_pedidos_itens.
    // Primeiro tentamos pelo OP, que é o vínculo mais forte.
    // Depois tentamos pelo número do pedido, para cobrir lote manual ou OP divergente.
    const [rows] = await dbPool.query(
      `
        SELECT
          pl.*,

          COALESCE(
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS pits_previsao,

          COALESCE(
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS previsao_entrega,

          COALESCE(
            pi_op.pits_numero,
            pi_pedido.pits_numero,
            pl.numero_pedido
          ) AS pedido_origem,

          COALESCE(
            pi_op.pits_cliente,
            pi_pedido.pits_cliente,
            pl.cliente_codigo
          ) AS pits_cliente,

          COALESCE(
            pi_op.pits_produto,
            pi_pedido.pits_produto,
            pl.produto_codigo
          ) AS pits_produto,

          COALESCE(
            pi_op.pits_nome_produto,
            pi_pedido.pits_nome_produto,
            pl.produto_nome
          ) AS pits_nome_produto,

          COALESCE(
            pi_op.pits_qtde,
            pi_pedido.pits_qtde,
            pl.quantidade
          ) AS pits_qtde,

          COALESCE(
            c_op.cli_nome,
            c_pedido.cli_nome,
            pl.cliente_nome
          ) AS nome_cliente_pedido,

          COALESCE(
            c_op.cli_endereco,
            c_pedido.cli_endereco,
            pl.cliente_endereco
          ) AS cli_endereco,

          COALESCE(
            c_op.cli_bairro,
            c_pedido.cli_bairro,
            pl.cliente_bairro
          ) AS cli_bairro,

          COALESCE(
            c_op.cli_cidade,
            c_pedido.cli_cidade,
            pl.cliente_cidade
          ) AS cli_cidade,

          COALESCE(
            c_op.cli_cep,
            c_pedido.cli_cep,
            pl.cliente_cep
          ) AS cli_cep,

          COALESCE(
            c_op.cli_estado,
            c_pedido.cli_estado,
            pl.cliente_estado
          ) AS cli_estado

        FROM producao_lotes pl

        LEFT JOIN cli_pedidos_itens pi_op
          ON TRIM(pi_op.pits_op) = TRIM(pl.op)

        LEFT JOIN cli_clientes c_op
          ON CAST(TRIM(c_op.cli_codigo) AS UNSIGNED) = CAST(TRIM(pi_op.pits_cliente) AS UNSIGNED)

        LEFT JOIN (
          SELECT
            pits_numero,
            MIN(pits_previsao) AS pits_previsao,
            MIN(pits_cliente) AS pits_cliente,
            MIN(pits_produto) AS pits_produto,
            MAX(pits_nome_produto) AS pits_nome_produto,
            SUM(COALESCE(pits_qtde, 0)) AS pits_qtde
          FROM cli_pedidos_itens
          WHERE pits_numero IS NOT NULL
            AND pits_numero <> ''
          GROUP BY pits_numero
        ) pi_pedido
          ON TRIM(pi_pedido.pits_numero) = TRIM(pl.numero_pedido)

        LEFT JOIN cli_clientes c_pedido
          ON CAST(TRIM(c_pedido.cli_codigo) AS UNSIGNED) = CAST(TRIM(pi_pedido.pits_cliente) AS UNSIGNED)

        ${where.replace(/\bstatus\b/g, 'pl.status')
               .replace(/\bsetor_atual\b/g, 'pl.setor_atual')
               .replace(/\bcliente_nome\b/g, 'pl.cliente_nome')
               .replace(/\bproduto_nome\b/g, 'pl.produto_nome')
               .replace(/\bnumero_pedido\b/g, 'pl.numero_pedido')
               .replace(/\bop\b/g, 'pl.op')}

        GROUP BY pl.id
        ORDER BY pl.data_criacao DESC, pl.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const data = rows.map((row) => ({
      ...row,

      // Compatibilidade com o front:
      // data.js procura estes nomes.
      deliveryDate: row.pits_previsao || row.previsao_entrega || null,
      delivery_date: row.pits_previsao || row.previsao_entrega || null,
      data_entrega: row.pits_previsao || row.previsao_entrega || null,

      // Se o pedido real trouxe dados melhores que o lote manual, já devolve enriquecido.
      cliente_nome: row.nome_cliente_pedido || row.cliente_nome,
      cliente_endereco: row.cli_endereco || row.cliente_endereco,
      cliente_bairro: row.cli_bairro || row.cliente_bairro,
      cliente_cidade: row.cli_cidade || row.cliente_cidade,
      cliente_cep: row.cli_cep || row.cliente_cep,
      cliente_estado: row.cli_estado || row.cliente_estado,
      produto_nome: row.pits_nome_produto || row.produto_nome,
      produto_codigo: row.pits_produto || row.produto_codigo,
      quantidade: row.pits_qtde || row.quantidade,
    }));

    res.json({
      ok: true,
      total: Number(total),
      limit,
      offset,
      data,
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
      'rota_escolhida',
      'ff_lotStatus',
      'ff_sectorEnteredAt',
      'ff_workSessions',
      'ff_expedientePausedStatus',
      'ff_history'
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
// FACTORYFLOW - EXPEDIENTE POR SETOR
// =========================

app.get('/api/expediente', async (req, res) => {
  try {
    await ensureSectorShiftTable();

    const [rows] = await dbPool.query(`
      SELECT
        id,
        setor,
        expediente_aberto,
        iniciado_em,
        finalizado_em,
        atualizado_em
      FROM ff_sector_shifts
      ORDER BY setor ASC
    `);

    res.json({ ok: true, total: rows.length, data: rows });
  } catch (err) {
    console.error('GET /api/expediente erro:', err.message);
    sendError(res, 500, 'Erro ao buscar expediente dos setores', err.message);
  }
});

app.get('/api/expediente/:setor', async (req, res) => {
  try {
    await ensureSectorShiftTable();

    const setor = normalizeShiftSetor(req.params.setor);
    if (!setor) return sendError(res, 400, 'Setor obrigatório');

    const [rows] = await dbPool.query(
      `SELECT * FROM ff_sector_shifts WHERE setor = ? LIMIT 1`,
      [setor]
    );

    if (!rows.length) {
      await dbPool.query(
        `INSERT INTO ff_sector_shifts (setor, expediente_aberto) VALUES (?, 0)`,
        [setor]
      );

      const [created] = await dbPool.query(
        `SELECT * FROM ff_sector_shifts WHERE setor = ? LIMIT 1`,
        [setor]
      );

      return res.json({ ok: true, data: created[0] });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /api/expediente/:setor erro:', err.message);
    sendError(res, 500, 'Erro ao buscar expediente do setor', err.message);
  }
});

app.post('/api/expediente/toggle', async (req, res) => {
  try {
    await ensureSectorShiftTable();

    const setor = normalizeShiftSetor(req.body?.setor);
    const aberto = Number(req.body?.expediente_aberto) === 1 || req.body?.expediente_aberto === true;

    if (!setor) return sendError(res, 400, 'Setor obrigatório');

    if (aberto) {
      await dbPool.query(
        `
          INSERT INTO ff_sector_shifts (setor, expediente_aberto, iniciado_em, finalizado_em)
          VALUES (?, 1, NOW(), NULL)
          ON DUPLICATE KEY UPDATE
            expediente_aberto = 1,
            iniciado_em = NOW(),
            finalizado_em = NULL
        `,
        [setor]
      );
    } else {
      await dbPool.query(
        `
          INSERT INTO ff_sector_shifts (setor, expediente_aberto, finalizado_em)
          VALUES (?, 0, NOW())
          ON DUPLICATE KEY UPDATE
            expediente_aberto = 0,
            finalizado_em = NOW()
        `,
        [setor]
      );
    }

    const [rows] = await dbPool.query(
      `SELECT * FROM ff_sector_shifts WHERE setor = ? LIMIT 1`,
      [setor]
    );

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /api/expediente/toggle erro:', err.message);
    sendError(res, 500, 'Erro ao alterar expediente do setor', err.message);
  }
});


// =========================
// CQ VISION - PREVISÕES AUTOMÁTICAS (FactoryFlow + Histórico CQ)
// =========================

function cqPrevisaoParseNumber(value) {
  if (value === null || value === undefined) return null;

  const cleaned = String(value)
    .replace(',', '.')
    .replace(/[^\d.-]/g, '')
    .trim();

  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cqPrevisaoFormatDiff(value, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;

  const n = Number(value);
  const sign = n > 0 ? '+' : '';
  const fixed = Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(1);
  return `${sign}${fixed.replace('.', ',')}${suffix}`;
}

function cqPrevisaoTipoPorResultado(resultado) {
  const r = String(resultado || '').toLowerCase();
  if (r.includes('reprov')) return 'danger';
  if (r.includes('reajuste')) return 'warning';
  if (r.includes('aprov')) return 'success';
  return 'info';
}

function cqPrevisaoBuildSugestoes({ padroes, historico, reajustes }) {
  const sugestoes = [];

  if (!historico || !historico.length) {
    return [
      {
        tipo: 'info',
        titulo: 'Nenhuma análise encontrada',
        mensagem: 'Nenhuma análise foi encontrada. Esse será o primeiro lançamento no CQVision. Favor consultar planilha de controle.'
      }
    ];
  }

  const ultimo = historico[0] || {};

  const viscPadrao = cqPrevisaoParseNumber(padroes?.viscosidade_padrao);
  const densPadrao = cqPrevisaoParseNumber(padroes?.densidade_padrao);
  const finezaPadrao = cqPrevisaoParseNumber(padroes?.fineza_padrao);

  const viscInicial = cqPrevisaoParseNumber(ultimo.viscosidade_inicial || ultimo.viscosidade_encontrada);
  const viscFinal = cqPrevisaoParseNumber(ultimo.viscosidade_final || ultimo.viscosidade_encontrada);
  const densEncontrada = cqPrevisaoParseNumber(ultimo.densidade_encontrada);
  const finezaEncontrada = cqPrevisaoParseNumber(ultimo.fineza_encontrada);

  if (viscPadrao !== null && viscInicial !== null) {
    const diffInicial = viscInicial - viscPadrao;

    if (diffInicial > 2) {
      sugestoes.push({
        tipo: 'warning',
        titulo: 'Viscosidade inicial acima do padrão',
        mensagem: `No último lote, a viscosidade inicial ficou ${cqPrevisaoFormatDiff(diffInicial, ' KU')} acima do padrão. Avaliar tendência de viscosidade alta antes da produção/revisão.`
      });
    } else if (diffInicial < -2) {
      sugestoes.push({
        tipo: 'warning',
        titulo: 'Viscosidade inicial abaixo do padrão',
        mensagem: `No último lote, a viscosidade inicial ficou ${cqPrevisaoFormatDiff(diffInicial, ' KU')} abaixo do padrão. Avaliar corpo/estrutura da tinta antes da liberação.`
      });
    } else {
      sugestoes.push({
        tipo: 'success',
        titulo: 'Viscosidade inicial próxima do padrão',
        mensagem: 'A viscosidade inicial do último lote ficou próxima do padrão informado.'
      });
    }
  }

  if (viscPadrao !== null && viscFinal !== null) {
    const diffFinal = viscFinal - viscPadrao;

    if (Math.abs(diffFinal) <= 2) {
      sugestoes.push({
        tipo: 'success',
        titulo: 'Viscosidade final ajustada',
        mensagem: 'A viscosidade final do último lote ficou próxima do padrão após análise/reajuste.'
      });
    } else {
      sugestoes.push({
        tipo: 'danger',
        titulo: 'Viscosidade final fora do padrão',
        mensagem: `Mesmo no resultado final, a viscosidade ficou ${cqPrevisaoFormatDiff(diffFinal, ' KU')} em relação ao padrão. Produto exige atenção especial.`
      });
    }
  }

  if (viscPadrao === null) {
    sugestoes.push({
      tipo: 'info',
      titulo: 'Viscosidade padrão não localizada',
      mensagem: 'A OP/produto não trouxe viscosidade padrão em cli_pedidos_itens. A comparação foi feita apenas com histórico disponível.'
    });
  }

  if (densPadrao !== null && densEncontrada !== null) {
    const diffDens = densEncontrada - densPadrao;

    if (diffDens < -0.01) {
      sugestoes.push({
        tipo: 'warning',
        titulo: 'Densidade abaixo do padrão',
        mensagem: `A densidade do último lote ficou ${cqPrevisaoFormatDiff(diffDens)} abaixo do padrão. Atenção ao rendimento e risco de sobra no envase.`
      });
    } else if (diffDens > 0.01) {
      sugestoes.push({
        tipo: 'warning',
        titulo: 'Densidade acima do padrão',
        mensagem: `A densidade do último lote ficou ${cqPrevisaoFormatDiff(diffDens)} acima do padrão. Conferir carga, pigmentação e possíveis correções.`
      });
    } else {
      sugestoes.push({
        tipo: 'success',
        titulo: 'Densidade próxima do padrão',
        mensagem: 'A densidade encontrada no último lote ficou próxima do padrão informado.'
      });
    }
  }

  if (densPadrao === null) {
    sugestoes.push({
      tipo: 'info',
      titulo: 'Densidade padrão não localizada',
      mensagem: 'A OP/produto não trouxe densidade padrão em cli_pedidos_itens. A comparação foi feita apenas com histórico disponível.'
    });
  }

  if (finezaPadrao !== null && finezaEncontrada !== null && finezaEncontrada > finezaPadrao) {
    sugestoes.push({
      tipo: 'warning',
      titulo: 'Fineza acima do padrão',
      mensagem: `A fineza encontrada ficou acima do padrão. Verificar moagem/dispersão antes de liberar.`
    });
  }

  const total = historico.length;
  const comReajuste = historico.filter((a) => String(a.resultado || '').toLowerCase().includes('reajuste')).length;

  if (total > 0) {
    const perc = Math.round((comReajuste / total) * 100);

    if (perc >= 50) {
      sugestoes.push({
        tipo: 'danger',
        titulo: 'Produto crítico por frequência de reajuste',
        mensagem: `${perc}% dos últimos ${total} lançamentos tiveram reajuste. Produto deve ser tratado com atenção especial na revisão.`
      });
    } else if (perc > 0) {
      sugestoes.push({
        tipo: 'warning',
        titulo: 'Produto com histórico de reajuste',
        mensagem: `${perc}% dos últimos ${total} lançamentos tiveram reajuste. Conferir histórico antes da produção.`
      });
    }
  }

  if (reajustes && reajustes.length) {
    const ultimoReajuste = reajustes[0];
    sugestoes.push({
      tipo: 'info',
      titulo: 'Último reajuste registrado',
      mensagem: `Motivo: ${ultimoReajuste.motivo_reajuste || '—'}. Matéria-prima: ${ultimoReajuste.materia_prima_nome || '—'}${ultimoReajuste.materia_prima_qtd ? ` (${ultimoReajuste.materia_prima_qtd})` : ''}.`
    });
  }

  if (!sugestoes.length) {
    sugestoes.push({
      tipo: 'info',
      titulo: 'Sem alerta relevante',
      mensagem: 'Há histórico para este produto, mas não foi identificado desvio relevante pelas regras automáticas.'
    });
  }

  return sugestoes;
}

app.get('/api/cq/previsoes/ops', async (req, res) => {
  try {
    const setoresQuery = String(req.query.setores || '').trim();
    const setores = setoresQuery
      ? setoresQuery.split(',').map(s => s.trim()).filter(Boolean)
      : ['laboratorio_revisao', 'coloracao', 'coloracao_revisao'];

    const placeholders = setores.map(() => '?').join(',');

    const [rows] = await dbPool.query(
      `
        SELECT 
          pl.id,
          pl.numero_pedido,
          pl.op,
          pl.produto_codigo,
          pl.produto_nome,
          pl.tipo_lote,
          pl.quantidade,
          pl.cliente_codigo,
          pl.cliente_nome,
          pl.setor_atual,
          pl.status,
          pl.prioridade,
          pl.linha_produto,
          pl.updated_at,
          pl.data_criacao,

          cpi.pits_viscosidade AS viscosidade_padrao,
          cpi.pits_densidade AS densidade_padrao,
          cpi.pits_fineza AS fineza_padrao,
          cpi.pits_revisao AS revisao,
          cpi.pits_previsao AS previsao_entrega

        FROM producao_lotes pl
        LEFT JOIN cli_pedidos_itens cpi 
          ON TRIM(cpi.pits_op) = TRIM(pl.op)

        WHERE COALESCE(pl.liberado_pcp, 0) = 1
          AND COALESCE(pl.classificado_pcp, 0) = 1
          AND LOWER(COALESCE(pl.tipo_lote, '')) = 'tinta'
          AND pl.setor_atual IN (${placeholders})
          AND COALESCE(pl.cq_status, 'pendente') = 'pendente'

        GROUP BY pl.id
        ORDER BY pl.updated_at DESC, pl.id DESC
        LIMIT 200
      `,
      setores
    );

    res.json({
      ok: true,
      total: rows.length,
      data: rows
    });
  } catch (err) {
    console.error('GET /api/cq/previsoes/ops erro:', err.message);
    sendError(res, 500, 'Erro ao buscar OPs para previsão', err.message);
  }
});

app.get('/api/cq/previsoes/produto/:codigoOuOp', async (req, res) => {
  try {
    const codigoOuOp = String(req.params.codigoOuOp || '').trim();
    const opQuery = String(req.query.op || '').trim();

    if (!codigoOuOp) {
      return sendError(res, 400, 'Informe o código do produto ou OP');
    }

    let loteAtual = null;
    let codigoProduto = codigoOuOp;

    // Se vier uma OP/lote, primeiro resolvemos qual é o produto_codigo.
    const opParaResolver = opQuery || (/^\d{5,8}$/.test(codigoOuOp) ? codigoOuOp : '');

    if (opParaResolver) {
      const [loteRows] = await dbPool.query(
        `
          SELECT 
            pl.*,
            cpi.pits_viscosidade AS viscosidade_padrao,
            cpi.pits_densidade AS densidade_padrao,
            cpi.pits_fineza AS fineza_padrao,
            cpi.pits_revisao AS revisao,
            cpi.pits_previsao AS previsao_entrega
          FROM producao_lotes pl
          LEFT JOIN cli_pedidos_itens cpi 
            ON TRIM(cpi.pits_op) = TRIM(pl.op)
          WHERE TRIM(pl.op) = TRIM(?)
          ORDER BY pl.id DESC
          LIMIT 1
        `,
        [opParaResolver]
      );

      loteAtual = loteRows[0] || null;

      if (loteAtual?.produto_codigo) {
        codigoProduto = String(loteAtual.produto_codigo).trim();
      }
    }

    // Se o parâmetro ainda parece OP, tenta resolver pela tabela de pedidos.
    if (/^\d{5,8}$/.test(codigoProduto)) {
      const [pedidoRows] = await dbPool.query(
        `
          SELECT
            pits_op,
            pits_numero,
            pits_cliente,
            pits_produto,
            pits_nome_produto,
            pits_qtde,
            pits_peso,
            pits_viscosidade AS viscosidade_padrao,
            pits_densidade AS densidade_padrao,
            pits_fineza AS fineza_padrao,
            pits_revisao AS revisao,
            pits_previsao AS previsao_entrega
          FROM cli_pedidos_itens
          WHERE TRIM(pits_op) = TRIM(?)
          ORDER BY id DESC
          LIMIT 1
        `,
        [codigoProduto]
      );

      if (pedidoRows.length && pedidoRows[0].pits_produto) {
        const pedido = pedidoRows[0];
        codigoProduto = String(pedido.pits_produto).trim();

        if (!loteAtual) {
          loteAtual = {
            op: pedido.pits_op,
            numero_pedido: pedido.pits_numero,
            produto_codigo: pedido.pits_produto,
            produto_nome: pedido.pits_nome_produto,
            quantidade: pedido.pits_qtde,
            peso: pedido.pits_peso,
            viscosidade_padrao: pedido.viscosidade_padrao,
            densidade_padrao: pedido.densidade_padrao,
            fineza_padrao: pedido.fineza_padrao,
            revisao: pedido.revisao,
            previsao_entrega: pedido.previsao_entrega
          };
        }
      }
    }

    let padroes = {
      viscosidade_padrao: loteAtual?.viscosidade_padrao || null,
      densidade_padrao: loteAtual?.densidade_padrao || null,
      fineza_padrao: loteAtual?.fineza_padrao || null,
      revisao: loteAtual?.revisao || null,
      previsao_entrega: loteAtual?.previsao_entrega || null
    };

    // Se o lote atual não trouxe padrões, busca os últimos padrões pelo código do produto.
    if (!padroes.viscosidade_padrao && !padroes.densidade_padrao) {
      const [padraoRows] = await dbPool.query(
        `
          SELECT
            pits_viscosidade AS viscosidade_padrao,
            pits_densidade AS densidade_padrao,
            pits_fineza AS fineza_padrao,
            pits_revisao AS revisao,
            pits_previsao AS previsao_entrega
          FROM cli_pedidos_itens
          WHERE TRIM(pits_produto) = TRIM(?)
          ORDER BY id DESC
          LIMIT 1
        `,
        [codigoProduto]
      );

      if (padraoRows.length) {
        padroes = {
          ...padroes,
          ...padraoRows[0]
        };
      }
    }

    // HISTÓRICO CORRETO: sempre pelo código do produto, não pela OP atual.
    const [historico] = await dbPool.query(
      `
        SELECT
          id,
          op,
          pedido,
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
          solidos_encontrado,
          resultado,
          usuario,
          criado_em,
          atualizado_em,
          solidos_a,
          solidos_ab,
          viscosidade_inicial,
          viscosidade_final,
          data_analise
        FROM cq_analises
        WHERE TRIM(produto_codigo) = TRIM(?)
        ORDER BY criado_em DESC, id DESC
        LIMIT 5
      `,
      [codigoProduto]
    );

    const analiseIds = historico.map((h) => h.id);
    let reajustes = [];

    if (analiseIds.length) {
      const placeholders = analiseIds.map(() => '?').join(',');

      const [reajusteRows] = await dbPool.query(
        `
          SELECT
            r.*,
            a.op,
            a.produto_codigo
          FROM cq_analises_reajustes r
          JOIN cq_analises a ON a.id = r.analise_id
          WHERE r.analise_id IN (${placeholders})
          ORDER BY r.criado_em DESC, r.id DESC
          LIMIT 20
        `,
        analiseIds
      );

      reajustes = reajusteRows;
    }

    const ultimo = historico[0] || null;
    const sugestoes = cqPrevisaoBuildSugestoes({
      padroes,
      historico,
      reajustes
    });

    const viscPadrao = cqPrevisaoParseNumber(padroes.viscosidade_padrao);
    const densPadrao = cqPrevisaoParseNumber(padroes.densidade_padrao);
    const finezaPadrao = cqPrevisaoParseNumber(padroes.fineza_padrao);

    const viscInicial = cqPrevisaoParseNumber(ultimo?.viscosidade_inicial || ultimo?.viscosidade_encontrada);
    const viscFinal = cqPrevisaoParseNumber(ultimo?.viscosidade_final || ultimo?.viscosidade_encontrada);
    const densEncontrada = cqPrevisaoParseNumber(ultimo?.densidade_encontrada);
    const finezaEncontrada = cqPrevisaoParseNumber(ultimo?.fineza_encontrada);

    const totalHistorico = historico.length;
    const totalReajuste = historico.filter((a) => String(a.resultado || '').toLowerCase().includes('reajuste')).length;

    res.json({
      ok: true,
      codigo: codigoProduto,
      codigoRecebido: codigoOuOp,
      op: opParaResolver || opQuery || null,
      temHistorico: totalHistorico > 0,
      classificacao: totalHistorico === 0
        ? 'sem_historico'
        : totalReajuste / totalHistorico >= 0.5
          ? 'critico'
          : totalReajuste > 0
            ? 'atencao'
            : 'estavel',
      loteAtual,
      padroes,
      ultimo,
      comparacao: {
        viscosidade_padrao: viscPadrao,
        viscosidade_inicial: viscInicial,
        viscosidade_final: viscFinal,
        diferenca_viscosidade_inicial: viscPadrao !== null && viscInicial !== null ? viscInicial - viscPadrao : null,
        diferenca_viscosidade_final: viscPadrao !== null && viscFinal !== null ? viscFinal - viscPadrao : null,
        densidade_padrao: densPadrao,
        densidade_encontrada: densEncontrada,
        diferenca_densidade: densPadrao !== null && densEncontrada !== null ? densEncontrada - densPadrao : null,
        fineza_padrao: finezaPadrao,
        fineza_encontrada: finezaEncontrada,
        diferenca_fineza: finezaPadrao !== null && finezaEncontrada !== null ? finezaEncontrada - finezaPadrao : null
      },
      resumo: {
        total_historico: totalHistorico,
        total_reajuste: totalReajuste,
        percentual_reajuste: totalHistorico ? Math.round((totalReajuste / totalHistorico) * 100) : 0,
        ultimo_resultado_tipo: cqPrevisaoTipoPorResultado(ultimo?.resultado)
      },
      historico,
      reajustes,
      sugestoes
    });
  } catch (err) {
    console.error('GET /api/cq/previsoes/produto/:codigoOuOp erro:', err.message);
    sendError(res, 500, 'Erro ao gerar previsão do produto', err.message);
  }
});


app.get('/api/cq/previsoes/op/:op', async (req, res) => {
  try {
    const op = String(req.params.op || '').trim();

    if (!op) {
      return sendError(res, 400, 'Informe a OP');
    }

    const [rows] = await dbPool.query(
      `
        SELECT 
          pl.op,
          pl.produto_codigo,
          pl.produto_nome,
          pl.numero_pedido,
          pl.cliente_nome,
          cpi.pits_viscosidade AS viscosidade_padrao,
          cpi.pits_densidade AS densidade_padrao,
          cpi.pits_fineza AS fineza_padrao,
          cpi.pits_revisao AS revisao,
          cpi.pits_previsao AS previsao_entrega
        FROM producao_lotes pl
        LEFT JOIN cli_pedidos_itens cpi 
          ON TRIM(cpi.pits_op) = TRIM(pl.op)
        WHERE TRIM(pl.op) = TRIM(?)
        ORDER BY pl.id DESC
        LIMIT 1
      `,
      [op]
    );

    if (!rows.length) {
      return sendError(res, 404, 'OP não encontrada para previsão');
    }

    const row = rows[0];
    req.params.codigo = row.produto_codigo;
    req.query.op = row.op;

    return res.redirect(307, `/api/cq/previsoes/produto/${encodeURIComponent(row.produto_codigo)}?op=${encodeURIComponent(row.op)}`);
  } catch (err) {
    console.error('GET /api/cq/previsoes/op/:op erro:', err.message);
    sendError(res, 500, 'Erro ao buscar previsão por OP', err.message);
  }
});

// =========================
// CQ VISION
// =========================

app.get('/api/cq/lotes/:op', async (req, res) => {
  try {
    const { op } = req.params;

    const loteManualOuProcessado = await getProductionLoteByOp(op);
    if (loteManualOuProcessado) {
      const row = loteManualOuProcessado;

      return res.json({
        ok: true,
        origem: 'producao_lotes',
        resumo: {
          pits_op: row.op,
          pits_numero: row.numero_pedido,
          pits_cliente: row.cliente_codigo,
          nome_cliente: row.cliente_nome,
          pits_previsao: null,
          total_registros: 1,
        },
        constantes: {
          pits_viscosidade: null,
          pits_densidade: null,
          pits_fineza: null,
          pits_revisao: null,
        },
        itens: [
          {
            id: row.id,
            pits_op: row.op,
            pits_numero: row.numero_pedido,
            pits_cliente: row.cliente_codigo,
            nome_cliente: row.cliente_nome,
            pits_previsao: null,
            pits_produto: row.produto_codigo,
            pits_nome_produto: row.produto_nome,
            pits_qtde: row.quantidade,
            pits_peso: null,
            pits_revisao: null,
            pits_viscosidade: null,
            pits_densidade: null,
            pits_fineza: null,
            linha_produto: row.linha_produto,
            tipo_lote: row.tipo_lote,
            origem: row.origem,
            ff_lotStatus: row.ff_lotStatus || null,
            ff_sectorEnteredAt: row.ff_sectorEnteredAt || null,
            ff_workSessions: row.ff_workSessions || null,
            ff_expedientePausedStatus: row.ff_expedientePausedStatus || null,
            ff_history: row.ff_history || null,
          }
        ],
      });
    }

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
          p.pits_fineza,
          'AUTO' AS origem
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        WHERE TRIM(p.pits_op) = TRIM(?)
        ORDER BY p.id ASC
      `,
      [op]
    );

    if (!rows.length) {
      return sendError(res, 404, 'Lote/OP não encontrado');
    }

    res.json({
      ok: true,
      origem: 'cli_pedidos_itens',
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

    const loteManualOuProcessado = await getProductionLoteByOp(op);
    if (loteManualOuProcessado) {
      const row = loteManualOuProcessado;

      return res.json({
        ok: true,
        origem: 'producao_lotes',
        data: {
          op: row.op,
          pedido: row.numero_pedido,
          numero_pedido: row.numero_pedido,
          cliente_codigo: row.cliente_codigo,
          cliente_nome: row.cliente_nome,
          previsao: null,
          produto_codigo: row.produto_codigo,
          produto_nome: row.produto_nome,
          quantidade: row.quantidade,
          peso: null,
          revisao: null,
          viscosidade_padrao: null,
          densidade_padrao: null,
          fineza_padrao: null,
          linha_produto: row.linha_produto,
          tipo_lote: row.tipo_lote,
          origem: row.origem,
          ff_lotStatus: row.ff_lotStatus || null,
          ff_sectorEnteredAt: row.ff_sectorEnteredAt || null,
          ff_workSessions: row.ff_workSessions || null,
          ff_expedientePausedStatus: row.ff_expedientePausedStatus || null,
          ff_history: row.ff_history || null,
        }
      });
    }

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
        WHERE TRIM(p.pits_op) = TRIM(?)
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
      origem: 'cli_pedidos_itens',
      data: {
        op: row.pits_op,
        pedido: row.pits_numero,
        numero_pedido: row.pits_numero,
        cliente_codigo: row.pits_cliente,
        cliente_nome: row.nome_cliente,
        previsao: row.pits_previsao,
        produto_codigo: row.pits_produto,
        produto_nome: row.pits_nome_produto,
        quantidade: Number(row.pits_peso || row.pits_qtde || 0),
        peso: row.pits_peso,
        revisao: row.pits_revisao,
        viscosidade_padrao: row.pits_viscosidade,
        densidade_padrao: row.pits_densidade,
        fineza_padrao: row.pits_fineza,
        linha_produto: null,
        tipo_lote: null,
        origem: 'AUTO'
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

async function getCqAnaliseCompletaById(id) {
  const [analises] = await dbPool.query(
    `
      SELECT *
      FROM cq_analises
      WHERE id = ?
      LIMIT 1
    `,
    [id]
  );

  if (!analises.length) return null;

  const analise = analises[0];

  const [reajustes] = await dbPool.query(
    `
      SELECT
        r.*,
        COALESCE(mp.mp_custo, 0) AS mp_custo,
        COALESCE(mp.mp_custo, 0) AS unit_cost
      FROM cq_analises_reajustes r
      LEFT JOIN cli_materia_prima mp
        ON TRIM(mp.mp_codigo) = TRIM(r.materia_prima_codigo)
      WHERE r.analise_id = ?
      ORDER BY r.numero_reajuste ASC, r.id ASC
    `,
    [id]
  );

  analise.reajustes = reajustes;
  analise.qtd_reajustes = reajustes.length;

  return analise;
}

app.get('/api/cq/analise/:id', async (req, res) => {
  try {
    const id = toPositiveInt(req.params.id, 0);

    if (!id) {
      return sendError(res, 400, 'ID da análise inválido');
    }

    const analise = await getCqAnaliseCompletaById(id);

    if (!analise) {
      return sendError(res, 404, 'Análise não encontrada');
    }

    res.json({
      ok: true,
      data: analise
    });
  } catch (err) {
    console.error('GET /api/cq/analise/:id erro:', err.message);
    sendError(res, 500, 'Erro ao buscar análise', err.message);
  }
});

app.put('/api/cq/analises/:id', async (req, res) => {
  try {
    const id = toPositiveInt(req.params.id, 0);

    if (!id) {
      return sendError(res, 400, 'ID da análise inválido');
    }

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
        UPDATE cq_analises
        SET
          op = ?,
          pedido = ?,
          cliente_codigo = ?,
          cliente_nome = ?,
          produto_codigo = ?,
          produto_nome = ?,
          linha_produto = ?,
          revisao = ?,
          viscosidade_padrao = ?,
          densidade_padrao = ?,
          fineza_padrao = ?,
          viscosidade_encontrada = ?,
          densidade_encontrada = ?,
          fineza_encontrada = ?,
          solidos_a = ?,
          solidos_ab = ?,
          observacoes = ?,
          resultado = ?,
          usuario = ?,
          data_analise = ?,
          viscosidade_inicial = ?,
          viscosidade_final = ?
        WHERE id = ?
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
        viscosidade_final || null,
        id
      ]
    );

    if (!result.affectedRows) {
      return sendError(res, 404, 'Análise não encontrada');
    }

    await dbPool.query(
      `DELETE FROM cq_analises_reajustes WHERE analise_id = ?`,
      [id]
    );

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
            id,
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

    const analiseAtualizada = await getCqAnaliseCompletaById(id);

    res.json({
      ok: true,
      id,
      data: analiseAtualizada,
      message: 'Análise atualizada com sucesso'
    });
  } catch (err) {
    console.error('PUT /api/cq/analises/:id erro:', err.message);
    sendError(res, 500, 'Erro ao atualizar análise', err.message);
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



// =========================
// CQ VISION - PRODUTOS LANÇADOS E PREVISÕES
// =========================

async function getCqProdutoHistorico(codigo, limit = 100) {
  const [analises] = await dbPool.query(
    `
      SELECT
        a.*,
        COUNT(r.id) AS qtd_reajustes,
        MAX(pinfo.total_quantidade) AS quantidade_total,
        MAX(pinfo.total_peso) AS peso_total
      FROM cq_analises a
      LEFT JOIN cq_analises_reajustes r
        ON r.analise_id = a.id
      LEFT JOIN (
        SELECT
          pits_op,
          SUM(COALESCE(pits_qtde, 0)) AS total_quantidade,
          SUM(COALESCE(pits_peso, 0)) AS total_peso
        FROM cli_pedidos_itens
        WHERE pits_op IS NOT NULL AND pits_op <> ''
        GROUP BY pits_op
      ) pinfo ON TRIM(pinfo.pits_op) = TRIM(a.op)
      WHERE TRIM(a.produto_codigo) = TRIM(?)
      GROUP BY a.id
      ORDER BY COALESCE(a.data_analise, DATE(a.criado_em)) DESC, a.id DESC
      LIMIT ?
    `,
    [codigo, limit]
  );

  if (!analises.length) return [];

  const ids = analises.map(a => a.id);
  const placeholders = ids.map(() => '?').join(',');
  const [reajustes] = await dbPool.query(
    `
      SELECT
        r.*,
        COALESCE(mp.mp_custo, 0) AS mp_custo,
        COALESCE(mp.mp_custo, 0) AS unit_cost
      FROM cq_analises_reajustes r
      LEFT JOIN cli_materia_prima mp
        ON TRIM(mp.mp_codigo) = TRIM(r.materia_prima_codigo)
      WHERE r.analise_id IN (${placeholders})
      ORDER BY r.analise_id ASC, r.numero_reajuste ASC, r.id ASC
    `,
    ids
  );

  const porAnalise = new Map();
  for (const r of reajustes) {
    if (!porAnalise.has(r.analise_id)) porAnalise.set(r.analise_id, []);
    porAnalise.get(r.analise_id).push(r);
  }

  return analises.map(a => ({
    ...a,
    qtd_reajustes: Number(a.qtd_reajustes || 0),
    reajustes: porAnalise.get(a.id) || []
  }));
}

function buildCqProdutoPrevisaoPayload(codigo, historico) {
  const total = historico.length;
  const comReajuste = historico.filter(a => Number(a.qtd_reajustes || 0) > 0).length;
  const semReajuste = total - comReajuste;
  const totalReajustes = historico.reduce((sum, a) => sum + Number(a.qtd_reajustes || 0), 0);
  const fpy = total ? (semReajuste / total) * 100 : 0;
  const probReajuste = total ? (comReajuste / total) * 100 : 0;

  const motivos = new Map();
  const materias = new Map();

  for (const a of historico) {
    for (const r of (a.reajustes || [])) {
      const motivo = (r.motivo_reajuste || 'Sem motivo informado').trim();
      const mp = (r.materia_prima_nome || r.materia_prima_codigo || 'Sem matéria-prima informada').trim();
      motivos.set(motivo, (motivos.get(motivo) || 0) + 1);
      materias.set(mp, (materias.get(mp) || 0) + 1);
    }
  }

  const topMotivos = [...motivos.entries()]
    .map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const topMaterias = [...materias.entries()]
    .map(([materia_prima, total]) => ({ materia_prima, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const ultimo = historico[0] || null;

  return {
    codigo,
    produto_codigo: codigo,
    produto_nome: ultimo?.produto_nome || null,
    linha_produto: ultimo?.linha_produto || null,
    total_analises: total,
    total_reajustes: totalReajustes,
    com_reajuste: comReajuste,
    sem_reajuste: semReajuste,
    fpy: Number(fpy.toFixed(2)),
    probabilidade_reajuste: Number(probReajuste.toFixed(2)),
    media_reajustes: total ? Number((totalReajustes / total).toFixed(2)) : 0,
    ultimo_lote: ultimo,
    top_motivos: topMotivos,
    top_materias_primas: topMaterias,
    historico
  };
}

app.get('/api/cq/produtos', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const limit = Math.min(toPositiveInt(req.query.limit, 300), 2000);
    const offset = toPositiveInt(req.query.offset, 0);

    const conditions = [
      `a.produto_codigo IS NOT NULL`,
      `TRIM(a.produto_codigo) <> ''`
    ];
    const params = [];

    if (search) {
      conditions.push(`(a.produto_codigo LIKE ? OR a.produto_nome LIKE ? OR a.linha_produto LIKE ?)`);
      params.push(search, search, search);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const [[{ total }]] = await dbPool.query(
      `
        SELECT COUNT(*) AS total
        FROM (
          SELECT a.produto_codigo
          FROM cq_analises a
          ${where}
          GROUP BY a.produto_codigo
        ) x
      `,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          a.produto_codigo AS id,
          a.produto_codigo AS code,
          SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(TRIM(a.produto_nome), '') ORDER BY COALESCE(a.data_analise, DATE(a.criado_em)) DESC, a.id DESC SEPARATOR '||'), '||', 1) AS name,
          SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(TRIM(a.linha_produto), '') ORDER BY COALESCE(a.data_analise, DATE(a.criado_em)) DESC, a.id DESC SEPARATOR '||'), '||', 1) AS type,
          COUNT(*) AS total_analises,
          MAX(COALESCE(a.data_analise, DATE(a.criado_em))) AS ultima_analise,
          COALESCE(SUM(r.qtd_reajustes), 0) AS total_reajustes,
          SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) > 0 THEN 1 ELSE 0 END) AS lotes_com_reajuste,
          ROUND((SUM(CASE WHEN COALESCE(r.qtd_reajustes, 0) = 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)) * 100, 2) AS fpy,
          1 AS active
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) r ON r.analise_id = a.id
        ${where}
        GROUP BY a.produto_codigo
        ORDER BY ultima_analise DESC, a.produto_codigo ASC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      total: Number(total || 0),
      limit,
      offset,
      data: rows.map(row => ({
        ...row,
        name: row.name || 'Produto sem nome',
        type: row.type || 'Sem linha',
        total_analises: Number(row.total_analises || 0),
        total_reajustes: Number(row.total_reajustes || 0),
        lotes_com_reajuste: Number(row.lotes_com_reajuste || 0),
        fpy: row.fpy === null ? null : Number(row.fpy)
      }))
    });
  } catch (err) {
    console.error('GET /api/cq/produtos erro:', err.message);
    sendError(res, 500, 'Erro ao buscar produtos lançados no CQVision', err.message);
  }
});

app.get('/api/cq/produtos/:codigo/previsao', async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    const limit = Math.min(toPositiveInt(req.query.limit, 100), 500);

    if (!codigo) return sendError(res, 400, 'Informe o código do produto');

    const historico = await getCqProdutoHistorico(codigo, limit);
    const payload = buildCqProdutoPrevisaoPayload(codigo, historico);

    res.json({ ok: true, data: payload });
  } catch (err) {
    console.error('GET /api/cq/produtos/:codigo/previsao erro:', err.message);
    sendError(res, 500, 'Erro ao gerar previsão do produto no CQVision', err.message);
  }
});


// =========================
// CQ VISION - DADOS CONSOLIDADOS PARA DASHBOARD / TV / RELATÓRIOS
// =========================

app.get('/api/cq/dashboard/dados', async (req, res) => {
  try {
    const limit = Math.min(toPositiveInt(req.query.limit, 5000), 10000);
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
      conditions.push('COALESCE(NULLIF(TRIM(a.linha_produto), \'\'), \'Sem linha\') = ?');
      params.push(linha);
    }

    if (dateFrom) {
      conditions.push('DATE(COALESCE(a.data_analise, a.criado_em)) >= ?');
      params.push(dateFrom);
    }

    if (dateTo) {
      conditions.push('DATE(COALESCE(a.data_analise, a.criado_em)) <= ?');
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
          a.id,
          a.op,
          a.pedido,
          a.cliente_codigo,
          a.cliente_nome,
          a.produto_codigo,
          a.produto_nome,
          COALESCE(NULLIF(TRIM(a.linha_produto), ''), 'Sem linha') AS linha_produto,
          a.revisao,
          a.resultado,
          a.usuario,
          a.data_analise,
          a.criado_em,
          a.viscosidade_padrao,
          a.densidade_padrao,
          a.fineza_padrao,
          a.viscosidade_inicial,
          a.viscosidade_final,
          a.viscosidade_encontrada,
          a.densidade_encontrada,
          a.fineza_encontrada,
          a.solidos_a,
          a.solidos_ab,
          a.observacoes,
          COALESCE(rc.qtd_reajustes, 0) AS qtd_reajustes,
          COALESCE(pi.total_quantidade, 0) AS quantidade_total,
          COALESCE(pi.total_peso, 0) AS peso_total
        FROM cq_analises a
        LEFT JOIN (
          SELECT analise_id, COUNT(*) AS qtd_reajustes
          FROM cq_analises_reajustes
          GROUP BY analise_id
        ) rc ON rc.analise_id = a.id
        LEFT JOIN (
          SELECT
            pits_op,
            SUM(COALESCE(pits_qtde, 0)) AS total_quantidade,
            SUM(COALESCE(pits_peso, 0)) AS total_peso
          FROM cli_pedidos_itens
          WHERE pits_op IS NOT NULL AND pits_op <> ''
          GROUP BY pits_op
        ) pi ON TRIM(pi.pits_op) = TRIM(a.op)
        ${where}
        ORDER BY DATE(COALESCE(a.data_analise, a.criado_em)) DESC, a.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    if (!analises.length) {
      return res.json({ ok: true, total: Number(total || 0), limit, offset, data: [] });
    }

    const ids = analises.map(a => a.id);
    const placeholders = ids.map(() => '?').join(',');

    const [reajustes] = await dbPool.query(
      `
        SELECT
          r.*,
          COALESCE(mp.mp_custo, 0) AS mp_custo,
          COALESCE(mp.mp_custo, 0) AS unit_cost
        FROM cq_analises_reajustes r
        LEFT JOIN cli_materia_prima mp
          ON TRIM(mp.mp_codigo) = TRIM(r.materia_prima_codigo)
        WHERE r.analise_id IN (${placeholders})
        ORDER BY r.analise_id ASC, r.numero_reajuste ASC, r.id ASC
      `,
      ids
    );

    const map = new Map();
    for (const r of reajustes) {
      if (!map.has(r.analise_id)) map.set(r.analise_id, []);
      map.get(r.analise_id).push(r);
    }

    for (const a of analises) {
      a.qtd_reajustes = Number(a.qtd_reajustes || 0);
      a.quantidade_total = Number(a.quantidade_total || 0);
      a.peso_total = Number(a.peso_total || 0);
      a.reajustes = map.get(a.id) || [];
    }

    res.json({ ok: true, total: Number(total || 0), limit, offset, data: analises });
  } catch (err) {
    console.error('GET /api/cq/dashboard/dados erro:', err.message);
    sendError(res, 500, 'Erro ao buscar dados consolidados do dashboard CQ', err.message);
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
          COUNT(r.id) AS qtd_reajustes,
          MAX(pinfo.total_quantidade) AS quantidade_total,
          MAX(pinfo.total_peso) AS peso_total
        FROM cq_analises a
        LEFT JOIN cq_analises_reajustes r
          ON r.analise_id = a.id
        LEFT JOIN (
          SELECT
            pits_op,
            SUM(COALESCE(pits_qtde, 0)) AS total_quantidade,
            SUM(COALESCE(pits_peso, 0)) AS total_peso
          FROM cli_pedidos_itens
          WHERE pits_op IS NOT NULL AND pits_op <> ''
          GROUP BY pits_op
        ) pinfo ON TRIM(pinfo.pits_op) = TRIM(a.op)
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
        SELECT
          r.*,
          COALESCE(mp.mp_custo, 0) AS mp_custo,
          COALESCE(mp.mp_custo, 0) AS unit_cost
        FROM cq_analises_reajustes r
        LEFT JOIN cli_materia_prima mp
          ON TRIM(mp.mp_codigo) = TRIM(r.materia_prima_codigo)
        WHERE r.analise_id IN (${placeholders})
        ORDER BY r.analise_id ASC, r.numero_reajuste ASC, r.id ASC
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
        SELECT
          a.*,
          pinfo.total_quantidade AS quantidade_total,
          pinfo.total_peso AS peso_total
        FROM cq_analises a
        LEFT JOIN (
          SELECT
            pits_op,
            SUM(COALESCE(pits_qtde, 0)) AS total_quantidade,
            SUM(COALESCE(pits_peso, 0)) AS total_peso
          FROM cli_pedidos_itens
          WHERE pits_op IS NOT NULL AND pits_op <> ''
          GROUP BY pits_op
        ) pinfo ON TRIM(pinfo.pits_op) = TRIM(a.op)
        WHERE a.op = ?
        ORDER BY a.criado_em DESC, a.id DESC
      `,
      [op]
    );

    for (const analise of analises) {
      const [reajustes] = await dbPool.query(
        `
          SELECT
            r.*,
            COALESCE(mp.mp_custo, 0) AS mp_custo,
            COALESCE(mp.mp_custo, 0) AS unit_cost
          FROM cq_analises_reajustes r
          LEFT JOIN cli_materia_prima mp
            ON TRIM(mp.mp_codigo) = TRIM(r.materia_prima_codigo)
          WHERE r.analise_id = ?
          ORDER BY r.numero_reajuste ASC, r.id ASC
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
// FACTORYFLOW APP - TABELAS GENÉRICAS PARA DRIVER.HTML
// =========================
// Estas rotas resolvem chamadas do frontend antigo/mobile:
// GET  /api/tables/ff_routes
// PUT  /api/tables/ff_routes/:id
// GET  /api/tables/ff_lots
// PUT  /api/tables/ff_lots/:id
// Também suportam ff_orders e ff_users caso alguma tela antiga use.

const FF_TABLES = {
  ff_routes: {
    createSql: `
      CREATE TABLE IF NOT EXISTS ff_routes (
        id VARCHAR(100) PRIMARY KEY,
        driverId VARCHAR(100) NULL,
        driverName VARCHAR(150) NULL,
        lots LONGTEXT NULL,
        status VARCHAR(50) DEFAULT 'active',
        createdAt BIGINT NULL,
        departureTime BIGINT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `,
    columns: ['id','driverId','driverName','lots','status','createdAt','departureTime']
  },
  ff_lots: {
    createSql: `
      CREATE TABLE IF NOT EXISTS ff_lots (
        id VARCHAR(100) PRIMARY KEY,
        number VARCHAR(100) NULL,
        orderId VARCHAR(100) NULL,
        orderNumber VARCHAR(100) NULL,
        client VARCHAR(255) NULL,
        productCode VARCHAR(100) NULL,
        paint VARCHAR(255) NULL,
        productType VARCHAR(100) NULL,
        endurecedorRoute VARCHAR(100) NULL,
        destinoEndurecedor VARCHAR(100) NULL,
        qty DECIMAL(14,4) DEFAULT 0,
        unit VARCHAR(30) DEFAULT 'Kg',
        priority VARCHAR(50) DEFAULT 'normal',
        deliveryDate VARCHAR(50) NULL,
        skipColor VARCHAR(20) NULL,
        city VARCHAR(150) NULL,
        address VARCHAR(255) NULL,
        notes LONGTEXT NULL,
        sector VARCHAR(100) NULL,
        lotStatus VARCHAR(50) NULL,
        workSessions LONGTEXT NULL,
        expedientePausedStatus VARCHAR(50) NULL,
        sectorEnteredAt BIGINT NULL,
        createdAt BIGINT NULL,
        createdBy VARCHAR(100) NULL,
        rejected VARCHAR(20) NULL,
        rejectedAt BIGINT NULL,
        rejectedReason LONGTEXT NULL,
        rejectedBy VARCHAR(100) NULL,
        rejectedSector VARCHAR(100) NULL,
        history LONGTEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `,
    columns: [
      'id','number','orderId','orderNumber','client','productCode','paint','productType',
      'endurecedorRoute','destinoEndurecedor','qty','unit','priority','deliveryDate','skipColor',
      'city','address','notes','sector','lotStatus','workSessions','expedientePausedStatus','sectorEnteredAt','createdAt',
      'createdBy','rejected','rejectedAt','rejectedReason','rejectedBy','rejectedSector','history'
    ]
  },
  ff_orders: {
    createSql: `
      CREATE TABLE IF NOT EXISTS ff_orders (
        id VARCHAR(100) PRIMARY KEY,
        number VARCHAR(100) NULL,
        client VARCHAR(255) NULL,
        city VARCHAR(150) NULL,
        address VARCHAR(255) NULL,
        deliveryDate VARCHAR(50) NULL,
        priority VARCHAR(50) DEFAULT 'normal',
        notes LONGTEXT NULL,
        status VARCHAR(50) NULL,
        createdAt BIGINT NULL,
        createdBy VARCHAR(100) NULL,
        lotIds LONGTEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `,
    columns: ['id','number','client','city','address','deliveryDate','priority','notes','status','createdAt','createdBy','lotIds']
  },
  ff_users: {
    createSql: `
      CREATE TABLE IF NOT EXISTS ff_users (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(150) NULL,
        login VARCHAR(100) NULL,
        password VARCHAR(255) NULL,
        role VARCHAR(50) NULL,
        active VARCHAR(20) DEFAULT 'true',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `,
    columns: ['id','name','login','password','role','active']
  }
};

function isSafeColumnName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''));
}

function normalizeTablePayload(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

async function ensureFfTable(tableName) {
  const cfg = FF_TABLES[tableName];
  if (!cfg) return false;
  await dbPool.query(cfg.createSql);
  return true;
}

async function getExistingColumns(tableName) {
  const [cols] = await dbPool.query(`SHOW COLUMNS FROM \`${tableName}\``);
  return new Set(cols.map(c => c.Field));
}

async function ensureColumnsForPayload(tableName, payload) {
  const cfg = FF_TABLES[tableName];
  if (!cfg) return;

  const existing = await getExistingColumns(tableName);
  const allowed = new Set(cfg.columns);

  for (const key of Object.keys(payload || {})) {
    if (!isSafeColumnName(key)) continue;
    if (existing.has(key)) continue;
    if (!allowed.has(key)) continue;

    await dbPool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${key}\` LONGTEXT NULL`);
    existing.add(key);
    console.log(`✅ Coluna ${tableName}.${key} criada automaticamente.`);
  }
}

function pickAllowedPayload(tableName, payload) {
  const cfg = FF_TABLES[tableName];
  const allowed = new Set(cfg.columns);
  const out = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (!allowed.has(key)) continue;
    if (!isSafeColumnName(key)) continue;
    out[key] = normalizeTablePayload(value);
  }

  return out;
}

function normalizeGenericRow(row) {
  if (!row) return row;
  const out = { ...row };

  for (const key of ['lots','history','workSessions','lotIds']) {
    if (typeof out[key] === 'string' && out[key].trim()) {
      try { out[key] = JSON.parse(out[key]); } catch (_) {}
    }
  }

  return out;
}

async function listGenericTable(req, res) {
  try {
    const tableName = req.params.table;
    if (!FF_TABLES[tableName]) return sendError(res, 404, `Tabela não liberada: ${tableName}`);

    await ensureFfTable(tableName);

    const limit = Math.min(toPositiveInt(req.query.limit, 500), 2000);
    const offset = toPositiveInt(req.query.offset, 0);

    const existing = await getExistingColumns(tableName);
    const orderCol = existing.has('createdAt') ? 'createdAt' : 'id';

    const [[{ total }]] = await dbPool.query(`SELECT COUNT(*) AS total FROM \`${tableName}\``);
    const [rows] = await dbPool.query(
      `SELECT * FROM \`${tableName}\` ORDER BY \`${orderCol}\` DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.json({
      ok: true,
      total: Number(total || 0),
      limit,
      offset,
      data: rows.map(normalizeGenericRow)
    });
  } catch (err) {
    console.error(`GET /tables/${req.params.table} erro:`, err.message);
    sendError(res, 500, 'Erro ao listar tabela FactoryFlow', err.message);
  }
}

async function getGenericTableRow(req, res) {
  try {
    const tableName = req.params.table;
    const id = req.params.id;
    if (!FF_TABLES[tableName]) return sendError(res, 404, `Tabela não liberada: ${tableName}`);

    await ensureFfTable(tableName);

    const [rows] = await dbPool.query(
      `SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`,
      [id]
    );

    if (!rows.length) return sendError(res, 404, 'Registro não encontrado');
    res.json({ ok: true, data: normalizeGenericRow(rows[0]) });
  } catch (err) {
    console.error(`GET /tables/${req.params.table}/${req.params.id} erro:`, err.message);
    sendError(res, 500, 'Erro ao buscar registro FactoryFlow', err.message);
  }
}

async function createGenericTableRow(req, res) {
  try {
    const tableName = req.params.table;
    if (!FF_TABLES[tableName]) return sendError(res, 404, `Tabela não liberada: ${tableName}`);

    await ensureFfTable(tableName);

    const payload = pickAllowedPayload(tableName, req.body || {});
    if (!payload.id) payload.id = `${tableName}_${Date.now()}`;

    await ensureColumnsForPayload(tableName, payload);

    const columns = Object.keys(payload);
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => payload[c]);

    await dbPool.query(
      `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
      values
    );

    const [rows] = await dbPool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [payload.id]);
    res.json({ ok: true, data: normalizeGenericRow(rows[0] || payload) });
  } catch (err) {
    console.error(`POST /tables/${req.params.table} erro:`, err.message);
    sendError(res, 500, 'Erro ao criar registro FactoryFlow', err.message);
  }
}

async function updateGenericTableRow(req, res) {
  try {
    const tableName = req.params.table;
    const id = req.params.id;
    if (!FF_TABLES[tableName]) return sendError(res, 404, `Tabela não liberada: ${tableName}`);

    await ensureFfTable(tableName);

    const payload = pickAllowedPayload(tableName, req.body || {});
    delete payload.id;

    await ensureColumnsForPayload(tableName, payload);

    const columns = Object.keys(payload);
    if (!columns.length) return sendError(res, 400, 'Nenhum campo válido para atualizar');

    const sets = columns.map(c => `\`${c}\` = ?`).join(', ');
    const values = columns.map(c => payload[c]);
    values.push(id);

    const [result] = await dbPool.query(
      `UPDATE \`${tableName}\` SET ${sets} WHERE id = ?`,
      values
    );

    if (!result.affectedRows) {
      const insertPayload = { id, ...payload };
      const insertColumns = Object.keys(insertPayload);
      const placeholders = insertColumns.map(() => '?').join(', ');
      await dbPool.query(
        `INSERT INTO \`${tableName}\` (${insertColumns.map(c => `\`${c}\``).join(', ')}) VALUES (${placeholders})`,
        insertColumns.map(c => insertPayload[c])
      );
    }

    const [rows] = await dbPool.query(`SELECT * FROM \`${tableName}\` WHERE id = ? LIMIT 1`, [id]);
    res.json({ ok: true, data: normalizeGenericRow(rows[0]) });
  } catch (err) {
    console.error(`PUT/PATCH /tables/${req.params.table}/${req.params.id} erro:`, err.message);
    sendError(res, 500, 'Erro ao atualizar registro FactoryFlow', err.message);
  }
}

async function deleteGenericTableRow(req, res) {
  try {
    const tableName = req.params.table;
    const id = req.params.id;
    if (!FF_TABLES[tableName]) return sendError(res, 404, `Tabela não liberada: ${tableName}`);

    await ensureFfTable(tableName);

    const [result] = await dbPool.query(`DELETE FROM \`${tableName}\` WHERE id = ?`, [id]);
    res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (err) {
    console.error(`DELETE /tables/${req.params.table}/${req.params.id} erro:`, err.message);
    sendError(res, 500, 'Erro ao excluir registro FactoryFlow', err.message);
  }
}

app.get('/tables/:table', listGenericTable);
app.get('/tables/:table/:id', getGenericTableRow);
app.post('/tables/:table', createGenericTableRow);
app.put('/tables/:table/:id', updateGenericTableRow);
app.patch('/tables/:table/:id', updateGenericTableRow);
app.delete('/tables/:table/:id', deleteGenericTableRow);

// Alias com /api/tables caso algum frontend esteja configurado assim.
app.get('/api/tables/:table', listGenericTable);
app.get('/api/tables/:table/:id', getGenericTableRow);
app.post('/api/tables/:table', createGenericTableRow);
app.put('/api/tables/:table/:id', updateGenericTableRow);
app.patch('/api/tables/:table/:id', updateGenericTableRow);
app.delete('/api/tables/:table/:id', deleteGenericTableRow);

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
    console.log('║   FactoryFlow + CQVision – MySQL Bridge v2.4.0 EXPEDIENTE    ║');
    console.log('╚════════════════════════════════════════════════════╝\n');

    await testConnection();
    await ensureProductionLotesManualColumns();
    await ensureSectorShiftTable();
    await ensureProductionLotesTimeColumns();

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
      console.log('   POST /api/producao/manual');
      console.log('   POST /api/lotes');
      console.log('   GET  /api/lote/:op');
      console.log('   PATCH /api/producao/:id');
      console.log('   GET  /api/cq/lotes/:op');
      console.log('   GET  /api/cq/lote-resumo/:op');
      console.log('   POST /api/cq/analises');
      console.log('   GET  /api/cq/analises');
      console.log('   GET  /api/cq/analises/:op');
      console.log('   GET  /api/cq/dashboard/dados');
      console.log('   GET  /api/cq/dashboard/resumo');
      console.log('   GET  /api/cq/dashboard/linhas');
      console.log('   GET  /api/cq/dashboard/reajustes');
      console.log('   GET  /api/cq/dashboard/materias-primas');
      console.log('   GET  /api/cq/dashboard/historico');
      console.log('   GET  /api/cq/dashboard/produtos-criticos');
      console.log('   GET  /api/cq/produtos');
      console.log('   GET  /api/cq/produtos/:codigo/previsao');
      console.log('   GET  /api/cq/previsoes/ops');
      console.log('   GET  /api/cq/previsoes/produto/:codigo');
      console.log('   GET  /api/cq/previsoes/op/:op');
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