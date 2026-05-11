plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.22"
    id("org.jetbrains.intellij") version "1.17.2"
}

group = "dev.kimchi"

val baseVersion = "1.0.0"
val versionSuffix = providers.environmentVariable("PLUGIN_VERSION_SUFFIX")
    .orElse(providers.exec { commandLine("git", "rev-parse", "--short", "HEAD") }
        .standardOutput.asText.map { "local-${it.trim()}" })
version = "$baseVersion-${versionSuffix.get()}"

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")
}

intellij {
    version.set("2023.2.5")
    type.set("IU") // IntelliJ IDEA Ultimate
}

tasks {
    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions.jvmTarget = "17"
    }

    patchPluginXml {
        sinceBuild.set("232")
        untilBuild.set("999.*")
    }

    buildPlugin {
        doFirst {
            layout.buildDirectory.dir("distributions").get().asFile.listFiles()
                ?.filter { it.extension == "zip" }
                ?.forEach { it.delete() }
        }
    }
}