# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# 系统栏图标明暗（KI-060）与物理键盘探测：Rust 经 JNI 反射调用 MainActivity.
# setSystemBarsLight / hasHardwareKeyboard，类名/方法名只以字符串形式出现在
# Rust 侧，R8 无从得知引用——release 压缩会改名或裁掉，故显式保留
# （方法签名 (Z)V / ()Z）。
-keep class com.tinyssh.app.MainActivity {
    public static void setSystemBarsLight(boolean);
    public static boolean hasHardwareKeyboard();
}

# Android 保活（KI-059）：Rust 经 JNI 反射调用 KeepaliveBridge.setActive，类名/
# 方法名只以字符串形式出现在 Rust 侧，R8 无从得知引用——签名 (Context,boolean,
# int,int) 必须显式保留；KeepaliveService 由 manifest 按类名实例化，整体保留。
-keep class com.tinyssh.app.KeepaliveBridge {
    public static void setActive(android.content.Context, boolean, int, int);
}
-keep class com.tinyssh.app.KeepaliveService { *; }

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile