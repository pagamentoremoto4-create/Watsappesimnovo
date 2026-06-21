require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const QRCode = require('qrcode');
const pino = require('pino');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = Number(process.env.PORT || 10000);
const BASE_URL = String(process.env.BASE_URL || '').replace(/\/$/, '');
const PIXGO_API_KEY = process.env.PIXGO_API_KEY || '';
const PIXGO_URL = process.env.PIXGO_URL || 'https://pixgo.org/api/v1/payment/create';
const LOJA_NOME = process.env.LOJA_NOME || 'Centralunlocker eSIM';
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'esim.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads_esim');
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_esim');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups_esim');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';
const ADMIN_NUMBERS = String(process.env.ADMIN_NUMBERS || '').split(',').map(onlyDigits).filter(Boolean);
const SUPORTE_WHATSAPP = onlyDigits(process.env.SUPORTE_WHATSAPP || ADMIN_NUMBERS[0] || '');
const ESTOQUE_BAIXO = Number(process.env.ESTOQUE_BAIXO || 2);
const PRAZO_MANUAL = process.env.PRAZO_MANUAL || 'até 30 minutos';

for (const dir of [DATA_DIR, UPLOAD_DIR, AUTH_DIR, BACKUP_DIR]) fs.mkdirSync(dir, { recursive: true });

