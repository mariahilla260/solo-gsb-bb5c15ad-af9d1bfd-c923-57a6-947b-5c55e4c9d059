'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fitCount,
  normalizeCuttingParams,
  evaluateStock,
  chooseCombination,
  planStockCutting,
  buildStockCuttingCsv,
} = require('../src/cutting');
const { generateImposition, validateImposition } = require('../src/imposition');

const state8 = generateImposition(8); // 2 张实体纸

const baseRaw = (overrides = {}) => ({
  state: state8,
  printRun: 1,
  sheetWidth: 420,
  sheetHeight: 297,
  foldDirection: 'vertical',
  trim: 3,
  kerf: 2,
  stocks: [
    { code: 'A', width: 889, height: 1194, grain: 'long', stock: 100, price: 12000 },
    { code: 'B', width: 787, height: 1092, grain: 'long', stock: 100, price: 9000 },
  ],
  ...overrides,
});

/* ---------- 几何：整行整列与修边 / 刀缝 ---------- */

test('整行整列：四边扣修边、相邻件计刀缝', () => {
  // usable = 889 - 6 = 883；floor((883+2)/(420+2)) = floor(885/422) = 2
  assert.equal(fitCount(889, 420, 3, 2), 2);
  // usable = 1194 - 6 = 1188；floor(1190/299) = 3
  assert.equal(fitCount(1194, 297, 3, 2), 3);
  // 无修边无刀缝：整除
  assert.equal(fitCount(1000, 100, 0, 0), 10);
  // 刀缝口径：floor((usable + kerf)/(piece + kerf))，首件不占刀缝
  assert.equal(fitCount(250, 100, 0, 50), 2); // (250+50)/150 = 2
  assert.equal(fitCount(249, 100, 0, 50), 1);
  // 修边后无可用空间
  assert.equal(fitCount(100, 60, 50, 0), 0);
});

/* ---------- 参数规范化 ---------- */

test('参数规范化：合法输入通过并按编号升序', () => {
  const r = normalizeCuttingParams(baseRaw({
    stocks: [
      { code: 'B', width: 1, height: 1, grain: 'short', stock: 0, price: 1 },
      { code: 'A', width: 10000, height: 10000, grain: 'long', stock: 1000, price: 1000000000 },
    ],
  }), 2);
  assert.ok(r.params);
  assert.equal(r.params.stocks[0].code, 'A');
  assert.equal(r.params.stocks[1].code, 'B');
  assert.equal(r.params.demand, 2); // 缺省 = 实体纸张数 2 × 印量 1
});

test('参数规范化：需求量默认值=实体纸张数×印量，并随印量计算', () => {
  const r = normalizeCuttingParams(baseRaw({ printRun: 500 }), 2);
  assert.equal(r.params.demand, 1000);
  // 显式需求量优先于默认值
  assert.equal(normalizeCuttingParams(baseRaw({ demand: 7, printRun: 500 }), 2).params.demand, 7);
});

test('参数规范化：默认需求量超出 1~10000 时拒绝并给出算式', () => {
  const r = normalizeCuttingParams(baseRaw({ printRun: 9999 }), 2);
  assert.match(r.error, /默认需求量/);
  assert.match(r.error, /实体纸张数 2 × 印量 9999 = 19998/);
});

test('参数规范化：需求 / 印量范围与整数要求', () => {
  assert.match(normalizeCuttingParams(baseRaw({ demand: 0 }), 2).error, /需求量/);
  assert.match(normalizeCuttingParams(baseRaw({ demand: 10001 }), 2).error, /需求量/);
  assert.match(normalizeCuttingParams(baseRaw({ demand: 1.5 }), 2).error, /需求量/);
  assert.match(normalizeCuttingParams(baseRaw({ demand: true }), 2).error, /需求量/);
  assert.match(normalizeCuttingParams(baseRaw({ printRun: 0 }), 2).error, /印量/);
  // 两者都缺失
  assert.match(normalizeCuttingParams(baseRaw({ printRun: null, demand: null }), 2).error, /请填写需求量/);
});

