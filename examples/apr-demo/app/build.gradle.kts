plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.apr.demo"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.apr.demo"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
}
