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

/// e2e sshd 连接参数 (host, port, username, password)。默认= docker 契约
/// root/testpass@127.0.0.1:2222（scripts/dev-sshd.sh）；本机替代 sshd
/// （无 docker 开发机，见 docs）用 TINYSSH_E2E_SSHD_ADDR/USER/PASS 覆盖
/// ——本机密码须过 Windows 密码策略，root/testpass 字面量装不进去。
pub fn sshd_endpoint() -> (String, u16, String, String) {
    let addr = std::env::var("TINYSSH_E2E_SSHD_ADDR").unwrap_or_else(|_| "127.0.0.1:2222".into());
    let (host, port) = match addr.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(2222)),
        None => (addr, 2222),
    };
    let username = std::env::var("TINYSSH_E2E_SSHD_USER").unwrap_or_else(|_| "root".into());
    let password = std::env::var("TINYSSH_E2E_SSHD_PASS").unwrap_or_else(|_| "testpass".into());
    (host, port, username, password)
}

/// docker 可用性：testbed 容器专用操作（容器内公钥注入、restart 旅程、PAM 安装）
/// 的门——无 docker 的开发机（本机 sshd 替代路径）这些步骤跳过或走本机等价物。
pub fn docker_available() -> bool {
    std::process::Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn net_svc(action: &str) {
    let svc = std::env::var("TINYSSH_E2E_LOCAL_SSHD_SERVICE").expect(
        "本机替代 sshd 的服务端断线/恢复需设 TINYSSH_E2E_LOCAL_SSHD_SERVICE（Windows 服务名）",
    );
    let st = std::process::Command::new("net")
        .args([action, &svc])
        .output()
        .expect("net");
    assert!(
        st.status.success(),
        "net {action} {svc} 失败: {}",
        String::from_utf8_lossy(&st.stderr)
    );
}

/// 服务端断线制造（journey2 重确认）：容器=docker restart；本机=net stop+start。
pub fn bounce_sshd() {
    if docker_available() {
        let st = std::process::Command::new("docker")
            .args(["restart", "tinyssh-e2e"])
            .output()
            .expect("docker restart");
        assert!(st.status.success(), "docker restart 失败");
    } else {
        net_svc("stop");
        net_svc("start");
    }
}

/// sshd 硬下线（journey3 死端）：容器=docker stop；本机=net stop。
pub fn sshd_down() {
    if docker_available() {
        let st = std::process::Command::new("docker")
            .args(["stop", "tinyssh-e2e"])
            .output()
            .expect("docker stop");
        assert!(st.status.success(), "docker stop 失败");
    } else {
        net_svc("stop");
    }
}

/// sshd 恢复（journey3 一键重连前；SshdStartGuard 收尾也会调用）：幂等尽力——
/// 已在运行时静默通过（drop 路径的兜底不得因「服务已在运行」而 panic）。
pub fn sshd_up() {
    if docker_available() {
        let _ = std::process::Command::new("docker")
            .args(["start", "tinyssh-e2e"])
            .output();
    } else if std::env::var("TINYSSH_E2E_LOCAL_SSHD_SERVICE").is_ok() {
        let svc = std::env::var("TINYSSH_E2E_LOCAL_SSHD_SERVICE").unwrap();
        let _ = std::process::Command::new("net")
            .args(["start", &svc])
            .output();
    }
}

/// 本机测试进程工作集（KB）——spike2 RSS 泄漏门的 Windows 采样（ps -o rss 的等价物；
/// K32GetProcessMemoryInfo 在 kernel32，Win7+ 随 MSVC 默认链接，不必加 windows crate）。
#[cfg(windows)]
pub fn self_rss_kb() -> u64 {
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }
    extern "system" {
        fn K32GetProcessMemoryInfo(
            process: *mut core::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
    }
    let mut pmc = ProcessMemoryCounters {
        cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
    };
    // 返回 0（失败）时如实报 0——RSS 门按增长量比较，基线与样本同为 0 不会误报泄漏
    unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut pmc,
            std::mem::size_of::<ProcessMemoryCounters>() as u32,
        );
    }
    (pmc.working_set_size / 1024) as u64
}

/// Unix 版：proc/ps 皆可，这里用 ps 同款字段（与既有测试写法一致）。
#[cfg(not(windows))]
pub fn self_rss_kb() -> u64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}
