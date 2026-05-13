import { describe, expect, it } from 'vitest';
import {
  determinePrimaryAction,
  generateRecommendationText,
  generateMorningBriefRecommendation,
  createMorningBriefSummary,
  type MorningBriefSummary,
  type PrimaryAction
} from './morning-brief-recos.js';

describe('morning-brief-recos', () => {
  describe('determinePrimaryAction', () => {
    it('should return "review_queue" when there are blocked items', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 1,
        routed: 0,
        allowed: 9,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      expect(determinePrimaryAction(summary)).toBe('review_queue');
    });

    it('should return "review_queue" when there are 3+ routed items', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 3,
        allowed: 7,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      expect(determinePrimaryAction(summary)).toBe('review_queue');
    });

    it('should return "check_budgets" when there are 5+ high budget agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 0,
        highBudgetAgents: 5
      };
      expect(determinePrimaryAction(summary)).toBe('check_budgets');
    });

    it('should return "check_agents" when there are offline agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 1,
        highBudgetAgents: 0
      };
      expect(determinePrimaryAction(summary)).toBe('check_agents');
    });

    it('should return "none" when no rules trigger', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 0,
        highBudgetAgents: 4
      };
      expect(determinePrimaryAction(summary)).toBe('none');
    });

    it('should prioritize blocked items over routed items', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 1,
        routed: 5,
        allowed: 4,
        offlineAgents: 2,
        highBudgetAgents: 6
      };
      expect(determinePrimaryAction(summary)).toBe('review_queue');
    });

    it('should prioritize routed items over high budget agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 3,
        allowed: 7,
        offlineAgents: 2,
        highBudgetAgents: 5
      };
      expect(determinePrimaryAction(summary)).toBe('review_queue');
    });

    it('should prioritize high budget agents over offline agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 1,
        highBudgetAgents: 5
      };
      expect(determinePrimaryAction(summary)).toBe('check_budgets');
    });
  });

  describe('generateRecommendationText', () => {
    it('should generate correct text for single blocked item', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 1,
        routed: 0,
        allowed: 9,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      expect(generateRecommendationText(summary)).toBe('Review 1 blocked item');
    });

    it('should generate correct text for multiple blocked items', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 3,
        routed: 0,
        allowed: 7,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      expect(generateRecommendationText(summary)).toBe('Review 3 blocked items');
    });

    it('should generate correct text for routed items when no blocked items', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 4,
        allowed: 6,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      expect(generateRecommendationText(summary)).toBe('Review 4 items in queue');
    });

    it('should generate correct text for high budget agents threshold', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 0,
        highBudgetAgents: 5
      };
      expect(generateRecommendationText(summary)).toBe('Check 5 agents over budget');
    });

    it('should generate correct text for multiple high budget agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 0,
        highBudgetAgents: 5
      };
      expect(generateRecommendationText(summary)).toBe('Check 5 agents over budget');
    });

    it('should generate correct text for single offline agent', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 1,
        highBudgetAgents: 0
      };
      expect(generateRecommendationText(summary)).toBe('Check 1 offline agent');
    });

    it('should generate correct text for multiple offline agents', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 3,
        highBudgetAgents: 0
      };
      expect(generateRecommendationText(summary)).toBe('Check 3 offline agents');
    });

    it('should generate correct text for quiet morning', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 0,
        routed: 2,
        allowed: 8,
        offlineAgents: 0,
        highBudgetAgents: 4
      };
      expect(generateRecommendationText(summary)).toBe('All systems operational');
    });
  });

  describe('generateMorningBriefRecommendation', () => {
    it('should return complete recommendation object', () => {
      const summary: MorningBriefSummary = {
        totalActions: 10,
        blocked: 2,
        routed: 3,
        allowed: 5,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      
      const result = generateMorningBriefRecommendation(summary);
      
      expect(result).toEqual({
        primaryAction: 'review_queue',
        recommendationText: 'Review 2 blocked items'
      });
    });
  });

  describe('createMorningBriefSummary', () => {
    it('should create summary object from individual parameters', () => {
      const result = createMorningBriefSummary(15, 1, 2, 12, 0, 0);
      
      expect(result).toEqual({
        totalActions: 15,
        blocked: 1,
        routed: 2,
        allowed: 12,
        offlineAgents: 0,
        highBudgetAgents: 0
      });
    });
  });

  describe('edge cases', () => {
    it('should handle zero values correctly', () => {
      const summary: MorningBriefSummary = {
        totalActions: 0,
        blocked: 0,
        routed: 0,
        allowed: 0,
        offlineAgents: 0,
        highBudgetAgents: 0
      };
      
      const result = generateMorningBriefRecommendation(summary);
      
      expect(result).toEqual({
        primaryAction: 'none',
        recommendationText: 'All systems operational'
      });
    });

    it('should handle large numbers correctly', () => {
      const summary: MorningBriefSummary = {
        totalActions: 1000,
        blocked: 50,
        routed: 100,
        allowed: 850,
        offlineAgents: 10,
        highBudgetAgents: 20
      };
      
      const result = generateMorningBriefRecommendation(summary);
      
      expect(result).toEqual({
        primaryAction: 'review_queue',
        recommendationText: 'Review 50 blocked items'
      });
    });
  });
});