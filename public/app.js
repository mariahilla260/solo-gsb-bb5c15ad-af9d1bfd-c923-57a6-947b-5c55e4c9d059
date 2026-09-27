'use strict';

const els = {
  pagesInput: document.getElementById('pagesInput'),
  generateBtn: document.getElementById('generateBtn'),
  resetBtn: document.getElementById('resetBtn'),
  exportBtn: document.getElementById('exportBtn'),
  proofBtn: document.getElementById('proofBtn'),
  singleModeBtn: document.getElementById('singleModeBtn'),
  multiModeBtn: document.getElementById('multiModeBtn'),
  sigCapLabel: document.getElementById('sigCapLabel'),
  sigCapInput: document.getElementById('sigCapInput'),
  creepEnable: document.getElementById('creepEnable'),
  thicknessLabel: document.getElementById('thicknessLabel'),
  thicknessInput: document.getElementById('thicknessInput'),
  creepCapLabel: document.getElementById('creepCapLabel'),
  creepCapInput: document.getElementById('creepCapInput'),
  swapModeBtn: document.getElementById('swapModeBtn'),
  editModeBtn: document.getElementById('editModeBtn'),
  modeHint: document.getElementById('modeHint'),
  repairPlanBtn: document.getElementById('repairPlanBtn'),
  repairCard: document.getElementById('repairCard'),
  repairInfo: document.getElementById('repairInfo'),
  repairSteps: document.getElementById('repairSteps'),
  applyRepairBtn: document.getElementById('applyRepairBtn'),
  discardRepairBtn: document.getElementById('discardRepairBtn'),
  reprintInput: document.getElementById('reprintInput'),
  reprintPlanBtn: document.getElementById('reprintPlanBtn'),
  reprintProofBtn: document.getElementById('reprintProofBtn'),
  reprintInfo: document.getElementById('reprintInfo'),
  reprintList: document.getElementById('reprintList'),
  reprintRunInput: document.getElementById('reprintRunInput'),
  reprintRunBtn: document.getElementById('reprintRunBtn'),
  reprintRunCsvBtn: document.getElementById('reprintRunCsvBtn'),
  reprintRunInfo: document.getElementById('reprintRunInfo'),
  reprintRunList: document.getElementById('reprintRunList'),
  saveBaselineBtn: document.getElementById('saveBaselineBtn'),
  compareReuseBtn: document.getElementById('compareReuseBtn'),
  clearBaselineBtn: document.getElementById('clearBaselineBtn'),
  baselineInfo: document.getElementById('baselineInfo'),
  reuseResult: document.getElementById('reuseResult'),
  reuseList: document.getElementById('reuseList'),
  summary: document.getElementById('summary'),
  sheets: document.getElementById('sheets'),
  errors: document.getElementById('errors'),
  emptyTip: document.getElementById('emptyTip'),
  nestTip: document.getElementById('nestTip'),
};

const SIDE_LABEL = { front: '正面', back: '反面' };
const POS_LABEL = { left: '左版', right: '右版' };
const MAX_SHEETS_PER_SIGNATURE = 8;
const MODE_HINT = {
  swap: '交换模式：依次点击两个版位，即可交换它们的页码（再次点击已选中的版位可取消选择）。',
  edit: '编辑模式：点击任意版位，可直接输入页码或设为空白。',
};

let state = null; // 当前拼版状态（单帖 {sheets} / 分帖 {signatures}）
let original = null; // 初始标准拼版（用于重置）
let layout = 'single'; // 拼版模式：'single' | 'multi'
let mode = 'swap'; // 操作模式：'swap' | 'edit'
let selected = null; // 交换模式下已选中的版位 { sig, sheet, side, pos }
let validateTimer = null;
let repairPlan = null; // 当前修复方案 { steps, fingerprint, baseJson, stale }
let reprintData = null; // 最近一次成功的补印清单（用于控制补印打样下载按钮）
let reprintRunData = null; // 最近一次成功的生产单 { plan, baseStateJson, baseInput }（拼版或输入变化后失效）
let baseline = null; // 改版印版复用基线 { state, label, time }，仅存于当前浏览器会话
let reuseData = null; // 最近一次复用比较结果 { result, baseStateJson }（当前拼版变化后失效）
const BASELINE_STORAGE_KEY = 'plateReuseBaseline';

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 当前状态下的全部帖（统一为 { sig, sheets }，单帖 sig 为 null） */
function groups() {
  if (!state) return [];
  if (layout === 'multi') return state.signatures;
  return [{ sig: null, sheets: state.sheets }];
}

function findSheet(ref) {
  if (layout === 'multi') {
    return state.signatures.find((g) => g.sig === ref.sig)
      .sheets.find((s) => s.index === ref.sheet);
  }
  return state.sheets[ref.sheet - 1];
}

function getSlot(ref) {
  return findSheet(ref)[ref.side][ref.pos];
}

function setSlot(ref, value) {
  findSheet(ref)[ref.side][ref.pos] = value;
}

/* ---------- 模式切换 / 生成 / 重置 ---------- */

