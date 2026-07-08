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
  'http://127.0.0.1:5500',
  'https://factoryflow-pagina.pages.dev'
];

const envAllowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // permite Postman/testes/curl

    let hostname = '';
    try { hostname = new URL(origin).hostname; } catch (_) { hostname = ''; }

    const isGenspark = hostname === 'gensparkspace.com' || hostname.endsWith('.gensparkspace.com');
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';

    if (allowedOrigins.includes(origin) || isGenspark || isLocalhost) {
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

function firstPositiveNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function resolveQuantidadeKg(...values) {
  return firstPositiveNumber(...values);
}


function normalizeProductionTipo(value, productName = '', productCode = '') {
  const raw = String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const name = String(productName || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const code = String(productCode || '').toLowerCase().trim();

  if (raw === 'base' || raw.includes('base') || name.includes('base')) return 'base';
  if (raw === 'amostra' || raw.includes('amostra') || name.includes('amostra')) return 'amostra';
  if (raw === 'diluente' || raw.includes('diluente') || raw.includes('solvente') || name.includes('diluente') || name.includes('solvente')) return 'diluente';
  if (raw === 'endurecedor' || raw.includes('endurecedor') || name.includes('endurecedor') || code.startsWith('035')) return 'endurecedor';

  return 'tinta';
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


async function ensureSectorShiftEventsTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS ff_sector_shift_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setor VARCHAR(80) NOT NULL,
      event_type VARCHAR(20) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(120) NULL,
      INDEX idx_ff_sector_shift_events_setor_created (setor, created_at),
      INDEX idx_ff_sector_shift_events_type_created (event_type, created_at)
    )
  `);
}

async function ensurePedidoDatasTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS ff_pedidos_datas (
      pedido VARCHAR(30) PRIMARY KEY,
      data_entrega DATE NOT NULL,
      atualizado_por VARCHAR(100) NULL,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
    },
    {
      name: 'ff_sectorMetrics',
      sql: `ALTER TABLE producao_lotes ADD COLUMN ff_sectorMetrics LONGTEXT NULL`
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



// =========================
// RELATÓRIO DE TEMPOS - HELPERS
// =========================

function rtSafeParseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function rtArray(value) {
  const parsed = rtSafeParseJson(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed).filter(Boolean);
  return [];
}

function rtNormalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_');
}

function rtDisplaySector(value) {
  const s = String(value || '').trim();
  if (!s) return 'sem_setor';
  const map = {
    pcp: 'PCP',
    pcp_liberacao: 'PCP (Liberação)',
    pesagem: 'Pesagem',
    producao: 'Produção',
    moagem: 'Moagem',
    laboratorio: 'Laboratório',
    laboratorio_revisao: 'Laboratório (Revisão)',
    laboratorio_amostras: 'Laboratório (Amostras)',
    coloracao: 'Coloração',
    coloracao_revisao: 'Coloração (Revisão)',
    coloracao_amostras: 'Coloração (Amostras)',
    envase: 'Envase',
    envase_produzir: 'Envase - Produzir',
    envase_enlatamento: 'Envase - Enlatamento',
    pronto: 'Pronto para Entrega',
    pronto_para_entrega: 'Pronto para Entrega',
    entregue: 'Entregue'
  };
  return map[rtNormalizeText(s)] || s;
}

function rtToMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10000000000 ? Math.round(value * 1000) : Math.round(value);
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n < 10000000000 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

function rtDurationMs(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function rtPickFirstMs(...values) {
  for (const value of values) {
    const ms = rtToMs(value);
    if (ms) return ms;
  }
  return null;
}


function rtGetSessionSector(session, fallbackSector = '') {
  return String(
    session?.sector ||
    session?.setor ||
    session?.sectorKey ||
    session?.setorAtual ||
    session?.setor_atual ||
    session?.currentSector ||
    session?.current_sector ||
    fallbackSector ||
    ''
  ).trim();
}

function rtGetSessionType(session) {
  // Compatibilidade com vários formatos usados pelo front:
  // pauseReason/motivoPausa, type/status/action e também sessões com pausedMs.
  if (session?.pauseReason && String(session.pauseReason).trim()) return 'pause';
  if (session?.motivoPausa && String(session.motivoPausa).trim()) return 'pause';
  if (rtDurationMs(session?.pausedMs ?? session?.paused_ms ?? session?.tempoPausadoMs ?? session?.tempo_pausado_ms) > 0) return 'mixed';

  const raw = rtNormalizeText(
    session?.type ||
    session?.tipo ||
    session?.status ||
    session?.action ||
    session?.acao ||
    session?.mode ||
    session?.event ||
    session?.evento ||
    ''
  );

  if (raw.includes('pause') || raw.includes('pausa') || raw.includes('paused') || raw.includes('pausado')) return 'pause';
  if (raw.includes('work') || raw.includes('trabalho') || raw.includes('trabalhando') || raw.includes('resume') || raw.includes('retom')) return 'work';
  return 'work';
}

function rtGetSessionRange(session) {
  const start = rtPickFirstMs(
    session?.startedAt,
    session?.startAt,
    session?.start,
    session?.inicio,
    session?.iniciadoEm,
    session?.iniciado_em,
    session?.createdAt,
    session?.created_at,
    session?.timestamp,
    session?.time,
    session?.data,
    session?.pauseStart,
    session?.pausaInicio,
    session?.pausedAt,
    session?.paused_at
  );

  const end = rtPickFirstMs(
    session?.endedAt,
    session?.endAt,
    session?.end,
    session?.fim,
    session?.finalizadoEm,
    session?.finalizado_em,
    session?.stoppedAt,
    session?.updatedAt,
    session?.updated_at,
    session?.pauseEnd,
    session?.pausaFim,
    session?.resumedAt,
    session?.resumed_at,
    session?.retomadoEm,
    session?.retomado_em
  );

  const duration = rtDurationMs(
    session?.durationMs ??
    session?.duration_ms ??
    session?.elapsedMs ??
    session?.elapsed_ms ??
    session?.tempoMs ??
    session?.tempo_ms ??
    session?.totalMs ??
    session?.total_ms
  );

  const workedDuration = rtDurationMs(
    session?.workedMs ??
    session?.worked_ms ??
    session?.tempoTrabalhadoMs ??
    session?.tempo_trabalhado_ms
  );

  const pausedDuration = rtDurationMs(
    session?.pausedMs ??
    session?.paused_ms ??
    session?.tempoPausadoMs ??
    session?.tempo_pausado_ms
  );

  return { start, end, duration, workedDuration, pausedDuration };
}

function rtOverlapMs(start, end, limitStart, limitEnd) {
  const safeStart = Math.max(Number(start || 0), Number(limitStart || start || 0));
  const safeEnd = Math.min(Number(end || Date.now()), Number(limitEnd || end || Date.now()));
  return Math.max(0, safeEnd - safeStart);
}

function rtSessionMatchesSector(session, targetSector, fallbackSector = '') {
  const target = rtNormalizeText(targetSector);
  if (!target) return true;

  const sessionSector = rtNormalizeText(rtGetSessionSector(session, fallbackSector));
  if (!sessionSector) return true;
  if (sessionSector === target) return true;

  // Compatibilidade entre setores agrupados/sinônimos.
  const groups = [
    ['laboratorio', 'laboratorio_revisao', 'laboratorio_amostras', 'lab'],
    ['coloracao', 'coloracao_revisao', 'coloracao_amostras'],
    ['envase', 'envase_produzir', 'envase_enlatamento']
  ];

  return groups.some(group => group.includes(target) && group.includes(sessionSector));
}

function rtMergeIntervals(intervals) {
  const clean = (intervals || [])
    .map(i => ({ start: Number(i.start || 0), end: Number(i.end || 0) }))
    .filter(i => i.start > 0 && i.end > i.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const item of clean) {
    const last = merged[merged.length - 1];
    if (!last || item.start > last.end) merged.push({ ...item });
    else last.end = Math.max(last.end, item.end);
  }
  return merged;
}

function rtIntervalsTotalMs(intervals) {
  return rtMergeIntervals(intervals).reduce((sum, i) => sum + Math.max(0, i.end - i.start), 0);
}

function rtSubtractIntervals(baseIntervals, subtractIntervals) {
  let result = rtMergeIntervals(baseIntervals);
  const subtracts = rtMergeIntervals(subtractIntervals);

  for (const sub of subtracts) {
    const next = [];
    for (const base of result) {
      if (sub.end <= base.start || sub.start >= base.end) {
        next.push(base);
        continue;
      }
      if (sub.start > base.start) next.push({ start: base.start, end: Math.min(sub.start, base.end) });
      if (sub.end < base.end) next.push({ start: Math.max(sub.end, base.start), end: base.end });
    }
    result = next;
  }

  return rtMergeIntervals(result);
}


// ─────────────────────────────────────────────────────────────
// EXPEDIENTE ÚTIL - DESCONTA PERÍODOS FECHADOS
// Regra FactoryFlow:
// Entrou no setor => começa a contar.
// Fechou expediente => congela.
// Abriu expediente => continua do ponto congelado.
// Saiu do setor => finaliza.
//
// O cálculo usa SOMENTE eventos reais de abre/fecha expediente.
// Não existe mais expediente fixo 07:10–17:25 aqui, porque se houver
// hora extra com expediente aberto o tempo precisa continuar contando.
// ─────────────────────────────────────────────────────────────
const RT_WORKDAY_START_MINUTES = 7 * 60 + 10;   // 07:10
const RT_WORKDAY_END_MINUTES = 17 * 60 + 25;    // 17:25
const RT_SAO_PAULO_OFFSET_MINUTES = -180;       // UTC-03:00

function rtSaoPauloParts(ms) {
  const d = new Date(Number(ms || 0) + RT_SAO_PAULO_OFFSET_MINUTES * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    dayOfWeek: d.getUTCDay()
  };
}

function rtSaoPauloLocalToMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second, 0) - RT_SAO_PAULO_OFFSET_MINUTES * 60000;
}

// Datas DATETIME do MySQL do expediente são gravadas como horário local do Brasil.
// Ex.: "2026-06-25 07:07:26" significa 07:07 em Rio Claro/SP, não 07:07 UTC.
// O mysql2/JSON pode transformar isso em Date/ISO com "Z", criando deslocamento de 3h.
// Para eventos de expediente, convertemos os componentes da data como America/Sao_Paulo.
function rtShiftDateTimeToMs(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10000000000 ? Math.round(value * 1000) : Math.round(value);
  }

  if (value instanceof Date) {
    // O mysql2 (config padrão timezone:'local') constrói este Date chamando o construtor
    // local do JS com os números literais do DATETIME (que são horário do Brasil, sem fuso
    // gravado). value.getTime() só dá o instante certo se o timezone do processo Node for
    // America/Sao_Paulo (verdade no Windows local, falso no Railway, que roda em UTC) —
    // por isso local e produção calculavam closedIntervals diferentes para a mesma OP 088088.
    // Os getters LOCAIS (getFullYear/getHours, sem "UTC") são simétricos ao construtor local
    // usado pelo mysql2: devolvem de volta os mesmos números literais do banco independente
    // de qual seja o fuso do processo. Por isso extraímos os literais assim e convertemos
    // nós mesmos como America/Sao_Paulo, em vez de confiar em value.getTime().
    return rtSaoPauloLocalToMs(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds()
    );
  }

  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n < 10000000000 ? Math.round(n * 1000) : Math.round(n);
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return rtSaoPauloLocalToMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s || 0));
  }

  return rtToMs(value);
}

// Corrige iniciado_em/finalizado_em/atualizado_em de uma linha de ff_sector_shifts antes de
// devolver ao frontend: troca o Date "mal rotulado" do mysql2 (ver rtShiftDateTimeToMs acima)
// por uma string ISO com o instante UTC correto, para o card de expediente não exibir hora
// 3h adiantada/atrasada (mesmo bug que já tinha sido corrigido no cálculo do relatório de tempos).
function ffFixShiftRowDates(row) {
  if (!row) return row;
  const fixed = { ...row };
  ['iniciado_em', 'finalizado_em', 'atualizado_em'].forEach((field) => {
    if (fixed[field] != null) {
      const ms = rtShiftDateTimeToMs(fixed[field]);
      fixed[field] = Number.isFinite(ms) ? new Date(ms).toISOString() : fixed[field];
    }
  });
  return fixed;
}

function rtAddDaysSaoPauloYmd(year, month, day, addDays) {
  const base = Date.UTC(year, month - 1, day + addDays, 12, 0, 0, 0);
  const d = new Date(base);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function rtGetStandardClosedIntervals(startMs, endMs) {
  const start = Number(startMs || 0);
  const end = Number(endMs || Date.now());
  if (!start || !end || end <= start) return [];

  const intervals = [];
  const startParts = rtSaoPauloParts(start);
  const endParts = rtSaoPauloParts(end);

  let cursorYmd = { year: startParts.year, month: startParts.month, day: startParts.day };
  const endDayStart = rtSaoPauloLocalToMs(endParts.year, endParts.month, endParts.day, 0, 0, 0);

  for (let guard = 0; guard < 370; guard++) {
    const dayStart = rtSaoPauloLocalToMs(cursorYmd.year, cursorYmd.month, cursorYmd.day, 0, 0, 0);
    if (dayStart > end) break;

    const workStart = rtSaoPauloLocalToMs(
      cursorYmd.year,
      cursorYmd.month,
      cursorYmd.day,
      Math.floor(RT_WORKDAY_START_MINUTES / 60),
      RT_WORKDAY_START_MINUTES % 60,
      0
    );
    const workEnd = rtSaoPauloLocalToMs(
      cursorYmd.year,
      cursorYmd.month,
      cursorYmd.day,
      Math.floor(RT_WORKDAY_END_MINUTES / 60),
      RT_WORKDAY_END_MINUTES % 60,
      0
    );
    const nextDay = rtAddDaysSaoPauloYmd(cursorYmd.year, cursorYmd.month, cursorYmd.day, 1);
    const nextDayStart = rtSaoPauloLocalToMs(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0);

    // Fora do expediente padrão do dia.
    intervals.push({ start: dayStart, end: workStart });
    intervals.push({ start: workEnd, end: nextDayStart });

    if (dayStart >= endDayStart && nextDayStart > end) break;
    cursorYmd = nextDay;
  }

  return rtMergeIntervals(intervals)
    .map(i => ({ start: Math.max(i.start, start), end: Math.min(i.end, end) }))
    .filter(i => i.start > 0 && i.end > i.start);
}


function rtGetShiftKeyForSector(sector) {
  return normalizeShiftSetor(rtNormalizeText(sector || '')) || rtNormalizeText(sector || '');
}

function rtGetGlobalShiftKeys() {
  return ['geral', 'expediente_geral', 'todos', 'all', 'global', 'todos_setores'];
}

function rtIsGlobalShiftKey(key) {
  return rtGetGlobalShiftKeys().includes(rtNormalizeText(key));
}

function rtGetShiftBuckets(shiftMap, sector) {
  const key = rtGetShiftKeyForSector(sector);
  const keys = [key, ...rtGetGlobalShiftKeys()].filter(Boolean);
  const closed = [];
  const open = [];

  for (const k of keys) {
    if (Array.isArray(shiftMap?.[k])) closed.push(...shiftMap[k]);
    if (Array.isArray(shiftMap?.__open?.[k])) open.push(...shiftMap.__open[k]);
  }

  return {
    key,
    closed: rtMergeIntervals(closed),
    open: rtMergeIntervals(open)
  };
}

function rtClipIntervals(intervals, startMs, endMs) {
  const start = Number(startMs || 0);
  const end = Number(endMs || Date.now());
  if (!start || !end || end <= start) return [];

  return rtMergeIntervals(intervals || [])
    .map(i => ({ start: Math.max(Number(i.start || 0), start), end: Math.min(Number(i.end || 0), end) }))
    .filter(i => i.start > 0 && i.end > i.start);
}

function rtIntersectIntervals(aIntervals, bIntervals) {
  const a = rtMergeIntervals(aIntervals || []);
  const b = rtMergeIntervals(bIntervals || []);
  const out = [];

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });

    if (a[i].end < b[j].end) i++;
    else j++;
  }

  return rtMergeIntervals(out);
}

function rtGetClosedIntervalsForSector(shiftClosedMap, sector, startMs, endMs) {
  const buckets = rtGetShiftBuckets(shiftClosedMap, sector);
  return rtClipIntervals(buckets.closed, startMs, endMs);
}

function rtGetOpenIntervalsForSector(shiftClosedMap, sector, startMs, endMs) {
  const buckets = rtGetShiftBuckets(shiftClosedMap, sector);
  return rtClipIntervals(buckets.open, startMs, endMs);
}

function rtBusinessIntervals(startMs, endMs, sector, shiftClosedMap = {}) {
  const start = Number(startMs || 0);
  const end = Number(endMs || Date.now());
  if (!start || !end || end <= start) return [];

  let base = [{ start, end }];
  const buckets = rtGetShiftBuckets(shiftClosedMap, sector);
  const sectorKey = buckets.key;

  // Regra correta FactoryFlow:
  // tempo conta somente enquanto o expediente está ABERTO.
  //
  // Correção importante:
  // Quando existe evento antigo de "fechado" sem o par de "aberto" no histórico,
  // o intervalo fechado pode ficar como fechado -> agora e apagar até o expediente atual.
  // Porém a tabela ff_sector_shifts é o estado vivo do sistema.
  // Se ela diz que o setor está aberto desde iniciado_em, esse intervalo aberto atual
  // precisa vencer o fechamento antigo.
  const state = shiftClosedMap?.__state?.[sectorKey] || {};
  const currentOpenStart = Number(state?.isOpen && state?.openedAt ? state.openedAt : 0);
  const currentOpenIntervals = currentOpenStart && end > currentOpenStart
    ? rtClipIntervals([{ start: currentOpenStart, end }], start, end)
    : [];

  const globalOpen = [];
  for (const gk of rtGetGlobalShiftKeys()) {
    if (Array.isArray(shiftClosedMap?.__open?.[gk])) globalOpen.push(...shiftClosedMap.__open[gk]);
  }

  const sectorOpen = Array.isArray(shiftClosedMap?.__open?.[sectorKey])
    ? [...shiftClosedMap.__open[sectorKey]]
    : [];

  // Garante que o expediente aberto atual entre no cálculo, mesmo que o evento
  // histórico de abertura não exista ou tenha sido gravado duplicado/incompleto.
  if (currentOpenIntervals.length) {
    sectorOpen.push(...currentOpenIntervals);
  }

  const clippedGlobalOpen = rtClipIntervals(globalOpen, start, end);
  const clippedSectorOpen = rtClipIntervals(sectorOpen, start, end);

  if (clippedGlobalOpen.length) {
    base = rtIntersectIntervals(base, clippedGlobalOpen);
  }

  if (clippedSectorOpen.length) {
    base = rtIntersectIntervals(base, clippedSectorOpen);
  }

  let closed = rtGetClosedIntervalsForSector(shiftClosedMap, sector, start, end);

  // Se o setor está aberto agora, não deixa um fechamento antigo cobrir o período
  // após a abertura atual.
  if (currentOpenIntervals.length) {
    closed = rtSubtractIntervals(closed, currentOpenIntervals);
  }

  // Mesmo com intervalos abertos, descontamos fechamentos explícitos como proteção contra
  // eventos duplicados/incompletos.
  return rtSubtractIntervals(base, closed);
}

function rtBusinessDurationMs(startMs, endMs, sector, shiftClosedMap = {}) {
  return rtIntervalsTotalMs(rtBusinessIntervals(startMs, endMs, sector, shiftClosedMap));
}

// Pareia cada evento "close" com a próxima "open" do mesmo setor normalizado,
// gerando o intervalo fechado real [close, nextOpen). Sem próxima abertura,
// o fechamento vai até "now" (turno ainda fechado no momento do cálculo).
// Defensivo: closes consecutivos sem open entre eles colapsam no close mais
// recente (o anterior é descartado); opens consecutivos sem close entre eles
// mantêm apenas o primeiro (os seguintes são ignorados) — sortedEvents deve
// vir ordenado por timestamp ascendente.
function rtPairSectorCloseToNextOpen(sortedEvents, now) {
  const closedIntervals = [];
  let closedStart = null;
  for (const ev of sortedEvents || []) {
    if (ev.type === 'close') {
      closedStart = ev.at;
    } else if (ev.type === 'open' && closedStart) {
      if (ev.at > closedStart) closedIntervals.push({ start: closedStart, end: ev.at });
      closedStart = null;
    }
  }
  if (closedStart) closedIntervals.push({ start: closedStart, end: now });
  return closedIntervals;
}

async function rtLoadShiftClosedIntervals() {
  const map = {};
  map.__open = {};
  map.__state = {};

  const ensureBucket = (key) => {
    if (!key) return;
    if (!map[key]) map[key] = [];
    if (!map.__open[key]) map.__open[key] = [];
    if (!map.__state[key]) {
      map.__state[key] = {
        hasEvents: false,
        lastEventAt: null,
        lastEventType: null,
        isOpen: null,
        openedAt: null,
        closedAt: null
      };
    }
  };

  const addClosed = (key, start, end) => {
    if (!key || !start || !end || end <= start) return;
    ensureBucket(key);
    map[key].push({ start, end });
  };

  const addOpen = (key, start, end) => {
    if (!key || !start || !end || end <= start) return;
    ensureBucket(key);
    map.__open[key].push({ start, end });
  };

  try {
    await ensureSectorShiftTable();
    await ensureSectorShiftEventsTable();

    const [events] = await dbPool.query(`
      SELECT id, setor, event_type, created_at
      FROM ff_sector_shift_events
      ORDER BY setor ASC, created_at ASC, id ASC
    `);

    const bySetor = new Map();
    for (const ev of events || []) {
      const key = rtGetShiftKeyForSector(ev.setor);
      const typeRaw = rtNormalizeText(ev.event_type);
      const at = rtShiftDateTimeToMs(ev.created_at);
      if (!key || !at) continue;
      ensureBucket(key);

      const isClose = typeRaw.includes('fech') || typeRaw === 'closed' || typeRaw === 'close' || typeRaw === 'encerrado' || typeRaw === 'encerrar';
      const isOpen = typeRaw.includes('aber') || typeRaw === 'open' || typeRaw === 'opened' || typeRaw === 'iniciado' || typeRaw === 'iniciar';
      if (!isClose && !isOpen) continue;

      if (!bySetor.has(key)) bySetor.set(key, []);
      bySetor.get(key).push({ at, type: isOpen ? 'open' : 'close' });

      map.__state[key].hasEvents = true;
      map.__state[key].lastEventAt = at;
      map.__state[key].lastEventType = isOpen ? 'open' : 'close';
    }

    const now = Date.now();

    for (const [key, list] of bySetor.entries()) {
      const sorted = list.sort((a, b) => a.at - b.at);
      let openStart = null;

      for (const ev of sorted) {
        if (ev.type === 'open') {
          if (!openStart) openStart = ev.at;
          continue;
        }

        if (ev.type === 'close') {
          // Se o primeiro evento conhecido é fechamento, assumimos que antes disso estava aberto.
          // Isso preserva histórico antigo e evita zerar períodos antes do primeiro fechamento registrado.
          if (!openStart) {
            addOpen(key, 1, ev.at);
          } else if (ev.at > openStart) {
            addOpen(key, openStart, ev.at);
          }
          openStart = null;
          // O intervalo fechado deste evento é montado abaixo por
          // rtPairSectorCloseToNextOpen (fechamento → próxima abertura real).
          // Não adicionar aqui: estender cada fechamento até "now" fazia o
          // merge colapsar tudo num único bloco fechado gigante, engolindo
          // reaberturas posteriores (bug confirmado na OP 088088/lote 755).
        }
      }

      if (openStart) {
        addOpen(key, openStart, now);
      }

      // Monta intervalos fechados entre "fechar" e a próxima "abertura" real.
      for (const interval of rtPairSectorCloseToNextOpen(sorted, now)) {
        addClosed(key, interval.start, interval.end);
      }
    }

    const [shifts] = await dbPool.query(`
      SELECT setor, expediente_aberto, iniciado_em, finalizado_em
      FROM ff_sector_shifts
    `);

    for (const row of shifts || []) {
      const key = rtGetShiftKeyForSector(row.setor);
      if (!key) continue;
      ensureBucket(key);

      const isOpen = Number(row.expediente_aberto || 0) === 1;
      const closedAt = rtShiftDateTimeToMs(row.finalizado_em);
      const openedAt = rtShiftDateTimeToMs(row.iniciado_em);

      map.__state[key].isOpen = isOpen;
      map.__state[key].openedAt = openedAt || map.__state[key].openedAt;
      map.__state[key].closedAt = closedAt || map.__state[key].closedAt;

      if (isOpen && openedAt) {
        addOpen(key, openedAt, now);

        // Proteção para quando a base antiga só tem o estado atual aberto,
        // mas não tem evento histórico de "fechado -> aberto".
        // Nesse caso, antes do iniciado_em atual o expediente deve ser tratado como fechado
        // para lotes que atravessaram a noite/fim de semana.
        const hasClosedEndingAtOpen = (map[key] || []).some(i => Math.abs(Number(i.end || 0) - openedAt) <= 2 * 60 * 1000);
        const hasEventHistory = !!map.__state[key].hasEvents;
        if (!hasEventHistory && openedAt) {
          addClosed(key, 1, openedAt);
        } else if (hasEventHistory && !hasClosedEndingAtOpen && map.__state[key].lastEventType === 'open') {
          // Se o último evento conhecido é abertura e não encontramos o fechamento anterior,
          // fecha pelo menos o período imediatamente anterior à abertura atual.
          addClosed(key, Math.max(1, openedAt - 18 * 60 * 60 * 1000), openedAt);
        }
      }

      if (!isOpen && closedAt) {
        addClosed(key, closedAt, now);
      }

      if (isOpen && closedAt && openedAt && openedAt > closedAt) {
        addClosed(key, closedAt, openedAt);
      }
    }

    for (const key of Object.keys(map)) {
      if (key.startsWith('__')) continue;
      map[key] = rtMergeIntervals(map[key]);
    }
    for (const key of Object.keys(map.__open)) {
      map.__open[key] = rtMergeIntervals(map.__open[key]);
    }
  } catch (err) {
    console.warn('[relatorio-tempos] não foi possível carregar histórico de expediente:', err.message);
  }
  return map;
}

function rtSessionExplicitPauseRange(session) {
  const start = rtPickFirstMs(
    session?.pauseStart,
    session?.pausaInicio,
    session?.pausadoEm,
    session?.pausedAt,
    session?.paused_at,
    session?.startPause,
    session?.start_pause,
    session?.start,
    session?.inicio,
    session?.startedAt,
    session?.started_at
  );

  const end = rtPickFirstMs(
    session?.pauseEnd,
    session?.pausaFim,
    session?.retomadoEm,
    session?.retomado_em,
    session?.resumedAt,
    session?.resumed_at,
    session?.endPause,
    session?.end_pause,
    session?.end,
    session?.fim,
    session?.endedAt,
    session?.ended_at
  );

  return { start, end };
}

function rtSumWorkSessionsBySector(workSessions, sector, enteredAt, leftAt, shiftClosedMap = {}) {
  const startLimit = Number(enteredAt || 0);
  const endLimit = Number(leftAt || Date.now());
  const now = Date.now();

  const workIntervals = [];
  const pauseIntervals = [];
  let workedDirectMs = 0;
  let pausedDirectMs = 0;

  for (const session of rtArray(workSessions)) {
    if (!session || typeof session !== 'object') continue;
    if (!rtSessionMatchesSector(session, sector, sector)) continue;

    const { start, end, duration, workedDuration, pausedDuration } = rtGetSessionRange(session);
    const type = rtGetSessionType(session);

    if (type === 'mixed') {
      workedDirectMs += workedDuration;
      pausedDirectMs += pausedDuration;
      continue;
    }

    if (type === 'pause') {
      const pauseRange = rtSessionExplicitPauseRange(session);
      const pStart = pauseRange.start || start;
      const pEnd = pauseRange.end || end || now;
      const ms = duration || (pStart ? rtOverlapMs(pStart, pEnd, startLimit, endLimit) : 0);

      if (pStart && pEnd && pEnd > pStart) {
        const clippedStart = Math.max(pStart, startLimit || pStart);
        const clippedEnd = Math.min(pEnd, endLimit || pEnd);
        if (clippedEnd > clippedStart) pauseIntervals.push({ start: clippedStart, end: clippedEnd });
      } else if (ms > 0) {
        pausedDirectMs += ms;
      }
      continue;
    }

    // Sessão de trabalho. Quando existe pausa aberta dentro dela, a pausa será
    // subtraída depois para não contar o mesmo intervalo como trabalhado e pausado.
    const wStart = start;
    const wEnd = end || endLimit || now;
    const ms = duration || (wStart ? rtOverlapMs(wStart, wEnd, startLimit, endLimit) : 0);

    if (wStart && wEnd && wEnd > wStart) {
      const clippedStart = Math.max(wStart, startLimit || wStart);
      const clippedEnd = Math.min(wEnd, endLimit || wEnd);
      if (clippedEnd > clippedStart) workIntervals.push({ start: clippedStart, end: clippedEnd });
    } else if (ms > 0) {
      workedDirectMs += ms;
    }
  }

  const closedIntervals = rtGetClosedIntervalsForSector(shiftClosedMap, sector, startLimit, endLimit);
  const mergedPauses = rtSubtractIntervals(rtMergeIntervals(pauseIntervals), closedIntervals);
  const effectiveWorkIntervals = rtSubtractIntervals(rtSubtractIntervals(workIntervals, mergedPauses), closedIntervals);

  return {
    workedMs: workedDirectMs + rtIntervalsTotalMs(effectiveWorkIntervals),
    pausedMs: pausedDirectMs + rtIntervalsTotalMs(mergedPauses)
  };
}

function rtExtractSectorFromHistoryEvent(event) {
  const direct = String(event?.sector || event?.setor || event?.toSector || event?.to_sector || event?.novoSetor || event?.setorDestino || event?.destinationSector || '').trim();
  if (direct) return direct;
  const text = String(event?.title || event?.message || event?.description || event?.descricao || event?.acao || event?.action || '').trim();
  const lower = rtNormalizeText(text);
  const known = [
    ['laboratorio_revisao', ['laboratorio_revisao', 'laboratorio revisao']],
    ['laboratorio_amostras', ['laboratorio_amostras', 'laboratorio amostras', 'laboratorio_amostra']],
    ['coloracao_revisao', ['coloracao_revisao', 'coloracao revisao']],
    ['coloracao_amostras', ['coloracao_amostras', 'coloracao amostras', 'coloracao_amostra']],
    ['envase_enlatamento', ['envase_enlatamento', 'enlatamento']],
    ['envase_produzir', ['envase_produzir']],
    ['pcp_liberacao', ['pcp_liberacao', 'pcp liberacao']],
    ['pesagem', ['pesagem']],
    ['producao', ['producao', 'produção']],
    ['moagem', ['moagem']],
    ['laboratorio', ['laboratorio', 'lab']],
    ['coloracao', ['coloracao', 'coloração']],
    ['envase', ['envase']],
    ['pcp', ['pcp']],
    ['pronto_para_entrega', ['pronto_para_entrega', 'pronto entrega']],
    ['pronto', ['pronto']],
    ['entrega', ['entrega']],
    ['entregue', ['entregue']]
  ];
  for (const [sector, needles] of known) {
    if (needles.some(n => lower.includes(rtNormalizeText(n)))) return sector;
  }
  return '';
}

function rtGetHistoryEventTime(event) {
  return rtPickFirstMs(event?.timestamp, event?.time, event?.date, event?.data, event?.createdAt, event?.created_at, event?.at, event?.quando, event?.updatedAt, event?.updated_at);
}


function rtMetricDurationFrom(metric, ...keys) {
  for (const key of keys) {
    const value = metric?.[key];
    const ms = rtDurationMs(value);
    if (ms > 0) return ms;
  }
  return 0;
}

function rtGetStoredMetricDurations(metric) {
  if (!metric || typeof metric !== 'object') {
    return { totalMs: 0, workedMs: 0, pausedMs: 0, idleMs: 0, efficiency: null };
  }

  const totalMs = rtMetricDurationFrom(
    metric,
    'totalMs', 'total_ms', 'tempoTotalMs', 'tempo_total_ms',
    'durationMs', 'duration_ms', 'elapsedMs', 'elapsed_ms'
  );

  const workedMs = rtMetricDurationFrom(
    metric,
    'workedMs', 'worked_ms', 'tempoTrabalhadoMs', 'tempo_trabalhado_ms',
    'trabalhadoMs', 'trabalhado_ms'
  );

  const pausedMs = rtMetricDurationFrom(
    metric,
    'pausedMs', 'paused_ms', 'tempoPausadoMs', 'tempo_pausado_ms',
    'pausadoMs', 'pausado_ms'
  );

  const idleMs = rtMetricDurationFrom(
    metric,
    'idleMs', 'idle_ms', 'tempoOciosoMs', 'tempo_ocioso_ms',
    'ociosoMs', 'ocioso_ms'
  );

  const effRaw = metric?.efficiency ?? metric?.eficiencia ?? metric?.efficiencyPct ?? metric?.eficienciaPct;
  const efficiency = Number.isFinite(Number(effRaw)) ? Math.round(Number(effRaw)) : null;

  return { totalMs, workedMs, pausedMs, idleMs, efficiency };
}

function rtGetMetricSector(metric, fallbackSector = '') {
  return String(
    metric?.sector ||
    metric?.setor ||
    metric?.sectorKey ||
    metric?.setorKey ||
    metric?.nomeSetor ||
    metric?.setor_nome ||
    fallbackSector ||
    ''
  ).trim();
}

function rtMetricMatchesSector(metric, targetSector) {
  const metricSector = rtGetMetricSector(metric);
  if (!metricSector || !targetSector) return true;
  return rtSessionMatchesSector({ sector: metricSector }, targetSector, targetSector);
}

function rtGetMetricEnteredAt(metric) {
  return rtPickFirstMs(
    metric?.enteredAt,
    metric?.entered_at,
    metric?.entrada,
    metric?.start,
    metric?.inicio,
    metric?.startedAt,
    metric?.started_at,
    metric?.createdAt,
    metric?.created_at
  );
}

function rtGetMetricLeftAt(metric) {
  return rtPickFirstMs(
    metric?.leftAt,
    metric?.left_at,
    metric?.saida,
    metric?.exitAt,
    metric?.exit_at,
    metric?.end,
    metric?.fim,
    metric?.endedAt,
    metric?.ended_at,
    metric?.updatedAt,
    metric?.updated_at
  );
}

function rtFindStoredMetricForTimeline(row, sector, enteredAt, leftAt, usedIndexes = new Set()) {
  const storedMetrics = rtArray(row?.ff_sectorMetrics);
  if (!storedMetrics.length) return null;

  const targetStart = Number(enteredAt || 0);
  const targetEnd = Number(leftAt || 0);

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  storedMetrics.forEach((metric, idx) => {
    if (!metric || typeof metric !== 'object') return;
    if (usedIndexes.has(idx)) return;
    if (!rtMetricMatchesSector(metric, sector)) return;

    const durations = rtGetStoredMetricDurations(metric);
    const hasUsefulDuration = durations.totalMs > 0 || durations.workedMs > 0 || durations.pausedMs > 0 || durations.idleMs > 0;
    if (!hasUsefulDuration) return;

    const mStart = rtGetMetricEnteredAt(metric);
    const mEnd = rtGetMetricLeftAt(metric);

    // Setor normalizado (laboratorio/laboratorio_revisao, coloracao/coloracao_revisao etc.)
    // agrupa sinônimos, mas isso não deve permitir "resgatar" por padrão um metric de
    // outra visita ao setor que aconteceu em uma janela completamente diferente — sem este
    // guard, quando a métrica certa do mesmo setor está zerada (vítima do bug de
    // rtLoadShiftClosedIntervals) ela é descartada por !hasUsefulDuration e o código acaba
    // escolhendo por eliminação a métrica de um sinônimo distante (ex.: laboratorio_revisao
    // de ~2 dias antes) só porque é o único candidato restante com duração útil.
    const RT_STORED_METRIC_MAX_DISTANCE_MS = 24 * 60 * 60 * 1000;
    if (targetStart && mStart && Math.abs(mStart - targetStart) > RT_STORED_METRIC_MAX_DISTANCE_MS) return;

    let score = 0;
    if (targetStart && mStart) score += Math.abs(mStart - targetStart);
    else score += 24 * 60 * 60 * 1000;

    if (targetEnd && mEnd) score += Math.abs(mEnd - targetEnd) * 0.5;
    else if (targetEnd || mEnd) score += 60 * 60 * 1000;

    // Preferência leve por métricas com trabalhado/pausado real, pois elas batem com os cards do lote.
    if (durations.workedMs > 0 || durations.pausedMs > 0) score -= 10 * 60 * 1000;

    if (score < bestScore) {
      bestScore = score;
      best = { metric, idx, durations };
    }
  });

  if (best) usedIndexes.add(best.idx);
  return best;
}

function rtComposeDurationsFromSources({ totalCandidateMs, sessionSum, storedDurations }) {
  const stored = storedDurations || { totalMs: 0, workedMs: 0, pausedMs: 0, idleMs: 0, efficiency: null };

  // Regra correta: o total no setor deve ser o tempo útil calculado pelos
  // eventos reais de abrir/fechar expediente. Não priorize totalMs antigo de
  // ff_sectorMetrics, porque ele pode ter sido gravado corrido enquanto o
  // expediente estava fechado.
  let totalMs = Number(totalCandidateMs || 0);
  if (totalMs <= 0 && stored.totalMs > 0) totalMs = stored.totalMs;

  // sessionSum (ff_workSessions) é calculado com o mesmo shiftClosedMap usado em
  // totalMs acima, então os dois são mutuamente consistentes nesta mesma requisição.
  // stored.workedMs/pausedMs vêm de um ff_sectorMetrics gravado em outro momento
  // (outro "now"/outro recálculo) e podem não somar mais com o totalMs atual — usá-los
  // por cima de um sessionSum válido faz o clamp abaixo truncar trabalhado e zerar
  // pausado mesmo quando a sessão real existe. Por isso sessionSum tem prioridade
  // sempre que existir; o metric salvo só serve de resgate quando não há sessão.
  let workedMs = sessionSum?.workedMs > 0 ? Number(sessionSum.workedMs) : Number(stored.workedMs || 0);
  let pausedMs = sessionSum?.pausedMs > 0 ? Number(sessionSum.pausedMs) : Number(stored.pausedMs || 0);
  let idleMs = stored.idleMs > 0 ? stored.idleMs : 0;

  if (totalMs <= 0 && (workedMs > 0 || pausedMs > 0 || idleMs > 0)) {
    totalMs = workedMs + pausedMs + idleMs;
  }

  workedMs = Math.max(0, Math.min(workedMs, totalMs));
  pausedMs = Math.max(0, Math.min(pausedMs, Math.max(0, totalMs - workedMs)));

  if (idleMs > 0) {
    idleMs = Math.max(0, Math.min(idleMs, Math.max(0, totalMs - workedMs - pausedMs)));
  } else {
    idleMs = Math.max(0, totalMs - workedMs - pausedMs);
  }

  const efficiency = totalMs > 0
    ? Math.round((workedMs / totalMs) * 100)
    : (stored.efficiency != null ? stored.efficiency : 0);

  return { totalMs, workedMs, pausedMs, idleMs, efficiency };
}

function rtCalculateMetricsFromFallback(row, shiftClosedMap = {}) {
  const now = Date.now();
  const finalSectors = new Set(['pronto', 'entrega', 'entregue', 'finalizado', 'concluido', 'concluído']);
  const currentSector = String(row?.setor_atual || row?.status || '').trim();
  const currentSectorNorm = rtNormalizeText(currentSector);
  const lotStatusNorm = rtNormalizeText(row?.ff_lotStatus || row?.status || '');
  const isFinalLot = finalSectors.has(currentSectorNorm) || lotStatusNorm.includes('final') || lotStatusNorm.includes('entregue');

  const history = rtArray(row.ff_history)
    .map((event, idx) => ({ event, sector: rtExtractSectorFromHistoryEvent(event), at: rtGetHistoryEventTime(event), idx }))
    .filter(item => item.sector && item.at)
    .sort((a, b) => a.at - b.at || a.idx - b.idx);

  const metrics = [];
  const usedStoredMetricIndexes = new Set();

  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    const next = history[i + 1];
    const sectorNorm = rtNormalizeText(current.sector || '');

    // Eventos finais não devem virar cartão de tempo produtivo.
    if (finalSectors.has(sectorNorm)) continue;

    const enteredAt = current.at;
    let leftAt = next?.at || null;
    let status = 'Finalizado';

    if (!leftAt) {
      if (!isFinalLot && currentSectorNorm && sectorNorm === currentSectorNorm) {
        status = 'Em andamento';
      } else {
        leftAt = rtPickFirstMs(row.updated_at, row.updatedAt, row.deliveredAt, row.finalizadoEm) || enteredAt;
        status = 'Finalizado';
      }
    }

    // Proteção contra dados corrompidos ou métrica antiga invertida.
    if (leftAt && leftAt < enteredAt) continue;

    const effectiveLeftAt = leftAt || now;
    const businessTotalMs = rtBusinessDurationMs(enteredAt, effectiveLeftAt, current.sector, shiftClosedMap);
    const sessionSum = rtSumWorkSessionsBySector(row.ff_workSessions, current.sector, enteredAt, effectiveLeftAt, shiftClosedMap);

    // Os cards do lote usam dados gravados em ff_sectorMetrics quando existem.
    // O relatório estava ignorando esses valores quando havia ff_history, por isso trabalhado vinha 0 e tudo virava ocioso.
    const storedMatch = rtFindStoredMetricForTimeline(
      row,
      current.sector,
      enteredAt,
      effectiveLeftAt,
      usedStoredMetricIndexes
    );

    const composed = rtComposeDurationsFromSources({
      totalCandidateMs: businessTotalMs,
      sessionSum,
      storedDurations: storedMatch?.durations || null
    });

    metrics.push({
      sector: current.sector,
      enteredAt,
      leftAt: status === 'Em andamento' ? null : leftAt,
      totalMs: composed.totalMs,
      workedMs: composed.workedMs,
      pausedMs: composed.pausedMs,
      idleMs: composed.idleMs,
      efficiency: composed.efficiency,
      status,
      _preserveStoredMetrics: !!storedMatch
    });
  }

  // Fallback só quando não há histórico confiável.
  if (!metrics.length && currentSector && !finalSectors.has(currentSectorNorm)) {
    const enteredAt = rtPickFirstMs(row.ff_sectorEnteredAt, row.updated_at, row.data_criacao) || now;
    const totalMs = rtBusinessDurationMs(enteredAt, now, currentSector, shiftClosedMap);
    const sessionSum = rtSumWorkSessionsBySector(row.ff_workSessions, currentSector, enteredAt, now, shiftClosedMap);
    let workedMs = Math.min(sessionSum.workedMs, totalMs);
    let pausedMs = Math.min(sessionSum.pausedMs, Math.max(0, totalMs - workedMs));
    const idleMs = Math.max(0, totalMs - workedMs - pausedMs);
    const efficiency = totalMs > 0 ? Math.round((workedMs / totalMs) * 100) : 0;
    metrics.push({ sector: currentSector, enteredAt, leftAt: null, totalMs, workedMs, pausedMs, idleMs, efficiency, status: 'Em andamento' });
  }

  return rtFixMetricsTimeline(metrics, row, shiftClosedMap);
}

function rtNormalizeMetric(metric, row, shiftClosedMap = {}) {
  const now = Date.now();
  const sector = String(metric?.sector || metric?.setor || metric?.sectorKey || row?.setor_atual || 'sem_setor').trim();
  const enteredAt = rtPickFirstMs(metric?.enteredAt, metric?.entered_at, metric?.entrada, metric?.start, metric?.inicio, metric?.startedAt, row?.ff_sectorEnteredAt, row?.data_criacao, row?.updated_at) || now;
  const rawLeftAt = rtPickFirstMs(metric?.leftAt, metric?.left_at, metric?.saida, metric?.exitAt, metric?.end, metric?.fim, metric?.endedAt);

  const totalFromMetric = rtDurationMs(metric?.totalMs ?? metric?.total_ms ?? metric?.tempoTotalMs ?? metric?.tempo_total_ms);
  const workedFromMetric = rtDurationMs(metric?.workedMs ?? metric?.worked_ms ?? metric?.tempoTrabalhadoMs ?? metric?.tempo_trabalhado_ms);
  const pausedFromMetric = rtDurationMs(metric?.pausedMs ?? metric?.paused_ms ?? metric?.tempoPausadoMs ?? metric?.tempo_pausado_ms);

  const isCurrentSector = rtNormalizeText(sector) === rtNormalizeText(row?.setor_atual || '');
  const metricStatus = rtNormalizeText(metric?.status || metric?.situacao || '');
  const isClosedByMetric = !!rawLeftAt || metricStatus.includes('final') || metricStatus.includes('done') || metricStatus.includes('conclu');
  const leftAt = rawLeftAt || (isCurrentSector && !isClosedByMetric ? null : rtPickFirstMs(metric?.updatedAt, metric?.updated_at, row?.updated_at));
  const effectiveLeftAt = leftAt || now;

  // Sempre recalcula o total útil pelo intervalo de entrada/saída descontando expediente fechado.
  // Não confia em totalMs antigo salvo em ff_sectorMetrics, porque ele pode ter sido gravado corrido.
  let totalMs = rtBusinessDurationMs(enteredAt, effectiveLeftAt, sector, shiftClosedMap);
  if (!totalMs && totalFromMetric && !rtGetClosedIntervalsForSector(shiftClosedMap, sector, enteredAt, effectiveLeftAt).length) {
    totalMs = totalFromMetric;
  }
  const sessionSum = rtSumWorkSessionsBySector(row?.ff_workSessions, sector, enteredAt, effectiveLeftAt, shiftClosedMap);

  // IMPORTANTE:
  // Ocioso NÃO deve virar o "resto" errado quando o trabalhado não veio.
  // Fórmula correta: total = trabalhado + pausado + ocioso.
  // Então, se o banco já tem idleMs/tempoOciosoMs salvo e o workedMs veio 0/vazio,
  // reconstruímos o trabalhado por diferença: worked = total - paused - idle.
  const idleFromMetric = rtDurationMs(
    metric?.idleMs ??
    metric?.idle_ms ??
    metric?.tempoOciosoMs ??
    metric?.tempo_ocioso_ms
  );

  let workedMs = workedFromMetric || sessionSum.workedMs;
  let pausedMs = pausedFromMetric || sessionSum.pausedMs;

  if ((!workedMs || workedMs <= 0) && totalMs > 0 && idleFromMetric > 0) {
    const derivedWorked = Math.max(0, totalMs - pausedMs - idleFromMetric);
    if (derivedWorked > 0) workedMs = derivedWorked;
  }

  workedMs = Math.min(workedMs, totalMs);
  pausedMs = Math.min(pausedMs, Math.max(0, totalMs - workedMs));
  const idleMs = Math.max(0, idleFromMetric || (totalMs - workedMs - pausedMs));
  const efficiencyRaw = metric?.efficiency ?? metric?.eficiencia ?? metric?.efficiencyPct ?? metric?.eficienciaPct;
  const efficiency = Number.isFinite(Number(efficiencyRaw)) ? Math.round(Number(efficiencyRaw)) : (totalMs > 0 ? Math.round((workedMs / totalMs) * 100) : 0);

  return { sector, enteredAt, leftAt, totalMs, workedMs, pausedMs, idleMs, efficiency, status: leftAt ? 'Finalizado' : 'Em andamento' };
}

function rtFixMetricsTimeline(metrics, row, shiftClosedMap = {}) {
  const now = Date.now();
  const currentSectorNorm = rtNormalizeText(row?.setor_atual || '');

  const sorted = (metrics || [])
    .filter(Boolean)
    .map(m => ({ ...m }))
    .sort((a, b) => Number(a.enteredAt || 0) - Number(b.enteredAt || 0));

  for (let i = 0; i < sorted.length; i++) {
    const metric = sorted[i];
    const next = sorted[i + 1];
    const sectorNorm = rtNormalizeText(metric.sector || '');
    const isCurrent = currentSectorNorm && sectorNorm === currentSectorNorm;

    // Se existe próximo setor, o setor atual da linha anterior foi finalizado na entrada do próximo.
    if (!metric.leftAt && next?.enteredAt && Number(next.enteredAt) > Number(metric.enteredAt || 0)) {
      metric.leftAt = Number(next.enteredAt);
      metric.status = 'Finalizado';
    }

    // Se não é o setor atual do lote e não tem saída, usa updated_at como fechamento.
    if (!metric.leftAt && !isCurrent) {
      const updated = rtPickFirstMs(row?.updated_at, row?.updatedAt);
      if (updated && updated > Number(metric.enteredAt || 0)) {
        metric.leftAt = updated;
        metric.status = 'Finalizado';
      }
    }

    if (!metric.leftAt && isCurrent) {
      metric.status = 'Em andamento';
    } else if (metric.leftAt) {
      metric.status = 'Finalizado';
    }

    const effectiveLeftAt = metric.leftAt || now;
    const recalculatedTotal = rtBusinessDurationMs(Number(metric.enteredAt || effectiveLeftAt), effectiveLeftAt, metric.sector, shiftClosedMap);

    // Sempre usa o total útil recalculado pelos eventos reais de expediente.
    // Mesmo quando há ff_sectorMetrics, o total salvo pode estar corrido; então
    // preservamos apenas trabalhado/pausado quando forem úteis.
    if (recalculatedTotal > 0 || !Number(metric.totalMs || 0)) {
      metric.totalMs = recalculatedTotal;
    }

    const sessionSum = rtSumWorkSessionsBySector(row?.ff_workSessions, metric.sector, metric.enteredAt, effectiveLeftAt, shiftClosedMap);
    if (!metric._preserveStoredMetrics || Number(metric.pausedMs || 0) <= 0) {
      if (sessionSum.pausedMs > 0) metric.pausedMs = sessionSum.pausedMs;
    }
    if (!metric._preserveStoredMetrics || Number(metric.workedMs || 0) <= 0) {
      if (sessionSum.workedMs > 0) metric.workedMs = sessionSum.workedMs;
    }

    metric.workedMs = Math.min(Number(metric.workedMs || 0), Number(metric.totalMs || 0));
    metric.pausedMs = Math.min(Number(metric.pausedMs || 0), Math.max(0, Number(metric.totalMs || 0) - metric.workedMs));
    metric.idleMs = Math.max(0, Number(metric.totalMs || 0) - metric.workedMs - metric.pausedMs);
    metric.efficiency = metric.totalMs > 0 ? Math.round((metric.workedMs / metric.totalMs) * 100) : 0;
  }

  return sorted;
}


function rtFirstTextValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys || []) {
    const value = obj?.[key];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const txt = value.map(v => typeof v === 'object' ? rtFirstTextValue(v, keys) : String(v || '').trim()).filter(Boolean).join(' | ');
      if (txt) return txt;
      continue;
    }
    if (typeof value === 'object') {
      const nested = rtFirstTextValue(value, keys);
      if (nested) return nested;
      continue;
    }
    const txt = String(value || '').trim();
    if (txt && txt !== '-' && txt !== '–') return txt;
  }
  return '';
}

function rtUniqueTextJoin(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const txt = String(value || '').trim();
    if (!txt || txt === '-' || txt === '–') continue;
    const key = txt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(txt);
  }
  return out.join(' | ');
}

function rtObservationKeys() {
  return [
    'observacoes', 'observacao', 'observação', 'obs', 'observation', 'observations',
    'note', 'notes', 'comentario', 'comentário', 'comentarios', 'comentários',
    'descricao', 'descrição', 'description', 'detalhes', 'details',
    'observacaoAvanco', 'observacao_avanco', 'obsAvanco', 'obs_avanco',
    'observacaoSetor', 'observacao_setor', 'comentarioSetor', 'comentario_setor',
    'movementObservation', 'advanceObservation', 'advanceNote', 'sectorNote',
    'textoObservacao', 'texto_observacao'
  ];
}

function rtPauseReasonKeys() {
  return [
    'pauseReason', 'pause_reason', 'motivoPausa', 'motivo_pausa', 'motivo_pausado',
    'motivoPausado', 'reason', 'pausaMotivo', 'pausa_motivo'
  ];
}

function rtCollectTempoRowTexts(row, metric, type = 'obs') {
  const keys = type === 'pause' ? rtPauseReasonKeys() : rtObservationKeys();
  const values = [];
  const sectorNorm = rtNormalizeText(metric?.sector || '');
  const start = Number(metric?.enteredAt || 0);
  const end = Number(metric?.leftAt || Date.now());
  const tolerance = 2 * 60 * 1000;

  // Observações digitadas ao avançar normalmente ficam no evento de histórico
  // que tem o timestamp da saída do setor anterior. Por isso aceitamos eventos
  // no intervalo da linha e também eventos exatamente próximos da saída.
  for (const ev of rtArray(row?.ff_history)) {
    if (!ev || typeof ev !== 'object') continue;
    const txt = rtFirstTextValue(ev, keys);
    if (!txt) continue;
    const evTime = rtGetHistoryEventTime(ev) || rtPickFirstMs(ev?.timestamp, ev?.createdAt, ev?.created_at, ev?.updatedAt, ev?.updated_at);
    const evSector = rtNormalizeText(rtExtractSectorFromHistoryEvent(ev));
    const sameSector = !sectorNorm || !evSector || evSector === sectorNorm || rtSessionMatchesSector({ sector: evSector }, sectorNorm, sectorNorm);
    const insideWindow = !start || !evTime || (evTime >= start - tolerance && evTime <= end + tolerance);
    const closeToExit = end && evTime && Math.abs(evTime - end) <= tolerance;
    if (sameSector || insideWindow || closeToExit) values.push(txt);
  }

  // Motivo de pausa costuma ficar em ff_workSessions. Também aceitamos obs ali,
  // caso o frontend tenha gravado observação junto com a sessão.
  for (const session of rtArray(row?.ff_workSessions)) {
    if (!session || typeof session !== 'object') continue;
    const txt = rtFirstTextValue(session, keys);
    if (!txt) continue;
    if (!rtSessionMatchesSector(session, metric?.sector || '', metric?.sector || '')) continue;
    const { start: sStart, end: sEnd } = rtGetSessionRange(session);
    const overlaps = !start || !sStart || rtOverlapMs(sStart, sEnd || end || Date.now(), start, end || Date.now()) > 0;
    if (overlaps) values.push(txt);
  }

  return rtUniqueTextJoin(values);
}

function rtBuildTempoRowsFromLot(row, setorFiltro = '', shiftClosedMap = {}) {
  // Fonte de verdade da sequência: ff_history.
  // ff_sectorMetrics pode conter registros antigos/corrompidos com entrada/saída invertidas
  // ou setores fora do fluxo; por isso só usamos metrics quando não existe histórico.
  const historyItems = rtArray(row.ff_history);
  const parsedMetrics = rtArray(row.ff_sectorMetrics);
  const baseMetrics = historyItems.length
    ? rtCalculateMetricsFromFallback(row, shiftClosedMap)
    : (parsedMetrics.length
        ? rtFixMetricsTimeline(parsedMetrics.map(metric => rtNormalizeMetric(metric, row, shiftClosedMap)), row, shiftClosedMap)
        : rtCalculateMetricsFromFallback(row, shiftClosedMap));

  const filterNorm = rtNormalizeText(setorFiltro);
  return baseMetrics
    .filter(metric => !filterNorm || rtNormalizeText(metric.sector) === filterNorm || rtNormalizeText(rtDisplaySector(metric.sector)) === filterNorm)
    .map(metric => ({
      op: row.op || '',
      numero_pedido: row.numero_pedido || '',
      produto_codigo: row.produto_codigo || '',
      produto_nome: row.produto_nome || '',
      cliente_nome: row.cliente_nome || '',
      quantidade: Number(row.quantidade || 0),
      linha_produto: row.linha_produto || '',
      setor: metric.sector || 'sem_setor',
      setor_nome: rtDisplaySector(metric.sector || 'sem_setor'),
      enteredAt: metric.enteredAt || null,
      leftAt: metric.leftAt || null,
      totalMs: Math.max(0, Number(metric.totalMs || 0)),
      workedMs: Math.max(0, Number(metric.workedMs || 0)),
      pausedMs: Math.max(0, Number(metric.pausedMs || 0)),
      idleMs: Math.max(0, Number(metric.idleMs || 0)),
      efficiency: Math.max(0, Math.min(100, Number(metric.efficiency || 0))),
      status: metric.status || (metric.leftAt ? 'Finalizado' : 'Em andamento'),
      // ff_lot_status é a fonte de verdade do estado operacional do lote (FactoryFlow);
      // status_atual_lote (coluna legada `status`) é mantido apenas como fallback.
      ff_lot_status: row.ff_lotStatus || '',
      status_atual_lote: row.status || '',
      setor_atual_lote: row.setor_atual || '',
      observacoes: rtCollectTempoRowTexts(row, metric, 'obs'),
      pauseReason: rtCollectTempoRowTexts(row, metric, 'pause'),
      motivo_pausa: rtCollectTempoRowTexts(row, metric, 'pause'),
      id_lote: row.id || null
    }));
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
  const hasFfSectorMetrics = await columnExists('producao_lotes', 'ff_sectorMetrics');

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
        ${hasFfSectorMetrics ? 'ff_sectorMetrics' : 'NULL AS ff_sectorMetrics'},
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
  ''
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
    version: '2.4.1-expediente-reprocessamento',
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
      'PATCH /api/pedidos/:numero/data-entrega',
      'GET /api/ops',
      'GET /api/ops/:op',
      'GET /api/producao',
      'GET /api/producao/ativos',
      'GET /api/producao/relatorio-tempos',
      'POST /api/admin/reprocessar-tempos',
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
    version: '2.4.1-expediente-reprocessamento',
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
      `Quantidade: ${pedidoItem.pits_peso || pedidoItem.pits_qtde || '-'} Kg`,
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



// =========================
// LOGIN PÚBLICO - precisa ficar ANTES do requireApiToken
// =========================
// Motivo: o usuário ainda não tem JWT antes de logar.
// Esta rota aceita as senhas antigas do FactoryFlow, inclusive formato "salt:hash" FNV usado no frontend.

function fnv1a32Server(str) {
  let hash = 0x811c9dc5;
  const input = String(str || '');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function hashPasswordFNVServer(password, salt) {
  const pwd = String(password || '');
  const s = String(salt || '');
  let h = fnv1a32Server(s + pwd);
  for (let r = 0; r < 3; r++) {
    h = fnv1a32Server(s + h + pwd);
  }
  return `${s}:${h}`;
}

async function verifyFactoryFlowPassword(enteredPassword, storedHash) {
  const senha = String(enteredPassword || '');
  const stored = String(storedHash || '');

  if (!senha || !stored) return false;

  // 1) Formato antigo/atual do FactoryFlow frontend: "salt:hash" com FNV-1a.
  // Exemplo: abcdef1234567890:1a2b3c4d
  if (stored.includes(':')) {
    const [salt] = stored.split(':');
    if (safeEqual(hashPasswordFNVServer(senha, salt), stored)) return true;
  }

  // 2) Bcrypt, caso algum usuário tenha sido gerado assim.
  if (stored.startsWith('$2')) {
    try {
      const bcrypt = require('bcryptjs');
      if (await bcrypt.compare(senha, stored)) return true;
    } catch (_) {
      // bcryptjs pode não estar instalado; não deve derrubar o login.
    }
  }

  // 3) SHA-256.
  const sha256 = crypto.createHash('sha256').update(senha).digest('hex');
  if (safeEqual(sha256, stored)) return true;

  // 4) MD5 legado.
  const md5 = crypto.createHash('md5').update(senha).digest('hex');
  if (safeEqual(md5, stored)) return true;

  // 5) Texto puro legado.
  if (safeEqual(senha, stored)) return true;

  return false;
}

function signFactoryFlowJwt(payload) {
  const now = Math.floor(Date.now() / 1000);

  const headerEncoded = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadEncoded = base64UrlEncode(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + (8 * 60 * 60)
  }));

  const signature = base64UrlEncode(
    crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerEncoded}.${payloadEncoded}`)
      .digest()
  );

  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

