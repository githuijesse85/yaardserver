/**
 * @fileoverview Shared email service for Yaard API.
 *
 * Uses Nodemailer with Namecheap Private Email (SMTP over SSL port 465).
 * All email templates are plain-text + HTML pairs for maximum inbox compatibility.
 */

import nodemailer from "nodemailer";

// ── TRANSPORT ─────────────────────────────────────────────────────────────────

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "mail.privateemail.com",
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true, // SSL on port 465
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: true,
    },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
  });

  return _transporter;
}

const FROM_ADDRESS = `"Yaard" <${process.env.EMAIL_USER || "info@yaard.biz"}>`;
const APP_URL = process.env.APP_URL || "https://yaardserver.netlify.app";

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Send an email. Logs a warning instead of throwing in production so a failed
 * email never causes the API request itself to fail.
 */
async function sendMail(options) {
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: FROM_ADDRESS,
      ...options,
    });
  } catch (err) {
    console.error("[Email] Send failed:", err.message, { to: options.to, subject: options.subject });
    // Re-throw so callers that explicitly need the email to succeed can handle it
    throw err;
  }
}

// ── TEMPLATES ─────────────────────────────────────────────────────────────────

/**
 * Send an email verification link to a newly registered user.
 *
 * @param {string} to    - Recipient email address
 * @param {string} token - Verification UUID token
 */
