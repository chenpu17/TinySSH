//! 输出脱敏（尽力而为）：记录含输出摘录，写盘前擦掉常见密钥形态。
//! 启发式永远可能漏——它是纵深防御的一层，不是权限边界；真正的边界仍是
//! 「记录整体加密落盘 + 只对有权限者解密」。

use regex::Regex;
use std::sync::OnceLock;

/// 命中即整段替换为 `[REDACTED:类别]`。
fn patterns() -> &'static Vec<(Regex, &'static str)> {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        vec![
            // PEM 私钥（含头尾整块）
            (
                r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
                "私钥块",
            ),
            // AWS AccessKeyId
            (r"\bAKIA[0-9A-Z]{16}\b", "AWS Key"),
            // GitHub token 系列
            (r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", "GitHub Token"),
            (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "GitHub Token"),
            // OpenAI / 通用 sk-
            (r"\bsk-[A-Za-z0-9_-]{20,}\b", "API Key"),
            // JWT（三段 base64url）
            (
                r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b",
                "JWT",
            ),
            // Bearer / Authorization 头
            (r"(?i)\b(authorization\s*:\s*)\S.*", "认证头"),
            (r"(?i)\bbearer\s+[A-Za-z0-9._-]{10,}", "Bearer Token"),
            // 键值形态：password/passwd/secret/token/api_key…
            (
                r"(?i)\b(pass(word|wd)?|secret|token|api[_-]?key|private[_-]?key)\b\s*[=:]\s*\S+",
                "凭据键值",
            ),
            // 连接串里的口令
            (
                r"(?i)\b(ssh|sshpass|mysql|postgres(ql)?|mongodb(\+srv)?)://[^\s:@/]+:[^\s@/]+@",
                "连接串凭据",
            ),
        ]
        .into_iter()
        .map(|(p, label): (&str, &str)| (Regex::new(p).expect("redact regex"), label))
        .collect()
    })
}

/// 输出摘录脱敏：命中形态替换为 `[REDACTED:类别]`。
pub fn scrub(text: &str) -> String {
    let mut out = text.to_string();
    for (re, label) in patterns() {
        out = re
            .replace_all(&out, format!("[REDACTED:{label}]"))
            .into_owned();
    }
    out
}

/// 摘录裁剪：先截断到 `cap` 字节（utf8 边界），再脱敏（脱敏后可能变短）。
pub fn excerpt(text: &str, cap: usize) -> String {
    if text.len() > cap {
        let cut = &text[..floor_char_boundary(text, cap)];
        scrub(&format!("{cut}…[截断]"))
    } else {
        scrub(text)
    }
}

fn floor_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut i = i;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_common_secret_shapes() {
        let s = "token=ghp_abcdefghijklmnopqrst1234\nAKIAIOSFODNN7EXAMPLE\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeK\npassword=hunter2";
        let out = scrub(s);
        assert!(!out.contains("ghp_"), "{out}");
        assert!(!out.contains("AKIA"), "{out}");
        assert!(!out.contains("hunter2"), "{out}");
        assert!(out.contains("[REDACTED:"));
    }

    #[test]
    fn pem_block_gone() {
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----\nnext line";
        let out = scrub(pem);
        assert!(!out.contains("PRIVATE KEY-----\nabc"), "{out}");
        assert!(out.contains("next line"), "块外内容保留：{out}");
    }

    #[test]
    fn excerpt_caps_and_keeps_utf8() {
        let s = "汉".repeat(5000);
        let out = excerpt(&s, 100);
        assert!(out.chars().count() < 200);
        assert!(out.contains("[截断]"));
        // 脱敏仍生效
        let secret = format!("token={}", "x".repeat(50));
        assert!(excerpt(&secret, 4096).contains("[REDACTED:"));
    }

    #[test]
    fn plain_text_untouched() {
        assert_eq!(
            scrub("total 4\ndrwxr-xr-x 2 root root"),
            "total 4\ndrwxr-xr-x 2 root root"
        );
    }
}
