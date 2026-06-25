'use strict';

require('dotenv').config();

const mysql = require('mysql2/promise');

const requiredEnvVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingEnvVars = requiredEnvVars.filter(name => !process.env[name]);

if (missingEnvVars.length) {
  throw new Error(
    `Configuração de banco incompleta. Defina as variáveis de ambiente: ${missingEnvVars.join(', ')}`
  );
}

const dbPool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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