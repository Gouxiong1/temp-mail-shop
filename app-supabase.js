// 临时邮箱后台系统
// 数据全部存在 Supabase Postgres，不再用 localStorage 存账号/钱包/订单。
// localStorage 里只留 Supabase Auth 的登录会话 token（换手机重新登录即可看到同一钱包/订单）。
// 图形验证码仍是前端 Canvas 生成——只能防机器人随手刷，不能防有意绕过；
// 真正防刷需 Edge Function 在服务端验码（待做）。
// 支付确认是全自动：买家上传付款截图 → 机器 10 秒一轮识图，清楚且金额/收款人对上就放行，
// 看不清直接打回重传，不转人工。钱包支付直接扣款、立即发货。
const FLOOR = { h3: 100, h12: 200, h24: 300, h72: 400, h168: 500 }; // 分，底价 1/2/3/4/5 元
const TIER_LABEL = { h1: '1小时', h3: '3小时', h12: '12小时', h24: '1天', h72: '3天', h168: '7天' };
function tierLabel(t) { return TIER_LABEL[t] || t; }
const TIERS = [
  { min: 200, self: 0.70, comm: 0.20, label: '200单及以上' },
  { min: 100, self: 0.80, comm: 0.12, label: '100单' },
  { min: 50, self: 0.90, comm: 0.08, label: '50单' },
  { min: 10, self: 0.95, comm: 0.05, label: '10单' },
];
function tierFor(sales) { for (const t of TIERS) if (sales >= t.min) return t; return { min: 0, self: 1, comm: 0, label: '新站主（未满10单）' }; }

const CFG = window.TMAIL_CONFIG || {};
let sb = null;
let meProfile = null;   // profiles 行（服务器上的）
let sites = [];
let adminOn = false;

function money(cents) { return '¥' + (Number(cents || 0) / 100).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 图形验证码（字母+数字混合，Canvas） ----------
const caps = {};
function randCode(n = 5) { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
function drawCaptcha(kind) {
  const cv = document.getElementById(kind === 'buy' ? 'capBuy' : kind === 'reg' ? 'capReg' : 'capSub');
  if (!cv) return;
  const code = randCode(5); caps[kind] = code;
  const x = cv.getContext('2d'); if (!x) return; // 无 canvas 环境时不中断启动
  x.fillStyle = '#fff'; x.fillRect(0, 0, 140, 44);
  x.strokeStyle = '#ddd';
  for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(Math.random() * 140, Math.random() * 44); x.lineTo(Math.random() * 140, Math.random() * 44); x.stroke(); }
  for (let i = 0; i < 40; i++) { x.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.4) + ')'; x.fillRect(Math.random() * 140, Math.random() * 44, 2, 2); }
  x.font = 'bold 26px sans-serif';
  for (let i = 0; i < code.length; i++) { x.fillStyle = 'hsl(' + Math.floor(Math.random() * 360) + ',60%,35%)'; x.save(); x.translate(12 + i * 24, 30); x.rotate((Math.random() - .5) * .4); x.fillText(code[i], 0, 0); x.restore(); }
}
function checkCaptcha(kind, input) { return input && input.trim().toLowerCase() === (caps[kind] || '').toLowerCase(); }

// ---------- 会话 / 资料 ----------
async function refreshMe() {
  const { data } = await sb.auth.getUser();
  if (!data.user) { meProfile = null; adminOn = false; refreshWho(); return null; }
  const { data: p } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
  meProfile = p || null;
  adminOn = !!(meProfile && meProfile.role === 'admin');
  refreshWho();
  return meProfile;
}
function refreshWho() {
  const el = document.getElementById('who');
  el.textContent = meProfile
    ? ('已登录：' + meProfile.username + '（' + (meProfile.role === 'sub' ? '分站站主' : meProfile.role === 'admin' ? '总站站主' : '用户') + '）钱包 ' + money(meProfile.wallet_cents))
    : '未登录';
}
function show(v) {
  document.querySelectorAll('.view').forEach(e => e.style.display = 'none');
  document.getElementById('view-' + v).style.display = 'block';
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'wallet') renderWallet();
  if (v === 'orders') renderOrders();
  if (v === 'admin') renderBackend();
  if (v === 'shop') renderShop();
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.v));

