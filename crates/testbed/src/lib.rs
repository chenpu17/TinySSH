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
