'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateImposition,
  parseReprintPages,
  planReprint,
  buildReprintProofHtml,
} = require('../src/imposition');

/** 取出第 n 个打样页（1 起）的 section 子串，顺序为正面、反面交替 */
function pageSection(html, n) {
  const parts = html.split('<section class="sheet-page">');
  assert.ok(parts[n], `只有 ${parts.length - 1} 个打样页，取不到第 ${n} 个`);
  return parts[n];
}

/** 打样页某一半版（left/right）内部 HTML：左半位于两个 half 之间，右半到折线为止 */
function halfContent(section, pos) {
  const start = section.indexOf(`class="half ${pos}"`);
  assert.notEqual(start, -1, `缺少 ${pos} 半版`);
  const rest = section.slice(start);
  const end = pos === 'left'
    ? rest.indexOf('class="half right"')
    : rest.indexOf('class="fold"');
  return rest.slice(0, end);
}

/* ---------- 页码输入解析 ---------- */

test('补印页码解析：逗号与连续区间（如 2,5-7）', () => {
  assert.deepEqual(parseReprintPages('2,5-7', 8), { pages: [2, 5, 6, 7] });
  assert.deepEqual(parseReprintPages('1', 8), { pages: [1] });
  assert.deepEqual(parseReprintPages('1-8', 8), { pages: [1, 2, 3, 4, 5, 6, 7, 8] });
});

test('补印页码解析：去重并升序排列', () => {
  assert.deepEqual(parseReprintPages('3,3,2-4,4', 8), { pages: [2, 3, 4] });
  assert.deepEqual(parseReprintPages('7,2,5', 8), { pages: [2, 5, 7] });
  assert.deepEqual(parseReprintPages('5-6,2-3', 8), { pages: [2, 3, 5, 6] });
});

test('补印页码解析：兼容全角符号与空白字符', () => {
  assert.deepEqual(parseReprintPages('2，5、7；8', 8), { pages: [2, 5, 7, 8] });
  assert.deepEqual(parseReprintPages(' 4 - 6 ', 8), { pages: [4, 5, 6] });
  assert.deepEqual(parseReprintPages('3~5', 8), { pages: [3, 4, 5] });
});

test('补印页码解析：非法输入说明原因', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.match(parseReprintPages(bad, 8).error, /请输入需补印的成品页码/);
  }
  assert.match(parseReprintPages('abc', 8).error, /无法识别的页码/);
  assert.match(parseReprintPages('1-2-3', 8).error, /无法识别的页码/);
  assert.match(parseReprintPages('2,', 8).error, /空项/);
  assert.match(parseReprintPages('7-5', 8).error, /起点大于终点/);
});

test('补印页码解析：页码范围校验（成品页，不含补齐的空白页位）', () => {
  assert.match(parseReprintPages('0', 8).error, /第 0 页超出成品页范围 1~8/);
  assert.match(parseReprintPages('9', 8).error, /第 9 页超出成品页范围 1~8/);
  // 6 页成品补齐至 8 页：第 7、8 页为空白页位，不属于成品页
  assert.match(parseReprintPages('7', 6).error, /第 7 页超出成品页范围 1~6/);
  assert.match(parseReprintPages('5-9', 8).error, /第 9 页超出成品页范围 1~8/);
});

/* ---------- 补印清单 ---------- */

test('补印清单：结构非法返回 null', () => {
  assert.equal(planReprint(null, '1'), null);
  assert.equal(planReprint({ pages: 3, totalPages: 8, sheets: [] }, '1'), null);
  assert.equal(buildReprintProofHtml(null, '1'), null);
});

