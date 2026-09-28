'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_PAPER_KINDS,
  MAX_STOCK,
  MAX_DIMENSION,
  MAX_UNIT_PRICE,
  computeDefaultDemand,
  normalizeStockParams,
  fitCount,
  evaluatePaper,
  selectCombination,
  planStockCutting,
  buildStockCsv,
} = require('../src/stock-cutting');
const { generateImposition } = require('../src/imposition');

/** 合法选配入参基线（各用例按需覆盖） */
function baseParams(over = {}) {
  return {
    demand: 12,
    sheetWidth: 100,
    sheetHeight: 100,
    foldDirection: 'horizontal',
    trim: 0,
    kerf: 0,
    papers: [{ code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 10, price: 100 }],
    ...over,
  };
}

/* ---------- 默认需求量 ---------- */

test('默认需求量：实体纸张数 × 印量', () => {
  // 8 页 → 2 张实体纸
  assert.equal(computeDefaultDemand(generateImposition(8), 1), 2);
  assert.equal(computeDefaultDemand(generateImposition(8), 5000), 10000);
  assert.equal(computeDefaultDemand(generateImposition(8), 10000), 20000); // 产品可超需求上限，由选配接口再校验
  // 20 页分帖 M=2 → 5 张实体纸
  assert.equal(computeDefaultDemand(generateImposition(20, 2), 3), 15);
});

test('默认需求量：拼版非法或印量越界返回 null', () => {
  assert.equal(computeDefaultDemand(null, 1), null);
  assert.equal(computeDefaultDemand(generateImposition(8), 0), null);
  assert.equal(computeDefaultDemand(generateImposition(8), 10001), null);
  assert.equal(computeDefaultDemand(generateImposition(8), 1.5), null);
});

/* ---------- 入参校验 ---------- */

test('入参校验：合法输入通过并按编号升序排序原纸', () => {
  const spec = normalizeStockParams(
    baseParams({ papers: [
      { code: 'B', width: 200, height: 200, grain: 'vertical', stock: 0, price: 50 },
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 1000, price: MAX_UNIT_PRICE },
    ] })
  );
  assert.equal(spec.error, undefined);
  assert.deepEqual(spec.papers.map((p) => p.code), ['A', 'B']);
  assert.equal(spec.papers[1].stock, 0);
});

test('入参校验：需求量必须是 1~10000 的整数', () => {
  for (const demand of [0, -1, 10001, 1.5, '12', null]) {
    assert.match(normalizeStockParams(baseParams({ demand })).error, /需求量必须是/);
  }
});

test('入参校验：展开纸张宽高为正整数毫米', () => {
  for (const bad of [0, -100, 1.5, MAX_DIMENSION + 1, '100']) {
    assert.match(normalizeStockParams(baseParams({ sheetWidth: bad })).error, /展开纸张宽度/);
    assert.match(normalizeStockParams(baseParams({ sheetHeight: bad })).error, /展开纸张高度/);
  }
});

test('入参校验：折线与纸纹方向枚举', () => {
  assert.match(normalizeStockParams(baseParams({ foldDirection: 'x' })).error, /折线方向/);
  const p = baseParams();
  p.papers[0].grain = 'x';
  assert.match(normalizeStockParams(p).error, /纸纹方向/);
});

test('入参校验：修边量与刀缝非负', () => {
  assert.match(normalizeStockParams(baseParams({ trim: -1 })).error, /修边量/);
  assert.match(normalizeStockParams(baseParams({ kerf: -1 })).error, /刀缝/);
});

test('入参校验：原纸 1~6 种、编号唯一非空且无逗号', () => {
  assert.match(normalizeStockParams(baseParams({ papers: [] })).error, /原纸种类/);
  const seven = Array.from({ length: MAX_PAPER_KINDS + 1 }, (_, i) => ({
    code: `P${i}`, width: 200, height: 200, grain: 'horizontal', stock: 1, price: 10,
  }));
  assert.match(normalizeStockParams(baseParams({ papers: seven })).error, /原纸种类/);

  const dup = baseParams();
  dup.papers.push({ code: 'A', width: 200, height: 200, grain: 'horizontal', stock: 1, price: 10 });
  assert.match(normalizeStockParams(dup).error, /编号「A」重复/);

  const empty = baseParams();
  empty.papers[0].code = '  ';
  assert.match(normalizeStockParams(empty).error, /编号不能为空/);

  const comma = baseParams();
  comma.papers[0].code = 'A,B';
  assert.match(normalizeStockParams(comma).error, /编号不能包含/);
});

