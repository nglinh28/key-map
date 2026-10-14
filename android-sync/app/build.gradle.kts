plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "vn.local.ftkeymapsync"
    compileSdk = 35

    defaultConfig {
        applicationId = "vn.local.ftkeymapsync"
        minSdk = 30 // Android 11+: one storage model (all-files access), no legacy permissions
        targetSdk = 35
        versionCode = 4
        versionName = "2.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // No AndroidX and no UI library on purpose: the app is a handful of plain views.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // the real org.json for JVM tests (android.jar only has stubs)
}