// ---------- 商城 ----------
async function loadSites() {
  const { data, error } = await sb.from('sites').select('*').order('is_main', { ascending: false });
  if (error) { alert('读站点失败：' + error.message); return; }
  sites = data || [];
}
function siteById(id) { return sites.find(s => s.id === id) || sites[0]; }
async function renderShop() {
  await loadSites();
  const sel = document.getElementById('siteSel');
  sel.innerHTML = sites.map(s => '<option value="' + s.id + '">' + esc(s.name) + '</option>').join('');
  const q = new URLSearchParams(location.search).get('site');
  if (q && sites.find(s => s.id === q)) sel.value = q;
  updateTier(); sel.onchange = updateTier; drawCaptcha('buy');
  const pre = document.getElementById('emailPrefix');
  if (pre && !pre.value) pre.value = randomPrefix();
}
function updateTier() {
  const s = siteById(document.getElementById('siteSel').value);
  document.getElementById('siteInfo').innerHTML = '本站价格：3小时 ' + money(s.price_h3_cents) + ' · 12小时 ' + money(s.price_h12_cents) + ' · 1天 ' + money(s.price_h24_cents) + ' · 3天 ' + money(s.price_h72_cents) + ' · 7天 ' + money(s.price_h168_cents);
  const g = document.getElementById('tierGrid');
  g.innerHTML = [['h3', '3小时', s.price_h3_cents], ['h12', '12小时', s.price_h12_cents], ['h24', '1天', s.price_h24_cents], ['h72', '3天', s.price_h72_cents], ['h168', '7天', s.price_h168_cents]].map(function (a, i) {
    return '<div class="price ' + (i === 0 ? 'sel' : '') + '" data-k="' + a[0] + '" onclick="pickTier(\'' + a[0] + '\')"><b>' + a[1] + '</b><br><span style="font-size:20px">' + money(a[2]) + '</span><br><span class="muted">本站价</span></div>';
  }).join('');
  g.dataset.k = 'h3'; calcPrice(); refreshDomainStock();
}
// ---------- 域名现货：哪个域名没货就禁用下拉里对应那一项 ----------
// 后端约定：moakt_pool_available() 无参数，返回 [{address, domain}]；没上线或报错时全部保持可选，页面不报错。
const MOAKT_DOMAINS = ['tmpmail.org', 'teml.net', 'tmpbox.net'];
async function refreshDomainStock() {
  if (!sb) return;
  let avail = null;
  try {
    const { data, error } = await sb.rpc('moakt_pool_available');
    if (error) return;
    avail = data;
  } catch (e) { return; }
  const has = new Set((Array.isArray(avail) ? avail : []).map(x => x && x.domain));
  const sel = document.getElementById('domainSel');
  if (!sel) return;
  MOAKT_DOMAINS.forEach(d => {
    const opt = sel.querySelector('option[value="' + d + '"]');
    if (!opt) return;
    const inStock = has.has(d);
    opt.disabled = !inStock;
    opt.textContent = d + (inStock ? '' : '（已售完）');
    if (!inStock && sel.value === d) sel.value = 'mailtm';
  });
}
function pickTier(k) { document.getElementById('tierGrid').dataset.k = k; document.querySelectorAll('#tierGrid .price').forEach(e => e.classList.toggle('sel', e.dataset.k === k)); calcPrice(); }
function calcPrice() {
  const s = siteById(document.getElementById('siteSel').value);
  const k = document.getElementById('tierGrid').dataset.k || 'h3';
  const qty = Math.max(1, parseInt(document.getElementById('qty').value || '1'));
  let unit = k === 'h3' ? s.price_h3_cents : k === 'h12' ? s.price_h12_cents : k === 'h24' ? s.price_h24_cents : k === 'h72' ? s.price_h72_cents : s.price_h168_cents;
  let note = '';
  if (meProfile && meProfile.role === 'sub' && meProfile.site_id === s.id) {
    const t = tierFor(s.sales); unit = Math.round(unit * t.self);
    note = '你是本站站主，本站自购优惠 ' + (t.self * 100) + '%（累计售出 ' + s.sales + ' 单，' + t.label + '），本单不享受分成。';
  }
  document.getElementById('priceLine').textContent = '应付：' + money(unit * qty) + '（单价 ' + money(unit) + ' × ' + qty + '）';
  document.getElementById('selfNote').textContent = note;
}
document.getElementById('qty').addEventListener('input', calcPrice);
document.querySelectorAll('input[name=pay]').forEach(r => r.onchange = () => {
  const v = document.querySelector('input[name=pay]:checked').value;
  const box = document.getElementById('scanBox');
  if (v === 'wallet') { box.style.display = 'none'; } else {
    box.style.display = 'block';
    document.getElementById('qrTitle').textContent = v === 'alipay' ? '支付宝收款码' : '微信收款码';
    document.getElementById('qrImg').src = v === 'alipay' ? 'alipay.jpg' : 'wechat.jpg';
  }
});

// ---------- 付款截图：压缩 + 提交 + 轮询确认 ----------
// 截图在浏览器里压到最长边 1000px 再上传；确认由机器 10 秒一轮自动识图，30 秒内出结果。
function downscaleShot(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', 0.75));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('截图读不出来'));
    img.src = URL.createObjectURL(file);
  });
}
function currentTotal() {
  const s = siteById(document.getElementById('siteSel').value);
  const k = document.getElementById('tierGrid').dataset.k || 'h3';
  const qty = Math.max(1, parseInt(document.getElementById('qty').value || '1'));
  let unit = k === 'h3' ? s.price_h3_cents : k === 'h12' ? s.price_h12_cents : k === 'h24' ? s.price_h24_cents : k === 'h72' ? s.price_h72_cents : s.price_h168_cents;
  if (meProfile && meProfile.role === 'sub' && meProfile.site_id === s.id) unit = Math.round(unit * tierFor(s.sales).self);
  return { unit, total: unit * qty };
}
function pollProof(proofId, msgEl, onApproved) {
  let n = 0;
  const timer = setInterval(async () => {
    n++;
    const { data, error } = await sb.rpc('proof_status', { p_proof_id: proofId });
    if (error || !data) { if (n > 24) { clearInterval(timer); msgEl.innerHTML = '<div class="alert">确认超时了，请去“我的订单”查看这单有没有发货，或重新上传截图。</div>'; } return; }
    if (data.status === 'approved') { clearInterval(timer); onApproved(data); }
    else if (data.status === 'rejected') {
      clearInterval(timer);
      msgEl.innerHTML = '<div class="alert">截图没通过：' + esc(data.reject_reason || '截图看不清') + '。请重新拍一张清楚的付款成功截图（要能看到金额和收款人），再点一次确认下单。</div>';
      drawCaptcha('buy');
    } else if (n > 24) { clearInterval(timer); msgEl.innerHTML = '<div class="alert">确认超时了，请去“我的订单”查看这单有没有发货，或重新上传截图。</div>'; }
  }, 5000);
}
function orderOkHtml(data, email) {
  return '<div class="ok">✅ 已发货！订单号：<b>' + esc(data.order_id) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + esc(data.order_id) + '\')">复制订单号</button><br>临时邮箱：<b>' + esc(email) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + esc(email) + '\')">复制邮箱</button><br>时长 ' + esc(tierLabel(data.tier || '')) + '，取货区显示一份；收件箱里也会收到发货邮件。'
    + (data.comm_cents ? '<br>分站分成 ' + money(data.comm_cents) + ' 已记入站主待结算分成，半个月一结。' : '')
    + (data.is_self ? '<br>本站自购，本单不享受分成。' : '')
    + '<br>请记好订单号，以后不用登录也能在“查订单”里用订单号或这个邮箱地址查到这单。请去“我的订单 / 取货”查看倒计时，去“查看验证码”查看收到的验证码。</div>';
}