app.post('/api/login', async (req, res) => {
  try {
    const usuario = String(
      req.body.usuario || req.body.login || req.body.username || req.body.email || ''
    ).trim().toLowerCase();

    // Não usa .trim() na senha para evitar falha caso alguma senha antiga tenha espaço.
    const senha = String(req.body.senha || req.body.password || '');

    if (!usuario || !senha) {
      return sendError(res, 400, 'Informe usuário e senha');
    }

    const hasUsersTable = await tableExists('users');
    if (!hasUsersTable) {
      console.error('❌ Login falhou: tabela users não existe.');
      return sendError(res, 500, 'Tabela de usuários não encontrada');
    }

    const [columnsRows] = await dbPool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'users'
      `
    );

    const userColumns = new Set(
      columnsRows.map(row => String(row.column_name || row.COLUMN_NAME || '').trim())
    );

    const existing = (names) => names.filter(name => userColumns.has(name));

    const loginColumns = existing(['usuario', 'login', 'username', 'email']);
    const passwordColumns = existing(['senha_hash', 'password_hash', 'senha', 'password', 'pass_hash']);

    if (!loginColumns.length) {
      console.error('❌ Login falhou: nenhuma coluna de usuário encontrada em users. Esperado: usuario/login/username/email');
      return sendError(res, 500, 'Configuração de login inválida: coluna de usuário não encontrada');
    }

    if (!passwordColumns.length) {
      console.error('❌ Login falhou: nenhuma coluna de senha encontrada em users. Esperado: senha_hash/password_hash/senha/password/pass_hash');
      return sendError(res, 500, 'Configuração de login inválida: coluna de senha não encontrada');
    }

    const whereLogin = loginColumns
      .map(col => `LOWER(TRIM(CAST(\`${col}\` AS CHAR))) = ?`)
      .join(' OR ');

    const [rows] = await dbPool.query(
      `
        SELECT *
        FROM users
        WHERE ${whereLogin}
        LIMIT 1
      `,
      loginColumns.map(() => usuario)
    );

    if (!rows.length) {
      // Fallback: tenta ff_users (usuários criados diretamente no FactoryFlow)
      const hasFF = await tableExists('ff_users');
      if (hasFF) {
        const [ffRows] = await dbPool.query(
          `SELECT * FROM ff_users WHERE LOWER(TRIM(COALESCE(login,''))) = ? AND COALESCE(active,'true') NOT IN ('false','0','inativo') LIMIT 1`,
          [usuario]
        );
        if (ffRows.length) {
          const ffUser = ffRows[0];
          const ffOk = await verifyFactoryFlowPassword(senha, String(ffUser.password || ''));
          if (!ffOk) {
            return sendError(res, 401, 'Usuário ou senha incorretos');
          }
          const ffPayload = {
            id: String(ffUser.id || ''),
            usuario: ffUser.login || usuario,
            login:   ffUser.login || usuario,
            username: ffUser.login || usuario,
            nome: ffUser.name || ffUser.login || usuario,
            name: ffUser.name || ffUser.login || usuario,
            role: ffUser.role || 'viewer',
            acesso_factoryflow: ffUser.role || 'manager',
            apps: ['factoryflow'],
          };
          const ffToken = signFactoryFlowJwt(ffPayload);
          console.log('✅ Login ff_users OK:', usuario, '| role:', ffPayload.role);
          return res.json({ ok: true, token: ffToken, user: ffPayload });
        }
      }
      console.warn('⚠️ Login recusado: usuário não encontrado:', usuario);
      return sendError(res, 401, 'Usuário ou senha incorretos');
    }

    const user = rows[0];

    if (userColumns.has('ativo')) {
      const ativoRaw = String(user.ativo ?? '').trim().toLowerCase();

      const ativoOk =
        ativoRaw === '' ||
        ativoRaw === '1' ||
        ativoRaw === 'true' ||
        ativoRaw === 'sim' ||
        ativoRaw === 's' ||
        ativoRaw === 'ativo';

      if (!ativoOk) {
        console.warn('⚠️ Login recusado: usuário inativo:', usuario);
        return sendError(res, 403, 'Usuário inativo');
      }
    }

    const passwordColumnUsed = passwordColumns.find(col => String(user[col] || '').length > 0);
    const storedPassword = passwordColumnUsed ? user[passwordColumnUsed] : '';

    if (!storedPassword) {
      console.warn('⚠️ Login recusado: usuário sem senha cadastrada:', usuario);
      return sendError(res, 401, 'Usuário ou senha incorretos');
    }

    const senhaOk = await verifyFactoryFlowPassword(senha, storedPassword);

    if (!senhaOk) {
      console.warn(
        '⚠️ Login recusado: senha inválida para',
        usuario,
        '| coluna usada:',
        passwordColumnUsed,
        '| formato:',
        String(storedPassword || '').includes(':') ? 'salt:hash' :
          String(storedPassword || '').startsWith('$2') ? 'bcrypt' :
          String(storedPassword || '').length === 64 ? 'sha256' :
          String(storedPassword || '').length === 32 ? 'md5' :
          'texto/legado'
      );
      return sendError(res, 401, 'Usuário ou senha incorretos');
    }

    const userLogin =
      user.usuario ||
      user.login ||
      user.username ||
      user.email ||
      usuario;

    const userName =
      user.nome ||
      user.name ||
      user.full_name ||
      userLogin ||
      'Usuário';

    const acessoFactoryFlow =
      user.acesso_factoryflow ||
      user.factoryflow_access ||
      user.acessoFactoryFlow ||
      user.acesso_factory ||
      '';

    const acessoPaintLab =
      user.acesso_paintlab ||
      user.paintlab_access ||
      user.acessoPaintLab ||
      '';

    const acessoCqVision =
      user.acesso_cqvision ||
      user.cqvision_access ||
      user.acessoCqVision ||
      '';

    const apps = [];
    if (String(acessoFactoryFlow || '').trim()) apps.push('factoryflow');
    if (String(acessoPaintLab || '').trim()) apps.push('paintlab');
    if (String(acessoCqVision || '').trim()) apps.push('cqvision');

    // Compatibilidade: se for admin/gerente/pcp/operador mas o campo de acesso estiver vazio,
    // ainda libera o FactoryFlow para não bloquear usuários antigos da empresa.
    const roleNorm = String(user.role || user.perfil || '').toLowerCase().trim();

    if (!apps.includes('factoryflow') && [
      'admin',
      'administrador',
      'diretoria',
      'pcp',
      'pcp_lib',
      'gerente',
      'manager',
      'sector',
      'setor',
      'operador',
      'driver',
      'motorista',
      'tv',
      'viewer',
      'visualizador'
    ].includes(roleNorm)) {
      apps.push('factoryflow');
    }

    const payload = {
      id: user.id,
      usuario: userLogin,
      login: userLogin,
      username: userLogin,
      nome: userName,
      name: userName,
      role: user.role || user.perfil || 'viewer',
      acesso_factoryflow: acessoFactoryFlow,
      acesso_paintlab: acessoPaintLab,
      acesso_cqvision: acessoCqVision,
      apps
    };

    const token = signFactoryFlowJwt(payload);

    console.log('✅ Login OK:', userLogin, '| apps:', apps.join(',') || '-', '| role:', payload.role);

    return res.json({
      ok: true,
      token,
      user: payload
    });
  } catch (err) {
    console.error('❌ Erro em POST /api/login:', err);
    return sendError(res, 500, 'Erro ao fazer login', err.message);
  }
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
          COALESCE(fpd.data_entrega, MIN(p.pits_previsao)) AS pits_previsao,
          COALESCE(fpd.data_entrega, MIN(p.pits_previsao)) AS previsao_entrega,
          COALESCE(fpd.data_entrega, MIN(p.pits_previsao)) AS deliveryDate,
          COALESCE(fpd.data_entrega, MIN(p.pits_previsao)) AS data_entrega,
          fpd.data_entrega AS data_entrega_override,
          COUNT(*) AS total_itens,
          COUNT(DISTINCT p.pits_op) AS total_ops,
          SUM(COALESCE(p.pits_qtde, 0)) AS total_quantidade,
          SUM(COALESCE(p.pits_peso, 0)) AS total_peso,
          ${processadoSelect}
          MAX(p.id) AS ultimo_id
        FROM cli_pedidos_itens p
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(p.pits_cliente) AS UNSIGNED)
        LEFT JOIN ff_pedidos_datas fpd
          ON TRIM(fpd.pedido) = TRIM(p.pits_numero)
        ${where}
        GROUP BY
          p.pits_numero,
          p.pits_cliente,
          c.cli_nome,
          fpd.data_entrega
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


app.patch('/api/pedidos/:numero/data-entrega', async (req, res) => {
  try {
    const numero = String(req.params.numero || '').trim();
    const dataEntrega = String(req.body.data_entrega || req.body.deliveryDate || req.body.previsao_entrega || '').trim();

    if (!numero) {
      return sendError(res, 400, 'Pedido não informado');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataEntrega)) {
      return sendError(res, 400, 'Data inválida', 'Use o formato YYYY-MM-DD. Exemplo: 2026-06-05');
    }

    const atualizadoPor = String(
      req.user?.nome ||
      req.user?.name ||
      req.user?.usuario ||
      req.user?.username ||
      req.user?.email ||
      req.authType ||
      ''
    ).trim() || null;

    await ensurePedidoDatasTable();

    await dbPool.query(
      `
        INSERT INTO ff_pedidos_datas (pedido, data_entrega, atualizado_por)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          data_entrega = VALUES(data_entrega),
          atualizado_por = VALUES(atualizado_por),
          atualizado_em = CURRENT_TIMESTAMP
      `,
      [numero, dataEntrega, atualizadoPor]
    );

    return res.json({
      ok: true,
      success: true,
      message: 'Data de entrega do pedido atualizada para todos os usuários',
      numero,
      pedido: numero,
      data_entrega: dataEntrega,
      deliveryDate: dataEntrega,
      previsao_entrega: dataEntrega,
      atualizado_por: atualizadoPor,
    });
  } catch (err) {
    console.error('PATCH /api/pedidos/:numero/data-entrega erro:', err.message);
    return sendError(res, 500, 'Erro ao atualizar data de entrega do pedido', err.message);
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
          COALESCE(fpd.data_entrega, p.pits_previsao) AS pits_previsao,
          COALESCE(fpd.data_entrega, p.pits_previsao) AS previsao_entrega,
          COALESCE(fpd.data_entrega, p.pits_previsao) AS deliveryDate,
          COALESCE(fpd.data_entrega, p.pits_previsao) AS data_entrega,
          fpd.data_entrega AS data_entrega_override,
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
        LEFT JOIN ff_pedidos_datas fpd
          ON TRIM(fpd.pedido) = TRIM(p.pits_numero)
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

    const itens = rows.map((row) => ({
      ...row,
      // No ERP, pits_qtde costuma ser quantidade de embalagem/unidade.
      // Para o FactoryFlow, a quantidade operacional deve ser o peso real em Kg.
      quantidade: resolveQuantidadeKg(row.pits_peso, row.pits_qtde),
      quantidade_kg: resolveQuantidadeKg(row.pits_peso, row.pits_qtde),
      peso: resolveQuantidadeKg(row.pits_peso),
      peso_kg: resolveQuantidadeKg(row.pits_peso),
      quantidade_embalagem: Number(row.pits_qtde || 0)
    }));

    res.json({
      ok: true,
      pedido: header,
      data: header,
      itens,
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

    const itens = rows.map((row) => ({
      ...row,
      quantidade: resolveQuantidadeKg(row.pits_peso, row.pits_qtde),
      quantidade_kg: resolveQuantidadeKg(row.pits_peso, row.pits_qtde),
      peso: resolveQuantidadeKg(row.pits_peso),
      peso_kg: resolveQuantidadeKg(row.pits_peso),
      quantidade_embalagem: Number(row.pits_qtde || 0)
    }));

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
      itens,
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
    const tipoLote = normalizeProductionTipo(body.tipo_lote || body.tipo || body.productType || body.product_type || body.linha_produto || body.linha, produtoNome, produtoCodigo);
    const linhaProduto = String(body.linha_produto || body.linha || body.product_type || tipoLote).trim();
    const prioridade = String(body.prioridade || body.urgencia || 'normal').trim();
    const setorAtual = String(body.setor_atual || body.setor || 'moagem').trim();
    const status = String(body.status || 'aguardando').trim();
    const quantidade = resolveQuantidadeKg(
      body.peso,
      body.pits_peso,
      body.peso_kg,
      body.quantidade_kg,
      body.kg,
      body.quantidade,
      body.pits_qtde,
      body.qtd
    );

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
          ff_history: lote.ff_history || null,
          ff_sectorMetrics: lote.ff_sectorMetrics || null
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
// PRODUÇÃO - ROTA ULTRA LEVE PARA ABERTURA DO FACTORYFLOW
// =========================
// Usada pelo Kanban no carregamento inicial.
// Não faz COUNT, JOIN, SELECT *, histórico, rotas ou processamento pesado em JS.
// IMPORTANTE: manter esta rota ANTES de /api/producao/:id.
app.get('/api/producao/ativos', async (req, res) => {
  try {
    const limit = Math.min(Math.max(toPositiveInt(req.query.limit, 300), 1), 500);

    const [rows] = await dbPool.query(
      `
        SELECT
          pl.id,
          pl.op,
          pl.numero_pedido,
          pl.cliente_codigo,
          pl.cliente_nome,
          pl.produto_codigo,
          pl.produto_nome,
          COALESCE(NULLIF(pl.quantidade, 0), erp.pits_peso, erp.pits_qtde, 0) AS quantidade,
          erp.pits_qtde,
          erp.pits_peso,
          COALESCE(fpd.data_entrega, erp.pits_previsao) AS pits_previsao,
          COALESCE(fpd.data_entrega, erp.pits_previsao) AS deliveryDate,
          COALESCE(fpd.data_entrega, erp.pits_previsao) AS previsao_entrega,
          COALESCE(fpd.data_entrega, erp.pits_previsao) AS data_entrega,
          fpd.data_entrega AS data_entrega_override,
          COALESCE(NULLIF(TRIM(pl.cliente_endereco), ''), c.cli_endereco, '') AS cliente_endereco,
          COALESCE(NULLIF(TRIM(pl.cliente_bairro), ''), c.cli_bairro, '') AS cliente_bairro,
          COALESCE(NULLIF(TRIM(pl.cliente_cidade), ''), c.cli_cidade, '') AS cliente_cidade,
          COALESCE(NULLIF(TRIM(pl.cliente_cep), ''), c.cli_cep, '') AS cliente_cep,
          COALESCE(NULLIF(TRIM(pl.cliente_estado), ''), c.cli_estado, '') AS cliente_estado,
          pl.tipo_lote,
          pl.prioridade,
          pl.setor_atual,
          pl.status,
          pl.linha_produto,
          pl.ff_lotStatus,
          pl.ff_sectorEnteredAt,
          pl.ff_workSessions,
          pl.ff_expedientePausedStatus,
          pl.ff_history,
          pl.ff_sectorMetrics,
          pl.data_criacao,
          pl.updated_at
        FROM producao_lotes pl
        LEFT JOIN (
          SELECT
            TRIM(pits_op) AS pits_op,
            MAX(pits_previsao) AS pits_previsao,
            MAX(COALESCE(pits_peso, 0)) AS pits_peso,
            MAX(COALESCE(pits_qtde, 0)) AS pits_qtde
          FROM cli_pedidos_itens
          WHERE pits_op IS NOT NULL AND TRIM(pits_op) <> ''
          GROUP BY TRIM(pits_op)
        ) erp
          ON TRIM(erp.pits_op) = TRIM(pl.op)
        LEFT JOIN ff_pedidos_datas fpd
          ON TRIM(fpd.pedido) = TRIM(pl.numero_pedido)
        LEFT JOIN cli_clientes c
          ON CAST(TRIM(c.cli_codigo) AS UNSIGNED) = CAST(TRIM(pl.cliente_codigo) AS UNSIGNED)
        WHERE
          LOWER(COALESCE(pl.status, '')) NOT IN ('entregue', 'finalizado', 'cancelado')
          AND LOWER(COALESCE(pl.setor_atual, '')) NOT IN ('entregue', 'finalizado', 'cancelado')
        ORDER BY
          (LOWER(COALESCE(pl.status,'')) = 'rejeitado' OR LOWER(COALESCE(pl.ff_lotStatus,'')) = 'rejected') ASC,
          pl.id DESC
        LIMIT ?
      `,
      [limit]
    );

    return res.json({
      ok: true,
      total: rows.length,
      limit,
      mode: 'fast',
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/producao/ativos erro:', err.message);
    return sendError(res, 500, 'Erro ao buscar lotes ativos de produção', err.message);
  }
});


app.get('/api/producao/metricas/codigo/:codigo', async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim();
    const setor = String(req.query.setor || '').trim().toLowerCase();
    const limit = Math.min(Math.max(toPositiveInt(req.query.limit, 200), 1), 1000);

    if (!codigo) return sendError(res, 400, 'Informe o código do produto');

    const [rows] = await dbPool.query(
      `
        SELECT
          id,
          op,
          produto_codigo,
          produto_nome,
          ff_sectorMetrics,
          ff_workSessions,
          ff_history
        FROM producao_lotes
        WHERE TRIM(produto_codigo) = TRIM(?)
        ORDER BY id DESC
        LIMIT ?
      `,
      [codigo, limit]
    );

    const normalize = (v) => String(v || '')
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const parseArr = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
      }
      return [];
    };

    const metrics = [];
    for (const row of rows) {
      const arr = parseArr(row.ff_sectorMetrics);
      for (const m of arr) {
        if (setor && normalize(m.sector) !== normalize(setor)) continue;
        if (Number(m.workedMs || 0) <= 0 && Number(m.totalMs || 0) <= 0) continue;
        metrics.push({
          ...m,
          op: m.op || row.op,
          produto_codigo: row.produto_codigo,
          produto_nome: row.produto_nome
        });
      }
    }

    if (!metrics.length) {
      return res.json({
        ok: true,
        data: {
          codigo,
          setor: setor || null,
          count: 0,
          avgTotalMs: 0,
          avgWorkedMs: 0,
          avgPausedMs: 0,
          avgIdleMs: 0,
          samples: []
        }
      });
    }

    const sum = metrics.reduce((acc, m) => {
      acc.totalMs += Number(m.totalMs || 0);
      acc.workedMs += Number(m.workedMs || 0);
      acc.pausedMs += Number(m.pausedMs || 0);
      acc.idleMs += Number(m.idleMs || 0);
      return acc;
    }, { totalMs: 0, workedMs: 0, pausedMs: 0, idleMs: 0 });

    return res.json({
      ok: true,
      data: {
        codigo,
        setor: setor || null,
        count: metrics.length,
        avgTotalMs: sum.totalMs / metrics.length,
        avgWorkedMs: sum.workedMs / metrics.length,
        avgPausedMs: sum.pausedMs / metrics.length,
        avgIdleMs: sum.idleMs / metrics.length,
        samples: metrics.slice(-20)
      }
    });
  } catch (err) {
    console.error('GET /api/producao/metricas/codigo/:codigo erro:', err.message);
    return sendError(res, 500, 'Erro ao buscar métricas por código', err.message);
  }
});

app.get('/api/producao/historico', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(res, 404, 'Tabela producao_lotes nÃ£o encontrada');
    }

    const page = Math.max(toPositiveInt(req.query.page, 1), 1);
    const limit = Math.min(Math.max(toPositiveInt(req.query.limit, 100), 1), 500);
    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];

    if (req.query.inicio) {
      conditions.push('DATE(pl.data_criacao) >= ?');
      params.push(String(req.query.inicio).slice(0, 10));
    }
    if (req.query.fim) {
      conditions.push('DATE(pl.data_criacao) <= ?');
      params.push(String(req.query.fim).slice(0, 10));
    }
    if (req.query.status) {
      conditions.push("LOWER(COALESCE(pl.status, '')) = LOWER(?)");
      params.push(String(req.query.status));
    }
    if (req.query.setor) {
      conditions.push("LOWER(COALESCE(pl.setor_atual, '')) = LOWER(?)");
      params.push(String(req.query.setor));
    }
    if (req.query.op) {
      conditions.push('TRIM(pl.op) = TRIM(?)');
      params.push(String(req.query.op));
    }
    if (req.query.pedido) {
      conditions.push('TRIM(pl.numero_pedido) = TRIM(?)');
      params.push(String(req.query.pedido));
    }
    if (req.query.cliente) {
      conditions.push('pl.cliente_nome LIKE ?');
      params.push(`%${String(req.query.cliente)}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [[{ total }]] = await dbPool.query(
      `SELECT COUNT(*) AS total FROM producao_lotes pl ${where}`,
      params
    );

    const [rows] = await dbPool.query(
      `
        SELECT
          pl.id,
          pl.op,
          pl.numero_pedido,
          pl.produto_codigo,
          pl.produto_nome,
          pl.cliente_nome,
          pl.quantidade,
          pl.setor_atual,
          pl.status,
          pl.linha_produto,
          pl.tipo_lote,
          pl.prioridade,
          pl.data_criacao,
          pl.updated_at
        FROM producao_lotes pl
        ${where}
        ORDER BY pl.updated_at DESC, pl.data_criacao DESC, pl.id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({
      ok: true,
      page,
      limit,
      offset,
      total: Number(total || 0),
      total_pages: Math.ceil(Number(total || 0) / limit),
      data: rows,
    });
  } catch (err) {
    console.error('GET /api/producao/historico erro:', err.message);
    sendError(res, 500, 'Erro ao buscar histÃ³rico de produÃ§Ã£o', err.message);
  }
});

app.get('/api/producao/metricas', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(res, 404, 'Tabela producao_lotes nÃ£o encontrada');
    }

    const conditions = [];
    const params = [];
    if (req.query.inicio) {
      conditions.push('DATE(data_criacao) >= ?');
      params.push(String(req.query.inicio).slice(0, 10));
    }
    if (req.query.fim) {
      conditions.push('DATE(data_criacao) <= ?');
      params.push(String(req.query.fim).slice(0, 10));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [[summary]] = await dbPool.query(
      `
        SELECT
          COUNT(*) AS total_lotes,
          COALESCE(SUM(COALESCE(quantidade, 0)), 0) AS total_kg,
          SUM(CASE WHEN LOWER(COALESCE(status, '')) = 'entregue'
                    OR LOWER(COALESCE(setor_atual, '')) = 'entregue' THEN 1 ELSE 0 END) AS lotes_entregues,
          SUM(CASE WHEN LOWER(COALESCE(status, '')) = 'finalizado'
                    OR LOWER(COALESCE(setor_atual, '')) = 'finalizado' THEN 1 ELSE 0 END) AS lotes_finalizados,
          AVG(CASE
                WHEN data_criacao IS NOT NULL AND updated_at IS NOT NULL
                  THEN TIMESTAMPDIFF(SECOND, data_criacao, updated_at)
                ELSE NULL
              END) AS tempo_medio_producao_segundos
        FROM producao_lotes
        ${where}
      `,
      params
    );

    const [statusRows] = await dbPool.query(
      `
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'sem_status') AS status, COUNT(*) AS total
        FROM producao_lotes
        ${where}
        GROUP BY COALESCE(NULLIF(TRIM(status), ''), 'sem_status')
        ORDER BY total DESC
      `,
      params
    );

    const [setorRows] = await dbPool.query(
      `
        SELECT COALESCE(NULLIF(TRIM(setor_atual), ''), 'sem_setor') AS setor, COUNT(*) AS total
        FROM producao_lotes
        ${where}
        GROUP BY COALESCE(NULLIF(TRIM(setor_atual), ''), 'sem_setor')
        ORDER BY total DESC
      `,
      params
    );

    const [linhaRows] = await dbPool.query(
      `
        SELECT COALESCE(NULLIF(TRIM(linha_produto), ''), 'sem_linha') AS linha_produto,
               COALESCE(SUM(COALESCE(quantidade, 0)), 0) AS kg
        FROM producao_lotes
        ${where}
        GROUP BY COALESCE(NULLIF(TRIM(linha_produto), ''), 'sem_linha')
        ORDER BY kg DESC
      `,
      params
    );

    res.json({
      ok: true,
      inicio: req.query.inicio || null,
      fim: req.query.fim || null,
      total_lotes: Number(summary.total_lotes || 0),
      total_kg: Number(summary.total_kg || 0),
      lotes_por_status: statusRows.map(r => ({ status: r.status, total: Number(r.total || 0) })),
      lotes_por_setor: setorRows.map(r => ({ setor: r.setor, total: Number(r.total || 0) })),
      kg_por_linha_produto: linhaRows.map(r => ({ linha_produto: r.linha_produto, kg: Number(r.kg || 0) })),
      lotes_entregues: Number(summary.lotes_entregues || 0),
      lotes_finalizados: Number(summary.lotes_finalizados || 0),
      tempo_medio_producao: summary.tempo_medio_producao_segundos == null
        ? null
        : Number(summary.tempo_medio_producao_segundos),
    });
  } catch (err) {
    console.error('GET /api/producao/metricas erro:', err.message);
    sendError(res, 500, 'Erro ao calcular mÃ©tricas de produÃ§Ã£o', err.message);
  }
});


// =========================
// PRODUÇÃO - RELATÓRIO DE TEMPOS
// =========================
// Usada exclusivamente pela aba "Relatório de Tempos" do frontend.
// Não altera Kanban, não mexe no fluxo de avanço e carrega somente sob demanda.
// IMPORTANTE: manter antes de /api/producao/:id.
app.get('/api/producao/relatorio-tempos', async (req, res) => {
  try {
    const hasProducaoLotes = await tableExists('producao_lotes');
    if (!hasProducaoLotes) {
      return sendError(res, 404, 'Tabela producao_lotes não encontrada');
    }

    const limit = Math.min(Math.max(toPositiveInt(req.query.limit, 500), 1), 10000);
    const offset = toPositiveInt(req.query.offset, 0);

    const codigoRaw = String(req.query.codigos || req.query.codigo || '').trim();
    const codigos = codigoRaw.split(/[;,\n\s]+/).map(v => v.trim()).filter(Boolean);
    const produto = String(req.query.produto || '').trim();
    const opRaw = String(req.query.op || req.query.lote || '').trim();
    const ops = opRaw ? opRaw.split(/[;,]+/).map(v => v.trim()).filter(Boolean) : [];
    const op = ops.join(';'); // mantido para compatibilidade com hasAnyUserFilter
    const pedido = String(req.query.pedido || req.query.numero_pedido || '').trim();
    const cliente = String(req.query.cliente || '').trim();
    const setor = String(req.query.setor || '').trim();
    const inicio = String(req.query.inicio || '').slice(0, 10);
    const fim = String(req.query.fim || '').slice(0, 10);

    const conditions = [];
    const params = [];

    if (codigos.length) {
      conditions.push(`(${codigos.map(() => 'TRIM(produto_codigo) LIKE ?').join(' OR ')})`);
      for (const codigo of codigos) params.push(`${codigo}%`);
    }
    if (produto) { conditions.push('produto_nome LIKE ?'); params.push(`%${produto}%`); }
    if (ops.length === 1) {
      conditions.push('TRIM(op) = TRIM(?)');
      params.push(ops[0]);
    } else if (ops.length > 1) {
      conditions.push(`(${ops.map(() => 'TRIM(op) = TRIM(?)').join(' OR ')})`);
      for (const o of ops) params.push(o);
    }
    if (pedido) { conditions.push('TRIM(numero_pedido) = TRIM(?)'); params.push(pedido); }
    if (cliente) { conditions.push('cliente_nome LIKE ?'); params.push(`%${cliente}%`); }
    if (setor) {
      conditions.push('(setor_atual LIKE ? OR ff_sectorMetrics LIKE ? OR ff_history LIKE ?)');
      params.push(`%${setor}%`, `%${setor}%`, `%${setor}%`);
    }
    if (inicio) { conditions.push('DATE(COALESCE(updated_at, data_criacao)) >= ?'); params.push(inicio); }
    if (fim) { conditions.push('DATE(COALESCE(updated_at, data_criacao)) <= ?'); params.push(fim); }

    const hasAnyUserFilter = Boolean(codigos.length || produto || op || pedido || cliente || setor || inicio || fim);
    if (!hasAnyUserFilter) {
      conditions.push('COALESCE(updated_at, data_criacao) >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [lotes] = await dbPool.query(
      `
        SELECT
          id,
          op,
          numero_pedido,
          produto_codigo,
          produto_nome,
          cliente_nome,
          quantidade,
          linha_produto,
          status,
          setor_atual,
          ff_lotStatus,
          ff_sectorEnteredAt,
          ff_workSessions,
          ff_history,
          ff_sectorMetrics,
          data_criacao,
          updated_at
        FROM producao_lotes
        ${where}
        ORDER BY COALESCE(updated_at, data_criacao) DESC, id DESC
        LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    const shiftClosedMap = await rtLoadShiftClosedIntervals();

    let data = [];
    for (const lote of lotes) data.push(...rtBuildTempoRowsFromLot(lote, setor, shiftClosedMap));

    if (inicio || fim) {
      const inicioMs = inicio ? rtToMs(`${inicio}T00:00:00-03:00`) : null;
      const fimMs = fim ? rtToMs(`${fim}T23:59:59-03:00`) : null;
      data = data.filter(row => {
        const ref = Number(row.enteredAt || 0);
        if (inicioMs && ref && ref < inicioMs) return false;
        if (fimMs && ref && ref > fimMs) return false;
        return true;
      });
    }

    const resumo = data.reduce((acc, row) => {
      acc.totalMs += Number(row.totalMs || 0);
      acc.workedMs += Number(row.workedMs || 0);
      acc.pausedMs += Number(row.pausedMs || 0);
      acc.idleMs += Number(row.idleMs || 0);
      return acc;
    }, { totalMs: 0, workedMs: 0, pausedMs: 0, idleMs: 0 });
    const efficiencyAvg = data.length ? Math.round(data.reduce((acc, row) => acc + Number(row.efficiency || 0), 0) / data.length) : 0;

    return res.json({
      ok: true,
      total: data.length,
      limit,
      offset,
      filtros: {
        codigo: req.query.codigo || null,
        codigos: req.query.codigos || null,
        produto: produto || null,
        op: op || null,
        pedido: pedido || null,
        cliente: cliente || null,
        setor: setor || null,
        inicio: inicio || null,
        fim: fim || null,
        default_ultimos_30_dias: !hasAnyUserFilter
      },
      resumo: {
        totalLinhas: data.length,
        totalMs: resumo.totalMs,
        workedMs: resumo.workedMs,
        pausedMs: resumo.pausedMs,
        idleMs: resumo.idleMs,
        efficiencyAvg
      },
      data
    });
  } catch (err) {
    console.error('GET /api/producao/relatorio-tempos erro:', err.message);
    return sendError(res, 500, 'Erro ao gerar relatório de tempos', err.message);
  }
});


// ===================================================
// PATCH INDUSCOLOR – REPROCESSAMENTO SEGURO DOS TEMPOS ANTIGOS
// Cole este bloco no server.js, de preferência logo depois da rota:
// GET /api/producao/relatorio-tempos
//
// Objetivo:
// - Recalcular ff_sectorMetrics a partir de ff_history + ff_sector_shift_events.
// - Corrigir métricas antigas que ficaram contando com expediente fechado.
// - Rodar primeiro em DRY RUN, sem alterar banco.
// - Quando aplicar, cria backup em ff_backup_reprocessamento_tempos.
//
// Rotas:
// POST /api/admin/reprocessar-tempos?dryRun=1
// POST /api/admin/reprocessar-tempos
//
// Body exemplos:
// { "op": "088079", "apply": false }
// { "days": 120, "limit": 5000, "apply": true }
// ===================================================

function ffAdminParseBool(value) {
  return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true' || String(value || '').toLowerCase() === 'sim';
}

function ffAdminNumber(value, fallback, max = 10000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function ffAdminSafeJsonString(value) {
  try {
    return JSON.stringify(value ?? []);
  } catch (_) {
    return '[]';
  }
}

function ffAdminTempoRowsToSectorMetrics(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && row.setor)
    .filter(row => !['pronto', 'entrega', 'entregue', 'finalizado', 'cancelado', 'rejeitado'].includes(rtNormalizeText(row.setor)))
    .map(row => {
      const totalMs = Math.max(0, Number(row.totalMs || 0));
      const workedMs = Math.min(Math.max(0, Number(row.workedMs || 0)), totalMs);
      const pausedMs = Math.min(Math.max(0, Number(row.pausedMs || 0)), Math.max(0, totalMs - workedMs));
      const idleMs = Math.max(0, totalMs - workedMs - pausedMs);

      return {
        sector: row.setor,
        sectorLabel: row.setor_nome || rtDisplaySector(row.setor),
        enteredAt: row.enteredAt || null,
        leftAt: row.leftAt || null,
        totalMs,
        workedMs,
        pausedMs,
        idleMs,
        efficiency: totalMs > 0 ? Math.min(100, Math.round((workedMs / totalMs) * 100)) : 0,
        status: row.status || (row.leftAt ? 'Finalizado' : 'Em andamento'),
        source: 'reprocessado_backend_ff_history_expediente',
        recalculatedAt: Date.now()
      };
    });
}

async function ffAdminEnsureTempoBackupTable() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS ff_backup_reprocessamento_tempos (
      backup_id INT AUTO_INCREMENT PRIMARY KEY,
      batch_id VARCHAR(80) NOT NULL,
      backup_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      lote_id INT NULL,
      op VARCHAR(40) NULL,
      numero_pedido VARCHAR(40) NULL,
      setor_atual VARCHAR(80) NULL,
      status VARCHAR(80) NULL,
      old_ff_sectorMetrics LONGTEXT NULL,
      old_ff_workSessions LONGTEXT NULL,
      old_ff_history LONGTEXT NULL,
      old_ff_sectorEnteredAt BIGINT NULL,
      old_updated_at DATETIME NULL,
      INDEX idx_ff_bkp_reproc_batch (batch_id),
      INDEX idx_ff_bkp_reproc_op (op),
      INDEX idx_ff_bkp_reproc_lote (lote_id)
    )
  `);
}

app.post('/api/admin/reprocessar-tempos', async (req, res) => {
  try {
    await ensureProductionLotesTimeColumns();
    await ensureSectorShiftTable();
    await ensureSectorShiftEventsTable();

    const apply = ffAdminParseBool(req.body?.apply) || ffAdminParseBool(req.query?.apply);
    const dryRun = !apply || ffAdminParseBool(req.query?.dryRun);

    const op = String(req.body?.op || req.query?.op || '').trim();
    const pedido = String(req.body?.pedido || req.query?.pedido || '').trim();
    const setor = String(req.body?.setor || req.query?.setor || '').trim();

    const days = ffAdminNumber(req.body?.days || req.query?.days, 180, 3650);
    const limit = ffAdminNumber(req.body?.limit || req.query?.limit, 5000, 20000);

    const conditions = [];
    const params = [];

    // Só reprocessa lotes que têm histórico. Sem ff_history confiável,
    // não existe linha do tempo suficiente para recalcular com segurança.
    conditions.push(`ff_history IS NOT NULL`);
    conditions.push(`TRIM(ff_history) <> ''`);
    conditions.push(`TRIM(ff_history) <> '[]'`);

    if (op) {
      conditions.push(`TRIM(op) = TRIM(?)`);
      params.push(op);
    }

    if (pedido) {
      conditions.push(`TRIM(numero_pedido) = TRIM(?)`);
      params.push(pedido);
    }

    if (setor) {
      conditions.push(`(setor_atual LIKE ? OR ff_history LIKE ? OR ff_sectorMetrics LIKE ?)`);
      params.push(`%${setor}%`, `%${setor}%`, `%${setor}%`);
    }

    if (!op && !pedido) {
      conditions.push(`COALESCE(updated_at, data_criacao) >= DATE_SUB(NOW(), INTERVAL ? DAY)`);
      params.push(days);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [lotes] = await dbPool.query(
      `
        SELECT
          id,
          op,
          numero_pedido,
          produto_codigo,
          produto_nome,
          cliente_nome,
          quantidade,
          linha_produto,
          status,
          setor_atual,
          ff_lotStatus,
          ff_sectorEnteredAt,
          ff_workSessions,
          ff_history,
          ff_sectorMetrics,
          data_criacao,
          updated_at
        FROM producao_lotes
        ${where}
        ORDER BY COALESCE(updated_at, data_criacao) DESC, id DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    const shiftClosedMap = await rtLoadShiftClosedIntervals();
    const batchId = `reproc_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`;

    if (apply) {
      await ffAdminEnsureTempoBackupTable();
    }

    const report = [];
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const lote of lotes || []) {
      try {
        const rows = rtBuildTempoRowsFromLot(lote, '', shiftClosedMap);
        const metrics = ffAdminTempoRowsToSectorMetrics(rows);

        if (!metrics.length) {
          skipped++;
          report.push({
            id: lote.id,
            op: lote.op,
            status: 'ignorado',
            motivo: 'Sem métricas recalculáveis a partir do histórico'
          });
          continue;
        }

        const oldMetricsRaw = lote.ff_sectorMetrics || '[]';
        const newMetricsRaw = ffAdminSafeJsonString(metrics);

        const oldTotal = rtArray(oldMetricsRaw).reduce((sum, m) => sum + Math.max(0, Number(m?.totalMs || m?.total || 0)), 0);
        const newTotal = metrics.reduce((sum, m) => sum + Math.max(0, Number(m.totalMs || 0)), 0);
        const diffMs = newTotal - oldTotal;

        report.push({
          id: lote.id,
          op: lote.op,
          pedido: lote.numero_pedido,
          setor_atual: lote.setor_atual,
          linhas: metrics.length,
          total_antigo_ms: oldTotal,
          total_novo_ms: newTotal,
          diferenca_ms: diffMs,
          total_antigo_horas: Number((oldTotal / 3600000).toFixed(2)),
          total_novo_horas: Number((newTotal / 3600000).toFixed(2)),
          diferenca_horas: Number((diffMs / 3600000).toFixed(2)),
          status: dryRun ? 'simulado' : 'atualizado'
        });

        if (!dryRun) {
          await dbPool.query(
            `
              INSERT INTO ff_backup_reprocessamento_tempos
                (
                  batch_id,
                  lote_id,
                  op,
                  numero_pedido,
                  setor_atual,
                  status,
                  old_ff_sectorMetrics,
                  old_ff_workSessions,
                  old_ff_history,
                  old_ff_sectorEnteredAt,
                  old_updated_at
                )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              batchId,
              lote.id,
              lote.op || null,
              lote.numero_pedido || null,
              lote.setor_atual || null,
              lote.status || null,
              lote.ff_sectorMetrics || null,
              lote.ff_workSessions || null,
              lote.ff_history || null,
              lote.ff_sectorEnteredAt || null,
              lote.updated_at || null
            ]
          );

          await dbPool.query(
            `
              UPDATE producao_lotes
              SET ff_sectorMetrics = ?
              WHERE id = ?
              LIMIT 1
            `,
            [newMetricsRaw, lote.id]
          );

          updated++;
        }

      } catch (err) {
        errors++;
        report.push({
          id: lote.id,
          op: lote.op,
          status: 'erro',
          erro: err.message
        });
      }
    }

    return res.json({
      ok: true,
      modo: dryRun ? 'DRY_RUN_SEM_ALTERAR_BANCO' : 'APLICADO_NO_BANCO',
      batchId: dryRun ? null : batchId,
      filtros: {
        op: op || null,
        pedido: pedido || null,
        setor: setor || null,
        days: (!op && !pedido) ? days : null,
        limit
      },
      totais: {
        encontrados: lotes.length,
        atualizados: dryRun ? 0 : updated,
        simulados: dryRun ? report.filter(r => r.status === 'simulado').length : 0,
        ignorados: skipped,
        erros: errors
      },
      amostra: report.slice(0, 50),
      aviso: dryRun
        ? 'Nada foi alterado. Para aplicar, envie apply:true no body ou ?apply=1.'
        : 'Banco atualizado. Backup salvo em ff_backup_reprocessamento_tempos usando o batchId retornado.'
    });

  } catch (err) {
    console.error('POST /api/admin/reprocessar-tempos erro:', err);
    return sendError(res, 500, 'Erro ao reprocessar tempos antigos', err.message);
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
      const setores = String(setor).split(',').map((s) => s.trim()).filter(Boolean);
      if (setores.length > 1) {
        conditions.push(`setor_atual IN (${setores.map(() => '?').join(',')})`);
        params.push(...setores);
      } else {
        conditions.push('setor_atual = ?');
        params.push(setores[0] || setor);
      }
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
            fpd.data_entrega,
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS pits_previsao,

          COALESCE(
            fpd.data_entrega,
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS previsao_entrega,

          COALESCE(
            fpd.data_entrega,
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS deliveryDate,

          COALESCE(
            fpd.data_entrega,
            pi_op.pits_previsao,
            pi_pedido.pits_previsao
          ) AS data_entrega,

          fpd.data_entrega AS data_entrega_override,

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

        LEFT JOIN ff_pedidos_datas fpd
          ON TRIM(fpd.pedido) = TRIM(pl.numero_pedido)

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
      deliveryDate: row.deliveryDate || row.pits_previsao || row.previsao_entrega || null,
      delivery_date: row.deliveryDate || row.pits_previsao || row.previsao_entrega || null,
      data_entrega: row.data_entrega || row.deliveryDate || row.pits_previsao || row.previsao_entrega || null,
      deliveryDateManual: row.data_entrega_override || null,

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
      'ff_history',
      'ff_sectorMetrics'
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

// Trava por setor em memória: evita que dois toggles quase simultâneos (duplo clique,
// duas abas, F5+clique) leiam o mesmo estado "anterior" antes de qualquer um gravar,
// o que duplicaria eventos em ff_sector_shift_events. Sem isso, a checagem unchanged/wasOpen
// abaixo tem uma janela de corrida porque as queries não estão em transação.
const ffExpedienteToggleLocks = new Set();

app.get('/api/expediente', async (req, res) => {
  try {
    await ensureSectorShiftTable();
    await ensureSectorShiftEventsTable();
    await ensurePedidoDatasTable();

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

    res.json({ ok: true, total: rows.length, data: rows.map(ffFixShiftRowDates) });
  } catch (err) {
    console.error('GET /api/expediente erro:', err.message);
    sendError(res, 500, 'Erro ao buscar expediente dos setores', err.message);
  }
});

app.get('/api/expediente/:setor', async (req, res) => {
  try {
    await ensureSectorShiftTable();
    await ensureSectorShiftEventsTable();
    await ensurePedidoDatasTable();

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

      return res.json({ ok: true, data: ffFixShiftRowDates(created[0]) });
    }

    res.json({ ok: true, data: ffFixShiftRowDates(rows[0]) });
  } catch (err) {
    console.error('GET /api/expediente/:setor erro:', err.message);
    sendError(res, 500, 'Erro ao buscar expediente do setor', err.message);
  }
});

app.post('/api/expediente/toggle', async (req, res) => {
  try {
    await ensureSectorShiftTable();
    await ensureSectorShiftEventsTable();
    await ensurePedidoDatasTable();

    const setor = normalizeShiftSetor(req.body?.setor);
    const aberto = Number(req.body?.expediente_aberto) === 1 || req.body?.expediente_aberto === true;

    if (!setor) return sendError(res, 400, 'Setor obrigatório');

    if (ffExpedienteToggleLocks.has(setor)) {
      return sendError(res, 409, 'Já existe uma alteração de expediente em andamento para este setor. Aguarde um instante.');
    }
    ffExpedienteToggleLocks.add(setor);

    try {
    // Proteção contra clique duplicado/tela desatualizada:
    // se o setor já está no estado solicitado, não grava novo evento e não reseta iniciado_em/finalizado_em.
    const [beforeRows] = await dbPool.query(
      `SELECT * FROM ff_sector_shifts WHERE setor = ? LIMIT 1`,
      [setor]
    );

    const previous = beforeRows[0] || null;
    const wasOpen = previous ? Number(previous.expediente_aberto || 0) === 1 : null;

    if (previous && wasOpen === aberto) {
      return res.json({ ok: true, unchanged: true, data: ffFixShiftRowDates(previous) });
    }

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

    await dbPool.query(
      `INSERT INTO ff_sector_shift_events (setor, event_type, created_by) VALUES (?, ?, ?)`,
      [setor, aberto ? 'aberto' : 'fechado', req.user?.name || req.user?.email || req.authType || null]
    );

    const [rows] = await dbPool.query(
      `SELECT * FROM ff_sector_shifts WHERE setor = ? LIMIT 1`,
      [setor]
    );

    res.json({ ok: true, unchanged: false, data: ffFixShiftRowDates(rows[0]) });
    } finally {
      ffExpedienteToggleLocks.delete(setor);
    }
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
    await ensureSectorShiftEventsTable();
    await ensurePedidoDatasTable();
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
      console.log('   PATCH /api/pedidos/:numero/data-entrega');
      console.log('   GET  /api/ops');
      console.log('   GET  /api/ops/:op');
      console.log('   GET  /api/producao');
      console.log('   GET  /api/producao/relatorio-tempos');
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
      if (!JWT_SECRET) {
        console.log('⚠️  Segurança: JWT_SECRET não configurado. Logins via JWT central serão rejeitados até a variável ser definida.\n');
      }
    });

    startSync();
  } catch (err) {
    console.error('\n💥 Falha na inicialização:', err.message);
    process.exit(1);
  }
})();
