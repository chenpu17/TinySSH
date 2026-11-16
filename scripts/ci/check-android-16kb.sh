#!/usr/bin/env bash
# Android 16 KB 页对齐门（KI-057 的固化验收）。
#
# 用法：
#   check-android-16kb.sh <apk> [<apk> ...]
#   check-android-16kb.sh <path/to/lib*.so> [...]
#
# 断言：
#   1. 每个 64 位 ELF（arm64-v8a / x86_64）的 PT_LOAD 段 p_align == 0x4000。
#   2. APK 内这些 .so 条目必须 STORED（不压缩），且数据偏移 16384 对齐
#      （即 `zipalign -P 16` 保证的内容）。
#      32 位 ABI（armeabi-v7a / x86）不受 16 KB 要求约束，仅含 32 位的包跳过。
#
# readelf 选择顺序：$READELF > $NDK_HOME/llvm-readelf > $ANDROID_NDK_HOME/llvm-readelf
#                   > PATH 上的 llvm-readelf > PATH 上的 readelf。
# binutils 的 GNU readelf 完全够用（只解析 ELF 头）；GitHub ubuntu runner 预装，
# 因此本门不依赖 NDK。
set -euo pipefail

die() { echo "::error::16KB $*" >&2; exit 1; }

pick_readelf() {
  if [ -n "${READELF:-}" ]; then echo "$READELF"; return; fi
  local ndk
  for ndk in "${NDK_HOME:-}" "${ANDROID_NDK_HOME:-}"; do
    [ -n "$ndk" ] || continue
    local bin
    bin=$(ls "$ndk"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1 || true)
    [ -n "$bin" ] && { echo "$bin"; return; }
  done
  command -v llvm-readelf 2>/dev/null && return
  command -v readelf 2>/dev/null && return
  die "no readelf/llvm-readelf found (set READELF or NDK_HOME)"
}
READELF=$(pick_readelf) || exit 1
[ -n "$READELF" ] || die "no readelf/llvm-readelf found (set READELF or NDK_HOME)"

# zipalign 可选：Python 兜底自行检查 STORED + 16384 对齐偏移。
# 有 Android build-tools 的 zipalign 时优先用它（额外校验 APK 签名块/中央目录对齐）。
if [ -z "${ZIPALIGN:-}" ]; then
  for home in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}"; do
    [ -n "$home" ] || continue
    ZIPALIGN=$(ls -d "$home"/build-tools/*/zipalign 2>/dev/null | sort -V | tail -1 || true)
    [ -n "$ZIPALIGN" ] && break
  done
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL=0
CHECKED=0

check_elf() { # $1 = .so path, $2 = label
  local so="$1" label="$2"
  local out
  out=$("$READELF" -lW "$so" 2>/dev/null) || { echo "::error::16KB not an ELF: $label"; FAIL=1; return; }
  local line align
  local n=0 bad=0
  while IFS= read -r line; do
    n=$((n+1))
    align=$(awk '{print $NF}' <<<"$line")
    if [ "$align" != "0x4000" ]; then
      echo "::error::16KB $label LOAD[$n] Align=$align (expected 0x4000)"
      bad=1
    fi
  done < <(grep -E '^[[:space:]]*LOAD' <<<"$out")
  if [ "$n" -eq 0 ]; then echo "::error::16KB $label has no PT_LOAD"; FAIL=1; return; fi
  CHECKED=$((CHECKED + 1))
  if [ "$bad" -ne 0 ]; then FAIL=1; return; fi
  echo "ok  $label ($n PT_LOAD, all Align=0x4000)"
}

# Python 兜底：STORED 条目的数据偏移必须 16384 对齐。
check_zip_offsets() { # $1 = apk, $2.. = entry names
  local apk="$1"; shift
  python3 - "$apk" "$@" <<'PY'
import sys, zipfile
apk = sys.argv[1]
want = sys.argv[2:]
fail = 0
with zipfile.ZipFile(apk) as z:
    for name in want:
        info = z.getinfo(name)
        if info.compress_type != zipfile.ZIP_STORED:
            print(f"::error::16KB {name} is compressed (must be STORED)", file=sys.stderr); fail = 1; continue
        # local file header: 30 fixed bytes + name + extra
        hdr = info.header_offset
        with open(apk, 'rb') as f:
            f.seek(hdr)
            raw = f.read(30)
        name_len = int.from_bytes(raw[26:28], 'little')
        extra_len = int.from_bytes(raw[28:30], 'little')
        data_off = hdr + 30 + name_len + extra_len
        if data_off % 16384:
            print(f"::error::16KB {name} data offset {data_off} not 16384-aligned", file=sys.stderr); fail = 1
        else:
            print(f"ok  {name} stored, offset {data_off} % 16384 == 0")
sys.exit(fail)
PY
}

for f in "$@"; do
  [ -f "$f" ] || die "missing file: $f"
  case "$f" in
    *.apk)
      entries=$(unzip -Z1 "$f" | grep -E '^lib/(arm64-v8a|x86_64)/lib[^/]+\.so$' || true)
      if [ -z "$entries" ]; then
        # split-per-abi 的 armeabi-v7a/x86 包只有 32 位库：16 KB 要求只针对 64 位。
        if unzip -Z1 "$f" | grep -qE '^lib/(armeabi-v7a|x86)/lib[^/]+\.so$'; then
          echo "skip $(basename "$f") (32-bit ABI only; 16 KB not required)"
          continue
        fi
        die "$f contains no native lib (lib/*/lib*.so)"
      fi
      while IFS= read -r entry; do
        out="$TMP/$(echo "$entry" | tr '/' '_')"
        unzip -p "$f" "$entry" > "$out"
        check_elf "$out" "$(basename "$f")!$entry"
      done <<<"$entries"
      # 同一批条目的 zip 层 16 KB 对齐
      if [ -n "${ZIPALIGN:-}" ] && [ -x "${ZIPALIGN:-}" ]; then
        "$ZIPALIGN" -c -P 16 -v 4 "$f" > "$TMP/zipalign.log" 2>&1 || { tail -20 "$TMP/zipalign.log"; echo "::error::16KB zipalign -P 16 check failed for $f"; FAIL=1; }
        echo "ok  $(basename "$f") zipalign -c -P 16"
      else
        # shellcheck disable=SC2086 # entries are one-per-line, no spaces in APK paths
        if check_zip_offsets "$f" $entries; then :; else FAIL=1; fi
      fi
      ;;
    *) check_elf "$f" "$f" ;;
  esac
done

[ "$CHECKED" -gt 0 ] || die "nothing checked"
if [ "$FAIL" -ne 0 ]; then
  echo "16KB gate: FAILED" >&2
  exit 1
fi
echo "16KB gate: PASS ($CHECKED ELF file(s))"