// ---------- 自定义前缀 + 先生成后付款 ----------
// 前缀只允许小写字母数字及 . _ -，3–32 位，首尾要是字母或数字；后缀点开下拉选域名。
// 点“点击生成”后只登记待付款订单（不扣钱不发邮箱），等本机建好邮箱再付款激活。
const PREFIX_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;
const DOMAIN_OF = { mailtm: 'euploading.com', 'tmpmail.org': 'tmpmail.org', 'teml.net': 'teml.net', 'tmpbox.net': 'tmpbox.net' };
let pendingOrder = null; // {id, temp_email, provider}
function randomPrefix() {
  const h = 'abcdefghjkmnpqrstuvwxyz0123456789'; let s = '';
  for (let i = 0; i < 10; i++) s += h[Math.floor(Math.random() * h.length)];
  return s;
}
function validPrefix(v) { return PREFIX_RE.test(v); }
function prefixInput() { return document.getElementById('emailPrefix').value.trim().toLowerCase(); }
document.getElementById('emailPrefix').addEventListener('input', () => {
  const v = prefixInput();
  const hint = document.getElementById('prefixHint');
  if (!v) { hint.textContent = '前缀用小写字母、数字和 . _ -，3–32 位。'; hint.className = 'muted'; return; }
  if (validPrefix(v)) { hint.textContent = '可以用的前缀：' + v + '@' + DOMAIN_OF[document.getElementById('domainSel').value]; hint.className = 'muted'; }
  else { hint.textContent = '前缀不对：只能用小写字母、数字和 . _ -，3–32 位，首尾要是字母或数字。'; hint.className = 'red'; }
});
document.getElementById('domainSel').addEventListener('change', () => {
  const v = prefixInput();
  const hint = document.getElementById('prefixHint');
  if (v && validPrefix(v)) hint.textContent = '可以用的前缀：' + v + '@' + DOMAIN_OF[document.getElementById('domainSel').value];
  refreshDomainStock();
});

async function generateOrder() {
  const msg = document.getElementById('genMsg');
  const btn = document.getElementById('genBtn');
  if (!meProfile) { msg.innerHTML = '<div class="alert">请先注册 / 登录用户，再生成邮箱。</div>'; return; }
  if (!checkCaptcha('buy', document.getElementById('capBuyIn').value)) { msg.innerHTML = '<div class="alert">图形验证码不对，请重新输入（字母+数字，点图可换一张）。</div>'; drawCaptcha('buy'); return; }
  const prefix = prefixInput();
  if (!validPrefix(prefix)) { msg.innerHTML = '<div class="alert">前缀不对：只能用小写字母、数字和 . _ -，3–32 位，首尾要是字母或数字。</div>'; return; }
  const provider = document.getElementById('domainSel').value;
  const s = siteById(document.getElementById('siteSel').value);
  const k = document.getElementById('tierGrid').dataset.k || 'h3';
  const qty = Math.max(1, parseInt(document.getElementById('qty').value || '1'));
  msg.innerHTML = '<div class="muted">正在生成邮箱地址…（一般 1 分钟内）</div>';
  btn.disabled = true;
  document.getElementById('genBox').style.display = 'none';
  const { data, error } = await sb.rpc('create_pending_order', {
    p_site_id: s.id, p_tier: k, p_qty: qty, p_provider: provider, p_prefix: prefix,
  });
  if (error) {
    msg.innerHTML = '<div class="alert">生成失败：' + esc(error.message) + '</div>';
    drawCaptcha('buy'); btn.disabled = false; return;
  }
  pendingOrder = { id: data.order_id, temp_email: data.temp_email, provider };
  pollPending(data.order_id, msg, btn);
}
function pollPending(orderId, msg, btn) {
  let n = 0;
  const timer = setInterval(async () => {
    n++;
    const { data, error } = await sb.rpc('pending_order_status', { p_order_id: orderId });
    if (error || !data) {
      if (n > 60) { clearInterval(timer); msg.innerHTML = '<div class="alert">生成超时了，请再点一次“点击生成”（同一个前缀会接着上次的继续生成，不会重复扣钱）。</div>'; btn.disabled = false; }
      return;
    }
    if (data.status === 'ready') {
      clearInterval(timer);
      pendingOrder = { id: orderId, temp_email: data.temp_email, provider: data.provider };
      msg.innerHTML = '';
      document.getElementById('genAddr').innerHTML = '你的临时邮箱：<b>' + esc(data.temp_email) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + esc(data.temp_email) + '\')">复制邮箱</button><br><span class="muted">请在 10 分钟内付款激活，超时这个地址会被收回。</span>';
      document.getElementById('genBox').style.display = 'block';
      btn.disabled = false;
      refreshDomainStock();
    } else if (data.status === 'failed') {
      clearInterval(timer);
      msg.innerHTML = '<div class="alert">' + esc(failText(data.fail_reason || '')) + '</div>';
      drawCaptcha('buy'); btn.disabled = false;
    } else if (n > 60) {
      clearInterval(timer);
      msg.innerHTML = '<div class="alert">生成超时了，请再点一次“点击生成”（同一个前缀会接着上次的继续生成，不会重复扣钱）。</div>';
      btn.disabled = false;
    }
  }, 3000);
}
function failText(r) {
  if (/taken|已被别人用/.test(r)) return '这个前缀已经被别人用了，换一个再试';
  if (/sold_out|没货|已售完/.test(r)) return '这个域名暂时没货，请换个域名试试';
  if (/domain_not_offered|不支持/.test(r)) return '这个域名暂时不支持自定义前缀，请换个域名试试';
  return r || '生成失败，换个前缀再试';
}

