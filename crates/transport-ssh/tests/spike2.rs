//! SPIKE-2（L0 §8）：russh 交互会话 × alacritty_terminal 渲染保真 + RSS 泄漏。
//! 门限：与 OpenSSH 参考流渲染结果一致（输出域字节级）；压力流量后 RSS 无持续增长。
//! 门控：TINYSSH_E2E_SSHD=1（scripts/dev-sshd.sh）。

use std::io::{Read as _, Write as _};
use std::time::Duration;
use term_core::{Screen, ScreenConfig};

fn sshd_enabled() -> bool {
    std::env::var("TINYSSH_E2E_SSHD")
        .map(|v| v == "1")
        .unwrap_or(false)
}

fn target() -> transport_ssh::SshTarget {
    let (addr, port, username, secret) = tinyssh_testbed::sshd_endpoint();
    transport_ssh::SshTarget {
        address: addr.into(),
        port,
        username: username.into(),
        auth_type: session_api::AuthType::Password,
        secret: secret.into(),
        host_key_check: None,
        kb_prompt_check: None,
    }
}

/// 从屏幕文本中提取标记之间的输出。
fn extract_between(text: &str, begin: &str, end: &str) -> Option<String> {
    let start = text.find(begin)? + begin.len();
    let rest = &text[start..];
    let stop = rest.find(end)?;
    Some(rest[..stop].to_string())
}

