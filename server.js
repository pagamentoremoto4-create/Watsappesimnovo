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
const { execFileSync } = require('child_process');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadContentFromMessage
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
const DEFAULT_MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || '';
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 30);

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
let whatsappStarting = false;
let reconnectTimer = null;
const userState = new Map();
const adminDeliveryState = new Map();

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function money(v) { return Number(v || 0).toFixed(2).replace('.', ','); }
function safe(s) { return String(s ?? '').replace(/[&<>'"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m])); }
function phoneToJid(phone) { const n = normalizePhone(phone); return n ? `${n}@s.whatsapp.net` : ''; }
function jidToPhone(jid) { return normalizePhone(String(jid || '').split('@')[0].split(':')[0]); }
function normalizePhone(v) { let n = onlyDigits(v).replace(/^0+/, ''); if ((n.length === 10 || n.length === 11) && !n.startsWith('55')) n = '55' + n; return n; }
function unwrapMessage(m) {
  let msg = m.message || {};
  if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
  if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
  if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
  if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
  return msg;
}
function getText(m) {
  const msg = unwrapMessage(m);
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
}
function isPaidStatus(s) { return ['paid','approved','completed','aprovado','pago','payment.completed','payment.paid','payment.approved'].includes(String(s || '').toLowerCase()); }

function isAdminPhone(phone) { return ADMIN_NUMBERS.includes(normalizePhone(phone)); }
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function saveIncomingImage(msg) {
  const content = unwrapMessage(msg);
  const imageMessage = content.imageMessage;
  if (!imageMessage) return '';
  const stream = await downloadContentFromMessage(imageMessage, 'image');
  const buffer = await streamToBuffer(stream);
  const fileName = `entrega_admin_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
function pedidoResumo(p) {
  if (!p) return '';
  return `#${p.id} - ${p.produto_nome || 'Pedido'}\nCliente: ${p.cliente_telefone || '-'}\nValor: ${brl(p.valor)}\nStatus: ${p.status}`;
}
async function listarPendentesAdmin(jid) {
  const rows = db.prepare("SELECT * FROM pedidos WHERE status IN ('AGUARDANDO_ENVIO','PAGO') ORDER BY id ASC LIMIT 30").all();
  if (!rows.length) return sendText(jid, '✅ Nenhum pedido manual pendente.');
  const txt = '📋 *Pedidos pendentes para entrega*\n\n' + rows.map(p => `${pedidoResumo(p)}\n➡️ /entregar ${p.id}`).join('\n\n');
  return sendText(jid, txt);
}
async function iniciarEntregaAdmin(jid, pedidoId) {
  const p = db.prepare("SELECT * FROM pedidos WHERE id=?").get(Number(pedidoId));
  if (!p) return sendText(jid, '❌ Pedido não encontrado.');
  if (['ENTREGUE','CANCELADO'].includes(p.status)) return sendText(jid, `❌ Pedido #${p.id} está com status ${p.status}.`);
  adminDeliveryState.set(jid, { pedido_id: p.id });
  return sendText(jid, `📤 *Entrega manual pelo WhatsApp*\n\n${pedidoResumo(p)}\n\nEnvie agora a *foto do QR Code* ou uma mensagem de texto com os dados da entrega.\n\nPara cancelar esta ação, digite *cancelar*.`);
}
async function comandosAdminWhatsApp(jid) {
  return sendText(jid, `🔐 *Comandos Admin WhatsApp*\n\n/pendentes - listar pedidos para entregar\n/entregar ID - iniciar entrega manual\n/cancelar ID - cancelar pedido\n/pedido ID - ver dados do pedido\n\nExemplo:\n/entregar 123`);
}

function initDB() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS configs (chave TEXT PRIMARY KEY, valor TEXT, atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT UNIQUE, nome TEXT, jid TEXT, saldo REAL DEFAULT 0, criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
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
    tipo_pagamento TEXT DEFAULT 'compra',
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
  try { db.prepare('ALTER TABLE clientes ADD COLUMN saldo REAL DEFAULT 0').run(); } catch(e) {}
  try { db.prepare("ALTER TABLE pedidos ADD COLUMN tipo_pagamento TEXT DEFAULT 'compra'").run(); } catch(e) {}
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

function limparBackupsAntigos() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db') || f.endsWith('.tar.gz'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a,b) => b.t - a.t);
    for (const old of files.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch(e) {}
    }
  } catch(e) { console.log('Erro limpar backups:', e.message); }
}
function criarBackupDB(prefix='backup_auto') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const f = `${prefix}_${new Date().toISOString().replace(/[:.]/g,'-')}.db`;
  db.pragma('wal_checkpoint(FULL)');
  fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, f));
  limparBackupsAntigos();
  return f;
}
function criarBackupCompleto(prefix='backup_completo') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const nome = `${prefix}_${new Date().toISOString().replace(/[:.]/g,'-')}.tar.gz`;
  const destino = path.join(BACKUP_DIR, nome);
  db.pragma('wal_checkpoint(FULL)');
  try {
    execFileSync('tar', ['-czf', destino, '-C', DATA_DIR, path.basename(DB_PATH), path.basename(UPLOAD_DIR)], { stdio: 'ignore' });
  } catch(e) {
    // Se o tar não estiver disponível, garante ao menos backup do banco.
    return criarBackupDB(prefix);
  }
  limparBackupsAntigos();
  return nome;
}
function iniciarBackupAutomatico() {
  setTimeout(async () => {
    try {
      const f = criarBackupCompleto('backup_auto');
      console.log('BACKUP AUTOMATICO:', f);
      if (ADMIN_NUMBERS.length) await notifyAdmins(`💾 Backup automático criado com sucesso.\nArquivo: ${f}`);
    } catch(e) { console.log('Erro backup automático:', e.message); }
  }, 60000);
  setInterval(async () => {
    try {
      const f = criarBackupCompleto('backup_auto');
      console.log('BACKUP AUTOMATICO:', f);
      if (ADMIN_NUMBERS.length) await notifyAdmins(`💾 Backup automático criado com sucesso.\nArquivo: ${f}`);
    } catch(e) { console.log('Erro backup automático:', e.message); }
  }, Math.max(1, BACKUP_INTERVAL_HOURS) * 60 * 60 * 1000);
}
async function sendMenu(to, cliente) {
  const texto = menuPrincipal(cliente);
  const menuFile = getConfig('menu_image_file', '');
  const menuUrl = getConfig('menu_image_url', DEFAULT_MENU_IMAGE_URL);

  if (menuFile) {
    const filePath = path.join(UPLOAD_DIR, path.basename(menuFile));
    if (fs.existsSync(filePath)) {
      try { await sock.sendMessage(to, { image: fs.readFileSync(filePath), caption: texto }); return true; }
      catch(e) { console.log('Erro enviar imagem menu local:', e.message); }
    }
  }

  if (menuUrl) {
    try { await sock.sendMessage(to, { image: { url: menuUrl }, caption: texto }); return true; }
    catch(e) { console.log('Erro enviar imagem menu URL:', e.message); }
  }
  return sendText(to, texto);
}

