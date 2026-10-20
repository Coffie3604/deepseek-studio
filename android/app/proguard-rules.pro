# ---------------------------------------------------------------------------
# DeepSeek Studio — R8 / ProGuard rules (used only by release builds)
#
# The shell is tiny (MainActivity + DeviceBridge) and the whole app is a
# WebView, so the rules are mostly about *not* letting R8 break the reflection
# surface between Java and JavaScript.
# ---------------------------------------------------------------------------

# The activity is referenced from AndroidManifest.xml and the JS interface is
# called by name from JavaScript — both are invisible to static analysis.
-keep class com.coffie.deepseekstudio.MainActivity { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep the bridge class name: window.AndroidDevice is the injected name and
# the JS side calls methods by their Java name.
-keep class com.coffie.deepseekstudio.DeviceBridge { public *; }

# WebView provides these via reflection (addJavascriptInterface, callbacks).
-keepclassmembers class * extends android.webkit.WebViewClient { public *; }
-keepclassmembers class * extends android.webkit.WebChromeClient { public *; }
-keepclassmembers class * extends android.content.BroadcastReceiver { public *; }

# Keep enum names for the launcher result switch.
-keepclassmembers enum com.coffie.deepseekstudio.** {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# Strip logging from release builds (Log.d/Log.v only — keep warnings/errors).
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# Keep line numbers useful in the mapping file, drop the local variable table.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

-dontwarn android.webkit.**
