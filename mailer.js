// Envio do e-mail de recuperação de senha.
// Em produção, troque o console.log por nodemailer, SES, SendGrid etc.
function enviarRecuperacao(email, token) {
  const link = `${process.env.APP_URL || 'http://localhost:3000'}/redefinir-senha?token=${token}`;
  console.log(`📧 [e-mail simulado] recuperação para ${email}: ${link}`);
}

module.exports = { enviarRecuperacao };
