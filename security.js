const crypto = require('crypto');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production' && (process.env.JWT_SECRET || '').length < 32) {
  throw new Error('Defina JWT_SECRET com pelo menos 32 caracteres em produção.');
}
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET não definido: usando segredo temporário (os tokens deixam de valer ao reiniciar).');
}

// Hash de senha com scrypt (nativo do Node, com salt aleatório por usuário)
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verificarSenha(senha, armazenado) {
  const [alg, saltHex, hashHex] = armazenado.split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const hash = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(hash, esperado); // comparação em tempo constante
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

const assinarToken = (u) =>
  jwt.sign({ sub: u.id, v: u.token_version }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const verificarToken = (t) => jwt.verify(t, SECRET, { algorithms: ['HS256'] });

module.exports = { hashSenha, verificarSenha, sha256, assinarToken, verificarToken };
