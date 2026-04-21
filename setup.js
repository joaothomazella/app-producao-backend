// =============================================
// SETUP.JS – Cria a tabela producao_lotes
// no banco LOCAL caso não exista ainda.
// Execute uma vez: node setup.js
// =============================================

'use strict';

require('dotenv').config();
const { localPool } = require('./db');

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS producao_lotes (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,

  -- chave natural de unicidade (pedido + OP)
  numero_pedido    VARCHAR(50)     NOT NULL,
  op               VARCHAR(50)     NOT NULL,

  -- produto
  produto_codigo   VARCHAR(100)    NOT NULL DEFAULT '',
  produto_nome     VARCHAR(255)    NOT NULL DEFAULT '',
  quantidade       DECIMAL(15, 4)  NOT NULL DEFAULT 0,

  -- cliente (denormalizado para leitura rápida)
  cliente_codigo   VARCHAR(50)     NOT NULL DEFAULT '',
  cliente_nome     VARCHAR(255)    NOT NULL DEFAULT '',
  cliente_endereco VARCHAR(255)    NOT NULL DEFAULT '',
  cliente_bairro   VARCHAR(100)    NOT NULL DEFAULT '',
  cliente_cidade   VARCHAR(100)    NOT NULL DEFAULT '',
  cliente_cep      VARCHAR(20)     NOT NULL DEFAULT '',
  cliente_estado   VARCHAR(2)      NOT NULL DEFAULT '',

  -- controle de produção
  status           VARCHAR(50)     NOT NULL DEFAULT 'aguardando',
  setor_atual      VARCHAR(50)     NOT NULL DEFAULT 'moagem',
  data_criacao     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_pedido_op (numero_pedido, op),
  INDEX idx_status       (status),
  INDEX idx_setor        (setor_atual),
  INDEX idx_data         (data_criacao)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

(async () => {
  try {
    const conn = await localPool.getConnection();
    await conn.query(CREATE_TABLE);
    conn.release();
    console.log('✅  Tabela producao_lotes criada (ou já existia).');
    process.exit(0);
  } catch (err) {
    console.error('❌  Erro ao criar tabela:', err.message);
    process.exit(1);
  }
})();
