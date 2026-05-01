fn main() {
    // 交给 Tauri 生成清单和资源绑定，避免手写路径遗漏。
    tauri_build::build()
}
