// locale-resolver.mjs 的类型声明（tsc 不读 .mjs 实现，bundler 解析按同名 .d.mts 配对）
export function resolveInitialLocale(
  stored: string | null | undefined,
  osLangs: readonly (string | undefined)[] | undefined | null,
): "zh" | "en";
