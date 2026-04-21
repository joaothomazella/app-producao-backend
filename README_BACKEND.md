# FactoryFlow – MySQL Bridge Backend

Backend Node.js que sincroniza automaticamente os pedidos do banco MySQL da empresa para a tabela local `producao_lotes`, expondo uma API REST para o frontend FactoryFlow consumir.

---

## 📁 Estrutura de arquivos

```
backend/
├── server.js          ← Ponto de entrada: Express API + inicialização
├── sync.js            ← Lógica de sincronização MySQL empresa → local
├── db.js              ← Pools de conexão (banco empresa + banco local)
├── setup.js           ← Cria a tabela producao_lotes (executar 1x)
├── package.json       ← Dependências npm
├── .env.example       ← Modelo de variáveis de ambiente
└── README_BACKEND.md  ← Este arquivo
```

---

## ⚙️ Requisitos

- **Node.js** v18 ou superior
- **npm** v9 ou superior
- Acesso TCP à porta 3306 do banco MySQL da empresa (`db.induscolor.com.br`)
- Um banco MySQL local (pode ser o mesmo servidor ou uma instância separada)

---

## 🚀 Instalação e execução

### 1. Instalar dependências

```bash
cd backend
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Abra o arquivo `.env` e preencha com as credenciais reais:

```env
# Banco da EMPRESA (origem dos pedidos)
EMPRESA_DB_HOST=db.induscolor.com.br
EMPRESA_DB_PORT=3306
EMPRESA_DB_NAME=induscolor_sistema
EMPRESA_DB_USER=induscolor
EMPRESA_DB_PASS=SUA_SENHA_AQUI        ← nunca comite a senha real!

# Banco LOCAL (onde producao_lotes será criada)
LOCAL_DB_HOST=localhost
LOCAL_DB_PORT=3306
LOCAL_DB_NAME=factoryflow
LOCAL_DB_USER=root
LOCAL_DB_PASS=sua_senha_local

# Servidor
PORT=3001
CORS_ORIGIN=*

# Intervalo de sync em ms (10000 = 10 segundos)
SYNC_INTERVAL_MS=10000
```

### 3. Criar a tabela local `producao_lotes`

Execute **uma única vez** para criar a tabela no banco local:

```bash
node setup.js
```

Saída esperada:
```
✅  Tabela producao_lotes criada (ou já existia).
```

### 4. Iniciar o servidor

**Modo produção:**
```bash
npm start
```

**Modo desenvolvimento** (auto-restart com nodemon):
```bash
npm run dev
```

Saída esperada no terminal:
```
╔══════════════════════════════════════════════╗
║   FactoryFlow  –  MySQL Bridge  v1.0.0      ║
╚══════════════════════════════════════════════╝

✅  Banco EMPRESA conectado  → db.induscolor.com.br
✅  Banco LOCAL conectado    → localhost

🚀  API rodando em http://localhost:3001
    GET  /api/producao         → lista lotes
    GET  /api/producao/:id     → detalhe do lote
    PATCH /api/producao/:id    → atualiza status/setor
    POST /api/sync/run         → sync manual
    GET  /api/sync/status      → estatísticas
    GET  /health               → health check

🔄  Sincronização iniciada  (intervalo: 10s)
```

---

## 🔗 Endpoints da API

### `GET /health`
Verifica se o servidor está rodando.

**Resposta:**
```json
{
  "ok": true,
  "service": "FactoryFlow MySQL Bridge",
  "version": "1.0.0",
  "timestamp": "2026-04-20T14:00:00.000Z",
  "sync": { "totalSyncs": 42, "totalInserted": 157, "intervalMs": 10000 }
}
```

---

### `GET /api/producao`
Retorna os lotes da tabela `producao_lotes`.

**Query params opcionais:**

| Parâmetro | Tipo   | Exemplo            | Descrição                           |
|-----------|--------|--------------------|-------------------------------------|
| `status`  | string | `aguardando`       | Filtra por status                   |
| `setor`   | string | `moagem`           | Filtra por setor_atual              |
| `search`  | string | `cliente+nome`     | Busca em cliente, produto, pedido   |
| `limit`   | number | `100`              | Máx registros (padrão 500, max 2000)|
| `offset`  | number | `0`                | Paginação (pula N registros)        |

**Resposta:**
```json
{
  "ok": true,
  "total": 243,
  "limit": 500,
  "offset": 0,
  "data": [
    {
      "id": 1,
      "numero_pedido": "10042",
      "op": "001",
      "produto_codigo": "TIN-001",
      "produto_nome": "Tinta Branca 18L",
      "quantidade": 50,
      "cliente_codigo": "C001",
      "cliente_nome": "Construtora ABC",
      "cliente_endereco": "Rua das Flores, 100",
      "cliente_bairro": "Centro",
      "cliente_cidade": "São Paulo",
      "cliente_cep": "01310-100",
      "cliente_estado": "SP",
      "status": "aguardando",
      "setor_atual": "moagem",
      "data_criacao": "2026-04-20T10:30:00.000Z",
      "updated_at": "2026-04-20T10:30:00.000Z"
    }
  ]
}
```

---

### `GET /api/producao/:id`
Retorna um único lote pelo ID numérico.

---

### `PATCH /api/producao/:id`
Atualiza o status e/ou setor de um lote.

**Body JSON:**
```json
{
  "status": "em_producao",
  "setor_atual": "producao"
}
```

**Valores válidos para `status`:** `aguardando`, `em_producao`, `pausado`, `concluido`, `rejeitado`

**Valores válidos para `setor_atual`:** `moagem`, `producao`, `coloracao`, `laboratorio`, `envase`, `expedicao`

---

### `GET /api/sync/status`
Retorna estatísticas da sincronização automática.

---

### `POST /api/sync/run`
Dispara uma sincronização manual imediata (sem esperar o intervalo de 10s).

---

## 🗄️ Estrutura da tabela `producao_lotes`

```sql
CREATE TABLE producao_lotes (
  id               INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  numero_pedido    VARCHAR(50)     NOT NULL,   -- chave única junto com op
  op               VARCHAR(50)     NOT NULL,   -- chave única junto com numero_pedido
  produto_codigo   VARCHAR(100)    NOT NULL DEFAULT '',
  produto_nome     VARCHAR(255)    NOT NULL DEFAULT '',
  quantidade       DECIMAL(15,4)  NOT NULL DEFAULT 0,
  cliente_codigo   VARCHAR(50)     NOT NULL DEFAULT '',
  cliente_nome     VARCHAR(255)    NOT NULL DEFAULT '',
  cliente_endereco VARCHAR(255)    NOT NULL DEFAULT '',
  cliente_bairro   VARCHAR(100)    NOT NULL DEFAULT '',
  cliente_cidade   VARCHAR(100)    NOT NULL DEFAULT '',
  cliente_cep      VARCHAR(20)     NOT NULL DEFAULT '',
  cliente_estado   VARCHAR(2)      NOT NULL DEFAULT '',
  status           VARCHAR(50)     NOT NULL DEFAULT 'aguardando',
  setor_atual      VARCHAR(50)     NOT NULL DEFAULT 'moagem',
  data_criacao     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pedido_op (numero_pedido, op)
);
```

---

## 🔄 Lógica de sincronização

A cada `SYNC_INTERVAL_MS` milissegundos (padrão: 10s), o backend executa:

```
1. Abre conexão com banco EMPRESA
2. Executa SELECT com JOIN:
   cli_pedidos_itens p
   INNER JOIN cli_clientes c ON c.cli_codigo = p.pits_cliente
