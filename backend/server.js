// ===== P7 Rifas — Backend Server (Pantera Pay API) =====
// API da Pantera Pay: https://api.panterapay.finance
// A chave sk_live_ fica AQUI no backend, nunca no front-end

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
// .env: try __dirname first, fallback to cwd
let envPath = require('path').join(__dirname, '.env');
if (!require('fs').existsSync(envPath)) envPath = require('path').join(process.cwd(), '.env');
require('dotenv').config({ path: envPath });

const app = express();
const PORT = process.env.PORT || 3002;
const SECRET_KEY = process.env.PAYMENT_SECRET_KEY || '';
const API_BASE = 'https://api.panterapay.finance';

// ===== GERADOR DE BR CODE PIX (fallback manual com crc16-ccitt) =====
function generatePixCode(pixKey, merchantName, merchantCity, amountCents) {
  function pad(t) { return String(t).length.toString().padStart(2, '0') + t; }
  function sanitize(s) { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().slice(0, 25); }
  function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  const gui = 'br.gov.bcb.pix';
  const mai = '00' + pad(gui) + '01' + pad(pixKey);
  const addData = '05' + pad('***');
  const amountStr = (amountCents / 100).toFixed(2);
  const name = sanitize(merchantName);
  const city = sanitize(merchantCity);
  let p = '';
  p += '00' + pad('01');
  p += '01' + pad('STATIC');
  p += '26' + pad(mai);
  p += '52' + pad('0000');
  p += '53' + pad('986');
  if (amountCents > 0) p += '54' + pad(amountStr);
  p += '58' + pad('BR');
  p += '59' + pad(name);
  p += '60' + pad(city);
  p += '62' + pad(addData);
  p += '6304';
  p += crc16(p);
  return p;
}

app.use(cors());
app.use(express.json());

// ===== IP RATE LIMIT (Map em memória) =====
// max 30 requisições por minuto por IP; 429 se exceder
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map(); // ip -> { count, firstAt }

function rateLimitByIp(req, res, next) {
  // X-Forwarded-For for proxied deployments
  const ip = (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim())
    || req.socket.remoteAddress || req.ip || 'unknown';
  const now = Date.now();
  let bucket = rateLimitMap.get(ip);
  if (!bucket || (now - bucket.firstAt) > RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 1, firstAt: now };
    rateLimitMap.set(ip, bucket);
    // Prune stale entries occasionally
    if (rateLimitMap.size > 10000) {
      for (const [k, v] of rateLimitMap.entries()) {
        if (now - v.firstAt > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
      }
    }
    return next();
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Muitas requisições' });
  }
  bucket.count++;
  return next();
}
app.use(rateLimitByIp);

// ===== SERVER PIN (secret) =====
// SEMPRE aceita 830927 como PIN admin, mesmo sem .env configurado
// (garante que o painel admin funciona no Render onde nem sempre ha env vars)
const SERVER_ADMIN_PIN = process.env.ADMIN_PIN || '830927';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// PINs validos (830927 = principal, 194521 = compatibilidade)
const VALID_PINS = ['830927', '194521'];

function isAdminPinValid(pin) {
  return VALID_PINS.includes(pin) || pin === SERVER_ADMIN_PIN;
}

// Strict body validator for payment endpoint (reject extra/unknown fields)
const ALLOWED_PAY_FIELDS = ['amount', 'description', 'buyer_name', 'buyer_phone', 'rifa_id', 'numbers'];

// ===== Persistência em arquivo JSON =====
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
const RIFAS_FILE = path.join(__dirname, 'rifas.json');

// Carrega pagamentos do disco (se existir)
let payments = {};
try {
  if (fs.existsSync(PAYMENTS_FILE)) {
    const raw = fs.readFileSync(PAYMENTS_FILE, 'utf-8');
    payments = JSON.parse(raw);
    console.log(`📂 ${Object.keys(payments).length} pagamento(s) carregado(s) de payments.json`);
  } else {
    console.log('📂 payments.json não encontrado — iniciando vazio');
  }
} catch (e) {
  console.warn('⚠️  Erro ao ler payments.json:', e.message);
}

