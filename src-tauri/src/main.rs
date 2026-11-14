//! 桌面可执行入口：装配与命令全部在 lib（移动端复用同一份）。
// 发布构建不弹控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tinyssh_app_lib::run();
}
