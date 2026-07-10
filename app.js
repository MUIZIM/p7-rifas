// ===== P7 Rifas — app.js =====

// ===== STATE =====
let state = {
  rifas: [],
  currentRifa: null,
  selectedNumbers: [],
  adminLogged: false,
  pinInput: ''
};

const DEFAULT_PIN = '194521';

// Admin PIN — stored in localStorage; force change on first login if still default
function getAdminPin() {
  return localStorage.getItem('rifaAdminPin') || DEFAULT_PIN;
}
function setAdminPin(pin) {
  localStorage.setItem('rifaAdminPin', pin);
  localStorage.setItem('rifaAdminPinSet', 'true');
}
function isPinDefault() {
  return getAdminPin() === DEFAULT_PIN;
}

// ===== XSS PROTECTION =====
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#x27;');
}
function esc(str) { return escapeHtml(str); } // alias for brevity

// ===== ADMIN LOGIN RATE LIMIT =====
// max 3 wrong attempts → 30s cooldown (state in memory + localStorage timestamp)
const ADMIN_MAX_ATTEMPTS = 3;
const ADMIN_COOLDOWN_MS = 30000;

function getAdminAttempts() {
  return parseInt(localStorage.getItem('rifaAdminAttempts') || '0', 10);
}
function setAdminAttempts(n) {
  localStorage.setItem('rifaAdminAttempts', String(n));
}
function getAdminLockUntil() {
  return parseInt(localStorage.getItem('rifaAdminLockUntil') || '0', 10);
}
function setAdminLockUntil(ts) {
  localStorage.setItem('rifaAdminLockUntil', String(ts));
}
function clearAdminRateLimit() {
  localStorage.removeItem('rifaAdminAttempts');
  localStorage.removeItem('rifaAdminLockUntil');
}

