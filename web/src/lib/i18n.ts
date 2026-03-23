export type UiLocale = "en" | "zh-CN";

export const DEFAULT_LOCALE: UiLocale = "en";

const STORAGE_KEY = "ui.locale.v1";

const messages: Record<UiLocale, Record<string, string>> = {
  en: {
    "brand.name": "Typst Collaboration",
    "nav.backToProjects": "Back to projects",
    "nav.logout": "Logout",
    "nav.projects": "Projects",
    "auth.signIn": "Sign In",
    "auth.subtitle": "Use local account credentials or your OpenID Connect provider.",
    "auth.localLogin": "Local Login",
    "auth.register": "Register",
    "auth.oidcLogin": "OIDC Login",
    "auth.continue": "Continue",
    "projects.title": "Projects",
    "projects.createTitle": "Create Project",
    "projects.createAction": "Create",
    "workspace.files": "Files",
    "workspace.editor": "Editor",
    "workspace.preview": "Preview",
    "workspace.settings": "Settings",
    "workspace.revisions": "Revisions",
    "workspace.upload": "Upload",
    "workspace.newFile": "New File",
    "workspace.newFolder": "New Folder",
    "workspace.download": "Download",
    "workspace.notEditable":
      "This file is not editable in web editor. Edit offline and sync with Git.",
    "workspace.connectionLost":
      "Connection to server lost. Edits may not sync until the connection recovers.",
    "workspace.connectionReconnecting": "Reconnecting to collaboration server...",
    "preview.loadingCompiler": "Preparing Typst compiler in browser",
    "preview.compiling": "Compiling Typst document...",
    "preview.downloadPdf": "Download PDF",
    "preview.downloadZip": "Download ZIP",
    "share.title": "Share Links",
    "share.createRead": "Create Read Link",
    "share.createWrite": "Create Write Link",
    "share.none": "No share links yet.",
    "share.copy": "Copy",
    "share.revoke": "Revoke",
    "share.joining": "Joining shared project...",
    "share.joinFailed": "Unable to join shared project.",
    "status.modeLive": "Live",
    "status.modeRevision": "Revision",
    "status.wrapOn": "Wrap On",
    "status.wrapOff": "Wrap Off",
    "status.saveIdle": "idle",
    "status.saveSaving": "saving",
    "status.saveSaved": "saved",
    "status.saveError": "error",
    "admin.title": "Admin Panel",
    "admin.siteName": "Site name",
    "admin.authSettings": "Authentication Settings",
    "profile.title": "Profile Security"
  },
  "zh-CN": {
    "brand.name": "Typst 协作平台",
    "nav.backToProjects": "返回项目",
    "nav.logout": "退出登录",
    "nav.projects": "项目",
    "auth.signIn": "登录",
    "auth.subtitle": "使用本地账号密码或 OpenID Connect 提供商登录。",
    "auth.localLogin": "本地登录",
    "auth.register": "注册",
    "auth.oidcLogin": "OIDC 登录",
    "auth.continue": "继续",
    "projects.title": "项目",
    "projects.createTitle": "新建项目",
    "projects.createAction": "创建",
    "workspace.files": "文件",
    "workspace.editor": "编辑器",
    "workspace.preview": "预览",
    "workspace.settings": "设置",
    "workspace.revisions": "版本",
    "workspace.upload": "上传",
    "workspace.newFile": "新建文件",
    "workspace.newFolder": "新建文件夹",
    "workspace.download": "下载",
    "workspace.notEditable": "该文件暂不支持网页编辑。请离线编辑后通过 Git 同步。",
    "workspace.connectionLost": "与服务器连接中断。恢复连接前编辑可能无法同步。",
    "workspace.connectionReconnecting": "正在重新连接协作服务器…",
    "preview.loadingCompiler": "正在浏览器中准备 Typst 编译器",
    "preview.compiling": "正在编译 Typst 文档…",
    "preview.downloadPdf": "下载 PDF",
    "preview.downloadZip": "下载 ZIP",
    "share.title": "共享链接",
    "share.createRead": "生成只读链接",
    "share.createWrite": "生成可编辑链接",
    "share.none": "暂无共享链接。",
    "share.copy": "复制",
    "share.revoke": "撤销",
    "share.joining": "正在加入共享项目…",
    "share.joinFailed": "加入共享项目失败。",
    "status.modeLive": "实时",
    "status.modeRevision": "历史",
    "status.wrapOn": "自动换行开",
    "status.wrapOff": "自动换行关",
    "status.saveIdle": "空闲",
    "status.saveSaving": "保存中",
    "status.saveSaved": "已保存",
    "status.saveError": "错误",
    "admin.title": "管理面板",
    "admin.siteName": "站点名称",
    "admin.authSettings": "认证设置",
    "profile.title": "账户安全"
  }
};

export function readStoredLocale(): UiLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "zh-CN" ? "zh-CN" : "en";
}

export function storeLocale(locale: UiLocale) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, locale);
}

export function translate(locale: UiLocale, key: string) {
  return messages[locale][key] ?? messages.en[key] ?? key;
}
