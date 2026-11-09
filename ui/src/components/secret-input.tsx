// 密码/口令输入的可视化开关（添加主机、快速连接、凭据表单共用）：默认隐藏，
// 切换只改 input type，不复制/回显明文到别处；按钮 type=button 不触发所在表单提交。
// 鼠标点按保持输入框焦点（mousedown preventDefault），方便继续输入。
import { forwardRef, useState } from "react";
import type { CSSProperties, InputHTMLAttributes } from "react";
import { t } from "../i18n";
import { IconEye, IconEyeOff } from "../icons";

type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** 包裹层样式（如所在 flex 行里需要 flex:1） */
  wrapStyle?: CSSProperties;
};

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput({ wrapStyle, ...rest }, ref) {
    const [shown, setShown] = useState(false);
    const label = shown ? t("隐藏内容") : t("显示内容");
    return (
      <span className="secret-input" style={wrapStyle}>
        <input {...rest} ref={ref} type={shown ? "text" : "password"} />
        <button type="button" className="ghost secret-toggle" aria-label={label} aria-pressed={shown}
          title={label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setShown((v) => !v); }}>
          {shown ? <IconEyeOff size={13} /> : <IconEye size={13} />}
        </button>
      </span>
    );
  },
);
