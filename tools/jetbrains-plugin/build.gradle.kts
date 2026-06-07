// yamlover JetBrains plugin — v1: file type + syntax highlighting only.
// Build:  ./gradlew buildPlugin     (needs JDK 17 and network for the IDE SDK)
// Run:    ./gradlew runIde
//
// Pin versions to whatever matches your target IDE; the IntelliJ Platform Gradle
// Plugin 2.x DSL is used below.
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "net.inthemoon.yamlover"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2023.2.6")
        bundledPlugin("org.intellij.plugins.markdown")  // for Markdown code-fence injection
        instrumentationTools()
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "232"
            // Open-ended upper bound: built against the oldest backend (2023.2/232) but
            // compatible with any newer one (this host also has 2024.3 / 2026.1 backends).
            untilBuild = provider { null }
        }
    }
}

kotlin {
    jvmToolchain(17)
}