test('入参校验：原纸宽高 / 库存 / 单价范围', () => {
  const mk = (patch) => {
    const p = baseParams();
    Object.assign(p.papers[0], patch);
    return normalizeStockParams(p).error;
  };
  assert.match(mk({ width: 0 }), /原纸「A」宽度/);
  assert.match(mk({ width: MAX_DIMENSION + 1 }), /原纸「A」宽度/);
  assert.match(mk({ height: -5 }), /原纸「A」高度/);
  assert.match(mk({ stock: -1 }), /库存必须是/);
  assert.match(mk({ stock: MAX_STOCK + 1 }), /库存必须是/);
  assert.match(mk({ price: 0 }), /单价必须是/);
  assert.match(mk({ price: -10 }), /单价必须是/);
  assert.match(mk({ stock: 1.5 }), /库存必须是/);
});

/* ---------- 摆放枚举与出数 ---------- */

test('整行整列：扣除四边修边、计入相邻刀缝', () => {
  // n 个工件占 n×piece + (n−1)×kerf，可用宽 = 边长 − 2×trim
  assert.equal(fitCount(200, 100, 0), 2);
  assert.equal(fitCount(203, 100, 3), 2); // 206/103
  assert.equal(fitCount(203, 100, 4), 1); // 207/104
  assert.equal(fitCount(200, 100, 3), 1); // 203/103
  assert.equal(fitCount(0, 100, 0), 0);
  assert.equal(fitCount(-10, 100, 0), 0);
});

test('摆放枚举：两种正交摆放恰一种折线平行纸纹，按整行整列出数', () => {
  // 展开 100×100、折线横向；原纸 200×300、纸纹横向 → 0° 可用（2 列 × 3 行 = 6）
  const spec = normalizeStockParams(baseParams());
  const ev = evaluatePaper(spec.papers[0], spec);
  assert.equal(ev.layouts.length, 2);
  assert.deepEqual(ev.layouts.map((l) => l.rotation), ['0deg', '90deg']);
  assert.equal(ev.layouts[0].foldParallel, true); // 折线横向 ∥ 纸纹横向
  assert.equal(ev.layouts[0].columns, 2);
  assert.equal(ev.layouts[0].rows, 3);
  assert.equal(ev.layouts[0].perSheet, 6);
  assert.equal(ev.layouts[1].foldParallel, false); // 90° 后折线变竖向，纸纹仍横向
  assert.equal(ev.layouts[1].columns, 3);
  assert.equal(ev.layouts[1].rows, 2);
  assert.equal(ev.usableRotation, '0deg');
  assert.equal(ev.maxOut, 6);
  assert.equal(ev.fit, true);
});

test('摆放枚举：纸纹竖向且折线横向时，旋转 90° 摆放可用', () => {
  // 90°：展开宽沿竖直 → 水平向放展开高（100）3 列、竖直向放展开宽（100）2 行 = 6
  const spec = normalizeStockParams(baseParams({
    foldDirection: 'horizontal',
    papers: [{ code: 'A', width: 200, height: 300, grain: 'vertical', stock: 10, price: 100 }],
  }));
  const ev = evaluatePaper(spec.papers[0], spec);
  assert.equal(ev.layouts[0].foldParallel, false);
  assert.equal(ev.layouts[1].foldParallel, true);
  assert.equal(ev.usableRotation, '90deg');
  assert.equal(ev.maxOut, 6);
});

test('摆放枚举：折线竖向 + 纸纹横向时 90° 摆放的行列', () => {
  // 展开 420×297（宽×高）、折线竖向；原纸 880×1230、纸纹横向；trim=3 kerf=3
  const spec = normalizeStockParams(baseParams({
    demand: 1, sheetWidth: 420, sheetHeight: 297, foldDirection: 'vertical', trim: 3, kerf: 3,
    papers: [{ code: 'A', width: 880, height: 1230, grain: 'horizontal', stock: 10, price: 100 }],
  }));
  const ev = evaluatePaper(spec.papers[0], spec);
  assert.equal(ev.usableRotation, '90deg');
  const l = ev.layouts[1];
  // 90°：水平向原纸边长 1230 → 可用 1224，放展开高 297：floor(1227/300)=4 列
  assert.equal(l.columns, 4);
  // 竖直向原纸边长 880 → 可用 874，放展开宽 420：floor(877/423)=2 行
  assert.equal(l.rows, 2);
  assert.equal(ev.maxOut, 8);
});

test('摆放枚举：修边过大或原纸过小出数为 0', () => {
  const spec = normalizeStockParams(baseParams({
    trim: 60,
    papers: [{ code: 'A', width: 200, height: 200, grain: 'horizontal', stock: 10, price: 100 }],
  }));
  const ev = evaluatePaper(spec.papers[0], spec);
  assert.equal(ev.maxOut, 0);
  assert.equal(ev.fit, false);
});

