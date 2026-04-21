// =============================================
// DB.JS – Pools de conexão MySQL
// Empresa (origem) + Local (producao_lotes)
// =============================================

'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

// ── Pool: banco da EMPRESA (leitura dos pedidos) ─────────
const empresaPool = mysql.createPool({
  host: 'db.induscolor.com.br',
  port: 3306,
  database: 'induscolor_sistema',
  user: 'induscolor',
  password: 'Adxcb$332#21xVc%',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});


// ── Pool: banco LOCAL (escrita de producao_lotes) ────────
const localPool = mysql.createPool({
  host:               process.env.LOCAL_DB_HOST     || 'localhost',
  port:               Number(process.env.LOCAL_DB_PORT) || 3306,
  database:           process.env.LOCAL_DB_NAME     || 'factoryflow',
  user:               process.env.LOCAL_DB_USER     || 'root',
  password:           process.env.LOCAL_DB_PASS     || '',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  connectTimeout:     10000,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

// ── Testa as duas conexões na inicialização ───────────────
async function testConnections() {
  try {
    const conn1 = await empresaPool.getConnection();
    console.log('✅  Banco EMPRESA conectado  →', process.env.EMPRESA_DB_HOST);
    conn1.release();
  } catch (err) {
    console.error('❌  Falha ao conectar banco EMPRESA:', err.message);
    throw err;
  }

  try {
    const conn2 = await localPool.getConnection();
    console.log('✅  Banco LOCAL conectado    →', process.env.LOCAL_DB_HOST || 'localhost');
    conn2.release();
  } catch (err) {
    console.error('❌  Falha ao conectar banco LOCAL:', err.message);
    throw err;
  }
}

module.exports = { empresaPool, localPool, testConnections };
