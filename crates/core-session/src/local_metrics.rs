//! 本机整机指标快照（本机监控轮）：给 probe_metrics 的 local 分支提供与
//! METRICS_SCRIPT 同形状的 /proc 文本——前端 parseMetricsSample 零改动复用
//! （本地与远端都是终端，监控条/大屏同权）。Windows 走 kernel32/iphlpapi
//! 直读（沿 src-tauri self_proc 零新依赖先例）；unix 本机直读 /proc + 一次
//! df 子进程；其余平台返回空串（前端缺 cpu 行判「不可用」整条隐藏）。
//! 纯读无副作用；计数器单位只需自洽——CPU% 与网速都是相邻采样的差分比值。
//! 诚实边界：Windows 无 loadavg 概念，负载段省略（前端按 0 显示）；
//! GetIfEntry 的 In/OutOctets 是 32 位计数，溢出回绕时单次差分出 0（前端
//! max(0,…) 已兜住），与 FinalShell 同口径。

#[cfg(windows)]
mod ffi {
    #![allow(non_snake_case)]
    #[repr(C)]
    pub struct FILETIME {
        pub lo: u32,
        pub hi: u32,
    }
    impl FILETIME {
        pub fn zero() -> Self {
            FILETIME { lo: 0, hi: 0 }
        }
        pub fn as_u64(&self) -> u64 {
            ((self.hi as u64) << 32) | self.lo as u64
        }
    }
    /// GlobalMemoryStatusEx 的缓冲（dwLength 必须先填 sizeof）。
    #[repr(C)]
    pub struct MemoryStatusEx {
        pub dw_length: u32,
        pub dw_memory_load: u32,
        pub total_phys: u64,
        pub avail_phys: u64,
        pub total_pagefile: u64,
        pub avail_pagefile: u64,
        pub total_virtual: u64,
        pub avail_virtual: u64,
        pub avail_extended_virtual: u64,
    }
    /// MIB_IFROW（iphlpapi IF-entry，SDK 稳定布局）：**无 dwSize 头**——首字段
    /// 256 WCHAR 名，第二字段 dwIndex（调用方填接口号，IPv4 接口号 1 基），
    /// 之后一串 DWORD + 8+4 字节物理地址（尾 4 字节是对齐垫）+ 计数器区 +
    /// 256 字节描述。曾按错误记忆加了 dwSize 头、漏了 dwIndex——GetIfEntry
    /// 拿着偏移错位的「index」全查失败，静默全零。
    #[repr(C)]
    pub struct MibIfRow {
        pub name: [u16; 256],
        pub index: u32,
        pub if_type: u32,
        pub mtu: u32,
        pub speed: u32,
        pub phys_addr_len: u32,
        pub phys_addr: [u8; 12],
        pub admin_status: u32,
        pub oper_status: u32,
        pub last_change: u32,
        pub in_octets: u32,
        pub in_ucast_pkts: u32,
        pub in_nucast_pkts: u32,
        pub in_discards: u32,
        pub in_errors: u32,
        pub in_unknown_protos: u32,
        pub out_octets: u32,
        pub out_ucast_pkts: u32,
        pub out_nucast_pkts: u32,
        pub out_discards: u32,
        pub out_errors: u32,
        pub out_qlen: u32,
        pub descr_len: u32,
        pub descr: [u8; 256],
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetSystemTimes(
            idle: *mut FILETIME,
            kernel: *mut FILETIME,
            user: *mut FILETIME,
        ) -> i32;
        pub fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
        pub fn GetTickCount64() -> u64;
        pub fn GetDiskFreeSpaceExW(
            dir: *const u16,
            avail: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    #[link(name = "iphlpapi")]
    extern "system" {
        pub fn GetNumberOfInterfaces(pdwnum: *mut u32) -> u32;
        pub fn GetIfEntry(row: *mut MibIfRow) -> u32;
    }
}

/// 系统盘符（SystemRoot 所在卷，通常 C:\），带反斜杠结尾——
/// GetDiskFreeSpaceExW 与 df 形状的挂载点列共用。
#[cfg(windows)]
fn system_drive() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\WINDOWS".into());
    let mut d = root.chars().take(3).collect::<String>(); // "C:\"
    if d.len() < 3 || !d.ends_with('\\') {
        d = r"C:\".into();
    }
    d
}

#[cfg(windows)]
pub fn snapshot() -> String {
    use ffi::*;
    let mut out = String::new();

    // CPU：GetSystemTimes（100ns 计数）。kernel 段含 idle，system = kernel − idle；
    // 缩到 ms 单位——7 年内开机时长都在 f64 无损整数区（<2^53），
    // **绝不钳 u32**：idle 累计量轻松过 4.29e9 ms，钳了就饱和成假 100%。
    unsafe {
        let (mut idle, mut kernel, mut user) =
            (FILETIME::zero(), FILETIME::zero(), FILETIME::zero());
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
            let ms = |t: u64| t / 10_000;
            let idle_ms = ms(idle.as_u64());
            let kern_ms = ms(kernel.as_u64());
            out.push_str(&format!(
                "cpu  {} 0 {} {} 0 0 0 0\n",
                ms(user.as_u64()),
                kern_ms.saturating_sub(idle_ms),
                idle_ms
            ));
        }
    }