function setLayout(next) {
  if (layout === next) return;
  layout = next;
  els.singleModeBtn.classList.toggle('active', layout === 'single');
  els.multiModeBtn.classList.toggle('active', layout === 'multi');
  els.sigCapLabel.hidden = layout !== 'multi';
  els.sigCapInput.hidden = layout !== 'multi';

  // 已生成的拼版属于另一种模式，清空工作区以避免结构不一致
  if (state) {
    state = null;
    original = null;
    selected = null;
    discardRepairPlan();
    els.sheets.innerHTML = '';
    els.emptyTip.hidden = false;
    els.nestTip.hidden = true;
    els.summary.textContent = '';
    els.resetBtn.disabled = true;
    els.repairPlanBtn.disabled = true;
    els.exportBtn.disabled = true;
    els.proofBtn.disabled = true;
    els.errors.innerHTML = '<p class="muted">已切换拼版模式，请重新点击「生成拼版」。</p>';
    refreshReprint();
  }
}

async function generate() {
  const pages = Number(els.pagesInput.value);
  const body = { pages };
  if (layout === 'multi') {
    const m = Number(els.sigCapInput.value);
    if (!Number.isInteger(m) || m < 1 || m > MAX_SHEETS_PER_SIGNATURE) {
      alert(`每帖最多纸张数必须是 1~${MAX_SHEETS_PER_SIGNATURE} 的整数`);
      return;
    }
    body.sheetsPerSignature = m;
  }
  if (els.creepEnable.checked) {
    const thickness = Number(els.thicknessInput.value);
    const cap = Number(els.creepCapInput.value);
    if (!Number.isFinite(thickness) || thickness < 0.01 || thickness > 0.5) {
      alert('单张纸厚度必须是 0.01~0.50 mm 的数值（0.01 mm 精度）');
      return;
    }
    if (!Number.isFinite(cap) || cap < 0 || cap > 10) {
      alert('补偿上限必须是 0~10 mm 的数值（0 表示不补偿）');
      return;
    }
    body.creep = { thickness, cap };
  }
  try {
    const data = await api('/api/generate', body);
    state = data;
    original = structuredClone(data);
    selected = null;
    discardRepairPlan();
    render();
    scheduleValidate();
  } catch (e) {
    alert(e.message);
  }
}

function reset() {
  if (!original) return;
  state = structuredClone(original);
  selected = null;
  discardRepairPlan();
  render();
  scheduleValidate();
}

/* ---------- 渲染 ---------- */

function render() {
  if (!state) return;
  els.emptyTip.hidden = true;
  els.nestTip.hidden = false;

  if (layout === 'multi') {
    els.summary.textContent =
      `成品 ${state.pages} 页 → 补齐至 ${state.totalPages} 页` +
      `（空白 ${state.totalPages - state.pages} 页） · 共 ${state.signatureCount} 帖、${state.sheetCount} 张纸` +
      ` · 每帖最多 ${state.sheetsPerSignature} 张（${state.sheetsPerSignature * 4} 个成品页），仅末帖补空白`;
  } else {
    els.summary.textContent =
      `成品 ${state.pages} 页 → 补齐至 ${state.totalPages} 页` +
      `（空白 ${state.totalPages - state.pages} 页） · 共 ${state.sheetCount} 张纸 · 每张正反 2 面、每面左右 2 版`;
  }
  if (state.creep) {
    els.summary.textContent +=
      ` · 爬移补偿：纸厚 ${state.creep.thickness.toFixed(2)} mm、上限 ${state.creep.cap.toFixed(2)} mm`;
  }

  els.sheets.innerHTML = '';
  for (const g of groups()) {
    if (layout === 'multi') {
      els.sheets.appendChild(renderSignature(g));
    } else {
      g.sheets.forEach((sheet, idx) =>
        els.sheets.appendChild(renderSheetCard(g.sig, sheet, idx, g.sheets.length))
      );
    }
  }

  els.resetBtn.disabled = false;
  els.repairPlanBtn.disabled = false;
  updateModeUI();
  refreshReprintRun(); // 拼版内容可能已变化：旧生产单立即失效
  refreshReuse();
}

function renderSignature(g) {
  const wrap = document.createElement('section');
  wrap.className = 'signature';
  wrap.dataset.sig = g.sig;

  const lastSig = state.signatures[state.signatures.length - 1].sig;
  let tag = '';
  if (g.sig === lastSig) {
    if (state.totalPages > state.pages) {
      tag = '<span class="sig-tag last">末帖 · 补空白</span>';
    } else if (state.signatures.length > 1) {
      tag = '<span class="sig-tag">末帖</span>';
    }
  }
  const header = document.createElement('header');
  header.className = 'sig-header';
  header.innerHTML =
    `<strong>第 ${g.sig} 帖</strong>` +
    `<span class="sig-range">成品页 第 ${g.startPage}～${g.endPage} 页</span>` +
    `<span class="sig-range">${g.sheetCount} 张纸</span>` +
    tag;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'sig-body';
  g.sheets.forEach((sheet, idx) =>
    body.appendChild(renderSheetCard(g.sig, sheet, idx, g.sheets.length))
  );
  wrap.appendChild(body);
  return wrap;
}