3. Para cada linha retornada:
   a. Verifica em producao_lotes se (numero_pedido + op) já existe
   b. Se NÃO existe → INSERT com status='aguardando', setor='moagem'
   c. Se JÁ existe → ignora (não sobrescreve atualizações locais)
4. Loga apenas quando há inserções ou erros (sem spam no terminal)
```

**Registros já existentes não são atualizados** — isso garante que mudanças feitas no FactoryFlow (avanço de setor, rejeição, etc.) não são sobrescritas pela sincronização.

---

## 🔒 Segurança

- **Nunca comite o arquivo `.env`** com credenciais reais
- Adicione `.env` ao `.gitignore`:
  ```
  backend/.env
  ```
- Em produção, use variáveis de ambiente do sistema operacional ou de um gerenciador de secrets (ex: Docker secrets, PM2 env, Railway/Heroku config vars)
- A senha do MySQL nunca aparece em logs nem em respostas da API

---

## 🖥️ Execução em produção com PM2

[PM2](https://pm2.keymetrics.io/) é o gerenciador de processos recomendado para manter o backend rodando como serviço:

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Entrar na pasta backend
cd backend

# Iniciar o servidor
pm2 start server.js --name factoryflow-bridge

# Configurar para reiniciar automaticamente no boot
pm2 startup
pm2 save

# Ver logs em tempo real
pm2 logs factoryflow-bridge

# Ver status
pm2 status
```

---

## 🐳 Execução com Docker (opcional)

Crie um `Dockerfile` na pasta `backend/`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
```

```bash
# Build
docker build -t factoryflow-bridge .

# Run com variáveis de ambiente
docker run -d \
  --name factoryflow-bridge \
  -p 3001:3001 \
  -e EMPRESA_DB_HOST=db.induscolor.com.br \
  -e EMPRESA_DB_NAME=induscolor_sistema \
  -e EMPRESA_DB_USER=induscolor \
  -e EMPRESA_DB_PASS=SUA_SENHA \
  -e LOCAL_DB_HOST=localhost \
  -e LOCAL_DB_NAME=factoryflow \
  -e LOCAL_DB_USER=root \
  -e LOCAL_DB_PASS=SUA_SENHA_LOCAL \
  factoryflow-bridge
```

---

## 🔧 Conectar o frontend FactoryFlow

Após o backend estar rodando, configure o frontend para consumir a API em `http://localhost:3001/api/producao` (ou o IP/domínio do servidor onde o backend está hospedado).

No FactoryFlow, a integração será feita no arquivo `js/data.js` com chamadas do tipo:

```javascript
// Exemplo de busca dos lotes do banco MySQL via bridge
const response = await fetch('http://localhost:3001/api/producao?limit=500');
const { data } = await response.json();
```

---

## ❓ Solução de problemas

| Erro | Causa provável | Solução |
|------|---------------|---------|
| `ECONNREFUSED` | Banco inacessível | Verificar host, porta e firewall |
| `ER_ACCESS_DENIED` | Senha incorreta | Conferir `EMPRESA_DB_PASS` no `.env` |
| `ER_NO_SUCH_TABLE` | Tabela não existe | Executar `node setup.js` |
| `422 Unprocessable` | Parâmetros inválidos | Verificar query params da API |
| Porta 3001 em uso | Outro processo | Alterar `PORT=3002` no `.env` |

---

## 📦 Dependências

| Pacote | Versão | Uso |
|--------|--------|-----|
| `express` | ^4.19 | Servidor HTTP / API REST |
| `mysql2` | ^3.9 | Driver MySQL com suporte a Promises |
| `cors` | ^2.8 | Headers CORS para o frontend |
| `dotenv` | ^16.4 | Variáveis de ambiente do `.env` |
| `nodemon` | ^3.1 | Auto-restart em desenvolvimento (devDep) |

---

*FactoryFlow MySQL Bridge v1.0.0 — Abril 2026*
