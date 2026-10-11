//! testbed: 测试支撑（进程内 sshd、共享 docker sshd 的跨进程测试锁）。

/// 跨进程互斥：共享 docker sshd 的测试（含 docker restart 的旅程 2）串行执行，
/// 避免并行测试互相杀连接造成 flake。
pub struct SshdLock(std::fs::File);

pub fn sshd_lock() -> SshdLock {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open("/tmp/tinyssh-sshd.lock")
            .expect("open lock file");
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
        SshdLock(f)
    }
    // Windows 实验性分支：锁文件放系统临时目录；std 阻塞锁语义与 flock 一致
    #[cfg(windows)]
    {
        let p = std::env::temp_dir().join("tinyssh-sshd.lock");
        let f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(p)
            .expect("open lock file");
        f.lock().expect("sshd lock");
        SshdLock(f)
    }
}

/// 持锁后等待共享 sshd 就绪。journey2 会 docker restart 容器，
/// 紧随其后的持锁测试若立即连接会撞上重启窗口——这是并发回归中
/// "empty screen / script not done / cwd=null" 一类 flake 的根因。
/// 只探 TCP 不够：docker start 会重跑容器 setup（apk 等需数秒），而 docker
/// 端口代理在容器内 sshd 真正监听前就接受 TCP（随后 reset）——journey3
/// "Connection reset by peer" 稳定失败的根因。因此探测必须读到 SSH banner。
pub async fn await_sshd_ready(timeout: std::time::Duration) {
    let addr = std::env::var("TINYSSH_E2E_SSHD_ADDR").unwrap_or_else(|_| "127.0.0.1:2222".into());
    let start = std::time::Instant::now();
    loop {
        if probe_banner(&addr) {
            // settle 一小段，让 sshd 会话子系统完全可用
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            return;
        }
        assert!(
            start.elapsed() < timeout,
            "共享 sshd {addr} 在 {timeout:?} 内未就绪"
        );
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// TCP 可连且 banner 以 "SSH-" 开头（读到 banner 即断开，sshd 仅记一条日志）。
fn probe_banner(addr: &str) -> bool {
    use std::io::Read;
    let Ok(mut stream) = std::net::TcpStream::connect(addr) else {
        return false;
    };
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .ok();
    let mut buf = [0u8; 8];
    match stream.read(&mut buf) {
        Ok(n) => n >= 4 && buf.starts_with(b"SSH-"),
        Err(_) => false,
    }
}