function renderSheetCard(sig, sheet, idx, groupSheetTotal) {
  const card = document.createElement('section');
  card.className = 'sheet';
  card.style.setProperty('--indent', idx);
  card.dataset.sheet = sheet.index;
  if (sig != null) card.dataset.sig = sig;

  const nestLabel =
    idx === 0 ? '最外层' : idx === groupSheetTotal - 1 && idx > 0 ? '最内层' : '';
  const header = document.createElement('header');
  header.innerHTML = `<strong>第 ${sheet.index} 张纸</strong>` +
    (nestLabel ? `<span class="nest">${nestLabel}</span>` : '');
  // 爬移补偿：每张纸正反面共用同一补偿量，左版向右、右版向左（朝折线）
  if (state.creep && typeof sheet.creep === 'number') {
    const c = sheet.creep;
    const badge = document.createElement('span');
    badge.className = 'creep';
    badge.textContent = c === 0
      ? '爬移 0.00 mm（本张不补偿）'
      : `爬移 ${c.toFixed(2)} mm｜左版 +${c.toFixed(2)} 向右 · 右版 −${c.toFixed(2)} 向左（朝折线）`;
    header.appendChild(badge);
  }
  card.appendChild(header);

  for (const side of ['front', 'back']) {
    const row = document.createElement('div');
    row.className = 'side';
    const label = document.createElement('span');
    label.className = 'side-label';
    label.textContent = SIDE_LABEL[side];
    row.appendChild(label);
    for (const pos of ['left', 'right']) {
      row.appendChild(renderSlot(sig, sheet.index, side, pos, sheet[side][pos]));
    }
    card.appendChild(row);
  }
  return card;
}

function renderSlot(sig, sheetIndex, side, pos, value) {
  const slot = document.createElement('div');
  slot.className = 'slot' + (value === null ? ' blank' : '');
  slot.dataset.sheet = sheetIndex;
  if (sig != null) slot.dataset.sig = sig;
  slot.dataset.side = side;
  slot.dataset.pos = pos;
  slot.setAttribute('role', 'button');
  slot.tabIndex = 0;

  const posEl = document.createElement('span');
  posEl.className = 'pos';
  posEl.textContent = POS_LABEL[pos];
  const pageEl = document.createElement('span');
  pageEl.className = 'page';
  pageEl.textContent = value === null ? '空白' : `第 ${value} 页`;
  slot.append(posEl, pageEl);

  if (
    selected &&
    selected.sig === sig &&
    selected.sheet === sheetIndex &&
    selected.side === side &&
    selected.pos === pos
  ) {
    slot.classList.add('selected');
  }
  slot.addEventListener('click', () => onSlotClick({ sig, sheet: sheetIndex, side, pos }, slot));
  return slot;
}

/* ---------- 交互：交换 / 编辑 ---------- */

function sameRef(a, b) {
  return a.sig === b.sig && a.sheet === b.sheet && a.side === b.side && a.pos === b.pos;
}

function onSlotClick(ref, el) {
  if (el.classList.contains('editing')) return;

  if (mode === 'edit') {
    openEditor(ref, el);
    return;
  }

  // 交换模式
  if (!selected) {
    selected = ref;
    el.classList.add('selected');
    return;
  }
  if (sameRef(selected, ref)) {
    selected = null;
    el.classList.remove('selected');
    return;
  }
  const tmp = getSlot(selected);
  setSlot(selected, getSlot(ref));
  setSlot(ref, tmp);
  selected = null;
  render();
  scheduleValidate();
  markRepairStaleIfChanged();
}

function openEditor(ref, el) {
  const current = getSlot(ref);
  el.classList.add('editing');
  el.innerHTML = '';

  const wrap = document.createElement('div');
  wrap.className = 'slot-editor';
  wrap.addEventListener('click', (e) => e.stopPropagation());

  const input = document.createElement('input');
  input.type = 'number';
  input.min = 1;
  input.max = state.pages;
  input.placeholder = `1~${state.pages}`;
  if (current !== null) input.value = current;

  const btns = document.createElement('div');
  btns.className = 'btns';
  const okBtn = document.createElement('button');
  okBtn.textContent = '确定';
  const blankBtn = document.createElement('button');
  blankBtn.textContent = '空白';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  btns.append(okBtn, blankBtn, cancelBtn);
  wrap.append(input, btns);
  el.appendChild(wrap);
  input.focus();
  input.select();

  const commit = (value) => {
    setSlot(ref, value);
    render();
    scheduleValidate();
    markRepairStaleIfChanged();
  };
  okBtn.addEventListener('click', () => {
    const raw = input.value.trim();
    if (raw === '') {
      commit(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > state.pages) {
      alert(`页码须为 1~${state.pages} 的整数，或留空表示空白版位`);
      return;
    }
    commit(n);
  });
  blankBtn.addEventListener('click', () => commit(null));
  cancelBtn.addEventListener('click', () => render());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });
}

function updateModeUI() {
  els.swapModeBtn.classList.toggle('active', mode === 'swap');
  els.editModeBtn.classList.toggle('active', mode === 'edit');
  els.modeHint.textContent = MODE_HINT[mode];
}

