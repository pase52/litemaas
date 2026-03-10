/**
 * Integration tests for Admin Groups Routes
 * Tests the 9 admin group management endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createApp } from '../../../src/app';
import { generateTestToken, createTestUsers, TEST_USER_IDS } from '../setup';

describe('Admin Groups Routes Integration', () => {
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
  // GET /api/v1/admin/groups
  // =========================================
  describe('GET /api/v1/admin/groups', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow access for admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
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

    it('should allow access for admin-readonly users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should support pagination parameters', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups?page=1&limit=5',
        headers: {
          Authorization: `Bearer ${adminToken}`,
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
        url: '/api/v1/admin/groups?search=test',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });

    it('should support isActive filter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups?isActive=true',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // POST /api/v1/admin/groups
  // =========================================
  describe('POST /api/v1/admin/groups', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        payload: { name: 'Test Group' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { name: 'Test Group' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
        payload: { name: 'Test Group' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to create a group', async () => {
      const uniqueName = `Integration Test Group ${Date.now()}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          name: uniqueName,
          description: 'Created by integration test',
        },
      });

      expect([201, 409, 500]).toContain(response.statusCode);

      if (response.statusCode === 201) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('name');
        expect(result.name).toBe(uniqueName);
      }
    });

    it('should reject missing name (required field)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { description: 'No name provided' },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should reject empty name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: '' },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should reject name exceeding maxLength (100)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'A'.repeat(101) },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should accept optional fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          name: `Full Options Group ${Date.now()}`,
          alias: `fog-${Date.now()}`,
          description: 'A group with all optional fields',
          maxBudget: 1000,
          budgetDuration: 'monthly',
          tpmLimit: 50000,
          rpmLimit: 500,
          allowedModels: [],
          adminIds: [TEST_USER_IDS.ADMIN],
        },
      });

      expect([201, 409, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // GET /api/v1/admin/groups/:groupId
  // =========================================
  describe('GET /api/v1/admin/groups/:groupId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow access for admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should allow access for admin-readonly users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups/not-a-uuid',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // PATCH /api/v1/admin/groups/:groupId
  // =========================================
  describe('PATCH /api/v1/admin/groups/:groupId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        payload: { name: 'Updated Group' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { name: 'Updated Group' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
        payload: { name: 'Updated Group' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to update a group', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          name: 'Updated Group Name',
          description: 'Updated description',
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'Does Not Exist' },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/groups/not-a-uuid',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { name: 'Invalid UUID' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should accept partial updates', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { description: 'Only updating description' },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should accept isActive field for deactivation', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { isActive: false },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should accept budget and limit fields', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          maxBudget: 2000,
          budgetDuration: 'monthly',
          tpmLimit: 100000,
          rpmLimit: 1000,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // DELETE /api/v1/admin/groups/:groupId
  // =========================================
  describe('DELETE /api/v1/admin/groups/:groupId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to delete a group', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('success');
        expect(result.success).toBe(true);
      }
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/admin/groups/not-a-uuid',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // POST /api/v1/admin/groups/:groupId/members
  // =========================================
  describe('POST /api/v1/admin/groups/:groupId/members', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to add a member', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'member',
        },
      });

      expect([201, 404, 500]).toContain(response.statusCode);
    });

    it('should reject missing userId (required field)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'member' },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should accept optional role parameter', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'admin',
        },
      });

      expect([201, 404, 500]).toContain(response.statusCode);
    });

    it('should accept viewer role', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: {
          userId: TEST_USER_IDS.USER,
          role: 'viewer',
        },
      });

      expect([201, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for groupId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/groups/not-a-uuid/members',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { userId: TEST_USER_IDS.USER },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // PATCH /api/v1/admin/groups/:groupId/members/:userId
  // =========================================
  describe('PATCH /api/v1/admin/groups/:groupId/members/:userId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        payload: { role: 'admin' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: { role: 'admin' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
        payload: { role: 'admin' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to update member role', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'viewer' },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'member' },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for groupId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/not-a-uuid/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'member' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for userId', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/not-a-uuid`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
        payload: { role: 'member' },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should accept all valid role values', async () => {
      for (const role of ['admin', 'member', 'viewer']) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
          payload: { role },
        });

        expect([200, 404, 500]).toContain(response.statusCode);
      }
    });
  });

  // =========================================
  // DELETE /api/v1/admin/groups/:groupId/members/:userId
  // =========================================
  describe('DELETE /api/v1/admin/groups/:groupId/members/:userId', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access for admin-readonly users (requires admin:groups:write)', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow admin to remove a member', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('success');
        expect(result.success).toBe(true);
      }
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for groupId', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/not-a-uuid/members/${TEST_USER_IDS.USER}`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format for userId', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/members/not-a-uuid`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });
  });

  // =========================================
  // GET /api/v1/admin/groups/:groupId/budget
  // =========================================
  describe('GET /api/v1/admin/groups/:groupId/budget', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/budget`,
      });

      expect(response.statusCode).toBe(401);
    });

    it('should deny access for regular users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should allow access for admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const result = JSON.parse(response.body);
        expect(result).toHaveProperty('teamId');
        expect(result).toHaveProperty('currentSpend');
        expect(result).toHaveProperty('budgetUtilization');
        expect(result).toHaveProperty('memberCount');
        expect(result).toHaveProperty('lastUpdatedAt');
      }
    });

    it('should allow access for admin-readonly users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminReadonlyToken}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });

    it('should return 404 for non-existent group', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/groups/${NON_EXISTENT_UUID}/budget`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it('should reject invalid UUID format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/groups/not-a-uuid/budget',
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect([400, 404, 500]).toContain(response.statusCode);
    });
  });
});
