// Mail sending (verification · password reset). SMTP via nodemailer; Mailpit in local dev.
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    async send(msg) {
      await transport.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
