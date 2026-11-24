import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Company, Prisma, PrismaClient } from '@jobfinder/database';
import {
  foldText,
  pairKeyOf,
  type CompanyCandidate,
  type CompanyDeduplicationService,
  type CompanyNormalizationService,
  type ExistingCompanySnapshot,
  type MatchAlternative,
  type NormalizedCandidate,
  type ProviderTerms,
} from '@jobfinder/discovery';
import { PRISMA } from '../infrastructure.module';
import { DEDUPLICATOR, NORMALIZER, workspaceLockKey } from './discovery.tokens';

export interface PersistContext {
  workspaceId: string;
  runId: string;
  taskId: string;
  providerId: string;
  terms: ProviderTerms;
  /** True when every result is inside the project's city (see CompanyDiscoveryProvider.cityScoped). */
  cityScoped: boolean;
  country: string;
  city: string;
  keyword?: string;
}

export interface PersistTotals {
  created: number;
  matched: number;
  reviews: number;
  /** Same hit already recorded for this run (replay or another keyword): nothing written. */
  duplicates: number;
  rejected: number;
  /** created + matched + reviews: results newly recorded by this call. */
  newResults: number;
}

type Outcome = 'CREATED' | 'MATCHED' | 'REVIEW_REQUIRED' | 'DUPLICATE';

const MAX_CANDIDATES_PER_BLOCK = 200;
const MAX_UNIQUE_RETRIES = 3;

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * Turns provider candidates into canonical workspace companies.
 *
 * Every candidate is handled in ONE transaction that first takes a per-workspace advisory
 * lock, so concurrent tasks (different providers/keywords) cannot create duplicates; the
 * unique constraints on CompanyIdentity / CompanySource / DiscoveryResult are the safety net.
 * Replaying a page is a no-op: the DiscoveryResult unique key short-circuits it.
 */
@Injectable()
export class CandidatePersister {
  private readonly logger = new Logger(CandidatePersister.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(NORMALIZER) private readonly normalizer: CompanyNormalizationService,
    @Inject(DEDUPLICATOR) private readonly deduplicator: CompanyDeduplicationService,
  ) {}

  async persistPage(
    context: PersistContext,
    candidates: CompanyCandidate[],
  ): Promise<PersistTotals> {
    const totals: PersistTotals = {
      created: 0,
      matched: 0,
      reviews: 0,
      duplicates: 0,
      rejected: 0,
      newResults: 0,
    };

    for (const candidate of candidates) {
      const normalized = this.normalizer.normalize(candidate, {
        country: context.country,
        city: context.city,
        cityTrusted: context.cityScoped,
      });
      if (!normalized.ok) {
        totals.rejected += 1;
        await this.prisma.searchRun.update({
          where: { id: context.runId },
          data: { rejected: { increment: 1 } },
        });
        continue;
      }

      const outcome = await this.persistOne(context, normalized.value);
      switch (outcome) {
        case 'CREATED':
          totals.created += 1;
          break;
        case 'MATCHED':
          totals.matched += 1;
          break;
        case 'REVIEW_REQUIRED':
          totals.reviews += 1;
          break;
        case 'DUPLICATE':
          totals.duplicates += 1;
          break;
      }
    }
    totals.newResults = totals.created + totals.matched + totals.reviews;
    return totals;
  }

