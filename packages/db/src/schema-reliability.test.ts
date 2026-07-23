import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  coverageAssignments,
  coverageEvents,
  mobilePushSubscriptions,
  parentAlerts,
} from './schema.js';

describe('reliability schema indexes', () => {
  it('declares tenant-scoped external-id and assignment uniqueness', () => {
    const eventIndexes = getTableConfig(coverageEvents).indexes;
    const assignmentIndexes = getTableConfig(coverageAssignments).indexes;

    expect(eventIndexes.find((index) =>
      index.config.name === 'coverage_events_school_source_external_id_unique'
    )?.config).toMatchObject({ unique: true });
    expect(eventIndexes.find((index) =>
      index.config.name === 'coverage_events_school_source_external_id_unique'
    )?.config.where).toBeDefined();

    for (const name of [
      'coverage_assignments_event_duty_teacher_unique',
      'coverage_assignments_event_duty_uncovered_unique',
    ]) {
      expect(assignmentIndexes.find((index) => index.config.name === name)?.config)
        .toMatchObject({ unique: true });
    }
  });

  it('mirrors parent-alert uniqueness and mobile active/token indexes', () => {
    const parentIndexes = getTableConfig(parentAlerts).indexes;
    const mobileIndexes = getTableConfig(mobilePushSubscriptions).indexes;

    expect(parentIndexes.find((index) =>
      index.config.name === 'parent_alerts_parent_assignment_unique'
    )?.config).toMatchObject({ unique: true });
    expect(mobileIndexes.find((index) =>
      index.config.name === 'idx_mobile_push_subscriptions_school_user_active'
    )?.config.where).toBeDefined();
    expect(mobileIndexes.some((index) =>
      index.config.name === 'idx_mobile_push_subscriptions_token'
    )).toBe(true);
  });
});