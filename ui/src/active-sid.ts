// 重载续用：页面重载/活动重建后，前端要回到重载前的活动标签（App 启动时据 core 会话表
// 判定「是重载不是冷启动」后回到它；决定逻辑在 App 的自动开本地终端 effect 里）。
//
// 记在 localStorage 而不是 sessionStorage（KI-135）：Android 的活动重建会换一个全新
// WebView，sessionStorage 随旧 WebView 一起没了——显示大小/密度/导航方式变化、后台活动
// 被系统回收后切回都走这条路（旋转、深浅色、语言由 configChanges 兜住，不重建）。内核里
// 的 SSH 会话还连着，界面却回到欢迎页、胶囊写着「暂无会话」。
//
// 冷启动不会误吃上次运行的值：调用方只在「这个标签仍在 core 会话表里」时才回它，而会话
// 不跨进程重启——陈旧值永远对不上。这里只是一个随机会话 id，不涉机密。

const KEY = "ui.activeSid";

/** 启动时读一次：上一个页面的活动标签。没有、或存储不可用（隐私模式/配额）返回 null。 */
export function readActiveSid(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** 活动标签变化时调用。null = 用户回到了欢迎页，抹掉——在欢迎页上重载如实留在欢迎页。 */
export function persistActiveSid(sid: string | null): void {
  try {
    if (sid) localStorage.setItem(KEY, sid);
    else localStorage.removeItem(KEY);
  } catch { /* 记不住就退化成留在欢迎页，不影响使用 */ }
}