  private async persistOne(
    context: PersistContext,
    candidate: NormalizedCandidate,
  ): Promise<Outcome> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.apply(tx, context, candidate), {
          maxWait: 15_000,
          timeout: 30_000,
        });
      } catch (error) {
        // A concurrent writer won a unique constraint between our read and write. Re-run the
        // whole decision: it will now see their row and match instead of duplicating.
        if (isUniqueViolation(error) && attempt < MAX_UNIQUE_RETRIES) {
          this.logger.warn(
            `Unique conflict persisting "${candidate.displayName}", retrying (${attempt})`,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async apply(
    tx: Prisma.TransactionClient,
    context: PersistContext,
    norm: NormalizedCandidate,
  ): Promise<Outcome> {
    const { workspaceId, runId } = context;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceLockKey(workspaceId)}, 0))`;

    // ---- Idempotency: this exact hit was already recorded for this run.
    const existingResult = await tx.discoveryResult.findUnique({
      where: {
        runId_providerId_sourceKey: {
          runId,
          providerId: context.providerId,
          sourceKey: norm.sourceKey,
        },
      },
    });
    if (existingResult) {
      if (context.keyword && !existingResult.keywords.includes(context.keyword)) {
        await tx.discoveryResult.update({
          where: { id: existingResult.id },
          data: { keywords: { push: context.keyword } },
        });
      }
      await tx.searchRun.update({
        where: { id: runId },
        data: { duplicatesSkipped: { increment: 1 } },
      });
      return 'DUPLICATE';
    }

    let outcome: Exclude<Outcome, 'DUPLICATE'>;
    let companyId: string;
    let score: number | null = null;
    let reasons: string[] = [];
    let sourceId: string;
    let alternatives: MatchAlternative[] = [];

    // ---- Seen from the same provider before (earlier run/keyword): same company, refresh provenance.
    const knownSource = await tx.companySource.findUnique({
      where: {
        workspaceId_providerId_sourceKey: {
          workspaceId,
          providerId: context.providerId,
          sourceKey: norm.sourceKey,
        },
      },
    });

    if (knownSource) {
      companyId = await this.resolveSurvivor(tx, knownSource.companyId);
      sourceId = knownSource.id;
      await tx.companySource.update({
        where: { id: knownSource.id },
        data: {
          lastSeenAt: new Date(),
          sightings: { increment: 1 },
          retrievedAt: norm.candidate.retrievedAt,
          ...this.storedPayload(context.terms, norm.candidate),
        },
      });
      outcome = 'MATCHED';
      score = 1;
      reasons = ['same provider record seen before'];
    } else {
      const snapshots = await this.loadSnapshots(tx, workspaceId, norm);
      const decision = this.deduplicator.decide(norm, snapshots);

      if (decision.type === 'MATCH') {
        companyId = decision.companyId;
        outcome = 'MATCHED';
        score = decision.score;
        reasons = decision.reasons;
      } else {
        // NEW and REVIEW both keep the candidate as its own company: nothing is discarded
        // and nothing uncertain is merged.
        const created = await tx.company.create({
          data: {
            workspaceId,
            displayName: norm.displayName,
            nameKey: norm.nameKey,
            coreName: norm.coreName,
            nameTokens: norm.nameTokens,
            coreTokens: norm.coreTokens,
            country: norm.countryCode,
          },
        });
        companyId = created.id;
        if (decision.type === 'REVIEW') {
          outcome = 'REVIEW_REQUIRED';
          alternatives = decision.alternatives;
          score = decision.alternatives[0]?.score ?? null;
          reasons = decision.alternatives[0]?.reasons ?? [];
        } else {
          outcome = 'CREATED';
        }
      }

      const source = await tx.companySource.create({
        data: {
          companyId,
          workspaceId,
          providerId: context.providerId,
          sourceKey: norm.sourceKey,
          externalId: norm.candidate.externalId,
          sourceUrl: norm.candidate.sourceUrl,
          rawName: norm.candidate.name,
          nameConfidence: norm.candidate.nameConfidence,
          matchedKeyword: context.keyword,
          attribution: context.terms.attribution,
          retrievedAt: norm.candidate.retrievedAt,
          expiresAt:
            context.terms.storage === 'TTL' && context.terms.ttlDays
              ? new Date(norm.candidate.retrievedAt.getTime() + context.terms.ttlDays * 86_400_000)
              : null,
          ...this.storedPayload(context.terms, norm.candidate),
        },
      });
      sourceId = source.id;
      await this.attachDetails(tx, workspaceId, companyId, norm, sourceId);

      for (const alternative of alternatives) {
        await this.raiseReview(tx, context, companyId, alternative);
      }
    }

    await tx.discoveryResult.create({
      data: {
        runId,
        workspaceId,
        taskId: context.taskId,
        companyId,
        companySourceId: sourceId,
        providerId: context.providerId,
        sourceKey: norm.sourceKey,
        outcome,
        matchScore: score,
        matchReasons: reasons,
        keywords: context.keyword ? [context.keyword] : [],
      },
    });

    const reviewsRaised = outcome === 'REVIEW_REQUIRED' ? alternatives.length : 0;
    await tx.searchRun.update({
      where: { id: runId },
      data: {
        candidatesFound: { increment: 1 },
        ...(outcome === 'CREATED' || outcome === 'REVIEW_REQUIRED'
          ? { companiesCreated: { increment: 1 } }
          : { companiesMatched: { increment: 1 } }),
        ...(reviewsRaised > 0 ? { reviewsCreated: { increment: reviewsRaised } } : {}),
      },
    });
    return outcome;
  }

  /** Raw provider data is stored only as far as the provider's terms allow. */
  private storedPayload(terms: ProviderTerms, candidate: CompanyCandidate) {
    return terms.storage === 'ID_ONLY'
      ? { rawData: undefined }
      : { rawData: (candidate.raw ?? undefined) as Prisma.InputJsonValue | undefined };
  }

  private async resolveSurvivor(tx: Prisma.TransactionClient, companyId: string): Promise<string> {
    let current = companyId;
    for (let hops = 0; hops < 5; hops += 1) {
      const company = await tx.company.findUnique({
        where: { id: current },
        select: { mergedIntoId: true },
      });
      if (!company?.mergedIntoId) return current;
      current = company.mergedIntoId;
    }
    return current;
  }

  /** Candidate companies worth comparing: exact identity hits plus name-blocked neighbours. */
  private async loadSnapshots(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    norm: NormalizedCandidate,
  ): Promise<ExistingCompanySnapshot[]> {
    const identityHits = norm.identities.length
      ? await tx.companyIdentity.findMany({
          where: {
            workspaceId,
            OR: norm.identities.map((i) => ({ type: i.type, scope: i.scope, value: i.value })),
          },
          select: { companyId: true },
        })
      : [];

    const blockTokens = norm.coreTokens.length ? norm.coreTokens : norm.nameTokens;
    const prefix = norm.coreName.replace(/ /g, '').slice(0, 4);
    const nameHits = await tx.company.findMany({
      where: {
        workspaceId,
        status: 'ACTIVE',
        OR: [
          { nameTokens: { hasSome: blockTokens } },
          ...(prefix.length >= 4 ? [{ nameKey: { startsWith: prefix } }] : []),
        ],
      },
      select: { id: true },
      take: MAX_CANDIDATES_PER_BLOCK,
    });

    const ids = [
      ...new Set([...identityHits.map((h) => h.companyId), ...nameHits.map((h) => h.id)]),
    ];
    if (ids.length === 0) return [];

    const companies = await tx.company.findMany({
      where: { id: { in: ids }, workspaceId, status: 'ACTIVE' },
      include: { identities: true, locations: true },
    });
    return companies.map((company) => ({
      id: company.id,
      displayName: company.displayName,
      nameKey: company.nameKey,
      coreName: company.coreName,
      nameTokens: company.nameTokens,
      coreTokens: company.coreTokens,
      cityKeys: [
        ...new Set(
          [
            ...company.locations.map((l) => l.cityKey),
            company.city ? foldText(company.city) : null,
          ].filter((c): c is string => Boolean(c)),
        ),
      ],
      addresses: company.locations.map((l) => l.addressTokens).filter((t) => t.length > 0),
      domains: company.identities.filter((i) => i.type === 'DOMAIN').map((i) => i.value),
      phones: company.locations.flatMap((l) => l.phones),
      registrationNumbers: company.identities
        .filter((i) => i.type === 'REGISTRATION_NUMBER')
        .map((i) => ({ scope: i.scope, value: i.value })),
      providerIds: company.identities
        .filter((i) => i.type === 'PROVIDER_ID')
        .map((i) => ({ scope: i.scope, value: i.value })),
    }));
  }

  /**
   * Adds what the candidate knows to a company (new or matched) WITHOUT overwriting:
   * only gaps are filled, aliases/locations/identities are additive.
   */
  private async attachDetails(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    companyId: string,
    norm: NormalizedCandidate,
    sourceId: string,
  ): Promise<void> {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: companyId },
      include: { identities: true },
    });

    const fill: Prisma.CompanyUpdateInput = {};
    if (!company.website && norm.website) {
      fill.website = norm.website.url;
      fill.domain = norm.website.domain;
      fill.websiteStatus = 'UNVERIFIED';
    }
    if (!company.city && norm.city) fill.city = norm.city;
    const description = norm.candidate.description?.trim().slice(0, 1000);
    if (!company.description && description) fill.description = description;
    if (Object.keys(fill).length > 0)
      await tx.company.update({ where: { id: companyId }, data: fill });

    const aliasKey = foldText(norm.displayName);
    if (aliasKey && aliasKey !== foldText(company.displayName)) {
      await tx.companyAlias.createMany({
        data: [{ companyId, alias: norm.displayName, aliasKey, sourceId }],
        skipDuplicates: true,
      });
    }

    // Identities: skip ones this company has, and ones another company already owns
    // (the unique index would reject them; the ambiguity is handled via reviews).
    const own = new Set(company.identities.map((i) => `${i.type}|${i.scope}|${i.value}`));
    const wanted = norm.identities.filter((i) => !own.has(`${i.type}|${i.scope}|${i.value}`));
    if (wanted.length > 0) {
      const owned = await tx.companyIdentity.findMany({
        where: {
          workspaceId,
          OR: wanted.map((i) => ({ type: i.type, scope: i.scope, value: i.value })),
        },
        select: { type: true, scope: true, value: true },
      });
      const taken = new Set(owned.map((i) => `${i.type}|${i.scope}|${i.value}`));
      const toCreate = wanted.filter((i) => !taken.has(`${i.type}|${i.scope}|${i.value}`));
      if (toCreate.length > 0) {
        await tx.companyIdentity.createMany({
          data: toCreate.map((i) => ({
            companyId,
            workspaceId,
            type: i.type,
            scope: i.scope,
            value: i.value,
          })),
        });
      }
    }

    const coords = norm.candidate.coordinates;
    if (norm.address || norm.cityKey || coords || norm.phones.length > 0) {
      const locationKey = createHash('sha1')
        .update(
          [
            norm.cityKey ?? '',
            norm.address?.tokens.join(' ') ?? '',
            coords ? `${coords.lat.toFixed(3)},${coords.lng.toFixed(3)}` : '',
          ].join('|'),
        )
        .digest('hex')
        .slice(0, 24);
      await tx.companyLocation.createMany({
        data: [
          {
            companyId,
            locationKey,
            city: norm.city,
            cityKey: norm.cityKey,
            country: norm.countryCode,
            addressRaw: norm.address?.raw,
            addressTokens: norm.address?.tokens ?? [],
            lat: coords?.lat,
            lng: coords?.lng,
            phones: norm.phones,
            sourceId,
          },
        ],
        skipDuplicates: true,
      });
    }
  }

  private async raiseReview(
    tx: Prisma.TransactionClient,
    context: PersistContext,
    candidateCompanyId: string,
    alternative: MatchAlternative,
  ): Promise<void> {
    const pairKey = pairKeyOf(candidateCompanyId, alternative.companyId);
    // A dismissed (or already raised) pair is never raised again.
    await tx.matchReview.createMany({
      data: [
        {
          workspaceId: context.workspaceId,
          candidateCompanyId,
          existingCompanyId: alternative.companyId,
          pairKey,
          score: alternative.score,
          reasons: alternative.reasons,
          runId: context.runId,
        },
      ],
      skipDuplicates: true,
    });
  }
}

export type { Company };