const app = express();
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use('/files', express.static(UPLOAD_DIR));
app.use(session({ secret: process.env.SESSION_SECRET || 'centralunlocker-secret', resave: false, saveUninitialized: false }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.png') || '.png';
      cb(null, `qr_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || ''))
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
let sock = null;
let qrBase64 = null;
let conectado = false;
const userState = new Map();

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function money(v) { return Number(v || 0).toFixed(2).replace('.', ','); }
function safe(s) { return String(s ?? '').replace(/[&<>'"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m])); }
function phoneToJid(phone) { const n = normalizePhone(phone); return n ? `${n}@s.whatsapp.net` : ''; }
function jidToPhone(jid) { return normalizePhone(String(jid || '').split('@')[0].split(':')[0]); }
function normalizePhone(v) { let n = onlyDigits(v).replace(/^0+/, ''); if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) n = '55' + n; return n; }
function getText(m) { return m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || ''; }
function isPaidStatus(s) { return ['paid','approved','completed','aprovado','pago'].includes(String(s || '').toLowerCase()); }

function initDB() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS configs (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT UNIQUE, nome TEXT, jid TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    gb TEXT,
    validade TEXT DEFAULT '30 dias',
    preco REAL NOT NULL DEFAULT 0,
    descricao TEXT,
    destaque INTEGER DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    permite_manual_sem_estoque INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS estoque_qr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    arquivo TEXT,
    codigo_texto TEXT,
    status TEXT DEFAULT 'DISPONIVEL',
    pedido_id INTEGER,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    usado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_ref TEXT UNIQUE,
    cliente_id INTEGER,
    cliente_nome TEXT,
    cliente_telefone TEXT,
    cliente_jid TEXT,
    produto_id INTEGER,
    produto_nome TEXT,
    valor REAL,
    status TEXT DEFAULT 'PENDENTE',
    pixgo_id TEXT,
    qr_estoque_id INTEGER,
    entrega_manual_texto TEXT,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
    pago_em TEXT,
    entregue_em TEXT
  );
  CREATE TABLE IF NOT EXISTS mensagens_salvas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT,
    total INTEGER DEFAULT 0,
    criado_em TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
  const hash = getConfig('admin_hash');
  if (!hash) setConfig('admin_hash', bcrypt.hashSync(ADMIN_PASS, 10));
  const count = db.prepare('SELECT COUNT(*) c FROM produtos').get().c;
  if (!count) {
    db.prepare('INSERT INTO produtos(nome,gb,validade,preco,descricao,destaque) VALUES(?,?,?,?,?,?)').run('TIM 50GB','50GB','30 dias',35,'Plano eSIM TIM 50GB',1);
    db.prepare('INSERT INTO produtos(nome,gb,validade,preco,descricao,destaque) VALUES(?,?,?,?,?,?)').run('TIM 67GB','67GB','30 dias',55,'Plano eSIM TIM 67GB',0);
  }
}
function getConfig(k, def='') { const r = db.prepare('SELECT valor FROM configs WHERE chave=?').get(k); return r ? r.valor : def; }
function setConfig(k, v) { db.prepare('INSERT OR REPLACE INTO configs(chave,valor,atualizado_em) VALUES(?,?,CURRENT_TIMESTAMP)').run(k, String(v)); }
function auth(req,res,next){ if(req.session.admin) return next(); res.redirect('/admin/login'); }

async function sendText(to, text) { if (!sock) return false; try { await sock.sendMessage(to, { text }); return true; } catch(e) { console.log('Erro enviar texto:', e.message); return false; } }
async function sendImage(to, filePath, caption='') { if (!sock || !fs.existsSync(filePath)) return false; try { await sock.sendMessage(to, { image: fs.readFileSync(filePath), caption }); return true; } catch(e) { console.log('Erro enviar imagem:', e.message); return false; } }
async function notifyAdmins(text) { for (const n of ADMIN_NUMBERS) await sendText(phoneToJid(n), text); }

function upsertClient(phone, nome, jid) {
  const p = normalizePhone(phone);
  db.prepare(`INSERT INTO clientes(telefone,nome,jid) VALUES(?,?,?) ON CONFLICT(telefone) DO UPDATE SET nome=excluded.nome,jid=excluded.jid`).run(p, nome || 'Cliente', jid || phoneToJid(p));
  return db.prepare('SELECT * FROM clientes WHERE telefone=?').get(p);
}
function estoqueProduto(pid) { return db.prepare("SELECT COUNT(*) c FROM estoque_qr WHERE produto_id=? AND status='DISPONIVEL'").get(pid).c; }
function produtoComEstoque(pid) { const p = db.prepare('SELECT * FROM produtos WHERE id=? AND ativo=1').get(pid); if (!p) return null; p.estoque = estoqueProduto(pid); return p; }
function menuPrincipal() { return `👋 Bem-vindo à *${LOJA_NOME}*\n\n1️⃣ Comprar eSIM\n2️⃣ Meus Pedidos\n3️⃣ Suporte\n\nDigite o número da opção.`; }
function listaPlanos() {
  const ps = db.prepare('SELECT * FROM produtos WHERE ativo=1 ORDER BY destaque DESC, id DESC').all();
  if (!ps.length) return '❌ Nenhum eSIM disponível no momento.';
  let txt = '📱 *eSIM DISPONÍVEIS*\n\n';
  ps.forEach((p, i) => {
    const qtd = estoqueProduto(p.id);
    const tag = p.destaque ? '🔥 MAIS VENDIDO\n' : '';
    const entrega = qtd > 0 ? `📦 ${qtd} disponíveis` : (p.permite_manual_sem_estoque ? `📦 0 disponíveis ⚠️ Entrega manual` : '📦 ESGOTADO');
    txt += `${tag}${i+1}️⃣ *${p.nome}*\n💰 ${brl(p.preco)}\n${entrega}\n\n`;
  });
  txt += '👇 Digite o número do plano para comprar.';
  return txt;
}
function getProdutoByChoice(choice) {
  const ps = db.prepare('SELECT * FROM produtos WHERE ativo=1 ORDER BY destaque DESC, id DESC').all();
  const idx = Number(choice) - 1;
  if (idx < 0 || idx >= ps.length) return null;
  const p = ps[idx]; p.estoque = estoqueProduto(p.id); return p;
}
async function createPix(pedido, produto) {
  if (!PIXGO_API_KEY) throw new Error('PIXGO_API_KEY não configurada no Render');
  if (!BASE_URL) throw new Error('BASE_URL não configurada no Render');

  // Mesmo padrão do seu bot Telegram que já funciona com a PixGo
  const payload = {
    amount: Number(pedido.valor),
    description: `Compra ${produto.nome} #${pedido.id}`,
    webhook_url: `${BASE_URL}/webhook/pixgo`,
    external_reference: String(pedido.id),
    external_id: String(pedido.id)
  };

  const headers = { 'X-API-Key': PIXGO_API_KEY, 'Content-Type': 'application/json' };
  const r = await axios.post(PIXGO_URL, payload, { headers, timeout: 30000 });
  const resposta = r.data || {};
  console.log('PIXGO RESPOSTA:', resposta);

  const data = resposta.data || resposta;
  const pixId = data.payment_id || data.id || data.transaction_id || '';
  const copia = data.qr_code || data.pix_copy_paste || data.copy_paste || data.pix || data.brcode || '';
  if (!copia) {
    const err = new Error('PixGo não retornou copia e cola');
    err.responseData = resposta;
    throw err;
  }
  db.prepare('UPDATE pedidos SET pixgo_id=? WHERE id=?').run(pixId, pedido.id);
  return copia;
}
async function entregarPedido(pedidoId, manualTexto='', manualArquivo='') {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(pedidoId);
  if (!pedido || pedido.status === 'ENTREGUE') return;
  const jid = pedido.cliente_jid || phoneToJid(pedido.cliente_telefone);
  const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(pedido.produto_id) || {};
  if (manualTexto || manualArquivo) {
    db.prepare('UPDATE pedidos SET status="ENTREGUE", entrega_manual_texto=?, entregue_em=CURRENT_TIMESTAMP WHERE id=?').run(manualTexto || '', pedido.id);
    const cap = manualTexto || `✅ Seu eSIM foi liberado!\n\nPedido #${pedido.id}\nPlano: ${pedido.produto_nome}`;
    if (manualArquivo) await sendImage(jid, manualArquivo, cap); else await sendText(jid, cap);
    await notifyAdmins(`✅ *PEDIDO ENTREGUE MANUALMENTE*\n\nPedido: #${pedido.id}\nCliente: ${pedido.cliente_telefone}\nPlano: ${pedido.produto_nome}`);
    return;
  }
  const qr = db.prepare("SELECT * FROM estoque_qr WHERE produto_id=? AND status='DISPONIVEL' ORDER BY id ASC LIMIT 1").get(pedido.produto_id);
  if (!qr) {
    db.prepare('UPDATE pedidos SET status="AGUARDANDO_ENVIO" WHERE id=?').run(pedido.id);
    await sendText(jid, `✅ Pagamento confirmado!\n\n📦 Pedido #${pedido.id}\n📱 ${pedido.produto_nome}\n\n⚠️ Seu pedido entrou para entrega manual.\n⏱ Prazo: ${PRAZO_MANUAL}`);
    await notifyAdmins(`🚨 *PEDIDO MANUAL - ESTOQUE ZERADO*\n\nPedido: #${pedido.id}\nCliente: ${pedido.cliente_telefone}\nPlano: ${pedido.produto_nome}\nValor: ${brl(pedido.valor)}\n\nAcesse /admin/pedidos para entregar.`);
    return;
  }
  db.prepare('UPDATE estoque_qr SET status="VENDIDO", pedido_id=?, usado_em=CURRENT_TIMESTAMP WHERE id=?').run(pedido.id, qr.id);
  db.prepare('UPDATE pedidos SET status="ENTREGUE", qr_estoque_id=?, entregue_em=CURRENT_TIMESTAMP WHERE id=?').run(qr.id, pedido.id);
  const caption = `✅ eSIM entregue!\n\n📦 Pedido #${pedido.id}\n📱 Plano: ${pedido.produto_nome}\n📶 ${produto.gb || ''} · ⏱ ${produto.validade || ''}\n\n📌 Como instalar:\n1. Abra Ajustes/Configurações\n2. Vá em Celular/Dados móveis\n3. Toque em Adicionar eSIM\n4. Escaneie este QR Code\n\n⚠️ Use apenas uma vez.`;
  const filePath = qr.arquivo ? path.join(UPLOAD_DIR, path.basename(qr.arquivo)) : '';
  if (filePath && fs.existsSync(filePath)) await sendImage(jid, filePath, caption);
  else await sendText(jid, caption + (qr.codigo_texto ? `\n\nCódigo: ${qr.codigo_texto}` : ''));
  const restam = estoqueProduto(pedido.produto_id);
  await notifyAdmins(`✅ *PEDIDO ENTREGUE AUTOMATICAMENTE*\n\nPedido: #${pedido.id}\nCliente: ${pedido.cliente_telefone}\nPlano: ${pedido.produto_nome}\nRestam: ${restam}`);
  if (restam === 0) await notifyAdmins(`🚨 *ESTOQUE ESGOTADO*\n\n${pedido.produto_nome}\nAs próximas vendas serão manuais.`);
  else if (restam <= ESTOQUE_BAIXO) await notifyAdmins(`⚠️ *ESTOQUE BAIXO*\n\n${pedido.produto_nome}\nRestam apenas ${restam}.`);
}

async function tratarMensagem(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || msg.key.fromMe || jid === 'status@broadcast') return;
  const text = getText(msg).trim();
  if (!text) return;
  const phone = jidToPhone(jid);
  const cliente = upsertClient(phone, msg.pushName || 'Cliente', jid);
  const state = userState.get(jid);
  const lower = text.toLowerCase();
  if (['menu','oi','olá','ola','start','inicio','início','cancelar'].includes(lower)) { userState.delete(jid); return sendText(jid, menuPrincipal()); }
  if (lower === '1' && !state) { userState.set(jid, { step: 'planos' }); return sendText(jid, listaPlanos()); }
  if (lower === '2' && !state) {
    const ps = db.prepare('SELECT * FROM pedidos WHERE cliente_id=? ORDER BY id DESC LIMIT 10').all(cliente.id);
    if (!ps.length) return sendText(jid, '📦 Você ainda não tem pedidos.');
    return sendText(jid, '📦 *Meus pedidos*\n\n' + ps.map(p => `#${p.id} - ${p.produto_nome}\n${brl(p.valor)} - ${p.status}`).join('\n\n'));
  }
  if (lower === '3' && !state) return sendText(jid, `🆘 Suporte Centralunlocker\n\nFale com: https://wa.me/${SUPORTE_WHATSAPP}`);

  if (state?.step === 'planos') {
    const produto = getProdutoByChoice(text);
    if (!produto) return sendText(jid, '❌ Plano inválido. Digite o número do plano ou *menu* para voltar.');
    if (produto.estoque <= 0 && !produto.permite_manual_sem_estoque) return sendText(jid, '❌ Esse plano está esgotado no momento.');
    userState.set(jid, { step: 'confirmar', produto_id: produto.id });
    const entrega = produto.estoque > 0 ? '✅ Entrega automática' : `⚠️ Entrega manual\n⏱ Prazo: ${PRAZO_MANUAL}`;
    return sendText(jid, `📱 *Plano Selecionado*\n\n${produto.nome}\n📅 ${produto.validade || '30 dias'}\n💰 ${brl(produto.preco)}\n📦 Estoque: ${produto.estoque}\n${entrega}\n\n1️⃣ Gerar PIX\n2️⃣ Voltar`);
  }
  if (state?.step === 'confirmar') {
    const opcaoConfirmar = text.toLowerCase().trim();
    const querVoltar = opcaoConfirmar === '2' || opcaoConfirmar.startsWith('2️⃣') || opcaoConfirmar.includes('voltar');
    const querPix = opcaoConfirmar === '1' || opcaoConfirmar.startsWith('1️⃣') || opcaoConfirmar.includes('gerar pix') || opcaoConfirmar.includes('pix') || opcaoConfirmar.includes('comprar');
    if (querVoltar) { userState.set(jid, { step: 'planos' }); return sendText(jid, listaPlanos()); }
    if (!querPix) return sendText(jid, 'Digite *1* para gerar PIX ou *2* para voltar.');
    const produto = produtoComEstoque(state.produto_id);
    if (!produto) { userState.delete(jid); return sendText(jid, '❌ Produto indisponível.'); }
    if (produto.estoque <= 0 && !produto.permite_manual_sem_estoque) return sendText(jid, '❌ Esse plano está esgotado no momento.');
    const external_ref = String(Date.now()) + '_' + uuidv4();
    const info = db.prepare('INSERT INTO pedidos(external_ref,cliente_id,cliente_nome,cliente_telefone,cliente_jid,produto_id,produto_nome,valor,status) VALUES(?,?,?,?,?,?,?,?,"PENDENTE")')
      .run(external_ref, cliente.id, cliente.nome, cliente.telefone, jid, produto.id, produto.nome, produto.preco);
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(info.lastInsertRowid);
    userState.delete(jid);
    await sendText(jid, `💰 Gerando PIX...\n\nProduto: ${produto.nome}\nValor: ${brl(produto.preco)}`);
    try {
      const copia = await createPix(pedido, produto);
      if (!copia) return sendText(jid, '❌ Pix gerado, mas não recebi o copia e cola. Chame o suporte.');
      await sendText(jid, `✅ *PIX GERADO*

📦 Pedido #${pedido.id}
📱 ${produto.nome}
💰 ${brl(produto.preco)}

📋 O código PIX copia e cola será enviado na próxima mensagem.

⏳ Após pagar, a entrega será automática ou manual conforme estoque.`);
      await sendText(jid, `${copia}`);
      await notifyAdmins(`🛒 *NOVA VENDA INICIADA*\n\nPedido: #${pedido.id}\nCliente: ${cliente.telefone}\nPlano: ${produto.nome}\nValor: ${brl(produto.preco)}`);
    } catch(e) {
      console.log('ERRO PIXGO:', e.response?.data || e.responseData || e.message);
      db.prepare('UPDATE pedidos SET status="ERRO_PIX" WHERE id=?').run(pedido.id);
      await sendText(jid, `❌ Erro ao gerar PIX.

Motivo: ${e.message}

Confira PIXGO_API_KEY, BASE_URL e PIXGO_URL no Render.`);
    }
    return;
  }
  return sendText(jid, menuPrincipal());
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { qrBase64 = await QRCode.toDataURL(qr); conectado = false; console.log('QR WhatsApp atualizado. Abra /qr'); }
    if (connection === 'open') { conectado = true; qrBase64 = null; console.log('WhatsApp conectado.'); }
    if (connection === 'close') {
      conectado = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startWhatsApp();
      else console.log('Sessão desconectada. Use /admin/reset-whatsapp.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => { for (const m of messages) { try { await tratarMensagem(m); } catch(e) { console.log('Erro mensagem:', e.message); } } });
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)}</title><style>
  body{margin:0;background:#07111f;color:#eaf0f8;font-family:Arial,sans-serif}.layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:#09101f;padding:18px;border-right:1px solid #24324b}.brand{font-weight:900;font-size:21px;margin-bottom:20px}.side a{display:block;color:#dbeafe;text-decoration:none;padding:11px;border-radius:12px;margin:5px 0}.side a:hover{background:#13223a}.main{padding:22px}.card{background:#101b31;border:1px solid #24324b;border-radius:18px;padding:16px;margin:14px 0;box-shadow:0 14px 35px rgba(0,0,0,.25)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric h1{margin:0;font-size:30px}.metric p{color:#97a6ba}input,select,textarea{width:100%;padding:11px;border-radius:12px;border:1px solid #334155;background:#08111f;color:white;margin:6px 0 12px}.btn,button{background:#2563eb;color:white;border:0;border-radius:11px;padding:9px 13px;text-decoration:none;font-weight:bold;display:inline-block;margin:2px;cursor:pointer}.green{background:#16a34a}.red{background:#dc2626}.orange{background:#ea580c}.muted{color:#97a6ba}table{width:100%;border-collapse:collapse;background:#08111f;border-radius:14px;overflow:hidden}td,th{padding:10px;border-bottom:1px solid #24324b;text-align:left}th{background:#13223a}.pill{padding:5px 9px;border-radius:999px;background:#1e40af;font-weight:bold}@media(max-width:800px){.layout{grid-template-columns:1fr}.side{position:relative}.main{padding:14px}}
  </style></head><body><div class="layout"><div class="side"><div class="brand">📱 Centralunlocker</div><a href="/admin">📊 Dashboard</a><a href="/admin/produtos">📦 Produtos</a><a href="/admin/estoque">📥 Estoque QR</a><a href="/admin/pedidos">📋 Pedidos</a><a href="/admin/pedidos?status=AGUARDANDO_ENVIO">🟡 Pedidos Manuais</a><a href="/admin/clientes">👥 Clientes</a><a href="/admin/mensagem">📢 Mensagem</a><a href="/admin/backup">💾 Backup</a><a href="/qr">🔳 QR WhatsApp</a><a href="/admin/senha">🔐 Alterar senha</a><a href="/admin/logout">🚪 Sair</a></div><div class="main">${body}</div></div></body></html>`;
}

app.get('/', (req,res)=>res.redirect('/admin'));
app.get('/qr', async (req,res)=>res.send(page('QR WhatsApp', `<h1>🔳 QR WhatsApp</h1><div class="card"><p>Status: <b>${conectado ? 'Conectado' : 'Aguardando QR'}</b></p>${qrBase64 ? `<img src="${qrBase64}" style="max-width:320px;width:100%">` : '<p>Se não aparecer QR, reinicie ou aguarde alguns segundos.</p>'}</div>`)));
app.get('/admin/login',(req,res)=>res.send(page('Login',`<div class="card" style="max-width:420px"><h1>Login Admin</h1><form method="post"><input name="user" placeholder="Usuário"><input name="pass" type="password" placeholder="Senha"><button>Entrar</button></form></div>`)));
app.post('/admin/login',(req,res)=>{ const ok=req.body.user===ADMIN_USER && bcrypt.compareSync(req.body.pass||'', getConfig('admin_hash')); if(!ok) return res.send(page('Erro','<div class="card">Login inválido.</div>')); req.session.admin=true; res.redirect('/admin'); });
app.get('/admin/logout',(req,res)=>req.session.destroy(()=>res.redirect('/admin/login')));
app.get('/admin',auth,(req,res)=>{ const clientes=db.prepare('SELECT COUNT(*) c FROM clientes').get().c; const pedidos=db.prepare('SELECT COUNT(*) c FROM pedidos').get().c; const pend=db.prepare("SELECT COUNT(*) c FROM pedidos WHERE status='AGUARDANDO_ENVIO'").get().c; const estoque=db.prepare("SELECT COUNT(*) c FROM estoque_qr WHERE status='DISPONIVEL'").get().c; const vendas=db.prepare("SELECT COALESCE(SUM(valor),0) s FROM pedidos WHERE status IN ('ENTREGUE','AGUARDANDO_ENVIO','PAGO')").get().s; res.send(page('Dashboard',`<h1>📊 Painel eSIM</h1><div class="grid"><div class="card metric"><p>WhatsApp</p><h1>${conectado?'Online':'QR'}</h1></div><div class="card metric"><p>Clientes</p><h1>${clientes}</h1></div><div class="card metric"><p>Pedidos</p><h1>${pedidos}</h1></div><div class="card metric"><p>Manuais</p><h1>${pend}</h1></div><div class="card metric"><p>QR disponíveis</p><h1>${estoque}</h1></div><div class="card metric"><p>Vendas</p><h1>${brl(vendas)}</h1></div></div>`)); });

app.get('/admin/produtos',auth,(req,res)=>{ const ps=db.prepare('SELECT * FROM produtos ORDER BY destaque DESC,id DESC').all(); let rows=''; for(const p of ps){ rows+=`<tr><td>#${p.id}</td><td>${safe(p.nome)} ${p.destaque?'🔥':''}</td><td>${safe(p.validade)}</td><td>${brl(p.preco)}</td><td>${estoqueProduto(p.id)}</td><td>${p.ativo?'Ativo':'Off'}</td><td><a class="btn" href="/admin/produtos/${p.id}/editar">Editar</a><form style="display:inline" method="post" action="/admin/produtos/${p.id}/apagar" onsubmit="return confirm('Apagar produto?')"><button class="red">Apagar</button></form></td></tr>`; } res.send(page('Produtos',`<h1>📦 Produtos</h1><div class="card"><h2>Novo produto</h2><form method="post"><input name="nome" placeholder="Ex: TIM 50GB" required><input name="gb" placeholder="Ex: 50GB"><input name="validade" placeholder="Ex: 30 dias"><input name="preco" placeholder="Preço" required><textarea name="descricao" placeholder="Descrição"></textarea><label><input type="checkbox" name="destaque" value="1"> Mais vendido/destaque</label><br><label><input type="checkbox" name="manual" value="1" checked> Permitir venda manual sem estoque</label><br><button class="green">Salvar produto</button></form></div><div class="card"><table><tr><th>ID</th><th>Nome</th><th>Validade</th><th>Preço</th><th>Estoque</th><th>Status</th><th>Ações</th></tr>${rows}</table></div>`)); });
app.post('/admin/produtos',auth,(req,res)=>{ db.prepare('INSERT INTO produtos(nome,gb,validade,preco,descricao,destaque,permite_manual_sem_estoque) VALUES(?,?,?,?,?,?,?)').run(req.body.nome,req.body.gb||'',req.body.validade||'30 dias',Number(String(req.body.preco).replace(',','.')),req.body.descricao||'',req.body.destaque?1:0,req.body.manual?1:0); res.redirect('/admin/produtos'); });
app.get('/admin/produtos/:id/editar',auth,(req,res)=>{ const p=db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id); if(!p) return res.redirect('/admin/produtos'); res.send(page('Editar',`<h1>Editar Produto #${p.id}</h1><div class="card"><form method="post"><input name="nome" value="${safe(p.nome)}"><input name="gb" value="${safe(p.gb||'')}"><input name="validade" value="${safe(p.validade||'')}"><input name="preco" value="${money(p.preco)}"><textarea name="descricao">${safe(p.descricao||'')}</textarea><label><input type="checkbox" name="destaque" value="1" ${p.destaque?'checked':''}> Destaque</label><br><label><input type="checkbox" name="ativo" value="1" ${p.ativo?'checked':''}> Ativo</label><br><label><input type="checkbox" name="manual" value="1" ${p.permite_manual_sem_estoque?'checked':''}> Permitir venda manual sem estoque</label><br><button>Salvar</button></form></div>`)); });
app.post('/admin/produtos/:id/editar',auth,(req,res)=>{ db.prepare('UPDATE produtos SET nome=?,gb=?,validade=?,preco=?,descricao=?,destaque=?,ativo=?,permite_manual_sem_estoque=? WHERE id=?').run(req.body.nome,req.body.gb||'',req.body.validade||'',Number(String(req.body.preco).replace(',','.')),req.body.descricao||'',req.body.destaque?1:0,req.body.ativo?1:0,req.body.manual?1:0,req.params.id); res.redirect('/admin/produtos'); });
app.post('/admin/produtos/:id/apagar',auth,(req,res)=>{ db.prepare('UPDATE produtos SET ativo=0 WHERE id=?').run(req.params.id); res.redirect('/admin/produtos'); });

app.get('/admin/estoque',auth,(req,res)=>{ const ps=db.prepare('SELECT * FROM produtos WHERE ativo=1 ORDER BY nome').all(); const opts=ps.map(p=>`<option value="${p.id}">${safe(p.nome)} - estoque ${estoqueProduto(p.id)}</option>`).join(''); const rows=db.prepare('SELECT e.*,p.nome produto FROM estoque_qr e LEFT JOIN produtos p ON p.id=e.produto_id ORDER BY e.id DESC LIMIT 500').all().map(e=>`<tr><td>#${e.id}</td><td>${safe(e.produto)}</td><td><span class="pill">${safe(e.status)}</span></td><td>${e.arquivo?`<a href="/files/${encodeURIComponent(path.basename(e.arquivo))}" target="_blank">Ver QR</a>`:'Texto'}</td><td>${e.pedido_id||'-'}</td><td><form method="post" action="/admin/estoque/${e.id}/apagar" onsubmit="return confirm('Apagar QR?')"><button class="red">Apagar</button></form></td></tr>`).join(''); res.send(page('Estoque',`<h1>📥 Estoque QR</h1><div class="card"><form method="post" enctype="multipart/form-data"><select name="produto_id">${opts}</select><input type="file" name="qr" accept="image/*"><textarea name="codigo_texto" placeholder="Código texto opcional"></textarea><button class="green">Adicionar QR</button></form></div><div class="card"><table><tr><th>ID</th><th>Produto</th><th>Status</th><th>QR</th><th>Pedido</th><th>Ações</th></tr>${rows}</table></div>`)); });
app.post('/admin/estoque',auth,upload.single('qr'),(req,res)=>{ const arquivo=req.file?req.file.filename:''; db.prepare('INSERT INTO estoque_qr(produto_id,arquivo,codigo_texto,status) VALUES(?,?,?,"DISPONIVEL")').run(req.body.produto_id,arquivo,req.body.codigo_texto||''); res.redirect('/admin/estoque'); });
app.post('/admin/estoque/:id/apagar',auth,(req,res)=>{ const e=db.prepare('SELECT * FROM estoque_qr WHERE id=?').get(req.params.id); if(e?.arquivo){ try{fs.unlinkSync(path.join(UPLOAD_DIR,path.basename(e.arquivo)))}catch{} } db.prepare('DELETE FROM estoque_qr WHERE id=?').run(req.params.id); res.redirect('/admin/estoque'); });

app.get('/admin/pedidos',auth,(req,res)=>{ const status=req.query.status; const rows=(status?db.prepare('SELECT * FROM pedidos WHERE status=? ORDER BY id DESC LIMIT 500').all(status):db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 500').all()).map(p=>`<tr><td>#${p.id}</td><td>${safe(p.cliente_nome||'-')}<br>${safe(p.cliente_telefone||'-')}</td><td>${safe(p.produto_nome)}</td><td>${brl(p.valor)}</td><td><span class="pill">${safe(p.status)}</span></td><td><a class="btn green" href="/admin/pedidos/${p.id}/entregar">Entregar</a><form style="display:inline" method="post" action="/admin/pedidos/${p.id}/cancelar"><button class="red">Cancelar</button></form></td></tr>`).join(''); res.send(page('Pedidos',`<h1>📋 Pedidos</h1><div class="card"><table><tr><th>ID</th><th>Cliente</th><th>Produto</th><th>Valor</th><th>Status</th><th>Ações</th></tr>${rows}</table></div>`)); });
app.get('/admin/pedidos/:id/entregar',auth,(req,res)=>{ const p=db.prepare('SELECT * FROM pedidos WHERE id=?').get(req.params.id); res.send(page('Entregar',`<h1>📤 Entregar pedido #${safe(req.params.id)}</h1><div class="card"><form method="post" enctype="multipart/form-data"><textarea name="texto" rows="8">✅ Seu eSIM foi liberado!\n\nPedido #${p?.id||''}\nPlano: ${safe(p?.produto_nome||'')}</textarea><input type="file" name="qr" accept="image/*"><button class="green">Enviar ao cliente</button></form></div>`)); });
app.post('/admin/pedidos/:id/entregar',auth,upload.single('qr'),async(req,res)=>{ await entregarPedido(Number(req.params.id), req.body.texto||'', req.file?path.join(UPLOAD_DIR,req.file.filename):''); res.redirect('/admin/pedidos'); });
app.post('/admin/pedidos/:id/cancelar',auth,(req,res)=>{ db.prepare('UPDATE pedidos SET status="CANCELADO" WHERE id=?').run(req.params.id); res.redirect('/admin/pedidos'); });

app.get('/admin/clientes',auth,(req,res)=>{ const rows=db.prepare('SELECT * FROM clientes ORDER BY id DESC LIMIT 500').all().map(c=>`<tr><td>#${c.id}</td><td>${safe(c.nome)}</td><td>${safe(c.telefone)}</td><td>${safe(c.criado_em)}</td></tr>`).join(''); res.send(page('Clientes',`<h1>👥 Clientes</h1><div class="card"><table><tr><th>ID</th><th>Nome</th><th>Telefone</th><th>Criado</th></tr>${rows}</table></div>`)); });
app.get('/admin/mensagem',auth,(req,res)=>res.send(page('Mensagem',`<h1>📢 Mensagem em massa</h1><div class="card"><form method="post"><textarea name="texto" rows="8" placeholder="Mensagem para clientes"></textarea><button class="orange">Enviar para todos</button></form></div>`)));
app.post('/admin/mensagem',auth,async(req,res)=>{ const texto=String(req.body.texto||'').trim(); if(texto){ const cs=db.prepare('SELECT * FROM clientes').all(); let ok=0; for(const c of cs){ if(await sendText(c.jid||phoneToJid(c.telefone), texto)) ok++; } db.prepare('INSERT INTO mensagens_salvas(texto,total) VALUES(?,?)').run(texto,ok); } res.redirect('/admin/mensagem'); });
app.get('/admin/senha',auth,(req,res)=>res.send(page('Senha',`<h1>🔐 Alterar senha</h1><div class="card"><form method="post"><input name="nova" type="password" placeholder="Nova senha"><button>Salvar</button></form></div>`)));
app.post('/admin/senha',auth,(req,res)=>{ if(req.body.nova) setConfig('admin_hash',bcrypt.hashSync(req.body.nova,10)); res.redirect('/admin'); });
app.get('/admin/backup',auth,(req,res)=>{ const files=fs.readdirSync(BACKUP_DIR).filter(f=>f.endsWith('.db')).sort().reverse(); const rows=files.map(f=>`<tr><td>${safe(f)}</td><td><a class="btn" href="/admin/backup/download/${encodeURIComponent(f)}">Baixar</a></td></tr>`).join(''); res.send(page('Backup',`<h1>💾 Backup</h1><div class="card"><form method="post" action="/admin/backup"><button class="green">Criar backup agora</button></form></div><table><tr><th>Arquivo</th><th>Ação</th></tr>${rows}</table>`)); });
app.post('/admin/backup',auth,(req,res)=>{ const f=`backup_esim_${new Date().toISOString().replace(/[:.]/g,'-')}.db`; db.pragma('wal_checkpoint(FULL)'); fs.copyFileSync(DB_PATH,path.join(BACKUP_DIR,f)); res.redirect('/admin/backup'); });
app.get('/admin/backup/download/:file',auth,(req,res)=>{ const f=path.basename(req.params.file); res.download(path.join(BACKUP_DIR,f)); });
app.post('/admin/reset-whatsapp',auth,(req,res)=>{ fs.rmSync(AUTH_DIR,{recursive:true,force:true}); fs.mkdirSync(AUTH_DIR,{recursive:true}); res.send(page('Reset','<div class="card">Sessão apagada. Reinicie o serviço e abra /qr.</div>')); });

app.get('/webhook/pixgo', (req,res)=>res.status(200).send('Webhook PixGo online ✅'));
app.post('/webhook/pixgo', async (req,res)=>{
  try {
    const b = req.body || {};
    console.log('WEBHOOK PIXGO:', b);
    const event = req.headers['x-webhook-event'] || b.event;
    if (event && !['payment.completed','payment.paid','payment.approved'].includes(event)) {
      return res.status(200).json({success:true,ignored:'event'});
    }

    const d = b.data || b;
    const ref = b.external_reference || b.externalReference || b.external_id || b.externalId ||
                d.external_reference || d.externalReference || d.external_id || d.externalId ||
                b.metadata?.external_reference || d.metadata?.external_reference;
    const status = b.status || b.payment_status || d.status || d.payment_status || event;
    if (!ref) return res.status(200).json({success:true,ignored:'no_ref'});

    // No WhatsApp corrigido enviamos o ID do pedido igual ao Telegram.
    // Também mantemos busca por external_ref para compatibilidade com pedidos antigos.
    const p = db.prepare('SELECT * FROM pedidos WHERE id=? OR external_ref=?').get(String(ref), String(ref));
    if (p && isPaidStatus(status) && !['PAGO','ENTREGUE','AGUARDANDO_ENVIO'].includes(p.status)) {
      db.prepare('UPDATE pedidos SET status="PAGO", pago_em=CURRENT_TIMESTAMP WHERE id=?').run(p.id);
      await notifyAdmins(`💰 *PAGAMENTO APROVADO*\n\nPedido: #${p.id}\nCliente: ${p.cliente_telefone}\nPlano: ${p.produto_nome}\nValor: ${brl(p.valor)}`);
      await entregarPedido(p.id);
    }
    res.status(200).json({success:true});
  } catch(e) {
    console.log('Webhook erro:', e.message);
    res.status(200).json({success:true,error:e.message});
  }
});

initDB();
startWhatsApp().catch(e=>console.log('Erro iniciar WhatsApp:', e.message));
app.listen(PORT,()=>console.log(`Servidor online na porta ${PORT}`));
