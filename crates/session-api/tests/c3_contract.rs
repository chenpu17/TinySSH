//! R44（§10.2）：C3「Shell 不可用时拒绝、禁止静默降级」的**旧客户端错误路径**契约。
//!
//! §10.2 明说这是「本轮设计中的语义收紧」，不能笼统宣称协议行为不变。收紧的对外表现
//! 只有一处：`exec` 在 shell 模式、无集成在场时**执行前拒绝**，替代旧行为里「静默
//! 走 Fresh 降级」。老客户端（不认识 shell_integration 的）必须能从错误里读出**为何**
//! 被拒，而不是拿到一个语焉不详的失败或（更糟）一个假的成功。
//!
//! 本测试锁住 `Error::wire_parts()` 这一**单点映射**（tauri `WireError::from` 与 MCP
//! 错误载荷共用，见 session-api 注释）：code 稳定、载荷区分「主机未启用」与「远端不
//! 支持」两种成因，二者**不可混淆**。它不依赖真实 sshd，故可在无网络环境下回归。

use session_api::{Error, ShellCapability};

/// 稳定 code：客户端按此分支；改名即破坏兼容，本测试即护栏。
#[test]
fn c3_wire_code_is_stable() {
    let e = Error::ShellIntegrationUnavailable {
        available: ShellCapability {
            integration_present: false,
            prompt_ready: false,
            host_setting: true,
        },
    };
    let (kind, detail) = e.wire_parts();
    assert_eq!(
        kind, "shell_integration_unavailable",
        "C3 收紧的对外 code 不得漂移"
    );
    assert!(detail.is_some(), "须带载荷说明成因，不能只有一句泛化失败");
}

/// 载荷如实、可区分两种成因——旧客户端据此给出不同指引：
///   host_setting=false → 主机设置里就没开（用户可自行开启）；
///   host_setting=true、integration_present=false → 主机开了但远端 shell 不支持。
#[test]
fn c3_payload_distinguishes_host_disabled_from_remote_unsupported() {
    let host_disabled = Error::ShellIntegrationUnavailable {
        available: ShellCapability {
            integration_present: false,
            prompt_ready: false,
            host_setting: false,
        },
    };
    let remote_unsupported = Error::ShellIntegrationUnavailable {
        available: ShellCapability {
            integration_present: false,
            prompt_ready: false,
            host_setting: true,
        },
    };

    let (_, d1) = host_disabled.wire_parts();
    let (_, d2) = remote_unsupported.wire_parts();
    let d1 = d1.unwrap();
    let d2 = d2.unwrap();

    assert_eq!(d1["available"]["host_setting"], serde_json::json!(false));
    assert_eq!(d2["available"]["host_setting"], serde_json::json!(true));
    assert_ne!(d1, d2, "两种成因的载荷必须不同，否则客户端无从区分");
    // 三个事实都在（integration_present / prompt_ready / host_setting）
    for k in ["integration_present", "prompt_ready", "host_setting"] {
        assert!(d2["available"].get(k).is_some(), "载荷缺事实字段 {k}：{d2}");
    }
}

/// 载荷可序列化往返（客户端跨进程/跨语言解析）。
#[test]
fn c3_payload_roundtrips() {
    let e = Error::ShellIntegrationUnavailable {
        available: ShellCapability {
            integration_present: false,
            prompt_ready: true,
            host_setting: true,
        },
    };
    let (kind, detail) = e.wire_parts();
    let wire = serde_json::json!({ "kind": kind, "detail": detail });
    let s = serde_json::to_string(&wire).unwrap();
    let back: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert_eq!(
        back["kind"],
        serde_json::json!("shell_integration_unavailable")
    );
    assert_eq!(
        back["detail"]["available"]["prompt_ready"],
        serde_json::json!(true)
    );
}
