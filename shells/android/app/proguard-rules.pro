# WebView 里的 @JavascriptInterface 方法名不能被混淆掉。
-keepclassmembers class dev.yangshan.schedule.ShellBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class dev.yangshan.schedule.SchoolActivity$SchoolJs {
    @android.webkit.JavascriptInterface <methods>;
}
