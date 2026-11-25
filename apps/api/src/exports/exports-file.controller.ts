import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ExportLinksService } from './export-links.service';
import { ExportsService } from './exports.service';

const fileQuerySchema = z.object({
  expires: z.coerce.number().int().positive(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Serves the file for a signed, short-lived link. There is no session here by design (the link
 * is the credential), so this route does nothing but verify the signature and stream.
 */
@ApiTags('exports')
@Public()
@Controller({ path: 'exports', version: '1' })
export class ExportFileController {
  constructor(
    private readonly exports: ExportsService,
    private readonly links: ExportLinksService,
  ) {}

  @Get(':id/file')
  @ApiOkResponse({ description: 'The export file (CSV or XLSX)' })
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(fileQuerySchema)) query: z.infer<typeof fileQuerySchema>,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.links.verify(id, query.expires, query.signature)) {
      throw new ForbiddenException('This download link is invalid or has expired');
    }
    const file = await this.exports.openFile(id);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/[^\w.-]/g, '_')}"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.size !== null) response.setHeader('Content-Length', String(file.size));
    file.stream.on('error', () => response.destroy());
    file.stream.pipe(response);
  }
}