test('参数规范化：展开尺寸、修边、刀缝', () => {
  assert.match(normalizeCuttingParams(baseRaw({ sheetWidth: 0 }), 2).error, /展开纸张宽度/);
  assert.match(normalizeCuttingParams(baseRaw({ sheetHeight: 10001 }), 2).error, /展开纸张高度/);
  assert.match(normalizeCuttingParams(baseRaw({ sheetWidth: 1.5 }), 2).error, /展开纸张宽度/);
  assert.match(normalizeCuttingParams(baseRaw({ trim: -1 }), 2).error, /修边量/);
  assert.match(normalizeCuttingParams(baseRaw({ kerf: -1 }), 2).error, /刀缝/);
  assert.ok(normalizeCuttingParams(baseRaw({ trim: 0, kerf: 0 }), 2).params);
  assert.match(normalizeCuttingParams(baseRaw({ foldDirection: 'diagonal' }), 2).error, /折线方向/);
});

test('参数规范化：原纸 1~6 种', () => {
  assert.match(normalizeCuttingParams(baseRaw({ stocks: [] }), 2).error, /1~6 种/);
  const seven = Array.from({ length: 7 }, (_, i) => ({
    code: `S${i}`, width: 800, height: 800, grain: 'long', stock: 1, price: 1,
  }));
  assert.match(normalizeCuttingParams(baseRaw({ stocks: seven }), 2).error, /1~6 种/);
});

test('参数规范化：编号唯一、非空、禁逗号', () => {
  const dup = [
    { code: 'A', width: 800, height: 800, grain: 'long', stock: 1, price: 1 },
    { code: ' A ', width: 800, height: 800, grain: 'long', stock: 1, price: 1 },
  ];
  assert.match(normalizeCuttingParams(baseRaw({ stocks: dup }), 2).error, /编号「A」重复/);
  assert.match(
    normalizeCuttingParams(baseRaw({
      stocks: [{ code: '  ', width: 800, height: 800, grain: 'long', stock: 1, price: 1 }],
    }), 2).error,
    /编号不能为空/
  );
  assert.match(
    normalizeCuttingParams(baseRaw({
      stocks: [{ code: 'A,B', width: 800, height: 800, grain: 'long', stock: 1, price: 1 }],
    }), 2).error,
    /编号不能包含逗号/
  );
  assert.match(
    normalizeCuttingParams(baseRaw({
      stocks: [{ code: 'x'.repeat(21), width: 800, height: 800, grain: 'long', stock: 1, price: 1 }],
    }), 2).error,
    /编号长度/
  );
});

test('参数规范化：宽高、库存、单价约束', () => {
  const mk = (patch) => normalizeCuttingParams(baseRaw({
    stocks: [{ code: 'A', width: 800, height: 800, grain: 'long', stock: 10, price: 100, ...patch }],
  }), 2);
  assert.match(mk({ width: 0 }).error, /宽度/);
  assert.match(mk({ height: 10001 }).error, /高度/);
  assert.match(mk({ stock: -1 }).error, /库存/);
  assert.match(mk({ stock: 1001 }).error, /库存/);
  assert.match(mk({ price: 0 }).error, /单价/);
  assert.match(mk({ grain: 'weave' }).error, /纸纹方向/);
});

/* ---------- 摆放枚举与纸纹 ---------- */

const params = normalizeCuttingParams(baseRaw(), 2).params;

test('摆放枚举：纵向折线 + 长纹仅正向合法，且按整行整列出数', () => {
  const spec = { code: 'A', width: 889, height: 1194, grain: 'long' };
  const ev = evaluateStock(spec, params);
  assert.equal(ev.placements[0].name, 'straight');
  assert.equal(ev.placements[0].foldParallelGrain, true);
  assert.equal(ev.placements[0].cols, 2);
  assert.equal(ev.placements[0].rows, 3);
  assert.equal(ev.placements[0].perSheet, 6);
  assert.equal(ev.placements[1].foldParallelGrain, false);
  assert.equal(ev.feasiblePlacement, 'straight');
  assert.equal(ev.perSheet, 6);
});

test('摆放枚举：纵向折线 + 短纹仅旋转 90° 合法', () => {
  const ev = evaluateStock({ code: 'B', width: 889, height: 1194, grain: 'short' }, params);
  assert.equal(ev.placements[0].foldParallelGrain, false);
  assert.equal(ev.placements[1].foldParallelGrain, true);
  assert.equal(ev.feasiblePlacement, 'swapped');
  assert.equal(ev.perSheet, ev.placements[1].perSheet);
});

