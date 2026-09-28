const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const mailer = require('./mailer');
const { hashSenha, verificarSenha, sha256, assinarToken, verificarToken } = require('./security');

const app = express();
// Atrás de um proxy (Render, Nginx), confia no 1º salto para enxergar o IP real do cliente.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(helmet({
  contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'upgrade-insecure-requests': null } },
}));
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false }));
app.use(express.json({ limit: '10kb' }));
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000, limit: Number(process.env.RATE_LIMIT_MAX) || 50, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'muitas requisições, tente novamente mais tarde' },
}));

// ---------- validações ----------
const normEmail = (e) => String(e || '').trim().toLowerCase();
const emailValido = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const senhaValida = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 128 && /[A-Za-z]/.test(s) && /\d/.test(s);
const MSG_SENHA = 'a senha deve ter de 8 a 128 caracteres, com letras e números';

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
const HASH_FALSO = hashSenha('senha-falsa-para-igualar-o-tempo-de-resposta');

// ---------- middleware de autenticação ----------
function autenticar(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) return res.status(401).json({ erro: 'token ausente' });
  try {
    const p = verificarToken(token);
    const u = db.prepare('SELECT id, nome, email, token_version FROM usuarios WHERE id = ?').get(p.sub);
    if (!u || u.token_version !== p.v) return res.status(401).json({ erro: 'token inválido' });
    req.usuario = u;
    next();
  } catch {
    res.status(401).json({ erro: 'token inválido ou expirado' });
  }
}

// ---------- interface web ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/redefinir-senha', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- rotas ----------
app.get('/api/saude', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/cadastro', (req, res) => {
  const nome = String(req.body.nome || '').trim();
  const email = normEmail(req.body.email);
  const { senha } = req.body;
  if (nome.length < 2 || nome.length > 100) return res.status(400).json({ erro: 'nome inválido' });
  if (!emailValido(email)) return res.status(400).json({ erro: 'e-mail inválido' });
  if (!senhaValida(senha)) return res.status(400).json({ erro: MSG_SENHA });
  try {
    const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)')
      .run(nome, email, hashSenha(senha));
    res.status(201).json({ id: Number(r.lastInsertRowid), nome, email });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ erro: 'e-mail já cadastrado' });
    throw e;
  }
});

app.post('/api/auth/login', (req, res) => {
  const email = normEmail(req.body.email);
  const senha = typeof req.body.senha === 'string' ? req.body.senha : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);

  if (u && u.bloqueado_ate && u.bloqueado_ate > Date.now()) {
    return res.status(429).json({ erro: 'conta temporariamente bloqueada por excesso de tentativas' });
  }
  // sempre calcula um hash, mesmo sem usuário, para não vazar (por tempo) se o e-mail existe
  const senhaOk = verificarSenha(senha, u ? u.senha_hash : HASH_FALSO) && !!u;

  if (!senhaOk) {
    if (u) {
      const t = u.tentativas_falhas + 1;
      if (t >= MAX_TENTATIVAS) db.prepare('UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = ? WHERE id = ?').run(Date.now() + BLOQUEIO_MS, u.id);
      else db.prepare('UPDATE usuarios SET tentativas_falhas = ? WHERE id = ?').run(t, u.id);
    }
    return res.status(401).json({ erro: 'credenciais inválidas' });
  }
  db.prepare('UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?').run(u.id);
  res.json({ token: assinarToken(u), tipo: 'Bearer', expiraEm: '1h' });
});

app.post('/api/auth/esqueci-senha', (req, res) => {
  const email = normEmail(req.body.email);
  const u = emailValido(email) ? db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email) : null;
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    db.transaction(() => {
      db.prepare('UPDATE reset_tokens SET usado = 1 WHERE usuario_id = ? AND usado = 0').run(u.id);
      db.prepare('INSERT INTO reset_tokens (usuario_id, token_hash, expira_em) VALUES (?, ?, ?)')
        .run(u.id, sha256(token), Date.now() + 30 * 60 * 1000);
    })();
    mailer.enviarRecuperacao(email, token);
  }
  // resposta idêntica exista ou não o e-mail (evita enumeração de usuários)
  res.json({ mensagem: 'se o e-mail estiver cadastrado, enviaremos instruções para redefinir a senha' });
});

app.post('/api/auth/redefinir-senha', (req, res) => {
  const { token, novaSenha } = req.body;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ erro: 'token inválido ou expirado' });
  if (!senhaValida(novaSenha)) return res.status(400).json({ erro: MSG_SENHA });

  const r = db.prepare('SELECT usuario_id FROM reset_tokens WHERE token_hash = ? AND usado = 0 AND expira_em > ?')
    .get(sha256(token), Date.now());
  if (!r) return res.status(400).json({ erro: 'token inválido ou expirado' });

  db.transaction(() => {
    db.prepare('UPDATE usuarios SET senha_hash = ?, token_version = token_version + 1, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?')
      .run(hashSenha(novaSenha), r.usuario_id);
    db.prepare('UPDATE reset_tokens SET usado = 1 WHERE usuario_id = ?').run(r.usuario_id);
  })();
  res.json({ mensagem: 'senha redefinida com sucesso' });
});

app.get('/api/auth/me', autenticar, (req, res) => {
  const { id, nome, email } = req.usuario;
  res.json({ id, nome, email });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ erro: 'erro interno' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API de autenticação em http://localhost:${PORT}`));
}

module.exports = app; // exportado para os testes
