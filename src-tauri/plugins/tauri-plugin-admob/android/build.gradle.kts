plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cloud.memorycard.admob"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
        // play-services-ads 25.x foi compilado com Kotlin 2.3; o projeto (gerado pelo Tauri) usa Kotlin 1.9.
        // Só usamos a API Java do SDK, então ignorar a versão dos metadados é seguro aqui.
        freeCompilerArgs += listOf("-Xskip-metadata-version-check")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    // Google Mobile Ads SDK (AdMob) + User Messaging Platform (GDPR/consent form)
    implementation("com.google.android.gms:play-services-ads:25.5.0")
    implementation("com.google.android.ump:user-messaging-platform:4.0.0")
    implementation(project(":tauri-android"))
}
