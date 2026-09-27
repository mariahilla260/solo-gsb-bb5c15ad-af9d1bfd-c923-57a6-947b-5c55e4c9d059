'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  validateImposition,
  comparePlateReuse,
} = require('../src/imposition');

/* ---------- 结构与校验门槛 ---------- */

test('复用比较：结构非法返回 null', () => {
  const imp = generateImposition(8);
  assert.equal(comparePlateReuse(null, imp), null);
  assert.equal(comparePlateReuse(imp, null), null);
  assert.equal(comparePlateReuse({ pages: 3, totalPages: 8, sheets: [] }, imp), null);
  assert.equal(comparePlateReuse(imp, { pages: 8, totalPages: 4, sheets: [] }), null);
});

test('复用比较：基线未通过服务端校验时拒绝核算', () => {
  const baseline = generateImposition(8);
  [baseline.sheets[0].front.left, baseline.sheets[1].front.left] = [
    baseline.sheets[1].front.left,
    baseline.sheets[0].front.left,
  ];
  const result = comparePlateReuse(baseline, generateImposition(8));
  assert.match(result.error, /基线拼版未通过服务端校验/);
  assert.ok(result.errors); // 附带校验错误明细
  assert.equal(result.faces, undefined);
});

test('复用比较：当前拼版未通过服务端校验时拒绝核算', () => {
  const current = generateImposition(8);
  current.sheets[0].front.left = 3; // 制造重复页 / 缺页
  const result = comparePlateReuse(generateImposition(8), current);
  assert.match(result.error, /当前拼版未通过服务端校验/);
  assert.ok(result.errors);
  assert.equal(result.faces, undefined);
});

/* ---------- 面匹配规则 ---------- */

test('复用比较：完全相同的拼版全部复用，无新制、无作废', () => {
  const result = comparePlateReuse(generateImposition(8), generateImposition(8));
  assert.deepEqual(result.summary, { reused: 4, new: 0, discarded: 0 });
  assert.deepEqual(result.faces, [
    { sheet: 1, side: 'front', left: 8, right: 1, status: 'reuse', source: { sheet: 1 } },
    { sheet: 1, side: 'back', left: 2, right: 7, status: 'reuse', source: { sheet: 1 } },
    { sheet: 2, side: 'front', left: 6, right: 3, status: 'reuse', source: { sheet: 2 } },
    { sheet: 2, side: 'back', left: 4, right: 5, status: 'reuse', source: { sheet: 2 } },
  ]);
  assert.ok(!('sig' in result.faces[0])); // 单帖模式不带帖号
  assert.ok(!('sig' in result.faces[0].source));
});

test('复用比较：跨帖号与纸张序号查找（单帖基线 → 分帖当前）', () => {
  // 基线 8 页单帖；当前 16 页分帖 M=2：第 1 帖与基线完全相同，第 2 帖全部新制
  const result = comparePlateReuse(generateImposition(8), generateImposition(16, 2));
  assert.deepEqual(result.summary, { reused: 4, new: 4, discarded: 0 });
  assert.equal(result.faces.length, 8);
  // 结果按当前帖与纸张顺序排列：第 1 帖 4 面复用（来源为基线第 1、2 张纸，无帖号）
  assert.deepEqual(
    result.faces.map((f) => [f.sig, f.sheet, f.side, f.status]),
    [
      [1, 1, 'front', 'reuse'],
      [1, 1, 'back', 'reuse'],
      [1, 2, 'front', 'reuse'],
      [1, 2, 'back', 'reuse'],
      [2, 1, 'front', 'new'],
      [2, 1, 'back', 'new'],
      [2, 2, 'front', 'new'],
      [2, 2, 'back', 'new'],
    ]
  );
  assert.deepEqual(result.faces[0].source, { sheet: 1 });
  assert.deepEqual(result.faces[2].source, { sheet: 2 });
  assert.equal(result.faces[4].source, undefined); // 新制面无来源
});

test('复用比较：分帖基线 → 单帖当前，复用来源带帖号并统计旧面作废', () => {
  // 基线 16 页分帖 M=2（2 帖 8 面）；当前 8 页单帖：4 面复用自第 1 帖，第 2 帖 4 面作废
  const result = comparePlateReuse(generateImposition(16, 2), generateImposition(8));
  assert.deepEqual(result.summary, { reused: 4, new: 0, discarded: 4 });
  assert.deepEqual(result.faces[0].source, { sig: 1, sheet: 1 });
  assert.deepEqual(result.faces[2].source, { sig: 1, sheet: 2 });
});

