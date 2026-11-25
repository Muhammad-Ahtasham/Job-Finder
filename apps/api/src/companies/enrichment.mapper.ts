import type {
  CompanyContact as ContactRow,
  CompanyPage as PageRow,
  CompanyReview as ReviewRow,
  ExtractionRun as RunRow,
} from '@jobfinder/database';
import {
  evidenceSchema,
  extractionErrorSchema,
  type CompanyContact,
  type CompanyPage,
  type CompanyReview,
  type ExtractionRun,
} from '@jobfinder/contracts';
import { z } from 'zod';

const evidenceList = z.array(evidenceSchema);
const errorList = z.array(extractionErrorSchema);

/** Stored JSON is untrusted-by-shape (it was written by another process): parse, never cast. */
export function toExtractionRun(run: RunRow): ExtractionRun {
  const stats = z.record(z.string(), z.number()).safeParse(run.stats);
  const errors = errorList.safeParse(run.errors);
  return {
    id: run.id,
    companyId: run.companyId,
    status: run.status,
    attempts: run.attempts,
    websiteUrl: run.websiteUrl,
    pagesFound: run.pagesFound,
    contactsFound: run.contactsFound,
    stats: stats.success ? stats.data : {},
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    errors: errors.success ? errors.data : [],
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export function toCompanyPage(page: PageRow): CompanyPage {
  return {
    id: page.id,
    url: page.url,
    type: page.type,
    typeConfidence: page.typeConfidence,
    classifiedBy: page.classifiedBy,
    title: page.title,
    fetchStatus: page.fetchStatus,
    httpStatus: page.httpStatus,
    errorCode: page.errorCode,
    external: page.external,
    discoveredFrom: page.discoveredFrom,
    fetchedAt: page.fetchedAt?.toISOString() ?? null,
    lastSeenAt: page.lastSeenAt.toISOString(),
  };
}

export function toCompanyContact(contact: ContactRow): CompanyContact {
  return {
    id: contact.id,
    kind: contact.kind,
    value: contact.value,
    category: contact.category,
    classifiedBy: contact.classifiedBy,
    confidence: contact.confidence,
    verificationStatus: contact.verificationStatus,
    verificationMethod: contact.verificationMethod,
    extractionMethod: contact.extractionMethod,
    sourceUrl: contact.sourceUrl,
    context: contact.context,
    domainMatch: contact.domainMatch,
    extractedAt: contact.extractedAt.toISOString(),
    lastSeenAt: contact.lastSeenAt.toISOString(),
  };
}

export function toCompanyReview(review: ReviewRow): CompanyReview {
  const evidence = evidenceList.safeParse(review.evidence);
  return {
    id: review.id,
    companyId: review.companyId,
    kind: 'WEBSITE',
    subjectUrl: review.subjectUrl,
    domain: review.subjectKey,
    decision: review.decision,
    confidence: review.confidence,
    evidence: evidence.success ? evidence.data : [],
    status: review.status,
    decidedManually: review.decidedManually,
    resolvedAt: review.resolvedAt?.toISOString() ?? null,
    updatedAt: review.updatedAt.toISOString(),
  };
}
