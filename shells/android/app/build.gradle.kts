plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.yangshan.schedule"
    compileSdk = 35

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
        versionCode = 10
        versionName = "0.1.9"
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
