# kotlinx.serialization (needed if minification is enabled later)
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class jp.chikuwachat.android.** { kotlinx.serialization.KSerializer serializer(...); }
