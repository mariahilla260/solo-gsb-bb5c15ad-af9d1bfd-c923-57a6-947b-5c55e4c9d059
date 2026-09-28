'use strict';

/**
 * 原纸开料选配（拼版校验通过后的用料选配）。
 *
 * 输入：需求量（1～10000 张；缺省时默认 = 当前拼版实体纸张数 × 印量）、展开纸张宽高
 * （整数毫米）与折线方向（纵向沿纸张高度 / 横向沿纸张宽度）、统一修边量与刀缝
 * （非负整数毫米）、1～6 种原纸（编号唯一；宽高为正整数毫米；纸纹平行长边 / 短边；
 * 库存 0～1000 张；单价为正整数分/张）。
 *
 * 服务端对每种原纸枚举两种正交摆放（正向、旋转 90°），仅允许折线平行纸纹的摆放；
 * 排料时原纸四边各扣除统一修边量，相邻展开纸之间计入刀缝，按整行整列计算
 *   每行张数 = floor((原纸宽 − 2×修边 + 刀缝) / (展开宽 + 刀缝))
 *   每列张数 = floor((原纸高 − 2×修边 + 刀缝) / (展开高 + 刀缝))
 * 每张出数 = 每行张数 × 每列张数（不足 1 行 / 列时为 0，即尺寸不适配）。
 *
 * 选配：在不超各规格库存的前提下，精确选取总出数覆盖需求的组合；
 * 选择次序为（1）总价最低（单价按分计，避免浮点误差）；（2）总价相同超印张数最少；
 * （3）仍并列时，按编号升序排列的领用量序列取字典序最小者。
 * 任一参与规格都无法出纸（纸纹不符或尺寸不足）或全部库存出数之和不足以覆盖需求时无解。
 */

const MIN_DEMAND = 1;
const MAX_DEMAND = 10000;
const MIN_PRINT_RUN = 1;
const MAX_PRINT_RUN = 10000;
const MIN_DIMENSION = 1; // 展开纸张 / 原纸宽高下限（mm）
const MAX_DIMENSION = 10000; // 展开纸张 / 原纸宽高上限（mm）
const MIN_ALLOWANCE = 0; // 修边量 / 刀缝下限（mm）
const MAX_ALLOWANCE = 10000; // 修边量 / 刀缝上限（mm）
const MIN_STOCK_KINDS = 1;
const MAX_STOCK_KINDS = 6;
const MAX_INVENTORY = 1000; // 单规格库存上限（张）
const MIN_PRICE = 1; // 单价下限（分/张）
const MAX_PRICE = 1_000_000_000; // 单价上限（分/张，即 1000 万元/张）
const MAX_CODE_LENGTH = 20;

const FOLD_DIRECTIONS = ['vertical', 'horizontal'];
const GRAIN_DIRECTIONS = ['long', 'short'];
const FOLD_LABEL = {
  vertical: '纵向（折线沿展开纸张高度）',
  horizontal: '横向（折线沿展开纸张宽度）',
};
const GRAIN_LABEL = {
  long: '平行长边（长纹）',
  short: '平行短边（短纹）',
};
const PLACEMENT_LABEL = {
  straight: '正向摆放（展开宽沿原纸宽、展开高沿原纸高）',
  swapped: '旋转 90° 摆放（展开宽沿原纸高、展开高沿原纸宽）',
};