test('补印清单：按版位反查纸张，同张纸命中多页只列一次', () => {
  // 8 页：第 1 张 正面[8,1]/反面[2,7]，第 2 张 正面[6,3]/反面[4,5]
  const plan = planReprint(generateImposition(8), '2,5-7');
  assert.deepEqual(plan.pages, [2, 5, 6, 7]);
  assert.equal(plan.sheetCount, 2);
  assert.deepEqual(plan.sheets[0], {
    sheet: 1,
    hitPages: [2, 7], // 同张纸命中两页只列一次，命中页升序
    front: { left: 8, right: 1 },
    back: { left: 2, right: 7 },
  });
  assert.deepEqual(plan.sheets[1], {
    sheet: 2,
    hitPages: [5, 6],
    front: { left: 6, right: 3 },
    back: { left: 4, right: 5 },
  });
  assert.ok(!('sig' in plan.sheets[0])); // 单帖模式不带帖号
});

test('补印清单：清单顺序按纸张排列，与输入顺序无关', () => {
  const plan = planReprint(generateImposition(8), '5,2');
  assert.deepEqual(plan.pages, [2, 5]);
  assert.deepEqual(
    plan.sheets.map((s) => [s.sheet, s.hitPages]),
    [[1, [2]], [2, [5]]]
  );
});

test('补印清单：跨帖按帖号及帖内纸张序排列', () => {
  // 20 页 M=2：第 1 帖 1~8（2 张）、第 2 帖 9~16（2 张）、第 3 帖 17~20（1 张）
  const plan = planReprint(generateImposition(20, 2), '18,2,10,13');
  assert.deepEqual(plan.pages, [2, 10, 13, 18]);
  assert.deepEqual(
    plan.sheets.map((s) => [s.sig, s.sheet, s.hitPages]),
    [
      [1, 1, [2]],
      [2, 1, [10]],
      [2, 2, [13]],
      [3, 1, [18]],
    ]
  );
  // 清单含该纸正反四个版位
  assert.deepEqual(plan.sheets[1].front, { left: 16, right: 9 });
  assert.deepEqual(plan.sheets[1].back, { left: 10, right: 15 });
  assert.deepEqual(plan.sheets[3].front, { left: 20, right: 17 });
  assert.deepEqual(plan.sheets[3].back, { left: 18, right: 19 });
});

test('补印清单：末帖空白页位不可作为补印页，命中纸含空白版位原样展示', () => {
  // 6 页：第 1 张 正面[空白,1]/反面[2,空白]
  const plan = planReprint(generateImposition(6), '1');
  assert.equal(plan.sheetCount, 1);
  assert.deepEqual(plan.sheets[0].front, { left: null, right: 1 });
  assert.deepEqual(plan.sheets[0].back, { left: 2, right: null });
  assert.match(planReprint(generateImposition(6), '7').error, /超出成品页范围 1~6/);
});

test('补印清单：拼版存在错误时说明原因并拒绝', () => {
  const imp = generateImposition(8);
  [imp.sheets[0].front.left, imp.sheets[1].front.left] = [
    imp.sheets[1].front.left,
    imp.sheets[0].front.left,
  ];
  const plan = planReprint(imp, '2');
  assert.match(plan.error, /当前拼版存在错误/);
  assert.ok(plan.errors); // 附带校验错误明细
  const proof = buildReprintProofHtml(imp, '2');
  assert.match(proof.error, /当前拼版存在错误/);
});

test('补印清单：页码输入无效时说明原因', () => {
  const imp = generateImposition(8);
  assert.match(planReprint(imp, '').error, /请输入需补印的成品页码/);
  assert.match(planReprint(imp, '9').error, /超出成品页范围 1~8/);
  assert.match(planReprint(imp, 'x').error, /无法识别的页码/);
});

test('补印清单：启用爬移时清单纸张带补偿量', () => {
  const plan = planReprint(generateImposition(8, null, { thickness: 0.1, cap: 2 }), '5');
  assert.equal(plan.sheetCount, 1);
  assert.equal(plan.sheets[0].sheet, 2);
  assert.equal(plan.sheets[0].creep, 0.2);
});

/* ---------- 补印打样 ---------- */

