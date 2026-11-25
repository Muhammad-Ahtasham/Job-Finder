'use client';

import Link from 'next/link';
import { AuthedPage } from '@/components/app-shell';
import { CompaniesTable } from '@/components/companies-table';
import { PageHeader } from '@/components/states';
import { Button } from '@/components/ui/button';

export default function CompaniesPage() {
  return (
    <AuthedPage>
      {() => (
        <div className="flex flex-col gap-6">
          <PageHeader
            title="Companies"
            description="Every company discovered in this workspace, with what is known and verified about it."
            actions={
              <Button asChild variant="outline">
                <Link href="/reviews">Review possible duplicates</Link>
              </Button>
            }
          />
          <CompaniesTable />
        </div>
      )}
    </AuthedPage>
  );
}
