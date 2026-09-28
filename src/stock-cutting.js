'use strict';

const { normalizeState, validateImposition, summarizeErrors } = require('./imposition');

/**
 * 原纸开料选配（接当前拼版校验）。
 *
 * 输入：
 *  - demand       需求量 1~10000 张（展开纸张数；页面默认值 = 实体纸张数 × 印量）
 *  - sheetWidth / sheetHeight  展开纸张宽 / 高（整数毫米，正数）
 *  - foldDirection 折线方向：'horizontal' 横向 / 'vertical' 竖向
 *  - trim         统一修边量（非负整数毫米，原纸四边各扣除一次）
 *  - kerf         相邻刀缝（非负整数毫米，同行 / 同列相邻两张展开纸之间计入一次）
 *  - papers       1~6 种原纸：编号（唯一）、宽 / 高（正整数毫米）、
 *                 纸纹方向 grain（'horizontal' / 'vertical'）、库存 0~1000 张、单价（分，正整数）
 *
 * 服务端枚举每种原纸的两种正交摆放（0°：原纸宽沿水平；90°：旋转 90°，原纸宽沿竖直），
 * 仅允许「折线平行纸纹」的那一种（两种摆放恰好一种满足）；
 * 扣除四边修边后按整行整列计算：
 *   可用宽 = 原纸水平向边长 − 2 × 修边；列数 = floor((可用宽 + 刀缝) / (沿水平向的展开边长 + 刀缝))
 *   行数同理（沿竖直向），单张最大出数 = 列数 × 行数。
 *
 * 精确选取不超库存且总出数覆盖需求的组合：
 *   1) 总价最低；2) 总价相同超印张数（总出数 − 需求）最少；3) 仍并列按编号升序的
 *   领用量序列取字典序最小者。无可行组合时说明库存不足或尺寸不适配。
 */

const MIN_DEMAND = 1;
const MAX_DEMAND = 10000;
const MIN_COPIES = 1;
const MAX_COPIES = 10000;
const MAX_PAPER_KINDS = 6;
const MAX_STOCK = 1000;
const MAX_DIMENSION = 100000; // 宽高上限（整数毫米）
const MAX_TRIM = 100000; // 修边量 / 刀缝上限（毫米）
const MAX_UNIT_PRICE = 1000000000; // 单价上限（分）
const MAX_CODE_LENGTH = 20;

const DIRECTIONS = ['horizontal', 'vertical'];
const DIRECTION_LABEL = { horizontal: '横向', vertical: '竖向' };
const ROTATION_LABEL = {
  '0deg': '原样摆放（0°，原纸宽沿水平）',
  '90deg': '旋转 90°（原纸宽沿竖直）',
};

/** 旋转 90° 后的轴向：横向 ↔ 竖向 */
function rotateAxis(axis) {
  return axis === 'horizontal' ? 'vertical' : 'horizontal';
}

