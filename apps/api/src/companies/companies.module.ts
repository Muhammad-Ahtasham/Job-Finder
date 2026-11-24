import { Module } from '@nestjs/common';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService, ReviewsService],
})
export class CompaniesModule {}
