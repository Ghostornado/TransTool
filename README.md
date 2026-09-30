# TransTool 局域网传输工具

在电脑上启动一个本地网页服务，手机连同一个 Wi-Fi 后浏览器扫码即可与电脑互传**文件、图片、文本**。所有数据只在局域网内传输，不上公网、不装 App。

## 功能特性

- **手机 ↔ PC 互传**：文件、图片（支持拍照/相册多选）、文本，实时同步
- **零安装**：手机不用装 App，电脑可解压即用（自带 Node 运行时）
- **扫码接入**：启动后终端与网页均显示二维码，随机访问令牌，重启即换
- **PC 端双栏布局**：左侧文本收发（支持复制/删除/链接跳转/内容二维码），右侧文件管理（拖拽上传/预览/进度条/删除）
- **接收目录可改**：网页上直接弹出系统窗口选择接收文件夹，即时生效
- **白天/夜间模式**切换
- **安全设计**：随机令牌鉴权、文件名清洗（防路径穿越）、上传类型黑名单 + 大小上限、访问日志、仅局域网监听

## 快速开始

### 方式一：免安装 Node（Windows）

1. 从 [Releases](https://github.com/Ghostornado/TransTool/releases) 页面下载发布包（如 `TransTool-v1.1.zip`，包内自带 `node.exe`），解压到任意位置；也可以克隆本仓库后把 Node.js 的 `node.exe` 放进目录
2. 双击 `start.bat`（首次运行放行防火墙「专用网络」）
3. 手机连同一 Wi-Fi，浏览器扫终端窗口里的二维码即可

### 方式二：已安装 Node.js

```bash
npm install
node server.js
```

启动后按终端提示扫码或输入网址。默认端口 `7100`，可用环境变量 `PORT` 修改；访问令牌可用 `TRANSTOOL_TOKEN` 固定；`TRANSTOOL_NO_OPEN=1` 可禁止自动打开浏览器。

## 目录结构

```
start.bat              双击启动（自动优先使用目录内 node.exe）
server.js              服务端程序（无框架，纯 Node 内置模块）
public/index.html      网页前端
data/config.json       本机配置（首次运行自动生成，参考 config.example.json）
data/texts.json        文本传输记录（运行时生成）
uploads/               默认接收目录（运行时生成）
使用说明.txt            面向使用者的完整说明与常见问题
make_release.ps1       打发布 zip 包的脚本
```

> 注意：`data/config.json`、`data/texts.json`、`data/access.log`、`uploads/` 属于本机运行数据，已在 `.gitignore` 中排除，不会被提交。

## 环境要求

- Windows / macOS / Linux 均可运行服务端（目录选择弹窗仅支持 Windows）
- Node.js ≥ 14（或使用发布包自带的 `node.exe`）
- 依赖：`qrcode`、`qrcode-terminal`（仅用于生成二维码，缺失时功能降级不影响传输）

## 安全说明

- 每次启动生成 128 位随机访问令牌，必须通过带令牌的二维码/链接进入
- 上传默认禁止 `exe/bat/cmd` 等可执行类型，单文件默认上限 2GB（可在配置中调整）
- 服务只监听局域网接口，不做端口映射不会暴露公网
- 请勿将带令牌的链接转发给不可信的人

## 更新日志

见 [使用说明.txt](使用说明.txt) 第八节。
