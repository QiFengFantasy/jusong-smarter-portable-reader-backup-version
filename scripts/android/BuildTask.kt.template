import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

/**
 * 本机构建定制：Windows 非管理员无法创建 jniLibs 符号链接。
 * Rust .so 由 scripts/build-android-apk.ps1 预先编译并复制到 jniLibs，
 * 这里跳过 Tauri CLI 的 android-studio-script 调用（该步骤只做编译 + symlink）。
 */
abstract class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        logger.lifecycle(
            "rustBuild skipped (libjusong_lib.so prebuilt/copied): target=$target release=$release"
        )
    }
}
