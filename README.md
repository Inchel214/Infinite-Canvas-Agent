# Infinite-Canvas-Agent

## macOS 一键启动（电脑小白友好）

1. 下载本项目到电脑（克隆或下载 ZIP 后解压）
2. 双击 `start_mac.command` 文件
   - 若提示"无法打开，因为来自身份不明的开发者"：**右键点击 → 打开** → 在弹窗里点"打开"
   - 若提示无权限：打开"终端"，运行 `chmod +x start_mac.command` 后再双击
3. 首次运行会自动安装所需环境（Homebrew / Python / Node），按提示输入电脑密码即可
4. 没有 ARK API Key 也能直接体验（自动进入演示模式）；有的话在提示时粘贴进去

启动后会自动打开浏览器到 http://localhost:5173 ，按 `Ctrl+C` 停止所有服务。

## Windows 一键启动（电脑小白友好）

1. 下载本项目到电脑（克隆或下载 ZIP 后解压）
2. 双击 `start_windows.bat` 文件
   - 若提示"已停止保护你的电脑"：点击"更多信息" → "仍要运行"
3. 首次运行会自动安装所需环境（Python / Node，需已安装 winget；缺环境时会自动安装，装完重新双击一次即可）
4. 没有 ARK API Key 也能直接体验（自动进入演示模式）；有的话在提示时粘贴进去

启动后会自动打开浏览器到 http://localhost:5173 。
停止服务：关闭"InfiniteCanvas-后端"和"InfiniteCanvas-前端"两个窗口即可。
脚本每次运行都会自动补装新依赖并清理旧的后端进程（避免"更新代码后没重启"导致的接口 404 问题）。