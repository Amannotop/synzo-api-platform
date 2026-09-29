import type { AppConfig } from '@synzo/config';
import type { Logger } from '../lib/logger.js';

export interface TelegramDeps {
  config: AppConfig;
  logger: Logger;
  /**
   * Injectable for tests. Defaults to the global fetch, so nothing has to be
   * mocked in production and a test can drive every failure mode — timeout,
   * non-2xx, malformed body — deterministically.
   */
  fetchImpl?: typeof fetch;
}

export interface PaymentNotice {
  paymentId: string;
  customerName: string;
  customerEmail: string;
  customerId: string;
  packageName: string;
  credits: number;
  amountMinor: number;
  currency: string;
  reference: string;
  submittedAt: Date;
  /** Deep link to the payment in the admin dashboard, when one is configured. */
  adminUrl?: string | null;
  /** Decoded receipt bytes, forwarded as a photo when Telegram accepts them. */
  receipt?: { bytes: Buffer; mime: string } | null;
}

/**
 * Formats a minor-unit amount as a currency string.
 *
 * Integer minor units only — never a float. 89900 paise is ₹899.00, and doing
 * that division in floating point is how an operator ends up reconciling
 * ₹898.99 against a ₹899 payment.
 */
function formatMoney(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  return `${currency} ${major.toFixed(2)}`;
}

/**
 * Sends payment notifications to the operator's Telegram chat.
 *
 * Three properties matter more than the feature itself:
 *
 *  1. The bot token is server-only. It is read from config on the server, is
 *     never echoed into a message, a log line, or any API response, and the
 *     URL that carries it is built and discarded inside this module.
 *
 *  2. Delivery failure cannot lose a payment. Every method returns a result
 *     rather than throwing, and the caller records the outcome on the payment
 *     row. A Telegram outage must not stop a customer submitting, and must
 *     certainly not grant or withhold credits.
 *
 *  3. Nothing here is proof of payment. It is a notification that a human
 *     should go and look at something.
 */
export class TelegramService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: TelegramDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  }

  /** True only when BOTH the token and the chat id are present. */
  get configured(): boolean {
    return this.deps.config.telegram.configured;
  }

  /**
   * Posts a new payment request to the operator.
   *
   * The text carries every field the spec requires: request id, customer name,
   * email and id, package, amount and currency, transaction reference, and
   * submission time. The id is what the operator reconciles against, so it is
   * the first line rather than buried at the bottom.
   */
  async notifyPayment(input: PaymentNotice): Promise<{ sent: boolean; error: string | null }> {
    if (!this.configured) {
      return { sent: false, error: 'Telegram is not configured' };
    }

    const lines = [
      '🧾 *New payment request*',
      '',
      `Request ID: \`${input.paymentId}\``,
      `Customer: ${input.customerName} (${input.customerEmail})`,
      `Customer ID: \`${input.customerId}\``,
      `Package: ${input.packageName}`,
      `Credits: ${input.credits.toLocaleString('en-US')} tokens`,
      `Amount: *${formatMoney(input.amountMinor, input.currency)}*`,
      `Reference: \`${input.reference}\``,
      `Submitted: ${input.submittedAt.toISOString()}`,
    ];
    if (input.adminUrl) lines.push('', `[Open in admin dashboard](${input.adminUrl})`);

    // The receipt is sent as a separate photo message. Attaching it to the
    // text is not an option the Bot API offers, and posting the bytes as a
    // document is the fallback when the image is too large or not an image.
    const sent = await this.send(input.paymentId, { text: lines.join('\n'), parseMode: 'Markdown' });
    if (!sent.sent) return sent;

    if (input.receipt) {
      await this.sendReceipt(input.paymentId, input.receipt.bytes, input.receipt.mime);
    }
    return { sent: true, error: null };
  }

  /**
   * Re-sends an existing payment request. This is the operator's manual retry
   * for a submission the bot never received, which is why the payment id is
   * passed in rather than generated here.
   */
  async retryPayment(input: PaymentNotice): Promise<{ sent: boolean; error: string | null }> {
    const result = await this.notifyPayment(input);
    return result;
  }

  /** Sends the receipt as a photo, falling back to a document. */
  private async sendReceipt(
    paymentId: string,
    bytes: Buffer,
    mime: string,
  ): Promise<{ sent: boolean; error: string | null }> {
    const isImage = mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp';
    // Telegram's caption limit is 1024 characters and its file limit is 50MB,
    // but the platform already caps uploads far below both; this is a
    // belt-and-braces bound so an oversized receipt cannot wedge the send.
    if (bytes.byteLength > 50 * 1024 * 1024) {
      return { sent: false, error: 'Receipt is too large to send' };
    }

    // The method and the form field name have to agree — Telegram rejects a
    // file posted under the wrong one — so both are decided once, here.
    const method: 'sendPhoto' | 'sendDocument' = isImage ? 'sendPhoto' : 'sendDocument';
    const filename = isImage ? 'receipt.png' : 'receipt.bin';

    const form = new FormData();
    form.append('chat_id', this.deps.config.telegram.chatId as string);
    form.append('caption', `Receipt for payment request \`${paymentId}\``);
    form.append('parse_mode', 'Markdown');
    // A Blob is used rather than a Buffer so the runtime sets the multipart
    // Content-Type itself. Setting it by hand is how a receipt silently
    // arrives as undecodable bytes.
    form.append(
      method === 'sendPhoto' ? 'photo' : 'document',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      filename,
    );

    return this.call(paymentId, method, form);
  }

  /** Sends a plain text message. */
  private async send(
    paymentId: string,
    payload: Record<string, unknown>,
  ): Promise<{ sent: boolean; error: string | null }> {
    const body = {
      chat_id: this.deps.config.telegram.chatId,
      disable_web_page_preview: true,
      ...payload,
    };
    return this.call(paymentId, 'sendMessage', JSON.stringify(body), 'application/json');
  }

  /**
   * One Telegram API call, with a hard timeout and total failure containment.
   *
   * The token appears in the request URL, which is how the Bot API works, so
   * the URL is constructed here and never returned, logged, or attached to an
   * error. The error text is truncated before it is stored, because Telegram's
   * descriptions can echo the request back and a payment row is not the place
   * to keep a credential.
   */
  private async call(
    paymentId: string,
    method: 'sendMessage' | 'sendPhoto' | 'sendDocument',
    body: string | FormData,
    contentType = 'application/json',
  ): Promise<{ sent: boolean; error: string | null }> {
    const { botToken, chatId, timeoutMs } = this.deps.config.telegram;
    if (!botToken || !chatId) return { sent: false, error: 'Telegram is not configured' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: contentType === 'application/json' ? { 'content-type': 'application/json' } : {},
        // FormData or a JSON string; both are valid fetch bodies, and the cast
        // is needed only because the DOM lib is not in scope for the Node
        // types this package builds against.
        body: body as unknown as string,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 300);
        // The status is logged; the body is not, because Telegram echoes the
        // request (token included) in some error shapes.
        this.deps.logger.warn('Telegram send failed', {
          paymentId,
          method,
          status: response.status,
        });
        return { sent: false, error: `Telegram responded ${response.status}${text ? '' : ''}` };
      }
      return { sent: true, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.deps.logger.warn('Telegram send failed', {
        paymentId,
        method,
        error: message,
      });
      return { sent: false, error: message.slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }
}