/** 取闭区间内的非负/正整数；布尔、NaN、小数、越界均视为非法 */
function asInt(value, min, max) {
  if (typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * 规范化开料选配请求参数。
 * 返回 { params }；参数非法时返回 { error }（说明具体原因）。
 * state 校验由调用方完成；sheetCount 用于缺省需求量计算。
 */
function normalizeCuttingParams(raw, sheetCount) {
  if (!raw || typeof raw !== 'object') return { error: '请求参数格式不正确' };

  // 需求量：显式传入时以传入值为准；缺省时由「实体纸张数 × 印量」推导
  let demand = null;
  if (raw.demand !== undefined && raw.demand !== null && raw.demand !== '') {
    demand = asInt(raw.demand, MIN_DEMAND, MAX_DEMAND);
    if (demand === null) {
      return { error: `需求量必须是 ${MIN_DEMAND}~${MAX_DEMAND} 张的整数` };
    }
  }
  let printRun = null;
  if (raw.printRun !== undefined && raw.printRun !== null && raw.printRun !== '') {
    printRun = asInt(raw.printRun, MIN_PRINT_RUN, MAX_PRINT_RUN);
    if (printRun === null) {
      return { error: `印量必须是 ${MIN_PRINT_RUN}~${MAX_PRINT_RUN} 的整数` };
    }
  }
  if (demand === null) {
    if (printRun === null) {
      return { error: '请填写需求量（或提供印量以按「实体纸张数 × 印量」自动计算）' };
    }
    const derived = sheetCount * printRun;
    if (derived < MIN_DEMAND || derived > MAX_DEMAND) {
      return {
        error: `默认需求量（实体纸张数 ${sheetCount} × 印量 ${printRun} = ${derived} 张）超出 ${MIN_DEMAND}~${MAX_DEMAND} 张范围，请直接填写需求量`,
      };
    }
    demand = derived;
  }

  const sheetWidth = asInt(raw.sheetWidth, MIN_DIMENSION, MAX_DIMENSION);
  if (sheetWidth === null) {
    return { error: `展开纸张宽度必须是 ${MIN_DIMENSION}~${MAX_DIMENSION} mm 的整数` };
  }
  const sheetHeight = asInt(raw.sheetHeight, MIN_DIMENSION, MAX_DIMENSION);
  if (sheetHeight === null) {
    return { error: `展开纸张高度必须是 ${MIN_DIMENSION}~${MAX_DIMENSION} mm 的整数` };
  }
  if (!FOLD_DIRECTIONS.includes(raw.foldDirection)) {
    return { error: '折线方向必须是「纵向」或「横向」' };
  }
  const trim = asInt(raw.trim, MIN_ALLOWANCE, MAX_ALLOWANCE);
  if (trim === null) {
    return { error: `统一修边量必须是 ${MIN_ALLOWANCE}~${MAX_ALLOWANCE} mm 的非负整数` };
  }
  const kerf = asInt(raw.kerf, MIN_ALLOWANCE, MAX_ALLOWANCE);
  if (kerf === null) {
    return { error: `刀缝必须是 ${MIN_ALLOWANCE}~${MAX_ALLOWANCE} mm 的非负整数` };
  }

  if (!Array.isArray(raw.stocks) || raw.stocks.length < MIN_STOCK_KINDS || raw.stocks.length > MAX_STOCK_KINDS) {
    return { error: `原纸规格必须为 ${MIN_STOCK_KINDS}~${MAX_STOCK_KINDS} 种` };
  }
  const stocks = [];
  const codes = new Set();
  for (let i = 0; i < raw.stocks.length; i++) {
    const item = raw.stocks[i];
    const at = `第 ${i + 1} 种原纸`;
    if (!item || typeof item !== 'object') return { error: `${at}：数据格式不正确` };
    const code = String(item.code ?? '').trim();
    if (!code) return { error: `${at}：编号不能为空` };
    if (code.length > MAX_CODE_LENGTH) return { error: `${at}：编号长度不能超过 ${MAX_CODE_LENGTH} 个字符` };
    if (/[,\r\n，;；]/.test(code)) return { error: `${at}：编号不能包含逗号、分号或换行` };
    if (codes.has(code)) return { error: `原纸编号「${code}」重复，编号必须唯一` };
    codes.add(code);
    const width = asInt(item.width, MIN_DIMENSION, MAX_DIMENSION);
    if (width === null) return { error: `${at}（${code}）：宽度必须是 ${MIN_DIMENSION}~${MAX_DIMENSION} mm 的正整数` };
    const height = asInt(item.height, MIN_DIMENSION, MAX_DIMENSION);
    if (height === null) return { error: `${at}（${code}）：高度必须是 ${MIN_DIMENSION}~${MAX_DIMENSION} mm 的正整数` };
    if (!GRAIN_DIRECTIONS.includes(item.grain)) {
      return { error: `${at}（${code}）：纸纹方向必须是平行长边或平行短边` };
    }
    const stock = asInt(item.stock, 0, MAX_INVENTORY);
    if (stock === null) return { error: `${at}（${code}）：库存张数必须是 0~${MAX_INVENTORY} 的整数` };
    const price = asInt(item.price, MIN_PRICE, MAX_PRICE);
    if (price === null) return { error: `${at}（${code}）：单价必须是 ${MIN_PRICE}~${MAX_PRICE} 分/张的正整数` };
    stocks.push({ code, width, height, grain: item.grain, stock, price });
  }
  // 编号升序（按 UTF-16 码元），保证选配与输出顺序确定
  stocks.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    params: {
      demand,
      printRun,
      sheetWidth,
      sheetHeight,
      foldDirection: raw.foldDirection,
      trim,
      kerf,
      stocks,
    },
  };
}

/**
 * 单轴整行 / 整列可排数量：四边扣除修边后，相邻件之间计入一道刀缝。
 * usable = 原纸该边尺寸 − 2×修边；count = floor((usable + 刀缝) / (件尺寸 + 刀缝))。
 */
function fitCount(stockDim, pieceDim, trim, kerf) {
  const usable = stockDim - 2 * trim;
  if (usable <= 0) return 0;
  return Math.max(0, Math.floor((usable + kerf) / (pieceDim + kerf)));
}

/**
 * 枚举一种原纸的两种正交摆放并判定其出数。
 * 返回 { placements: [straight, swapped], feasiblePlacement, perSheet }：
 *  - placements 每项 { name, sheetAlong, foldParallelGrain, usableWidth, usableHeight, cols, rows, perSheet }；
 *  - 仅折线平行纸纹的摆放允许选用；两种都合法时取每张出数较大者（相同取正向）；
 *  - 均不合法或出数为 0 时 feasiblePlacement 为 null、perSheet 为 0（尺寸不适配）。
 */
function evaluateStock(spec, params) {
  const { sheetWidth: pw, sheetHeight: ph, foldDirection, trim, kerf } = params;
  const placements = ['straight', 'swapped'].map((name) => {
    // pieceAlongW / pieceAlongH：展开纸张宽高投影到原纸宽 / 高方向的尺寸
    const pieceAlongW = name === 'straight' ? pw : ph;
    const pieceAlongH = name === 'straight' ? ph : pw;
    const usableWidth = spec.width - 2 * trim;
    const usableHeight = spec.height - 2 * trim;
    const cols = fitCount(spec.width, pieceAlongW, trim, kerf);
    const rows = fitCount(spec.height, pieceAlongH, trim, kerf);

    // 折线方向轴：纵向折线沿展开纸高度、横向沿展开纸宽度；纸纹轴：长纹沿长边、短纹沿短边
    const foldAxis = foldDirection === 'vertical'
      ? (name === 'straight' ? 'H' : 'W') // 展开高投影到原纸的方向
      : (name === 'straight' ? 'W' : 'H');
    const longAxis = spec.width >= spec.height ? 'W' : 'H';
    const shortAxis = spec.width <= spec.height ? 'W' : 'H'; // 正方形时长短边重合，两轴均视为纸纹方向
    const grainAxes = spec.grain === 'long'
      ? new Set([longAxis])
      : new Set([shortAxis]);
    if (spec.width === spec.height) grainAxes.add('W').add('H');
    const foldParallelGrain = grainAxes.has(foldAxis);

    return {
      name,
      sheetAlong: name === 'straight' ? '展开宽沿原纸宽' : '展开宽沿原纸高',
      foldParallelGrain,
      usableWidth,
      usableHeight,
      cols,
      rows,
      perSheet: cols * rows,
    };
  });

  const allowed = placements.filter((p) => p.foldParallelGrain && p.perSheet > 0);
  allowed.sort((a, b) => b.perSheet - a.perSheet || (a.name === 'straight' ? -1 : 1));
  const chosen = allowed[0] || null;
  return {
    placements,
    feasiblePlacement: chosen ? chosen.name : null,
    perSheet: chosen ? chosen.perSheet : 0,
  };
}

/**
 * 有限库存覆盖需求的精确选配（单价为整数分）。
 * 参与规格仅含每张可出纸且库存为正者，顺序即编号升序；状态按封顶产出 s∈[0,demand)
 * 做分层 DP：同层状态只保留「总价 → 前缀领用量序列字典序（dense rank）」最优记录；
 * 每层用按余数分类的单调队列把单规格转移优化到 O(demand)。
 * 到达需求的终态可发生在任意层（后续规格领用量取 0 必更优，价格为正）：
 * 终态依次按总价、超印量、完整领用量序列字典序比较。
 * 成功返回 { used: 各规格领用量（与入参同序）, totalOutput, overprint, totalCost }；
 * 库存总出数不足以覆盖需求时返回 null。
 */
function chooseCombination(specs, demand) {
  const usable = specs.filter((s) => s.perSheet > 0 && s.stock > 0);
  const totalCapacity = usable.reduce((sum, s) => sum + s.perSheet * s.stock, 0);
  if (totalCapacity < demand) return null;

  const n = usable.length;
  // layers[k][s]：用完前 k 种规格、封顶产出为 s 时的最优记录
  // { cost, rank, prevRank, u }；rankIndex[k] 为该层 rank → 状态下标 的反查
  const layers = [];
  const rankIndex = [];
  const zero = new Array(demand).fill(null);
  zero[0] = { cost: 0, rank: 0, prevRank: -1, u: 0 };
  layers.push(zero);
  rankIndex.push([0]);

  let best = null; // 最优终态 { cost, overprint, layer, s, u }

  for (let k = 0; k < n; k++) {
    const { perSheet: y, stock: cap, price } = usable[k];
    const prev = layers[k];
    const next = new Array(demand).fill(null);
    // 每个余数类一个单调双端队列；队首为当前目标状态下的最优来源
    const residueCount = Math.min(y, demand);
    const deques = new Array(residueCount);

    const considerTerminal = (s, rec) => {
      const u0 = Math.ceil((demand - s) / y); // 覆盖需求的最小领用量；更大的 u 总价必更高
      if (u0 > cap) return;
      const term = {
        cost: rec.cost + u0 * price,
        overprint: s + u0 * y - demand,
        layer: k,
        s,
        u: u0,
      };
      if (
        !best ||
        term.cost < best.cost ||
        (term.cost === best.cost &&
          (term.overprint < best.overprint ||
            (term.overprint === best.overprint && compareTerminalVectors(term, best, layers, rankIndex, n) < 0)))
      ) {
        best = term;
      }
    };

    for (let t = 0; t < demand; t++) {
      const source = prev[t];
      const r = t % y;
      let dq = deques[r];
      if (!dq) {
        dq = [];
        deques[r] = dq;
      }
      if (source) {
        // 来源键：A = cost − (s/y)·price 升序、rank 升序、s 降序（同目标时 u 更小）
        const entry = { s: t, a: source.cost - Math.floor(t / y) * price, rank: source.rank };
        while (dq.length) {
          const back = dq[dq.length - 1];
          if (back.a < entry.a || (back.a === entry.a && back.rank < entry.rank)) break;
          dq.pop(); // 同 A 同 rank 时 s 更大的新项恒优（领用量更小且更晚过期）
        }
        dq.push(entry);
        considerTerminal(t, source);
      }
      const minS = t - cap * y;
      while (dq.length && dq[0].s < minS) dq.shift();
      if (dq.length) {
        const src = dq[0];
        const u = (t - src.s) / y;
        next[t] = {
          cost: prev[src.s].cost + u * price,
          rank: -1,
          prevRank: src.rank,
          u,
        };
      }
    }

    // 为新一层记录分配 dense rank（按前缀领用量序列字典序：prevRank, u）
    const order = [];
    for (let s = 0; s < demand; s++) if (next[s]) order.push(s);
    order.sort((sa, sb) => {
      const A = next[sa];
      const B = next[sb];
      return A.prevRank - B.prevRank || A.u - B.u;
    });
    order.forEach((s, idx) => {
      next[s].rank = idx;
    });
    layers.push(next);
    rankIndex.push(order);
  }

  if (!best) return null; // 理论上容量预检通过后不会发生
  const used = reconstructVector(best, layers, rankIndex, n);

  // 映射回入参（已过滤规格领用量恒为 0）
  const usedByCode = new Map();
  usable.forEach((s, i) => usedByCode.set(s.code, used[i]));
  return {
    usedByCode,
    totalOutput: demand + best.overprint,
    overprint: best.overprint,
    totalCost: best.cost,
  };
}

/** 反查终态对应的完整领用量序列（未使用的后续规格补 0） */
function reconstructVector(term, layers, rankIndex, n) {
  const v = new Array(n).fill(0);
  v[term.layer] = term.u;
  let curS = term.s;
  for (let L = term.layer; L >= 1; L--) {
    const rec = layers[L][curS];
    v[L - 1] = rec.u;
    curS = rankIndex[L - 1][rec.prevRank];
  }
  return v;
}

/** 比较两个终态的完整领用量序列字典序（不足 n 的尾部补 0）；返回 -1 / 0 / 1 */
function compareTerminalVectors(a, b, layers, rankIndex, n) {
  const va = reconstructVector(a, layers, rankIndex, n);
  const vb = reconstructVector(b, layers, rankIndex, n);
  for (let i = 0; i < n; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

/** 分转元的展示文本（两位小数） */
function fenToYuan(fen) {
  return (fen / 100).toFixed(2);
}

/**
 * 生成开料选配方案。
 * raw 结构为 { state, demand?, printRun?, sheetWidth, sheetHeight, foldDirection, trim, kerf, stocks }。
 * 当前拼版结构非法返回 null；拼版未通过校验或输入非法返回 { error, errors? }；
 * 成功返回完整方案（含每种原纸两种摆放枚举、每张出数、领用量与总价 / 超印汇总）。
 * validate 由调用方注入（避免与拼版模块产生循环依赖）。
 */
function planStockCutting(raw, validate) {
  if (!raw || typeof raw !== 'object') return null;
  const validation = validate(raw.state);
  if (!validation) return null;
  if (!validation.valid) {
    return {
      error: '当前拼版存在拼版错误，请先修复或重置后再进行开料选配',
      errors: validation.errors,
    };
  }
  const sheetCount = Number(raw.state && raw.state.sheetCount);
  const normalized = normalizeCuttingParams(raw, sheetCount);
  if (normalized.error) return { error: normalized.error };
  const params = normalized.params;

  const evaluated = params.stocks.map((spec) => ({
    ...spec,
    ...evaluateStock(spec, params),
  }));
  const usableKinds = evaluated.filter((s) => s.perSheet > 0 && s.stock > 0);
  const totalCapacity = usableKinds.reduce((sum, s) => sum + s.perSheet * s.stock, 0);

  const result = {
    demand: params.demand,
    sheetWidth: params.sheetWidth,
    sheetHeight: params.sheetHeight,
    foldDirection: params.foldDirection,
    foldLabel: FOLD_LABEL[params.foldDirection],
    trim: params.trim,
    kerf: params.kerf,
    sheetCount,
    stocks: evaluated.map((s) => ({
      code: s.code,
      width: s.width,
      height: s.height,
      grain: s.grain,
      grainLabel: GRAIN_LABEL[s.grain],
      stock: s.stock,
      price: s.price,
      priceYuan: fenToYuan(s.price),
      placements: s.placements,
      feasiblePlacement: s.feasiblePlacement,
      feasiblePlacementLabel: s.feasiblePlacement ? PLACEMENT_LABEL[s.feasiblePlacement] : null,
      perSheet: s.perSheet,
    })),
    feasible: false,
    totalCapacity,
  };
  if (params.printRun !== null) result.printRun = params.printRun;

  if (usableKinds.length === 0) {
    result.reason = '无可用于出纸的原纸规格：各规格库存为 0，或折线不平行纸纹 / 扣除修边后尺寸不足（尺寸不适配）';
    return result;
  }
  const choice = chooseCombination(usableKinds, params.demand);
  if (!choice) {
    result.reason = `库存不足：可用原纸满库存最多出 ${totalCapacity} 张，无法覆盖 ${params.demand} 张的需求`;
    return result;
  }

  result.feasible = true;
  let totalUsedSheets = 0;
  result.solution = {
    items: result.stocks.map((s) => {
      const used = choice.usedByCode.get(s.code) || 0;
      const output = used * s.perSheet;
      const cost = used * s.price;
      totalUsedSheets += used;
      return {
        code: s.code,
        placement: s.feasiblePlacement,
        placementLabel: s.feasiblePlacementLabel,
        perSheet: s.perSheet,
        used,
        output,
        cost,
        costYuan: fenToYuan(cost),
      };
    }),
    totalUsedSheets,
    totalOutput: choice.totalOutput,
    overprint: choice.overprint,
    totalCost: choice.totalCost,
    totalCostYuan: fenToYuan(choice.totalCost),
  };
  return result;
}

/** CSV 字段转义：编号含逗号 / 引号 / 换行时按 RFC 4180 加引号 */
function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 生成与页面内容一致的开料选配 CSV（带 BOM，Excel 友好）。
 * 结构非法返回 null；拼版有错 / 输入非法返回 { error, errors? }；无选配方案同样拒绝导出。
 */
function buildStockCuttingCsv(raw, validate) {
  const plan = planStockCutting(raw, validate);
  if (!plan) return null;
  if (plan.error) return plan;
  if (!plan.feasible) {
    return { error: `无选配方案：${plan.reason}` };
  }
  const detailById = new Map(plan.solution.items.map((it) => [it.code, it]));
  const rows = [];
  rows.push(['原纸开料选配方案']);
  rows.push([
    '展开纸张宽(mm)', String(plan.sheetWidth),
    '展开纸张高(mm)', String(plan.sheetHeight),
    '折线方向', FOLD_LABEL[plan.foldDirection],
  ]);
  rows.push([
    '统一修边量(mm)', String(plan.trim),
    '刀缝(mm)', String(plan.kerf),
    '实体纸张数', String(plan.sheetCount),
  ]);
  const demandSummary = ['需求量(张)', String(plan.demand)];
  if (plan.printRun !== null && plan.printRun !== undefined) {
    demandSummary.push('印量', String(plan.printRun));
  }
  rows.push(demandSummary);
  rows.push([
    '原纸编号', '原纸宽(mm)', '原纸高(mm)', '纸纹方向', '库存(张)',
    '单价(分/张)', '单价(元/张)', '选用摆放', '排布（每行×每列）', '每张出数(张)',
    '领用量(张)', '实际出数(张)', '金额(分)', '金额(元)',
  ]);
  for (const s of plan.stocks) {
    const item = detailById.get(s.code);
    let placementText;
    let layoutText;
    if (s.feasiblePlacement) {
      const chosen = s.placements.find((p) => p.name === s.feasiblePlacement);
      placementText = PLACEMENT_LABEL[s.feasiblePlacement];
      layoutText = `每行${chosen.cols}张;每列${chosen.rows}张`;
    } else {
      placementText = '无（折线不平行纸纹或尺寸不足）';
      layoutText = '每行0张;每列0张';
    }
    rows.push([
      s.code,
      String(s.width),
      String(s.height),
      GRAIN_LABEL[s.grain],
      String(s.stock),
      String(s.price),
      s.priceYuan,
      placementText,
      layoutText,
      String(s.perSheet),
      String(item.used),
      String(item.output),
      String(item.cost),
      item.costYuan,
    ]);
  }
  const sol = plan.solution;
  rows.push([
    '合计', '', '', '', '', '', '', '', '', '',
    String(sol.totalUsedSheets),
    String(sol.totalOutput),
    String(sol.totalCost),
    sol.totalCostYuan,
  ]);
  rows.push([
    '总价(分)', String(sol.totalCost),
    '总价(元)', sol.totalCostYuan,
    '总出数(张)', String(sol.totalOutput),
    '超印(张)', String(sol.overprint),
  ]);
  return { csv: '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', plan };
}

module.exports = {
  MIN_DEMAND,
  MAX_DEMAND,
  MIN_PRINT_RUN,
  MAX_PRINT_RUN,
  MIN_DIMENSION,
  MAX_DIMENSION,
  MIN_ALLOWANCE,
  MAX_ALLOWANCE,
  MIN_STOCK_KINDS,
  MAX_STOCK_KINDS,
  MAX_INVENTORY,
  MIN_PRICE,
  MAX_PRICE,
  MAX_CODE_LENGTH,
  FOLD_DIRECTIONS,
  GRAIN_DIRECTIONS,
  FOLD_LABEL,
  GRAIN_LABEL,
  PLACEMENT_LABEL,
  fitCount,
  normalizeCuttingParams,
  evaluateStock,
  chooseCombination,
  planStockCutting,
  buildStockCuttingCsv,
  fenToYuan,
};