function isAdminLocked() {
  const until = getAdminLockUntil();
  if (!until) return false;
  if (Date.now() > until) {
    clearAdminRateLimit();
    return false;
  }
  return true;
}
function getAdminLockRemaining() {
  const until = getAdminLockUntil();
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

// ===== PAYMENT RATE LIMIT (frontend) =====
// max 5 payment creations per minute per browser (localStorage)
const PAY_MAX_PER_MIN = 5;
const PAY_WINDOW_MS = 60000;

function checkPayRateLimit() {
  const now = Date.now();
  let timestamps = [];
  try {
    timestamps = JSON.parse(localStorage.getItem('rifaPayTimestamps') || '[]');
  } catch (e) { timestamps = []; }
  timestamps = timestamps.filter(ts => now - ts < PAY_WINDOW_MS);
  if (timestamps.length >= PAY_MAX_PER_MIN) return false;
  timestamps.push(now);
  localStorage.setItem('rifaPayTimestamps', JSON.stringify(timestamps));
  return true;
}

// ===== STORAGE (Backend sync) =====
// Carrega e salva rifas no backend (nao mais localStorage)
// Fallback pra localStorage se backend offline

function mapBackendRifa(r) {
  // Converte formato do backend (title, total_numbers, sold_numbers) pro formato do frontend (name, qty, numbers)
  const numbers = [];
  for (let i = 0; i < (r.total_numbers || r.qty || 0); i++) {
    const sn = (r.sold_numbers || r.numbers || []).find(n => n.num === i + 1);
    if (sn) {
      numbers.push({ num: i + 1, status: sn.status || 'free', buyer: sn.buyer || null, phone: sn.phone || null, reservedAt: sn.reservedAt || null, paidAt: sn.paidAt || null });
    } else {
      numbers.push({ num: i + 1, status: 'free', buyer: null, phone: null });
    }
  }
  return {
    id: r.id,
    name: r.name || r.title || 'Sem nome',
    desc: r.desc || r.description || '',
    qty: r.qty || r.total_numbers || 100,
    price: r.price || 10,
    date: r.date || (r.draw_date ? r.draw_date.split('T')[0] : ''),
    img: r.img || r.image || '',
    tags: r.tags || '',
    status: r.status || 'active',
    numbers,
    winner: r.winner || null,
    createdAt: r.createdAt || (r.created_at ? new Date(r.created_at).getTime() : Date.now())
  };
}

function mapFrontendRifa(r) {
  // Converte formato do frontend pro backend
  return {
    id: r.id,
    name: r.name,
    desc: r.desc,
    price: r.price,
    qty: r.qty,
    date: r.date,
    img: r.img,
    tags: r.tags,
    status: r.status,
    numbers: r.numbers.map(n => ({ num: n.num, status: n.status, buyer: n.buyer, phone: n.phone, reservedAt: n.reservedAt, paidAt: n.paidAt })),
    winner: r.winner,
    createdAt: r.createdAt
  };
}

async function load() {
  try {
    const resp = await fetch(`${API_BASE}/api/rifas`);
    if (resp.ok) {
      const data = await resp.json();
      state.rifas = data.map(mapBackendRifa);
      return;
    }
  } catch (e) { /* fallback pra localStorage */ }
  // Fallback: localStorage
  const d = localStorage.getItem('p7rifas');
  state.rifas = d ? JSON.parse(d) : [];
}

let _saveTimer = null;
async function save() {
  // Salva no localStorage como backup
  localStorage.setItem('p7rifas', JSON.stringify(state.rifas));
  // Debounce sync pro backend
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const pin = getAdminPin();
      await fetch(`${API_BASE}/api/rifa/sync-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rifas_data: state.rifas.map(mapFrontendRifa), admin_pin: pin }),
      });
    } catch (e) { console.warn('Erro ao sincronizar com backend:', e); }
  }, 1000);
}

// ===== UTILS =====
function fmt(n) { return 'R$ ' + Number(n).toFixed(2).replace('.', ','); }
function pad(n) { return String(n).padStart(3, '0'); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 3000);
}
function findById(id) { return state.rifas.find(r => r.id === id); }

// ===== PAGE NAV =====
function showPage(page) {
  ['main','client','admin'].forEach(p => {
    document.getElementById('page-'+p).style.display = p === page ? 'block' : 'none';
  });
  window.scrollTo(0, 0);
  if (page === 'main') renderRifa();
  if (page === 'client') document.getElementById('client-search').value = '';
  if (page === 'admin' && state.adminLogged) renderAdmin();
}

// ===== RENDER RIFA PAGE =====
function renderRifa() {
  // pick the most recent active rifa
  let rifa = state.rifas.find(r => r.status === 'active');
  if (!rifa && state.rifas.length) rifa = state.rifas[state.rifas.length - 1];
  state.currentRifa = rifa;

  const el = document.getElementById('rifa-content');
  if (!rifa) {
    el.innerHTML = `<div class="empty"><p>🎟️ Nenhuma rifa ativa no momento.</p><p style="margin-top:1rem;font-size:.85rem">Acesse o <a href="#" onclick="showPage('admin');return false" style="color:var(--gold-2)">painel admin</a> para criar uma rifa.</p></div>`;
    return;
  }

  state.selectedNumbers = [];

  // counts
  const sold = rifa.numbers.filter(n => n.status !== 'free').length;
  const pct = ((sold / rifa.qty) * 100).toFixed(1);
  const tags = (rifa.tags || '').split(',').filter(Boolean);

  // image or placeholder
  const imgHTML = rifa.img
    ? `<img src="${esc(rifa.img)}" alt="${esc(rifa.name)}" class="rifa-img">`
    : `<div style="display:grid;place-items:center;max-width:400px;margin:0 auto"><span style="font-size:6rem">🎁</span></div>`;

  el.innerHTML = `
    <section class="rifa-hero">
      <div>
        <span class="rifa-badge">⚡ Rifa ativa${rifa.date ? ' — Sorteio ' + formatDate(rifa.date) : ''}</span>
        <h1 class="rifa-title">${esc(rifa.name)}</h1>
        <p class="rifa-desc">${esc(rifa.desc || 'Concorra a este prêmio incrível!')}</p>
        ${tags.length ? `<div class="rifa-tags">${tags.map(t => `<div class="rifa-tag"><span class="rifa-tag-dot"></span>${esc(t.trim())}</div>`).join('')}</div>` : ''}
        <div class="rifa-price-row">
          <div>
            <div class="rifa-price-label">Valor por número</div>
            <div class="rifa-price">${fmt(rifa.price)}</div>
          </div>
          <button class="btn-gold" onclick="document.getElementById('numbers').scrollIntoView({behavior:'smooth'})">Escolher meu número</button>
        </div>
      </div>
      <div class="rifa-img-wrap">
        <div class="rifa-img-glow"></div>
        <div class="rifa-img-container">${imgHTML}</div>
      </div>
    </section>

    <!-- PROGRESS -->
    <div class="card progress-card">
      <div class="progress-header">
        <div>
          <div class="rifa-price-label">Números vendidos</div>
          <div class="progress-num">${sold} <span>/ ${rifa.qty}</span></div>
        </div>
        <div class="progress-pct">${pct}%</div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      ${rifa.winner ? `<div style="margin-top:1rem;padding:1rem;background:rgba(232,185,40,.1);border-radius:12px;text-align:center"><span style="font-size:.8rem;color:var(--gold-2)">🏆 GANHADOR: Nº ${pad(rifa.winner.num)} — ${esc(rifa.winner.name)}</span></div>` : ''}
    </div>

    <!-- NUMBERS -->
    <section id="numbers" class="numbers-section">
      <div class="numbers-header">
        <h2 class="numbers-title">Escolha seu número</h2>
        <div class="numbers-legend">
          <div class="legend-item"><span class="legend-dot legend-free"></span><span class="legend-label">Livre (reservar)</span></div>
          <div class="legend-item"><span class="legend-dot legend-reserved"></span><span class="legend-label">Reservado</span></div>
          <div class="legend-item"><span class="legend-dot legend-paid"></span><span class="legend-label">Pago</span></div>
          <div class="legend-item"><span class="legend-dot legend-selected"></span><span class="legend-label">Selecionado</span></div>
        </div>
      </div>
      <div class="numbers-grid" id="numbers-grid"></div>
      <div id="buy-section" style="margin-top:2rem;text-align:center"></div>
    </section>
  `;

  renderNumbers();
}

function renderNumbers() {
  const rifa = state.currentRifa;
  if (!rifa) return;
  const grid = document.getElementById('numbers-grid');
  if (!grid) return;

  let html = '';
  for (let i = 0; i < rifa.qty; i++) {
    const num = rifa.numbers[i];
    let cls = 'num-free';
    let disabled = '';
    let titleText = `Número ${pad(num.num)} — ${fmt(rifa.price)} — Disponível! ⚡ Reserve agora`;
    let badge = '';
    if (num.status === 'reserved') { cls = 'num-reserved'; disabled = 'disabled'; titleText = `Nº ${pad(num.num)} — reservado`; }
    else if (num.status === 'paid') { cls = 'num-paid'; disabled = 'disabled'; titleText = `Nº ${pad(num.num)} — pago`; }
    else if (num.status === 'mine') { cls = 'num-mine'; titleText = `Nº ${pad(num.num)} — seu número`; }
    if (rifa.winner && rifa.winner.num === num.num) cls = 'num-winner';

    const sel = state.selectedNumbers.includes(num.num);
    if (sel && (cls === 'num-free' || cls === 'num-mine')) cls = 'num-selected';

    // Badge for free numbers
    if (cls === 'num-free') {
      badge = '<span class="num-reserve-badge">RESERVE</span>';
    }

    html += `<button class="num-btn ${cls}" ${disabled} title="${esc(titleText)}" onclick="toggleNumber(${i}, event)" data-idx="${i}">${badge}${pad(num.num)}</button>`;
  }
  grid.innerHTML = html;

  // Floating counter + buy button (only visible when selections exist)
  updateFloatingCounter();
}

// ===== FLOATING COUNTER + BUY BUTTON =====
let _floatCounterEl = null;
function updateFloatingCounter() {
  const rifa = state.currentRifa;
  if (!rifa) return;
  const cnt = state.selectedNumbers.length;
  const total = cnt * rifa.price;

  // Create floating counter element if missing
  if (!_floatCounterEl) {
    _floatCounterEl = document.createElement('div');
    _floatCounterEl.id = 'floating-buy-bar';
    _floatCounterEl.className = 'floating-buy-bar';
    _floatCounterEl.style.display = 'none';
    document.body.appendChild(_floatCounterEl);
  }

  if (cnt > 0) {
    _floatCounterEl.innerHTML = `
      <div class="fb-info">
        <span class="fb-count">${cnt} selecionad${cnt > 1 ? 'os' : 'o'}</span>
        <span class="fb-total">Total: ${fmt(total)}</span>
      </div>
      <button class="fb-buy-btn" onclick="startPayment()">
        COMPRAR ${cnt} NÚMERO${cnt > 1 ? 'S' : ''} — ${fmt(total)}
      </button>
      <span class="fb-close" onclick="clearSelections()" title="Limpar seleção">×</span>
    `;
    _floatCounterEl.style.display = 'flex';
  } else {
    _floatCounterEl.style.display = 'none';
  }

  // Also update buy-section (inline detail panel) when selections exist
  const bs = document.getElementById('buy-section');
  if (bs) {
    if (cnt > 0) {
      bs.innerHTML = `
        <div class="card" style="max-width:480px;margin:0 auto">
          <h3 class="section-title" style="font-size:1.1rem">Confirmar Compra</h3>
          <div class="selected-list">${state.selectedNumbers.map(n => `<span class="selected-chip">${pad(n)} <span onclick="removeNum(${n})">×</span></span>`).join('')}</div>
          <p style="margin:.5rem 0">Total: <strong style="font-size:1.3rem">${fmt(total)}</strong> (${cnt} número${cnt > 1 ? 's' : ''})</p>
          <button class="btn-gold" onclick="startPayment()" style="width:100%">Pagar com PIX</button>
          <p class="hint">Gera o PIX agora. Depois de pagar, pediremos seu contato.</p>
        </div>
      `;
    } else {
      bs.innerHTML = '';
    }
  }
}

function clearSelections() {
  state.selectedNumbers = [];
  renderNumbers();
}

// Ripple effect on number buttons
function createRipple(event) {
  if (!event || !event.currentTarget) return;
  const btn = event.currentTarget;
  const rect = btn.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'num-ripple';
  ripple.style.left = (event.clientX - rect.left) + 'px';
  ripple.style.top = (event.clientY - rect.top) + 'px';
  btn.appendChild(ripple);
  setTimeout(() => { if (ripple.parentNode) ripple.remove(); }, 600);
}

function toggleNumber(idx, event) {
  const rifa = state.currentRifa;
  if (!rifa) return;
  const num = rifa.numbers[idx];
  if (num.status !== 'free') return;

  // Ripple
  if (event) createRipple(event);

  const i = state.selectedNumbers.indexOf(num.num);
  if (i >= 0) {
    state.selectedNumbers.splice(i, 1);
  } else {
    state.selectedNumbers.push(num.num);
    // Mini confetti on select
    if (event) miniConfetti(event);
  }
  renderNumbers();
}

function removeNum(n) {
  const i = state.selectedNumbers.indexOf(n);
  if (i >= 0) state.selectedNumbers.splice(i, 1);
  renderNumbers();
}

// ===== MINI CONFETTI =====
function miniConfetti(event) {
  if (!event || !event.clientX) return;
  const colors = ['#f5d061', '#e8b928', '#d4a017', '#22c55e'];
  const cx = event.clientX;
  const cy = event.clientY;
  const w = window.pageXOffset || document.documentElement.scrollLeft;
  const h = window.pageYOffset || document.documentElement.scrollTop;
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('div');
    c.className = 'confetti-piece';
    c.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.style.left = (cx + w - 8) + 'px';
    c.style.top = (cy + h - 8) + 'px';
    const ang = (Math.random() * Math.PI * 2);
    const dist = 40 + Math.random() * 40;
    c.style.setProperty('--tx', Math.cos(ang) * dist + 'px');
    c.style.setProperty('--ty', Math.sin(ang) * dist + 'px');
    document.body.appendChild(c);
    setTimeout(() => { if (c.parentNode) c.remove(); }, 700);
  }
}

// ===== RESERVATION EXPIRY (configurable minutes → back to free) =====
let reservationCheckTimer = null;

function getReservationTimeout() {
  const mins = parseInt(localStorage.getItem('rifa_reservationMinutes') || '30', 10);
  return Math.max(1, mins) * 60 * 1000;
}

function startReservationChecker() {
  if (reservationCheckTimer) clearInterval(reservationCheckTimer);
  reservationCheckTimer = setInterval(checkExpiredReservations, 60000); // every 60s
  checkExpiredReservations(); // run once immediately
}

function checkExpiredReservations() {
  const now = Date.now();
  const timeout = getReservationTimeout();
  let freed = 0;
  state.rifas.forEach(rifa => {
    rifa.numbers.forEach(n => {
      if (n.status === 'reserved' && n.reservedAt) {
        const elapsed = now - n.reservedAt;
        if (elapsed >= timeout) {
          n.status = 'free';
          n.buyer = null;
          n.phone = null;
          n.reservedAt = null;
          freed++;
        }
      }
    });
  });
  if (freed > 0) {
    save();
    if (state.currentRifa) renderNumbers();
    toast(`${freed} número(s) liberado(s) por expiração de reserva.`);
  }
}

// ===== PAYMENT FLOW (Pantera Pay PIX) =====
// Se rodando local (file://), usa localhost:3002. Se online, usa a mesma origem
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3002' : window.location.origin;
let currentPayment = null;
let paymentPollTimer = null;
let pendingBuyData = null;

async function startPayment() {
  if (!state.selectedNumbers.length) { toast('Selecione um número!'); return; }
  // Frontend rate limit: max 5 payment creations per minute
  if (!checkPayRateLimit()) {
    toast('⏳ Muitas cobranças por minuto. Aguarde alguns segundos e tente novamente.');
    return;
  }
  const rifa = state.currentRifa;
  const total = state.selectedNumbers.length * rifa.price;
  pendingBuyData = { rifa, numbers: [...state.selectedNumbers], total };

  const modal = document.getElementById('buy-modal');
  const content = document.getElementById('buy-modal-content');
  content.innerHTML = `
    <h2 class="section-title">🏦 Pagamento via PIX</h2>
    <div style="text-align:center">
      <p class="muted" style="margin-bottom:1rem">Gerando cobrança de <strong style="color:var(--gold-2);font-size:1.4rem">${fmt(total)}</strong></p>
      <p class="muted">Números: ${state.selectedNumbers.map(n => pad(n)).join(', ')}</p>
      <div id="pix-loading" style="padding:3rem">
        <div style="font-size:2rem">⏳</div>
        <p class="muted">Gerando QR Code...</p>
      </div>
      <div id="pix-content" style="display:none"></div>
    </div>
  `;
  modal.style.display = 'flex';

  try {
    const resp = await fetch(`${API_BASE}/api/pay/pix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: total,
        description: `${rifa.name} — Números: ${state.selectedNumbers.map(n => pad(n)).join(', ')}`,
        rifa_id: rifa.id,
        numbers: state.selectedNumbers,
      }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    currentPayment = data;
    showPixQR(data);
    startPaymentPolling(data.id);
    // Marcar números como reservados com timestamp
    state.selectedNumbers.forEach(n => {
      const idx = state.currentRifa.numbers.findIndex(x => x.num === n);
      if (idx >= 0 && state.currentRifa.numbers[idx].status === 'free') {
        state.currentRifa.numbers[idx].status = 'reserved';
        state.currentRifa.numbers[idx].reservedAt = Date.now();
      }
    });
    save();
  } catch (err) {
    document.getElementById('pix-loading').innerHTML = `
      <div style="font-size:2rem">⚠️</div>
      <p style="color:var(--destructive)">${err.message}</p>
      <p class="hint" style="margin-top:1rem">O backend está rodando? Execute: cd backend && node server.js</p>
    `;
  }
}