test('摆放枚举：横向折线下长纹改由旋转摆放满足', () => {
  const horiz = { ...params, foldDirection: 'horizontal' };
  const ev = evaluateStock({ code: 'A', width: 889, height: 1194, grain: 'long' }, horiz);
  assert.equal(ev.placements[0].foldParallelGrain, false);
  assert.equal(ev.placements[1].foldParallelGrain, true);
  assert.equal(ev.feasiblePlacement, 'swapped');
});

test('摆放枚举：扣除修边后放不下任何一件时尺寸不适配', () => {
  // 425×300 原纸扣 6mm 修边后可用 419×294：正向宽 419 < 420（0 列），旋转后高 419/422 = 0 行，均出 0
  const ev = evaluateStock({ code: 'S', width: 425, height: 300, grain: 'long' }, params);
  assert.equal(ev.perSheet, 0);
  assert.equal(ev.feasiblePlacement, null);
  const ev2 = evaluateStock({ code: 'T', width: 100, height: 100, grain: 'long' }, { ...params, trim: 45 });
  assert.equal(ev2.perSheet, 0);
});

test('摆放枚举：纸纹合法但出数为 0 仍判不适配', () => {
  // 800×300 原纸：纵向折线长纹（H 轴），正向 rows=floor((300-6+2)/299)=0；
  // 旋转后纸纹不符。无可用摆放。
  const ev = evaluateStock({ code: 'U', width: 800, height: 300, grain: 'long' }, params);
  assert.equal(ev.feasiblePlacement, null);
  assert.equal(ev.perSheet, 0);
});

/* ---------- 选配：价格 / 超印 / 字典序 ---------- */

test('选配：总价最低优先', () => {
  const r = chooseCombination([
    { code: 'A', perSheet: 4, stock: 10, price: 100 },
    { code: 'B', perSheet: 4, stock: 10, price: 60 },
  ], 8);
  assert.deepEqual([...r.usedByCode.values()], [0, 2]);
  assert.equal(r.totalCost, 120);
  assert.equal(r.overprint, 0);
});

test('选配：总价相同时超印最少优先', () => {
  // 需求 5：A 每张 2 出 3 张=6（超 1，30 分）；B 每张 5 出 1 张=5（超 0，30 分）
  const r = chooseCombination([
    { code: 'A', perSheet: 2, stock: 10, price: 10 },
    { code: 'B', perSheet: 5, stock: 10, price: 30 },
  ], 5);
  assert.deepEqual([...r.usedByCode.values()], [0, 1]);
  assert.equal(r.overprint, 0);
  assert.equal(r.totalCost, 30);
});

test('选配：价格与超印均并列时，编号升序列用量取字典序最小', () => {
  const r = chooseCombination([
    { code: 'A', perSheet: 2, stock: 10, price: 10 },
    { code: 'B', perSheet: 2, stock: 10, price: 10 },
  ], 4);
  assert.deepEqual([...r.usedByCode.values()], [0, 2]); // [0,2] < [1,1] < [2,0]
});

test('选配：不得超出库存', () => {
  // A 库存 1 出 4，B 需补足
  const r = chooseCombination([
    { code: 'A', perSheet: 4, stock: 1, price: 1 },
    { code: 'B', perSheet: 4, stock: 10, price: 100 },
  ], 8);
  assert.deepEqual([...r.usedByCode.values()], [1, 1]);
});

test('选配：库存不足或全部不可用时无解', () => {
  assert.equal(chooseCombination([
    { code: 'A', perSheet: 4, stock: 1, price: 10 },
    { code: 'B', perSheet: 3, stock: 1, price: 10 },
  ], 8), null);
  assert.equal(chooseCombination([], 1), null);
});

