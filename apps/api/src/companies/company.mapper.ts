import type { Company } from '@jobfinder/database';
import type { CompanySummary } from '@jobfinder/contracts';

export function toCompanySummary(
  company: Company & { _count?: { sources: number } },
): CompanySummary {
  return {
    id: company.id,
    displayName: company.displayName,
    country: company.country,
    city: company.city,
    website: company.website,
    description: company.description,
    websiteStatus: company.websiteStatus,
    emailStatus: company.emailStatus,
    careersStatus: company.careersStatus,
    status: company.status,
    sourceCount: company._count?.sources ?? 0,
    createdAt: company.createdAt.toISOString(),
  };
}