function showPixQR(data) {
  document.getElementById('pix-loading').style.display = 'none';
  const el = document.getElementById('pix-content');
  el.style.display = 'block';
  let qrHTML = '';
  if (data.pix_qr_code) {
    qrHTML = `<img src="${data.pix_qr_code}" alt="QR Code PIX" style="width:220px;height:220px;border-radius:12px;border:1px solid var(--border);margin:0 auto;display:block">`;
  } else if (data.pix_copy_paste) {
    qrHTML = `<div id="qrcode" style="margin:0 auto;width:220px;height:220px"></div>`;
    setTimeout(() => {
      const qrEl = document.getElementById('qrcode');
      if (qrEl) { qrEl.innerHTML = ''; new QRCode(qrEl, { text: data.pix_copy_paste, width: 220, height: 220 }); }
    }, 100);
  }
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  const expiresStr = expiresAt ? expiresAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = `
    ${qrHTML}
    <div style="margin:1.5rem 0">
      <p class="muted" style="margin-bottom:.5rem">📋 Copia e Cola:</p>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input type="text" id="pix-copy" value="${data.pix_copy_paste || ''}" class="input" style="font-size:.75rem" readonly>
        <button class="btn-gold" onclick="copyPix()" style="padding:0 1rem;height:42px;font-size:.8rem">Copiar</button>
      </div>
    </div>
    ${expiresStr ? `<p class="hint">⏰ Expira às ${expiresStr}</p>` : ''}
    <div id="payment-status" style="margin-top:1.5rem;padding:1rem;border-radius:12px;background:rgba(245,158,11,.1);border:1px solid var(--warning)">
      <p style="color:var(--warning)">⏳ Aguardando pagamento...</p>
      <p class="hint">Pague o PIX e continuaremos automaticamente</p>
    </div>
  `;
}

function copyPix() {
  const input = document.getElementById('pix-copy');
  input.select(); document.execCommand('copy');
  toast('📋 Código PIX copiado!');
}

function startPaymentPolling(paymentId) {
  if (paymentPollTimer) clearInterval(paymentPollTimer);
  let attempts = 0;
  paymentPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 120) { clearInterval(paymentPollTimer); return; }
    try {
      const resp = await fetch(`${API_BASE}/api/pay/status/${paymentId}`);
      const data = await resp.json();
      if (data.status === 'paid') { clearInterval(paymentPollTimer); onPaymentApproved(); }
      else if (data.status === 'expired' || data.status === 'failed') {
        clearInterval(paymentPollTimer);
        // Liberar números reservados (pagamento falhou/expirou)
        if (pendingBuyData) {
          pendingBuyData.numbers.forEach(n => {
            const idx = pendingBuyData.rifa.numbers.findIndex(x => x.num === n);
            if (idx >= 0 && pendingBuyData.rifa.numbers[idx].status === 'reserved') {
              pendingBuyData.rifa.numbers[idx].status = 'free';
              pendingBuyData.rifa.numbers[idx].reservedAt = null;
            }
          });
          save();
        }
        const s = document.getElementById('payment-status');
        if (s) s.innerHTML = `<p style="color:var(--destructive)">❌ Pagamento ${data.status === 'expired' ? 'expirado' : 'falhou'}</p>`;
      }
    } catch (e) {}
  }, 5000);
}

// ===== PAGAMENTO APROVADO → PEDIR CONTATO =====
function onPaymentApproved() {
  const d = pendingBuyData;
  const el = document.getElementById('pix-content');
  el.innerHTML = `
    <div style="text-align:center;padding:1rem">
      <div style="font-size:2.5rem">✅</div>
      <h2 class="section-title" style="color:var(--gold-2)">Pagamento Aprovado!</h2>
      <p class="muted" style="margin-bottom:1.5rem">Agora precisamos do seu contato para confirmar seus números.</p>
    </div>
    <div class="form-group">
      <label>Nome completo</label>
      <input type="text" id="contact-name" placeholder="Seu nome" class="input">
    </div>
    <div class="form-group">
      <label>Telefone / WhatsApp</label>
      <input type="text" id="contact-phone" placeholder="(11) 99999-9999" class="input">
    </div>
    <button class="btn-gold" onclick="confirmContact()" style="width:100%">Confirmar e Ver Meus Números</button>
  `;
  toast('✅ Pagamento aprovado! Preencha seu contato.');
}

