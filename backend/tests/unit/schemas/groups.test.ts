import { describe, it, expect } from 'vitest';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { FormatRegistry } from '@sinclair/typebox';
import {
  CreateGroupSchema,
  UpdateGroupSchema,
  UpdateGroupDetailsSchema,
  AddGroupMemberSchema,
  UpdateGroupMemberRoleSchema,
  GroupIdParamSchema,
  GroupMemberParamSchema,
  GroupUserSearchQuerySchema,
} from '../../../src/schemas/groups.js';

// Register UUID format validator for TypeCompiler (Fastify/Ajv does this automatically at runtime)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID_REGEX.test(value));
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('Groups Schema', () => {
  describe('CreateGroupSchema', () => {
    const validator = TypeCompiler.Compile(CreateGroupSchema);

    it('should accept valid minimal (just name)', () => {
      expect(validator.Check({ name: 'My Group' })).toBe(true);
    });

    it('should accept valid with all fields', () => {
      expect(
        validator.Check({
          name: 'Full Group',
          alias: 'fg',
          description: 'A fully specified group',
          maxBudget: 100.5,
          budgetDuration: 'monthly',
          tpmLimit: 1000,
          rpmLimit: 500,
          allowedModels: ['gpt-4', 'claude-3'],
          adminIds: ['user-1', 'user-2'],
        }),
      ).toBe(true);
    });

    it('should reject missing name', () => {
      expect(validator.Check({})).toBe(false);
    });

    it('should reject empty name', () => {
      expect(validator.Check({ name: '' })).toBe(false);
    });

    it('should reject name too long (101 chars)', () => {
      expect(validator.Check({ name: 'a'.repeat(101) })).toBe(false);
    });

    it('should reject alias too long (51 chars)', () => {
      expect(validator.Check({ name: 'Valid', alias: 'a'.repeat(51) })).toBe(false);
    });

    it('should reject description too long (501 chars)', () => {
      expect(validator.Check({ name: 'Valid', description: 'a'.repeat(501) })).toBe(false);
    });

    it('should reject negative maxBudget', () => {
      expect(validator.Check({ name: 'Valid', maxBudget: -1 })).toBe(false);
    });

    it('should reject invalid budgetDuration', () => {
      expect(validator.Check({ name: 'Valid', budgetDuration: 'biweekly' })).toBe(false);
    });

    it('should reject negative tpmLimit', () => {
      expect(validator.Check({ name: 'Valid', tpmLimit: -1 })).toBe(false);
    });

    it('should accept name with 1 character', () => {
      expect(validator.Check({ name: 'a' })).toBe(true);
    });

    it('should accept name with 100 characters', () => {
      expect(validator.Check({ name: 'a'.repeat(100) })).toBe(true);
    });

    it('should accept maxBudget of 0', () => {
      expect(validator.Check({ name: 'Valid', maxBudget: 0 })).toBe(true);
    });
  });

  describe('UpdateGroupSchema', () => {
    const validator = TypeCompiler.Compile(UpdateGroupSchema);

    it('should accept empty object (all optional)', () => {
      expect(validator.Check({})).toBe(true);
    });

    it('should accept partial update (just name)', () => {
      expect(validator.Check({ name: 'Updated Name' })).toBe(true);
    });

    it('should accept isActive toggle', () => {
      expect(validator.Check({ isActive: false })).toBe(true);
    });

    it('should reject empty name', () => {
      expect(validator.Check({ name: '' })).toBe(false);
    });

    it('should reject invalid budgetDuration', () => {
      expect(validator.Check({ budgetDuration: 'biweekly' })).toBe(false);
    });
  });

  describe('UpdateGroupDetailsSchema', () => {
    const validator = TypeCompiler.Compile(UpdateGroupDetailsSchema);

    it('should accept empty object', () => {
      expect(validator.Check({})).toBe(true);
    });

    it('should accept name only', () => {
      expect(validator.Check({ name: 'New Name' })).toBe(true);
    });

    it('should accept all three fields', () => {
      expect(
        validator.Check({
          name: 'Name',
          alias: 'Alias',
          description: 'Description',
        }),
      ).toBe(true);
    });

    it('should reject empty name', () => {
      expect(validator.Check({ name: '' })).toBe(false);
    });
  });

  describe('AddGroupMemberSchema', () => {
    const validator = TypeCompiler.Compile(AddGroupMemberSchema);

    it('should accept with userId only (role defaults)', () => {
      expect(validator.Check({ userId: 'user-123' })).toBe(true);
    });

    it('should accept with userId and role=admin', () => {
      expect(validator.Check({ userId: 'user-123', role: 'admin' })).toBe(true);
    });

    it('should accept with role=member', () => {
      expect(validator.Check({ userId: 'user-123', role: 'member' })).toBe(true);
    });

    it('should accept with role=viewer', () => {
      expect(validator.Check({ userId: 'user-123', role: 'viewer' })).toBe(true);
    });

    it('should reject missing userId', () => {
      expect(validator.Check({})).toBe(false);
    });

    it('should reject invalid role', () => {
      expect(validator.Check({ userId: 'user-123', role: 'superadmin' })).toBe(false);
    });
  });

  describe('UpdateGroupMemberRoleSchema', () => {
    const validator = TypeCompiler.Compile(UpdateGroupMemberRoleSchema);

    it('should accept admin', () => {
      expect(validator.Check({ role: 'admin' })).toBe(true);
    });

    it('should accept member', () => {
      expect(validator.Check({ role: 'member' })).toBe(true);
    });

    it('should accept viewer', () => {
      expect(validator.Check({ role: 'viewer' })).toBe(true);
    });

    it('should reject invalid role', () => {
      expect(validator.Check({ role: 'owner' })).toBe(false);
    });

    it('should reject missing role', () => {
      expect(validator.Check({})).toBe(false);
    });
  });

  describe('GroupIdParamSchema', () => {
    const validator = TypeCompiler.Compile(GroupIdParamSchema);

    it('should accept valid UUID', () => {
      expect(validator.Check({ groupId: VALID_UUID })).toBe(true);
    });

    it('should reject non-UUID string', () => {
      expect(validator.Check({ groupId: 'not-a-uuid' })).toBe(false);
    });

    it('should reject missing groupId', () => {
      expect(validator.Check({})).toBe(false);
    });
  });

  describe('GroupMemberParamSchema', () => {
    const validator = TypeCompiler.Compile(GroupMemberParamSchema);

    it('should accept both valid UUIDs', () => {
      expect(validator.Check({ groupId: VALID_UUID, userId: VALID_UUID_2 })).toBe(true);
    });

    it('should reject invalid groupId', () => {
      expect(validator.Check({ groupId: 'bad', userId: VALID_UUID_2 })).toBe(false);
    });

    it('should reject invalid userId', () => {
      expect(validator.Check({ groupId: VALID_UUID, userId: 'bad' })).toBe(false);
    });
  });

  describe('GroupUserSearchQuerySchema', () => {
    const validator = TypeCompiler.Compile(GroupUserSearchQuerySchema);

    it('should accept valid search with 2+ chars', () => {
      expect(validator.Check({ search: 'ab' })).toBe(true);
    });

    it('should reject search with 1 char', () => {
      expect(validator.Check({ search: 'a' })).toBe(false);
    });

    it('should reject search with 101 chars', () => {
      expect(validator.Check({ search: 'a'.repeat(101) })).toBe(false);
    });

    it('should accept limit within range', () => {
      expect(validator.Check({ search: 'test', limit: 25 })).toBe(true);
    });

    it('should reject limit 0', () => {
      expect(validator.Check({ search: 'test', limit: 0 })).toBe(false);
    });

    it('should reject limit 51', () => {
      expect(validator.Check({ search: 'test', limit: 51 })).toBe(false);
    });
  });
});
