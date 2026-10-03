//! 会话字节编码（路线图⑩后半：GBK）。
//!
//! 边界原则：GBK 尾字节落在 ASCII 可打印区（如「中」= D6 D0，D0='0'），
//! 远端原始字节直接喂 vt 解析会腐蚀屏态——所以**解码必须在传输出口、
//! 进 screen.feed / 订阅广播之前**完成；发送方向在 channel.write 前编码。
//! 两处转换之后，core 内部与 UI 全程只见 UTF-8。

use encoding_rs::{CoderResult, Decoder, GBK};
use session_api::Charset;

/// UTF-8 文本 → 会话线上字节。Utf8 直通零拷贝；Gbk 走 encoding_rs
/// （不可映射字符按编码标准转为十进制 NCR——GBK 覆盖中文常用区，罕触发）。
pub fn encode(charset: Charset, text: &str) -> Vec<u8> {
    match charset {
        Charset::Utf8 => text.as_bytes().to_vec(),
        Charset::Gbk => {
            let (cow, _, _) = GBK.encode(text);
            cow.into_owned()
        }
    }
}

/// 流式解码器：多字节序列可跨 chunk 切开（「中」的首尾字节分两次到达），
/// Decoder 内部缓存半个序列，下一次 feed 拼回——不能每 chunk 新建解码器。
pub struct CharsetDecoder {
    inner: Option<Decoder>,
    /// 复用缓冲，避免每个 chunk 两次分配
    buf: String,
}

impl CharsetDecoder {
    pub fn new(charset: Charset) -> Self {
        Self {
            inner: match charset {
                Charset::Utf8 => None,
                Charset::Gbk => Some(GBK.new_decoder()),
            },
            buf: String::new(),
        }
    }

    /// 一块线上字节 → UTF-8 字节（喂 screen.feed / output_tx）。
    /// Utf8 直通；Gbk 非法序列按标准替换为 U+FFFD（不中断流）。
    pub fn feed(&mut self, data: &[u8]) -> Vec<u8> {
        let Some(dec) = self.inner.as_mut() else {
            return data.to_vec();
        };
        self.buf.clear();
        self.buf.reserve(data.len());
        // 循环喂：buf 满时 Decoder 返回 OutputFull，从已消费游标续喂
        // （last=false 保持流态，跨 chunk 的半个序列留在 Decoder 内部）
        let mut offset = 0;
        loop {
            let (res, read, _) = dec.decode_to_string(&data[offset..], &mut self.buf, false);
            offset += read;
            if res == CoderResult::OutputFull {
                self.buf.reserve(data.len().max(64));
                continue;
            }
            break;
        }
        self.buf.as_bytes().to_vec()
    }

    /// 通路关闭时冲刷悬空的半个序列（尾字节永远不到 → 补 U+FFFD）。
    pub fn flush(&mut self) -> Vec<u8> {
        let Some(dec) = self.inner.as_mut() else {
            return Vec::new();
        };
        // 容量须足以放下替换符（U+FFFD=3 字节）——零容量会让 decode 报 OutputFull 吞掉它
        let mut out = String::with_capacity(8);
        loop {
            let (res, _, _) = dec.decode_to_string(&[], &mut out, true);
            if res == CoderResult::OutputFull {
                out.reserve(64);
                continue;
            }
            break;
        }
        out.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_passthrough() {
        let mut d = CharsetDecoder::new(Charset::Utf8);
        assert_eq!(d.feed("hello 中文".as_bytes()), "hello 中文".as_bytes());
        assert_eq!(encode(Charset::Utf8, "abc"), b"abc");
    }

    #[test]
    fn gbk_decode_basic() {
        // 「中文」GBK = D6 D0 CE C4
        let mut d = CharsetDecoder::new(Charset::Gbk);
        assert_eq!(d.feed(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文".as_bytes());
    }

    #[test]
    fn gbk_split_multibyte_across_chunks() {
        // 跨 chunk 切开的双字节：先 D6，后 D0——必须拼回「中」而非两个替换符
        let mut d = CharsetDecoder::new(Charset::Gbk);
        assert_eq!(d.feed(&[0xD6]), b"");
        assert_eq!(d.feed(&[0xD0]), "中".as_bytes());
    }

    #[test]
    fn gbk_mixed_ascii() {
        // GBK 与 ASCII 混排：单字节区直通
        let mut d = CharsetDecoder::new(Charset::Gbk);
        let gbk_bytes = [b"ls -la ".as_slice(), &[0xC4, 0xE3, 0xBA, 0xC3]].concat(); // "ls -la 你好"
        assert_eq!(d.feed(&gbk_bytes), "ls -la 你好".as_bytes());
    }

    #[test]
    fn gbk_encode_roundtrip() {
        let bytes = encode(Charset::Gbk, "打包日志到 /tmp");
        let mut d = CharsetDecoder::new(Charset::Gbk);
        assert_eq!(d.feed(&bytes), "打包日志到 /tmp".as_bytes());
    }

    #[test]
    fn gbk_flush_dangling_lead() {
        let mut d = CharsetDecoder::new(Charset::Gbk);
        assert_eq!(d.feed(&[0xD6]), b"");
        // 尾字节永远不到：flush 补 U+FFFD，不静默吞掉
        assert_eq!(d.flush(), "\u{FFFD}".as_bytes());
    }
}
