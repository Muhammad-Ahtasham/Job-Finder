import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { EnrichmentController } from './enrichment.controller';
import { EnrichmentService } from './enrichment.service';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [CompaniesController, EnrichmentController],
  providers: [CompaniesService, ReviewsService, EnrichmentService],
})
export class CompaniesModule {}
