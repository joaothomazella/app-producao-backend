'use strict';

const mysql = require('mysql2/promise');

const dbPool = mysql.createPool({
  host: 'db.induscolor.com.br',
  port: 3306,
  database: 'induscolor_sistema',
  user: 'induscolor',
  password: 'Adxcb$332#21xVc%',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

async function testConnection() {
  try {
    const conn = await dbPool.getConnection();
    console.log('✅ Banco conectado → db.induscolor.com.br');
    conn.release();
  } catch (err) {
    console.error('❌ Falha ao conectar banco:', err.message);
    throw err;
  }
}

module.exports = { dbPool, testConnection };