/* ---------- 校验 ---------- */

function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validateNow, 200);
}

async function validateNow() {
  if (!state) return;
  try {
    const result = await api('/api/validate', state);
    renderErrors(result);
    markSlotErrors(result.slotErrors || []);
    els.exportBtn.disabled = !result.valid;
    els.proofBtn.disabled = !result.valid;
  } catch (e) {
    els.errors.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `校验请求失败：${e.message}`;
    els.errors.appendChild(p);
    els.exportBtn.disabled = true;
    els.proofBtn.disabled = true;
  }
  refreshReprint();
}

function renderErrors(result) {
  els.errors.innerHTML = '';
  if (result.valid) {
    const p = document.createElement('p');
    p.className = 'ok';
    p.textContent = layout === 'multi'
      ? '✓ 校验通过：各帖页码连续、无重复、无缺失，帖内正反配对正确，可以导出 CSV 或下载双面打样。'
      : '✓ 校验通过：页码无重复、无缺失，各纸张正反配对正确，可以导出 CSV 或下载双面打样。';
    els.errors.appendChild(p);
    return;
  }
  const e = result.errors;
  if (e.duplicates.length) {
    addErrGroup(`重复页：${e.duplicates.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.missing.length) {
    addErrGroup(`缺页：${e.missing.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.outOfRange.length) {
    addErrGroup(`页码超出范围：${e.outOfRange.map((p) => `第 ${p} 页`).join('、')}`);
  }
  if (e.crossSignature) {
    for (const c of e.crossSignature) {
      addErrGroup(`第 ${c.sig} 帖跨帖异常：${c.message}`);
    }
  }
  for (const p of e.pairing) {
    const div = document.createElement('div');
    div.className = 'err-group';
    const title = document.createElement('strong');
    title.textContent = p.sig != null
      ? `第 ${p.sig} 帖 · 第 ${p.sheet} 张纸配对异常：`
      : `第 ${p.sheet} 张纸配对异常：`;
    const ul = document.createElement('ul');
    for (const m of p.messages) {
      const li = document.createElement('li');
      li.textContent = m;
      ul.appendChild(li);
    }
    div.append(title, ul);
    els.errors.appendChild(div);
  }
}

function addErrGroup(text) {
  const div = document.createElement('div');
  div.className = 'err-group';
  const strong = document.createElement('strong');
  strong.textContent = text;
  div.appendChild(strong);
  els.errors.appendChild(div);
}

function markSlotErrors(slotErrors) {
  els.sheets.querySelectorAll('.slot.error').forEach((el) => {
    el.classList.remove('error');
    el.removeAttribute('title');
  });
  els.sheets.querySelectorAll('.sheet.has-error').forEach((el) => el.classList.remove('has-error'));
  els.sheets.querySelectorAll('.signature.has-error').forEach((el) => el.classList.remove('has-error'));

  const byKey = new Map();
  for (const se of slotErrors) {
    const key = `${se.sig ?? ''}|${se.sheet}|${se.side}|${se.pos}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(se.message);
  }
  for (const [key, messages] of byKey) {
    const [sig, sheet, side, pos] = key.split('|');
    const selector = sig
      ? `.slot[data-sig="${sig}"][data-sheet="${sheet}"][data-side="${side}"][data-pos="${pos}"]`
      : `.slot:not([data-sig])[data-sheet="${sheet}"][data-side="${side}"][data-pos="${pos}"]`;
    const el = els.sheets.querySelector(selector);
    if (!el) continue;
    el.classList.add('error');
    el.title = [...new Set(messages)].join('\n');
    const card = el.closest('.sheet');
    if (card) card.classList.add('has-error');
    const sigCard = el.closest('.signature');
    if (sigCard) sigCard.classList.add('has-error');
  }
}

/* ---------- 修复方案 ---------- */

/** 版位标签：单帖「第 N 张纸 · 正面左版」，分帖「第 S 帖 · 第 N 张纸 · 正面左版」 */
function slotLabel(ref) {
  const where = ref.sig == null ? `第 ${ref.sheet} 张纸` : `第 ${ref.sig} 帖 · 第 ${ref.sheet} 张纸`;
  return `${where} · ${SIDE_LABEL[ref.side]}${POS_LABEL[ref.pos]}`;
}

function valueLabel(v) {
  return v === null ? '空白' : `第 ${v} 页`;
}

/** 生成修复方案：以服务端标准拼版为目标，返回按顺序执行的交换 / 改值步骤 */
async function generateRepairPlan() {
  if (!state) return;
  try {
    const data = await api('/api/repair/plan', state);
    repairPlan = {
      steps: data.steps,
      fingerprint: data.fingerprint,
      baseJson: JSON.stringify(state), // 生成方案时的状态快照，用于检测后续改动
      stale: false,
    };
    renderRepairPlan();
  } catch (e) {
    alert(e.message);
  }
}

function renderRepairPlan() {
  if (!repairPlan) {
    els.repairCard.hidden = true;
    return;
  }
  els.repairCard.hidden = false;
  els.repairInfo.innerHTML = '';
  els.repairSteps.innerHTML = '';

  if (repairPlan.stale) {
    const warn = document.createElement('p');
    warn.className = 'repair-stale';
    warn.textContent = '拼版已在生成方案后被改动，本方案已失效，请重新生成修复方案。';
    els.repairInfo.appendChild(warn);
  } else if (repairPlan.steps.length === 0) {
    const ok = document.createElement('p');
    ok.className = 'repair-ok';
    ok.textContent = '当前拼版已通过校验，无需修复。';
    els.repairInfo.appendChild(ok);
  } else {
    const swaps = repairPlan.steps.filter((s) => s.type === 'swap').length;
    const sets = repairPlan.steps.length - swaps;
    const p = document.createElement('p');
    p.className = 'repair-summary';
    p.textContent =
      `以服务端标准拼版为目标，共 ${repairPlan.steps.length} 步` +
      `（交换 ${swaps} 步、改值 ${sets} 步），按顺序执行；修复保留分帖结构与爬移参数。`;
    els.repairInfo.appendChild(p);
  }

  repairPlan.steps.forEach((step) => {
    const li = document.createElement('li');
    li.className = `repair-step ${step.type}`;
    const badge = document.createElement('span');
    badge.className = 'step-badge';
    badge.textContent = step.type === 'swap' ? '交换' : '改值';
    const changes = document.createElement('div');
    changes.className = 'step-changes';
    for (const ch of step.changes) {
      const line = document.createElement('div');
      line.className = 'step-change';
      line.textContent = `${slotLabel(ch.slot)}：${valueLabel(ch.from)} → ${valueLabel(ch.to)}`;
      changes.appendChild(line);
    }
    li.append(badge, changes);
    els.repairSteps.appendChild(li);
  });

  els.applyRepairBtn.disabled = repairPlan.steps.length === 0;
}

/** 拼版被交换 / 编辑改动后，若已有修复方案则标记失效（拒绝应用旧方案） */
function markRepairStaleIfChanged() {
  if (!repairPlan || !state) return;
  if (JSON.stringify(state) !== repairPlan.baseJson) {
    repairPlan.stale = true;
    renderRepairPlan();
  }
}

function discardRepairPlan() {
  repairPlan = null;
  renderRepairPlan();
}

/** 一键应用修复方案；生成方案后拼版又被改动时拒绝应用并提示重新生成 */
async function applyRepairPlan() {
  if (!repairPlan || !state) return;
  if (repairPlan.stale || JSON.stringify(state) !== repairPlan.baseJson) {
    repairPlan.stale = true;
    renderRepairPlan();
    alert('拼版已在生成修复方案后被改动，请重新生成修复方案。');
    return;
  }
  try {
    const data = await api('/api/repair/apply', { state, fingerprint: repairPlan.fingerprint });
    state = data.state;
    selected = null;
    discardRepairPlan();
    render();
    validateNow();
  } catch (e) {
    if (e.status === 409 && repairPlan) {
      repairPlan.stale = true;
      renderRepairPlan();
    }
    alert(e.message);
  }
}

/* ---------- 补印 ---------- */

/** 生成补印清单：服务端校验页码输入与当前拼版，按帖号与帖内纸张序返回命中纸张 */
async function generateReprintPlan() {
  if (!state) {
    reprintData = null;
    els.reprintProofBtn.disabled = true;
    renderReprintMessage('muted', '请先生成拼版。');
    return;
  }
  try {
    const data = await api('/api/reprint/plan', { state, pages: els.reprintInput.value });
    reprintData = data;
    renderReprintPlan(data);
  } catch (e) {
    reprintData = null;
    renderReprintMessage('reprint-err', e.message);
  }
  els.reprintProofBtn.disabled = !reprintData || reprintData.sheetCount === 0;
}

function renderReprintMessage(cls, text) {
  els.reprintInfo.innerHTML = '';
  els.reprintList.innerHTML = '';
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  els.reprintInfo.appendChild(p);
}

/** 渲染补印清单：每张命中纸列出命中页与正反四个版位（同张纸命中多页只列一次） */
function renderReprintPlan(data) {
  els.reprintInfo.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'reprint-ok';
  p.textContent = `需补印 ${data.pages.length} 页（第 ${data.pages.join('、')} 页），涉及 ${data.sheetCount} 张纸：`;
  els.reprintInfo.appendChild(p);

  els.reprintList.innerHTML = '';
  for (const s of data.sheets) {
    const li = document.createElement('li');
    li.className = 'reprint-sheet';

    const head = document.createElement('div');
    head.className = 'reprint-sheet-head';
    const where = document.createElement('strong');
    where.textContent = s.sig == null ? `第 ${s.sheet} 张纸` : `第 ${s.sig} 帖 · 第 ${s.sheet} 张纸`;
    const hit = document.createElement('span');
    hit.className = 'reprint-hit';
    hit.textContent = `命中：第 ${s.hitPages.join('、')} 页`;
    head.append(where, hit);

    const slots = document.createElement('div');
    slots.className = 'reprint-slots';
    for (const side of ['front', 'back']) {
      const row = document.createElement('span');
      row.textContent =
        `${SIDE_LABEL[side]}：左版 ${valueLabel(s[side].left)} · 右版 ${valueLabel(s[side].right)}`;
      slots.appendChild(row);
    }
    li.append(head, slots);
    els.reprintList.appendChild(li);
  }
}

/** 拼版变化后同步补印区：页码输入非空时自动重算清单，否则清空并禁用下载 */
function refreshReprint() {
  if (!state || els.reprintInput.value.trim() === '') {
    reprintData = null;
    els.reprintProofBtn.disabled = true;
    els.reprintList.innerHTML = '';
    els.reprintInfo.innerHTML = state ? '' : '<p class="muted">请先生成拼版。</p>';
  } else {
    generateReprintPlan();
  }
  refreshReprintRun();
  refreshReuse();
}

/* ---------- 补印生产单（按页份数核算） ---------- */

/** 生成生产单：服务端校验「页码:份数」输入与当前拼版，按帖号与帖内纸张序返回核算结果 */
async function generateReprintRun() {
  if (!state) {
    reprintRunData = null;
    els.reprintRunCsvBtn.disabled = true;
    renderReprintRunMessage('muted', '请先生成拼版。');
    return;
  }
  try {
    const data = await api('/api/reprint/run', { state, items: els.reprintRunInput.value });
    reprintRunData = {
      plan: data,
      baseStateJson: JSON.stringify(state), // 生成生产单时的拼版快照，用于检测后续改动
      baseInput: els.reprintRunInput.value,
    };
    renderReprintRun(data);
    els.reprintRunCsvBtn.disabled = false;
  } catch (e) {
    reprintRunData = null;
    els.reprintRunCsvBtn.disabled = true;
    renderReprintRunMessage('reprint-err', e.message);
  }
}

function renderReprintRunMessage(cls, text) {
  els.reprintRunInfo.innerHTML = '';
  els.reprintRunList.innerHTML = '';
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  els.reprintRunInfo.appendChild(p);
}

/** 渲染生产单：汇总总用量 + 每张纸的实际补印份数与每页需求 / 随印超出份数 */
function renderReprintRun(plan) {
  els.reprintRunInfo.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'reprint-ok';
  p.textContent =
    `生产单：返工 ${plan.items.length} 页，涉及 ${plan.sheetCount} 种实体纸张，` +
    `实体纸张总用量 ${plan.totalCopies} 份（按帖号、帖内纸张序排列）：`;
  els.reprintRunInfo.appendChild(p);

  els.reprintRunList.innerHTML = '';
  for (const s of plan.sheets) {
    const li = document.createElement('li');
    li.className = 'reprint-sheet';

    const head = document.createElement('div');
    head.className = 'reprint-sheet-head';
    const where = document.createElement('strong');
    where.textContent = s.sig == null ? `第 ${s.sheet} 张纸` : `第 ${s.sig} 帖 · 第 ${s.sheet} 张纸`;
    const copies = document.createElement('span');
    copies.className = 'reprint-hit';
    copies.textContent = `实际补印 ${s.copies} 份`;
    head.append(where, copies);

    const hits = document.createElement('div');
    hits.className = 'reprint-slots';
    const line = document.createElement('span');
    line.textContent = s.hits
      .map((h) => `第 ${h.page} 页需 ${h.requested} 份（随印超出 ${h.overrun} 份）`)
      .join('；');
    hits.appendChild(line);

    li.append(head, hits);
    els.reprintRunList.appendChild(li);
  }
}

/** 拼版或输入变化后旧生产单失效：清空结果并禁用 CSV 下载，需重新生成 */
function refreshReprintRun() {
  if (!state) {
    reprintRunData = null;
    els.reprintRunCsvBtn.disabled = true;
    els.reprintRunList.innerHTML = '';
    els.reprintRunInfo.innerHTML = '<p class="muted">请先生成拼版。</p>';
    return;
  }
  if (!reprintRunData) return;
  if (
    JSON.stringify(state) !== reprintRunData.baseStateJson ||
    els.reprintRunInput.value !== reprintRunData.baseInput
  ) {
    reprintRunData = null;
    els.reprintRunCsvBtn.disabled = true;
    renderReprintRunMessage('muted', '拼版或输入已变化，旧生产单已失效，请重新「生成生产单」。');
  }
}

/** 下载生产单 CSV（与屏幕生产单一致）；拼版或输入已变化时拒绝下载并提示重新生成 */
async function downloadReprintRunCsv() {
  if (!state || !reprintRunData) return;
  if (
    JSON.stringify(state) !== reprintRunData.baseStateJson ||
    els.reprintRunInput.value !== reprintRunData.baseInput
  ) {
    refreshReprintRun();
    alert('拼版或输入已变化，旧生产单已失效，请重新生成生产单。');
    return;
  }
  const res = await fetch('/api/reprint/run/csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, items: els.reprintRunInput.value }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '生产单 CSV 下载失败');
    refreshReprintRun(); // 拼版可能已变化：刷新生产单与下载按钮状态
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = layout === 'multi'
    ? `reprint-run-${state.totalPages}p-${state.signatureCount}sig.csv`
    : `reprint-run-${state.totalPages}p.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 下载补印打样：仅含清单纸张的双面打样（服务端按当前拼版与页码重新校验，有错即拒绝） */
async function downloadReprintProof() {
  if (!state || !reprintData) return;
  const res = await fetch('/api/reprint/proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, pages: els.reprintInput.value }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || '补印打样下载失败');
    generateReprintPlan(); // 拼版可能已变化：刷新清单与下载按钮状态
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = layout === 'multi'
    ? `reprint-proof-${state.totalPages}p-${state.signatureCount}sig.html`
    : `reprint-proof-${state.totalPages}p.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- 改版印版复用 ---------- */

/** 拼版摘要文本（基线信息展示用） */
function describeState(s) {
  const parts = [`成品 ${s.pages} 页`];
  if (s.signatures) parts.push(`${s.signatureCount} 帖`);
  parts.push(`${s.sheetCount} 张纸`);
  if (s.creep) {
    parts.push(`爬移纸厚 ${s.creep.thickness.toFixed(2)} mm、上限 ${s.creep.cap.toFixed(2)} mm`);
  }
  return parts.join(' · ');
}

/** 启动时从当前浏览器会话恢复基线（关闭标签页即清除） */
function loadBaseline() {
  try {
    const raw = sessionStorage.getItem(BASELINE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.state && parsed.label) baseline = parsed;
  } catch {
    baseline = null;
  }
}

/** 保存为比较基线：先经服务端校验通过才保存（仅保存在当前浏览器会话） */
async function saveBaseline() {
  if (!state) return;
  try {
    const result = await api('/api/validate', state);
    if (!result.valid) {
      alert('当前拼版未通过校验，不能保存为比较基线，请先修复或重置。');
      return;
    }
  } catch (e) {
    alert(`校验请求失败，无法保存基线：${e.message}`);
    return;
  }
  baseline = {
    state: structuredClone(state),
    label: describeState(state),
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  };
  try {
    sessionStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baseline));
  } catch {
    // 会话存储不可用时仍保留在内存中（当前标签页会话内有效）
  }
  reuseData = null;
  els.reuseResult.innerHTML = '';
  els.reuseList.innerHTML = '';
  renderBaselineInfo();
  refreshReuse();
}

function clearBaseline() {
  baseline = null;
  reuseData = null;
  try {
    sessionStorage.removeItem(BASELINE_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
  els.reuseResult.innerHTML = '';
  els.reuseList.innerHTML = '';
  renderBaselineInfo();
  refreshReuse();
}

function renderBaselineInfo() {
  els.baselineInfo.innerHTML = '';
  if (!baseline) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '尚未保存基线：生成拼版且校验通过后点击「保存为比较基线」。';
    els.baselineInfo.appendChild(p);
    return;
  }
  const p = document.createElement('p');
  p.className = 'reuse-baseline';
  p.textContent = `基线：${baseline.label} · 保存于 ${baseline.time}（仅当前浏览器会话有效）`;
  els.baselineInfo.appendChild(p);
}

/** 与基线比较：服务端对两个方案逐一校验，任一未通过即拒绝核算 */
async function compareReuse() {
  if (!state || !baseline) return;
  try {
    const data = await api('/api/reuse/compare', { baseline: baseline.state, current: state });
    reuseData = { result: data, baseStateJson: JSON.stringify(state) };
    renderReuseResult(data);
  } catch (e) {
    reuseData = null;
    els.reuseList.innerHTML = '';
    els.reuseResult.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'reprint-err';
    p.textContent = e.message;
    els.reuseResult.appendChild(p);
  }
}

/** 渲染比较结果：按当前帖与纸张顺序列出每张纸正/反面的复用 / 新制及复用来源，并汇总数量 */
function renderReuseResult(data) {
  els.reuseResult.innerHTML = '';
  const s = data.summary;
  const p = document.createElement('p');
  p.className = 'reprint-ok';
  p.textContent =
    `复用 ${s.reused} 面 · 新制 ${s.new} 面 · 旧面作废 ${s.discarded} 面` +
    `（当前方案共 ${s.reused + s.new} 面，按当前帖与纸张顺序）：`;
  els.reuseResult.appendChild(p);

  els.reuseList.innerHTML = '';
  let li = null;
  let slotsBox = null;
  let lastKey = null;
  for (const f of data.faces) {
    const key = `${f.sig ?? ''}|${f.sheet}`;
    if (key !== lastKey) {
      lastKey = key;
      li = document.createElement('li');
      li.className = 'reprint-sheet';
      const head = document.createElement('div');
      head.className = 'reprint-sheet-head';
      const where = document.createElement('strong');
      where.textContent = f.sig == null
        ? `第 ${f.sheet} 张纸`
        : `第 ${f.sig} 帖 · 第 ${f.sheet} 张纸`;
      head.appendChild(where);
      slotsBox = document.createElement('div');
      slotsBox.className = 'reprint-slots';
      li.append(head, slotsBox);
      els.reuseList.appendChild(li);
    }

    const line = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = `reuse-badge ${f.status}`;
    badge.textContent = f.status === 'reuse' ? '复用' : '新制';
    const detail = document.createElement('span');
    const creepNote = typeof f.creep === 'number' && f.creep > 0 ? ` · 爬移 ${f.creep.toFixed(2)} mm` : '';
    detail.textContent =
      `${SIDE_LABEL[f.side]}：左版 ${valueLabel(f.left)} · 右版 ${valueLabel(f.right)}${creepNote}`;
    line.append(badge, detail);
    if (f.status === 'reuse') {
      const source = document.createElement('span');
      source.className = 'reuse-source';
      source.textContent =
        ` ← 沿用基线${f.source.sig == null ? '' : `第 ${f.source.sig} 帖 · `}第 ${f.source.sheet} 张纸 ${SIDE_LABEL[f.side]}`;
      line.appendChild(source);
    }
    slotsBox.appendChild(line);
  }
}

/** 拼版变化后同步复用区：更新按钮状态；比较结果基于的当前拼版已变化时立即失效 */
function refreshReuse() {
  els.saveBaselineBtn.disabled = !state;
  els.compareReuseBtn.disabled = !state || !baseline;
  els.clearBaselineBtn.disabled = !baseline;
  if (reuseData && (!state || JSON.stringify(state) !== reuseData.baseStateJson)) {
    reuseData = null;
    els.reuseList.innerHTML = '';
    els.reuseResult.innerHTML = state
      ? '<p class="muted">当前拼版已变化，旧比较结果已失效，请重新点击「与基线比较」。</p>'
      : '';
  }
}

/* ---------- 导出 ---------- */

/** 下载结果文件（CSV / 打样 HTML）的通用逻辑 */
async function downloadResult(path, filename, errorLabel) {
  if (!state) return;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || errorLabel);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv() {
  const filename = layout === 'multi'
    ? `imposition-${state.totalPages}p-${state.signatureCount}sig.csv`
    : `imposition-${state.totalPages}p.csv`;
  return downloadResult('/api/export', filename, '导出失败');
}

function downloadProof() {
  const filename = layout === 'multi'
    ? `imposition-proof-${state.totalPages}p-${state.signatureCount}sig.html`
    : `imposition-proof-${state.totalPages}p.html`;
  return downloadResult('/api/export/proof', filename, '打样下载失败');
}

/* ---------- 事件绑定 ---------- */

els.generateBtn.addEventListener('click', generate);
els.resetBtn.addEventListener('click', reset);
els.repairPlanBtn.addEventListener('click', generateRepairPlan);
els.applyRepairBtn.addEventListener('click', applyRepairPlan);
els.discardRepairBtn.addEventListener('click', discardRepairPlan);
els.exportBtn.addEventListener('click', exportCsv);
els.proofBtn.addEventListener('click', downloadProof);
els.reprintPlanBtn.addEventListener('click', generateReprintPlan);
els.reprintProofBtn.addEventListener('click', downloadReprintProof);
els.reprintInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generateReprintPlan();
});
els.reprintInput.addEventListener('input', () => {
  // 页码输入已修改：旧清单失效，需重新生成后才能下载
  reprintData = null;
  els.reprintProofBtn.disabled = true;
  els.reprintList.innerHTML = '';
  els.reprintInfo.innerHTML = els.reprintInput.value.trim()
    ? '<p class="muted">页码已修改，请点击「生成补印清单」。</p>'
    : '';
});
els.reprintRunBtn.addEventListener('click', generateReprintRun);
els.reprintRunCsvBtn.addEventListener('click', downloadReprintRunCsv);
els.saveBaselineBtn.addEventListener('click', saveBaseline);
els.compareReuseBtn.addEventListener('click', compareReuse);
els.clearBaselineBtn.addEventListener('click', clearBaseline);
els.reprintRunInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generateReprintRun();
});
els.reprintRunInput.addEventListener('input', () => {
  // 份数输入已修改：旧生产单失效，需重新生成后才能下载 CSV
  reprintRunData = null;
  els.reprintRunCsvBtn.disabled = true;
  els.reprintRunList.innerHTML = '';
  els.reprintRunInfo.innerHTML = els.reprintRunInput.value.trim()
    ? '<p class="muted">输入已修改，请点击「生成生产单」。</p>'
    : '';
});
els.pagesInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate();
});
els.sigCapInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') generate();
});
els.singleModeBtn.addEventListener('click', () => setLayout('single'));
els.multiModeBtn.addEventListener('click', () => setLayout('multi'));
els.creepEnable.addEventListener('change', () => {
  const on = els.creepEnable.checked;
  els.thicknessLabel.hidden = !on;
  els.thicknessInput.hidden = !on;
  els.creepCapLabel.hidden = !on;
  els.creepCapInput.hidden = !on;
});
els.swapModeBtn.addEventListener('click', () => {
  mode = 'swap';
  selected = null;
  render();
});
els.editModeBtn.addEventListener('click', () => {
  mode = 'edit';
  selected = null;
  render();
});

setLayout('single');
updateModeUI();
loadBaseline();
renderBaselineInfo();
refreshReuse();