export async function sendVerificationEmail(to, token) {
  const verifyUrl = `${APP_URL}/api/auth/verify-email?token=${token}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
        <tr><td style="background:#1a1a2e;padding:32px;text-align:center">
          <h1 style="color:#ffffff;margin:0;font-size:28px;letter-spacing:2px">YAARD</h1>
          <p style="color:#a0a0c0;margin:8px 0 0;font-size:14px">Marketplace &amp; Video Commerce</p>
        </td></tr>
        <tr><td style="padding:40px 48px">
          <h2 style="color:#1a1a2e;margin:0 0 16px;font-size:22px">Verify your email address</h2>
          <p style="color:#555;line-height:1.6;margin:0 0 24px">
            Welcome to Yaard! Click the button below to verify your email address and activate your account.
            This link expires in <strong>24 hours</strong>.
          </p>
          <div style="text-align:center;margin:32px 0">
            <a href="${verifyUrl}" style="background:#6c63ff;color:#ffffff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
              Verify Email Address
            </a>
          </div>
          <p style="color:#888;font-size:13px;margin:0">
            Or copy and paste this URL into your browser:<br>
            <a href="${verifyUrl}" style="color:#6c63ff;word-break:break-all">${verifyUrl}</a>
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f9;padding:24px 48px;border-top:1px solid #eee">
          <p style="color:#aaa;font-size:12px;margin:0;text-align:center">
            If you didn't create an account with Yaard, you can safely ignore this email.<br>
            &copy; ${new Date().getFullYear()} Yaard. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  await sendMail({
    to,
    subject: "Verify your Yaard account",
    text: `Welcome to Yaard!\n\nVerify your email: ${verifyUrl}\n\nThis link expires in 24 hours.`,
    html,
  });
}

/**
 * Send a password reset link.
 *
 * @param {string} to    - Recipient email address
 * @param {string} token - Password reset UUID token
 */
export async function sendPasswordResetEmail(to, token) {
  const resetUrl = `${APP_URL}/api/auth/reset-password?token=${token}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
        <tr><td style="background:#1a1a2e;padding:32px;text-align:center">
          <h1 style="color:#ffffff;margin:0;font-size:28px;letter-spacing:2px">YAARD</h1>
          <p style="color:#a0a0c0;margin:8px 0 0;font-size:14px">Marketplace &amp; Video Commerce</p>
        </td></tr>
        <tr><td style="padding:40px 48px">
          <h2 style="color:#1a1a2e;margin:0 0 16px;font-size:22px">Reset your password</h2>
          <p style="color:#555;line-height:1.6;margin:0 0 24px">
            We received a request to reset the password for your Yaard account.
            Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
          </p>
          <div style="text-align:center;margin:32px 0">
            <a href="${resetUrl}" style="background:#e74c3c;color:#ffffff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block">
              Reset Password
            </a>
          </div>
          <p style="color:#888;font-size:13px;margin:0">
            Or copy and paste this URL into your browser:<br>
            <a href="${resetUrl}" style="color:#e74c3c;word-break:break-all">${resetUrl}</a>
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f9;padding:24px 48px;border-top:1px solid #eee">
          <p style="color:#aaa;font-size:12px;margin:0;text-align:center">
            If you didn't request a password reset, please ignore this email. Your password will remain unchanged.<br>
            &copy; ${new Date().getFullYear()} Yaard. All rights reserved.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

  await sendMail({
    to,
    subject: "Reset your Yaard password",
    text: `Reset your Yaard password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
    html,
  });
}

/**
 * Send an admin alert when a video receives a report.
 *
 * @param {object} opts
 * @param {string} opts.videoId
 * @param {string} opts.videoTitle
 * @param {string} opts.reporterUsername
 * @param {string} opts.reason
 * @param {string} [opts.description]
 */
export async function sendReportToAdmin(opts) {
  const adminEmail = process.env.EMAIL_USER || "info@yaard.biz";
  const { videoId, videoTitle, reporterUsername, reason, description } = opts;

  await sendMail({
    to: adminEmail,
    subject: `[Yaard] Content Report: "${videoTitle}"`,
    text: [
      `A video has been reported on Yaard.`,
      ``,
      `Video ID:   ${videoId}`,
      `Title:      ${videoTitle}`,
      `Reporter:   @${reporterUsername}`,
      `Reason:     ${reason}`,
      `Details:    ${description || "N/A"}`,
      ``,
      `Review at: ${APP_URL}/admin`,
    ].join("\n"),
    html: `
<p>A video has been reported on Yaard.</p>
<table style="border-collapse:collapse;width:100%;max-width:500px">
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold">Video ID</td><td style="padding:6px 12px">${videoId}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold">Title</td><td style="padding:6px 12px">${videoTitle}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold">Reporter</td><td style="padding:6px 12px">@${reporterUsername}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold">Reason</td><td style="padding:6px 12px">${reason}</td></tr>
  <tr><td style="padding:6px 12px;background:#f5f5f5;font-weight:bold">Details</td><td style="padding:6px 12px">${description || "N/A"}</td></tr>
</table>
<p><a href="${APP_URL}/admin">Review in Admin Panel →</a></p>
    `.trim(),
  });
}

/**
 * Send an ad/content warning email to the listing owner.
 *
 * @param {object} opts
 * @param {string} opts.to        - Owner email
 * @param {string} opts.videoId
 * @param {string} opts.videoTitle
 * @param {number} opts.reportCount
 */
export async function sendAdWarningEmail(opts) {
  const { to, videoId, videoTitle, reportCount } = opts;

  await sendMail({
    to,
    subject: `[Yaard] Content Warning: Your listing "${videoTitle}"`,
    text: [
      `Your Yaard listing "${videoTitle}" has been flagged by ${reportCount} users.`,
      ``,
      `Please review your listing to ensure it complies with Yaard's community guidelines.`,
      `Continued violations may result in your listing being removed.`,
      ``,
      `Video ID: ${videoId}`,
    ].join("\n"),
    html: `
<p>Your Yaard listing <strong>"${videoTitle}"</strong> has been flagged by <strong>${reportCount}</strong> users.</p>
<p>Please review your listing to ensure it complies with <a href="${APP_URL}/guidelines">Yaard's community guidelines</a>.</p>
<p>Continued violations may result in your listing being removed.</p>
<p style="color:#888;font-size:13px">Video ID: ${videoId}</p>
    `.trim(),
  });
}
