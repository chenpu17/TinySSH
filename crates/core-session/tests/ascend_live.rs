//! Ascend 真机验证（#[ignore]：默认套件不跑、不连外部网络）。
//! 凭据走环境变量、**绝不写进仓库任何文件**。用法：
//!
//! ```text
//! TINYSSH_LIVE_ASCEND_ADDRESS=10.x.x.x \
//! TINYSSH_LIVE_ASCEND_PORT=22 \
//! TINYSSH_LIVE_ASCEND_USER=root \
//! TINYSSH_LIVE_ASCEND_PASSWORD=xxx \
//!   cargo test -p tinyssh-core-session --test ascend_live -- --ignored --nocapture
//! ```
//!
//! 验证面：probe_npu_metrics 直连通道在真 Ascend 服务器上的三个形状契约——
//! ①返回 ==NPU== 标记（npu-smi 在 PATH）；②表格正文非空；③全文打印供前端
//! npu.ts 解析器校准（各 CANN 版本表格列略有差异，解析在前端，此处只锁通道）。
//! 解析修正落在 ui/src/npu.ts + demo.ts 镜像，改完跑 ui specs 回归。

use core_session::SessionManager;
use session_api::*;
use std::sync::Arc;
use std::time::Duration;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

async fn manager() -> Arc<SessionManager> {
    if std::env::var("TINYSSH_MASTER_KEY").is_err() {
        std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
    }
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir);
    SessionManager::open(&db).unwrap()
}

fn human() -> Actor {
    Actor::Human
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需真实 Ascend 服务器凭据（env 门），默认套件不跑"]
async fn npu_probe_on_real_ascend_host() {
    let (address, user, password) = match (
        env("TINYSSH_LIVE_ASCEND_ADDRESS"),
        env("TINYSSH_LIVE_ASCEND_USER"),
        env("TINYSSH_LIVE_ASCEND_PASSWORD"),
    ) {
        (Some(a), Some(u), Some(p)) => (a, u, p),
        _ => {
            eprintln!("skip: 需 TINYSSH_LIVE_ASCEND_ADDRESS/USER/PASSWORD 三件齐全");
            return;
        }
    };
    let port: u16 = env("TINYSSH_LIVE_ASCEND_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(22);

    let m = manager().await;
    let hid = m
        .upsert_host(
            &human(),
            HostDraft {
                name: "ascend-live".into(),
                address,
                port: Some(port),
                username: user,
                auth: AuthDraft::Password { password },
                tags: vec![],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let m2 = m.clone();
    let hid_spawn = hid.clone();
    let t1 = tokio::spawn(async move {
        m2.create_session(&human(), CreateSessionReq { host_id: hid_spawn })
            .await
    });
    // TOFU 首连即信任（真机轮的信任语义由人工把关，此处自动化只管连上）
    for _ in 0..75 {
        let list = m.pending_host_keys(&human()).await.unwrap();
        if let Some(it) = list.into_iter().find(|it| it.host_id == hid) {
            m.decide_host_key(&human(), &it.id, true).await.unwrap();
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let sid = t1.await.unwrap().expect("connect to Ascend host");

    let npu = m
        .probe_npu_metrics(&human(), &sid)
        .await
        .expect("probe_npu_metrics over live Ascend host");
    println!("==== npu-smi 原文（供 npu.ts 校准） ====");
    println!("{}", npu);
    println!("==== 原文结束 ====");
    assert!(
        npu.contains("==NPU=="),
        "真机应有 npu-smi（无则该机不是 Ascend 管理节点）：{:?}",
        npu
    );
    let body = npu.split("==NPU==").nth(1).unwrap_or("");
    assert!(
        body.trim().len() > 20,
        "npu-smi 表格正文不应为空：{:?}",
        body
    );
    m.close_session(&human(), sid).await.unwrap();
}
