import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { EnrichmentController } from './enrichment.controller';
import { EnrichmentService } from './enrichment.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [CompaniesController, EnrichmentController, JobsController],
  providers: [CompaniesService, ReviewsService, EnrichmentService, JobsService],
})
export class CompaniesModule {}
