//! 指标采样：远端主机/NPU 与 tinyssh-app 自身开销（CPU%/内存）。
//!
//! 从 main.rs 抽出（第二波结构拆分）。自身开销走平台原生只读计数，
//! 不经审批/审计；CPU% 差分是纯函数，测试随模块走。

use crate::{human, ApiState, CmdResult, WireError};
use tauri::State;

/// NPU 采样（监控面板轮）：Ascend npu-smi 原文数据源——与 read_host_metrics
/// 同款人类专属直连 Fresh 采样（脚本固定在核心侧，UI 不可注入命令；不经审批/
/// 审计，输出不回放终端）。无 npu-smi 的远端返回 NO_NPU，前端隐藏 NPU 区。
#[tauri::command]
pub(crate) async fn read_npu_metrics(state: ApiState<'_>, sid: String) -> CmdResult<String> {
    state
        .api
        .probe_npu_metrics(&human(), &sid)
        .await
        .map_err(WireError::from)
}

// ---- 自身开销监控（本轮）：tinyssh-app 进程级 CPU%/内存——kernel32 直读，零新依赖 ----

#[cfg(windows)]
mod self_proc {
    //! 最小 Win32 面：只取本进程 CPU 时间与内存计数，不经 windows crate。
    //! K32GetProcessMemoryInfo 在 kernel32（Win7+），随 MSVC 默认链接解析。
    #![allow(non_snake_case)]
    #[repr(C)]
    struct FileTime {
        lo: u32,
        hi: u32,
    }
    impl FileTime {
        fn as_u64(&self) -> u64 {
            ((self.hi as u64) << 32) | self.lo as u64
        }
    }
    #[repr(C)]
    struct ProcMemCountersEx {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
        PrivateUsage: usize, // EX 扩展：独占提交字节
    }
    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn GetProcessTimes(
            h: *mut core::ffi::c_void,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn K32GetProcessMemoryInfo(
            h: *mut core::ffi::c_void,
            out: *mut ProcMemCountersEx,
            cb: u32,
        ) -> i32;
    }

    /// 一次采样：（内核+用户 CPU 时间，100ns 累计），工作集字节，提交字节
    pub fn sample() -> (u64, u64, u64) {
        unsafe {
            let h = GetCurrentProcess();
            let (mut c, mut e, mut k, mut u) = (
                FileTime { lo: 0, hi: 0 },
                FileTime { lo: 0, hi: 0 },
                FileTime { lo: 0, hi: 0 },
                FileTime { lo: 0, hi: 0 },
            );
            let proc_time = if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
                k.as_u64().wrapping_add(u.as_u64())
            } else {
                0
            };
            let mut mc = ProcMemCountersEx {
                cb: std::mem::size_of::<ProcMemCountersEx>() as u32,
                PageFaultCount: 0,
                PeakWorkingSetSize: 0,
                WorkingSetSize: 0,
                QuotaPeakPagedPoolUsage: 0,
                QuotaPagedPoolUsage: 0,
                QuotaPeakNonPagedPoolUsage: 0,
                QuotaNonPagedPoolUsage: 0,
                PagefileUsage: 0,
                PeakPagefileUsage: 0,
                PrivateUsage: 0,
            };
            let (ws, commit) = if K32GetProcessMemoryInfo(h, &mut mc, mc.cb) != 0 {
                (mc.WorkingSetSize as u64, mc.PrivateUsage as u64)
            } else {
                (0, 0)
            };
            (proc_time, ws, commit)
        }
    }
}

/// CPU 差分基线：上次采样的进程 CPU 时间与墙钟锚点（单位随采样侧，见
/// read_self_metrics 的 ns 归一）；None=首样未立
#[derive(Default)]
pub(crate) struct SelfMeter(std::sync::Mutex<Option<(u64, std::time::Instant)>>);

