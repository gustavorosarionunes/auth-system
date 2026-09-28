const $ = (s) => document.querySelector(s);
const VIEWS = ['login', 'cadastro', 'esqueci', 'redefinir', 'painel'];

function mostrar(nome) {
  VIEWS.forEach((v) => ($('#v-' + v).hidden = v !== nome));
  document.querySelectorAll('.senha input[type=text]').forEach((i) => i.nextElementSibling.click());
  msg('');
}

function msg(texto, ok = false) {
  const m = $('#msg');
  m.textContent = texto; // textContent: nunca interpreta HTML (evita XSS)
  m.className = ok ? 'ok' : 'erro';
  m.hidden = !texto;
}

async function api(rota, corpo, token) {
  const r = await fetch('/api/auth/' + rota, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || 'erro inesperado');
  return dados;
}

function ligar(id, fn) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const botao = e.target.querySelector('button:not([type=button])');
    botao.disabled = true;
    msg('');
    try { await fn(Object.fromEntries(new FormData(e.target)), e.target); }
    catch (err) { msg(err.message); }
    finally { botao.disabled = false; }
  });
}

async function abrirPainel() {
  try {
    const u = await api('me', null, sessionStorage.getItem('token'));
    $('#p-nome').textContent = u.nome;
    $('#p-email').textContent = u.email;
    mostrar('painel');
  } catch {
    sessionStorage.removeItem('token');
    mostrar('login');
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ir]');
  if (a) { e.preventDefault(); mostrar(a.dataset.ir); }
});

ligar('#f-login', async (d) => {
  const r = await api('login', d);
  sessionStorage.setItem('token', r.token);
  await abrirPainel();
});

ligar('#f-cadastro', async (d, form) => {
  await api('cadastro', d);
  form.reset();
  mostrar('login');
  msg('Conta criada! Faça login.', true);
});

ligar('#f-esqueci', async (d) => {
  const r = await api('esqueci-senha', d);
  msg(r.mensagem, true);
});

ligar('#f-redefinir', async (d, form) => {
  const token = new URLSearchParams(location.search).get('token');
  await api('redefinir-senha', { token, novaSenha: d.novaSenha });
  form.reset();
  history.replaceState(null, '', '/');
  mostrar('login');
  msg('Senha redefinida! Faça login com a nova senha.', true);
});

$('#sair').addEventListener('click', () => {
  sessionStorage.removeItem('token');
  mostrar('login');
});

// botão mostrar/ocultar em todos os campos de senha
document.querySelectorAll('input[type=password]').forEach((input) => {
  const wrap = document.createElement('span');
  wrap.className = 'senha';
  input.replaceWith(wrap);
  wrap.append(input);
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'olho';
  botao.textContent = 'Mostrar';
  botao.setAttribute('aria-label', 'Mostrar senha');
  botao.addEventListener('click', () => {
    const ocultando = input.type === 'password';
    input.type = ocultando ? 'text' : 'password';
    botao.textContent = ocultando ? 'Ocultar' : 'Mostrar';
    botao.setAttribute('aria-label', ocultando ? 'Ocultar senha' : 'Mostrar senha');
  });
  wrap.append(botao);
});

// estado inicial
if (location.pathname === '/redefinir-senha' && new URLSearchParams(location.search).get('token')) mostrar('redefinir');
else if (sessionStorage.getItem('token')) abrirPainel();
else mostrar('login');
