fn main() {
    // 编译时间（关于卡「编译于 …」可溯源）：不写 rerun-if 指令 = 默认包内任一文件
    // 变更即重跑本脚本，时间戳跟着真实构建走、不会发霉。本地时区格式化。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_secs() as i64;
    let build_time = chrono::DateTime::from_timestamp(secs, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=TINYSSH_BUILD_TIME={build_time}");
    // updater 轮：签名公钥编译期注入（CI secrets TAURI_UPDATER_PUBKEY → 真公钥；
    // 本地/未配密钥 = 空串，运行期按占位符处理——updater_info.supported=false）。
    // 显式 rerun-if-env-changed：rust-cache 不感知任意 env，缺这条会吐出没带公钥的旧产物。
    println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBKEY");
    println!(
        "cargo:rustc-env=TAURI_UPDATER_PUBKEY={}",
        std::env::var("TAURI_UPDATER_PUBKEY").unwrap_or_default()
    );
    tauri_build::build()
}
