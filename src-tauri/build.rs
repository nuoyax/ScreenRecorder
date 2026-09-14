fn main() {
    // Workaround: mingw windres 2.45 popen preprocessor fails under this env;
    // tell tauri-winres to use a trivial preprocessor via env override.
    std::env::set_var("WINDRES", "windres --preprocessor=cat");
    tauri_build::build()
}
