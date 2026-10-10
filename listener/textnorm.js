// =============================================
// textnorm.js — 转写后处理"洗一遍"
// AI 分析板块导入话术/字幕时的本地模糊匹配清洗。
//
// 原则：
// - 原始文本永远保留，本模块只输出派生结果，绝不改写原文；
// - 只纠识别档案 norm_terms 闭环词典里的词，不做开放式改写；
// - 每次替换留记录（from/to/index），可审计、可回滚。
//
// 当前实现：别名精确替换层（高精度）。
// 拼音模糊兜底：预留 washTextFuzzy() 接口，待引入 pinyin 依赖后再实现，
// 目前不做——宁可漏纠，不可错纠。
// =============================================

/**
 * @param {string} rawText ASR 原始文本
 * @param {Array<{correct:string, aliases:string[]}>} normTerms 档案词典
 * @returns {{ text:string, replacements:Array<{from:string,to:string,index:number}> }}
 */
function washText(rawText, normTerms) {
  if (!rawText || !Array.isArray(normTerms) || normTerms.length === 0) {
    return { text: rawText || "", replacements: [] };
  }
  let text = rawText;
  const replacements = [];
  for (const term of normTerms) {
    if (!term || !term.correct || !Array.isArray(term.aliases)) continue;
    for (const alias of term.aliases) {
      if (!alias || alias === term.correct) continue;
      let idx = text.indexOf(alias);
      while (idx !== -1) {
        replacements.push({ from: alias, to: term.correct, index: idx });
        idx = text.indexOf(alias, idx + alias.length);
      }
      if (text.includes(alias)) {
        text = text.split(alias).join(term.correct);
      }
    }
  }
  // 按出现位置排序，便于审计
  replacements.sort((a, b) => a.index - b.index);
  return { text, replacements };
}

// 预留：拼音模糊兜底（待 pinyin 依赖）
// function washTextFuzzy(rawText, normTerms, threshold) { ... }

module.exports = { washText };