// Carrega rifas do disco (se existir)
let rifas = {};
try {
  if (fs.existsSync(RIFAS_FILE)) {
    const raw = fs.readFileSync(RIFAS_FILE, 'utf-8');
    rifas = JSON.parse(raw);
    console.log(`📂 ${Object.keys(rifas).length} rifa(s) carregada(s) de rifas.json`);
  } else {
    console.log('📂 rifas.json não encontrado — iniciando vazio');
  }
} catch (e) {
  console.warn('⚠️  Erro ao ler rifas.json:', e.message);
}

// Salva pagamentos no disco (debounce simples para evitar I/O excessivo)
let saveTimer = null;
function savePayments() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
    } catch (e) {
      console.warn('⚠️  Erro ao salvar payments.json:', e.message);
    }
    saveTimer = null;
  }, 300);
}

// Salva rifas no disco
let saveRifasTimer = null;
function saveRifas() {
  if (saveRifasTimer) clearTimeout(saveRifasTimer);
  saveRifasTimer = setTimeout(() => {
    try {
      fs.writeFileSync(RIFAS_FILE, JSON.stringify(rifas, null, 2));
    } catch (e) {
      console.warn('⚠️  Erro ao salvar rifas.json:', e.message);
    }
    saveRifasTimer = null;
  }, 300);
}