// ===== CONTATO CONFIRMADO → ENTREGAR NÚMEROS + EXTRATO =====
function confirmContact() {
  const name = document.getElementById('contact-name').value.trim();
  const phone = document.getElementById('contact-phone').value.trim();
  if (!name) { toast('Digite seu nome!'); return; }
  if (!phone || phone.length < 8) { toast('Digite um telefone válido!'); return; }

  const d = pendingBuyData;
  // Marca números como pagos
  d.numbers.forEach(n => {
    const idx = d.rifa.numbers.findIndex(x => x.num === n);
    d.rifa.numbers[idx].status = 'paid';
    d.rifa.numbers[idx].buyer = name;
    d.rifa.numbers[idx].phone = phone;
    d.rifa.numbers[idx].paidAt = new Date().toISOString();
    d.rifa.numbers[idx].reservedAt = null; // clear reservation timestamp
  });
  save();

  // Gera extrato/recibo
  const txId = currentPayment ? (currentPayment.provider_id || currentPayment.id || 'N/A') : 'N/A';
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR');
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const fee = currentPayment && currentPayment.fee ? (currentPayment.fee / 100).toFixed(2) : '0,00';

  const el = document.getElementById('pix-content');
  el.innerHTML = `
    <div style="text-align:center;padding:1rem 0">
      <div style="font-size:3rem">🎉</div>
      <h2 class="section-title" style="color:var(--gold-2)">Compra Confirmada!</h2>
      <p class="muted">Seus números:<br><strong style="font-size:1.8rem;color:var(--gold-2)">${d.numbers.map(n => pad(n)).join(' · ')}</strong></p>
    </div>

    <!-- EXTRATO / RECIBO -->
    <div class="card" style="margin:1rem 0;border:1px solid var(--gold-2);box-shadow:var(--gold-glow)">
      <h3 style="font-family:Poppins;font-size:.9rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:1rem">📊 Extrato da Compra</h3>
      <div style="display:grid;gap:.5rem;font-size:.85rem">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Rifa:</span><span>${esc(d.rifa.name)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Comprador:</span><span>${esc(name)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Telefone:</span><span>${esc(phone)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Números:</span><span><strong>${d.numbers.map(n => pad(n)).join(', ')}</strong></span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Qtd:</span><span>${d.numbers.length}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Preço unitário:</span><span>${fmt(d.rifa.price)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Total pago:</span><span><strong style="color:var(--gold-2)">${fmt(d.total)}</strong></span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Taxa:</span><span>R$ ${fee}</span></div>
        <hr style="border:none;border-top:1px solid var(--border);margin:.5rem 0">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">ID Transação:</span><span style="font-size:.7rem;font-family:monospace">${esc(txId)}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Data:</span><span>${dateStr} às ${timeStr}</span></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text-muted)">Status:</span><span style="color:var(--success);font-weight:600">✅ Pago</span></div>
      </div>
    </div>

    <div style="display:flex;gap:1rem;margin-top:1rem">
      <button class="btn-gold" onclick="downloadReceipt()" style="flex:1">📄 Baixar Recibo</button>
      <button class="btn-gold" onclick="closeModal('buy-modal');renderRifa()" style="flex:1">Concluir</button>
    </div>
  `;

  // Guarda dados do recibo pra download
  window._lastReceipt = {
    rifa: d.rifa.name, name, phone, numbers: d.numbers.map(n => pad(n)),
    qty: d.numbers.length, unitPrice: d.rifa.price, total: d.total, fee,
    txId, date: dateStr, time: timeStr
  };

  state.selectedNumbers = [];
  toast('✅ Número(s) confirmado(s)!');
}

// ===== BAIXAR RECIBO EM TXT =====
function downloadReceipt() {
  const r = window._lastReceipt;
  if (!r) { toast('Nenhum recibo disponível.'); return; }
  const txt = `
══════════════════════════════════════
         RIFA PREMIUM — RECIBO
══════════════════════════════════════

Rifa: ${r.rifa}
Comprador: ${r.name}
Telefone: ${r.phone}

Números: ${r.numbers.join(', ')}
Quantidade: ${r.qty}
Preço por número: R$ ${r.unitPrice.toFixed(2).replace('.', ',')}
TOTAL PAGO: R$ ${r.total.toFixed(2).replace('.', ',')}
Taxa: R$ ${r.fee}

ID Transação: ${r.txId}
Data: ${r.date} às ${r.time}
Status: ✅ PAGO

══════════════════════════════════════
  Guarde este recibo. Em caso de
  dúvida, consulte na aba "Meus Números"
══════════════════════════════════════
`;
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `recibo_rifa_${r.numbers.join('-')}.txt`;
  a.click();
  toast('📄 Recibo baixado!');
}

// ===== CLIENT SEARCH =====
function searchClientNumbers(e) {
  if (e && e.key && e.key !== 'Enter') return;
  const q = document.getElementById('client-search').value.trim().toLowerCase();
  const el = document.getElementById('client-results');
  if (!q) { el.innerHTML = ''; return; }

  let all = [];
  state.rifas.forEach(rifa => {
    rifa.numbers.forEach(n => {
      if ((n.buyer && n.buyer.toLowerCase().includes(q)) || (n.phone && n.phone.includes(q))) {
        all.push({ rifa: rifa.name, num: n.num, status: n.status, winner: rifa.winner && rifa.winner.num === n.num, paidAt: n.paidAt });
      }
    });
  });

  if (!all.length) {
    el.innerHTML = '<div class="empty">Nenhum número encontrado para essa busca.</div>';
    return;
  }
  el.innerHTML = `
    <div class="card" style="max-width:600px;margin:1rem auto">
      <h3 class="section-title">Seus números (${all.length})</h3>
      ${all.map(n => `
        <div class="client-num-card">
          <div>
            <div class="client-num">${pad(n.num)}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">${esc(n.rifa)}${n.paidAt ? ' · ' + new Date(n.paidAt).toLocaleDateString('pt-BR') : ''}</div>
          </div>
          <div class="client-num-status ${n.winner ? 'status-winner' : (n.status==='paid'?'status-paid':'status-reserved')}">
            ${n.winner ? '🏆 GANHADOR!' : (n.status==='paid' ? '✅ Pago' : '⏳ Reservado')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ===== ADMIN =====
// ===== PIN PAD =====
function pinPress(digit) {
  if (state.pinInput.length >= 6) return;
  // If locked, clear input and skip
  if (isAdminLocked()) {
    toast(`⏳ Bloqueado, aguarde ${getAdminLockRemaining()}s`);
    return;
  }
  state.pinInput += digit;
  updatePinDots();
  if (state.pinInput.length === 6) {
    setTimeout(checkAdminLogin, 200);
  }
}

function pinClear() {
  state.pinInput = state.pinInput.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dot');
  if (!dots.length) return;
  dots.forEach((dot, i) => {
    if (i < state.pinInput.length) dot.classList.add('filled');
    else dot.classList.remove('filled', 'error');
  });
}

function checkAdminLogin() {
  const pin = state.pinInput;
  // Lock check
  if (isAdminLocked()) {
    const remaining = getAdminLockRemaining();
    const hintEl = document.getElementById('pin-hint');
    if (hintEl) hintEl.textContent = `🔒 Bloqueado, aguarde ${remaining}s`;
    state.pinInput = '';
    updatePinDots();
    toast(`⏳ Bloqueado, aguarde ${remaining}s`);
    // Start a countdown display
    if (!window._pinLockInterval) {
      window._pinLockInterval = setInterval(() => {
        const r = getAdminLockRemaining();
        const hintEl2 = document.getElementById('pin-hint');
        if (r > 0 && hintEl2) {
          hintEl2.textContent = `🔒 Bloqueado, aguarde ${r}s`;
        }
        if (r <= 0) {
          clearInterval(window._pinLockInterval);
          window._pinLockInterval = null;
          const hintEl3 = document.getElementById('pin-hint');
          if (hintEl3) hintEl3.textContent = 'Digite seu PIN secreto';
        }
      }, 1000);
    }
    return;
  }

  if (pin === getAdminPin()) {
    // Clear wrong attempt counter on success
    clearAdminRateLimit();
    state.adminLogged = true;
    state.pinInput = '';
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    renderAdmin();
    toast('✅ Bem-vindo, admin!');

    // ⚠ Force PIN change on first login with default 194521
    if (isPinDefault()) {
      setTimeout(() => {
        if (confirm('⚠️ Você está usando o PIN padrão (194521). Por segurança é obrigatório definir um novo PIN agora.\n\nClique em OK para definir um novo PIN de 6 dígitos.')) {
          promptSetNewPin();
        }
      }, 400);
    }
  } else {
    // Wrong PIN
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach(d => { d.classList.remove('filled'); d.classList.add('error'); });
    state.pinInput = '';

    const attempts = getAdminAttempts() + 1;
    setAdminAttempts(attempts);

    if (attempts >= ADMIN_MAX_ATTEMPTS) {
      setAdminLockUntil(Date.now() + ADMIN_COOLDOWN_MS);
      toast(`❌ PIN incorreto! Bloqueado por 30 segundos.`);
      // Hide "first PIN" button while locked
      const fb = document.getElementById('btn-first-pin');
      if (fb) fb.style.display = 'none';
    } else {
      toast(`❌ PIN incorreto! ${ADMIN_MAX_ATTEMPTS - attempts} tentativa(s) restante(s).`);
    }
    setTimeout(updatePinDots, 400);
  }
}

// ⚠ Force-set new PIN (first login)
function promptSetNewPin() {
  const newPin = prompt('Digite seu NOVO PIN de 6 dígitos:');
  if (!newPin || newPin.length !== 6 || isNaN(newPin)) {
    toast('O PIN deve ter exatamente 6 dígitos numéricos!');
    promptSetNewPin();
    return;
  }
  setAdminPin(newPin);
  toast('✅ Novo PIN definido com sucesso!');
}

function setFirstPin() {
  // If locked, cannot
  if (isAdminLocked()) {
    toast(`⏳ Bloqueado, aguarde ${getAdminLockRemaining()}s`);
    return;
  }
  const newPin = prompt('Digite seu PIN secreto de 6 dígitos:');
  if (!newPin || newPin.length !== 6 || isNaN(newPin)) {
    toast('O PIN deve ter exatamente 6 dígitos numéricos!');
    return;
  }
  // Requires a valid current PIN to unlock; bypass only if still default
  if (!isPinDefault()) {
    const oldConfirm = prompt('Digite seu PIN ATUAL para autorizar a troca:');
    if (oldConfirm !== getAdminPin()) { toast('PIN atual incorreto!'); return; }
  }
  setAdminPin(newPin);
  toast('✅ PIN definido! Use ele para entrar.');
  const fb = document.getElementById('btn-first-pin');
  if (fb) fb.style.display = 'none';
  const hint = document.getElementById('pin-hint');
  if (hint) hint.textContent = 'Seu PIN foi definido. Digite para entrar.';
}

function adminTab(tab, ev) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-content').forEach(c => c.classList.remove('active'));
  // Usa o evento passado explicitamente (evita depender do `event` global implícito)
  const target = (ev && ev.target) ? ev.target : null;
  if (target) target.classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'manage') renderManage();
  if (tab === 'sales') renderSales();
  if (tab === 'winner') renderWinnerTab();
  if (tab === 'config') renderConfig();
}