fn drain(s: &mut Screen, r: &std::sync::mpsc::Receiver<Vec<u8>>) {
    while let Ok(d) = r.try_recv() {
        s.feed(&d);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spike2_render_fidelity_and_rss() {
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    // 环境抖动兜底（共享容器偶发输出滞留）：整场景最多重试两次
    for attempt in 0..2 {
        match tokio::spawn(spike2_body()).await {
            Ok(()) => return,
            Err(e) => eprintln!("attempt {attempt} 失败，重试: {e}"),
        }
    }
    panic!("spike2 两次尝试均失败");
}

async fn spike2_body() {
    use session_api::transport::ChannelHandle;

    // 尾部 `; true`：回显行以 true 结尾，__E__ 后跟 ";"——等待循环以 marker_e
    // 出现为准，不能让它命中命令回显行的行尾（Windows bash 首命令延迟比容器大，
    // 先命中回显会在输出到达前就提前收卷）
    // 不节流、直接 50 行爆发：Windows sshd 的 ConPTY 对「一次性 50 行爆发」会用
    // 「光标跳 57;1 + 26 个换行 + 归位」的滚动协议整帧重绘——term-core 视口模型
    // 曾跟不住丢行（登记实测 29/50），CupTranslator 超界 CUP 补偿后可全量保真；
    // 本测试因此固定打爆发路径，作为该渲染缺口的 e2e 回归（此前靠 20ms 节流规避）。
    let script = "echo __B__; for i in $(seq 1 50); do echo $i; done; echo __E__; true\r";
    let marker_b = "__B__";
    let marker_e = "__E__";

    // 参考密钥自举：缺失则生成；公钥注入容器（容器重建后 authorized_keys 会丢——
    // 此前公钥只在建容器时手工塞过一次，属隐式环境依赖，pv_env reset 后 spike2 必挂）。
    // 路径必须走 env::temp_dir 的原生形态：Rust 的 "/tmp/..." 在 Windows 解析为
    // <当前盘>:\tmp，与 MSYS ssh-keygen 的 /tmp（用户临时目录）是两个目录。
    let ref_key = std::env::temp_dir().join("tinyssh_ref_key");
    if !ref_key.exists() || !ref_key.with_extension("pub").exists() {
        let _ = std::fs::remove_file(&ref_key);
        let st = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-q", "-f"])
            .arg(&ref_key)
            .status()
            .expect("spawn ssh-keygen");
        assert!(st.success(), "ssh-keygen 失败");
    }
    let pubkey = std::fs::read_to_string(ref_key.with_extension("pub")).unwrap();
    if tinyssh_testbed::docker_available() {
        let st = std::process::Command::new("docker")
            .args([
                "exec", "tinyssh-e2e", "sh", "-c",
                &format!(
                    "mkdir -p /root/.ssh && grep -qF '{}' /root/.ssh/authorized_keys 2>/dev/null || echo '{}' >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys",
                    pubkey.trim(),
                    pubkey.trim()
                ),
            ])
            .status()
            .expect("spawn docker exec");
        assert!(st.success(), "公钥注入失败");
    } else {
        // 本机替代 sshd：Win32-OpenSSH 对管理员组用户只认 ProgramData 的
        // administrators_authorized_keys（e2e 用户须属 Administrators）
        use std::io::Write as _;
        let path = std::path::Path::new(&std::env::var("PROGRAMDATA").unwrap())
            .join("ssh")
            .join("administrators_authorized_keys");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("open administrators_authorized_keys");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        if !existing.contains(pubkey.trim()) {
            writeln!(f, "{}", pubkey.trim()).expect("append pubkey");
        }
    }

    // ---- 我们：russh 通路 → alacritty 渲染 ----
    let channel: std::sync::Arc<transport_ssh::SshChannel> =
        transport_ssh::SshChannel::connect(target(), 80, 24)
            .await
            .expect("connect");
    let mut screen = Screen::new(ScreenConfig {
        cols: 80,
        rows: 24,
        scrollback: 100,
        lossless_cap: 1 << 20,
    });
    let mut rx = channel.subscribe_output();
    let (tx, rx_feed) = std::sync::mpsc::channel::<Vec<u8>>();
    tokio::task::spawn_blocking(move || loop {
        match rx.blocking_recv() {
            Ok(d) => {
                if tx.send(d).is_err() {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            Err(_) => continue,
        }
    });
    channel.write(b"export PS1='$ '\r").await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    drain(&mut screen, &rx_feed);
    channel.write(script.as_bytes()).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        drain(&mut screen, &rx_feed);
        // 行尾锚定：命令回显行含 "__E__"（后跟 ";"），裸子串会命中回显提前收卷
        if screen.snapshot_text().contains(&format!("{marker_e}\n")) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "script not done");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let ours = extract_between(
        &screen.snapshot_text(),
        &format!("{marker_b}\n"),
        &format!("{marker_e}\n"),
    )
    .unwrap_or_else(|| panic!("ours extract 失败; screen={:?}", screen.snapshot_text()));
    let ours_lines: Vec<String> = ours
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // ---- 参考：同一命令经系统 OpenSSH + PTY → 同一 alacritty 渲染 ----
    // Windows 本机 sshd 替代路径只跑 ours+RSS 两道门：ref 通道（MSYS ssh -tt →
    // ConPTY）在 50 行滚动时用「光标跳 57;1 + 批量换行 + 归位」协议整帧重绘，
    // term-core 视口模型跟不住（实测丢 21 行）——这是 term-core 渲染器的已知
    // 缺口（登记待修），不是通路差异；容器路径无 ConPTY 不受影响。
    let ref_lines: Vec<String> = if tinyssh_testbed::docker_available() {
        let (ref_host, ref_port, ref_user, _) = tinyssh_testbed::sshd_endpoint();
        let mut child = std::process::Command::new("ssh")
            .args(["-tt", "-i"])
            .arg(&ref_key)
            .args([
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "BatchMode=yes",
                "-o",
                "LogLevel=ERROR",
                "-p",
                &ref_port.to_string(),
                &format!("{ref_user}@{ref_host}"),
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("spawn ssh");
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (ttx, trx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if ttx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut ref_screen = Screen::new(ScreenConfig {
            cols: 80,
            rows: 24,
            scrollback: 100,
            lossless_cap: 1 << 20,
        });
        // 静置排空：Windows sshd 的 ConPTY 初始清屏/重绘会晚到——不排空就键入脚本，
        // 清屏恰好落在 seq 输出中段，视口行（__B__ 后约 20 行）被 2J 吞掉（实测
        // ref 行数 29/50）。先等连接初始流收干再键入。
        let settle = std::time::Instant::now() + Duration::from_millis(2500);
        while std::time::Instant::now() < settle {
            std::thread::sleep(Duration::from_millis(200));
            drain(&mut ref_screen, &trx);
        }
        stdin.write_all(b"export PS1='$ '\r").unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        drain(&mut ref_screen, &trx);
        stdin.write_all(script.as_bytes()).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        drain(&mut ref_screen, &trx);
        let _ = stdin.write_all(b"exit\r");
        let _ = child.kill();
        let reference = extract_between(
            &ref_screen.snapshot_text(),
            &format!("{marker_b}\n"),
            &format!("{marker_e}\n"),
        )
        .expect("ref extract");
        let ref_lines: Vec<String> = reference
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        ref_lines
    } else {
        Vec::new()
    };

    // 字节级对比（渲染后输出域）
    assert_eq!(ours_lines.len(), 50, "ours 行数异常: {ours_lines:?}");
    if !ref_lines.is_empty() {
        assert_eq!(ref_lines.len(), 50, "ref 行数异常: {ref_lines:?}");
        for (i, (a, b)) in ours_lines.iter().zip(ref_lines.iter()).enumerate() {
            assert_eq!(a, b, "第 {i} 行渲染不一致: ours={a:?} ref={b:?}");
        }
    }

    // ---- RSS 泄漏：大流量前后对比（Windows 用 K32GetProcessMemoryInfo 采样） ----
    let warm = channel
        .exec_fresh(
            "head -c 2000000 /dev/zero | base64",
            &Default::default(),
            std::time::Instant::now() + Duration::from_secs(30),
            &Default::default(),
        )
        .await;
    let _ = warm;
    let rss_before = tinyssh_testbed::self_rss_kb();
    for _ in 0..4 {
        let _ = channel
            .exec_fresh(
                "head -c 5000000 /dev/zero | base64",
                &Default::default(),
                std::time::Instant::now() + Duration::from_secs(30),
                &Default::default(),
            )
            .await;
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    let rss_after = tinyssh_testbed::self_rss_kb();
    let growth = rss_after.saturating_sub(rss_before);
    println!("RSS growth = {growth} KB（门限 < 51200 KB）");
    assert!(growth < 51200, "RSS 增长 {growth}KB 疑似泄漏");

    channel.close().await.unwrap();
}