test('复用比较：正反面别必须相同（同纸正反对调仍通过校验，但不可复用）', () => {
  const current = generateImposition(8);
  // 第 1 张纸正反面内容对调：front[2,7] / back[8,1]，仍为合法拼版
  [current.sheets[0].front, current.sheets[0].back] = [
    current.sheets[0].back,
    current.sheets[0].front,
  ];
  assert.equal(validateImposition(current).valid, true);
  const result = comparePlateReuse(generateImposition(8), current);
  // 第 1 张纸两面因面别不符判新制，对应两个旧面作废；第 2 张纸复用
  assert.deepEqual(result.summary, { reused: 2, new: 2, discarded: 2 });
  assert.equal(result.faces[0].status, 'new');
  assert.equal(result.faces[1].status, 'new');
  assert.equal(result.faces[2].status, 'reuse');
  assert.equal(result.faces[3].status, 'reuse');
});

test('复用比较：左右页码与空白版位均相同才可复用', () => {
  // 基线 6 页（第 1 张含空白版位：front[空白,1] / back[2,空白]）；当前 8 页对应位置为实页
  const baseline = generateImposition(6);
  assert.equal(baseline.sheets[0].front.left, null);
  assert.equal(baseline.sheets[0].back.right, null);
  const result = comparePlateReuse(baseline, generateImposition(8));
  // 第 1 张纸两面空白变实页 → 新制；第 2 张纸两面相同 → 复用
  assert.deepEqual(result.summary, { reused: 2, new: 2, discarded: 2 });
  // 空白版位相同的拼版再次比较：全部复用
  const same = comparePlateReuse(baseline, generateImposition(6));
  assert.deepEqual(same.summary, { reused: 4, new: 0, discarded: 0 });
});

test('复用比较：该面实际爬移量相同才可复用', () => {
  const creep = { thickness: 0.1, cap: 2 }; // 第 1 张 0 mm，第 2 张 0.20 mm
  const baseline = generateImposition(8, null, creep);
  // 当前未启用爬移：仅第 1 张纸（爬移 0）两面可复用
  const result = comparePlateReuse(baseline, generateImposition(8));
  assert.deepEqual(result.summary, { reused: 2, new: 2, discarded: 2 });
  assert.equal(result.faces[0].status, 'reuse');
  assert.equal(result.faces[1].status, 'reuse');
  assert.equal(result.faces[2].status, 'new');
  assert.equal(result.faces[3].status, 'new');
  // 爬移参数一致：全部复用，且结果面带爬移量
  const same = comparePlateReuse(baseline, generateImposition(8, null, creep));
  assert.deepEqual(same.summary, { reused: 4, new: 0, discarded: 0 });
  assert.equal(same.faces[2].creep, 0.2);
  // 爬移上限不同（第 2 张补偿量不同）：第 2 张纸两面不可复用
  const other = comparePlateReuse(baseline, generateImposition(8, null, { thickness: 0.1, cap: 0.1 }));
  assert.deepEqual(other.summary, { reused: 2, new: 2, discarded: 2 });
});

test('复用比较：每个旧面最多匹配一个新面', () => {
  // 基线 8 页（4 面），当前 16 页分帖：基线第 1 张纸的正面只能复用一次，
  // 当前第 1 帖第 1 张纸正面占用后，其余相同内容的需求只能新制
  const baseline = generateImposition(8);
  const current = generateImposition(16, 2);
  const result = comparePlateReuse(baseline, current);
  assert.deepEqual(result.summary, { reused: 4, new: 4, discarded: 0 });
  // 基线 4 个旧面各被匹配一次后池空，当前第 2 帖全部新制
  const reusedSources = result.faces.filter((f) => f.status === 'reuse').map((f) => f.source.sheet);
  assert.deepEqual(reusedSources.sort(), [1, 1, 2, 2]); // 每张旧纸的正、反面各一次
});

test('复用比较：分帖结果按当前帖与纸张顺序排列并带帖号', () => {
  // 基线 20 页 M=2（3 帖），当前 20 页 M=2 相同：全部复用，来源跨帖对应
  const result = comparePlateReuse(generateImposition(20, 2), generateImposition(20, 2));
  assert.deepEqual(result.summary, { reused: 10, new: 0, discarded: 0 });
  assert.deepEqual(
    result.faces.map((f) => [f.sig, f.sheet]),
    [
      [1, 1], [1, 1], [1, 2], [1, 2],
      [2, 1], [2, 1], [2, 2], [2, 2],
      [3, 1], [3, 1],
    ]
  );
  assert.deepEqual(result.faces[8].source, { sig: 3, sheet: 1 });
});
