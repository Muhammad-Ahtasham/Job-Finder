import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({ imports: [RunsModule], controllers: [ProjectsController], providers: [ProjectsService] })
export class ProjectsModule {}
