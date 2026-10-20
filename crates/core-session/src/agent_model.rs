// 内置 Agent 的模型服务配置（Round 2 接真模型轮）：FE 设置卡录入的
// provider/base_url/model/api_key 以 JSON 密封入 vault KV（agent.model.v1）——
// api_key 与凭据同级敏感，**绝不落明文盘**；读取侧解封后只在内存交给
// agent-host 构造 provider。注意与 vault settings 表的明文 KV（UI 偏好用）
// 区分：本键走 seal_bytes/open_bytes 密封字节。
use crate::SessionManager;

pub const AGENT_MODEL_KV_KEY: &str = "agent.model.v1";

impl SessionManager {
    /// 写模型服务配置（整包 JSON 密封覆盖；调用方保证 JSON 里含 api_key）。
    pub fn set_agent_model(&self, cfg_json: &str) -> Result<(), session_api::Error> {
        let blob = self.center.vault.seal_bytes(cfg_json.as_bytes());
        let encoded = base64_hex(&blob);
        self.center
            .vault
            .set_setting(AGENT_MODEL_KV_KEY, &encoded)
            .map_err(|e| session_api::Error::Storage(e.to_string()))
    }

    /// 读模型服务配置（None = 从未配置）。损坏/解封失败如实给 None
    ///（设置卡会显示未配置，用户重录即自愈）。
    pub fn get_agent_model(&self) -> Result<Option<String>, session_api::Error> {
        let Some(encoded) = self
            .center
            .vault
            .get_setting(AGENT_MODEL_KV_KEY)
            .map_err(|e| session_api::Error::Storage(e.to_string()))?
        else {
            return Ok(None);
        };
        let Some(blob) = unhex(&encoded) else {
            return Ok(None);
        };
        match self.center.vault.open_bytes(&blob) {
            Ok(plain) => Ok(String::from_utf8(plain).ok()),
            Err(_) => Ok(None),
        }
    }

    /// 抹除模型服务配置（设置卡「清除」）。
    pub fn clear_agent_model(&self) -> Result<(), session_api::Error> {
        self.center
            .vault
            .set_setting(AGENT_MODEL_KV_KEY, "")
            .map_err(|e| session_api::Error::Storage(e.to_string()))
    }
}

fn base64_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{byte:02x}"));
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn mgr() -> Arc<SessionManager> {
        if std::env::var("TINYSSH_MASTER_KEY").is_err() {
            std::env::set_var("TINYSSH_MASTER_KEY", "07".repeat(32));
        }
        let dir = std::env::temp_dir().join(format!("agent-model-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        SessionManager::open(&dir.join("t.db")).unwrap()
    }

    #[test]
    fn agent_model_roundtrip_and_clear() {
        let m = mgr();
        assert!(m.get_agent_model().unwrap().is_none());
        m.set_agent_model(r#"{"provider":"openai","model":"glm-4.7","api_key":"sk-test"}"#)
            .unwrap();
        let got = m.get_agent_model().unwrap().unwrap();
        assert!(got.contains("sk-test"));
        // 密封落盘：settings 表里的原始值不含明文 key
        let raw = m
            .center
            .vault
            .get_setting(AGENT_MODEL_KV_KEY)
            .unwrap()
            .unwrap();
        assert!(!raw.contains("sk-test"), "密封后明文不得出现在 KV 值里");
        m.clear_agent_model().unwrap();
        assert!(m.get_agent_model().unwrap().is_none());
    }

    #[test]
    fn corrupted_blob_reads_as_none() {
        let m = mgr();
        m.center
            .vault
            .set_setting(AGENT_MODEL_KV_KEY, "zz-not-hex")
            .unwrap();
        assert!(m.get_agent_model().unwrap().is_none());
        m.center
            .vault
            .set_setting(AGENT_MODEL_KV_KEY, "00ff")
            .unwrap();
        assert!(
            m.get_agent_model().unwrap().is_none(),
            "解封失败如实给 None"
        );
    }
}
