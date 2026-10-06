# R8 rules for the release build (app/build.gradle.kts). Libraries bring their own rules (kotlinx.serialization,
# Room, OkHttp, Firebase, AndroidX); only what they cannot know is here.

# Stack traces: keep file names and line numbers (retrace them with the build's mapping.txt).
-keepattributes SourceFile, LineNumberTable
-renamesourcefileattribute SourceFile

# AndroidMath (ui/MathRender.kt) draws with FreeType through JNI: libmain.so binds Java_com_pvporbit_freetype_* and
# builds Kerning, LibraryVersion and GlyphSlot$Advance objects by class name, so that package keeps its names.
-keep class com.pvporbit.freetype.** { *; }