function upsertClient(phone, nome, jid) {
  const p = normalizePhone(phone);
  db.prepare(`INSERT INTO clientes(telefone,nome,jid) VALUES(?,?,?) ON CONFLICT(telefone) DO UPDATE SET nome=excluded.nome,jid=excluded.jid`).run(p, nome || 'Cliente', jid || phoneToJid(p));
  return db.prepare('SELECT * FROM clientes WHERE telefone=?').get(p);
}
function estoqueProduto(pid) { return db.prepare("SELECT COUNT(*) c FROM estoque_qr WHERE produto_id=? AND status='DISPONIVEL'").get(pid).c; }
function produtoComEstoque(pid) { const p = db.prepare('SELECT * FROM produtos WHERE id=? AND ativo=1').get(pid); if (!p) return null; p.estoque = estoqueProduto(pid); return p; }
function menuPrincipal(cliente=null) { const saldoTxt = cliente ? `\n💰 Saldo: *${brl(cliente.saldo || 0)}*` : ''; return `👋 Bem-vindo à *${LOJA_NOME}*${saldoTxt}\n\n1️⃣ Comprar eSIM\n2️⃣ Meus Pedidos\n3️⃣ Suporte\n4️⃣ Depositar saldo\n5️⃣ Meu saldo\n\nDigite o número da opção.`; }
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
    db.prepare('UPDATE pedidos SET status=?, entrega_manual_texto=?, entregue_em=CURRENT_TIMESTAMP WHERE id=?').run('ENTREGUE', manualTexto || '', pedido.id);
    const cap = manualTexto || `✅ Seu eSIM foi liberado!\n\nPedido #${pedido.id}\nPlano: ${pedido.produto_nome}`;
    if (manualArquivo) await sendImage(jid, manualArquivo, cap); else await sendText(jid, cap);
    await notifyAdmins(`✅ *PEDIDO ENTREGUE MANUALMENTE*\n\nPedido: #${pedido.id}\nCliente: ${pedido.cliente_telefone}\nPlano: ${pedido.produto_nome}`);
    return;
  }
  const qr = db.prepare("SELECT * FROM estoque_qr WHERE produto_id=? AND status='DISPONIVEL' ORDER BY id ASC LIMIT 1").get(pedido.produto_id);
  if (!qr) {
    db.prepare('UPDATE pedidos SET status=? WHERE id=?').run('AGUARDANDO_ENVIO', pedido.id);
    await sendText(jid, `✅ Pagamento confirmado!\n\n📦 Pedido #${pedido.id}\n📱 ${pedido.produto_nome}\n\n⚠️ Seu pedido entrou para entrega manual.\n⏱ Prazo: ${PRAZO_MANUAL}`);
    await notifyAdmins(`🚨 *PEDIDO MANUAL - ESTOQUE ZERADO*\n\nPedido: #${pedido.id}\nCliente: ${pedido.cliente_telefone}\nPlano: ${pedido.produto_nome}\nValor: ${brl(pedido.valor)}\n\nUse /pendentes ou /entregar ${pedido.id} aqui no WhatsApp, ou acesse /admin/pedidos.`);
    return;
  }
  db.prepare('UPDATE estoque_qr SET status=?, pedido_id=?, usado_em=CURRENT_TIMESTAMP WHERE id=?').run('VENDIDO', pedido.id, qr.id);
  db.prepare('UPDATE pedidos SET status=?, qr_estoque_id=?, entregue_em=CURRENT_TIMESTAMP WHERE id=?').run('ENTREGUE', qr.id, pedido.id);
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
  const phone = jidToPhone(jid);
  const cliente = upsertClient(phone, msg.pushName || 'Cliente', jid);
  const state = userState.get(jid);
  const lower = text.toLowerCase();
  const isAdmin = isAdminPhone(phone);
  const hasImage = !!unwrapMessage(msg).imageMessage;

  if (isAdmin && adminDeliveryState.has(jid)) {
    if (['cancelar','menu','sair'].includes(lower)) {
      adminDeliveryState.delete(jid);
      return sendText(jid, '❌ Entrega manual cancelada.');
    }
    const stAdmin = adminDeliveryState.get(jid);
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(stAdmin.pedido_id);
    if (!pedido) {
      adminDeliveryState.delete(jid);
      return sendText(jid, '❌ Pedido não encontrado.');
    }
    try {
      const imgPath = await saveIncomingImage(msg);
      const textoEntrega = text || `✅ Seu eSIM foi liberado!\n\nPedido #${pedido.id}\nPlano: ${pedido.produto_nome}`;
      await entregarPedido(pedido.id, textoEntrega, imgPath);
      adminDeliveryState.delete(jid);
      return sendText(jid, `✅ Pedido #${pedido.id} entregue ao cliente ${pedido.cliente_telefone}.`);
    } catch (e) {
      console.log('ERRO ENTREGA ADMIN WHATSAPP:', e.message);
      return sendText(jid, `❌ Erro ao entregar pedido #${pedido.id}: ${e.message}`);
    }
  }

  if (!text && !hasImage) return;

  if (isAdmin && lower.startsWith('/')) {
    const parts = lower.split(/\s+/).filter(Boolean);
    const cmd = parts[0];
    const id = parts[1];
    if (cmd === '/pendentes') return listarPendentesAdmin(jid);
    if (cmd === '/comandos' || cmd === '/admin' || cmd === '/ajuda') return comandosAdminWhatsApp(jid);
    if (cmd === '/entregar') {
      if (!id) return sendText(jid, 'Use assim: /entregar ID_DO_PEDIDO');
      return iniciarEntregaAdmin(jid, id);
    }
    if (cmd === '/cancelar') {
      if (!id) return sendText(jid, 'Use assim: /cancelar ID_DO_PEDIDO');
      db.prepare('UPDATE pedidos SET status=? WHERE id=?').run('CANCELADO', Number(id));
      return sendText(jid, `✅ Pedido #${id} cancelado.`);
    }
    if (cmd === '/pedido') {
      if (!id) return sendText(jid, 'Use assim: /pedido ID_DO_PEDIDO');
      const p = db.prepare('SELECT * FROM pedidos WHERE id=?').get(Number(id));
      if (!p) return sendText(jid, '❌ Pedido não encontrado.');
      return sendText(jid, `📦 *Pedido*\n\n${pedidoResumo(p)}\nTipo: ${p.tipo_pagamento || '-'}\nCriado: ${p.criado_em || '-'}\nPago: ${p.pago_em || '-'}\n\nPara entregar: /entregar ${p.id}`);
    }
  }

  if (['menu','oi','olá','ola','start','inicio','início','cancelar'].includes(lower)) { userState.delete(jid); return sendMenu(jid, cliente); }
  if (lower === '1' && !state) { userState.set(jid, { step: 'planos' }); return sendText(jid, listaPlanos()); }
  if (lower === '2' && !state) {
    const ps = db.prepare('SELECT * FROM pedidos WHERE cliente_id=? ORDER BY id DESC LIMIT 10').all(cliente.id);
    if (!ps.length) return sendText(jid, '📦 Você ainda não tem pedidos.');
    return sendText(jid, '📦 *Meus pedidos*\n\n' + ps.map(p => `#${p.id} - ${p.produto_nome}\n${brl(p.valor)} - ${p.status}`).join('\n\n'));
  }
  if (lower === '3' && !state) return sendText(jid, `🆘 Suporte Centralunlocker\n\nFale com: https://wa.me/${SUPORTE_WHATSAPP}`);
  if (lower === '4' && !state) {
    userState.set(jid, { step: 'depositar_saldo' });
    return sendText(jid, '💳 *Depositar saldo*\n\nDigite o valor que deseja adicionar.\nExemplo: *20*\n\nDigite *menu* para cancelar.');
  }
  if (lower === '5' && !state) {
    const c = db.prepare('SELECT * FROM clientes WHERE id=?').get(cliente.id);
    return sendText(jid, `💰 *Meu saldo*\n\nSaldo atual: *${brl(c?.saldo || 0)}*`);
  }
  if (state?.step === 'depositar_saldo') {
    const valor = Number(text.replace(',', '.').replace(/[^0-9.]/g, ''));
    if (!valor || valor < 1) return sendText(jid, '❌ Valor inválido. Digite apenas números. Exemplo: *20*');
    const external_ref = String(Date.now()) + '_' + uuidv4();
    const info = db.prepare(`INSERT INTO pedidos(external_ref,cliente_id,cliente_nome,cliente_telefone,cliente_jid,produto_id,produto_nome,valor,status,tipo_pagamento) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(external_ref, cliente.id, cliente.nome, cliente.telefone, jid, null, 'Depósito de saldo', valor, 'PENDENTE', 'deposito_saldo');
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(info.lastInsertRowid);
    userState.delete(jid);
    await sendText(jid, `💰 Gerando PIX de depósito...\n\nValor: ${brl(valor)}`);
    try {
      const copia = await createPix(pedido, { nome: 'Depósito de saldo' });
      await sendText(jid, `✅ *PIX DE DEPÓSITO GERADO*\n\n📦 Pedido #${pedido.id}\n💰 Valor: ${brl(valor)}\n\n📋 O código PIX será enviado na próxima mensagem.`);
      await sendText(jid, `${copia}`);
      await notifyAdmins(`💳 *DEPÓSITO DE SALDO INICIADO*\n\nPedido: #${pedido.id}\nCliente: ${cliente.telefone}\nValor: ${brl(valor)}`);
    } catch(e) {
      console.log('ERRO PIXGO DEPÓSITO:', e.response?.data || e.responseData || e.message);
      db.prepare('UPDATE pedidos SET status=? WHERE id=?').run('ERRO_PIX', pedido.id);
      await sendText(jid, `❌ Erro ao gerar PIX de depósito.\n\nMotivo: ${e.message}`);
    }
    return;
  }

  if (state?.step === 'planos') {
    const produto = getProdutoByChoice(text);
    if (!produto) return sendText(jid, '❌ Plano inválido. Digite o número do plano ou *menu* para voltar.');
    if (produto.estoque <= 0 && !produto.permite_manual_sem_estoque) return sendText(jid, '❌ Esse plano está esgotado no momento.');
    userState.set(jid, { step: 'confirmar', produto_id: produto.id });
    const entrega = produto.estoque > 0 ? '✅ Entrega automática' : `⚠️ Entrega manual\n⏱ Prazo: ${PRAZO_MANUAL}`;
    return sendText(jid, `📱 *Plano Selecionado*\n\n${produto.nome}\n📅 ${produto.validade || '30 dias'}\n💰 ${brl(produto.preco)}\n📦 Estoque: ${produto.estoque}\n${entrega}\n\n1️⃣ Gerar PIX\n2️⃣ Comprar com saldo\n3️⃣ Voltar`);
  }
  if (state?.step === 'confirmar') {
    const opcaoConfirmar = text.toLowerCase().trim();
    const querVoltar = opcaoConfirmar === '3' || opcaoConfirmar.startsWith('3️⃣') || opcaoConfirmar.includes('voltar');
    const querSaldo = opcaoConfirmar === '2' || opcaoConfirmar.startsWith('2️⃣') || opcaoConfirmar.includes('saldo');
    const querPix = opcaoConfirmar === '1' || opcaoConfirmar.startsWith('1️⃣') || opcaoConfirmar.includes('gerar pix') || opcaoConfirmar.includes('pix') || opcaoConfirmar.includes('comprar');
    if (querVoltar) { userState.set(jid, { step: 'planos' }); return sendText(jid, listaPlanos()); }
    if (!querPix && !querSaldo) return sendText(jid, 'Digite *1* para gerar PIX, *2* para comprar com saldo ou *3* para voltar.');
    const produto = produtoComEstoque(state.produto_id);
    if (!produto) { userState.delete(jid); return sendText(jid, '❌ Produto indisponível.'); }
    if (produto.estoque <= 0 && !produto.permite_manual_sem_estoque) return sendText(jid, '❌ Esse plano está esgotado no momento.');

    if (querSaldo) {
      const clienteAtual = db.prepare('SELECT * FROM clientes WHERE id=?').get(cliente.id);
      const saldoAtual = Number(clienteAtual?.saldo || 0);
      if (saldoAtual < Number(produto.preco)) {
        const falta = Number(produto.preco) - saldoAtual;
        return sendText(jid, `❌ Saldo insuficiente.\n\n💰 Seu saldo: *${brl(saldoAtual)}*\n📱 Produto: *${brl(produto.preco)}*\nFalta: *${brl(falta)}*\n\nDigite *4* no menu para depositar saldo ou escolha *1* para pagar direto no PIX.`);
      }
      const external_ref = String(Date.now()) + '_' + uuidv4();
      const tx = db.transaction(() => {
        db.prepare('UPDATE clientes SET saldo = saldo - ? WHERE id=?').run(Number(produto.preco), cliente.id);
        const info = db.prepare(`INSERT INTO pedidos(external_ref,cliente_id,cliente_nome,cliente_telefone,cliente_jid,produto_id,produto_nome,valor,status,tipo_pagamento,pago_em) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
          .run(external_ref, cliente.id, cliente.nome, cliente.telefone, jid, produto.id, produto.nome, produto.preco, 'PAGO', 'saldo');
        return info.lastInsertRowid;
      });
      const pedidoId = tx();
      userState.delete(jid);
      const novoSaldo = db.prepare('SELECT saldo FROM clientes WHERE id=?').get(cliente.id).saldo;
      await sendText(jid, `✅ Compra aprovada com saldo!\n\n📦 Pedido #${pedidoId}\n📱 ${produto.nome}\n💰 Valor: ${brl(produto.preco)}\n💵 Saldo restante: ${brl(novoSaldo)}\n\nPreparando entrega...`);
      await notifyAdmins(`💰 *COMPRA COM SALDO*\n\nPedido: #${pedidoId}\nCliente: ${cliente.telefone}\nPlano: ${produto.nome}\nValor: ${brl(produto.preco)}`);
      await entregarPedido(pedidoId);
      return;
    }

    const external_ref = String(Date.now()) + '_' + uuidv4();
    const info = db.prepare(`INSERT INTO pedidos(external_ref,cliente_id,cliente_nome,cliente_telefone,cliente_jid,produto_id,produto_nome,valor,status,tipo_pagamento) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(external_ref, cliente.id, cliente.nome, cliente.telefone, jid, produto.id, produto.nome, produto.preco, 'PENDENTE', 'pix');
    const pedido = db.prepare('SELECT * FROM pedidos WHERE id=?').get(info.lastInsertRowid);
    userState.delete(jid);
    await sendText(jid, `💰 Gerando PIX...\n\nProduto: ${produto.nome}\nValor: ${brl(produto.preco)}`);
    try {
      const copia = await createPix(pedido, produto);
      if (!copia) return sendText(jid, '❌ Pix gerado, mas não recebi o copia e cola. Chame o suporte.');
      await sendText(jid, `✅ *PIX GERADO*\n\n📦 Pedido #${pedido.id}\n📱 ${produto.nome}\n💰 ${brl(produto.preco)}\n\n📋 O código PIX copia e cola será enviado na próxima mensagem.\n\n⏳ Após pagar, a entrega será automática ou manual conforme estoque.`);
      await sendText(jid, `${copia}`);
      await notifyAdmins(`🛒 *NOVA VENDA INICIADA*\n\nPedido: #${pedido.id}\nCliente: ${cliente.telefone}\nPlano: ${produto.nome}\nValor: ${brl(produto.preco)}`);
    } catch(e) {
      console.log('ERRO PIXGO:', e.response?.data || e.responseData || e.message);
      db.prepare('UPDATE pedidos SET status=? WHERE id=?').run('ERRO_PIX', pedido.id);
      await sendText(jid, `❌ Erro ao gerar PIX.\n\nMotivo: ${e.message}\n\nConfira PIXGO_API_KEY, BASE_URL e PIXGO_URL no Render.`);
    }
    return;
  }
  return sendMenu(jid, cliente);
}

async function startWhatsApp() {
  if (whatsappStarting) {
    console.log('Start WhatsApp ignorado: conexão já está iniciando.');
    return;
  }
  if (sock && conectado) {
    console.log('Start WhatsApp ignorado: já conectado.');
    return;
  }
  whatsappStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    try { sock?.ev?.removeAllListeners?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        qrBase64 = await QRCode.toDataURL(qr);
        conectado = false;
        console.log('QR WhatsApp atualizado. Abra /qr');
      }

      if (connection === 'open') {
        conectado = true;
        whatsappStarting = false;
        qrBase64 = null;
        console.log('WhatsApp conectado.');
      }

      if (connection === 'close') {
        conectado = false;
        whatsappStarting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log('WhatsApp conexão fechada. Código:', code || 'sem código');

        if (code !== DisconnectReason.loggedOut) {
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsApp().catch(e => console.log('Erro reconectar WhatsApp:', e.message));
          }, 8000);
        } else {
          console.log('Sessão desconectada. Abra /admin/whatsapp e clique para resetar.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        try { await tratarMensagem(m); }
        catch(e) { console.log('Erro mensagem:', e.message); }
      }
    });
  } catch (e) {
    whatsappStarting = false;
    console.log('Erro iniciar WhatsApp:', e.message);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startWhatsApp().catch(err => console.log('Erro reconectar WhatsApp:', err.message));
    }, 10000);
  }
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)}</title><style>
  body{margin:0;background:#07111f;color:#eaf0f8;font-family:Arial,sans-serif}.layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:#09101f;padding:18px;border-right:1px solid #24324b}.brand{font-weight:900;font-size:21px;margin-bottom:20px}.side a{display:block;color:#dbeafe;text-decoration:none;padding:11px;border-radius:12px;margin:5px 0}.side a:hover{background:#13223a}.main{padding:22px}.card{background:#101b31;border:1px solid #24324b;border-radius:18px;padding:16px;margin:14px 0;box-shadow:0 14px 35px rgba(0,0,0,.25)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric h1{margin:0;font-size:30px}.metric p{color:#97a6ba}input,select,textarea{width:100%;padding:11px;border-radius:12px;border:1px solid #334155;background:#08111f;color:white;margin:6px 0 12px}.btn,button{background:#2563eb;color:white;border:0;border-radius:11px;padding:9px 13px;text-decoration:none;font-weight:bold;display:inline-block;margin:2px;cursor:pointer}.green{background:#16a34a}.red{background:#dc2626}.orange{background:#ea580c}.muted{color:#97a6ba}table{width:100%;border-collapse:collapse;background:#08111f;border-radius:14px;overflow:hidden}td,th{padding:10px;border-bottom:1px solid #24324b;text-align:left}th{background:#13223a}.pill{padding:5px 9px;border-radius:999px;background:#1e40af;font-weight:bold}@media(max-width:800px){.layout{grid-template-columns:1fr}.side{position:relative}.main{padding:14px}}
  </style></head><body><div class="layout"><div class="side"><div class="brand">📱 Centralunlocker</div><a href="/admin">📊 Dashboard</a><a href="/admin/produtos">📦 Produtos</a><a href="/admin/estoque">📥 Estoque QR</a><a href="/admin/pedidos">📋 Pedidos</a><a href="/admin/pedidos?status=AGUARDANDO_ENVIO">🟡 Pedidos Manuais</a><a href="/admin/clientes">👥 Clientes</a><a href="/admin/mensagem">📢 Mensagem</a><a href="/admin/menu-imagem">🖼️ Imagem do Menu</a><a href="/admin/backup">💾 Backup</a><a href="/admin/financeiro">💵 Financeiro</a><a href="/admin/whatsapp">🔳 QR WhatsApp</a><a href="/admin/senha">🔐 Alterar senha</a><a href="/admin/logout">🚪 Sair</a></div><div class="main">${body}</div></div></body></html>`;
}

app.get('/', (req,res)=>res.redirect('/admin'));
function qrWhatsappHtml(msg='') {
  return `<h1>🔳 QR WhatsApp</h1>
  ${msg ? `<div class="card"><b>${safe(msg)}</b></div>` : ''}
  <div class="card">
    <p>Status: <b>${conectado ? 'Conectado ✅' : 'Aguardando QR'}</b></p>
    ${qrBase64 ? `<img src="${qrBase64}" style="max-width:320px;width:100%;background:white;padding:10px;border-radius:12px">` : '<p>Se não aparecer QR, clique em <b>Gerar novo QR</b> e aguarde alguns segundos.</p>'}
    <p class="muted">Esta função apaga somente a sessão do WhatsApp. Não apaga banco, clientes, pedidos, saldo, estoque, imagens nem backups.</p>
  </div>
  <div class="card">
    <h2>Reconectar WhatsApp</h2>
    <form method="post" action="/admin/reset-whatsapp" onsubmit="return confirm('Apagar somente a sessão do WhatsApp e gerar QR novo?')">
      <button class="red">🗑 Apagar sessão antiga e gerar novo QR</button>
    </form>
    <br>
    <a class="btn" href="/qr">🔄 Atualizar QR</a>
  </div>`;
}
app.get('/qr', auth, async (req,res)=>res.send(page('QR WhatsApp', qrWhatsappHtml())));
app.get('/admin/whatsapp', auth, async (req,res)=>res.send(page('QR WhatsApp', qrWhatsappHtml())));
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
app.post('/admin/estoque',auth,upload.single('qr'),(req,res)=>{ const arquivo=req.file?req.file.filename:''; db.prepare('INSERT INTO estoque_qr(produto_id,arquivo,codigo_texto,status) VALUES(?,?,?,?)').run(req.body.produto_id,arquivo,req.body.codigo_texto||'', 'DISPONIVEL'); res.redirect('/admin/estoque'); });
app.post('/admin/estoque/:id/apagar',auth,(req,res)=>{ const e=db.prepare('SELECT * FROM estoque_qr WHERE id=?').get(req.params.id); if(e?.arquivo){ try{fs.unlinkSync(path.join(UPLOAD_DIR,path.basename(e.arquivo)))}catch{} } db.prepare('DELETE FROM estoque_qr WHERE id=?').run(req.params.id); res.redirect('/admin/estoque'); });

app.get('/admin/pedidos',auth,(req,res)=>{ const status=req.query.status; const rows=(status?db.prepare('SELECT * FROM pedidos WHERE status=? ORDER BY id DESC LIMIT 500').all(status):db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 500').all()).map(p=>`<tr><td>#${p.id}</td><td>${safe(p.cliente_nome||'-')}<br>${safe(p.cliente_telefone||'-')}</td><td>${safe(p.produto_nome)}</td><td>${brl(p.valor)}</td><td><span class="pill">${safe(p.status)}</span></td><td>${safe(p.tipo_pagamento || 'compra')}</td><td><a class="btn green" href="/admin/pedidos/${p.id}/entregar">Entregar</a><form style="display:inline" method="post" action="/admin/pedidos/${p.id}/cancelar"><button class="red">Cancelar</button></form></td></tr>`).join(''); res.send(page('Pedidos',`<h1>📋 Pedidos</h1><div class="card"><table><tr><th>ID</th><th>Cliente</th><th>Produto</th><th>Valor</th><th>Status</th><th>Tipo</th><th>Ações</th></tr>${rows}</table></div>`)); });
app.get('/admin/pedidos/:id/entregar',auth,(req,res)=>{ const p=db.prepare('SELECT * FROM pedidos WHERE id=?').get(req.params.id); res.send(page('Entregar',`<h1>📤 Entregar pedido #${safe(req.params.id)}</h1><div class="card"><form method="post" enctype="multipart/form-data"><textarea name="texto" rows="8">✅ Seu eSIM foi liberado!\n\nPedido #${p?.id||''}\nPlano: ${safe(p?.produto_nome||'')}</textarea><input type="file" name="qr" accept="image/*"><button class="green">Enviar ao cliente</button></form></div>`)); });
app.post('/admin/pedidos/:id/entregar',auth,upload.single('qr'),async(req,res)=>{ await entregarPedido(Number(req.params.id), req.body.texto||'', req.file?path.join(UPLOAD_DIR,req.file.filename):''); res.redirect('/admin/pedidos'); });
app.post('/admin/pedidos/:id/cancelar',auth,(req,res)=>{ db.prepare('UPDATE pedidos SET status=? WHERE id=?').run('CANCELADO', req.params.id); res.redirect('/admin/pedidos'); });

app.get('/admin/clientes',auth,(req,res)=>{ const rows=db.prepare('SELECT * FROM clientes ORDER BY id DESC LIMIT 500').all().map(c=>`<tr><td>#${c.id}</td><td>${safe(c.nome)}</td><td>${safe(c.telefone)}</td><td>${brl(c.saldo || 0)}</td><td>${safe(c.criado_em)}</td><td><form method="post" action="/admin/clientes/saldo" style="display:flex;gap:6px;align-items:center"><input type="hidden" name="id" value="${c.id}"><input name="valor" placeholder="Valor" style="max-width:90px;margin:0"><button class="green">Add saldo</button></form></td></tr>`).join(''); res.send(page('Clientes',`<h1>👥 Clientes</h1><div class="card"><p class="muted">Adicione saldo manual para cliente comprar com saldo no WhatsApp.</p><table><tr><th>ID</th><th>Nome</th><th>Telefone</th><th>Saldo</th><th>Criado</th><th>Ação</th></tr>${rows}</table></div>`)); });
app.post('/admin/clientes/saldo',auth,async(req,res)=>{ const id=Number(req.body.id); const valor=Number(String(req.body.valor||'0').replace(',','.')); if(id && valor){ db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id=?').run(valor,id); const c=db.prepare('SELECT * FROM clientes WHERE id=?').get(id); if(c) await sendText(c.jid || phoneToJid(c.telefone), `💰 Saldo adicionado!

Valor: *${brl(valor)}*
Saldo atual: *${brl(c.saldo || 0)}*`); } res.redirect('/admin/clientes'); });
app.get('/admin/mensagem',auth,(req,res)=>res.send(page('Mensagem',`<h1>📢 Mensagem em massa</h1><div class="card"><form method="post"><textarea name="texto" rows="8" placeholder="Mensagem para clientes"></textarea><button class="orange">Enviar para todos</button></form></div>`)));
app.post('/admin/mensagem',auth,async(req,res)=>{ const texto=String(req.body.texto||'').trim(); if(texto){ const cs=db.prepare('SELECT * FROM clientes').all(); let ok=0; for(const c of cs){ if(await sendText(c.jid||phoneToJid(c.telefone), texto)) ok++; } db.prepare('INSERT INTO mensagens_salvas(texto,total) VALUES(?,?)').run(texto,ok); } res.redirect('/admin/mensagem'); });

app.get('/admin/menu-imagem',auth,(req,res)=>{
  const menuFile = getConfig('menu_image_file','');
  const menuUrl = getConfig('menu_image_url', DEFAULT_MENU_IMAGE_URL);
  let preview = '<p class="muted">Nenhuma imagem configurada ainda.</p>';
  if (menuFile) preview = `<img src="/files/${encodeURIComponent(path.basename(menuFile))}" style="max-width:420px;width:100%;border-radius:14px">`;
  else if (menuUrl) preview = `<img src="${safe(menuUrl)}" style="max-width:420px;width:100%;border-radius:14px">`;
  res.send(page('Imagem do Menu',`<h1>🖼️ Imagem do Menu</h1><div class="card"><h2>Imagem atual</h2>${preview}<p class="muted">Essa imagem será enviada quando o cliente digitar oi, menu, olá, start ou cancelar.</p></div><div class="card"><h2>Enviar imagem pelo painel</h2><form method="post" enctype="multipart/form-data"><input type="file" name="menu_image" accept="image/*"><button class="green">Salvar imagem</button></form></div><div class="card"><h2>Ou usar link da imagem</h2><form method="post"><input name="menu_url" placeholder="https://.../banner.png" value="${safe(menuUrl)}"><button>Salvar link</button></form></div><div class="card"><form method="post"><input type="hidden" name="remover" value="1"><button class="red">Remover imagem do menu</button></form></div>`));
});
app.post('/admin/menu-imagem',auth,upload.single('menu_image'),(req,res)=>{
  if (req.body.remover) {
    setConfig('menu_image_file','');
    setConfig('menu_image_url','');
  } else if (req.file) {
    setConfig('menu_image_file', req.file.filename);
    setConfig('menu_image_url','');
  } else if (req.body.menu_url !== undefined) {
    setConfig('menu_image_url', String(req.body.menu_url || '').trim());
    setConfig('menu_image_file','');
  }
  res.redirect('/admin/menu-imagem');
});

app.get('/admin/senha',auth,(req,res)=>res.send(page('Senha',`<h1>🔐 Alterar senha</h1><div class="card"><form method="post"><input name="nova" type="password" placeholder="Nova senha"><button>Salvar</button></form></div>`)));
app.post('/admin/senha',auth,(req,res)=>{ if(req.body.nova) setConfig('admin_hash',bcrypt.hashSync(req.body.nova,10)); res.redirect('/admin'); });

app.get('/admin/financeiro',auth,(req,res)=>{
  const hoje = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM pedidos WHERE date(pago_em)=date('now','localtime') AND status IN ('PAGO','ENTREGUE','AGUARDANDO_ENVIO') AND tipo_pagamento!='deposito_saldo'").get().s;
  const mes = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM pedidos WHERE strftime('%Y-%m', pago_em)=strftime('%Y-%m','now','localtime') AND status IN ('PAGO','ENTREGUE','AGUARDANDO_ENVIO') AND tipo_pagamento!='deposito_saldo'").get().s;
  const depositos = db.prepare("SELECT COALESCE(SUM(valor),0) s FROM pedidos WHERE status='PAGO' AND tipo_pagamento='deposito_saldo'").get().s;
  const saldoClientes = db.prepare("SELECT COALESCE(SUM(saldo),0) s FROM clientes").get().s;
  const rows = db.prepare("SELECT * FROM pedidos ORDER BY id DESC LIMIT 20").all().map(p=>`<tr><td>#${p.id}</td><td>${safe(p.cliente_telefone||'-')}</td><td>${safe(p.produto_nome||'-')}</td><td>${brl(p.valor)}</td><td>${safe(p.tipo_pagamento||'')}</td><td>${safe(p.status||'')}</td></tr>`).join('');
  res.send(page('Financeiro', `<h1>💵 Financeiro</h1><div class="grid"><div class="card metric"><p>Vendas hoje</p><h1>${brl(hoje)}</h1></div><div class="card metric"><p>Vendas no mês</p><h1>${brl(mes)}</h1></div><div class="card metric"><p>Depósitos aprovados</p><h1>${brl(depositos)}</h1></div><div class="card metric"><p>Saldo em clientes</p><h1>${brl(saldoClientes)}</h1></div></div><div class="card"><h2>Últimos pedidos</h2><table><tr><th>ID</th><th>Cliente</th><th>Produto</th><th>Valor</th><th>Tipo</th><th>Status</th></tr>${rows}</table></div>`));
});

app.get('/admin/backup',auth,(req,res)=>{ const files=fs.readdirSync(BACKUP_DIR).filter(f=>f.endsWith('.db') || f.endsWith('.tar.gz')).sort().reverse(); const rows=files.map(f=>`<tr><td>${safe(f)}</td><td><a class="btn" href="/admin/backup/download/${encodeURIComponent(f)}">Baixar</a></td></tr>`).join(''); res.send(page('Backup',`<h1>💾 Backup</h1><div class="card"><p class="muted">Backup completo inclui banco de dados e imagens dos QR Codes. O sistema também cria backup automático a cada ${BACKUP_INTERVAL_HOURS} horas.</p><form method="post" action="/admin/backup"><button class="green">Criar backup completo agora</button></form></div><table><tr><th>Arquivo</th><th>Ação</th></tr>${rows}</table>`)); });
app.post('/admin/backup',auth,(req,res)=>{ criarBackupCompleto('backup_manual'); res.redirect('/admin/backup'); });
app.get('/admin/backup/download/:file',auth,(req,res)=>{ const f=path.basename(req.params.file); res.download(path.join(BACKUP_DIR,f)); });
async function resetWhatsAppSession() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  whatsappStarting = false;
  conectado = false;
  qrBase64 = null;
  try { sock?.ev?.removeAllListeners?.(); } catch(e) { console.log('Erro removendo listeners:', e.message); }
  try { sock?.ws?.close?.(); } catch(e) { console.log('Erro fechando socket:', e.message); }
  sock = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch(e => console.log('Erro reiniciar WhatsApp:', e.message));
  }, 3000);
}
app.get('/admin/reset-whatsapp', auth, async (req,res) => {
  await resetWhatsAppSession();
  res.send(page('Reset WhatsApp', qrWhatsappHtml('Sessão antiga apagada. Aguarde alguns segundos e atualize esta página para aparecer o novo QR.')));
});
app.post('/admin/reset-whatsapp', auth, async (req,res)=>{
  await resetWhatsAppSession();
  res.send(page('Reset WhatsApp', qrWhatsappHtml('Sessão antiga apagada. Aguarde alguns segundos e atualize esta página para aparecer o novo QR.')));
});

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

    // O PixGo recebe external_reference/external_id com o ID do pedido, igual ao bot Telegram.
    const p = db.prepare('SELECT * FROM pedidos WHERE id=? OR external_ref=?').get(String(ref), String(ref));
    if (!p) return res.status(200).json({success:true,ignored:'pedido_not_found', ref:String(ref)});

    if (isPaidStatus(status) && !['PAGO','ENTREGUE','AGUARDANDO_ENVIO'].includes(p.status)) {
      if (p.tipo_pagamento === 'deposito_saldo') {
        db.prepare('UPDATE pedidos SET status=?, pago_em=CURRENT_TIMESTAMP WHERE id=?').run('PAGO', p.id);
        db.prepare('UPDATE clientes SET saldo = saldo + ? WHERE id=?').run(Number(p.valor || 0), p.cliente_id);
        const c = db.prepare('SELECT * FROM clientes WHERE id=?').get(p.cliente_id);
        await sendText(p.cliente_jid || phoneToJid(p.cliente_telefone), `✅ Depósito confirmado!\n\n💰 Valor adicionado: *${brl(p.valor)}*\n💵 Saldo atual: *${brl(c?.saldo || 0)}*`);
        await notifyAdmins(`💳 *DEPÓSITO APROVADO*\n\nPedido: #${p.id}\nCliente: ${p.cliente_telefone}\nValor: ${brl(p.valor)}\nSaldo atual: ${brl(c?.saldo || 0)}`);
        return res.status(200).json({success:true,deposito:true});
      }
      db.prepare('UPDATE pedidos SET status=?, pago_em=CURRENT_TIMESTAMP WHERE id=?').run('PAGO', p.id);
      await sendText(p.cliente_jid || phoneToJid(p.cliente_telefone), `✅ Pagamento confirmado!\n\n📦 Pedido #${p.id}\n📱 ${p.produto_nome}\n\nPreparando entrega...`);
      await notifyAdmins(`💰 *PAGAMENTO APROVADO*\n\nPedido: #${p.id}\nCliente: ${p.cliente_telefone}\nPlano: ${p.produto_nome}\nValor: ${brl(p.valor)}`);
      await entregarPedido(p.id);
    }
    return res.status(200).json({success:true});
  } catch(e) {
    console.log('Webhook erro:', e.message);
    return res.status(200).json({success:true,error:e.message});
  }
});

process.on('uncaughtException', (e) => {
  console.log('Erro não capturado:', e.message);
  if (String(e.message || '').toLowerCase().includes('timed out')) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    whatsappStarting = false;
    conectado = false;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startWhatsApp().catch(err => console.log('Erro reconectar após timeout:', err.message));
    }, 10000);
    return;
  }
});
process.on('unhandledRejection', (e) => {
  const msg = e?.message || String(e || '');
  console.log('Promise rejeitada:', msg);
  if (msg.toLowerCase().includes('timed out')) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    whatsappStarting = false;
    conectado = false;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startWhatsApp().catch(err => console.log('Erro reconectar após timeout:', err.message));
    }, 10000);
  }
});

initDB();
iniciarBackupAutomatico();
startWhatsApp().catch(e=>console.log('Erro iniciar WhatsApp:', e.message));
app.listen(PORT,()=>console.log(`Servidor online na porta ${PORT}`));
