/**
 * Rule-based recommendations for morning brief
 * Pure functions that translate brief inputs into recommendation strings
 */

export interface MorningBriefSummary {
  totalActions: number;
  blocked: number;
  routed: number;
  allowed: number;
  offlineAgents: number;
  highBudgetAgents: number;
}

export type PrimaryAction = 'review_queue' | 'check_budgets' | 'check_agents' | 'none';

export interface MorningBriefRecommendation {
  primaryAction: PrimaryAction;
  recommendationText: string;
}

/**
 * Determines the primary action based on morning brief summary data
 * Rules are evaluated in priority order - first match wins
 */
export function determinePrimaryAction(summary: MorningBriefSummary): PrimaryAction {
  // Rule 1: Compliance risk always wins - any blocked items
  if (summary.blocked > 0) {
    return 'review_queue';
  }

  // Rule 2: Batch review efficiency - 3+ routed items
  if (summary.routed >= 3) {
    return 'review_queue';
  }

  // Rule 3: Pre-emptive cost control - 5+ high budget agents
  if (summary.highBudgetAgents >= 5) {
    return 'check_budgets';
  }

  // Rule 4: Reliability signal - any offline agents
  if (summary.offlineAgents > 0) {
    return 'check_agents';
  }

  // Default: Quiet morning
  return 'none';
}

/**
 * Generates human-readable recommendation text based on summary data
 */
export function generateRecommendationText(summary: MorningBriefSummary): string {
  const primaryAction = determinePrimaryAction(summary);

  switch (primaryAction) {
    case 'review_queue': {
      const totalReviewItems = summary.blocked + summary.routed;
      if (summary.blocked > 0) {
        return `Review ${summary.blocked} blocked item${summary.blocked === 1 ? '' : 's'}`;
      }
      return `Review ${totalReviewItems} item${totalReviewItems === 1 ? '' : 's'} in queue`;
    }

    case 'check_budgets': {
      return `Check ${summary.highBudgetAgents} agent${summary.highBudgetAgents === 1 ? '' : 's'} over budget`;
    }

    case 'check_agents': {
      return `Check ${summary.offlineAgents} offline agent${summary.offlineAgents === 1 ? '' : 's'}`;
    }

    case 'none': {
      return 'All systems operational';
    }
  }
}

/**
 * Main function to generate morning brief recommendation
 * Combines primary action determination and text generation
 */
export function generateMorningBriefRecommendation(
  summary: MorningBriefSummary
): MorningBriefRecommendation {
  return {
    primaryAction: determinePrimaryAction(summary),
    recommendationText: generateRecommendationText(summary)
  };
}

/**
 * Helper function to create a summary from raw data
 */
export function createMorningBriefSummary(
  totalActions: number,
  blocked: number,
  routed: number,
  allowed: number,
  offlineAgents: number,
  highBudgetAgents: number
): MorningBriefSummary {
  return {
    totalActions,
    blocked,
    routed,
    allowed,
    offlineAgents,
    highBudgetAgents
  };
}