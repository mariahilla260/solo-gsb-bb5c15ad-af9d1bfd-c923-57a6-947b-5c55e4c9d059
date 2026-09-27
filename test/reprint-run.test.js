'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  parseReprintQuotas,
  planReprintRun,
  buildReprintRunCsv,
} = require('../src/imposition');

/* ---------- 「页码:份数」输入解析 ---------- */

test('份数输入解析：基本格式（如 2:5,7:3）', () => {
  assert.deepEqual(parseReprintQuotas('2:5,7:3', 8), {
    items: [
      { page: 2, copies: 5 },
      { page: 7, copies: 3 },
    ],
  });
  assert.deepEqual(parseReprintQuotas('1:1', 8), { items: [{ page: 1, copies: 1 }] });
});

test('份数输入解析：按页码升序返回，与输入顺序无关', () => {
  assert.deepEqual(parseReprintQuotas('7:3,2:5', 8).items, [
    { page: 2, copies: 5 },
    { page: 7, copies: 3 },
  ]);
});

test('份数输入解析：兼容全角冒号、全角逗号与空白字符', () => {
  assert.deepEqual(parseReprintQuotas('2：5，7：3', 8).items, [
    { page: 2, copies: 5 },
    { page: 7, copies: 3 },
  ]);
  assert.deepEqual(parseReprintQuotas(' 2 : 5 , 7 : 3 ', 8).items, [
    { page: 2, copies: 5 },
    { page: 7, copies: 3 },
  ]);
});

test('份数输入解析：页码不可重复', () => {
  assert.match(parseReprintQuotas('2:5,2:3', 8).error, /第 2 页重复出现/);
  assert.match(parseReprintQuotas('2:5,7:3,2:5', 8).error, /第 2 页重复出现/);
});

test('份数输入解析：份数须为正整数', () => {
  assert.match(parseReprintQuotas('2:0', 8).error, /份数须为正整数/);
  assert.match(parseReprintQuotas('2:-1', 8).error, /份数须为正整数/);
  assert.match(parseReprintQuotas('2:1.5', 8).error, /份数须为正整数/);
  assert.match(parseReprintQuotas('2:', 8).error, /份数须为正整数/);
  assert.match(parseReprintQuotas('2:abc', 8).error, /份数须为正整数/);
});

test('份数输入解析：非法输入说明原因', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.match(parseReprintQuotas(bad, 8).error, /请输入需返工的页码与份数/);
  }
  assert.match(parseReprintQuotas('abc', 8).error, /无法识别的条目/);
  assert.match(parseReprintQuotas('2', 8).error, /无法识别的条目/);
  assert.match(parseReprintQuotas('2:5:3', 8).error, /无法识别的条目/);
  assert.match(parseReprintQuotas('2:5,', 8).error, /空项/);
});

test('份数输入解析：页码范围校验（成品页，不含补齐的空白页位）', () => {
  assert.match(parseReprintQuotas('0:2', 8).error, /第 0 页超出成品页范围 1~8/);
  assert.match(parseReprintQuotas('9:2', 8).error, /第 9 页超出成品页范围 1~8/);
  // 6 页成品补齐至 8 页：第 7、8 页为空白页位，不属于成品页
  assert.match(parseReprintQuotas('7:2', 6).error, /第 7 页超出成品页范围 1~6/);
});

/* ---------- 补印生产单 ---------- */

test('生产单：结构非法返回 null', () => {
  assert.equal(planReprintRun(null, '1:2'), null);
  assert.equal(planReprintRun({ pages: 3, totalPages: 8, sheets: [] }, '1:2'), null);
  assert.equal(buildReprintRunCsv(null, '1:2'), null);
});

test('生产单：同一纸张命中多页时实际补印份数取最大值，并列出每页需求与随印超出', () => {
  // 8 页：第 1 张 正面[8,1]/反面[2,7]，第 2 张 正面[6,3]/反面[4,5]
  const plan = planReprintRun(generateImposition(8), '2:5,7:3,5:2');
  assert.deepEqual(plan.items, [
    { page: 2, copies: 5 },
    { page: 5, copies: 2 },
    { page: 7, copies: 3 },
  ]);
  assert.equal(plan.sheetCount, 2);
  // 第 1 张命中第 2、7 页：实际补印 max(5,3)=5 份，第 7 页随印超出 2 份
  assert.deepEqual(plan.sheets[0], {
    sheet: 1,
    copies: 5,
    hits: [
      { page: 2, requested: 5, overrun: 0 },
      { page: 7, requested: 3, overrun: 2 },
    ],
  });
  // 第 2 张命中第 5 页：2 份，无超出
  assert.deepEqual(plan.sheets[1], {
    sheet: 2,
    copies: 2,
    hits: [{ page: 5, requested: 2, overrun: 0 }],
  });
  // 实体纸张总用量 = 5 + 2
  assert.equal(plan.totalCopies, 7);
  assert.ok(!('sig' in plan.sheets[0])); // 单帖模式不带帖号
});

