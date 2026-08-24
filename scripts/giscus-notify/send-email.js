// Giscus 评论邮件通知 —— 事件驱动发送脚本
//
// 由 GitHub Actions 在 `discussion_comment: [created]` 事件触发时调用。
// 数据全部来自 github.event（无需 GraphQL 轮询、无 last-notified.json）。
//
// 依赖：nodemailer（仅在此脚本中 import，需在本仓库 npm install nodemailer）
//
// 环境变量（由 workflow 注入，敏感项来自 Secrets）：
//   EVENT_JSON       — github.event 的 JSON 字符串（workflow 用 toJSON(github.event) 传入）
//   CATEGORY_NAME    — 期望的 giscus 评论分类名（如 "Announcements"），用于过滤
//   SITE_BASE_URL    — 博客站点根，如 https://baiwumm.com
//   SMTP_HOST        — 来自 Secret
//   SMTP_PORT        — 来自 Secret
//   SMTP_USER        — 来自 Secret
//   SMTP_PASSWORD    — 来自 Secret
//   NOTIFY_EMAIL     — 来自 Secret（收信地址）
//   TEMPLATE_PATH    — 邮件模板绝对路径

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

// 最小权限、显式失败：任何一步出错都抛出，让 workflow 以非零状态结束。
function fail(msg) {
  console.error("[giscus-notify] " + msg);
  process.exit(1);
}

function main() {
  const eventJson = process.env.EVENT_JSON;
  if (!eventJson) fail("缺少 EVENT_JSON 环境变量（github.event 未传入）");

  let event;
  try {
    event = JSON.parse(eventJson);
  } catch (e) {
    fail("EVENT_JSON 解析失败: " + e.message);
  }

  const comment = event.discussion_comment;
  const discussion = event.discussion;
  if (!comment || !discussion) {
    fail("event payload 缺少 discussion_comment 或 discussion 字段");
  }

  // 仅处理目标分类下的评论（payload 只有 category.name/slug/id，无 giscus categoryId）
  const expectedCategory = (process.env.CATEGORY_NAME || "").trim();
  const actualCategory = discussion.category && discussion.category.name;
  if (expectedCategory && actualCategory !== expectedCategory) {
    console.log(
      `[giscus-notify] 分类不匹配，跳过：期望 "${expectedCategory}"，实际 "${actualCategory}"`
    );
    process.exit(0); // 正常退出，不视为失败（这不是本博客评论）
  }

  // 收信配置
  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (!notifyEmail) fail("缺少 NOTIFY_EMAIL（收信地址）");
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
    fail("SMTP 配置不完整（HOST/PORT/USER/PASSWORD 至少有一个缺失）");
  }

  // 读取并渲染模板
  const templatePath =
    process.env.TEMPLATE_PATH ||
    path.join(__dirname, "email-template.sample.html");
  if (!fs.existsSync(templatePath)) fail("模板不存在: " + templatePath);
  let html = fs.readFileSync(templatePath, "utf8");

  // 时间格式化（Asia/Shanghai，与站点 SITE.timezone 一致）
  const createdAt = comment.created_at ? new Date(comment.created_at) : new Date();
  const timeStr = createdAt.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // 链接处理：
  // - discussion.html_url：GitHub Discussions 页（「在 GitHub 查看」按钮）
  // - giscus mapping=pathname 时，discussion.title 即文章 path，如 "posts/iy5v650a"
  //   拼上站点前缀即为文章页（「前往文章」按钮）。非 posts/ 前缀（如 about、/）
  //   则回退到 Discussions 链接，保证按钮永远有效。
  const siteBase = (process.env.SITE_BASE_URL || "https://www.baiwumm.com").replace(/\/$/, "");
  const discussionUrl = discussion.html_url || "";
  const postTitle = (discussion.title || "未知文章").trim();

  let postUrl = discussionUrl;
  if (/^posts\/.+/i.test(postTitle)) {
    postUrl = siteBase + "/" + postTitle;
  } else if (/^\//.test(postTitle)) {
    postUrl = siteBase + postTitle;
  }

  // 标签：giscus 评论本身无 tags，留空（模板 {{POST_TAGS}} 渲染为空行）。
  const postTags = "";

  const replacements = {
    "{{COMMENT_AVATAR}}": comment.user && comment.user.avatar_url
      ? comment.user.avatar_url
      : "",
    "{{COMMENT_AUTHOR}}": comment.user && comment.user.login
      ? comment.user.login
      : "匿名",
    "{{COMMENT_TIME}}": timeStr,
    "{{COMMENT_BODY}}": (comment.body || "").trim(),
    "{{POST_TITLE}}": postTitle,
    "{{POST_TAGS}}": postTags,
    "{{DISCUSSION_URL}}": discussionUrl,
    "{{COMMENT_URL}}": postUrl,
  };

  for (const [key, value] of Object.entries(replacements)) {
    // 正文做 HTML 转义，防止注入破坏模板；其余字段来自 GitHub 可信 payload。
    const safe = key === "{{COMMENT_BODY}}" ? escapeHtml(value) : value;
    html = html.split(key).join(safe);
  }

  // 发信
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort),
    secure: Number(smtpPort) === 465, // 465 走 SSL，587 走 STARTTLS
    auth: { user: smtpUser, pass: smtpPassword },
  });

  const mailOptions = {
    from: `"baiwumm 评论通知" <${smtpUser}>`,
    to: notifyEmail,
    subject: `💬 新评论 · 《${postTitle}》`,
    html,
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      // 明确失败：不更新任何「已通知」状态（本方案无该状态）。
      fail("SMTP 发送失败: " + err.message);
    }
    console.log(
      `[giscus-notify] 邮件已发送 -> ${notifyEmail} (messageId: ${info.messageId})`
    );
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

main();
