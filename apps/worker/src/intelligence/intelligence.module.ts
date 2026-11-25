import { Module } from '@nestjs/common';
import { AnthropicAiProvider, JobAi } from '@jobfinder/intelligence';
import { ENV, type Env } from '../config/env.token';
import { IntelligenceService } from './intelligence.service';
import { JOB_AI } from './intelligence.tokens';
import { JobAnalyzer } from './job-analyzer';
import { MatchProcessor } from './match-processor';
import { MatchQueueService } from './match-queue.service';
import { StatusSweeper } from './status-sweeper';

@Module({
  providers: [
    {
      provide: JOB_AI,
      inject: [ENV],
      // No key (or disabled): analysis and matching run on deterministic rules alone.
      useFactory: (env: Env) =>
        env.ANTHROPIC_API_KEY && env.INTELLIGENCE_AI_ENABLED
          ? new JobAi(
              new AnthropicAiProvider({
                apiKey: env.ANTHROPIC_API_KEY,
                model: env.INTELLIGENCE_AI_MODEL,
              }),
            )
          : null,
    },
    StatusSweeper,
    JobAnalyzer,
    MatchProcessor,
    MatchQueueService,
    IntelligenceService,
  ],
  exports: [IntelligenceService, JobAnalyzer, MatchProcessor, MatchQueueService, StatusSweeper],
})
export class IntelligenceModule {}
