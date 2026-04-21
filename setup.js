'use strict';

require('dotenv').config();
const { dbPool } = require('./db');

async function setup() {
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS producao_lotes (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        numero_pedido VARCHAR(50) NOT NULL,
        op VARCHAR(50) NOT NULL,
        produto_codigo VARCHAR(100) NOT NULL DEFAULT '',
        produto_nome VARCHAR(255) NOT NULL DEFAULT '',
        quantidade DECIMAL(15,4) NOT NULL DEFAULT 0,
        cliente_codigo VARCHAR(50) NOT NULL DEFAULT '',
        cliente_nome VARCHAR(255) NOT NULL DEFAULT '',
        cliente_endereco VARCHAR(255) NOT NULL DEFAULT '',
        cliente_bairro VARCHAR(100) NOT NULL DEFAULT '',
        cliente_cidade VARCHAR(100) NOT NULL DEFAULT '',
        cliente_cep VARCHAR(20) NOT NULL DEFAULT '',
        cliente_estado VARCHAR(2) NOT NULL DEFAULT '',
        status VARCHAR(50) NOT NULL DEFAULT 'aguardando',
        setor_atual VARCHAR(50) NOT NULL DEFAULT 'moagem',
        data_criacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pedido_op (numero_pedido, op)
      );
    `);

    console.log('✅ Tabela producao_lotes criada (ou já existia).');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro ao criar tabela:', err.message);
    process.exit(1);
  }
}

setup();