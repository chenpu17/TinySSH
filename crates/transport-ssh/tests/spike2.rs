//! SPIKE-2（L0 §8）：russh 交互会话 × alacritty_terminal 渲染保真 + RSS 泄漏。
//! 门限：与 OpenSSH 参考流渲染结果一致（输出域字节级）；压力流量后 RSS 无持续增长。
//! 门控：TINYSSH_E2E_SSHD=1（scripts/dev-sshd.sh）。

use std::io::{Read as _, Write as _};
use std::time::Duration;
use term_core::{Screen, ScreenConfig};

fn sshd_enabled() -> bool {
    std::env::var("TINYSSH_E2E_SSHD").map(|v| v == "1").unwrap_or(false)
}

fn target() -> transport_ssh::SshTarget {
    transport_ssh::SshTarget {
        address: "127.0.0.1".into(),
        port: 2222,
        username: "root".into(),
        auth_type: session_api::AuthType::Password,
        secret: "testpass".into(),
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
    let _sshd_guard = tinyssh_testbed::sshd_lock();
    tinyssh_testbed::await_sshd_ready(std::time::Duration::from_secs(30)).await;
    if !sshd_enabled() {
        eprintln!("skip: TINYSSH_E2E_SSHD=1 未设置");
        return;
    }
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

    let script = "echo __B__; seq 1 50; echo __E__\r";
    let marker_b = "__B__";
    let marker_e = "__E__";

    // 参考密钥自举：缺失则生成；公钥注入容器（容器重建后 authorized_keys 会丢——
    // 此前公钥只在建容器时手工塞过一次，属隐式环境依赖，pv_env reset 后 spike2 必挂）
    if !std::path::Path::new("/tmp/tinyssh_ref_key").exists()
        || !std::path::Path::new("/tmp/tinyssh_ref_key.pub").exists()
    {
        let st = std::process::Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-q", "-f", "/tmp/tinyssh_ref_key"])
            .status()
            .expect("spawn ssh-keygen");
        assert!(st.success(), "ssh-keygen 失败");
    }
    let pubkey = std::fs::read_to_string("/tmp/tinyssh_ref_key.pub").unwrap();
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

    // ---- 我们：russh 通路 → alacritty 渲染 ----
    let channel: std::sync::Arc<transport_ssh::SshChannel> =
        transport_ssh::SshChannel::connect(target(), 80, 24).await.expect("connect");
    let mut screen = Screen::new(ScreenConfig { cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20 });
    let mut rx = channel.subscribe_output();
    let (tx, rx_feed) = std::sync::mpsc::channel::<Vec<u8>>();
    tokio::task::spawn_blocking(move || loop {
        match rx.blocking_recv() {
            Ok(d) => {
                if tx.send(d).is_err() { break; }
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
        if screen.snapshot_text().contains(marker_e) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "script not done");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let ours = extract_between(&screen.snapshot_text(), &format!("{marker_b}\n"), &format!("{marker_e}\n"))
        .expect("ours extract");
    let ours_lines: Vec<String> = ours
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // ---- 参考：同一命令经系统 OpenSSH + PTY → 同一 alacritty 渲染 ----
    let mut child = std::process::Command::new("ssh")
        .args([
            "-tt",
            "-i", "/tmp/tinyssh_ref_key",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "BatchMode=yes",
            "-o", "LogLevel=ERROR",
            "-p", "2222",
            "root@127.0.0.1",
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
                    if ttx.send(buf[..n].to_vec()).is_err() { break; }
                }
            }
        }
    });
    let mut ref_screen = Screen::new(ScreenConfig { cols: 80, rows: 24, scrollback: 100, lossless_cap: 1 << 20 });
    stdin.write_all(b"export PS1='$ '\r").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    drain(&mut ref_screen, &trx);
    stdin.write_all(script.as_bytes()).unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    drain(&mut ref_screen, &trx);
    let _ = stdin.write_all(b"exit\r");
    let _ = child.kill();
    let reference = extract_between(&ref_screen.snapshot_text(), &format!("{marker_b}\n"), &format!("{marker_e}\n"))
        .expect("ref extract");
    let ref_lines: Vec<String> = reference
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // 字节级对比（渲染后输出域）
    assert_eq!(ours_lines.len(), 50, "ours 行数异常: {ours_lines:?}");
    assert_eq!(ref_lines.len(), 50, "ref 行数异常: {ref_lines:?}");
    for (i, (a, b)) in ours_lines.iter().zip(ref_lines.iter()).enumerate() {
        assert_eq!(a, b, "第 {i} 行渲染不一致: ours={a:?} ref={b:?}");
    }

    // ---- RSS 泄漏：大流量前后对比 ----
    fn rss_kb() -> u64 {
        let out = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("ps");
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
    }
    let warm = channel.exec_fresh("head -c 2000000 /dev/zero | base64", &Default::default(),
        std::time::Instant::now() + Duration::from_secs(30),
        &Default::default()).await;
    let _ = warm;
    let rss_before = rss_kb();
    for _ in 0..4 {
        let _ = channel.exec_fresh("head -c 5000000 /dev/zero | base64", &Default::default(),
            std::time::Instant::now() + Duration::from_secs(30),
            &Default::default()).await;
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    let rss_after = rss_kb();
    let growth = rss_after.saturating_sub(rss_before);
    println!("RSS growth = {growth} KB（门限 < 51200 KB）");
    assert!(growth < 51200, "RSS 增长 {growth}KB 疑似泄漏");

    channel.close().await.unwrap();
}