async function payPending() {
  const msg = document.getElementById('payMsg');
  if (!pendingOrder) { msg.innerHTML = '<div class="alert">请先点“点击生成”生成邮箱地址。</div>'; return; }
  const s = siteById(document.getElementById('siteSel').value);
  const k = document.getElementById('tierGrid').dataset.k || 'h3';
  const qty = Math.max(1, parseInt(document.getElementById('qty').value || '1'));
  const pay = document.querySelector('input[name=pay]:checked').value;
  const provider = pendingOrder.provider;
  if (pay === 'wallet') {
    // 钱包直接扣款，立即激活
    const { data, error } = await sb.rpc('buy_with_wallet', {
      p_site_id: s.id, p_tier: k, p_qty: qty, p_pay_method: pay, p_temp_email: pendingOrder.temp_email, p_provider: provider, p_pending_order_id: pendingOrder.id,
    });
    if (error) { msg.innerHTML = '<div class="alert">付款失败：' + esc(error.message) + '</div>'; drawCaptcha('buy'); return; }
    await refreshMe();
    msg.innerHTML = orderOkHtml({ order_id: data.order_id, tier: k, comm_cents: data.comm_cents, is_self: data.is_self }, data.temp_email);
    pendingOrder = null;
    drawCaptcha('buy');
    refreshDomainStock();
    return;
  }
  // 扫码支付：上传截图 → 机器 10 秒一轮自动确认，30 秒内放行激活
  const f = document.getElementById('shotFile').files[0];
  if (!f) { msg.innerHTML = '<div class="alert">扫码支付请上传付款截图，截图是确认到账的唯一凭证。</div>'; return; }
  if (Date.now() - f.lastModified > 180000) { msg.innerHTML = '<div class="alert">已过时 / 已过期：截图时间与上传时间相差超过 3 分钟，请重新下单付款。</div>'; return; }
  msg.innerHTML = '<div class="muted">正在上传截图并自动确认…（清楚的截图一般 30 秒内确认放行）</div>';
  let img;
  try { img = await downscaleShot(f); } catch (e) { msg.innerHTML = '<div class="alert">截图读不出来，请换一张清楚的付款截图重新上传。</div>'; return; }
  const { unit, total } = currentTotal();
  const { data, error } = await sb.rpc('submit_proof', {
    p_kind: 'order', p_amount_cents: total, p_pay_method: pay,
    p_site_id: s.id, p_tier: k, p_qty: qty, p_image_data: img, p_provider: provider, p_pending_order_id: pendingOrder.id,
  });
  if (error) { msg.innerHTML = '<div class="alert">提交截图失败：' + esc(error.message) + '</div>'; drawCaptcha('buy'); return; }
  msg.innerHTML = '<div class="muted">截图已提交，正在自动确认（一般 30 秒内），请不要离开本页…</div>';
  pollProof(data.proof_id, msg, async (st) => {
    const { data: ord } = await sb.rpc('lookup_order', { p_query: st.order_id });
    const o = Array.isArray(ord) ? ord[0] : ord;
    await refreshMe();
    msg.innerHTML = orderOkHtml({ order_id: st.order_id, tier: k, comm_cents: 0, is_self: false }, o ? o.temp_email : '');
    pendingOrder = null;
    drawCaptcha('buy');
    refreshDomainStock();
  });
}