function renderAdmin() { renderDashboard(); renderManage(); renderSales(); renderWinnerTab(); }

// DASHBOARD
function renderDashboard() {
  const el = document.getElementById('stats-grid');
  const totalRifas = state.rifas.length;
  const active = state.rifas.filter(r => r.status === 'active').length;
  let totalSold = 0, totalRev = 0, totalReserved = 0, totalFree = 0;
  state.rifas.forEach(r => {
    r.numbers.forEach(n => {
      if (n.status === 'paid' || n.status === 'reserved') totalSold++;
      if (n.status === 'paid') totalRev += r.price;
      if (n.status === 'reserved') totalReserved++;
      if (n.status === 'free') totalFree++;
    });
  });
  el.innerHTML = `
    <div class="stat-card"><div class="stat-label">Rifas totais</div><div class="stat-value">${totalRifas}</div></div>
    <div class="stat-card"><div class="stat-label">Rifas ativas</div><div class="stat-value">${active}</div></div>
    <div class="stat-card"><div class="stat-label">Números vendidos</div><div class="stat-value">${totalSold}</div></div>
    <div class="stat-card"><div class="stat-label">Receita (pago)</div><div class="stat-value stat-gold">${fmt(totalRev)}</div></div>
    <div class="stat-card"><div class="stat-label">Reservados (pendentes)</div><div class="stat-value" style="color:var(--warning)">${totalReserved}</div></div>
    <div class="stat-card"><div class="stat-label">Livres</div><div class="stat-value" style="color:var(--text-muted)">${totalFree}</div></div>
  `;
  // Add expiry checker button below stats
  const dg = document.getElementById('tab-dashboard');
  let checker = dg.querySelector('.expiry-checker');
  if (!checker) {
    checker = document.createElement('div');
    checker.className = 'expiry-checker card';
    checker.style.cssText = 'max-width:1100px;margin:1rem auto;text-align:center';
    dg.appendChild(checker);
  }
  checker.innerHTML = `
    <h3 class="section-title" style="font-size:1.1rem">⏳ Reservas</h3>
    <p class="muted">Números reservados expiram automaticamente em 30 min sem pagamento.</p>
    <div style="margin-top:.75rem">
      <button class="btn-gold" onclick="forceCheckExpirations()" style="height:auto;padding:.5rem 1.5rem">🔄 Verificar expirações agora</button>
    </div>
  `;
}

