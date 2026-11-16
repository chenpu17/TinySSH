import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// release 签名材料：环境变量（CI）优先，其次 key.properties（本地，已被 .gitignore）。
// key.properties 放在 src-tauri/gen/android/（Gradle rootProject 目录），格式：
//   storeFile=/abs/or/relative/path/to/tinyssh-release.jks
//   storePassword=****
//   keyAlias=tinyssh
//   keyPassword=****
// Windows 路径注意：.properties 里 \ 是转义符，写 C:/keys/x.jks 或 C:\\keys\\x.jks。
val signingProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) {
        f.inputStream().use { load(it) }
    }
}

fun signingValue(env: String, prop: String): String? =
    System.getenv(env)?.takeIf { it.isNotBlank() }
        ?: signingProps.getProperty(prop)?.takeIf { it.isNotBlank() }

val releaseStore = signingValue("TINYSSH_ANDROID_KEYSTORE", "storeFile")
val releaseStorePass = signingValue("TINYSSH_ANDROID_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAlias = signingValue("TINYSSH_ANDROID_KEY_ALIAS", "keyAlias")
val releaseKeyPass = signingValue("TINYSSH_ANDROID_KEY_PASSWORD", "keyPassword")

android {
    compileSdk = 36
    namespace = "com.tinyssh.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.tinyssh.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // release 签名：四项材料齐全才创建 signingConfig；缺任一项则不建，Gradle 会产
    // app-universal-release-unsigned.apk（装不上），CI 的 apksigner 断言负责报红。
    // 绝不回退 debug 证书——否则会静默产出 debug 签名的 release 包，日后无法用正式
    // 签名覆盖升级。
    signingConfigs {
        // 在 lambda 内取局部值，确保下面 create 里是明确的非空类型。
        val store = releaseStore
        val storePass = releaseStorePass
        val alias = releaseKeyAlias
        val keyPass = releaseKeyPass
        if (store != null && storePass != null && alias != null && keyPass != null) {
            create("release") {
                storeFile = rootProject.file(store)
                storePassword = storePass
                keyAlias = alias
                keyPassword = keyPass
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // 没有签名材料就保持 unsigned（见上），不借 debug 证书。
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")