/// macOS 自身开销采样（mac 自进程监控轮）：此前 `cfg(not(windows))` 直接给
/// `(0,0,0)`，前端只判 `cpuPct==null && wsMb==0` 才隐藏——首样后 cpuPct 变成
/// `Some(0.0)`，于是标题栏稳定显示「本机 CPU 0.0% / 0 MB」假读数（用户真机
/// 实锤）。这里填真值，让「不支持就隐藏」的分支只对真正的未知平台生效。
///
/// - CPU 时间：`getrusage(RUSAGE_SELF)` 的 utime+stime（timeval，μs 精度）。
///   **不用** `proc_pid_rusage` 的 ri_user_time/ri_system_time——macOS 实测
///   其单位是 ns 但精度只有 ~100ms（2s 忙等只报 48ms），差分出来常年偏低。
/// - 工作集：`proc_pid_rusage` v2 的 ri_resident_size（字节，RSS 等价；
///   与 `ps` 的 RSS 一致）。提交内存：ri_phys_footprint（物理足迹，mac 无
///   「提交」概念，语义最接近的诚实替代——注释与 UI 标题如实标注）。
#[cfg(target_os = "macos")]
mod self_proc {
    /// 一次采样：（CPU 时间累计，ns），工作集字节，物理足迹字节
    pub fn sample() -> (u64, u64, u64) {
        // SAFETY：getrusage/proc_pid_rusage 只读本进程结构；rusage 布局由 libc
        // 声明保证，rusage_info 按 Darwin v2 前缀读取（长度以 WORD 计 = 字节/4）。
        unsafe {
            let mut ru: libc::rusage = std::mem::zeroed();
            let cpu_ns = if libc::getrusage(libc::RUSAGE_SELF, &mut ru) == 0 {
                let us = |tv: libc::timeval| (tv.tv_sec as u64) * 1_000_000 + tv.tv_usec as u64;
                (us(ru.ru_utime) + us(ru.ru_stime)) * 1_000
            } else {
                0
            };
            // rusage_info_v2 由 libc 按 Darwin 布局声明（ri_uuid[16] 起头）；
            // 第三参是 `*mut rusage_info_t`（= *mut *mut c_void 的别名），
            // 直接传结构体指针的地址即可（C 侧按 flavor 决定读多少字节）。
            let mut buf: libc::rusage_info_v2 = std::mem::zeroed();
            let rc = libc::proc_pid_rusage(
                std::process::id() as libc::c_int,
                libc::RUSAGE_INFO_V2,
                (&mut buf as *mut libc::rusage_info_v2).cast(),
            );
            if rc != 0 {
                return (cpu_ns, 0, 0);
            }
            (cpu_ns, buf.ri_resident_size, buf.ri_phys_footprint)
        }
    }
}

/// 进程自身开销快照（过桥形状）
#[derive(serde::Serialize)]
pub(crate) struct SelfMetrics {
    /// 占全部逻辑核的百分比（任务管理器「进程 CPU」同口径）；null=首样基线未立
    /// **或本平台不支持采样**（前端据此整块隐藏——不再用 0.0% 冒充读数）
    cpu_pct: Option<f64>,
    /// 工作集 MB
    ws_mb: u64,
    /// 提交内存 MB（Windows=PrivateUsage；macOS=物理足迹 phys_footprint，
    /// 该平台无「提交」概念，取语义最近的可观测值）
    commit_mb: u64,
}

/// 纯函数（可单测）：CPU%=Δ进程时间 / (Δ墙钟×核数)。时间倒流/非法入参 → None。
/// 时间单位统一为 **ns**（Windows 100ns 计数在采样侧 ×100 折算；macOS 直接 ns，
/// 避免两平台在同一个差分公式里各带一个魔数）。
fn cpu_pct(cur: u64, prev: u64, wall_secs: f64, ncores: f64) -> Option<f64> {
    if wall_secs <= 0.0 || ncores <= 0.0 || cur < prev {
        return None;
    }
    Some((((cur - prev) as f64 / 1e9 / wall_secs / ncores) * 100.0).clamp(0.0, 100.0))
}

/// 自身开销采样（2s 轮询）：不经审计/审批（自进程只读计数，与
/// read_host_metrics 的直连通道同理——高频轮询不能刷审计流）。
/// async 化（稳定轮）：同步 command 跑主线程，2s 一拍的采样不该占主线程；
/// 带 State 的 async command 须返回 Result（tauri 规则），FE 侧序列化不变。
#[tauri::command]
pub(crate) async fn read_self_metrics(state: State<'_, SelfMeter>) -> CmdResult<SelfMetrics> {
    // 未知平台：None = 不支持，FE 整块隐藏（不产出 0 值假读数）
    #[cfg(windows)]
    let sampled = {
        let (proc_now_100ns, ws, commit) = self_proc::sample();
        Some((proc_now_100ns * 100, ws, commit))
    };
    #[cfg(target_os = "macos")]
    let sampled = {
        let (proc_now_ns, ws, commit) = self_proc::sample();
        Some((proc_now_ns, ws, commit))
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let sampled: Option<(u64, u64, u64)> = None;

    let Some((proc_now, ws, commit)) = sampled else {
        return Ok(SelfMetrics {
            cpu_pct: None,
            ws_mb: 0,
            commit_mb: 0,
        });
    };
    let ncores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    let mut prev = state.0.lock().unwrap();
    let cpu_pct = match prev.as_ref() {
        Some((p, at)) => cpu_pct(proc_now, *p, at.elapsed().as_secs_f64(), ncores),
        None => None,
    };
    *prev = Some((proc_now, std::time::Instant::now()));
    Ok(SelfMetrics {
        cpu_pct,
        ws_mb: ws / 1048576,
        commit_mb: commit / 1048576,
    })
}

/// 监控条采样（监控条轮）：FinalShell 式底部资源条数据源——人类专属只读
/// Fresh 采样（固定 /proc 脚本在核心侧，UI 不可注入命令；不经审批/审计，
/// 输出不回放终端）。非 Linux 远端输出不可解析，前端整条隐藏。
#[tauri::command]
pub(crate) async fn read_host_metrics(state: ApiState<'_>, sid: String) -> CmdResult<String> {
    state
        .api
        .probe_metrics(&human(), &sid)
        .await
        .map_err(WireError::from)
}

#[cfg(test)]
mod self_meter_tests {
    use super::cpu_pct;

    /// 自身开销轮：CPU% 差分数学——ns→秒、除核数、钳 [0,100]；
    /// 首样（wall=0）与时间倒流（cur<prev）返回 None。
    #[test]
    fn delta_math_and_edges() {
        // 单核满载 1s：进程时间增量 = 1e9 (ns)
        assert!(
            (cpu_pct(2 * 1_000_000_000, 1_000_000_000, 1.0, 1.0).unwrap() - 100.0).abs() < 1e-9
        );
        // 8 核机器上单核满载 1s → 12.5%
        assert!((cpu_pct(1_000_000_000, 0, 1.0, 8.0).unwrap() - 12.5).abs() < 1e-9);
        // 半个核的量
        assert!((cpu_pct(500_000_000, 0, 1.0, 1.0).unwrap() - 50.0).abs() < 1e-9);
        // 超界钳 100（采样间隙调度抖动可能算出 >100）
        assert_eq!(cpu_pct(u64::MAX, 0, 0.5, 1.0), Some(100.0));
        // 非法入参
        assert_eq!(cpu_pct(100, 0, 0.0, 8.0), None);
        assert_eq!(cpu_pct(100, 0, 1.0, 0.0), None);
        assert_eq!(cpu_pct(50, 100, 1.0, 8.0), None);
    }

    /// 真实 Win32 采样活体测试：本测试进程自身的计数应为正、CPU 时间单调——
    /// FFI 签名/结构体布局任何走样在这里直接炸出来（不依赖 UI 冒烟）。
    #[test]
    #[cfg(windows)]
    fn win32_sample_live() {
        // 平台实测（本 VM/Server 2022 记账仪表）：负载下进程 kernel+user 时间可
        // 连续数秒合法为 0（GetProcessTimes ok=1 且零值，记账粒度粗/滞后，随系统
        // 负载时有时无）——FFI 活体门不赌记账时机：内存计数（提交即非零）硬断言
        // 验证 ProcMemCountersEx 布局与调用成功，时间路径只验单调（含 0 恒真）；
        // CPU 差分数学由 delta_math_and_edges 纯函数门负责。签名/布局走样仍会在
        // 此炸出（ws/commit 归零或栈损坏）。
        let (t1, ws, commit) = super::self_proc::sample();
        assert!(ws > 0, "工作集应为正: {ws}");
        assert!(commit > 0, "提交内存应为正: {commit}");
        std::thread::sleep(std::time::Duration::from_millis(15));
        let (t2, _, _) = super::self_proc::sample();
        assert!(t2 >= t1, "进程 CPU 时间应单调不减: {t1} → {t2}");
    }

    /// 真实 macOS 采样活体测试（mac 自进程监控轮）：此前该平台恒返回
    /// (0,0,0)，标题栏永远 0.0% / 0 MB。FFI 签名/结构体布局走样在此炸出。
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_sample_live() {
        let (t1, ws, commit) = super::self_proc::sample();
        assert!(ws > 0, "RSS 应为正（proc_pid_rusage v2 布局走样？）: {ws}");
        assert!(commit > 0, "物理足迹应为正: {commit}");
        std::thread::sleep(std::time::Duration::from_millis(15));
        // 短睡 CPU 时间可能不变，但绝不允许倒流
        let (t2, _, _) = super::self_proc::sample();
        assert!(t2 >= t1, "进程 CPU 时间应单调不减: {t1} → {t2}");
    }
}
