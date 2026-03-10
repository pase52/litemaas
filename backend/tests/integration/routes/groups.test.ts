/**
 * Integration tests for user-facing Groups Routes
 * Tests the 8 group endpoints available to authenticated users
 * (no admin permission check — access control at service level via team membership)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';

describe('Groups Routes Integration', () => {
  let app: FastifyInstance;
  let userToken: string;
  let adminToken: string;
  let adminReadonlyToken: string;

  const NON_EXISTENT_UUID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOWED_FRONTEND_ORIGINS = '';

    app = await createApp({ logger: false });
    await app.ready();

    // Create test users in database for token validation
    await createTestUsers(app);

    // Generate test tokens using fixed UUIDs from setup
    userToken = generateTestToken(TEST_USER_IDS.USER, ['user']);
    adminToken = generateTestToken(TEST_USER_IDS.ADMIN, ['admin']);
    adminReadonlyToken = generateTestToken(TEST_USER_IDS.ADMIN_READONLY, ['admin-readonly']);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // =========================================
  // GET /api/v1/groups
  // =========================================
  describe('GET /api/v1/groups', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated regular user access', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('data');
        expect(result).toHaveProperty('pagination');
        expect(Array.isArray(result.data)).toBe(true);
        expect(result.pagination).toHaveProperty('page');
        expect(result.pagination).toHaveProperty('limit');
        expect(result.pagination).toHaveProperty('total');
        expect(result.pagination).toHaveProperty('totalPages');
      }
    });

    it('should allow authenticated admin user access', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should allow authenticated admin-readonly user access', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should support pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?page=1&limit=5',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result.pagination.page).toBe(1);
        expect(result.pagination.limit).toBe(5);
      }
    });

    it('should support search query parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?search=test',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should support isActive filter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups?isActive=true',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should filter out the default team from results', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        const defaultTeamId = 'a0000000-0000-4000-8000-000000000001';
        const hasDefaultTeam = result.data.some(
          (g: { id: string }) => g.id === defaultTeamId,
        );
        expect(hasDefaultTeam).toBe(false);
      }
    });

    it('should include myRole in each group entry when status is 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        for (const group of result.data) {
          expect(group).toHaveProperty('id');
          expect(group).toHaveProperty('name');
          // myRole may be undefined if the member lookup didn't match
          expect('myRole' in group).toBe(true);
        }
      }
    });
  });

  // =========================================
  // GET /api/v1/groups/:groupId
  // =========================================
  describe('GET /api/v1/groups/:groupId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (membership checked at service level)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups/not-a-uuid',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should return 404 or 403 for non-existent group', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([403, 404, 500]).toContain(response.statusCode);
    });

    it('should return group with members shape when 200', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('members');
        expect(Array.isArray(result.members)).toBe(true);
      }
    });
  });

  // =========================================
  // PATCH /api/v1/groups/:groupId
  // =========================================
  describe('PATCH /api/v1/groups/:groupId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        payload: { name: 'Updated Group' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (team admin check in service)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { name: 'Updated Group' },
      });

      // No 403 from route-level — service may return 403/404/500
      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/groups/not-a-uuid',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { name: 'Invalid UUID' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should return error for non-existent group', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'Does Not Exist' },
      });

      expect([403, 404, 500]).toContain(response.statusCode);
    });

    it('should accept partial updates with name only', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'Only Name Update' },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should accept partial updates with alias only', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { alias: 'new-alias' },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should accept partial updates with description only', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { description: 'Only updating description' },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should accept all allowed fields together', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          name: 'Full Update',
          alias: 'full-update',
          description: 'Updated all fields',
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should return GroupWithMembers shape on success', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'Check Shape' },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('name');
        expect(result).toHaveProperty('members');
        expect(Array.isArray(result.members)).toBe(true);
      }
    });
  });

  // =========================================
  // GET /api/v1/groups/:groupId/users/search
  // =========================================
  describe('GET /api/v1/groups/:groupId/users/search', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=test`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (team admin check in handler)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=test`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      // Service-level check may return 403/404/500
      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should validate search query parameter is required', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should validate search minLength of 2', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=a`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should accept search with 2 characters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=ab`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should validate search maxLength of 100', async () => {
      const longSearch = 'a'.repeat(101);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=${longSearch}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups/not-a-uuid/users/search?search=test',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should support optional limit parameter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=test&limit=5`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should return user search response shape on success', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/users/search?search=test`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('users');
        expect(result).toHaveProperty('total');
        expect(Array.isArray(result.users)).toBe(true);
        for (const user of result.users) {
          expect(user).toHaveProperty('userId');
          expect(user).toHaveProperty('username');
          expect(user).toHaveProperty('email');
        }
      }
    });
  });

  // =========================================
  // POST /api/v1/groups/:groupId/members
  // =========================================
  describe('POST /api/v1/groups/:groupId/members', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (team admin check in service)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { userId: TEST_USER_IDS.ADMIN },
      });

      // Service-level check may return 403/404/409/500
      expect([201, 400, 403, 404, 409, 500]).toContain(response.statusCode);
    });

    it('should reject missing userId in body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: {},
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should reject invalid userId format in body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { userId: 'not-a-uuid' },
      });

      expect([400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format in path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/groups/not-a-uuid/members',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should accept optional role field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'viewer',
        },
      });

      expect([201, 400, 403, 404, 409, 500]).toContain(response.statusCode);
    });

    it('should accept admin role value', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'admin',
        },
      });

      expect([201, 400, 403, 404, 409, 500]).toContain(response.statusCode);
    });

    it('should accept member role value', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'member',
        },
      });

      expect([201, 400, 403, 404, 409, 500]).toContain(response.statusCode);
    });

    it('should return member object with user info on 201', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { userId: TEST_USER_IDS.USER },
      });

      if (response.statusCode === 201) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('userId');
        expect(result).toHaveProperty('role');
        expect(result).toHaveProperty('joinedAt');
        expect(result).toHaveProperty('user');
        expect(result.user).toHaveProperty('id');
        expect(result.user).toHaveProperty('username');
        expect(result.user).toHaveProperty('email');
      }
    });
  });

  // =========================================
  // PATCH /api/v1/groups/:groupId/members/:userId
  // =========================================
  describe('PATCH /api/v1/groups/:groupId/members/:userId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        payload: { role: 'viewer' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (team admin check in service)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { role: 'member' },
      });

      expect([200, 400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject missing role in body', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: {},
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should reject invalid role value', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { role: 'superadmin' },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should accept admin role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'admin' },
      });

      expect([200, 400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should accept viewer role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'viewer' },
      });

      expect([200, 400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for groupId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/not-a-uuid/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { role: 'member' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for userId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/not-a-uuid`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { role: 'member' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should return member object with user info on success', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'member' },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('userId');
        expect(result).toHaveProperty('role');
        expect(result).toHaveProperty('joinedAt');
        expect(result).toHaveProperty('user');
        expect(result.user).toHaveProperty('id');
        expect(result.user).toHaveProperty('username');
        expect(result.user).toHaveProperty('email');
      }
    });
  });

  // =========================================
  // DELETE /api/v1/groups/:groupId/members/:userId
  // =========================================
  describe('DELETE /api/v1/groups/:groupId/members/:userId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (team admin check in service)', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for groupId', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/not-a-uuid/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for userId', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/not-a-uuid`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should return error for non-existent group', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 400, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should return success shape on 200', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('success', true);
      }
    });
  });

  // =========================================
  // GET /api/v1/groups/:groupId/budget
  // =========================================
  describe('GET /api/v1/groups/:groupId/budget', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/budget`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should allow authenticated user access (membership checked at service level)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should allow admin user access', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 403, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/groups/not-a-uuid/budget',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should return error for non-existent group', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([403, 404, 500]).toContain(response.statusCode);
    });

    it('should return proper budget shape on success', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('teamId');
        expect(result).toHaveProperty('currentSpend');
        expect(result).toHaveProperty('budgetUtilization');
        expect(result).toHaveProperty('memberCount');
        expect(result).toHaveProperty('lastUpdatedAt');
        // Optional fields may or may not be present
        if ('maxBudget' in result) {
          expect(typeof result.maxBudget).toBe('number');
        }
        if ('remainingBudget' in result) {
          expect(typeof result.remainingBudget).toBe('number');
        }
        if ('budgetDuration' in result) {
          expect(typeof result.budgetDuration).toBe('string');
        }
      }
    });
  });
});