// ---------- 钱包 / 充值 ----------
async function renderWallet() {
  const box = document.getElementById('walletBox');
  if (!meProfile) { box.innerHTML = '<p class="red">请先注册 / 登录，才能使用网站钱包。每个用户和每个分站站主都有自己的网站钱包，余额互不混。</p>'; document.getElementById('txList').innerHTML = ''; return; }
  await refreshMe();
  box.innerHTML = '<p>当前账号：<b>' + esc(meProfile.username) + '</b>（' + (meProfile.role === 'sub' ? '分站站主' : meProfile.role === 'admin' ? '总站站主' : '用户') + '）</p>'
    + '<p>网站钱包余额：<span class="wallet">' + money(meProfile.wallet_cents) + '</span></p>'
    + '<p>待结算分成：<b>' + money(meProfile.pending_comm_cents || 0) + '</b>（半个月一结，结算后进入钱包）</p>';
  const { data: tx } = await sb.from('wallet_txns').select('*').eq('user_id', meProfile.id).order('created_at', { ascending: false }).limit(20);
  document.getElementById('txList').innerHTML = tx && tx.length
    ? '<table><tr><th>时间</th><th>类型</th><th>金额</th><th>备注</th></tr>' + tx.map(t => '<tr><td>' + esc(new Date(t.created_at).toLocaleString()) + '</td><td>' + esc(t.kind) + '</td><td>' + money(t.amount_cents) + '</td><td>' + esc(t.note || '') + '</td></tr>').join('') + '</table>'
    : '<p class="muted">暂无流水。</p>';
}
function showTopQR() {
  const amt = parseFloat(document.getElementById('topAmt').value);
  if (!meProfile) { alert('请先注册 / 登录'); return; }
  if (!(amt >= 5)) { alert('最低充值 5 元'); return; }
  document.getElementById('topBox').style.display = 'block';
  const p = document.getElementById('topPay').value;
  document.getElementById('topQR').src = p === 'alipay' ? 'alipay.jpg' : 'wechat.jpg';
  document.getElementById('topMsg').textContent = '充值 ' + money(Math.round(amt * 100)) + '，到账 ' + money(Math.round(amt * 110)) + '（110%）。扫码付款后上传付款截图，确认后到账。';
}
async function confirmTopup() {
  if (!meProfile) return;
  const amt = parseFloat(document.getElementById('topAmt').value);
  if (!(amt >= 5)) return;
  const f = document.getElementById('topShot').files[0];
  const msgEl = document.getElementById('topMsg');
  if (!f) { msgEl.innerHTML = '<span class="red">请先上传付款截图，截图是确认到账的唯一凭证。</span>'; return; }
  if (Date.now() - f.lastModified > 180000) { msgEl.innerHTML = '<span class="red">已过时 / 已过期：截图时间与上传时间相差超过 3 分钟，请重新付款截图。</span>'; return; }
  msgEl.innerHTML = '<span class="muted">正在上传截图并自动确认…（清楚的截图一般 30 秒内到账）</span>';
  let img;
  try { img = await downscaleShot(f); } catch (e) { msgEl.innerHTML = '<span class="red">截图读不出来，请换一张清楚的付款截图重新上传。</span>'; return; }
  const { data, error } = await sb.rpc('submit_proof', {
    p_kind: 'topup', p_amount_cents: Math.round(amt * 100), p_pay_method: document.getElementById('topPay').value,
    p_site_id: null, p_tier: null, p_qty: null, p_image_data: img,
  });
  if (error) { msgEl.innerHTML = '<span class="red">提交截图失败：' + esc(error.message) + '</span>'; return; }
  pollProof(data.proof_id, msgEl, async (st) => {
    await refreshMe(); renderWallet();
    msgEl.innerHTML = '<span class="green">已到账 ' + money(st.credit_cents || 0) + '（按 110% 入账）。</span>';
  });
}

// ---------- 订单 / 收件箱 ----------
async function renderOrders() {
  const el = document.getElementById('orderList');
  if (!meProfile) { el.innerHTML = '<p class="muted">请先登录查看自己的订单。</p>'; return; }
  const { data: list } = await sb.from('orders').select('*').eq('buyer_id', meProfile.id).order('created_at', { ascending: false }).limit(20);
  if (!list || !list.length) { el.innerHTML = '<p class="muted">暂无订单。买了之后这里显示临时邮箱和剩余时间。</p>'; return; }
  el.innerHTML = list.map(o => {
    const left = new Date(o.expires_at).getTime() - Date.now();
    const leftMin = Math.max(0, Math.floor(left / 60000));
    return '<div class="card"><b>订单 ' + o.id + '</b> · ' + esc(o.site_name) + ' · ' + tierLabel(o.tier) + ' ×' + o.qty + ' · ' + money(o.total_cents)
      + '<br>临时邮箱：<b>' + esc(o.temp_email) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + o.temp_email + '\')">复制</button>'
      + '<br>状态：' + (left <= 0 ? '<span class="red">已过期</span>' : '<span class="green">使用中，剩约 ' + leftMin + ' 分钟</span>') + ' · 有效期 ' + o.duration_hours + ' 小时'
      + ' <button class="ghost" onclick="showInboxFor(\'' + o.temp_email + '\')">去查看验证码</button></div>';
  }).join('');
}
function showInboxFor(email) { document.getElementById('inboxAddr').value = email; show('inbox'); showInbox(); }
async function showInbox() {
  const addr = document.getElementById('inboxAddr').value.trim();
  const el = document.getElementById('inboxList');
  if (!addr) { el.innerHTML = '<p class="red">请先输入买到的临时邮箱地址。</p>'; return; }
  const { data: list, error } = await sb.from('mails').select('*').eq('temp_email', addr).order('created_at', { ascending: false }).limit(20);
  if (error) { el.innerHTML = '<p class="red">查询失败：' + esc(error.message) + '</p>'; return; }
  el.innerHTML = (list && list.length
    ? list.map(x => '<div class="card"><b>' + esc(x.subject) + '</b><br>发件人：' + (/moakt/i.test(x.from_name || '') ? '系统邮件' : esc(x.from_name)) + ' · ' + esc(new Date(x.created_at).toLocaleString()) + '<br>' + esc(x.body) + (x.code ? '<br>验证码：<b style="font-size:22px">' + esc(x.code) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + x.code + '\')">复制验证码</button>' : '') + '</div>').join('')
    : '<p class="muted">暂时还没有收到邮件，等十几秒再刷新。</p>')
    + '<p class="muted">新邮件一般几十秒内出现，本页每 20 秒自动刷新一次。</p>';
}

