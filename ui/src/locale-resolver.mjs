// 界面语解算（OS 语言默认轮）：纯函数零依赖——i18n.ts 引用（真实域首次启动 KV 无值
// 时定初始语言），spec 60 直连本文件做真值表断言（node spec 导不进 TS 源，故独立成 .mjs）。
// 规则（按序）：
//   ① 显式存储值（zh/en）最优先——用户在设置里选过就尊重，OS 变了也不翻；
//   ② OS 语言偏好列表按序匹配：zh* → zh、en* → en（列表顺序即优先级）；
//   ③ 有语言信息但都不支持（fr/de/…）→ en——两种支持语言里英语是次优通用语；
//   ④ 完全探测不到（老 WebView/异常环境）→ zh——历史缺省兜底。
// 仅真实域消费：demo 域固定 zh 缺省不跟 OS（套件确定性基座——harness 对每个上下文
// 固定 newContext({locale:"zh-CN"})，即便跟 OS 也不打穿中文断言；固定 zh 是 demo 域
// 与真实域行为隔离的既有约定）；真实域只落模块态+localStorage
// 即时缓存、不写 KV——用户在设置里显式选择前保持「跟随系统」语义（OS 变则界面跟着变）。
export function resolveInitialLocale(stored, osLangs) {
  if (stored === "en" || stored === "zh") return stored;
  let sawAny = false;
  for (const raw of osLangs ?? []) {
    const l = (raw ?? "").toLowerCase();
    if (!l) continue;
    sawAny = true;
    if (l.startsWith("zh")) return "zh";
    if (l.startsWith("en")) return "en";
  }
  return sawAny ? "en" : "zh";
}
