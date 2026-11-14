plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.extrravenue.webview"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        targetSdk = 34
        versionCode = System.getenv("BUILD_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.${System.getenv("BUILD_NUMBER") ?: "1"}"
    }

    flavorDimensions += "portal"
    productFlavors {
        create("venue") {
            dimension = "portal"
            applicationId = "com.extrravenue.venue"
            buildConfigField("String", "PORTAL_URL", "\"https://www.extrravenue.com/venue\"")
        }
        create("inspector") {
            dimension = "portal"
            applicationId = "com.extrravenue.inspector"
            buildConfigField("String", "PORTAL_URL", "\"https://www.extrravenue.com/inspector\"")
        }
        create("advertiser") {
            dimension = "portal"
            applicationId = "com.extrravenue.advertiser"
            buildConfigField("String", "PORTAL_URL", "\"https://www.extrravenue.com/signagecms.html\"")
        }
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
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