    // 内存：GlobalMemoryStatusEx → /proc/meminfo 的 kB 口径
    unsafe {
        let mut ms = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_pagefile: 0,
            avail_pagefile: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        if GlobalMemoryStatusEx(&mut ms) != 0 && ms.total_phys > 0 {
            out.push_str(&format!(
                "MemTotal:       {} kB\nMemAvailable:   {} kB\n",
                ms.total_phys / 1024,
                ms.avail_phys / 1024
            ));
        }
    }

    // 运行时长：GetTickCount64（开机毫秒）
    let up = unsafe { GetTickCount64() } / 1000;
    out.push_str(&format!("{up}.00 {up}.00\n"));

    // 网络：全部非环回、非停用网卡的 In/OutOctets 求和，吐单条合成 net/dev 行
    //（解析器逐行求和、跳 lo——单行 net0 同价）。rx 在第 0 列、tx 在第 8 列。
    let (rx, tx) = if_rows_octets();
    out.push_str(&format!("net0: {rx} 0 0 0 0 0 0 0 {tx} 0 0 0 0 0 0 0\n"));

    // 磁盘：系统盘用量 → ==DF== + df -kP 尾行形状
    let drive = system_drive();
    let mut wide: Vec<u16> = drive.encode_utf16().collect();
    wide.push(0);
    unsafe {
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        if GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) != 0 && total > 0 {
            let kb = |b: u64| b / 1024;
            let pct = ((total - free) * 100 / total).min(100);
            out.push_str("==DF==\n");
            // Filesystem blocks used avail %cap mount（解析器正则逐列匹配）
            out.push_str(&format!(
                "{}: {} {} {} {}% {}\n",
                drive.trim_end_matches('\\'),
                kb(total),
                kb(total - free),
                kb(free),
                pct,
                drive
            ));
        }
    }
    out
}

/// 遍历接口表，返回（in_octets 之和, out_octets 之和）。GetNumberOfInterfaces
/// 的 IPv4 接口号是 **1 基**（1..=n），GetIfEntry 前填 row.index；环回
///（type 24）不计。**不按 oper_status 过滤**：legacy GetIfEntry 在部分机器
///（本机 Server 20348 实测）对正常网卡也报 NON_OPERATIONAL(0)——真值在
/// 计数器里，过滤条件只会把数据全滤没。
#[cfg(windows)]
fn if_rows_octets() -> (u64, u64) {
    use ffi::*;
    unsafe {
        let mut n: u32 = 0;
        // iphlpapi 返回 DWORD 错误码：**0 = 成功**（不是 kernel32 的 BOOL 真值
        // 语义——曾写成 != 0 恰好在成功时跳过，网速恒 0）
        if GetNumberOfInterfaces(&mut n) != 0 || n == 0 {
            return (0, 0);
        }
        let (mut rx, mut tx) = (0u64, 0u64);
        for i in 1..=n {
            let mut row: MibIfRow = std::mem::zeroed();
            row.index = i;
            if GetIfEntry(&mut row) == 0 && row.if_type != 24 {
                rx += u64::from(row.in_octets);
                tx += u64::from(row.out_octets);
            }
        }
        (rx, tx)
    }
}

#[cfg(unix)]
pub fn snapshot() -> String {
    // unix 本机：/proc 就在本地，直读同款文件 + 一次 df；缺文件静默跳过
    //（macOS/BSD 缺 /proc → 无 cpu 行 → 前端整条隐藏，与远端口径一致）。
    let mut out = String::new();
    for f in [
        "/proc/stat",
        "/proc/meminfo",
        "/proc/uptime",
        "/proc/loadavg",
        "/proc/net/dev",
    ] {
        if let Ok(s) = std::fs::read_to_string(f) {
            out.push_str(&s);
            if !s.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out.push_str("==DF==\n");
    if let Ok(o) = std::process::Command::new("df").args(["-kP", "/"]).output() {
        if let Some(last) = String::from_utf8_lossy(&o.stdout).lines().last() {
            out.push_str(last);
            out.push('\n');
        }
    }
    out
}

#[cfg(not(any(windows, unix)))]
pub fn snapshot() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    #[test]
    fn snapshot_is_proc_shaped() {
        let s = super::snapshot();
        if s.is_empty() {
            return; // 不支持平台：空串=前端整条隐藏，契约即如此
        }
        assert!(s.contains("cpu "), "缺 cpu 行：{s:?}");
        assert!(s.contains("MemTotal:"), "缺 MemTotal：{s:?}");
        assert!(s.contains("==DF=="), "缺 DF 段：{s:?}");
        // cpu 行首 8 列可解析（前端 slice(1) 后取 8 列全为有限数才认）
        let cpu = s.lines().find(|l| l.starts_with("cpu ")).unwrap();
        let v: Vec<&str> = cpu.split_whitespace().skip(1).take(8).collect();
        assert_eq!(v.len(), 8, "cpu 行须 8 列：{cpu:?}");
        assert!(
            v.iter().all(|x| x.parse::<u64>().is_ok()),
            "cpu 列须非负整数：{cpu:?}"
        );
        // net 行：第 0 列 rx、第 8 列 tx（前端按位置取）
        let net = s
            .lines()
            .find(|l| l.starts_with("net0:"))
            .expect("缺 net0 行");
        let nums: Vec<u64> = net
            .split(':')
            .nth(1)
            .unwrap()
            .split_whitespace()
            .map(|x| x.parse().unwrap())
            .collect();
        assert!(nums.len() >= 9, "net 行须 ≥9 列：{net:?}");
    }
}
