// 106 重载续用的活动标签（KI-135）：页面重载而内核还在时，前端要回到重载前的活动标签。
// 它此前记在 sessionStorage——Android 的活动重建会换一个全新 WebView，sessionStorage 随
// 旧 WebView 一起没了：内核里的 SSH 会话还连着，界面却回到欢迎页、胶囊写着「暂无会话」。
//
// 「有在册会话就回到重载前的标签」这段判定只在 Tauri 下运行（浏览器 demo 没有内核会话
// 表），这里检验它依赖的两件事：
// ① 存取模块（直接 import）：模拟「换了 WebView」（清空 sessionStorage）与整页重载后仍
//    记得；回到欢迎页时抹掉；存储不可用时安全退化。
// ② 写入接线（demo 真页面）：进会话即记住活动标签，关掉会话回到欢迎页即抹掉。

const KEY = "ui.activeSid";

const connectLocal = async (page) => {
  const card = await page.$('.host-card:has(.host-name:text-is("本机"))');
  await card.hover();
  await page.waitForTimeout(200);
  await (await card.$('button[title^="连接"]')).click();
  await page.waitForTimeout(1300);
};

module.exports = {
  title: "重载续用：活动标签跨 WebView 重建仍在，回欢迎页即抹掉",
  async run({ page, ck }) {
    await page.evaluate((k) => localStorage.removeItem(k), KEY);

    // ── ① 存取模块 ──
    const keys = await page.evaluate(async () => Object.keys(await import("/src/active-sid.ts")).sort());
    ck.eq("存取模块导出读/写两个入口", keys.join(","), "persistActiveSid,readActiveSid");

    await page.evaluate(async () => (await import("/src/active-sid.ts")).persistActiveSid("s-resume-1"));
    const where = await page.evaluate((k) => ({ local: localStorage.getItem(k), session: sessionStorage.getItem(k) }), KEY);
    ck.eq("活动标签记在 localStorage", where.local, "s-resume-1");
    ck.eq("不再写 sessionStorage（它随旧 WebView 一起没）", where.session, null);

    // 活动重建 = 换了一个 WebView：同源页面的 sessionStorage 是空的
    const afterNewWebView = await page.evaluate(async () => {
      sessionStorage.clear();
      return (await import("/src/active-sid.ts")).readActiveSid();
    });
    ck.eq("模拟活动重建（sessionStorage 清空）后仍记得", afterNewWebView, "s-resume-1");

    await page.reload();
    await page.waitForFunction(() => !!document.querySelector(".app-shell"));
    const afterReload = await page.evaluate(async () => (await import("/src/active-sid.ts")).readActiveSid());
    ck.eq("整页重载后仍记得", afterReload, "s-resume-1");

    const degraded = await page.evaluate(async () => {
      const m = await import("/src/active-sid.ts");
      const proto = window.Storage.prototype;
      const orig = { get: proto.getItem, set: proto.setItem, del: proto.removeItem };
      let wrote = "没抛";
      let read;
      try {
        proto.getItem = () => { throw new Error("blocked"); };
        proto.setItem = () => { throw new Error("blocked"); };
        proto.removeItem = () => { throw new Error("blocked"); };
        read = m.readActiveSid();
        m.persistActiveSid("s-blocked");
        m.persistActiveSid(null);
      } catch (e) {
        wrote = "抛了：" + e;
      } finally {
        proto.getItem = orig.get; proto.setItem = orig.set; proto.removeItem = orig.del;
      }
      return { read: read === null ? "null" : String(read), wrote };
    });
    ck.eq("存储不可用时读取返回 null", degraded.read, "null");
    ck.eq("存储不可用时写入不抛异常", degraded.wrote, "没抛");

    // ── ② 写入接线 ──
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector(".app-shell"));
    await connectLocal(page);
    const sid = await page.evaluate(() => document.querySelector(".term-session.active")?.dataset.sid ?? null);
    ck.check("demo 里已进入一个会话", !!sid, String(sid));
    ck.eq("进会话即记住活动标签", await page.evaluate((k) => localStorage.getItem(k), KEY), sid);

    // 关掉当前会话：回到欢迎页（demo 初始态另有两个演示会话，数的是「少了一个」）
    const before = await page.evaluate(() => document.querySelectorAll(".tabbar .tab:not(.tab-add)").length);
    await page.click(".tab-active .tab-x");
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".confirm-dialog button")].find((x) => x.textContent.trim() === "关闭会话");
      if (b) b.click();
    });
    await page.waitForTimeout(900);
    const closed = await page.evaluate((k) => ({
      v: localStorage.getItem(k),
      active: document.querySelector(".term-session.active")?.dataset.sid ?? null,
      welcome: !!document.querySelector(".welcome-box") && document.querySelector(".welcome-box").getBoundingClientRect().height > 0,
      tabs: document.querySelectorAll(".tabbar .tab:not(.tab-add)").length,
    }), KEY);
    ck.check("关掉会话后回到欢迎页", closed.welcome && closed.active === null && closed.tabs === before - 1, JSON.stringify({ ...closed, before }));
    ck.eq("回到欢迎页：活动标签抹掉（欢迎页上重载如实留在欢迎页）", closed.v, null);
  },
};
