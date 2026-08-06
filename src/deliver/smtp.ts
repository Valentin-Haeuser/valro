import nodemailer from 'nodemailer';
import type { DeliveryResult, Mailer } from '../types.js';
import type { Env } from '../config.js';

/**
 * Versand über das eigene Gmail-Konto per SMTP.
 *
 * Braucht ein App-Passwort, nicht das normale Google-Passwort — dafür muss
 * die Zwei-Faktor-Authentifizierung aktiv sein (siehe README). Gmail erlaubt
 * rund 500 Mails am Tag; wir verschicken eine.
 *
 * Der Absender ist zwangsläufig das Gmail-Konto selbst: Google akzeptiert
 * keine fremde Absenderadresse, es sei denn, sie ist im Konto als Alias
 * hinterlegt.
 */
export function createSmtpMailer(env: Env): Mailer {
  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPassword },
  });

  return {
    name: `smtp:${env.smtpHost}`,
    async send(msg): Promise<DeliveryResult> {
      try {
        const info = await transporter.sendMail({
          from: { name: env.mailFromName, address: env.smtpUser },
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
        return { ok: true, provider: 'smtp', id: info.messageId };
      } catch (err) {
        return { ok: false, provider: 'smtp', error: (err as Error).message };
      }
    },
  };
}

/** Schreibt statt zu senden — für `npm run briefing:dry`. */
export function createConsoleMailer(): Mailer {
  return {
    name: 'console',
    async send(msg): Promise<DeliveryResult> {
      console.log(`\n--- An: ${msg.to}`);
      console.log(`--- Betreff: ${msg.subject}\n`);
      console.log(msg.text);
      return { ok: true, provider: 'console' };
    },
  };
}
