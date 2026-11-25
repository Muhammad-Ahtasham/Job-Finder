import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.token';

/**
 * Short-lived download links. A link is `<export id>` + `<expiry>` signed with an HMAC key that
 * only the API knows, so it cannot be forged, extended or reused for another export. It is
 * handed out only to an authorised member of the export's workspace (see ExportsService), and it
 * dies after EXPORT_LINK_TTL_SECONDS.
 */
@Injectable()
export class ExportLinksService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  private sign(exportId: string, expires: number): string {
    return createHmac('sha256', this.env.EXPORT_LINK_SECRET)
      .update(`export-download:${exportId}:${expires}`)
      .digest('hex');
  }

  create(exportId: string, now = Date.now()): { url: string; expiresAt: Date } {
    const expires = Math.floor(now / 1000) + this.env.EXPORT_LINK_TTL_SECONDS;
    const signature = this.sign(exportId, expires);
    return {
      url: `/api/v1/exports/${exportId}/file?expires=${expires}&signature=${signature}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** True only for an unexpired link signed for exactly this export. */
  verify(exportId: string, expires: number, signature: string, now = Date.now()): boolean {
    if (!Number.isInteger(expires) || expires * 1000 < now) return false;
    // A link can never outlive the configured TTL, even with a validly signed far-future expiry.
    if (expires * 1000 > now + (this.env.EXPORT_LINK_TTL_SECONDS + 5) * 1000) return false;
    const expected = Buffer.from(this.sign(exportId, expires), 'hex');
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
