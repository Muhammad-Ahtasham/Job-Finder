/**
 * robots.txt (RFC 9309) parsing and matching. We obey the group for our own product token
 * and fall back to `*`; the longest matching rule wins and Allow beats Disallow on a tie.
 */
interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}
interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelaySeconds?: number;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export class RobotsPolicy {
  private constructor(
    private readonly groups: Group[],
    private readonly mode: 'RULES' | 'ALLOW_ALL' | 'DISALLOW_ALL' | 'UNREADABLE',
  ) {}

  /** No robots.txt (HTTP 4xx): everything is allowed. */
  static allowAll(): RobotsPolicy {
    return new RobotsPolicy([], 'ALLOW_ALL');
  }

  /** robots.txt unreachable / server error: RFC 9309 says assume complete disallow. */
  static disallowAll(): RobotsPolicy {
    return new RobotsPolicy([], 'DISALLOW_ALL');
  }

  /** robots.txt could not be fetched (5xx / network): treated as "do not crawl". */
  static unreadable(): RobotsPolicy {
    return new RobotsPolicy([], 'UNREADABLE');
  }

  get isUnreadable(): boolean {
    return this.mode === 'UNREADABLE';
  }

  static parse(text: string): RobotsPolicy {
    const groups: Group[] = [];
    let current: Group | undefined;
    let lastWasAgent = false;
    for (const rawLine of text.slice(0, 512 * 1024).split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, '').trim();
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (field === 'user-agent') {
        if (!current || !lastWasAgent) {
          current = { agents: [], rules: [] };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!current) continue;
      if (field === 'allow' || field === 'disallow') {
        // "Disallow:" with an empty value allows everything.
        if (value) {
          current.rules.push({
            allow: field === 'allow',
            pattern: value,
            regex: patternToRegex(value),
          });
        }
      } else if (field === 'crawl-delay') {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
      }
    }
    return new RobotsPolicy(groups, 'RULES');
  }

  private groupsFor(userAgentToken: string): Group[] {
    const token = userAgentToken.toLowerCase();
    const specific = this.groups.filter((g) =>
      g.agents.some((agent) => agent !== '*' && agent !== '' && token.includes(agent)),
    );
    return specific.length > 0 ? specific : this.groups.filter((g) => g.agents.includes('*'));
  }

  /** `pathAndQuery` is `url.pathname + url.search`. */
  isAllowed(pathAndQuery: string, userAgentToken: string): boolean {
    if (this.mode === 'ALLOW_ALL') return true;
    if (this.mode === 'DISALLOW_ALL' || this.mode === 'UNREADABLE') return false;
    if (pathAndQuery === '/robots.txt') return true;
    let best: Rule | undefined;
    for (const rule of this.groupsFor(userAgentToken).flatMap((g) => g.rules)) {
      if (!rule.regex.test(pathAndQuery)) continue;
      if (
        !best ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
    return best ? best.allow : true;
  }

  crawlDelayMs(userAgentToken: string): number | undefined {
    const delays = this.groupsFor(userAgentToken)
      .map((g) => g.crawlDelaySeconds)
      .filter((d): d is number => d !== undefined);
    return delays.length > 0 ? Math.max(...delays) * 1000 : undefined;
  }
}
