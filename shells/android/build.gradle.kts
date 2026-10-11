// 仰山课表 · 安卓壳
//
// 本工程**已编译验证过**（2026-10-10）：JDK 21 + Android SDK build-tools 36.0.0 +
// Gradle 8.11.1，`gradle assembleDebug` → BUILD SUCCESSFUL，APK 9,684,062 字节。
// 构建步骤、踩过的坑（含 `android.overridePathCheck`）见 shells/android/README.md。
// 与 Windows 壳的对应关系见 shells/README.md 里的对照表。

plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