/* ---------- 组合精确选取 ---------- */

test('选取：单纸种精确覆盖与必要超印', () => {
  const spec = normalizeStockParams(baseParams());
  const ev = spec.papers.map((p) => evaluatePaper(p, spec));
  assert.deepEqual(selectCombination(ev, 12), { q: [2], totalOutput: 12, totalPrice: 200 });
  assert.deepEqual(selectCombination(ev, 13), { q: [3], totalOutput: 18, totalPrice: 300 });
});

test('选取：库存为硬上限（不超库存并自动凑其它纸种）', () => {
  // A 出 6、库存 1、单价 100；B 出 6、库存 10、单价 101；需求 12 → A1+B1=201（B2=202 更贵）
  const spec = normalizeStockParams(baseParams({
    papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 1, price: 100 },
      { code: 'B', width: 300, height: 200, grain: 'horizontal', stock: 10, price: 101 },
    ],
  }));
  const ev = spec.papers.map((p) => evaluatePaper(p, spec));
  assert.deepEqual(selectCombination(ev, 12), { q: [1, 1], totalOutput: 12, totalPrice: 201 });
  // 需求 6：A1=100 比 B1=101 便宜
  assert.deepEqual(selectCombination(ev, 6), { q: [1, 0], totalOutput: 6, totalPrice: 100 });
});

test('选取：先最小化总价，再最小化超印张数', () => {
  // A 出 3 单价 100；B 出 5 单价 100；需求 6
  // A2=6 超印0、A1B1=8 超印2、B2=10 超印4，总价均 200 → 取超印最少 A2
  const spec = normalizeStockParams(baseParams({
    demand: 6,
    papers: [
      { code: 'A', width: 100, height: 300, grain: 'horizontal', stock: 10, price: 100 },
      { code: 'B', width: 100, height: 500, grain: 'horizontal', stock: 10, price: 100 },
    ],
  }));
  const ev = spec.papers.map((p) => evaluatePaper(p, spec));
  assert.equal(ev[0].maxOut, 3);
  assert.equal(ev[1].maxOut, 5);
  assert.deepEqual(selectCombination(ev, 6), { q: [2, 0], totalOutput: 6, totalPrice: 200 });
});

test('选取：总价与超印均并列时按编号升序用量序列取字典序最小者', () => {
  // A、B 均出 3、单价 100；需求 3：[1,0] 与 [0,1] 等价，字典序最小为 [0,1]
  const spec = normalizeStockParams(baseParams({
    demand: 3,
    papers: [
      { code: 'A', width: 100, height: 300, grain: 'horizontal', stock: 10, price: 100 },
      { code: 'B', width: 300, height: 100, grain: 'vertical', stock: 10, price: 100 },
    ],
  }));
  const ev = spec.papers.map((p) => evaluatePaper(p, spec));
  assert.equal(ev[0].maxOut, 3);
  assert.equal(ev[1].maxOut, 3);
  assert.deepEqual(selectCombination(ev, 3), { q: [0, 1], totalOutput: 3, totalPrice: 100 });
});

test('选取：低价纸种优先（不为字典序牺牲价格）', () => {
  // A 出 6 单价 100；B 出 4 单价 50；需求 12：B3=150 < A2=200
  const spec = normalizeStockParams(baseParams({
    papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 10, price: 100 },
      { code: 'B', width: 200, height: 200, grain: 'horizontal', stock: 10, price: 50 },
    ],
  }));
  const ev = spec.papers.map((p) => evaluatePaper(p, spec));
  assert.equal(ev[1].maxOut, 4);
  assert.deepEqual(selectCombination(ev, 12), { q: [0, 3], totalOutput: 12, totalPrice: 150 });
});

/* ---------- planStockCutting 端到端 ---------- */

test('选配：拼版结构非法返回 null；拼版有错拒绝', () => {
  assert.equal(planStockCutting(null, baseParams()), null);
  const bad = generateImposition(8);
  [bad.sheets[0].front.left, bad.sheets[1].front.left] = [
    bad.sheets[1].front.left,
    bad.sheets[0].front.left,
  ];
  const r = planStockCutting(bad, baseParams());
  assert.match(r.error, /当前拼版存在错误/);
  assert.ok(r.errors);
});

test('选配：非法入参拒绝计算', () => {
  const r = planStockCutting(generateImposition(8), baseParams({ demand: 0 }));
  assert.match(r.error, /需求量必须是/);
});