/** 严格读取非负 / 正整数 */
function intField(obj, key) {
  const v = obj == null ? undefined : obj[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * 默认需求量：实体纸张数 × 印量。
 * 印量为 1~10000 的正整数；拼版结构非法返回 null。
 */
function computeDefaultDemand(rawState, copies) {
  const state = normalizeState(rawState);
  if (!state) return null;
  const c = Number(copies);
  if (!Number.isInteger(c) || c < MIN_COPIES || c > MAX_COPIES) return null;
  return state.sheetCount * c;
}

/**
 * 校验并规范化选配入参（不含拼版）。
 * 返回规范化对象；非法时返回 { error }（说明具体原因）。
 */
function normalizeStockParams(raw) {
  if (!raw || typeof raw !== 'object') return { error: '选配参数缺失或格式不正确' };

  const demand = intField(raw, 'demand');
  if (demand === null || demand < MIN_DEMAND || demand > MAX_DEMAND) {
    return { error: `需求量必须是 ${MIN_DEMAND}~${MAX_DEMAND} 的整数张` };
  }

  const sheetWidth = intField(raw, 'sheetWidth');
  if (sheetWidth === null || sheetWidth < 1 || sheetWidth > MAX_DIMENSION) {
    return { error: `展开纸张宽度必须是 1~${MAX_DIMENSION} 的整数毫米` };
  }
  const sheetHeight = intField(raw, 'sheetHeight');
  if (sheetHeight === null || sheetHeight < 1 || sheetHeight > MAX_DIMENSION) {
    return { error: `展开纸张高度必须是 1~${MAX_DIMENSION} 的整数毫米` };
  }

  if (!DIRECTIONS.includes(raw.foldDirection)) {
    return { error: '折线方向必须是「横向 horizontal」或「竖向 vertical」' };
  }
  const foldDirection = raw.foldDirection;

  const trim = intField(raw, 'trim');
  if (trim === null || trim < 0 || trim > MAX_TRIM) {
    return { error: `修边量必须是 0~${MAX_TRIM} 的整数毫米` };
  }
  const kerf = intField(raw, 'kerf');
  if (kerf === null || kerf < 0 || kerf > MAX_TRIM) {
    return { error: `刀缝必须是 0~${MAX_TRIM} 的整数毫米` };
  }

  if (!Array.isArray(raw.papers) || raw.papers.length < 1 || raw.papers.length > MAX_PAPER_KINDS) {
    return { error: `原纸种类必须是 1~${MAX_PAPER_KINDS} 种` };
  }

  const seen = new Set();
  const papers = [];
  for (let i = 0; i < raw.papers.length; i++) {
    const rp = raw.papers[i];
    const at = `第 ${i + 1} 种原纸`;
    if (!rp || typeof rp !== 'object') return { error: `${at}：数据格式不正确` };

    const code = String(rp.code == null ? '' : rp.code).trim();
    if (!code) return { error: `${at}：编号不能为空` };
    if (code.length > MAX_CODE_LENGTH) return { error: `${at}：编号长度不能超过 ${MAX_CODE_LENGTH} 个字符` };
    if (/[,"\r\n\t]/.test(code) || /[，]/.test(code)) {
      return { error: `${at}：编号不能包含逗号、引号或换行` };
    }
    if (seen.has(code)) return { error: `原纸编号「${code}」重复，编号必须唯一` };
    seen.add(code);

    const width = intField(rp, 'width');
    if (width === null || width < 1 || width > MAX_DIMENSION) {
      return { error: `原纸「${code}」宽度必须是 1~${MAX_DIMENSION} 的整数毫米` };
    }
    const height = intField(rp, 'height');
    if (height === null || height < 1 || height > MAX_DIMENSION) {
      return { error: `原纸「${code}」高度必须是 1~${MAX_DIMENSION} 的整数毫米` };
    }
    if (!DIRECTIONS.includes(rp.grain)) {
      return { error: `原纸「${code}」纸纹方向必须是「横向 horizontal」或「竖向 vertical」` };
    }
    const stock = intField(rp, 'stock');
    if (stock === null || stock < 0 || stock > MAX_STOCK) {
      return { error: `原纸「${code}」库存必须是 0~${MAX_STOCK} 的整数张` };
    }
    const price = intField(rp, 'price');
    if (price === null || price < 1 || price > MAX_UNIT_PRICE) {
      return { error: `原纸「${code}」单价必须是 1~${MAX_UNIT_PRICE} 的正整数（分）` };
    }

    papers.push({ code, width, height, grain: rp.grain, stock, price });
  }

  // 后续用量序列按编号升序定义；排序同时作为字典序 tie-break 的固定顺序
  papers.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return { demand, sheetWidth, sheetHeight, foldDirection, trim, kerf, papers };
}

/**
 * 计算单个轴向上可容纳的整行 / 整列数：
 * 扣除两端修边后，n 个工件占 n×piece + (n−1)×kerf，即 (usable + kerf) / (piece + kerf) 向下取整。
 */
function fitCount(usable, piece, kerf) {
  if (usable <= 0) return 0;
  return Math.floor((usable + kerf) / (piece + kerf));
}

/**
 * 枚举一种原纸的两种正交摆放，并选出折线平行纸纹的可用摆放。
 * 坐标轴为物理方向：horizontal 水平向、vertical 竖向。
 *  - 0°：原纸宽沿水平、高沿竖直；纸纹物理轴向 = 填报纸纹方向；折线物理轴向 = 折线方向。
 *  - 90°：展开纸（连同折线）旋转 90°，原纸本身不转，故纸纹物理轴向不变、
 *    折线物理轴向旋转；允许摆放恰为「折线 ∥ 纸纹」的那一种。
 */
function evaluatePaper(paper, spec) {
  const layouts = [];
  for (const rotation of ['0deg', '90deg']) {
    const rotated = rotation === '90deg';
    // 水平 / 竖直向上的原纸可用边长（四边各扣一次修边）
    const stockHorizontal = rotated ? paper.height : paper.width;
    const stockVertical = rotated ? paper.width : paper.height;
    const usableWidth = stockHorizontal - 2 * spec.trim;
    const usableHeight = stockVertical - 2 * spec.trim;
    // 展开纸沿水平 / 竖直向上的边长（90° 摆放时展开宽沿竖直）
    const pieceHorizontal = rotated ? spec.sheetHeight : spec.sheetWidth;
    const pieceVertical = rotated ? spec.sheetWidth : spec.sheetHeight;

    const grainAxis = paper.grain; // 原纸不旋转，纸纹物理轴向恒定
    const foldAxis = rotated ? rotateAxis(spec.foldDirection) : spec.foldDirection;
    const columns = fitCount(usableWidth, pieceHorizontal, spec.kerf);
    const rows = fitCount(usableHeight, pieceVertical, spec.kerf);

    layouts.push({
      rotation,
      label: ROTATION_LABEL[rotation],
      foldAxis,
      grainAxis,
      foldParallel: foldAxis === grainAxis,
      usableWidth,
      usableHeight,
      columns,
      rows,
      perSheet: columns * rows,
    });
  }

  // 两种摆放中恰有且仅有一种满足折线平行纸纹
  const usable = layouts.find((l) => l.foldParallel);
  return {
    code: paper.code,
    width: paper.width,
    height: paper.height,
    grain: paper.grain,
    stock: paper.stock,
    price: paper.price,
    layouts,
    usableRotation: usable.rotation,
    maxOut: usable.perSheet,
    fit: usable.perSheet > 0,
  };
}

/**
 * 动态规划精确选取最优组合。
 * papers 已按编号升序；总出数 capped 到 demand，故状态可用整数下标 0..demand 索引。
 * 每个阶段以四个纯数值数组记录各总出数槽位的最优候选：
 *   cost[k][t] 总价、real[k][t] 实际总出数、prev[k][t] 前一阶段来源槽位、qty[k][t] 本纸种领用量；
 * 热循环只有数值读写，不产生对象 / 数组分配。
 * 合并规则：
 *  - 未覆盖（t < 需求）：先总价，再用量序列字典序；
 *  - 已覆盖（t = 需求，不再扩展、后续纸种领用量恒为 0）：先总价，再实际总出数（超印），
 *    最后用量序列字典序。
 * 用量序列的字典序比较仅在总价（及实际总出数）并列时沿前驱链回溯，最多纸种类层；
 * 最终从胜出槽位回溯一次重建用量向量。返回 { q, totalOutput, totalPrice }；无解返回 null。
 */
function selectCombination(papers, demand) {
  const K = papers.length;
  const costSnap = [];
  const realSnap = [];
  const prevSnap = [];
  const qtySnap = [];

  // 字典序比较的定长暂存（qtyLess 同步调用且每次完整覆写，可跨调用复用）
  const scratchPool = [new Array(K), new Array(K)];

  // 阶段 −1（初始）：仅槽位 0 可达
  let prevCost = new Array(demand + 1);
  let prevReal = new Array(demand + 1);
  prevCost[0] = 0;
  prevReal[0] = 0;
  let prevReachable = [0];

  /**
   * 比较两个候选的领用量序列字典序（按编号升序，即阶段 0 → K−1，先比较小编号纸种）：
   * 候选 A 为「前驱槽位 (stage−1, tA) 的向量 + 领用量 qA」，候选 B 同理。
   * 严格小于返回 true。沿前驱链把各阶段领用量写入跨调用复用的两个定长暂存数组，
   * 再从小编号纸种起正向比较；热循环不产生对象分配（纸种最多 6 种，开销极小）。
   */
  const qtyLess = (stage, tA, qA, tB, qB) => {
    const scratchA = scratchPool[0];
    const scratchB = scratchPool[1];
    scratchA[stage] = qA;
    scratchB[stage] = qB;
    let a = tA;
    let b = tB;
    for (let s = stage - 1; s >= 0; s--) {
      scratchA[s] = qtySnap[s][a];
      scratchB[s] = qtySnap[s][b];
      a = prevSnap[s][a];
      b = prevSnap[s][b];
    }
    for (let s = 0; s <= stage; s++) {
      if (scratchA[s] !== scratchB[s]) return scratchA[s] < scratchB[s];
    }
    return false;
  };

  for (let k = 0; k < K; k++) {
    const out = papers[k].maxOut;
    const price = papers[k].price;
    const stock = papers[k].stock;
    const cost = new Array(demand + 1);
    const real = new Array(demand + 1);
    const prev = new Array(demand + 1);
    const qty = new Array(demand + 1);
    const seen = new Uint8Array(demand + 1);
    const reachable = [];

    const write = (T, R, C, from, qv, covered) => {
      if (!seen[T]) {
        seen[T] = 1;
        reachable.push(T);
      } else if (C > cost[T]) {
        return;
      } else if (C === cost[T]) {
        if (covered && R !== real[T]) {
          if (R > real[T]) return;
        } else if (!covered || R === real[T]) {
          // 总价并列：已覆盖时实际总出数也并列才比字典序；未覆盖直接比字典序
          if (!qtyLess(k, from, qv, prev[T], qty[T])) return;
        }
      }
      cost[T] = C;
      real[T] = R;
      prev[T] = from;
      qty[T] = qv;
    };

    for (const t of prevReachable) {
      if (t >= demand) {
        // 已覆盖槽位不再扩展：本纸种领用量 0，直接传递
        write(demand, prevReal[t], prevCost[t], t, 0, true);
        continue;
      }
      const maxQ = out === 0 ? 0 : Math.min(stock, Math.ceil((demand - t) / out));
      for (let qv = 0; qv <= maxQ; qv++) {
        const R = prevReal[t] + qv * out;
        const T = R >= demand ? demand : R;
        const C = prevCost[t] + qv * price;
        write(T, R, C, t, qv, T >= demand);
      }
    }

    costSnap.push(cost);
    realSnap.push(real);
    prevSnap.push(prev);
    qtySnap.push(qty);
    prevCost = cost;
    prevReal = real;
    prevReachable = reachable;
  }

  if (prevCost[demand] === undefined) return null;

  // 从胜出槽位回溯重建按纸种（编号升序）的领用量向量
  const q = new Array(K).fill(0);
  let t = demand;
  for (let k = K - 1; k >= 0; k--) {
    q[k] = qtySnap[k][t];
    t = prevSnap[k][t];
  }
  return { q, totalOutput: realSnap[K - 1][demand], totalPrice: costSnap[K - 1][demand] };
}

/**
 * 开料选配主入口：要求当前拼版通过服务端校验，随后校验选配入参并精确求解。
 *  - 拼版结构非法返回 null；
 *  - 拼版存在错误 / 入参非法返回 { error, errors? }；
 *  - 成功返回 { feasible, demand, sheetWidth, sheetHeight, foldDirection, trim, kerf,
 *              entitySheets, papers:[每纸种摆放与出数评估 + 选中领用量], selection }。
 */
function planStockCutting(rawState, rawParams) {
  const state = normalizeState(rawState);
  if (!state) return null;
  const validation = validateImposition(rawState);
  if (!validation.valid) {
    return {
      error: `当前拼版存在错误（${summarizeErrors(validation.errors)}），请先修复或重置后再开料选配`,
      errors: validation.errors,
    };
  }

  const spec = normalizeStockParams(rawParams);
  if (spec.error) return { error: spec.error };

  const evaluated = spec.papers.map((p) => evaluatePaper(p, spec));

  // 可行性预检：各纸种按库存封顶后的总出数能否覆盖需求
  let capacity = 0;
  for (const ev of evaluated) {
    capacity = Math.min(spec.demand, capacity + ev.maxOut * ev.stock);
  }

  const result = {
    feasible: false,
    reason: null,
    demand: spec.demand,
    sheetWidth: spec.sheetWidth,
    sheetHeight: spec.sheetHeight,
    foldDirection: spec.foldDirection,
    trim: spec.trim,
    kerf: spec.kerf,
    entitySheets: state.sheetCount,
    papers: evaluated,
    selection: null,
  };

  if (capacity < spec.demand) {
    // 所有纸种都排不下整张 → 尺寸不适配；否则为库存不足以凑够需求
    result.reason = evaluated.every((p) => p.maxOut === 0) ? 'size_mismatch' : 'insufficient_stock';
    return result;
  }

  const chosen = selectCombination(evaluated, spec.demand);
  if (!chosen) {
    result.reason = evaluated.every((p) => p.maxOut === 0) ? 'size_mismatch' : 'insufficient_stock';
    return result;
  }

  result.feasible = true;
  let totalTake = 0;
  evaluated.forEach((p, i) => {
    const take = chosen.q[i];
    p.take = take;
    p.output = take * p.maxOut;
    p.amount = take * p.price;
    totalTake += take;
  });
  result.selection = {
    totalTake,
    totalOutput: chosen.totalOutput,
    overrun: chosen.totalOutput - spec.demand,
    totalPrice: chosen.totalPrice,
  };
  return result;
}

/** CSV 单元格转义（含逗号 / 引号 / 换行时加双引号） */
function csvCell(v) {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成与屏幕选配结果同内容的 CSV（带 BOM，Excel 友好）：
 * 参数汇总 + 各规格摆放 / 出数 / 领用量 / 金额 + 总价与超印量（无方案时注明原因）。
 * 拼版结构非法返回 null；拼版有错或入参非法返回 { error }。
 */
function buildStockCsv(rawState, rawParams) {
  if (!normalizeState(rawState)) return null;
  const plan = planStockCutting(rawState, rawParams);
  if (plan.error) return plan;

  const rows = [
    ['原纸开料选配', '需求量（张）', String(plan.demand), '实体纸张数（张）', String(plan.entitySheets)],
    [
      '展开纸张（mm）', `${plan.sheetWidth}×${plan.sheetHeight}`,
      '折线方向', DIRECTION_LABEL[plan.foldDirection],
    ],
    ['修边量（mm）', String(plan.trim), '刀缝（mm）', String(plan.kerf)],
    [
      '编号', '原纸宽（mm）', '原纸高（mm）', '纸纹方向', '库存（张）', '单价（分）',
      '摆放', '单张出数', '领用量（张）', '本规格出数', '金额（分）',
    ],
  ];

  for (const p of plan.papers) {
    const usable = p.layouts.find((l) => l.rotation === p.usableRotation);
    const placement =
      `${usable.rotation === '0deg' ? '原样0°' : '旋转90°'}` +
      `（折线∥纸纹，${usable.columns}列×${usable.rows}行）`;
    rows.push([
      p.code,
      String(p.width),
      String(p.height),
      DIRECTION_LABEL[p.grain],
      String(p.stock),
      String(p.price),
      placement,
      String(p.maxOut),
      plan.feasible ? String(p.take) : '-',
      plan.feasible ? String(p.output) : '-',
      plan.feasible ? String(p.amount) : '-',
    ]);
  }

  if (plan.feasible) {
    const s = plan.selection;
    rows.push([
      '总价（分）', String(s.totalPrice),
      '领用纸种（种）', String(plan.papers.filter((p) => p.take > 0).length),
      '总出数（张）', String(s.totalOutput),
      '超印量（张）', String(s.overrun),
    ]);
  } else {
    rows.push([
      '无可用方案',
      plan.reason === 'size_mismatch' ? '尺寸不适配：所有原纸均无法按允许摆放排出至少一张' : '库存不足：现有库存总出数无法覆盖需求',
    ]);
  }

  return { csv: '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', plan };
}

module.exports = {
  MIN_DEMAND,
  MAX_DEMAND,
  MIN_COPIES,
  MAX_COPIES,
  MAX_PAPER_KINDS,
  MAX_STOCK,
  MAX_DIMENSION,
  MAX_TRIM,
  MAX_UNIT_PRICE,
  DIRECTION_LABEL,
  ROTATION_LABEL,
  computeDefaultDemand,
  normalizeStockParams,
  fitCount,
  evaluatePaper,
  selectCombination,
  planStockCutting,
  buildStockCsv,
};