test('补印打样：仅含清单纸张，正反面成对保留', () => {
  const { html, plan } = buildReprintProofHtml(generateImposition(8), '1');
  assert.equal(plan.sheetCount, 1);
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 2); // 1 张纸 × 正反 2 页
  assert.match(html, /<title>补印打样 · 成品 8 页 · 补印第 1 页 · 共 1 张纸<\/title>/);
  assert.match(html, /第 1 张纸（共 2 张） · 补印命中：第 1 页 · 正面/);
  assert.match(html, /第 1 张纸（共 2 张） · 补印命中：第 1 页 · 反面（左右镜像）/);
  assert.doesNotMatch(html, /第 2 张纸/);
});

test('补印打样：沿用短边翻转镜像（背面页 左=反面右版、右=反面左版）', () => {
  // 8 页第 1 张：正面[8,1]，反面[2,7]；镜像后背面页 左 7 / 右 2
  const { html } = buildReprintProofHtml(generateImposition(8), '2');
  const back = pageSection(html, 2);
  assert.match(halfContent(back, 'left'), /page-num[^>]*>7</);
  assert.match(halfContent(back, 'right'), /page-num[^>]*>2</);
  assert.doesNotMatch(back, /rotate/);
});

test('补印打样：空白版位原样保留', () => {
  // 6 页第 1 张：正面[空白,1]
  const { html } = buildReprintProofHtml(generateImposition(6), '1');
  const front = pageSection(html, 1);
  assert.match(halfContent(front, 'left'), /blank-label">空白</);
  assert.match(halfContent(front, 'right'), /page-num[^>]*>1</);
});

test('补印打样：沿用爬移补偿参数（仅页码内容朝折线平移）', () => {
  // 8 页、纸厚 0.10、上限 2：第 2 张 c=0.20，正面[6,3]
  const { html } = buildReprintProofHtml(
    generateImposition(8, null, { thickness: 0.1, cap: 2 }),
    '5'
  );
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 2); // 仅第 2 张
  const front = pageSection(html, 1);
  assert.match(halfContent(front, 'left'), /page-num[^>]*translateX\(0\.20mm\)[^>]*>6</);
  assert.match(halfContent(front, 'right'), /page-num[^>]*translateX\(-0\.20mm\)[^>]*>3</);
  assert.match(front, /爬移补偿 0\.20 mm/);
});

test('补印打样：分帖仅输出命中帖的命中纸张，按帖号与帖内纸张序排列', () => {
  // 20 页 M=2：第 10 页在第 2 帖第 1 张，第 18 页在第 3 帖第 1 张
  const { html } = buildReprintProofHtml(generateImposition(20, 2), '10,18');
  assert.equal((html.match(/class="sheet-page"/g) || []).length, 4); // 2 张纸 × 正反 2 页
  const titles = [
    ...html.matchAll(/第 (\d) 帖 · 第 (\d) 张纸（帖内共 \d 张） · 补印命中：第 [\d、]+ 页 · (正面|反面（左右镜像）)/g),
  ].map((m) => `${m[1]}-${m[2]}-${m[3]}`);
  assert.deepEqual(titles, [
    '2-1-正面', '2-1-反面（左右镜像）',
    '3-1-正面', '3-1-反面（左右镜像）',
  ]);
  assert.doesNotMatch(html, /第 1 帖/);
  assert.match(html, /第 2 帖 · 第 1 张纸（帖内共 2 张）/); // 纸张标题保留原帖内纸张总数
});

test('补印打样：输入无效或拼版有错时返回错误（禁止下载）', () => {
  const imp = generateImposition(8);
  assert.match(buildReprintProofHtml(imp, '').error, /请输入需补印的成品页码/);
  assert.match(buildReprintProofHtml(imp, '9').error, /超出成品页范围 1~8/);

  imp.sheets[0].front.left = 3; // 制造重复页 / 缺页
  assert.match(buildReprintProofHtml(imp, '2').error, /当前拼版存在错误/);
});
