const mysql = require('mysql2/promise');

async function test() {
  try {
    const conn = await mysql.createConnection({
      host: 'db.induscolor.com.br',
      port: 3306,
      database: 'induscolor_sistema',
      user: 'induscolor',
      password: 'Adxcb$332#21xVc%',
    });

    console.log('✅ CONECTOU NO FACTORYFLOW');
    await conn.end();
  } catch (err) {
    console.error('❌ ERRO FACTORYFLOW:', err.message);
  }
}

test();