// CREATE
function createRifa() {
  const name = document.getElementById('rifa-name').value.trim();
  if (!name) { toast('Digite o nome do prêmio!'); return; }
  const qty = parseInt(document.getElementById('rifa-qty').value);
  const rifa = {
    id: Date.now().toString(),
    name,
    desc: document.getElementById('rifa-desc').value.trim(),
    qty,
    price: parseFloat(document.getElementById('rifa-price').value),
    date: document.getElementById('rifa-date').value,
    img: document.getElementById('rifa-img').value.trim(),
    tags: document.getElementById('rifa-tags').value.trim(),
    status: 'active',
    numbers: Array.from({length: qty}, (_, i) => ({num: i + 1, status: 'free', buyer: null, phone: null})),
    winner: null,
    createdAt: Date.now()
  };
  state.rifas.push(rifa);
  save();
  toast('✅ Rifa criada!');
  // Reset form
  ['rifa-name','rifa-desc','rifa-tags','rifa-date'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('rifa-qty').value = 100;
  document.getElementById('rifa-price').value = '10.00';
  document.getElementById('rifa-img').value = '';
  document.getElementById('rifa-img-file').value = '';
  document.getElementById('img-preview').style.display = 'none';
  document.getElementById('img-upload-placeholder').style.display = 'block';
  renderManage();
  adminTab('manage');
}

// ===== IMAGE UPLOAD =====
function handleImgUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { toast('Imagem muito grande! Máx 3MB.'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    document.getElementById('rifa-img').value = dataUrl;
    const preview = document.getElementById('img-preview');
    preview.src = dataUrl;
    preview.style.display = 'block';
    document.getElementById('img-upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

// ===== EDIT RIFA =====
let editingRifaId = null;

function editRifa(id) {
  const r = findById(id);
  if (!r) return;
  editingRifaId = id;

  const modal = document.getElementById('buy-modal');
  const content = document.getElementById('buy-modal-content');
  const imgPreview = r.img ? `<img src="${r.img}" style="max-width:100%;border-radius:12px;margin-top:.5rem">` : '<p class="hint">Sem imagem</p>';

  content.innerHTML = `
    <h2 class="section-title">✏️ Editar Rifa</h2>
    <div class="form-group">
      <label>Nome do Prêmio</label>
      <input type="text" id="edit-name" value="${r.name}" class="input">
    </div>
    <div class="form-group">
      <label>Descrição</label>
      <textarea id="edit-desc" class="input" rows="3">${r.desc || ''}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Preço por Número (R$)</label>
        <input type="number" id="edit-price" value="${r.price}" step="0.50" min="0.50" class="input">
      </div>
      <div class="form-group">
        <label>Data do Sorteio</label>
        <input type="date" id="edit-date" value="${r.date || ''}" class="input">
      </div>
    </div>
    <div class="form-group">
      <label>Tags</label>
      <input type="text" id="edit-tags" value="${r.tags || ''}" class="input">
    </div>
    <div class="form-group">
      <label>Imagem do Prêmio</label>
      <div class="img-upload-area" id="edit-img-area" onclick="document.getElementById('edit-img-file').click()">
        <input type="file" id="edit-img-file" accept="image/*" style="display:none" onchange="handleEditImgUpload(event)">
        <input type="hidden" id="edit-img" value="${r.img || ''}">
        <div id="edit-img-current">${imgPreview}</div>
        <p class="hint" style="margin-top:.5rem">Clique para trocar a imagem</p>
      </div>
    </div>
    <div class="form-group">
      <label>Status da Rifa</label>
      <select id="edit-status" class="input">
        <option value="active" ${r.status==='active'?'selected':''}>Ativa</option>
        <option value="paused" ${r.status==='paused'?'selected':''}>Pausada</option>
        <option value="finished" ${r.status==='finished'?'selected':''}>Finalizada</option>
      </select>
    </div>
    <div style="display:flex;gap:1rem;margin-top:1rem">
      <button class="btn-gold" onclick="saveEditRifa()" style="flex:1">Salvar Alterações</button>
      <button class="btn-ghost" onclick="closeModal('buy-modal')">Cancelar</button>
    </div>
  `;
  modal.style.display = 'flex';
}

function handleEditImgUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) { toast('Imagem muito grande! Máx 3MB.'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    const dataUrl = e.target.result;
    document.getElementById('edit-img').value = dataUrl;
    document.getElementById('edit-img-current').innerHTML = `<img src="${dataUrl}" style="max-width:100%;border-radius:12px;margin-top:.5rem">`;
  };
  reader.readAsDataURL(file);
}

function saveEditRifa() {
  const r = findById(editingRifaId);
  if (!r) return;
  const name = document.getElementById('edit-name').value.trim();
  if (!name) { toast('Nome obrigatório!'); return; }
  const newPrice = parseFloat(document.getElementById('edit-price').value);
  if (!newPrice || newPrice < 0.50) { toast('Preço mínimo R$0,50!'); return; }

  r.name = name;
  r.desc = document.getElementById('edit-desc').value.trim();
  r.price = newPrice;
  r.date = document.getElementById('edit-date').value;
  r.tags = document.getElementById('edit-tags').value.trim();
  r.img = document.getElementById('edit-img').value.trim();
  r.status = document.getElementById('edit-status').value;
  save();
  closeModal('buy-modal');
  toast('✅ Rifa atualizada!');
  renderManage();
  renderRifa();
}

// ===== ADMIN CONFIG TAB =====
function renderConfig() {
  const el = document.getElementById('config-content');
  const pinSet = localStorage.getItem('rifaAdminPinSet') === 'true';
  el.innerHTML = `
    <div style="max-width:600px;margin:0 auto;display:grid;gap:1.5rem">

      <!-- TROCAR PIN -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">🔐 Trocar PIN do Admin</h3>
        <p class="muted" style="margin-bottom:1rem">Defina um novo PIN de 6 dígitos para acessar o painel admin.</p>
        <div class="form-group">
          <label>PIN atual</label>
          <input type="password" id="cfg-pin-old" maxlength="6" placeholder="Digite o PIN atual" class="input">
        </div>
        <div class="form-group">
          <label>Novo PIN (6 dígitos)</label>
          <input type="password" id="cfg-pin-new" maxlength="6" placeholder="Ex: 246810" class="input">
        </div>
        <div class="form-group">
          <label>Confirmar novo PIN</label>
          <input type="password" id="cfg-pin-confirm" maxlength="6" placeholder="Repita o novo PIN" class="input">
        </div>
        <button class="btn-gold" onclick="changePin()">Trocar PIN</button>
      </div>

      <!-- DADOS DA RIFA -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">🏪 Nome do Site</h3>
        <p class="muted" style="margin-bottom:1rem">Nome que aparece no topo do site.</p>
        <div class="form-group">
          <label>Nome</label>
          <input type="text" id="cfg-site-name" value="${getState('siteName','P7 Rifas')}" class="input">
        </div>
        <button class="btn-gold" onclick="saveSiteName()">Salvar Nome</button>
      </div>

      <!-- CHAVE PIX MANUAL -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">📋 Chave PIX (recebedor)</h3>
        <p class="muted" style="margin-bottom:1rem">Usada no modo simulado (sem gateway).</p>
        <div class="form-group">
          <label>Chave PIX (email,telefone,CNPJ)</label>
          <input type="text" id="cfg-pix-key" value="${getState('pixKey','contato@p7rifas.com.br')}" class="input">
        </div>
        <button class="btn-gold" onclick="savePixKey()">Salvar Chave PIX</button>
      </div>

      <!-- EXPORTAR / IMPORTAR DADOS -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">💾 Backup de Dados</h3>
        <p class="muted" style="margin-bottom:1rem">Exporte ou importe todos os dados das rifas (vendidos, clientes, etc).</p>
        <div style="display:flex;gap:1rem;flex-wrap:wrap">
          <button class="btn-gold" onclick="exportData()">📥 Exportar dados</button>
          <button class="btn-gold" onclick="document.getElementById('import-file').click()">📤 Importar dados</button>
          <input type="file" id="import-file" accept=".json" style="display:none" onchange="importData(event)">
        </div>
      </div>

      <!-- CONFIGURAR TEMPO DE EXPIRACAO -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">⏳ Tempo de Expiração de Reservas</h3>
        <p class="muted" style="margin-bottom:1rem">Quantos minutos um número reservado fica disponível sem pagamento antes de voltar para compra.</p>
        <div class="form-group">
          <label>Minutos (padrão: 30)</label>
          <input type="number" id="cfg-reservation-min" value="${getState('reservationMinutes','30')}" min="1" max="120" class="input">
        </div>
        <button class="btn-gold" onclick="saveReservationMinutes()">Salvar Tempo</button>
      </div>

      <!-- LIMPAR DADOS -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">⚠️ Zerar Tudo</h3>
        <p class="muted" style="margin-bottom:1rem">Apaga todas as rifas, vendas e clientes. Não pode ser desfeito.</p>
        <button class="btn-danger" onclick="wipeAll()" style="padding:.5rem 1.5rem">Apagar todos os dados</button>
      </div>

      <!-- INFO DO SISTEMA -->
      <div class="card">
        <h3 class="section-title" style="font-size:1.1rem">ℹ️ Sistema</h3>
        <p class="muted">Backend: <strong id="cfg-backend-status">verificando...</strong></p>
        <p class="muted">Pantera Pay: <strong id="cfg-pp-status">verificando...</strong></p>
        <p class="muted">Versão: 2.0.0</p>
      </div>

    </div>
  `;
  checkBackendStatus();
}

function checkBackendStatus() {
  fetch(`${API_BASE}/api/health`).then(r => r.json()).then(d => {
    document.getElementById('cfg-backend-status').textContent = '✅ Online';
    document.getElementById('cfg-pp-status').textContent = d.pantera_pay.includes('configurada') && !d.pantera_pay.includes('nao') ? '✅ Configurada' : '⚠️ Não configurada';
    document.getElementById('cfg-pp-status').style.color = d.pantera_pay.includes('configurada') && !d.pantera_pay.includes('nao') ? 'var(--success)' : 'var(--warning)';
  }).catch(() => {
    document.getElementById('cfg-backend-status').textContent = '❌ Offline';
    document.getElementById('cfg-backend-status').style.color = 'var(--destructive)';
    document.getElementById('cfg-pp-status').textContent = '❌ Indisponível';
  });
}

function changePin() {
  const oldPin = document.getElementById('cfg-pin-old').value;
  const newPin = document.getElementById('cfg-pin-new').value;
  const confirmPin = document.getElementById('cfg-pin-confirm').value;
  if (oldPin !== getAdminPin()) { toast('PIN atual incorreto!'); return; }
  if (newPin.length !== 6 || isNaN(newPin)) { toast('Novo PIN deve ter 6 dígitos!'); return; }
  if (newPin !== confirmPin) { toast('PINs não conferem!'); return; }
  setAdminPin(newPin);
  localStorage.setItem('rifaAdminPinSet', 'true');
  toast('✅ PIN trocado com sucesso!');
  document.getElementById('cfg-pin-old').value = '';
  document.getElementById('cfg-pin-new').value = '';
  document.getElementById('cfg-pin-confirm').value = '';
}

function getState(key, def) {
  return localStorage.getItem('rifa_' + key) || def;
}
function setState(key, val) {
  localStorage.setItem('rifa_' + key, val);
}

function saveSiteName() {
  const name = document.getElementById('cfg-site-name').value.trim();
  if (!name) { toast('Digite um nome!'); return; }
  setState('siteName', name);
  document.querySelector('.logo-text').textContent = name;
  toast('✅ Nome do site atualizado!');
}

function savePixKey() {
  const key = document.getElementById('cfg-pix-key').value.trim();
  if (!key) { toast('Digite uma chave PIX!'); return; }
  setState('pixKey', key);
  toast('✅ Chave PIX salva!');
}

function saveReservationMinutes() {
  const mins = parseInt(document.getElementById('cfg-reservation-min').value);
  if (!mins || mins < 1 || mins > 120) { toast('Valor inválido! Use entre 1 e 120 minutos.'); return; }
  setState('reservationMinutes', String(mins));
  toast(`✅ Reservas expiram em ${mins} minutos sem pagamento.`);
}

function exportData() {
  const data = { rifas: state.rifas, exportDate: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rifas_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  toast('📥 Backup exportado!');
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.rifas) { toast('Arquivo inválido!'); return; }
      state.rifas = data.rifas;
      save();
      toast('✅ Dados importados!');
      renderManage();
      renderDashboard();
    } catch { toast('Erro ao ler arquivo!'); }
  };
  reader.readAsText(file);
}

function wipeAll() {
  if (!confirm('APAGAR TODOS OS DADOS? Isso não pode ser desfeito!')) return;
  if (!confirm('Tem certeza? Todas as rifas, vendas e clientes serão perdidos.')) return;
  state.rifas = [];
  save();
  toast('Todos os dados foram apagados.');
  renderManage();
  renderDashboard();
}

// ===== ADMIN BULK ACTIONS =====
function freeAllReserved(rifaId) {
  const r = findById(rifaId);
  if (!r) return;
  if (!confirm('Liberar TODOS os números reservados (não pagos) desta rifa?')) return;
  let count = 0;
  r.numbers.forEach(n => {
    if (n.status === 'reserved') { n.status = 'free'; n.buyer = null; n.phone = null; n.reservedAt = null; count++; }
  });
  save(); renderManage(); renderDashboard();
  toast(`${count} número(s) reservado(s) liberado(s).`);
}

function markAllReservedPaid(rifaId) {
  const r = findById(rifaId);
  if (!r) return;
  if (!confirm('Marcar TODOS os números reservados como PAGOS? Use com cuidado.')) return;
  let count = 0;
  r.numbers.forEach(n => {
    if (n.status === 'reserved') { n.status = 'paid'; n.reservedAt = null; count++; }
  });
  save(); renderManage(); renderDashboard();
  toast(`${count} número(s) marcado(s) como pago.`);
}

function forceCheckExpirations() {
  checkExpiredReservations();
  renderManage(); renderDashboard();
  toast('Verificação de expiração executada.');
}

function duplicateRifa(rifaId) {
  const r = findById(rifaId);
  if (!r) return;
  const newRifa = {
    id: Date.now().toString(),
    name: r.name + ' (cópia)',
    desc: r.desc,
    qty: r.qty,
    price: r.price,
    date: '',
    img: r.img,
    tags: r.tags,
    status: 'active',
    numbers: Array.from({length: r.qty}, (_, i) => ({num: i+1, status: 'free', buyer: null, phone: null})),
    winner: null,
    createdAt: Date.now()
  };
  state.rifas.push(newRifa);
  save(); renderManage();
  toast('Rifa duplicada com sucesso!');
}

// MANAGE
function renderManage() {
  const el = document.getElementById('manage-list');
  if (!state.rifas.length) { el.innerHTML = '<div class="empty">Nenhuma rifa criada. Vá em "Criar Rifa".</div>'; return; }
  el.innerHTML = state.rifas.map(r => {
    const sold = r.numbers.filter(n => n.status !== 'free').length;
    const paid = r.numbers.filter(n => n.status === 'paid').length;
    const reserved = r.numbers.filter(n => n.status === 'reserved').length;
    let statusBadge = r.status === 'active' ? '<span class="badge-status badge-active">Ativa</span>' : '<span class="badge-status badge-finished">Finalizada</span>';
    let winnerInfo = r.winner ? `<div style="margin:.5rem 0;color:var(--gold-2)">🏆 Ganhador: Nº ${pad(r.winner.num)} — ${esc(r.winner.name)}</div>` : '';
    let reservedInfo = reserved > 0 ? `<div style="margin:.25rem 0;color:var(--warning);font-size:.8rem">⏳ ${reserved} reservado(s) — expira em 30 min</div>` : '';
    return `
      <div class="manage-item">
        <h3>${esc(r.name)} ${statusBadge}</h3>
        <div class="manage-meta">${r.qty} números · ${fmt(r.price)}/número · ${sold} vendidos · ${paid} pagos</div>
        ${winnerInfo}
        ${reservedInfo}
        <div class="manage-actions">
          <button class="btn-gold" onclick="openRifaManage('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">Ver números</button>
          <button class="btn-gold" onclick="editRifa('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">✏️ Editar</button>
          <button class="btn-gold" onclick="duplicateRifa('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">📋 Duplicar</button>
          <button class="btn-gold" onclick="exportRifa('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">Exportar</button>
          ${reserved > 0 ? `<button class="btn-gold" onclick="markAllReservedPaid('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">✅ Marcar reservados como pagos</button>` : ''}
          ${reserved > 0 ? `<button class="btn-gold" onclick="freeAllReserved('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">🔓 Liberar reservados</button>` : ''}
          ${!r.winner ? `<button class="btn-gold" onclick="adminTab('winner', event);selectWinnerRifa('${r.id}')" style="padding:.4rem 1rem;height:auto;font-size:.8rem">Sortear</button>` : ''}
          <button class="btn-danger" onclick="deleteRifa('${r.id}')">Excluir</button>
        </div>
      </div>
    `;
  }).join('');
}

function openRifaManage(id) {
  const r = findById(id);
  if (!r) return;
  let nums = r.numbers.filter(n => n.status !== 'free');
  if (!nums.length) { toast('Nenhum número vendido ainda.'); return; }
  let html = `<h2 class="section-title">${esc(r.name)} — Gerenciar números</h2>`;
  html += `<div style="overflow-x:auto"><table class="sales-table"><thead><tr><th>Nº</th><th>Comprador</th><th>Telefone</th><th>Status</th><th>Ações</th></tr></thead><tbody>`;
  r.numbers.forEach(n => {
    if (n.status === 'free') return;
    html += `<tr>
      <td><strong>${pad(n.num)}</strong></td>
      <td>${esc(n.buyer || '-')}</td>
      <td>${esc(n.phone || '-')}</td>
      <td><span class="badge-status ${n.status==='paid'?'badge-finished':'badge-active'}">${n.status==='paid'?'Pago':'Reservado'}</span></td>
      <td>
        ${n.status==='reserved' ? `<button class="btn-gold" onclick="markPaid('${id}',${n.num})" style="padding:.2rem .6rem;height:auto;font-size:.7rem">Marcar pago</button>` : ''}
        <button class="btn-danger" onclick="cancelNumber('${id}',${n.num})" style="padding:.2rem .6rem;font-size:.7rem">Cancelar</button>
      </td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  document.getElementById('manage-list').innerHTML = html;
}

function markPaid(id, num) {
  const r = findById(id);
  r.numbers.find(n => n.num === num).status = 'paid';
  save(); renderManage(); openRifaManage(id);
  toast('✅ Nº ' + pad(num) + ' marcado como pago!');
}

function cancelNumber(id, num) {
  const r = findById(id);
  const n = r.numbers.find(n => n.num === num);
  n.status = 'free'; n.buyer = null; n.phone = null;
  save(); renderManage(); openRifaManage(id);
  toast('Nº ' + pad(num) + ' liberado.');
}

function deleteRifa(id) {
  if (!confirm('Excluir esta rifa? Não pode ser desfeito.')) return;
  state.rifas = state.rifas.filter(r => r.id !== id);
  save(); renderManage(); renderDashboard(); toast('Rifa excluída.');
}

function exportRifa(id) {
  const r = findById(id);
  let csv = 'Numero,Comprador,Telefone,Status\n';
  r.numbers.forEach(n => {
    if (n.status !== 'free') csv += `${n.num},${n.buyer||''},${n.phone||''},${n.status}\n`;
  });
  const blob = new Blob([csv], {type: 'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rifa_${r.name.replace(/\s+/g,'_')}.csv`;
  a.click();
  toast('CSV exportado!');
}

// SALES
function renderSales() {
  const el = document.getElementById('sales-list');
  let sales = [];
  state.rifas.forEach(r => {
    r.numbers.forEach(n => {
      if (n.status !== 'free') sales.push({rifa: r.name, num: n.num, buyer: n.buyer, phone: n.phone, status: n.status, price: r.price});
    });
  });
  if (!sales.length) { el.innerHTML = '<div class="empty">Nenhuma venda registrada.</div>'; return; }
  let totalRev = sales.filter(s => s.status === 'paid').reduce((a, s) => a + s.price, 0);
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem">
      <div class="stat-label">Total arrecadado (pagos)</div>
      <div class="stat-value stat-gold">${fmt(totalRev)}</div>
    </div>
    <div style="overflow-x:auto">
      <table class="sales-table">
        <thead><tr><th>Nº</th><th>Rifa</th><th>Comprador</th><th>Telefone</th><th>Status</th><th>Valor</th></tr></thead>
        <tbody>
          ${sales.map(s => `<tr>
            <td><strong>${pad(s.num)}</strong></td>
            <td>${esc(s.rifa)}</td>
            <td>${esc(s.buyer||'-')}</td>
            <td>${esc(s.phone||'-')}</td>
            <td><span class="badge-status ${s.status==='paid'?'badge-finished':'badge-active'}">${s.status==='paid'?'Pago':'Reservado'}</span></td>
            <td>${fmt(s.price)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// WINNER
function renderWinnerTab() {
  const sel = document.getElementById('winner-rifa-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Escolha uma rifa —</option>' + state.rifas.map(r => `<option value="${r.id}">${esc(r.name)} (${r.numbers.filter(n=>n.status!=='free').length} vendidos)</option>`).join('');
  document.getElementById('winner-result').innerHTML = '';
  document.getElementById('manual-pick').style.display = 'none';
  document.getElementById('winner-candidates-info').innerHTML = '';
}

function selectWinnerRifa(id) {
  document.getElementById('winner-rifa-select').value = id;
  loadWinnerCandidates();
}

function loadWinnerCandidates() {
  const id = document.getElementById('winner-rifa-select').value;
  if (!id) { document.getElementById('winner-candidates-info').innerHTML = ''; return; }
  const r = findById(id);
  const paid = r.numbers.filter(n => n.status === 'paid');
  const reserved = r.numbers.filter(n => n.status === 'reserved');
  const free = r.numbers.filter(n => n.status === 'free');
  document.getElementById('winner-candidates-info').innerHTML = `
    <div class="card" style="margin:1rem 0">
      <p>Pagos: <strong>${paid.length}</strong> | Reservados: <strong>${reserved.length}</strong> | Livres: <strong>${free.length}</strong></p>
      ${reserved.length ? '<p style="color:var(--warning);margin-top:.5rem">⚠️ Há números reservados não pagos. Eles não participam do sorteio.</p>' : ''}
    </div>
  `;
  document.getElementById('winner-result').innerHTML = '';
  document.getElementById('manual-pick').style.display = 'none';
}

function drawWinner(mode) {
  const id = document.getElementById('winner-rifa-select').value;
  if (!id) { toast('Selecione uma rifa!'); return; }
  const r = findById(id);
  if (r.winner) { if (!confirm('Esta rifa já tem ganhador. Sortear novamente?')) return; }

  if (mode === 'random') {
    const paid = r.numbers.filter(n => n.status === 'paid');
    if (!paid.length) { toast('Nenhum número pago para sortear! Marque números como pagos primeiro.'); return; }
    const winner = paid[Math.floor(Math.random() * paid.length)];
    r.winner = { num: winner.num, name: winner.buyer, phone: winner.phone };
    r.status = 'finished';
    save();
    showWinnerResult(winner.num, winner.buyer, winner.phone);
  } else if (mode === 'manual') {
    document.getElementById('manual-pick').style.display = 'block';
  }
}

function setManualWinner() {
  const id = document.getElementById('winner-rifa-select').value;
  const num = parseInt(document.getElementById('manual-winner-num').value);
  const r = findById(id);
  if (!num || num < 1 || num > r.qty) { toast('Número inválido!'); return; }
  const n = r.numbers.find(x => x.num === num);
  if (n.status === 'free') { toast('Esse número não foi vendido!'); return; }
  r.winner = { num: num, name: n.buyer || 'Não informado', phone: n.phone || '-' };
  r.status = 'finished';
  save();
  showWinnerResult(num, n.buyer, n.phone);
}

function showWinnerResult(num, name, phone) {
  document.getElementById('winner-result').innerHTML = `
    <div class="card" style="text-align:center;border:2px solid var(--gold-2);box-shadow:var(--gold-glow)">
      <div style="font-size:3rem">🏆</div>
      <h2 class="section-title" style="font-size:1.8rem;color:var(--gold-2)">Ganhador!</h2>
      <div style="font-family:Poppins;font-size:3rem;font-weight:800;margin:1rem 0">Nº ${pad(num)}</div>
      <div style="font-size:1.2rem">${esc(name || 'Não informado')}</div>
      ${phone ? `<div style="color:var(--text-muted)">${esc(phone)}</div>` : ''}
    </div>
  `;
  renderManage(); renderDashboard();
}

// ===== MODAL =====
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d + 'T00:00');
  return date.toLocaleDateString('pt-BR', {day: '2-digit', month: 'long'});
}

// ===== INIT =====
(async function init() {
  await load();
  renderRifa();
  startReservationChecker();
  // Seed demo data if empty (first visit) — so se backend tambem estiver vazio
  if (!state.rifas.length) {
    state.rifas = [{
      id: 'demo1',
      name: 'iPhone 14 Midnight',
      desc: '100% original, nunca aberto, 90% de bateria, Face ID ok. Envio para todo o Brasil.',
      qty: 400,
      price: 10,
      date: '',
      img: '',
      tags: 'Nunca aberto, Bateria 90%, Envio Brasil, Face ID ok',
      status: 'active',
      numbers: Array.from({length: 400}, (_, i) => ({num: i+1, status: 'free', buyer: null, phone: null})),
      winner: null,
      createdAt: Date.now()
    }];
    // Add some demo sales
    [0, 1, 2, 6, 19].forEach(i => {
      state.rifas[0].numbers[i] = {num: i+1, status: 'reserved', buyer: 'João Silva', phone: '11988887777'};
    });
    state.rifas[0].numbers[3] = {num: 4, status: 'paid', buyer: 'Maria Santos', phone: '11999998888'};
    state.rifas[0].numbers[5] = {num: 6, status: 'paid', buyer: 'Pedro Costa', phone: '11777766666'};
    save();
    renderRifa();
  }
})();

// Show "Definir meu PIN secreto" button when PIN is still the default (194521)
(function initPinUi() {
  try {
    const fb = document.getElementById('btn-first-pin');
    const hint = document.getElementById('pin-hint');
    if (isPinDefault() && fb) {
      fb.style.display = 'inline-flex';
      if (hint) hint.textContent = '⚠️ Você ainda usa o PIN padrão. Defina um novo PIN agora.';
    } else if (fb) {
      fb.style.display = 'none';
    }
    // Restore lock display if reloading while locked
    if (isAdminLocked()) {
      if (hint) hint.textContent = `🔒 Bloqueado, aguarde ${getAdminLockRemaining()}s`;
      if (!window._pinLockInterval) {
        window._pinLockInterval = setInterval(() => {
          const r = getAdminLockRemaining();
          const h2 = document.getElementById('pin-hint');
          if (r > 0 && h2) h2.textContent = `🔒 Bloqueado, aguarde ${r}s`;
          if (r <= 0) { clearInterval(window._pinLockInterval); window._pinLockInterval = null; if (h2) h2.textContent = 'Digite seu PIN secreto de 6 dígitos'; }
        }, 1000);
      }
    }
  } catch (e) {}
})();
