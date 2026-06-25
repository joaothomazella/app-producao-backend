require('dotenv').config();
const mysql = require('mysql2/promise');

async function test() {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

    console.log('✅ CONECTOU NO FACTORYFLOW');
    await conn.end();
  } catch (err) {
    console.error('❌ ERRO FACTORYFLOW:', err.message);
  }
}

test();