// ---------- 公开查订单（不用登录，订单号或临时邮箱地址） ----------
async function queryOrder() {
  const q = document.getElementById('queryInput').value.trim();
  const el = document.getElementById('queryResult');
  if (!q) { el.innerHTML = '<p class="red">请先输入订单号或临时邮箱地址。</p>'; return; }
  el.innerHTML = '<p class="muted">正在查询…</p>';
  const { data, error } = await sb.rpc('lookup_order', { p_query: q });
  if (error) { el.innerHTML = '<p class="red">查询失败：' + esc(error.message) + '</p>'; return; }
  const o = Array.isArray(data) ? data[0] : data;
  if (!o) { el.innerHTML = '<p class="red">没查到这单：订单号或邮箱地址不对，请核对后重新输入。</p>'; return; }
  const left = new Date(o.expires_at).getTime() - Date.now();
  const leftMin = Math.max(0, Math.floor(left / 60000));
  el.innerHTML = '<div class="card"><b>订单 ' + esc(o.order_id) + '</b> · ' + esc(o.site_name) + ' · ' + tierLabel(o.tier) + ' ×' + o.qty + ' · ' + money(o.total_cents)
    + '<br>临时邮箱：<b>' + esc(o.temp_email) + '</b> <button class="ghost" onclick="navigator.clipboard.writeText(\'' + o.temp_email + '\')">复制</button>'
    + '<br>状态：' + (left <= 0 ? '<span class="red">已过期</span>' : '<span class="green">使用中，剩约 ' + leftMin + ' 分钟</span>') + ' · 有效期 ' + o.duration_hours + ' 小时'
    + '<br>下单时间：' + esc(new Date(o.created_at).toLocaleString())
    + ' <button class="ghost" onclick="showInboxFor(\'' + o.temp_email + '\')">去查看验证码</button></div>';
}

// ---------- 注册 / 登录 ----------
async function registerUser() {
  if (!checkCaptcha('reg', document.getElementById('capRegIn').value)) { document.getElementById('rgMsg').innerHTML = '<span class="red">图形验证码不对，请重新输入。</span>'; drawCaptcha('reg'); return; }
  const u = document.getElementById('rgUser').value.trim(), e = document.getElementById('rgEmail').value.trim(), p = document.getElementById('rgPass').value;
  if (!u || !p || !e) { document.getElementById('rgMsg').innerHTML = '<span class="red">用户名、邮箱、密码都要填。</span>'; return; }
  const { data, error } = await sb.auth.signUp({ email: e, password: p });
  if (error) { document.getElementById('rgMsg').innerHTML = '<span class="red">注册失败：' + esc(error.message) + '</span>'; return; }
  const uid = data.user && data.user.id;
  if (!uid) { document.getElementById('rgMsg').innerHTML = '<span class="red">注册后请先到邮箱确认（若已关闭邮件确认，可直接登录）。</span>'; return; }
  const { error: e2 } = await sb.from('profiles').insert({ id: uid, username: u, email: e, role: 'user' });
  if (e2) { document.getElementById('rgMsg').innerHTML = '<span class="red">建资料失败（用户名可能已存在）：' + esc(e2.message) + '</span>'; return; }
  await refreshMe();
  document.getElementById('rgMsg').innerHTML = '<span class="green">注册成功，已自动登录，网站钱包已创建，余额 ¥0.00。换手机登录同一邮箱即可看到同一钱包。</span>';
  drawCaptcha('reg');
}
async function loginUser() {
  const u = document.getElementById('lgUser').value.trim(), p = document.getElementById('lgPass').value;
  // 登录用邮箱：用户名就是注册邮箱前缀时可直接填邮箱；这里先按邮箱登录，
  // 若用户只记得用户名，可在 profiles 里按 username 查 email 再登录（见下方）。
  // 登录必须用邮箱（RLS 不允许未登录用户按用户名反查别人的邮箱，这是防泄露的正确设计）。
  const email = u.includes('@') ? u : null;
  if (!email) { document.getElementById('lgMsg').innerHTML = '<span class="red">请用注册邮箱登录（不是用户名）。</span>'; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password: p });
  if (error) { document.getElementById('lgMsg').innerHTML = '<span class="red">用户名或密码不对。</span>'; return; }
  await refreshMe();
  document.getElementById('lgMsg').innerHTML = '<span class="green">登录成功。</span>';
}
async function logout() { await sb.auth.signOut(); meProfile = null; adminOn = false; refreshWho(); alert('已退出'); }

async function registerSubsite() {
  if (!checkCaptcha('sub', document.getElementById('capSubIn').value)) { document.getElementById('ssMsg').innerHTML = '<span class="red">图形验证码不对，请重新输入。</span>'; drawCaptcha('sub'); return; }
  const name = document.getElementById('ssName').value.trim(), u = document.getElementById('ssUser').value.trim(),
    e = document.getElementById('ssEmail').value.trim(), p = document.getElementById('ssPass').value;
  if (!name || !u || !e || !p) { document.getElementById('ssMsg').innerHTML = '<span class="red">分站名、用户名、常用邮箱、密码都要填，常用邮箱供分佣金用。</span>'; return; }
  const { data, error } = await sb.auth.signUp({ email: e, password: p });
  if (error) { document.getElementById('ssMsg').innerHTML = '<span class="red">注册失败：' + esc(error.message) + '</span>'; return; }
  const uid = data.user && data.user.id;
  if (!uid) { document.getElementById('ssMsg').innerHTML = '<span class="red">注册后请先到邮箱确认（若已关闭邮件确认，可直接登录）。</span>'; return; }
  const id = 's' + Date.now().toString().slice(-6);
  const { error: e2 } = await sb.from('profiles').insert({ id: uid, username: u, email: e, role: 'sub', site_id: id });
  if (e2) { document.getElementById('ssMsg').innerHTML = '<span class="red">建资料失败（用户名可能已存在）：' + esc(e2.message) + '</span>'; return; }
  const { error: e3 } = await sb.from('sites').insert({ id, name, owner_id: uid, owner_username: u, commission_email: e, price_h1_cents: 100, price_h3_cents: FLOOR.h3, price_h12_cents: FLOOR.h12, price_h24_cents: FLOOR.h24, price_h72_cents: FLOOR.h72, price_h168_cents: FLOOR.h168, sales: 0, is_main: false });
  if (e3) { document.getElementById('ssMsg').innerHTML = '<span class="red">建分站失败：' + esc(e3.message) + '</span>'; return; }
  await refreshMe();
  document.getElementById('ssMsg').innerHTML = '<span class="green">分站注册成功！分站名：' + esc(name) + '，你的网站钱包已创建，余额 ¥0.00。分站链接：?site=' + id + '。分成按累计售出等级结算，半个月一结，分佣金打到你留的常用邮箱对应的钱包里。</span>';
  drawCaptcha('sub'); renderShop();
}