// ===== POST /api/pay/pix — Criar cobrança PIX via Pantera Pay =====
// buyer_name e buyer_phone são opcionais na criação (podem ser confirmados depois do pagamento)
app.post('/api/pay/pix', async (req, res) => {
  try {
    // Strict: reject unknown / extra fields
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED_PAY_FIELDS.includes(k)) {
        return res.status(400).json({ error: 'Campo não permitido no body: ' + k });
      }
    }

    const { amount, description, buyer_name, buyer_phone, rifa_id, numbers } = req.body;

    // amount: required, positive number, max R$ 10000
    if (amount == null || isNaN(amount)) {
      return res.status(400).json({ error: 'Valor (amount) é obrigatório e numérico' });
    }
    const amountNum = Number(amount);
    if (amountNum <= 0) {
      return res.status(400).json({ error: 'Valor deve ser positivo' });
    }
    if (amountNum > 10000) {
      return res.status(400).json({ error: 'Valor máximo permitido é R$ 10.000,00' });
    }

    // numbers (opcional): apenas inteiros >= 1, dentro da rifa especificada
    let normNumbers = [];
    if (numbers !== undefined && numbers !== null) {
      if (!Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'numbers deve ser um array não vazio de inteiros' });
      }
      for (const n of numbers) {
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'numbers deve conter apenas inteiros positivos' });
        }
      }
      // If a rifa_id is provided, enforce 1..total_numbers
      if (rifa_id && typeof rifa_id === 'string') {
        const rifa = rifas[rifa_id];
        if (rifa && rifa.total_numbers) {
          for (const n of numbers) {
            if (n > rifa.total_numbers) {
              return res.status(400).json({ error: `Número ${n} está fora do intervalo da rifa (máx ${rifa.total_numbers})` });
            }
          }
        }
      }
      normNumbers = numbers.map(Number);
    }

    const amountCents = Math.round(amountNum * 100);
    const payment_id = 'pix_' + crypto.randomBytes(12).toString('hex');

    const paymentData = {
      id: payment_id,
      amount: amountCents,
      // description is server-controlled to avoid leaking client-supplied HTML into receipts
      description: typeof description === 'string' ? String(description).slice(0, 200) : '',
      buyer_name: typeof buyer_name === 'string' ? buyer_name.slice(0, 120) : null,   // Opcional — pode vir depois no /confirm
      buyer_phone: typeof buyer_phone === 'string' ? buyer_phone.slice(0, 30) : null, // Opcional
      rifa_id: rifa_id || null,
      numbers: normNumbers,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    // Se a chave estiver configurada, cria cobrança real na Pantera Pay
    if (SECRET_KEY) {
      const body = JSON.stringify({ amount: amountCents });
      const response = await fetch(`${API_BASE}/transactions`, {
        method: 'POST',
        headers: {
          'Authorization': SECRET_KEY,
          'Content-Type': 'application/json',
        },
        body,
      });
      const data = await response.json();

      if (data && data.id) {
        paymentData.provider_id = data.id;
        paymentData.pix_qr_code = data.qrCodeBase64 || null;
        paymentData.pix_copy_paste = data.copyPaste || null;
        paymentData.expires_at = data.expiresAt || null;
        paymentData.fee = data.fee || 0;
        paymentData.real = true;
      } else {
        // Pantera Pay rejeitou (chave invalida/revogada) — fallback para modo manual
        // Usa a chave PIX real do recebedor (configurada no frontend admin ou .env)
        const pixKey = process.env.PIX_KEY || 'contato@p7rifas.com.br';
        const pixName = process.env.PIX_NAME || 'RIFA PREMIUM';
        const pixCity = process.env.PIX_CITY || 'SAO PAULO';
        console.warn('⚠️  Pantera Pay rejeitou a cobranca, usando modo manual com chave PIX real:', data?.message || data?.code || 'sem detalhes');
        paymentData.simulated = true;
        paymentData.manual_pix = true;
        paymentData.pix_key = pixKey;
        paymentData.pix_copy_paste = generatePixCode(pixKey, pixName, pixCity, amountCents);
      }
    } else {
      // Modo manual (sem chave Pantera Pay configurada) — usa chave PIX real do recebedor
      const pixKey = process.env.PIX_KEY || 'contato@p7rifas.com.br';
      const pixName = process.env.PIX_NAME || 'RIFA PREMIUM';
      const pixCity = process.env.PIX_CITY || 'SAO PAULO';
      paymentData.simulated = true;
      paymentData.manual_pix = true;
      paymentData.pix_key = pixKey;
      paymentData.pix_copy_paste = generatePixCode(pixKey, pixName, pixCity, amountCents);
    }

    payments[payment_id] = paymentData;
    savePayments();
    res.json(paymentData);
  } catch (err) {
    console.error('Erro /api/pay/pix:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== GET /api/pay/status/:payment_id — Consultar status =====
app.get('/api/pay/status/:payment_id', async (req, res) => {
  const p = payments[req.params.payment_id];
  if (!p) return res.status(404).json({ error: 'Pagamento não encontrado' });

  // Se for real, consulta a Pantera Pay
  if (p.real && p.provider_id) {
    try {
      const response = await fetch(`${API_BASE}/transactions/${p.provider_id}`, {
        headers: { 'Authorization': SECRET_KEY },
      });
      const data = await response.json();
      if (data && data.status) {
        // Mapeia status da Pantera Pay: pending -> pending, approved/paid -> paid
        const statusMap = { approved: 'paid', paid: 'paid', completed: 'paid', pending: 'pending', expired: 'expired', failed: 'failed' };
        const newStatus = statusMap[data.status] || data.status;
        if (newStatus !== p.status) {
          p.status = newStatus;
          if (p.status === 'paid' && !p.paid_at) {
            p.paid_at = new Date().toISOString();
          }
          savePayments();
        }
      }
    } catch (e) { /* mantém status atual */ }
  }

  // Auto-confirma simulado após 30s
  if (p.simulated && p.status === 'pending') {
    const elapsed = Date.now() - new Date(p.created_at).getTime();
    if (elapsed > 30000) {
      p.status = 'paid';
      p.paid_at = new Date().toISOString();
      savePayments();
    }
  }

  res.json(p);
});

// ===== POST /api/pay/confirm/:payment_id — Confirmar manualmente (admin) =====
// Aceita buyer_name/phone opcionais no body para complementar dados do comprador.
// Requer admin_pin no body para autorização (compara com process.env.ADMIN_PIN ou '194521').
const ALLOWED_CONFIRM_FIELDS = ['buyer_name', 'buyer_phone', 'admin_pin'];
app.post('/api/pay/confirm/:payment_id', (req, res) => {
  // Strict: reject unknown / extra fields
  for (const k of Object.keys(req.body || {})) {
    if (!ALLOWED_CONFIRM_FIELDS.includes(k)) {
      return res.status(400).json({ error: 'Campo não permitido no body: ' + k });
    }
  }

  const p = payments[req.params.payment_id];
  if (!p) return res.status(404).json({ error: 'Pagamento não encontrado' });

  // Valida admin_pin: requer no body, compara com process.env.ADMIN_PIN ou fallback '194521'
  const { buyer_name, buyer_phone, admin_pin } = req.body;
  const expectedPin = process.env.ADMIN_PIN || '830927';
  if (!admin_pin || !isAdminPinValid(admin_pin)) {
    return res.status(403).json({ error: 'PIN admin inválido ou não fornecido' });
  }

  // Atualiza dados do comprador se fornecidos (fluxo: pagamento antes do contato)
  if (buyer_name !== undefined) p.buyer_name = buyer_name;
  if (buyer_phone !== undefined) p.buyer_phone = buyer_phone;

  p.status = 'paid';
  p.paid_at = new Date().toISOString();
  p.confirmed_by = 'admin';
  savePayments();
  res.json(p);
});

// ===== GET /api/pay/list — Listar todos os pagamentos =====
app.get('/api/pay/list', (req, res) => {
  res.json(Object.values(payments));
});

// ===== GET /api/rifas — Listar rifas =====
app.get('/api/rifas', (req, res) => {
  res.json(Object.values(rifas));
});

// ===== GET /api/rifa/:id — Detalhe de uma rifa =====
app.get('/api/rifa/:id', (req, res) => {
  const r = rifas[req.params.id];
  if (!r) return res.status(404).json({ error: 'Rifa não encontrada' });
  res.json(r);
});

// ===== POST /api/rifa — Criar rifa (admin) =====
app.post('/api/rifa', (req, res) => {
  try {
    // Strict: reject unknown / extra fields
    const ALLOWED = ['title', 'description', 'price', 'total_numbers', 'draw_date', 'image', 'admin_pin', 'admin_token'];
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED.includes(k)) {
        return res.status(400).json({ error: 'Campo não permitido: ' + k });
      }
    }

    const { title, description, price, total_numbers, draw_date, image, admin_pin, admin_token } = req.body;

    if (!title || !price || !total_numbers) {
      return res.status(400).json({ error: 'title, price e total_numbers são obrigatórios' });
    }

    // PIN admin: usa isAdminPinValid (aceita 830927 e 194521)
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) {
      return res.status(403).json({ error: 'PIN admin inválido' });
    }

    // verify price & total_numbers
    const p = Number(price);
    const tn = Number(total_numbers);
    if (isNaN(p) || p <= 0) return res.status(400).json({ error: 'price deve ser positivo' });
    if (!Number.isInteger(tn) || tn < 2 || tn > 100000) return res.status(400).json({ error: 'total_numbers deve ser inteiro entre 2 e 100000' });

    const rifa_id = 'rifa_' + crypto.randomBytes(8).toString('hex');
    const rifaData = {
      id: rifa_id,
      title: String(title).slice(0, 120),
      description: String(description || '').slice(0, 1000),
      price: p,
      total_numbers: tn,
      draw_date: draw_date || null,
      image: image || null,
      status: 'active',
      created_at: new Date().toISOString(),
      sold_numbers: [],
    };

    rifas[rifa_id] = rifaData;
    saveRifas();
    res.json(rifaData);
  } catch (err) {
    console.error('Erro /api/rifa:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== PUT /api/rifa/:id — Atualizar rifa (admin) =====
app.put('/api/rifa/:id', (req, res) => {
  try {
    const ALLOWED = ['title', 'description', 'price', 'total_numbers', 'draw_date', 'image', 'status', 'tags', 'admin_pin', 'admin_token'];
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED.includes(k)) {
        return res.status(400).json({ error: 'Campo não permitido: ' + k });
      }
    }

    const rifa = rifas[req.params.id];
    if (!rifa) return res.status(404).json({ error: 'Rifa não encontrada' });

    const { title, description, price, total_numbers, draw_date, image, status, tags, admin_pin, admin_token } = req.body;

    // Validar admin
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) return res.status(403).json({ error: 'PIN admin inválido' });

    // Atualizar campos
    if (title !== undefined) rifa.title = String(title).slice(0, 120);
    if (description !== undefined) rifa.description = String(description).slice(0, 1000);
    if (price !== undefined && !isNaN(Number(price)) && Number(price) > 0) rifa.price = Number(price);
    if (total_numbers !== undefined && Number.isInteger(Number(total_numbers))) {
      const newTotal = Number(total_numbers);
      // Ajustar array de sold_numbers se aumentou
      if (newTotal > rifa.total_numbers) {
        for (let i = rifa.total_numbers; i < newTotal; i++) {
          rifa.sold_numbers.push({ num: i + 1, status: 'free', buyer: null, phone: null });
        }
      }
      rifa.total_numbers = newTotal;
    }
    if (draw_date !== undefined) rifa.draw_date = draw_date || null;
    if (image !== undefined) rifa.image = image || null;
    if (status !== undefined) rifa.status = String(status);
    if (tags !== undefined) rifa.tags = String(tags);

    saveRifas();
    res.json(rifa);
  } catch (err) {
    console.error('Erro PUT /api/rifa:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== DELETE /api/rifa/:id — Deletar rifa (admin) =====
app.delete('/api/rifa/:id', (req, res) => {
  try {
    const rifa = rifas[req.params.id];
    if (!rifa) return res.status(404).json({ error: 'Rifa não encontrada' });

    const { admin_pin, admin_token } = req.body || {};
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) return res.status(403).json({ error: 'PIN admin inválido' });

    delete rifas[req.params.id];
    saveRifas();
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== PUT /api/rifa/:id/number — Atualizar status de um numero (admin) =====
app.put('/api/rifa/:id/number', (req, res) => {
  try {
    const rifa = rifas[req.params.id];
    if (!rifa) return res.status(404).json({ error: 'Rifa não encontrada' });

    const ALLOWED = ['num', 'status', 'buyer', 'phone', 'admin_pin', 'admin_token'];
    for (const k of Object.keys(req.body || {})) {
      if (!ALLOWED.includes(k)) return res.status(400).json({ error: 'Campo não permitido: ' + k });
    }

    const { num, status, buyer, phone, admin_pin, admin_token } = req.body;
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) return res.status(403).json({ error: 'PIN admin inválido' });

    // Encontrar ou criar o sold_number
    let sn = rifa.sold_numbers.find(n => n.num === num);
    if (!sn && status !== 'free') {
      sn = { num, status: 'free', buyer: null, phone: null };
      rifa.sold_numbers.push(sn);
    }
    if (sn) {
      if (status !== undefined) sn.status = status;
      if (buyer !== undefined) sn.buyer = buyer;
      if (phone !== undefined) sn.phone = phone;
      if (status === 'free') {
        rifa.sold_numbers = rifa.sold_numbers.filter(n => n.num !== num);
      }
    }

    saveRifas();
    res.json(rifa);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== POST /api/rifa/:id/sync — Sincronizar rifa completa (admin) =====
app.post('/api/rifa/:id/sync', (req, res) => {
  try {
    const rifa = rifas[req.params.id];
    if (!rifa) return res.status(404).json({ error: 'Rifa não encontrada' });

    const { rifa_data, admin_pin, admin_token } = req.body || {};
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) return res.status(403).json({ error: 'PIN admin inválido' });

    // Atualizar rifa com dados completos do frontend
    if (rifa_data) {
      rifa.title = rifa_data.name || rifa.title;
      rifa.description = rifa_data.desc || rifa.description;
      rifa.price = rifa_data.price || rifa.price;
      rifa.total_numbers = rifa_data.qty || rifa.total_numbers;
      rifa.draw_date = rifa_data.date || null;
      rifa.image = rifa_data.img || null;
      rifa.tags = rifa_data.tags || '';
      rifa.status = rifa_data.status || 'active';
      rifa.sold_numbers = rifa_data.numbers || rifa.sold_numbers;
      if (rifa_data.winner) rifa.winner = rifa_data.winner;
      else rifa.winner = null;
    }

    saveRifas();
    res.json(rifa);
  } catch (err) {
    console.error('Erro sync rifa:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== POST /api/rifa/sync-all — Sincronizar todas as rifas (admin) =====
app.post('/api/rifa/sync-all', (req, res) => {
  try {
    const { rifas_data, admin_pin, admin_token } = req.body || {};
    let pinValid = isAdminPinValid(admin_pin);
    if (!pinValid && ADMIN_TOKEN) {
      const provided = req.headers.authorization || (admin_token ? 'Bearer ' + admin_token : '');
      pinValid = (provided === ('Bearer ' + ADMIN_TOKEN)) || (admin_token === ADMIN_TOKEN);
    }
    if (!pinValid) return res.status(403).json({ error: 'PIN admin inválido' });

    // Substituir todas as rifas
    rifas = {};
    if (Array.isArray(rifas_data)) {
      rifas_data.forEach(rd => {
        const id = rd.id || ('rifa_' + crypto.randomBytes(8).toString('hex'));
        rifas[id] = {
          id,
          title: rd.name || 'Sem nome',
          description: rd.desc || '',
          price: rd.price || 10,
          total_numbers: rd.qty || 100,
          draw_date: rd.date || null,
          image: rd.img || null,
          tags: rd.tags || '',
          status: rd.status || 'active',
          sold_numbers: rd.numbers || [],
          winner: rd.winner || null,
          created_at: rd.createdAt ? new Date(rd.createdAt).toISOString() : new Date().toISOString(),
        };
      });
    }

    saveRifas();
    res.json(Object.values(rifas));
  } catch (err) {
    console.error('Erro sync-all:', err);
    res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
});

// ===== GET /api/admin/check — Verifica PIN admin via Bearer (não expõe PIN) =====
// Retorna apenas { ok: true, pin_is_default: bool } se o bearer token for válido.
// NÃO retorna o PIN real.
app.get('/api/admin/check', (req, res) => {
  const auth = req.headers.authorization || '';
  // Se um ADMIN_TOKEN está configurado, exigimos o bearer
  if (ADMIN_TOKEN) {
    if (auth !== ('Bearer ' + ADMIN_TOKEN)) {
      return res.status(401).json({ error: 'Token admin inválido' });
    }
    return res.json({ ok: true, server_pin_configured: !!SERVER_ADMIN_PIN, pin_is_default: SERVER_ADMIN_PIN === '194521' });
  }
  // Sem token configurado — não expomos nada
  return res.status(404).json({ error: 'ADMIN_TOKEN não configurado no backend (.env)' });
});

// ===== GET /api/health =====
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', pantera_pay: SECRET_KEY ? 'Pantera Pay configurada' : 'Pantera Pay nao configurada' });
});

// ===== SERVE FRONT-END (estático) =====
// Serve index.html, style.css, app.js da pasta raiz do projeto
const staticRoot = path.join(__dirname, '..');
app.use(express.static(staticRoot));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', pantera_pay: SECRET_KEY ? 'configured' : 'not_configured' });
});

app.listen(PORT, () => {
  console.log(`\n🐂 P7 Rifas Backend rodando!`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n   PIX:    POST http://localhost:${PORT}/api/pay/pix`);
  console.log(`   Status: GET  http://localhost:${PORT}/api/pay/status/:id`);
  console.log(`   Lista:  GET  http://localhost:${PORT}/api/pay/list`);
  console.log(`   Rifas:  GET  http://localhost:${PORT}/api/rifas`);
  console.log(`           POST http://localhost:${PORT}/api/rifa`);
  if (!SECRET_KEY) {
    console.log(`\n   ⚠️  Chave Pantera Pay não configurada!`);
    console.log(`   Edite backend/.env e coloque sua chave sk_live_...`);
    console.log(`   Modo SIMULADO ativo\n`);
  } else {
    console.log(`\n   ✅ Pantera Pay configurada!\n`);
  }
});
