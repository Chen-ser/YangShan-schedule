import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ── 签名 ────────────────────────────────────────────────────────────────────
// 已经装过旧版的手机只能升级不能覆盖安装：Android 要求新旧 APK 的签名证书相同，
// 否则报 INSTALL_FAILED_UPDATE_INCOMPATIBLE。而调试签名默认是「这台机器第一次构建时
// 随机生成一把」（ANDROID_USER_HOME/debug.keystore），换机器、换 ANDROID_USER_HOME
// 就换了一把钥匙 —— 同一份源码会打出装不上去的 APK。
//
// 所以这里允许把钥匙固定下来：在 local.properties（已在 gitignore 里）写
//     yangshan.keystore=D:\\某个不进仓库的目录\\yangshan-debug.keystore
// 就固定用它；没写或文件不在，就照旧回落到本机默认的调试签名（换台机器也能构建）。
//
// 钥匙本身永远不进仓库：这是分发用的签名身份，谁拿到它谁就能签一个「看起来是官方」的包。
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    // 用 Reader 按 UTF-8 读：Properties.load(InputStream) 会把非 ASCII 当 ISO-8859-1，
    // 路径里带中文目录（D:\ds工作区\…）就会被读成乱码。
    if (f.exists()) f.reader(Charsets.UTF_8).use { load(it) }
}
val sharedKeystore = localProps.getProperty("yangshan.keystore")
    ?.takeIf { it.isNotBlank() }
    ?.let { file(it) }
    ?.takeIf { it.exists() }

android {
    namespace = "dev.yangshan.schedule"
    compileSdk = 35

    signingConfigs {
        getByName("debug") {
            if (sharedKeystore != null) {
                storeFile = sharedKeystore
                storePassword = localProps.getProperty("yangshan.keystore.storePassword") ?: "android"
                keyAlias = localProps.getProperty("yangshan.keystore.keyAlias") ?: "androiddebugkey"
                keyPassword = localProps.getProperty("yangshan.keystore.keyPassword") ?: "android"
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // 本机 SDK 里只装了 build-tools 36.0.0（没有 35.0.0），显式指定免得 AGP
    // 去自动下载一个不存在的版本。build-tools 只要求不低于某个下限，用新的没问题。
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "dev.yangshan.schedule"
        // 26 = Android 8.0。选 26 是为了直接用 NotificationChannel 与 EncryptedSharedPreferences，
        // 不用为老系统写一堆分支；2026 年这个下限不会挡到任何在读的同学。
        minSdk = 26
        targetSdk = 35
        versionCode = 13
        versionName = "0.1.12"
        resourceConfigurations += listOf("zh", "en")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += setOf("META-INF/*.version", "DebugProbesKt.bin")
    }
}

dependencies {
    // WebViewAssetLoader：把内核托到 https://appassets.androidplatform.net/ 这个虚拟源上。
    // 用它而不是 file:// —— 虽然安卓的 file:// 有 localStorage，但 file:// 下
    // 同源策略会把每个文件都当成独立源，fetch/模块/存储行为都不正常。
    implementation("androidx.webkit:webkit:1.12.1")

    // 每小时后台刷新。用 WorkManager 而不是自己拿 AlarmManager 拼：
    // 省电策略、Doze、重启后恢复都由它管。
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // 账号密码存加密的 SharedPreferences（密钥在 Android Keystore 里）。
    implementation("androidx.security:security-crypto:1.0.0")

    implementation("androidx.core:core-ktx:1.13.1")
}
