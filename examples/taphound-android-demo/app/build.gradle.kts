plugins {
    id("com.android.application")
}

android {
    namespace = "dev.taphound.demo"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.taphound.demo"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