// ---------- 我的后台：登录后按角色显示 ----------
async function renderBackend() {
  if (!sites.length) await loadSites();
  const loginBox = document.getElementById('backendLogin');
  const adminBox = document.getElementById('adminBox');
  const subBox = document.getElementById('subBox');
  const plainBox = document.getElementById('plainBox');
  const priceBox = document.getElementById('priceBox');
  [loginBox, adminBox, subBox, plainBox, priceBox].forEach(e => { if (e) e.style.display = 'none'; });
  if (!meProfile) { loginBox.style.display = 'block'; return; }
  if (meProfile.role === 'admin') {
    adminBox.style.display = 'block'; priceBox.style.display = 'block';
    renderAdmin();
    const main = sites.find(s => s.is_main);
    if (main) fillPrices(main);
  } else if (meProfile.role === 'sub') {
    subBox.style.display = 'block'; priceBox.style.display = 'block';
    renderSubBackend();
    const mine = sites.find(s => s.id === meProfile.site_id);
    if (mine) fillPrices(mine);
  } else {
    plainBox.style.display = 'block';
  }
}
function fillPrices(s) {
  document.getElementById('prP3').value = (s.price_h3_cents / 100);
  document.getElementById('prP12').value = (s.price_h12_cents / 100);
  document.getElementById('prP24').value = (s.price_h24_cents / 100);
  document.getElementById('prP72').value = (s.price_h72_cents / 100);
  document.getElementById('prP168').value = (s.price_h168_cents / 100);
}
async function renderSubBackend() {
  const mine = sites.find(s => s.id === meProfile.site_id);
  if (!mine) {
    document.getElementById('subInfo').innerHTML = '<p class="red">还没绑定分站。</p>';
    document.getElementById('subOrders').innerHTML = '';
    document.getElementById('subComms').innerHTML = '';
    return;
  }
  const p = await refreshMe();
  if (!p) return;
  const { data: ords } = await sb.from('orders').select('*').eq('site_id', mine.id).order('created_at', { ascending: false }).limit(50);
  const { data: comms } = await sb.from('commissions').select('*').eq('owner_id', meProfile.id).order('created_at', { ascending: false }).limit(20);
  const t = tierFor(mine.sales);
  document.getElementById('subInfo').innerHTML = '分站名：<b>' + esc(mine.name) + '</b> · 分站链接：?site=' + mine.id
    + '<br>累计售出 ' + mine.sales + ' 单 · ' + t.label + ' · 自购 ' + (t.self * 100) + '% · 分成 ' + (t.comm * 100) + '%'
    + '<br>钱包余额：<b>' + money(meProfile.wallet_cents) + '</b> · 待结算分成：<b>' + money(meProfile.pending_comm_cents || 0) + '</b>（半个月一结）';
  document.getElementById('subOrders').innerHTML = ords && ords.length
    ? '<table><tr><th>订单</th><th>买家</th><th>金额</th><th>邮箱</th><th>时间</th></tr>' + ords.map(o => '<tr><td>' + o.id + '</td><td>' + esc(o.buyer_username) + '</td><td>' + money(o.total_cents) + '</td><td>' + esc(o.temp_email) + '</td><td>' + new Date(o.created_at).toLocaleString() + '</td></tr>').join('') + '</table>'
    : '<p class="muted">暂无订单。</p>';
  document.getElementById('subComms').innerHTML = comms && comms.length
    ? '<table><tr><th>订单</th><th>金额</th><th>比例</th><th>时间</th></tr>' + comms.map(c => '<tr><td>' + c.order_id + '</td><td>' + money(c.amount_cents) + '</td><td>' + (Number(c.rate) * 100) + '%</td><td>' + new Date(c.created_at).toLocaleString() + '</td></tr>').join('') + '</table>'
    : '<p class="muted">暂无分成。</p>';
}
async function saveMyPrices() {
  const msg = document.getElementById('prMsg');
  if (!meProfile) { msg.innerHTML = '<span class="red">请先登录。</span>'; return; }
  const isAdmin = meProfile.role === 'admin';
  const target = isAdmin ? sites.find(s => s.is_main) : sites.find(s => s.id === meProfile.site_id);
  if (!target) { msg.innerHTML = '<span class="red">找不到要改的站点。</span>'; return; }
  const p3 = Math.round(+document.getElementById('prP3').value * 100),
    p12 = Math.round(+document.getElementById('prP12').value * 100),
    p24 = Math.round(+document.getElementById('prP24').value * 100),
    p72 = Math.round(+document.getElementById('prP72').value * 100),
    p168 = Math.round(+document.getElementById('prP168').value * 100);
  // 底价参照：总站改价用 FLOOR，分站改价用总站当时的价格，取不到才用 FLOOR 兜底
  const main = sites.find(s => s.is_main);
  const fl = isAdmin ? FLOOR : (main ? { h3: main.price_h3_cents, h12: main.price_h12_cents, h24: main.price_h24_cents, h72: main.price_h72_cents, h168: main.price_h168_cents } : FLOOR);
  const bad = [];
  if (p3 < fl.h3) bad.push('3小时不能低于 ' + money(fl.h3));
  if (p12 < fl.h12) bad.push('12小时不能低于 ' + money(fl.h12));
  if (p24 < fl.h24) bad.push('1天不能低于 ' + money(fl.h24));
  if (p72 < fl.h72) bad.push('3天不能低于 ' + money(fl.h72));
  if (p168 < fl.h168) bad.push('7天不能低于 ' + money(fl.h168));
  if (bad.length) { msg.innerHTML = '<span class="red">' + bad.join('；') + '，请调高后再提交。</span>'; return; }
  const { error } = await sb.from('sites').update({ price_h3_cents: p3, price_h12_cents: p12, price_h24_cents: p24, price_h72_cents: p72, price_h168_cents: p168 }).eq('id', target.id);
  if (error) { msg.innerHTML = '<span class="red">保存失败：' + esc(error.message) + '</span>'; return; }
  msg.innerHTML = '<span class="green">定价已保存。</span>';
  renderShop();
}
async function renderAdmin() {
  const { data: orders } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
  const { data: users } = await sb.from('profiles').select('*').order('created_at', { ascending: true });
  const { data: allSites } = await sb.from('sites').select('*').order('created_at', { ascending: true });
  const total = (orders || []).reduce((a, o) => a + o.total_cents, 0);
  document.getElementById('adminStats').innerHTML = '订单 ' + (orders || []).length + ' 单 · 总金额 ' + money(total) + ' · 用户/站主 ' + (users || []).length + ' 人 · 分站 ' + (allSites || []).filter(s => !s.is_main).length + ' 个 · 待结算分成合计 ' + money((users || []).reduce((a, u) => a + (u.pending_comm_cents || 0), 0));
  document.getElementById('adminSites').innerHTML = '<table><tr><th>分站</th><th>站主</th><th>常用邮箱</th><th>价格</th><th>累计售出</th><th>等级 / 分成</th><th>待结算</th></tr>' + (allSites || []).map(s => {
    const t = tierFor(s.sales); const o = (users || []).find(x => x.site_id === s.id);
    return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.owner_username) + '</td><td>' + esc(o ? o.email : s.commission_email) + '</td><td>' + money(s.price_h3_cents) + ' / ' + money(s.price_h12_cents) + ' / ' + money(s.price_h24_cents) + ' / ' + money(s.price_h72_cents) + ' / ' + money(s.price_h168_cents) + '</td><td>' + s.sales + '</td><td>' + t.label + ' · 自购 ' + (t.self * 100) + '% · 分成 ' + (t.comm * 100) + '%</td><td>' + money(o ? o.pending_comm_cents || 0 : 0) + '</td></tr>';
  }).join('') + '</table>';
  document.getElementById('adminOrders').innerHTML = orders && orders.length
    ? '<table><tr><th>订单</th><th>站点</th><th>买家</th><th>金额</th><th>邮箱</th><th>时间</th></tr>' + orders.map(o => '<tr><td>' + o.id + '</td><td>' + esc(o.site_name) + '</td><td>' + esc(o.buyer_username) + '</td><td>' + money(o.total_cents) + '</td><td>' + esc(o.temp_email) + '</td><td>' + new Date(o.created_at).toLocaleString() + '</td></tr>').join('') + '</table>'
    : '<p class="muted">暂无订单。</p>';
  document.getElementById('adminUsers').innerHTML = '<table><tr><th>用户</th><th>角色</th><th>邮箱</th><th>钱包</th><th>待结算分成</th></tr>' + (users || []).map(x => '<tr><td>' + esc(x.username) + '</td><td>' + (x.role === 'sub' ? '分站站主' : x.role === 'admin' ? '总站站主' : '用户') + '</td><td>' + esc(x.email) + '</td><td>' + money(x.wallet_cents) + '</td><td>' + money(x.pending_comm_cents || 0) + '</td></tr>').join('') + '</table>';
  const d = new Date();
  const next = d.getDate() < 16 ? d.getFullYear() + '-' + (d.getMonth() + 1) + '-16' : d.getFullYear() + '-' + (d.getMonth() + 2) + '-1';
  document.getElementById('settleInfo').textContent = '下次结算日：' + next + '（每月 1 日、16 日结算一次）。结算时把待结算分成转入各站主网站钱包。';
}
async function settleAll() {
  const { data, error } = await sb.rpc('settle_all_commissions');
  if (error) { alert('结算失败：' + error.message); return; }
  renderAdmin(); refreshMe();
  alert('已结算 ' + data.settled_owners + ' 位站主的待结算分成到各自网站钱包。');
}
async function changeAdminPass() {
  const p = document.getElementById('adNewPass').value;
  if (p.length < 4) { alert('密码至少 4 位'); return; }
  const { error } = await sb.auth.updateUser({ password: p });
  if (error) { alert('改密码失败：' + error.message); return; }
  alert('总站密码已修改（存在 Supabase Auth 里，不再写死在前端），请记住新密码。');
}

// ---------- 自动刷新：订单页每 60 秒刷新倒计时；收件箱每 20 秒拉一次新信 ----------
// mail.tm 没有 60 分钟过期，不再需要延时；extend_due_orders 已是空操作，不再调用。
setInterval(async () => {
  if (document.getElementById('view-orders').style.display !== 'none') renderOrders();
}, 60000);
setInterval(() => {
  if (document.getElementById('view-inbox').style.display !== 'none'
      && document.getElementById('inboxAddr').value.trim()) showInbox();
}, 20000);

// ---------- 启动 ----------
(async function init() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
    document.getElementById('who').textContent = '未配置 Supabase：请填好 config.js 后再部署。';
    alert('未配置 Supabase：请把 Project URL 和 anon key 填进 config.js 后再部署。');
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  await refreshMe();
  drawCaptcha('reg'); drawCaptcha('sub'); renderShop();
})();
