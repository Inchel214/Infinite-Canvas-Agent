# Infinite-Canvas-Agent

## macOS 一键启动（电脑小白友好）

1. 下载本项目到电脑（克隆或下载 ZIP 后解压）
2. 双击 `start_mac.command` 文件
   - 若提示"无法打开，因为来自身份不明的开发者"：**右键点击 → 打开** → 在弹窗里点"打开"
   - 若提示无权限：打开"终端"，运行 `chmod +x start_mac.command` 后再双击
3. 首次运行会自动安装所需环境（Homebrew / Python / Node），按提示输入电脑密码即可
4. 没有 ARK API Key 也能直接体验（自动进入演示模式）；有的话在提示时粘贴进去

启动后会自动打开浏览器到 http://localhost:5173 ，按 `Ctrl+C` 停止所有服务。