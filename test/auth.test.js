// Testes de integração: sobem a API de verdade (porta aleatória, banco em memória)
// e chamam os endpoints via HTTP. Rodar com: npm test
process.env.DB_FILE = ':memory:';
process.env.JWT_SECRET = 'segredo-de-teste';
process.env.RATE_LIMIT_MAX = '100000'; // não limitar requisições durante os testes

const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const app = require('../server');
const db = require('../db');
const mailer = require('../mailer');

const SENHA = 'senha1234';
let server, base, ultimoToken, contador = 0;

async function chamar(metodo, rota, corpo, token) {
  const r = await fetch(base + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo === undefined ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
  return { status: r.status, corpo: await r.json().catch(() => null) };
}

async function criarUsuario() {
  const email = `user${++contador}@teste.com`;
  const r = await chamar('POST', '/api/auth/cadastro', { nome: 'Fulano', email, senha: SENHA });
  return { email, id: r.corpo.id };
}
const logar = (email, senha = SENHA) => chamar('POST', '/api/auth/login', { email, senha });
const redefinir = (token, novaSenha) => chamar('POST', '/api/auth/redefinir-senha', { token, novaSenha });

async function pedirRecuperacao(email) {
  ultimoToken = undefined;
  await chamar('POST', '/api/auth/esqueci-senha', { email });
  return ultimoToken; // capturado pelo mock do e-mail
}

describe('API de autenticação', () => {
  before(async () => {
    mock.method(mailer, 'enviarRecuperacao', (_email, token) => { ultimoToken = token; });
    await new Promise((ok) => { server = app.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { mock.restoreAll(); server.close(); });

  describe('configuração', () => {
    test('em produção, recusa iniciar sem JWT_SECRET forte', () => {
      const r = spawnSync(process.execPath, ['-e', "require('./security')"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'curto' },
        encoding: 'utf8',
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /JWT_SECRET/);
    });
  });

  describe('cadastro', () => {
    test('cria usuário, normaliza o e-mail e não devolve a senha', async () => {
      const r = await chamar('POST', '/api/auth/cadastro', { nome: 'Ana', email: '  ANA@Teste.com ', senha: SENHA });
      assert.equal(r.status, 201);
      assert.equal(r.corpo.email, 'ana@teste.com');
      assert.equal(r.corpo.senha, undefined);
      assert.equal(r.corpo.senha_hash, undefined);
    });

    test('rejeita e-mail duplicado (mesmo com maiúsculas)', async () => {
      const { email } = await criarUsuario();
      const r = await chamar('POST', '/api/auth/cadastro', { nome: 'Outro', email: email.toUpperCase(), senha: SENHA });
      assert.equal(r.status, 409);
    });

    test('rejeita senha fraca e e-mail inválido', async () => {
      for (const senha of ['curta1', 'somenteletras', '12345678']) {
        const r = await chamar('POST', '/api/auth/cadastro', { nome: 'Ana', email: 'fraca@teste.com', senha });
        assert.equal(r.status, 400, `senha "${senha}" deveria ser rejeitada`);
      }
      const r = await chamar('POST', '/api/auth/cadastro', { nome: 'Ana', email: 'nao-e-email', senha: SENHA });
      assert.equal(r.status, 400);
    });

    test('guarda a senha como hash scrypt, nunca em texto puro', async () => {
      const { email } = await criarUsuario();
      const { senha_hash } = db.prepare('SELECT senha_hash FROM usuarios WHERE email = ?').get(email);
      assert.ok(senha_hash.startsWith('scrypt$'));
      assert.ok(!senha_hash.includes(SENHA));
    });
  });

  describe('login e JWT', () => {
    test('login correto devolve token que abre /me', async () => {
      const { email } = await criarUsuario();
      const login = await logar(email);
      assert.equal(login.status, 200);
      const me = await chamar('GET', '/api/auth/me', undefined, login.corpo.token);
      assert.equal(me.status, 200);
      assert.equal(me.corpo.email, email);
    });

    test('senha errada e e-mail inexistente dão a mesma resposta genérica', async () => {
      const { email } = await criarUsuario();
      const errada = await logar(email, 'errada123');
      const inexistente = await logar('ninguem@teste.com');
      assert.equal(errada.status, 401);
      assert.deepEqual(errada, inexistente);
    });

    test('rota protegida rejeita: sem token, outro segredo e alg "none"', async () => {
      const { id } = await criarUsuario();
      assert.equal((await chamar('GET', '/api/auth/me')).status, 401);

      const outroSegredo = jwt.sign({ sub: id, v: 0 }, 'segredo-do-atacante');
      assert.equal((await chamar('GET', '/api/auth/me', undefined, outroSegredo)).status, 401);

      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const semAssinatura = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: id, v: 0 })}.`;
      assert.equal((await chamar('GET', '/api/auth/me', undefined, semAssinatura)).status, 401);
    });

    test('rejeita JSON malformado com 400', async () => {
      const r = await chamar('POST', '/api/auth/login', '{"email":');
      assert.equal(r.status, 400);
    });
  });

  describe('bloqueio por tentativas', () => {
    test('bloqueia após 5 erros, mesmo com a senha certa, e libera quando o prazo acaba', async () => {
      const { email } = await criarUsuario();
      for (let i = 0; i < 5; i++) assert.equal((await logar(email, 'errada123')).status, 401);

      assert.equal((await logar(email)).status, 429);

      db.prepare('UPDATE usuarios SET bloqueado_ate = ? WHERE email = ?').run(Date.now() - 1000, email);
      assert.equal((await logar(email)).status, 200);
    });

    test('login bem-sucedido zera o contador de erros', async () => {
      const { email } = await criarUsuario();
      for (let i = 0; i < 3; i++) await logar(email, 'errada123');
      assert.equal((await logar(email)).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await logar(email, 'errada123')).status, 401);
      assert.equal((await logar(email)).status, 200); // 4 erros novos ainda não bloqueiam
    });
  });

  describe('recuperação de senha', () => {
    test('resposta é idêntica para e-mail existente e inexistente', async () => {
      const { email } = await criarUsuario();
      const a = await chamar('POST', '/api/auth/esqueci-senha', { email });
      const b = await chamar('POST', '/api/auth/esqueci-senha', { email: 'fantasma@teste.com' });
      assert.equal(a.status, 200);
      assert.deepEqual(a, b);
    });

    test('guarda só o hash do token e o token dura cerca de 30 minutos', async () => {
      const { email, id } = await criarUsuario();
      const token = await pedirRecuperacao(email);
      assert.match(token, /^[a-f0-9]{64}$/);
      const linha = db.prepare('SELECT token_hash, expira_em FROM reset_tokens WHERE usuario_id = ?').get(id);
      assert.notEqual(linha.token_hash, token);
      const minutos = (linha.expira_em - Date.now()) / 60000;
      assert.ok(minutos > 29 && minutos <= 30);
    });

    test('redefine a senha: a nova funciona e a antiga não', async () => {
      const { email } = await criarUsuario();
      const token = await pedirRecuperacao(email);
      assert.equal((await redefinir(token, 'novaSenha99')).status, 200);
      assert.equal((await logar(email, 'novaSenha99')).status, 200);
      assert.equal((await logar(email, SENHA)).status, 401);
    });

    test('senha nova fraca é rejeitada sem gastar o token', async () => {
      const { email } = await criarUsuario();
      const token = await pedirRecuperacao(email);
      assert.equal((await redefinir(token, 'fraca')).status, 400);
      assert.equal((await redefinir(token, 'novaSenha99')).status, 200);
    });

    test('token é de uso único', async () => {
      const { email } = await criarUsuario();
      const token = await pedirRecuperacao(email);
      assert.equal((await redefinir(token, 'novaSenha99')).status, 200);
      assert.equal((await redefinir(token, 'outraSenha99')).status, 400);
    });

    test('token expirado é recusado', async () => {
      const { email, id } = await criarUsuario();
      const token = await pedirRecuperacao(email);
      db.prepare('UPDATE reset_tokens SET expira_em = ? WHERE usuario_id = ?').run(Date.now() - 1000, id);
      assert.equal((await redefinir(token, 'novaSenha99')).status, 400);
    });

    test('token malformado ou inexistente é recusado', async () => {
      assert.equal((await redefinir('abc', 'novaSenha99')).status, 400);
      assert.equal((await redefinir('0'.repeat(64), 'novaSenha99')).status, 400);
    });

    test('um novo pedido invalida o token anterior', async () => {
      const { email } = await criarUsuario();
      const primeiro = await pedirRecuperacao(email);
      const segundo = await pedirRecuperacao(email);
      assert.equal((await redefinir(primeiro, 'novaSenha99')).status, 400);
      assert.equal((await redefinir(segundo, 'novaSenha99')).status, 200);
    });

    test('JWT emitido antes da troca de senha deixa de valer', async () => {
      const { email } = await criarUsuario();
      const antigo = (await logar(email)).corpo.token;
      assert.equal((await chamar('GET', '/api/auth/me', undefined, antigo)).status, 200);

      const token = await pedirRecuperacao(email);
      await redefinir(token, 'novaSenha99');

      assert.equal((await chamar('GET', '/api/auth/me', undefined, antigo)).status, 401);
      const novo = (await logar(email, 'novaSenha99')).corpo.token;
      assert.equal((await chamar('GET', '/api/auth/me', undefined, novo)).status, 200);
    });
  });
});
