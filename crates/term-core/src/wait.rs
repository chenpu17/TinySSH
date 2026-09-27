//! Screen 公共返回类型（wait_output 等），与 session-api 解耦。

#[derive(Debug, Clone)]
pub struct ScreenWaitOk {
    pub text: String,
    pub matched: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenWaitErr {
    Timeout,
}
