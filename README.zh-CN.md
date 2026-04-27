# TOSS

**TOSS = Typst Open-Source Server**  
一个面向 Typst（以及 LaTeX）的开源自托管协作写作平台，支持实时协作、Git 集成、版本历史与浏览器端编译预览。

English version: [README.md](./README.md)

演示站点: [https://typst-demo.cslabs.cn/](https://typst-demo.cslabs.cn/)

> ⚠️此项目100% vibe coded，阅读其代码可能对您造成精神伤害。  
> ⚠️ This project is 100% vibe coded; reading its code too carefully may cause emotional damage.

## 功能特性

- 实时协作编辑，支持在线状态、协作者存在与光标感知
- 多文件项目工作区，支持目录树、文件/文件夹 CRUD 与上传
- 浏览器端 Typst 编译与预览（WASM）
- 浏览器端 LaTeX 编译与预览（pdfTeX/XeTeX，基于 SwiftLaTeX 运行时）
- 项目级 Git HTTP 访问，使用 PAT（个人访问令牌）鉴权
- 版本历史浏览与作者归属
- 项目分享链接（只读 / 可写）
- 项目归档导出与 PDF 下载
- 管理后台（认证、OIDC、站点品牌、公告等）
- 用户个人安全设置（PAT 管理）

## 架构概览

- `web/`: 静态 React SPA（Vite 构建）
- `backend/`: Rust 单体服务，统一提供：
  - REST API
  - 实时协作 WebSocket
  - Git HTTP 接口
  - 同源静态前端资源服务
- PostgreSQL 用于元数据与状态存储
- 运行时数据统一写入 `DATA_DIR`（Git 仓库、缩略图、TeXLive 缓存等）

## 快速开始（本地自部署）

### 1）构建前端

```bash
cd web
npm install
npm run build
```

### 2）启动后端

```bash
cd backend
DATABASE_URL=postgres://typstapp:iv61v6mRPCGxvWjt@127.0.0.1:5432/typstappdb \
CORE_API_PORT=18080 \
DATA_DIR=/tmp/toss-data \
WEB_STATIC_DIR=../web/dist \
MAX_REQUEST_BODY_BYTES=$((64 * 1024 * 1024)) \
LATEX_TEXLIVE_BASE_URL=https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet \
cargo run
```

访问: [http://127.0.0.1:18080](http://127.0.0.1:18080)

健康检查:

```bash
curl http://127.0.0.1:18080/health
```

## 首次登录 / 管理员初始化

首次启动时，TOSS 会自动创建初始管理员账号，并在日志中输出一次密码：

```text
INITIAL ADMIN ACCOUNT: email=admin@example.com password=...
```

请首次登录后立即修改该密码，并在管理后台完成认证策略与 OIDC 配置。

## 测试指引

### 快速检查

```bash
cd backend && cargo check
cd web && npm run build
```

### 完整本地 CI 检查

```bash
scripts/ci-checks.sh
```

### Headless E2E 脚本

- `web/scripts/headless-smoke.mjs`
- `web/scripts/headless-collab-git.mjs`
- `web/scripts/realtime-multiuser-test.mjs`
- `web/scripts/headless-revision-collab-regression.mjs`

## 认证与访问模型

- 支持本地账号登录/注册
- 支持 OIDC（基于发现端点），可在管理后台配置
- 管理员可配置认证开关（本地登录、注册、OIDC、匿名策略）
- Git 使用 PAT 作为 HTTP 密码
- 项目 Git 接口默认拒绝 force push

## 环境变量说明

- `DATA_DIR`：运行时数据根目录，包括：
  - `git/<project_id>` 项目仓库
  - `thumbnails/<project_id>.thumb` 项目缩略图
  - `texlive/...` TeXLive 缓存与引导文件
- `LATEX_TEXLIVE_BASE_URL`：可配置 SwiftLaTeX 兼容源或 CTAN `/tlnet` 镜像
- `MAX_REQUEST_BODY_BYTES`：默认 64 MiB；大文件上传时可酌情调高

## 项目定位

TOSS 当前重点是协作写作场景下的可用性与功能完整性。  
更大规模生产部署的硬化与扩展可在此基础上持续演进。

## 许可证

本项目以 **GNU AGPLv3** 发布。详见 [LICENSE](./LICENSE)。

采用 AGPLv3 的原因是：当前集成依赖栈中存在 AGPLv3 约束。

对于仓库中的新增原创贡献，贡献者可以额外声明其原创部分按 **WTFPL** 发布。  
但这些代码一旦作为本项目整体的一部分进行分发，整体分发许可证仍然是 **AGPLv3**。

## 重要依赖

- [Typst](https://typst.app/)
- [Yjs](https://yjs.dev/)
- [typst.ts / typst.ts 生态](https://github.com/Myriad-Dreamin/typst.ts)
- [SwiftLaTeX](https://github.com/SwiftLaTeX)