test('选配：大规模（需求 10000、6 种规格）可在毫秒级精确求解', () => {
  const specs = Array.from({ length: 6 }, (_, i) => ({
    code: `S${i}`, perSheet: 2, stock: 1000, price: 100 + i,
  }));
  const started = Date.now();
  const r = chooseCombination(specs, 10000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(r.totalOutput, 10000);
  assert.equal(r.overprint, 0);
});

/* ---------- 端到端 planStockCutting ---------- */

test('端到端：合法拼版返回完整方案，含各规格摆放枚举与汇总', () => {
  const plan = planStockCutting(baseRaw({ demand: 20 }), validateImposition);
  assert.equal(plan.feasible, true);
  assert.equal(plan.demand, 20);
  assert.equal(plan.stocks.length, 2);
  // A：889×1194 长纹纵向正向 2×3=6；B：787×1092：宽向 floor((787-6+2)/422)=1，高向 floor(1088/299)=3 → 3
  const A = plan.stocks.find((s) => s.code === 'A');
  const B = plan.stocks.find((s) => s.code === 'B');
  assert.equal(A.perSheet, 6);
  assert.equal(B.perSheet, 3);
  assert.ok(plan.solution.totalCost > 0);
  assert.ok(plan.solution.totalOutput >= 20);
  assert.equal(plan.solution.overprint, plan.solution.totalOutput - 20);
});

test('端到端：拼版结构非法返回 null；拼版有错拒绝计算', () => {
  assert.equal(planStockCutting({ ...baseRaw(), state: null }, validateImposition), null);
  const broken = JSON.parse(JSON.stringify(state8));
  broken.sheets[0].front.left = 1; // 制造重复 / 配对错误
  const plan = planStockCutting(baseRaw({ state: broken }), validateImposition);
  assert.match(plan.error, /拼版错误/);
  assert.ok(plan.errors);
});

test('端到端：输入非法拒绝计算', () => {
  const plan = planStockCutting(baseRaw({ trim: -1 }), validateImposition);
  assert.match(plan.error, /修边量/);
});

test('端到端：库存不足时 feasible=false 并说明原因', () => {
  const plan = planStockCutting(baseRaw({
    demand: 1000,
    stocks: [
      { code: 'A', width: 889, height: 1194, grain: 'long', stock: 1, price: 12000 },
      { code: 'B', width: 787, height: 1092, grain: 'long', stock: 1, price: 9000 },
    ],
  }), validateImposition);
  assert.equal(plan.feasible, false);
  assert.match(plan.reason, /库存不足/);
  assert.match(plan.reason, /1000/);
});

test('端到端：尺寸全部不适配时说明尺寸不适配', () => {
  const plan = planStockCutting(baseRaw({
    demand: 10,
    stocks: [{ code: 'S', width: 300, height: 300, grain: 'long', stock: 100, price: 100 }],
  }), validateImposition);
  assert.equal(plan.feasible, false);
  assert.match(plan.reason, /尺寸不适配|库存为 0/);
});

test('端到端：分帖拼版同样接入校验', () => {
  const multi = generateImposition(10, 2); // 3 张实体纸
  const plan = planStockCutting(baseRaw({ state: multi, printRun: 2 }), validateImposition);
  assert.equal(plan.sheetCount, 3);
  assert.equal(plan.demand, 6);
  assert.equal(plan.feasible, true);
});

/* ---------- CSV ---------- */

test('CSV：与页面内容一致（需求、摆放出数、领用量、总价、超印）', () => {
  const r = buildStockCuttingCsv(baseRaw({ demand: 20 }), validateImposition);
  assert.ok(r.csv.startsWith('﻿'));
  assert.match(r.csv, /原纸开料选配方案/);
  assert.match(r.csv, /需求量\(张\),20/);
  assert.match(r.csv, /每行2张;每列3张/);
  assert.match(r.csv, /超印\(张\)/);
  const plan = r.plan;
  assert.match(r.csv, new RegExp(`总价\\(分\\),${plan.solution.totalCost}`));
});

test('CSV：无方案 / 拼版有错 / 结构非法时拒绝导出', () => {
  const infeasible = buildStockCuttingCsv(baseRaw({
    demand: 1000,
    stocks: [{ code: 'A', width: 889, height: 1194, grain: 'long', stock: 1, price: 1 }],
  }), validateImposition);
  assert.match(infeasible.error, /无选配方案/);
  const broken = JSON.parse(JSON.stringify(state8));
  broken.sheets[0].front.left = 1;
  assert.match(buildStockCuttingCsv(baseRaw({ state: broken }), validateImposition).error, /拼版错误/);
  assert.equal(buildStockCuttingCsv(null, validateImposition), null);
});