test('生产单：同页多份与同纸多页取大者并存时的核算', () => {
  // 8 页：第 1 张命中第 1、2、7、8 页
  const plan = planReprintRun(generateImposition(8), '1:2,2:5,7:3,8:1');
  assert.equal(plan.sheetCount, 1);
  assert.equal(plan.sheets[0].copies, 5);
  assert.deepEqual(plan.sheets[0].hits, [
    { page: 1, requested: 2, overrun: 3 },
    { page: 2, requested: 5, overrun: 0 },
    { page: 7, requested: 3, overrun: 2 },
    { page: 8, requested: 1, overrun: 4 },
  ]);
  assert.equal(plan.totalCopies, 5);
});

test('生产单：跨帖按帖号及帖内纸张序排列并汇总总用量', () => {
  // 20 页 M=2：第 1 帖 1~8（2 张）、第 2 帖 9~16（2 张）、第 3 帖 17~20（1 张）
  const plan = planReprintRun(generateImposition(20, 2), '18:4,2:5,10:1,13:2');
  assert.deepEqual(plan.items, [
    { page: 2, copies: 5 },
    { page: 10, copies: 1 },
    { page: 13, copies: 2 },
    { page: 18, copies: 4 },
  ]);
  assert.deepEqual(
    plan.sheets.map((s) => [s.sig, s.sheet, s.copies]),
    [
      [1, 1, 5],
      [2, 1, 1],
      [2, 2, 2],
      [3, 1, 4],
    ]
  );
  assert.equal(plan.sheetCount, 4);
  assert.equal(plan.totalCopies, 12);
});

test('生产单：拼版存在错误时说明原因并拒绝', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[1].front.left] = [
    imp.sheets[1].front.left,
    imp.sheets[0].front.left,
  ];
  const plan = planReprintRun(imp, '2:5');
  assert.match(plan.error, /当前拼版存在错误/);
  assert.ok(plan.errors); // 附带校验错误明细
  const csv = buildReprintRunCsv(imp, '2:5');
  assert.match(csv.error, /当前拼版存在错误/);
});

test('生产单：输入无效时说明原因', () => {
  const imp = generateImposition(8);
  assert.match(planReprintRun(imp, '').error, /请输入需返工的页码与份数/);
  assert.match(planReprintRun(imp, '9:2').error, /超出成品页范围 1~8/);
  assert.match(planReprintRun(imp, '2:0').error, /份数须为正整数/);
  assert.match(planReprintRun(imp, '2:1,2:2').error, /重复出现/);
});

/* ---------- 生产单 CSV ---------- */

test('生产单 CSV：内容与生产单一致（汇总 + 每页明细）', () => {
  const { csv, plan } = buildReprintRunCsv(generateImposition(8), '2:5,7:3');
  assert.equal(plan.sheetCount, 1);
  assert.equal(plan.totalCopies, 5);
  assert.equal(csv.charCodeAt(0), 0xfeff); // 带 BOM，Excel 友好
  const lines = csv.slice(1).split('\r\n');
  assert.deepEqual(lines, [
    '补印生产单,成品 8 页',
    '返工页数,2,涉及纸张（种）,1,实体纸张总用量（份）,5',
    '帖内纸张序号,返工页码,页需求份数,本张实际补印份数,本页随印超出份数',
    '1,2,5,5,0',
    '1,7,3,5,2',
    '',
  ]);
});

test('生产单 CSV：分帖模式含帖号列，按帖号与帖内纸张序排列', () => {
  const { csv, plan } = buildReprintRunCsv(generateImposition(20, 2), '18:4,2:5,10:1');
  assert.equal(plan.sheetCount, 3);
  assert.equal(plan.totalCopies, 10);
  const lines = csv.slice(1).split('\r\n');
  assert.deepEqual(lines, [
    '补印生产单,成品 20 页,共 3 帖',
    '返工页数,3,涉及纸张（种）,3,实体纸张总用量（份）,10',
    '帖号,帖内纸张序号,返工页码,页需求份数,本张实际补印份数,本页随印超出份数',
    '1,1,2,5,5,0',
    '2,1,10,1,1,0',
    '3,1,18,4,4,0',
    '',
  ]);
});

test('生产单 CSV：输入无效或拼版有错时返回错误（禁止下载）', () => {
  const imp = generateImposition(8);
  assert.match(buildReprintRunCsv(imp, '').error, /请输入需返工的页码与份数/);
  assert.match(buildReprintRunCsv(imp, '2:0').error, /份数须为正整数/);

  imp.sheets[0].front.left = 3; // 制造重复页 / 缺页
  assert.match(buildReprintRunCsv(imp, '2:5').error, /当前拼版存在错误/);
});
