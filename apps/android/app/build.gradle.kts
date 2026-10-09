import java.util.Properties
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// Firebase (FCM, M7): the Google services plugin needs app/google-services.json from the Firebase
// console. Without the file the app still builds; push registration is skipped at runtime.
if (file("google-services.json").exists()) {
    apply(plugin = libs.plugins.google.services.get().pluginId)
}

// Release signing (docs/STORE_RELEASE.md): the Play upload key, kept outside the repository. Read from
// ~/.config/taylis/android-release.properties (TAYLIS_ANDROID_SIGNING overrides the path) with the keys
// storeFile / storePassword / keyAlias / keyPassword, or from the environment variables
// TAYLIS_ANDROID_STORE_FILE / TAYLIS_ANDROID_STORE_PASSWORD / TAYLIS_ANDROID_KEY_ALIAS / TAYLIS_ANDROID_KEY_PASSWORD
// (which win). Without them a release build is unsigned; debug builds never need them.
val releaseSigning: Map<String, String>? = run {
    val path = System.getenv("TAYLIS_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.config/taylis/android-release.properties"
    val props = Properties()
    val file = File(path)
    if (file.isFile) file.inputStream().use { props.load(it) }
    fun value(key: String, env: String): String? =
        System.getenv(env)?.takeIf { it.isNotEmpty() } ?: props.getProperty(key)?.trim()?.takeIf { it.isNotEmpty() }
    val values = mapOf(
        "storeFile" to value("storeFile", "TAYLIS_ANDROID_STORE_FILE"),
        "storePassword" to value("storePassword", "TAYLIS_ANDROID_STORE_PASSWORD"),
        "keyAlias" to value("keyAlias", "TAYLIS_ANDROID_KEY_ALIAS"),
        "keyPassword" to value("keyPassword", "TAYLIS_ANDROID_KEY_PASSWORD"),
    )
    if (values.values.all { it != null }) {
        values.mapValues { it.value!! }.toMutableMap().also {
            it["storeFile"] = it.getValue("storeFile").replaceFirst(Regex("^~"), System.getProperty("user.home"))
        }
    } else {
        if (values.values.any { it != null }) {
            logger.warn("Release signing is incomplete (missing ${values.filterValues { it == null }.keys}): release builds are unsigned")
        }
        null
    }
}

android {
    namespace = "jp.chikuwachat.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "jp.chikuwachat.android"
        minSdk = 26
        targetSdk = 37
        // versionName: what people see (X.Y.Z, raised for a store release). versionCode: an integer Play needs to
        // grow with every upload (any track), raised by one per uploaded build (docs/STORE_RELEASE.md).
        versionCode = 16
        versionName = "1.0.7"
    }

    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = file(releaseSigning.getValue("storeFile"))
                storePassword = releaseSigning.getValue("storePassword")
                keyAlias = releaseSigning.getValue("keyAlias")
                keyPassword = releaseSigning.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigning != null) signingConfig = signingConfigs.getByName("release")
            // R8 shrinks and obfuscates the release build (Play warns about unobfuscated DEX). kotlinx.serialization,
            // Room, OkHttp and Firebase ship their own keep rules; proguard-rules.pro adds AndroidMath's JNI classes.
            // The AAB carries mapping.txt for Play's stack traces; release-android.sh also keeps a copy next to it.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    // docs/I18N.md: the in-app language may differ from the device's, so Play must not split the strings by language.
    // AndroidMath ships three math fonts; the renderer uses its default (Latin Modern), so the other two stay out.
    androidResources {
        ignoreAssetsPatterns += listOf("!xits-math.otf", "!texgyretermes-math.otf")
    }

    bundle {
        language {
            enableSplit = false
        }
    }
}

// M153a (docs/WIKI.md §30.3 / §30.5): the page editor bundled for the phones is built by the desktop project
// (`cd apps/desktop && npm ci && npm run build:mobile-editor` → apps/shared/mobile-editor/dist, a generated directory
// that is not committed) and copied by this task into a generated assets root (build/generated/mobileEditor, so
// `assets/editor/` in the APK) that every variant's assets include. Nothing is written under src/, so nothing can be
// committed by mistake and every task that reads the assets (merge, lint, package) depends on the copy through the
// variant API. A checkout without the bundle fails here with the command to run.
abstract class CopyMobileEditorTask : DefaultTask() {
    /** apps/shared/mobile-editor/dist (a missing directory is reported below, not by Gradle's input check). */
    @get:Internal
    abstract val dist: Property<File>

    /** The files of `dist`, for the up-to-date check. */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val distFiles: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        val source = dist.get()
        check(File(source, "index.html").isFile && File(source, "editor.js").isFile) {
            "The bundled page editor is missing: ${source.absolutePath} has no index.html / editor.js. " +
                "Build it first: cd apps/desktop && npm ci && npm run build:mobile-editor (docs/WIKI.md §30.3)."
        }
        fs.sync {
            from(source)
            into(outputDir.get().dir("editor"))
        }
    }
}
val mobileEditorDist = rootProject.file("../shared/mobile-editor/dist")
val copyMobileEditor by tasks.registering(CopyMobileEditorTask::class) {
    description = "Copies the bundled page editor (apps/shared/mobile-editor/dist) into the generated assets as editor/"
    dist.set(mobileEditorDist)
    distFiles.from(fileTree(mobileEditorDist))
    outputDir.set(layout.buildDirectory.dir("generated/mobileEditor"))
}
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyMobileEditor, CopyMobileEditorTask::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    // Play services (via Firebase) pulls an old androidx.fragment; ActivityResult needs 1.3+.
    implementation(libs.androidx.fragment)
    // Custom Tabs for Google sign-in (M48, docs/SSO.md §6): Jetpack; falls back to the default browser by itself.
    implementation(libs.androidx.browser)
    // M153a (docs/WIKI.md §30.3 / §30.5): WebViewAssetLoader serves the bundled page editor (assets/editor) to the WebView.
    implementation(libs.androidx.webkit)
    // TeX math in messages (ui/MathRender.kt; MIT, THIRD_PARTY_NOTICES.md). Its POM lists test and AppCompat artifacts
    // as runtime dependencies it never uses; only the library itself (Kotlin's stdlib is the app's own).
    implementation(libs.androidmath) { isTransitive = false }
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.room.runtime)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    // The only non-Jetpack dependency: Jetpack has no WebSocket client (CLAUDE.md "Android").
    implementation(libs.okhttp)
    // Firebase Cloud Messaging (CLAUDE.md "Android": FCM for push).
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(libs.junit)
}
