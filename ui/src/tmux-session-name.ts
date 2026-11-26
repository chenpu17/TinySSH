/**
 * tmux 会话名的跨版本兼容口径：3.2–3.5 会把 `.`/`:` 清理成 `_`，后续版本
 * 对这两类字符的规则又有变化。应用统一沿用传统清理规则，让同一名称确定性可建。
 * 这里只规范化、不判定合法性；核心仍按原白名单校验，表单会预告实际名称。
 */
export function normalizeTmuxSessionName(name: string): string {
  return name.trim().replace(/[.:]/g, "_");
}