test('选配：可行方案给出摆放、出数、领用量、总价与超印量', () => {
  const imp = generateImposition(8); // 实体纸张 2
  const r = planStockCutting(imp, baseParams({ demand: 13 }));
  assert.equal(r.feasible, true);
  assert.equal(r.reason, null);
  assert.equal(r.entitySheets, 2);
  assert.equal(r.papers[0].usableRotation, '0deg');
  assert.equal(r.papers[0].maxOut, 6);
  assert.equal(r.papers[0].take, 3);
  assert.equal(r.papers[0].output, 18);
  assert.equal(r.papers[0].amount, 300);
  assert.deepEqual(r.selection, { totalTake: 3, totalOutput: 18, overrun: 5, totalPrice: 300 });
});

test('选配：库存不足无法覆盖需求时无解并说明原因', () => {
  const r = planStockCutting(
    generateImposition(8),
    baseParams({ demand: 100, papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 10, price: 100 },
    ] })
  ); // 总出数 60 < 100
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'insufficient_stock');
  assert.equal(r.selection, null);
});

test('选配：所有原纸尺寸不适配时无解并说明原因', () => {
  const r = planStockCutting(
    generateImposition(8),
    baseParams({ papers: [
      { code: 'A', width: 50, height: 50, grain: 'horizontal', stock: 100, price: 100 },
      { code: 'B', width: 80, height: 80, grain: 'vertical', stock: 100, price: 100 },
    ] })
  );
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'size_mismatch');
});

test('选配：能排下但零库存按库存不足处理', () => {
  const r = planStockCutting(
    generateImposition(8),
    baseParams({ papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 0, price: 100 },
    ] })
  );
  assert.equal(r.feasible, false);
  assert.equal(r.reason, 'insufficient_stock');
});

test('选配：未选用规格的领用量为 0', () => {
  const r = planStockCutting(
    generateImposition(8),
    baseParams({ papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 10, price: 100 },
      { code: 'B', width: 200, height: 200, grain: 'horizontal', stock: 10, price: 50 },
    ] })
  ); // 需求 12：B×3 最便宜
  assert.equal(r.feasible, true);
  assert.deepEqual(r.papers.map((p) => p.take), [0, 3]);
  assert.deepEqual(r.papers.map((p) => p.output), [0, 12]);
  assert.equal(r.selection.totalPrice, 150);
  assert.equal(r.selection.overrun, 0);
});

/* ---------- CSV ---------- */

test('选配 CSV：与屏幕同内容（参数 + 各规格 + 总价超印）', () => {
  const { csv, plan } = buildStockCsv(generateImposition(8), baseParams({ demand: 13 }));
  assert.equal(plan.feasible, true);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.deepEqual(lines, [
    '原纸开料选配,需求量（张）,13,实体纸张数（张）,2',
    '展开纸张（mm）,100×100,折线方向,横向',
    '修边量（mm）,0,刀缝（mm）,0',
    '编号,原纸宽（mm）,原纸高（mm）,纸纹方向,库存（张）,单价（分）,摆放,单张出数,领用量（张）,本规格出数,金额（分）',
    'A,200,300,横向,10,100,原样0°（折线∥纸纹，2列×3行）,6,3,18,300',
    '总价（分）,300,领用纸种（种）,1,总出数（张）,18,超印量（张）,5',
    '',
  ]);
});

test('选配 CSV：无解时注明库存不足或尺寸不适配，领用量列占位', () => {
  const r1 = buildStockCsv(
    generateImposition(8),
    baseParams({ demand: 100, papers: [
      { code: 'A', width: 200, height: 300, grain: 'horizontal', stock: 10, price: 100 },
    ] })
  );
  const lines1 = r1.csv.slice(1).split('\r\n');
  assert.equal(lines1[4], 'A,200,300,横向,10,100,原样0°（折线∥纸纹，2列×3行）,6,-,-,-');
  assert.match(lines1[5], /无可用方案/);
  assert.match(lines1[5], /库存不足/);

  const r2 = buildStockCsv(
    generateImposition(8),
    baseParams({ papers: [
      { code: 'A', width: 50, height: 50, grain: 'horizontal', stock: 10, price: 100 },
    ] })
  );
  const lines2 = r2.csv.slice(1).split('\r\n');
  assert.match(lines2[5], /尺寸不适配/);
});

test('选配 CSV：拼版有错或入参非法时拒绝', () => {
  assert.equal(buildStockCsv(null, baseParams()), null);
  const bad = generateImposition(8);
  bad.sheets[0].front.left = 3;
  assert.match(buildStockCsv(bad, baseParams()).error, /当前拼版存在错误/);
  assert.match(buildStockCsv(generateImposition(8), baseParams({ kerf: -1 })).error, /刀缝/);
});
