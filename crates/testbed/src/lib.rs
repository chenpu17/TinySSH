//! testbed: 测试支撑（进程内 sshd、共享 docker sshd 的跨进程测试锁）。

/// 跨进程互斥：共享 docker sshd 的测试（含 docker restart 的旅程 2）串行执行，
/// 避免并行测试互相杀连接造成 flake。
pub struct SshdLock(std::fs::File);

pub fn sshd_lock() -> SshdLock {
    use std::os::unix::io::AsRawFd;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open("/tmp/tinyssh-sshd.lock")
        .expect("open lock file");
    unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
    SshdLock(f)
}

/// 持锁后等待共享 sshd 就绪（TCP 可连）。journey2 会 docker restart 容器，
/// 紧随其后的持锁测试若立即连接会撞上重启窗口——这是并发回归中
/// "empty screen / script not done / cwd=null" 一类 flake 的根因。
/// 探测成功后再 settle 一小段，让 sshd 会话子系统完全可用。
pub async fn await_sshd_ready(timeout: std::time::Duration) {
    let addr = std::env::var("TINYSSH_E2E_SSHD_ADDR").unwrap_or_else(|_| "127.0.0.1:2222".into());
    let start = std::time::Instant::now();
    loop {
        if std::net::TcpStream::connect(&addr).is_ok() {
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
