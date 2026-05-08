import nodemailer from "nodemailer";

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type AppMailer = {
  sendMail(input: SendMailInput): Promise<void>;
};

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (!host || !from) {
    return null;
  }

  const portRaw = process.env.SMTP_PORT?.trim() ?? "587";
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : 587;
  const secure = String(process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";

  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    secure,
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASS?.trim() || undefined,
    from,
  };
}

export function createMailer(): AppMailer {
  const config = readSmtpConfig();
  if (!config) {
    return {
      async sendMail(input) {
        console.log("[mailer:dev-fallback]", {
          to: input.to,
          subject: input.subject,
          text: input.text,
        });
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  });

  return {
    async sendMail(input) {
      await transport.sendMail({
        from: config.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
    },
  };
}
