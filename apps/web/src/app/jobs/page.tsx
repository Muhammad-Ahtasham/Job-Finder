'use client';

import { AuthedPage } from '@/components/app-shell';
import { JobsTable } from '@/components/jobs-table';
import { PageHeader } from '@/components/states';

export default function JobsPage() {
  return (
    <AuthedPage>
      {() => (
        <div className="flex flex-col gap-6">
          <PageHeader
            title="Job opportunities"
            description="Jobs read from company career pages and job boards. Pick a project to see how well each job matches it."
          />
          <JobsTable chooseProject />
        </div>
      )}
    </AuthedPage>
  );
}
