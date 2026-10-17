# 第三方内容说明

本仓库包含以下第三方产物或资源。

## 1. `assets/vendor/workbuddy-cloud-sdk.global.js`

云服务客户端 SDK 的浏览器打包副本（IIFE 格式，全局变量 `WorkBuddyCloud`）。

- 来源：npm 包 [`@tencent-ai/workbuddy-cloud-sdk`](https://www.npmjs.com/package/@tencent-ai/workbuddy-cloud-sdk)
- 版本：`0.1.3-dev.c090db7.202610050023`（见 `package-lock.json`）
- 版权归其作者所有

自托管这份副本而不是从 CDN 加载，是为了让页面不请求任何外部域名：中文站点的首屏常常卡在外部字体与脚本的 DNS + TLS 握手上，而且 CDN 不可用时页面会退化。

如果你要分发本仓库（尤其是用于商业用途），请自行确认该 SDK 的授权条款是否允许再分发这份副本。如果不允许，删掉这个文件并把 `admin.html` 里的引用指向官方提供的地址即可，公开页面不依赖它。

## 2. `assets/vendor/fonts/`

- `archivo-var.woff2` —— Archivo，SIL Open Font License 1.1
- `instrument-serif-400.woff2`、`instrument-serif-400-italic.woff2` —— Instrument Serif，SIL Open Font License 1.1

两者均来自 Google Fonts。OFL 允许自由使用、修改与再分发，包括随软件一起打包。

## 3. `data/sample-items.json`

演示模式的示例数据，全部为虚构内容（标题、摘要、链接均指向 `example.com`），用于让 `npm start` 之后界面有东西可渲染。可以随意删除或替换。
