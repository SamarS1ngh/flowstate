# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# flowstate's own native modules + foreground service. They're registered
# explicitly (AudioMelPackage.createNativeModules) and reached from JS by name,
# so keep the classes and their @ReactMethod members intact under R8 shrinking.
-keep class com.flowstate.** { *; }

# React Native bridge surface -- keep native modules, packages, and any method
# annotated @ReactMethod so the JS<->native bridge still resolves after shrink.
-keep class * extends com.facebook.react.bridge.ReactContextBaseJavaModule { *; }
-keep class * extends com.facebook.react.ReactPackage { *; }
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod <methods>;
}
