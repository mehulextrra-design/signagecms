plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

android {
    namespace = "in.signagecms.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "in.signagecms.player"
        minSdk = 21   // Android 5.0 — China boards ke liye
        targetSdk = 34
        versionCode = System.getenv("BUILD_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.${System.getenv("BUILD_NUMBER") ?: "0"}"
        buildConfigField("String", "API_BASE_URL", "\"https://signagecrm-production.up.railway.app/api/\"")
    }

    signingConfigs {
        create("release") {
            storeFile = file("signagecms.keystore")
            storePassword = System.getenv("KEYSTORE_PASS") ?: "signagecms2026"
            keyAlias = System.getenv("KEY_ALIAS") ?: "signagecms"
            keyPassword = System.getenv("KEY_PASS") ?: "signagecms2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false  // disabled — proguard can break TV compatibility
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.kotlinx.coroutines.android)

    // Network
    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp.logging)
    implementation(libs.gson)

    // Database
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Background work
    implementation(libs.workmanager)

    // Media
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.datasource.okhttp)

    // Images
    implementation(libs.glide)
}
